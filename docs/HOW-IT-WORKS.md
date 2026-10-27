# How it works

## The two checkpoints

Every lead passes up to two checkpoints. Both run the **same pipeline** with the same rules.

| Checkpoint | Who calls it | Strength | Blind spot |
|---|---|---|---|
| **Browser** — the embed calls `POST /v1/validate` before the form submits | the visitor's browser | instant feedback in the form; sees IP, country, device, timezone, interaction | bots that never load the page or run JavaScript |
| **Server** — a webhook (Webflow, Calendly) or your own backend calls the service after submission | server to server | cannot be bypassed; catches direct POSTs to your form endpoint | no visitor IP or User-Agent on webhook paths (see *Signals*) |

The browser checkpoint writes its result into hidden fields of the form (`lead_risk_score`,
`lead_risk_flags`, `lv_vt` token, …). The server checkpoint reads them back — a submission that
carries neither token nor signals never loaded the embed, which is itself a signal (`embed_missing`).

## Pipeline

```
Stage 0  bot signals      honeypot · time-to-submit token · rate limits · webdriver · interaction
Stage 1  email ∥ phone    syntax · typo · MX · disposable · freemail/role   |   libphonenumber · type · bot patterns
Stage 1b spam layer       geo · device · timezone/language · night · keywords · blocklists · repeats · IP
Stage 2  (optional)       SMTP deep check via deep-verifier — asynchronous, never on the request path
Decide                    hard reject reasons first, then additive score → accept / accept_flagged / reject
```

Stage 1 runs email and phone in parallel inside a time budget (`budget_ms`, 100–5000 ms, default
1500 ms). For server-side calls in a request path a small budget plus a client timeout keeps the
form fast — whatever does not finish in time comes back as `unknown`. Results are cached per address
(hashed key), so a form check while typing makes the submit-time check almost free.

## The decision

```
decision = reject          if a hard reason fires (first match wins, list below)
         = accept_flagged  if any risk flag is set
         = accept          otherwise
score    = sum of the weights of all flags          suspicious ≥ 50 · review ≥ 80
```

**Hard reject reasons, in order of precedence:**

| Reason | When |
|---|---|
| `honeypot` | the off-screen honeypot field was filled (autofill-like values are only flagged) |
| `too_fast` | submit with a valid token less than 2.5 s after the page loaded |
| `rate_limited` | submission limits exceeded — only with `RATE_LIMIT_HARD=true`, otherwise a flag |
| spam layer | a rule in `block` mode fired (`geo_denied`, `device_denied`, `contact_denied`, …) |
| `email_syntax` | invalid address — only in strict mode or when no valid phone number is present |
| `email_disposable` | disposable / throwaway domain |
| `email_no_mx` | the domain cannot receive mail (no MX, no A) — A-only domains only in strict mode |
| `phone_premium_rate` | premium-rate number (e.g. 0900) |
| `phone_invalid` | denied dial prefix (always), or invalid / bot-pattern number in strict mode |
| `spam_score` | the summed score reached `block_threshold` (off by default) |

**Defaults are deliberately lenient.** Freemail, role accounts, catch-all domains carry a flag but
zero points: a lot of real B2B leads come from `gmail.com` or `info@`. Strictness is something you
switch on per site once you have data.

### Junk vs. mistakes

Some rejects mean *the visitor mistyped* (`email_syntax`, `email_no_mx`, a plain `phone_invalid`);
the visitor sees an error message and can fix it. All others mean *this is junk*. Only junk rejects
may trigger actions outside the form — deleting a Webflow submission, cancelling a Calendly booking.
A real person with a typo or an ad blocker must never lose a booking.

## What the visitor sees (embed in `enforce` mode)

| Result | Embed behaviour |
|---|---|
| `email_*`, `phone_*` reject | inline error at the field, submit blocked, field focused — texts are configurable |
| `honeypot`, `contact_denied`, `ip_denied`, `repeat_denied` | **fake success**: the form shows its success message, nothing is sent, no redirect. A bot learns nothing |
| other spam rejects (geo, device, timezone …) | not blocked in the browser — enforced server-side only, so a false positive can still reach you |
| `too_fast`, `rate_limited` | never blocked in the browser — flag only |
| network error, timeout, non-200 | submit goes through unchanged (watchdog after 2.5 s) |

In `observe` mode nothing is ever blocked; the hidden fields are still filled, so you can analyse
decisions in your form backend or CRM before you enforce anything.

## Score weights

| Flag | Points | Source |
|---|---|---|
| `token_missing` / `token_invalid` / `token_expired` | 30 / 50 / 20 | time-to-submit token |
| `token_too_fast` | 50 | field checks only — submits reject instead |
| `honeypot_autofill_suspect` | 20 | honeypot contains an autofill-like value |
| `rate_limited` | 40 | submission limits per IP / per freemail address |
| `webdriver` / `no_interaction` | 40 / 20 | browser signals |
| `repeated_digits` / `sequential_digits` | 40 each | phone bot patterns |
| `no_trunk_prefix` | 20 | national number typed without its trunk prefix |
| `phone_dup_24h` | 30 | same number submitted within 24 h |
| `foreign` / `voip` / `typed_e164` | 10 / 10 / 5 | phone |
| `typo_suspected` / `invalid` | 10 / 10 | email typo, soft-invalid phone |
| `undeliverable` | 40 | stage 2 SMTP result |
| `geo_denied` / `geo_outside` / `geo_freemail` | 60 / 40 / 60 | spam layer: country |
| `ua_denied` | 40 | spam layer: device |
| `phone_geo_mismatch` | 40 | phone country ≠ IP country (only when the IP country is denied/outside) |
| `tz_foreign` / `lang_foreign` / `night_submit` | 30 / 20 / 15 | spam layer: browser |
| `text_denied` | 40 | spam layer: keywords |
| `contact_denied` / `ip_denied` | 60 / 60 | spam layer: blocklists |
| `repeat_contact` / `embed_missing` | 40 / 30 | spam layer: behaviour |
| `freemail`, `role_account`, `catch_all`, `geo_from_phone`, `phone_prefix_denied`, … | 0 | informational markers |

Weights live in [`src/core/types.ts`](../src/core/types.ts) (`SCORE`). They are tuned so that **two
independent strong signals together** cross the `suspicious` threshold, but one alone does not.

## The spam layer

Email and phone checks are useless against a click farm that submits a real Gmail address and a
valid mobile number. The spam layer looks at *who* submits, not *what* is submitted. Every rule is
`off` by default and has three states: `off`, `score`, `block`.

| Rule | Config keys | Signal |
|---|---|---|
| Country | `geo_mode`, `geo_allow`, `geo_deny` | IP country outside the allow list / on the deny list |
| Country + freemail | `geo_freemail_mode` | foreign country **and** a freemail address. Real foreign B2B enquiries usually come from company domains — this combination is often the sharpest single rule |
| Phone as country fallback | `geo_phone_fallback` | no IP country available (webhooks) → the phone's country stands in. An IP country always wins |
| Device | `ua_mode`, `ua_deny` | User-Agent substring blocklist (device models typical for click farms) |
| Browser locale | `client_mode`, `client_allow_tz`, `client_allow_lang` | browser timezone / language outside the allow lists — works without any geo header |
| Night window | `night_mode`, `night_from`, `night_to` | submitted inside the local night window (score only) |
| Keywords | `text_mode`, `text_deny` | keyword in free-text fields (company, name, message) |
| Contact blocklist | `contact_mode`, `contact_deny_emails`, `contact_deny_names` | exact address, `@domain`, or full name (case- and whitespace-insensitive, no substrings) |
| Repeat submissions | `repeat_mode`, `repeat_max`, `repeat_window_h` | same email or full name more than `repeat_max` times within the window — counted across forms and booking pages |
| IP blocklist | `ip_mode`, `ip_deny` | exact IPv4/IPv6 or IPv4 CIDR — browser path only |
| Embed bypass | `no_embed_mode` | webhook submission with neither token nor signals — the page was never loaded |
| Score threshold | `block_threshold` | reject once the summed score reaches the value (`null` = off) |

**Denied dial prefixes** (`phone_deny_prefixes`, e.g. `["1","2","7"]`) are a phone rule, not a spam
rule: a matching number is rejected exactly like an invalid number (`phone_invalid`, with the
marker flag `phone_prefix_denied`), in every mode and already while the visitor types.

### Signals and where they come from

| Signal | Source | Missing when |
|---|---|---|
| IP country | `CF-IPCountry`, `X-Vercel-IP-Country` or `X-Geo-Country` request header, set by your edge | the service is not behind such a proxy; on all webhook paths |
| Client IP | `CF-Connecting-IP` → first `X-Forwarded-For` → `X-Real-Ip` → socket | webhook paths |
| Device | `User-Agent` (substring match, never stored) | webhook paths |
| Timezone / language | embed sends `Intl…timeZone` and `navigator.language` | no embed |
| Freemail | email stage (`domain_class`) | no email field |
| Phone country | libphonenumber | no phone field |

**A missing signal never fires a rule.** That is the fail-open principle applied to the spam layer:
if the country is unknown, geo rules stay silent and the lead is judged on the rest.

> **Header trust.** The geo and IP headers are read as they arrive. Put the service behind a proxy
> that *overwrites* them (Cloudflare proxied, Vercel, your own reverse proxy) — otherwise a caller
> could send its own `X-Geo-Country` to dodge geo rules.

## Configuration cascade

Settings resolve **global → site → form**; `null` or absent means *inherit*.

- `mode`, `strict`, `country`, `messages`, `honeypot`: the deepest level that sets a value wins.
- `spam` merges **field by field** — a site may switch one rule to `block` and inherit the rest.
- `phone_deny_prefixes` is replaced as a **whole list**; `[]` switches an inherited list off.
- `enabled: false` on a form skips validation entirely; `fields.email|phone: false` skips one check.
- `active: false` on a site turns it off (mode `off`, its origins are no longer allowed).
- Forms are matched by `data-name` → `name` → `id` of the `<form>` element; Calendly bookings use
  the form key `calendly`.

Configuration comes either from environment variables (one global setting, good for a single site)
or from a **remote config endpoint** that you host — a JSON document the service polls every
60 s and on `POST /v1/admin/reload`. A broken or unreachable endpoint keeps the last good config;
one invalid value discards the whole payload. Format: [CONTRACT.md → Remote config](CONTRACT.md#remote-config--pull).

## Privacy

- The embed sets no cookies and uses no storage. It sends only the field being checked, plus the
  token and coarse signals (interaction yes/no, webdriver, page age, timezone, language).
- IPs are only used as salted hashes for rate limits; the salt rotates daily.
- Logs contain the domain and a short hash of an address, never the address itself.
- Statistics events contain domain class, TLD, phone type and country, the decision and the flags —
  never an address, number, name or IP.
- Repeat counters store hashed keys in process memory only; a restart resets them.
