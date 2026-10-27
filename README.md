# lead-spam-validate

> **In plain words.** Every contact form on the internet attracts junk: bots, click farms, fake
> enquiries with made-up names, throwaway email addresses and phone numbers that do not exist.
> All of it ends up in your inbox and your CRM, and your team wastes time calling people who never
> wanted to be called. This project checks every enquiry *before* it reaches you. Real people get
> through, even if they make a typo, because they are asked to correct it. Spam is quietly
> filtered out, so your CRM stays clean. If anything goes wrong on our side, the form keeps
> working: we never lose a real customer.
>
> **Einfach erklärt.** Jedes Kontaktformular im Internet zieht Müll an: Bots, Klickfarmen,
> Fake-Anfragen mit erfundenen Namen, Wegwerf-E-Mail-Adressen und Telefonnummern, die es nicht
> gibt. Das alles landet im Postfach und im CRM, und das Team verliert Zeit mit Rückrufen bei
> Leuten, die nie angefragt haben. Dieses Projekt prüft jede Anfrage, *bevor* sie bei Ihnen
> ankommt. Echte Menschen kommen durch; wer sich vertippt, wird freundlich gebeten, es zu
> korrigieren. Spam wird still aussortiert, damit das CRM sauber bleibt. Und falls auf unserer
> Seite etwas ausfällt, funktioniert das Formular trotzdem weiter: Ein echter Kunde geht nie
> verloren.

## What it is

Self-hosted validation and spam defense for lead forms — contact forms, quote requests, newsletter
sign-ups, booking pages. One small HTTP service plus a dependency-free browser script that works on
Webflow, static sites, WordPress, React/Next.js or any HTML form.

It answers one question for every submission — **is this a real person who can be reached?** — and
it does so without CAPTCHAs, cookies or third-party tracking.

```
 Visitor ──► Form ──► validate.js (embed) ──► POST /v1/validate ──► accept · accept_flagged · reject
                │                                                         │
                └──► your form backend ──► webhook ──► server-side re-check ──► forward / drop / delete
```

## The principle

Spam on lead forms rarely looks like spam. A click farm submits a real Gmail address and a formally
valid phone number; a bot posts straight to the form endpoint without ever loading the page; a
fake-lead wave books every free slot of a public calendar. No single check catches all of that, and
every check that is too strict loses real customers. The system is built around five rules:

1. **Layered checks, one decision.** Email, phone, bot signals and spam rules each contribute flags
   and points. A few clear cases reject outright (honeypot filled, disposable address, premium-rate
   number); everything else adds up to a risk score. See [How it works](docs/HOW-IT-WORKS.md).
2. **Fail-open, always.** Timeout, provider outage, internal bug → the lead is accepted and marked
   `degraded`. The validation routes answer HTTP 200 for every outcome. The embed never blocks a form
   because of a network error, and has a watchdog that always lets the submit through.
3. **Check twice: in the browser and on the server.** The embed gives the visitor instant feedback
   and writes its findings into hidden fields. A webhook re-validates the submission server-side,
   which also catches bots that never ran any JavaScript.
4. **Observe before you enforce.** Every site starts in `observe` mode: nothing is blocked, every
   decision is logged. You measure false positives on your own traffic, then switch individual rules
   to `score` or `block` — per site, per form.
5. **Every rule has a kill switch.** Mode, strictness, texts and spam rules are delivered at runtime.
   Turning a rule off needs no deploy and no republish of the website.

Privacy by design: no cookies, no storage in the browser, only the field being checked is sent;
IPs are hashed with a rotating salt, logs and statistics events contain no addresses, numbers or names.

## What it checks

| Layer | Checks |
|---|---|
| **Email** | syntax and normalization · typo suggestion (`gmial.com` → `gmail.com`) · MX / A records · disposable domains (auto-refreshed list) · freemail and role accounts (`info@`, `sales@`) · optional SMTP deep check |
| **Phone** | parsing and E.164 normalization (libphonenumber) · mobile / fixed / VoIP / premium-rate · bot patterns (repeated or sequential digits, missing trunk prefix) · denied dial prefixes · duplicate numbers |
| **Bot** | off-screen honeypot · signed time-to-submit token (too fast / missing / expired) · `navigator.webdriver` · no user interaction · submission rate limits |
| **Spam rules** | IP country allow/deny · foreign country + freemail · device blocklist (User-Agent) · browser timezone and language · night window · keyword blocklist · contact blocklist (address, domain, full name) · repeat submissions · IP / CIDR blocklist · submissions that bypassed the embed · score threshold |

Each spam rule has three states — `off`, `score` (flag + points), `block` (reject) — and they
cascade **global → site → form**, so one form can be strict while the rest of the site only scores.

## Components

| Part | Path | Runs on |
|---|---|---|
| `validate` service (Node 20, TypeScript, [Hono](https://hono.dev)) | `src/server`, `src/core`, `src/providers` | any Docker host or PaaS |
| Browser embed `validate.js` (zero dependencies, < 10 KB) | `src/embed` → served at `/embed/v1/validate.js` | your website |
| `deep-verifier` (Go, wraps [AfterShip/email-verifier](https://github.com/AfterShip/email-verifier)) — optional | `deep-verifier/` | a VPS with outbound port 25 |

## Quick start

```bash
git clone https://github.com/marketer-UX/lead-spam-validate.git
cd lead-spam-validate
npm install
npm test                       # unit + route + embed tests (vitest, jsdom)
cp .env.example .env           # set TOKEN_SECRET, API_KEYS, ALLOWED_ORIGINS
npm run build && npm run dev   # http://localhost:8787/health
```

Try it:

```bash
curl -s -H 'X-Api-Key: CHANGE_ME' -H 'Content-Type: application/json' \
  -d '{"email":"test@mailinator.com","phone":"0900 123456","country":"DE"}' \
  http://localhost:8787/v1/validate | jq '{decision, reject_reason, score, flags}'
```

Add the embed to any page with a form:

```html
<script src="https://validate.example.com/embed/v1/validate.js" defer
  data-site="my-site" data-mode="observe" data-country="DE"></script>
```

## Documentation

| Document | Contents |
|---|---|
| [How it works](docs/HOW-IT-WORKS.md) | Pipeline, decision logic, score weights, every flag and rule |
| [Setup](docs/SETUP.md) | Deploying the service, secrets, domain and geo headers, the optional SMTP deep-verifier |
| [Integrations](docs/INTEGRATIONS.md) | Webflow · static sites (Netlify, Formspree, Hugo, Astro …) · WordPress · React/Next.js · any backend · Calendly · forwarding to a CRM |
| [Rollout playbook](docs/ROLLOUT.md) | Observe → measure → enforce, tuning rules on real traffic, kill switches, common pitfalls |
| [API contract](docs/CONTRACT.md) | Routes, request/response JSON, hidden fields, webhooks, remote config, events |
| [deep-verifier](deep-verifier/README.md) | Stage 2 SMTP verification, port 25, PTR/SPF, throttling |

## License

MIT — see [LICENSE](LICENSE). The optional `reacher` provider talks to
[Reacher](https://github.com/reacherhq/check-if-email-exists), which is AGPL-licensed; check its
license before you use it.

## Maintainers

Built and maintained by [marketer UX](https://github.com/marketer-ux-team).
