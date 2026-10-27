# API contract — lead-spam-validate

Source of truth for service, embed, webhooks, remote config and events.

Base URL in the examples: `https://validate.example.com`. All JSON. Types: `src/core/types.ts`.

## Auth (same routes for both callers)
- Browser: request must carry an `Origin` in `ALLOWED_ORIGINS` (exact, or wildcard `https://*.webflow.io`). Server echoes that origin in
  `Access-Control-Allow-Origin` (+ `Vary: Origin`), never `*`. No key. Abuse limit 60/min per IP → `429` + `Retry-After`.
  The embed POSTs with `Content-Type: text/plain` (CORS simple request, no preflight); server parses the text as JSON.
- Server-to-server: header `X-Api-Key: <key>` (`API_KEYS=id:key,id2:key2`). No Origin needed. `deep:true` allowed. Bad key → `401`.
- Neither → `403 {"ok":false,"error":"origin_not_whitelisted"}`. Body > 16 KB → `413`. Bad JSON → `400`.
- `OPTIONS` on any `/v1/*` → `204` with `Access-Control-Allow-Methods: POST, GET, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, X-Api-Key`, `Access-Control-Max-Age: 600`.

## Fail-open rule
Any internal error on `/v1/validate`, `/v1/email`, `/v1/phone` → HTTP **200** with `decision:"accept"`, `degraded:true`, `email.verdict:"unknown"`.
Only transport errors are non-200 (400/401/403/413/429). The embed treats every non-200 and every network error as `unknown` and never blocks.

## POST /v1/validate
Request (all fields optional except at least one of email/phone):
```jsonc
{ "email": "k.mueller@gmial.com", "phone": "0211/12345678", "phone_raw": "0211/12345678", "country": "DE",
  "token": "v1.demo.<ts_b36>.<nonce>.<sig>", "honeypot": "", "honeypot_name": "company_url_confirm",
  "mode": "field" | "submit", "deep": false, "budget_ms": 1500,
  "signals": { "wd": false, "i": true, "pl": 1240, "tz": "Europe/Berlin", "lg": "de-DE" },
  "site": "demo", "form": "Download Form",
  "context": { "site": "demo", "form": "Download Form", "company": "Example Ltd" } }
```
Response (HTTP 200 for every validation outcome, including reject):
```jsonc
{ "decision": "accept" | "accept_flagged" | "reject",
  "reject_reason": null | "honeypot" | "too_fast" | "rate_limited" | "email_syntax" | "email_disposable" | "email_no_mx" | "phone_invalid" | "phone_premium_rate"
                   | "geo_denied" | "client_denied" | "device_denied" | "text_denied"
                   | "contact_denied" | "repeat_denied" | "embed_missing" | "spam_score",
  "score": 10, "flags": ["typo_suspected"], "suspicious": false, "review": false,
  "email": { "verdict": "unknown", "flags": ["typo_suspected"], "suggestion": "k.mueller@gmail.com", "provider": "native",
             "latency_ms": 41, "normalized": "k.mueller@gmial.com", "cached": false },
  "phone": { "valid": true, "e164": "+4921112345678", "national": "0211 12345678", "international": "+49 211 12345678",
             "country": "DE", "type": "fixed_line", "flags": ["fixed_line"] },
  "bot":   { "honeypot": "empty", "token": "ok", "elapsed_ms": 18342, "rate_limited": false, "flags": [] },
  "degraded": false, "request_id": "…", "latency_ms": 44 }
```
- `email` is `null` when no email was sent; `phone` is `null` when no phone was sent.
- `flags` (top-level) = risk flags only: all email flags, phone `invalid|voip|premium_rate|foreign|phone_prefix_denied|repeated_digits`, and bot flags.
  Descriptive phone types (`mobile`, `fixed_line`, `toll_free`) only live in `phone.flags` / `phone.type`.
- `site`/`form` may be sent top-level or inside `context` (`context` wins); without them the site owning the `Origin` is used, else `default`.
  They select the per-form rule and end up in the log and in the decision event.
- `mode:"field"` = blur/debounce check (no submission counters, `too_fast` is only a flag). `mode:"submit"` = final check at submit time
  (submission counters, phone-dup cache, `too_fast` rejects when the token is valid).
- Spam-layer inputs the service reads itself, not from the body: `CF-IPCountry` (→ country; `X-Vercel-IP-Country`/`X-Geo-Country` are
  accepted too, `XX`/`T1` count as unknown) and `User-Agent` (device blocklist). The country needs the host **proxied** through
  Cloudflare; without the header the geo rules simply do not fire and `signals.tz`/`signals.lg` carry the layer.
- `geo_phone_fallback: true` closes exactly that gap: with no IP country the **phone country** (libphonenumber) takes its place, which is
  what makes `geo_mode`/`geo_freemail_mode` work on the Webflow-webhook path at all — that path has no client IP and therefore never a
  `CF-IPCountry`. An IP country that did arrive always wins, and `geo_allow: ["DE","AT","CH"]` keeps CH/AT numbers safe.
- The spam layer never rejects in `mode:"field"` — a policy block only ever applies to a real submission.
- `phone_deny_prefixes` is the exception that is **not** part of the spam layer: it is a phone rule. When the country calling
  code of the parsed number starts with one of the configured prefixes, the number is rejected with `reject_reason:
  "phone_invalid"` — the same reason as a structurally invalid number, so the embed shows the configured phone message
  unchanged — plus the flag `phone_prefix_denied` (0 points) so log, decision event and statistics show *why*. It needs neither
  `strict` nor `mode:"enforce"` to produce the verdict and it fires in `mode:"field"` too, so the visitor sees the message
  while typing. Fail-open: no phone, an unparseable number or an empty list → the rule does not fire.

### Spam-layer flags (`flags`, score in brackets)
`geo_denied` (60) country on the deny list · `geo_outside` (40) country outside the allow list · `geo_freemail` (60) foreign country
**and** a freemail address · `ua_denied` (40) device substring from `ua_deny` in the User-Agent · `tz_foreign` (30) browser timezone
outside `client_allow_tz` · `lang_foreign` (20) `navigator.language` outside `client_allow_lang` · `night_submit` (15) submitted inside
the night window · `phone_geo_mismatch` (40) phone country ≠ IP country, **only** when that IP country is denied or outside the allow
list (travel inside the allowed countries stays clean), and never when the country itself came from the phone · `geo_from_phone` (0)
marker: no IP country arrived and `geo_phone_fallback` let the phone country stand in — set only when a geo rule actually fired, so the
source of a verdict is visible in the log and in the decision event · `text_denied` (40) keyword from `text_deny` in a text field — the embed
offers only `context.company`, the Webflow webhook additionally name and message · `contact_denied` (60) address, `@domain` or
full name on `contact_deny_emails`/`contact_deny_names` (exact, no substrings) · `repeat_contact` (40) the same e-mail or full name
already submitted `repeat_max` times inside `repeat_window_h` (submit/webhook/Calendly only, process-local counter, one submission
seen by embed and webhook counts once via its token) · `embed_missing` (30) webhook submission with neither `lv_vt` nor `lv_vs` · `ip_denied` (60) client IP (`CF-Connecting-IP` →
XFF → X-Real-Ip) on `ip_deny` (exact IPv4/IPv6 or IPv4 CIDR) — `/v1/validate` only, the webhooks have no visitor IP. The embed in
`enforce` answers `contact_denied`/`ip_denied`/`repeat_denied` like the honeypot: fake success, nothing submitted.

**Junk rejects** (`isJunkReject`): every reject except `email_syntax`, `email_no_mx` and a plain `phone_invalid` (a denied dial
prefix counts as junk). Only junk may trigger an action outside the form: deleting the Webflow submission, cancelling the Calendly
booking.

## POST /v1/email
`{ "email": "…", "deep": false, "budget_ms": 1500, "site": "demo", "form": "Contact" }` → `{ verdict, flags, suggestion?, provider, latency_ms, normalized, cached, decision_hint: "accept"|"accept_flagged"|"reject", reject_reason }`

## POST /v1/phone
`{ "phone": "…", "phone_raw": "…", "country": "DE", "site": "demo", "form": "Contact" }` → `PhoneCheckResult` + `{ reject_reason, decision_hint, request_id }`.
`country` defaults to the effective country of the site. With `fields.phone: false` or `enabled: false` the number is returned unjudged (`reject_reason: null`).
A denied dial prefix answers `reject_reason: "phone_invalid"`, `decision_hint: "reject"` and carries `phone_prefix_denied` in `flags` — this is the
route the embed uses for its field check, which is why the rule is visible while the visitor is still typing.

## GET /v1/token?site=demo
```jsonc
{ "token": "v1.demo.<ts_b36>.<nonce>.<sig>", "ttl_s": 21600, "site": "demo",
  "mode": "observe" | "enforce" | "off", "strict": true, "country": "DE",
  "messages": { "email": "Please enter a valid email address.", "phone": "Please enter a valid phone number." },
  "forms": { "Newsletter Subscription": { "enabled": true, "fields": { "email": true, "phone": false }, "mode": null, "strict": null } } }
```
`Cache-Control: no-store`. Without `?site=` the site owning the request `Origin` is used (runtime config), else `default`.
`mode`/`strict`/`country`/`messages` are the **effective** values for that site (remote config, else env) and override the embed's
`data-mode`/`data-country` (remote kill switch). `forms` = that site's form rules (`{}` when none); the embed matches the form key
`data-name` → `name` → `id`. Token = HMAC-SHA256 over `site.ts.nonce`; elapsed < 2500 ms → `too_fast`, > 6 h → `expired`.

## GET /health
```jsonc
{ "ok": true, "version": "…", "uptime_s": 12, "provider": "aftership", "deep_reachable": true,
  "embed_mode": "enforce", "strict": true,
  "config": { "source": "remote" | "env", "version": "abc123…" | "env", "fetched_at": "ISO" | null, "sites": 3 },
  "events": { "buffered": 0, "sent": 42, "dropped": 0, "failed": 0 },
  "field_checks": 128, "queue": null }
```
Always 200. Full body only with a valid `X-Api-Key`; without one (or with a wrong key) the response is the minimal probe
`{ "ok": true, "version": "…", "uptime_s": 12 }` — enough for uptime monitoring, no internals. `config.source = env` = config server
unreachable/not configured → env fallback (`EMBED_MODE`, `STRICT_CONTACT`, …).

## Remote config — pull
`GET {CONFIG_URL}` with `X-Api-Key: <CONTROL_API_KEY>` and `If-None-Match: "<version>"`, 3 s timeout, at boot and every `CONFIG_POLL_S` (60 s).
Answers: `200` JSON (below) · `304` unchanged · `401`/`503` → the last good config stays. Invalid payload (enum/regex/length) → discarded + `config.invalid` log.
```jsonc
{ "version": "abc123…",
  "global": { "mode": "enforce", "strict": true, "rate_limit_hard": false, "country": "DE",
              "messages": { "email": "…", "phone": "…" },
              "phone_deny_prefixes": ["1","2","7","8","9"],
              "spam": { "geo_mode": "score", "geo_allow": ["DE","AT","CH"], "geo_deny": ["NG","PK","IN"],
                        "geo_freemail_mode": "block", "geo_phone_fallback": false,
                        "client_mode": "score", "client_allow_tz": ["Europe/"], "client_allow_lang": ["de","en"],
                        "ua_mode": "block", "ua_deny": ["tecno","infinix","itel"],
                        "night_mode": "score", "night_from": 1, "night_to": 5,
                        "text_mode": "off", "text_deny": [],
                        "block_threshold": null } },
  "sites": [ { "slug": "demo", "name": "Example", "active": true,
               "origins": ["https://example.com", "https://*.webflow.io"],
               "webflow_site_id": "0123456789abcdef01234567", "honeypot": "company_url_confirm", "country": "DE",
               "mode": null, "strict": null, "messages": null, "phone_deny_prefixes": null,
               "spam": { "geo_deny": ["NG"], "geo_phone_fallback": true }, "forward": false,
               "forms": { "Newsletter Subscription": { "enabled": true, "fields": { "email": true, "phone": false } },
                          "Site Audit": { "enabled": false },
                          "Quote Request": { "mode": "enforce", "strict": true, "phone_deny_prefixes": ["1","2","7","8","9"] } } } ] }
```
Limits: ≤ 200 sites, ≤ 100 forms and ≤ 50 origins per site, messages ≤ 200 chars, slug `^[a-z0-9][a-z0-9_-]{0,31}$`,
honeypot `^[a-zA-Z][a-zA-Z0-9_-]{1,63}$`, `webflow_site_id` `^[a-f0-9]{24}$`, origins `^https?://(\*\.)?[a-z0-9.-]+(:\d+)?$`, mode `observe|enforce|off`.
`phone_deny_prefixes`: dial prefixes **without** the plus, `^[0-9]{1,4}$`, ≤ 20 entries, settable at every cascade level
(absent/`null` = inherit, `[]` = rule off). An invalid entry discards the whole config like every other field.
`spam`: every field optional (absent = inherit), rule modes `off|score|block`, `night_mode` `off|score`, `geo_phone_fallback` a plain
boolean (default `false`), ≤ 60 countries (ISO-3166-1 alpha-2), ≤ 25 timezone prefixes, ≤ 25 language subtags, ≤ 100 entries of ≤ 60 chars
in `ua_deny`/`text_deny`, hours 0–23, `block_threshold` 1–1000 or `null` (off). One invalid value discards the **whole** config — the last
good one stays.

**Cascade** `effective(site, form)` = global → site → form, `null` = inherit:
`{ mode, strict, rate_limit_hard, country, honeypot, messages, phone_deny_prefixes, spam, enabled, fields: { email, phone }, forward, known_site }`.
- `phone_deny_prefixes` inherits as a **whole list** (no field-by-field merge): the deepest level that sets it wins, `[]`
  switches an inherited list off. It sits next to `country`/`messages.phone` and not in `spam`, because it behaves like
  `phone_invalid`: it blocks in the browser (field + submit) and rejects server-side on the webhook/intake path.
- `spam` merges **field by field** (`{ ...global.spam, ...site.spam, ...form.spam }`), so a site may override a single rule and inherit
  the rest. That includes `geo_phone_fallback`: it is meant to be switched on per site (or per form) where the leads arrive through the
  Webflow webhook, and left `false` globally. `block_threshold: null` at a lower level switches an inherited threshold off. Rules default to `off` → the layer changes
  nothing until the remote config switches it on, and the env fallback keeps it off entirely.
- `active: false` (site) → `enabled: false` + `mode: "off"`; its origins are **not** whitelisted.
- `forms[x].enabled: false` → validation is skipped entirely: `decision "accept"`, `reject_reason null`, `score 0`, `flags []`,
  no email/phone/bot evaluation (the embed injects no hidden fields for such forms).
- `fields.email|phone: false` → that field is not evaluated (response `email`/`phone` = `null`).
- Unknown slug → global values but `mode: "observe"` (remote source); with the env fallback the env values apply unchanged.
- `forward_token`/`forward_origin` are **never** delivered by the remote config — they stay in `SITES_JSON` and are merged in by slug.
  Webhook forward = `forward && forward_token && FORWARD_URL`.
- Origins = `ALLOWED_ORIGINS` ∪ origins of all **active** sites (wildcards allowed).

## Events — push
`POST {EVENTS_URL}` with `X-Api-Key`, batch ≤ 200 events / ≤ 256 KB, every `EVENTS_FLUSH_S` (10 s) or at 100 buffered events, 5 s timeout.
```jsonc
{ "events": [ { "ts": "ISO", "rid": "uuid", "site": "demo", "form": "Contact" | null,
                "mode": "field" | "submit" | "webhook", "decision": "accept" | "accept_flagged" | "reject",
                "reason": "email_disposable" | null, "score": 40, "flags": ["disposable"],
                "email_domain_class": "freemail" | null, "email_tld": "de" | null, "email_verdict": "unknown" | null,
                "phone_type": "mobile" | null, "phone_country": "DE" | null,
                "token": "ok|missing|invalid|too_fast|expired", "blocked": false,
                "geo_country": "NG" | null } ] }
```
No PII — never the address, the number, a name or an IP. `geo_country` is the country of the client IP (ISO-3166-1 alpha-2), never the IP. `blocked` = `mode === "submit" && decision === "reject" && effective.mode === "enforce"`.
`mode: "field"` is only sent for `reject`/`accept_flagged`. Answers: `200 {ok,stored:true,received}` = stored · `202 {stored:false}` and every `4xx` =
batch dropped · `5xx`/network = kept, retry after 30 s backoff. Buffer ≤ 2000 events, oldest dropped first. Without `EVENTS_URL` nothing is collected.

## Admin (API key only, no Origin path, `Cache-Control: no-store`)
- `POST /v1/admin/reload` → pulls the config now → `{ ok, version, source, sites, changed, status, fetched_at }`. Call it from your admin backend after every save.
- `GET /v1/admin/config` → effective runtime config for debugging: `{ source, version, fetched_at, configured, last_error, last_status, global, allowed_origins, sites: [...] }`.
  Contains **no** tokens/secrets — instead `forward_ready: true|false` per site.
- Missing/incorrect `X-Api-Key` → `401 {"ok":false,"error":"api_key_required"}`.

## GET /embed/v1/validate.js
JavaScript, `Cache-Control: public, max-age=300, stale-while-revalidate=86400`, `ETag`, `Access-Control-Allow-Origin: *`.

## Embed hidden fields (injected into every validated form; `name` AND `data-name` set)
`email_verdict`, `email_flags` (comma-joined), `phone_e164`, `phone_type`, `lead_risk_score`, `lead_risk_flags` (comma-joined),
`lv_vt` (token), `lv_vs` (`v1;i=1;wd=0;pl=1240`), honeypot text input `company_url_confirm` (configurable, off-screen, never `display:none`).

## POST /v1/hooks/webflow?site=demo&k=<WEBHOOK_FALLBACK_SECRET>
Webflow `form_submission` payload: `{ triggerType, payload: { id, name, siteId, formId, submittedAt, data: { "Name": "…", "E-Mail": "…", "Telefonnummer": "…", "company_url_confirm": "", "lv_vt": "…", … } } }`.
Verification: `x-webflow-signature` = hex HMAC-SHA256(`WEBFLOW_WEBHOOK_SECRET`, `"<x-webflow-timestamp>:<rawBody>"`) and |now − ts| ≤ 5 min; otherwise `k` query secret.
Responses: 200 processed / duplicate; 401 bad auth; 503 forward target unreachable (Webflow retries); 200 `{ok:false,degraded:true}` on own bug.
Webflow calls this server-to-server: there is no client IP, so no `CF-IPCountry` and no `User-Agent` of the visitor. Only
`spam.geo_phone_fallback: true` gives the geo rules a country on this path (the phone country) — the flag `geo_from_phone` then marks it.
Response adds `reason` and `deleted`. With `WEBFLOW_DELETE_REJECTED=true` + `WEBFLOW_API_TOKEN` (forms:write), a junk reject on a site
in `enforce` is deleted via `DELETE https://api.webflow.com/v2/form_submissions/<id>` (Webflow's notification mail is already out).

## POST /v1/hooks/calendly?site=demo
Calendly webhook subscription, event `invitee.created` (others → `{ok:true, ignored}`). Verification: header
`Calendly-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(CALENDLY_WEBHOOK_SIGNING_KEY, "<t>.<rawBody>")>`, |now − t| ≤ 5 min;
without a signing key the `k` query secret (`WEBHOOK_FALLBACK_SECRET`). Runs the same pipeline as a webhook submission
(`mode: webhook`, form key `calendly` → per-form rules under `forms.calendly`): e-mail, name, phone from the question matching
/telefon|phone|handy|mobil/ (else `text_reminder_number`), all answers as message. A junk reject on a site in `enforce` with
`CALENDLY_TOKEN` set cancels the booking: `POST <scheduled_event.uri>/cancellation` (URI must be `https://api.calendly.com/scheduled_events/…`).
Response `{ ok, decision, reason, cancelled }`; dedup per invitee URI; own bug → 200 `{ok:false,degraded:true}`.

## Forward to a lead store (`POST FORWARD_URL`, `X-Source-Token`, `Origin: <site.forward_origin>`)
Only when `effective(site, form).forward` is true AND the site has a `forward_token` in `SITES_JSON` (else: validate + log only).
Body = original display-name fields minus raw phone/honeypot/`lv_*`/`email_*`/`phone_*`/`lead_risk_*`, plus `phone: <e164>`,
`_meta: { source: "webflow-webhook", form, submitted_at, webflow_submission_id, site }` and FLAT `_validation`:
`{ v: 1, decision, score, flags: [...], review, email_verdict, email_flags: [...], email_suggestion, phone_e164, phone_type, phone_flags: [...], token, at }`.
