# Setup

The service is a single stateless Node process (in-memory caches only). Run one instance per
environment; it needs no database.

## 1. Secrets

| Variable | Required | How to create |
|---|---|---|
| `TOKEN_SECRET` | yes | `openssl rand -hex 32` — signs the time-to-submit tokens |
| `API_KEYS` | yes | `id:key,id2:key2` — keys for server-to-server callers (your backend, admin tools). `openssl rand -hex 24` per key |
| `ALLOWED_ORIGINS` | yes | comma-separated origins of your websites, wildcards allowed: `https://example.com,https://*.webflow.io` |
| `IP_SALT_SECRET` | recommended | random; salts the IP hashes used for rate limits |
| `TOKEN_SECRET_PREV` | optional | the previous `TOKEN_SECRET` during a rotation, so open pages keep working |

With `NODE_ENV=production` (set in the Dockerfile) the service refuses to boot without the first
three. All other variables are documented in [`.env.example`](../.env.example).

## 2. Deploy

Any platform that runs a Dockerfile works: Railway, Render, Fly.io, Google Cloud Run, a VPS with
Docker, Kubernetes.

```bash
docker build -t lead-spam-validate .
docker run -d -p 8787:8787 --env-file .env lead-spam-validate
curl -s localhost:8787/health          # {"ok":true,"version":"…","uptime_s":…}
```

- Health check path: `/health` (always 200; full details only with a valid `X-Api-Key`).
- Port: `PORT` (default `8787`).
- Caches are bounded LRUs, so memory stays flat; the smallest instance size of most platforms is enough.
- Rate limits, repeat counters and caches are per process. With several instances behind a load
  balancer, each counts on its own — fine for spam defense, but keep it in mind for `repeat_max`.
- Without Docker: `npm ci && npm run build && npm start`.

> **Deploys that upload the working directory** (`railway up`, `fly deploy` from a laptop …) ship
> whatever is on disk, not what is in git. Pull before you deploy.

## 3. Domain and geo headers

Serve the service on its own subdomain, e.g. `validate.example.com`. The embed is loaded from the
same host (`/embed/v1/validate.js`), so it needs no extra configuration.

The country-based rules need a **country header** set by the edge in front of the service:

| Edge | Header | Notes |
|---|---|---|
| Cloudflare | `CF-IPCountry`, `CF-Connecting-IP` | the DNS record must be **proxied** (orange cloud). "DNS only" delivers no header |
| Vercel | `X-Vercel-IP-Country` | when the service runs behind a Vercel rewrite |
| your own proxy | `X-Geo-Country` (ISO 3166-1 alpha-2) | e.g. nginx with GeoIP2, Caddy with a geo module |

The proxy must **overwrite** these headers on every request — the service trusts what it receives.
Without a country header the geo rules simply never fire; timezone, language and device rules
still work because they come from the browser.

`CANONICAL_HOST` + `CANONICAL_FROM_SUFFIX` optionally 301-redirect requests on the platform's
default domain (e.g. `.up.railway.app`) to your domain. Set them only after every caller —
webhooks in particular — uses the custom domain: a 301 turns a webhook POST into a failed GET.

## 4. Optional: remote config and statistics

Environment variables give you one global configuration. For several sites, per-form rules, or
changing rules without a redeploy, host a small **config endpoint** — any URL that returns the JSON
described in [CONTRACT.md → Remote config](CONTRACT.md#remote-config--pull). It can be a static
JSON file behind auth, a serverless function, or a page in your admin backend.

```bash
CONFIG_URL=https://admin.example.com/api/lead-validation/config
CONTROL_API_KEY=…                       # sent as X-Api-Key
CONFIG_POLL_S=60
```

The service pulls at boot, every `CONFIG_POLL_S` seconds (with `If-None-Match`), and immediately on
`POST /v1/admin/reload` — call that from your admin backend after every save. If the endpoint is
down or returns an invalid document, the last good config stays active.

For statistics, set `EVENTS_URL`: the service POSTs batches of PII-free decision events (site, form,
decision, reason, score, flags, domain class, TLD, phone type, countries). Store them in any
database and you can answer *how many leads did rule X reject on form Y last week?*

## 5. Optional: SMTP deep verification

Stage 1 (syntax, MX, disposable lists) catches most bad addresses. Stage 2 asks the recipient's mail
server whether the mailbox exists — without sending a mail. It runs asynchronously and never delays
the form.

```bash
EMAIL_VERIFIER_PROVIDER=aftership
DEEP_VERIFIER_URL=https://verify.example.com
DEEP_VERIFIER_KEY=…                     # API_KEY of the deep-verifier
```

The `deep-verifier` needs **outbound port 25**, which most PaaS platforms block, plus a dedicated
IP with matching PTR record, A record and SPF. Without that, large mail providers refuse the
handshake and every result is `unknown` (fail-open). Full checklist:
[deep-verifier/README.md](../deep-verifier/README.md).

Stage 2 results land in the cache and, if you configure a lead store (`FORWARD_URL` +
`CONTROL_API_KEY`), are PATCHed onto the forwarded lead as `_validation.stage: 2`.

## 6. Smoke test

```bash
BASE=https://validate.example.com KEY=…
curl -s $BASE/health
curl -s -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"test@mailinator.com"}' $BASE/v1/validate | jq '{decision, reject_reason}'
# → {"decision":"reject","reject_reason":"email_disposable"}
curl -s -H "X-Api-Key: $KEY" $BASE/health | jq '{config, events}'
```

Then open a page with the embed and append `?lv_dry=1` to the URL: the embed logs what it would do
to the browser console and never blocks.
