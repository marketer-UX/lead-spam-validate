# deep-verifier — stage 2 (SMTP) of lead-spam-validate

A ~400-line Go service around [`github.com/AfterShip/email-verifier`](https://github.com/AfterShip/email-verifier)
(**MIT**, pinned to `v1.4.1`). It is the asynchronous half of the email check:
stage 1 runs natively in the Node service, stage 2 lives here because it needs
outbound **port 25**, which most PaaS platforms block.

Two endpoints, no framework:

| | |
|---|---|
| `GET  /check?email=<addr>&mode=fast\|deep` | `X-Api-Key` required |
| `POST /check` with `{"email":"…","mode":"…"}` | same semantics, for the Node adapter |
| `GET  /health` | unauthenticated |

**The service never answers 5xx on `/check`.** Every failure — DNS, SMTP refused,
timeout, throttle, greylisting — comes back as HTTP 200 with `verdict:"unknown"`.
A broken stage 2 must never block a lead form.

## API

Success (`mode=fast`, the `result` object is the library's `Result` verbatim):

```json
{
  "result": {
    "email": "test@mailinator.com",
    "reachable": "unknown",
    "syntax": { "username": "test", "domain": "mailinator.com", "valid": true },
    "smtp": null,
    "gravatar": null,
    "suggestion": "",
    "disposable": true,
    "role_account": false,
    "free": false,
    "has_mx_records": false
  },
  "provider": "aftership",
  "mode": "fast",
  "latency_ms": 3
}
```

Fail-open (anything went wrong — still HTTP **200**):

```json
{
  "verdict": "unknown",
  "flags": [],
  "provider": "aftership",
  "mode": "deep",
  "latency_ms": 1462,
  "error": "lookup nonexistent-domain-xyz123.de: no such host"
}
```

`error` is short, single-line, capped at 200 chars, and the address is stripped
out of it (`<email>` / `<local>`), because SMTP servers quote it back.
Known short codes: `throttle_timeout`, `timeout`, `canceled`.

Other statuses: `400` missing email · `401` wrong/missing `X-Api-Key` ·
`404` unknown path · `405` method other than GET/POST.

Health:

```json
{
  "ok": true,
  "version": "dev",
  "uptime_s": 41,
  "smtp25": false,
  "smtp25_checked_at": "2026-08-23T11:42:07Z",
  "hello_name": "verify.example.com",
  "from_email": "noreply@example.com"
}
```

`smtp25` is a plain TCP dial to `alt1.gmail-smtp-in.l.google.com:25` (3 s),
done at boot and refreshed every 10 minutes in a goroutine — **never** on the
request path. It answers the only question that matters for this box: *can it
do SMTP verification at all?*

- `smtp25: false` → every `mode=deep` result will be `unknown`. Expected on
  most PaaS platforms, on consumer ISPs, and on any cloud that blocks 25 by default.
- `smtp25: true` → deep checks actually work (a VPS with the port unlocked).

## Env

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Bind is always `0.0.0.0:$PORT`. |
| `API_KEY` | — | `X-Api-Key` value, constant-time compared. |
| `FROM_EMAIL` | `noreply@example.com` | `MAIL FROM:` of the probe. |
| `HELLO_NAME` | `verify.example.com` | `EHLO` name. Must match the PTR record. |
| `ALLOW_NO_AUTH` | — | `1` allows an empty `API_KEY` (local development only). |
| `LOG_JSON` | — | `1` → JSON log lines, otherwise key=value text. |

**Boot guard:** empty `API_KEY` without `ALLOW_NO_AUTH=1` → the process
logs one clear line and exits 1, rather than serving `/check` to the internet.
With `ALLOW_NO_AUTH=1` an empty key only logs a warning and disables auth.

`FROM_EMAIL` and `HELLO_NAME` are not cosmetic. If `HELLO_NAME` does not match
the PTR of the outbound IP and `FROM_EMAIL`'s domain has no SPF covering that
IP, a large share of MX hosts drop the handshake — and you end up measuring your
own misconfiguration, not the address.

**Logs never contain an address.** Only the domain plus the first 12 hex chars
of `sha256(lowercased address)` — enough to correlate lines, not enough to
recover the address.

## Build and run

`go.sum` is deliberately not in the repo: `go.mod` is pinned by hand and the
**Dockerfile runs `go mod tidy` at build time**, which resolves the graph and writes `go.sum`
inside the image. Any Docker-based platform builds it exactly the same way.

```bash
docker build -t lead-spam-validate-deep:dev .
docker run --rm -p 8080:8080 -e API_KEY=test lead-spam-validate-deep:dev

curl -s localhost:8080/health
curl -s -H 'X-Api-Key: test' 'localhost:8080/check?email=test@mailinator.com&mode=fast'
curl -s -H 'X-Api-Key: test' -H 'Content-Type: application/json' \
     -d '{"email":"info@example.com","mode":"deep"}' localhost:8080/check
```

To get a reproducible build, generate and commit the
lockfile once; then the Dockerfile can go back to the cache-friendly layout
described in its comments:

```bash
docker run --rm -v "$PWD":/src -w /src golang:1.23-alpine go mod tidy
```

Build metadata: `docker build --build-arg VERSION=$(git rev-parse --short HEAD) .`
surfaces in `/health.version`.

## Throttling

Mail servers greylist or blocklist senders that hammer them, and the whole point
of a dedicated IP is to keep its reputation. So deep checks are gated:

- **global**: at most 10 deep checks in flight,
- **per MX host**: exactly 1 at a time and at least 1 s between two starts,
- **queue wait**: 20 s max, then the call returns `unknown` with
  `error:"throttle_timeout"` instead of piling up,
- **request**: 25 s hard ceiling end to end (library: 5 s connect, 8 s operation).

The throttle key is the domain's first MX host (`net.LookupMX`, cached 5 min,
falling back to the domain), so all domains behind one provider share a slot.
The per-host slot is released when the library call actually returns, not when
the caller walks away — otherwise a timed-out request would free the slot while
its TCP connection is still open.

## Library behaviour worth knowing (verified against v1.4.1)

These are properties of `AfterShip/email-verifier` itself, and they matter for
the mapping in `src/providers/aftership.ts`:

1. **`mode=fast` never opens an SMTP connection.** `CheckSMTP` returns
   `(nil, nil)` when `smtpCheckEnabled` is false, so `result.smtp` is `null` and
   `reachable` is `"unknown"`. That is the whole reason for two separate
   verifier instances instead of one with flags.
2. **A disposable domain short-circuits `Verify`** before the MX and SMTP checks
   — so `has_mx_records` comes back `false` and `suggestion` empty for
   `test@mailinator.com`. Evaluate `disposable` **before** `no_mx` in the
   adapter, or every disposable address is mislabelled `no_mx`.
3. **`suggestion` is filled last**, after MX and SMTP. A typo domain that does
   not resolve (`gmial.com`) errors out in `CheckMX` first, so stage 2 returns
   fail-open `unknown` with no suggestion. Typo correction therefore belongs in
   the Node stage-1 path (`src/core/typo.ts`), not here.
4. **Catch-all before deliverable.** On a catch-all domain the server answers
   `RCPT TO` positively for everything; the library sets `smtp.catch_all` and
   returns early **without** setting `deliverable`. The adapter must check
   `catch_all` first — this is the single most common bug in this area.
5. `CheckSMTP` dials **all** MX hosts of a domain concurrently and keeps the
   first that answers. Our per-host throttle keys on the first MX record, so in
   practice it throttles per domain-MX-group, which is what greylisting cares
   about.
6. `EnableAutoUpdateDisposable()` fetches
   `disposable/disposable-email-domains` synchronously on the first call (5 s
   timeout, error discarded) and then re-fetches every 24 h. The list is a
   package-level global, so the two verifier instances share it — boot pays the
   fetch twice, which is why the container's `start-period` is 20 s.

## Deployment

| Mode | Where | Why |
|---|---|---|
| `mode=fast` | any PaaS / container host | no SMTP needed, port 25 irrelevant |
| `mode=deep` | VPS with port 25 unlocked + own IP/PTR | most PaaS block outbound port 25 |

### PaaS (Railway, Render, Fly.io, …)

Deploy the Dockerfile, health check path `/health`.
Set `API_KEY`, `FROM_EMAIL`, `HELLO_NAME`, `LOG_JSON=1`; `PORT` is injected.

**Caveat:** most PaaS block outbound port 25. `/health` will report
`smtp25: false` and every `mode=deep` call will fail open to `unknown`. That is
still useful — it exercises the full plumbing end to end (Node adapter → HTTP →
fail-open path) while a VPS is being set up. Do not read `unknown`
there as "address is bad".

### VPS (production for `mode=deep`)

`docker compose up -d --build` brings up the service on `127.0.0.1:8080` plus
Caddy on 80/443, which terminates TLS for `verify.example.com` automatically.

Checklist, in order — steps 1–3 are the ones that actually decide whether deep
verification works:

1. **Port-25 unlock.** Many VPS providers block outbound 25 on new accounts. Open a
   support ticket and state the purpose: *address verification only, no sending*.
   Nothing below matters until this is granted.
2. **PTR record** for the server's IPv4 (and IPv6, if it sends) →
   `verify.example.com`, set in your provider's console. It must equal
   `HELLO_NAME`.
3. **A record** `verify.example.com` → the server IP (and AAAA if used).
   Forward and reverse must agree; many MX hosts check exactly that.
4. **SPF must exist** on `example.com` (the `FROM_EMAIL` domain) and should
   cover this IP. We never send mail, but receiving MX hosts do check it during
   the handshake.
5. **Firewall: only 22, 80, 443 inbound.** 8080 stays on loopback — the compose
   file binds `127.0.0.1:8080:8080` on purpose. Outbound 25 must be open (that
   is step 1). Port 80 has to stay open for Caddy's ACME HTTP-01 challenge.
6. Put `API_KEY` etc. into `.env` next to `docker-compose.yml` (see
   `.env.example`), then `docker compose up -d --build`.
7. Verify: `curl -s https://verify.example.com/health` → `smtp25: true`.
   If it is still `false`, the ticket is not through or the firewall blocks
   egress — deep results stay `unknown` until it flips.
8. Point `DEEP_VERIFIER_URL` in the Node service at
   `https://verify.example.com`.

Watch the share of `unknown` results per day in the logs. Above ~40 % it is
almost always one of: port 25 closed again, IP on a blocklist, or PTR/SPF
mismatch.
