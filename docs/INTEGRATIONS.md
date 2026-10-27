# Integrations

Pick the row that matches your stack. Most setups combine **the embed** (browser checkpoint) with
**one server-side checkpoint** — a webhook or a call from your own backend.

| Stack | Browser checkpoint | Server checkpoint |
|---|---|---|
| Webflow | embed in site-wide custom code | built-in Webflow `form_submission` webhook → `/v1/hooks/webflow` |
| Static site + form service (Netlify Forms, Formspree, Basin, Getform …) | embed | the service's webhook → a small function that calls `/v1/validate` |
| Static site + own endpoint (Cloudflare Worker, Netlify/Vercel function, Lambda) | embed | call `/v1/validate` inside the function before storing the lead |
| WordPress (Contact Form 7, Gravity Forms, WPForms …) | embed in the footer | a `pre-submit` hook that calls `/v1/validate` |
| React / Next.js / Vue / any SPA | embed (binds dynamically rendered forms) **or** none | call `/v1/validate` in your API route |
| Classic backend (PHP, Rails, Django, Laravel …) | embed | call `/v1/validate` in the form controller |
| Calendly booking pages | — (no JavaScript on the page) | Calendly webhook → `/v1/hooks/calendly` |

Before you start, add every website origin to `ALLOWED_ORIGINS` (or to the site's `origins` in the
remote config). Browser calls from other origins are refused with `403`.

---

## The embed

```html
<script src="https://validate.example.com/embed/v1/validate.js" defer
  data-site="my-site"
  data-mode="observe"
  data-country="DE"
  data-honeypot="company_url_confirm"></script>
```

| Attribute | Default | Meaning |
|---|---|---|
| `data-site` | `default` | site slug — selects the site's rules |
| `data-mode` | `observe` | `observe` (never block) · `enforce` · `off`. The server value from `/v1/token` overrides it — that is your remote kill switch |
| `data-country` | `DE` | default country for numbers typed without `+` |
| `data-honeypot` | `company_url_confirm` | name of the injected honeypot field |
| `data-forms` | `form` | CSS selector: only bind matching forms (opt-in) |
| `data-email`, `data-phone` | auto | CSS selectors for the fields when auto-detection is not enough |
| `data-endpoint` | script origin | service URL, if you host `validate.js` somewhere else |
| `data-no-css` | — | do not inject the default hint styles (`.lv-hint`, `.lv-hint--error`) |

**Field detection**, per form: configured selector → `input[type=email|tel]` → `autocomplete` →
field name (`email`, `e-mail`, `mail`, `phone`, `tel`, `mobil`, `telefon`, `telefonnummer` …) → `#Phone`. Forms that
appear later (SPAs, popups, multi-step) are bound automatically. Exclude a form with
`<form data-validate="off">`.

**What it does**: checks fields on blur and while typing (debounced), shows inline hints, runs the
final check on submit, writes hidden fields into the form, and resubmits through the original
submit path (native `requestSubmit`, or jQuery for Webflow and multi-step libraries).

**Hidden fields** added to every bound form — your form backend receives them with the submission:

| Field | Example |
|---|---|
| `email_verdict` | `valid`, `catch_all`, `undeliverable`, `unknown` |
| `email_flags` | `freemail,typo_suspected` |
| `phone_e164` / `phone_type` | `+4921112345678` / `fixed_line` |
| `lead_risk_score` / `lead_risk_flags` | `40` / `freemail,foreign,tz_foreign` |
| `lv_vt` | signed time-to-submit token |
| `lv_vs` | compact browser signals (`v1;i=1;wd=0;pl=1240`) |
| honeypot (`company_url_confirm`) | must stay empty — positioned off-screen, never `display:none` |

**Events** on the `<form>`: `lv:validated` and `lv:rejected` (`event.detail` = the decision).
**JavaScript API**: `window.leadValidate.validateEmail(x)`, `.validatePhone(x)`, `.validateForm(form)`,
`.getState(form)`.

**Debug**: append `?lv_dry=1` to the page URL — the embed logs to the console and never blocks.

---

## Webflow

1. **Embed** — *Site settings → Custom code → Footer code*: paste the script tag above, publish to
   the staging domain first (`*.webflow.io` must be in the allowed origins). Remove any other
   phone/email validation script — two scripts fighting over the submit event cause double submits.
2. **Form names** — per-form rules match the form's *name* in the Designer (`data-name`).
3. **Webhook** — register a `form_submission` webhook (*Site settings → Apps & integrations →
   Webhooks*, or via the Webflow API) pointing to:
   ```
   https://validate.example.com/v1/hooks/webflow?site=my-site&k=<WEBHOOK_FALLBACK_SECRET>
   ```
   Requests are verified by `x-webflow-signature` when `WEBFLOW_WEBHOOK_SECRET` is set (webhooks
   created through the API), otherwise by the `k` query secret.
4. **What happens with a webhook submission**: the service re-runs the full pipeline (honeypot,
   token, embed signals, email, phone, spam rules) and then
   - forwards it to `FORWARD_URL` with a flat `_validation` block (optional, see *Forwarding*),
   - with `WEBHOOK_ENFORCE=true` drops rejected submissions instead of forwarding them,
   - with `WEBFLOW_DELETE_REJECTED=true` + `WEBFLOW_API_TOKEN` (scope `forms:write`) deletes junk
     from the Webflow form inbox on sites in `enforce` mode. Webflow's notification email has
     already been sent at that point — that cannot be prevented server-side.
5. **Bots that skip the page** post straight to Webflow's form endpoint. They carry no `lv_vt` /
   `lv_vs`; switch `no_embed_mode` to `score` and later `block` to catch them. Mind visitors whose
   ad blocker blocks your validation domain — they look identical; watch the numbers first.
6. **Geo on the webhook path**: Webflow calls the webhook server-to-server, so there is no visitor
   IP and no country header. Set `geo_phone_fallback: true` for the site to let the phone number's
   country stand in.

---

## Static sites

Static generators (Hugo, Jekyll, Eleventy, Astro, plain HTML) have no server of their own; the form
goes to a form service or to a serverless function.

### With a form service (Netlify Forms, Formspree, Basin …)

1. Add the embed. It works with any `<form action="…">` that submits normally.
2. In `enforce` mode bad input is blocked in the browser. Bots that post directly to the form
   service bypass the embed — close that gap with the service's webhook:

```js
// netlify/functions/lead-check.js — target of the form service's outgoing webhook
export default async (req) => {
  const sub = await req.json();
  const f = sub.data ?? sub;                     // payload shape depends on the provider
  const r = await fetch(process.env.LEAD_VALIDATE_URL + '/v1/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.LEAD_VALIDATE_KEY },
    body: JSON.stringify({
      email: f.email, phone: f.phone, mode: 'submit',
      token: f.lv_vt, honeypot: f.company_url_confirm ?? '',
      context: { site: 'my-site', form: f['form-name'] ?? 'contact', company: f.company },
    }),
    signal: AbortSignal.timeout(2000),
  }).then((x) => x.json()).catch(() => null);  // null → fail-open

  if (r?.decision === 'reject') { /* mark as spam, skip the notification, delete via the provider API */ }
  else { /* forward to your inbox / CRM with r.score and r.flags */ }
  return new Response('ok');
};
```

### With your own endpoint (recommended)

Point the form at your own function and validate **before** anything is stored or emailed:

```js
// Cloudflare Worker — the form posts here
export default {
  async fetch(req, env) {
    const form = await req.formData();
    const r = await fetch(env.LEAD_VALIDATE_URL + '/v1/validate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': env.LEAD_VALIDATE_KEY,
        // pass the visitor's context on, so IP / country / device rules can work
        'user-agent': req.headers.get('user-agent') ?? '',
        'x-forwarded-for': req.headers.get('cf-connecting-ip') ?? '',
        'x-geo-country': req.cf?.country ?? '',
      },
      body: JSON.stringify({
        email: form.get('email'), phone: form.get('phone'), mode: 'submit',
        token: form.get('lv_vt'), honeypot: form.get('company_url_confirm') ?? '',
        context: { site: 'my-site', form: 'contact' },
      }),
      signal: AbortSignal.timeout(1500),
    }).then((x) => x.json()).catch(() => null);

    if (r?.decision === 'reject') {
      // honeypot / denied senders: answer with the normal success page, store nothing
      if (['honeypot', 'too_fast', 'contact_denied', 'ip_denied', 'repeat_denied'].includes(r.reject_reason))
        return Response.redirect('https://example.com/thank-you', 303);
      return new Response('Please check your email address and phone number.', { status: 400 });
    }
    // store / forward the lead, include r.score and r.flags for your sales team
    return Response.redirect('https://example.com/thank-you', 303);
  },
};
```

Only forward visitor headers from a backend you control: the service trusts them.

---

## WordPress

1. Add the embed via your theme's footer or a "header & footer scripts" plugin.
2. Server side, hook into your form plugin's validation step (e.g. `wpcf7_before_send_mail`,
   `gform_validation`, `wpforms_process`) and call `/v1/validate` with `wp_remote_post`, a short
   timeout, and fail-open on any error:

```php
$r = wp_remote_post(LEAD_VALIDATE_URL . '/v1/validate', [
  'timeout' => 2,
  'headers' => ['content-type' => 'application/json', 'x-api-key' => LEAD_VALIDATE_KEY],
  'body'    => wp_json_encode([
    'email' => $email, 'phone' => $phone, 'mode' => 'submit',
    'token' => $_POST['lv_vt'] ?? '', 'honeypot' => $_POST['company_url_confirm'] ?? '',
    'context' => ['site' => 'my-site', 'form' => $form_name],
  ]),
]);
$v = is_wp_error($r) ? null : json_decode(wp_remote_retrieve_body($r), true);
if ($v && $v['decision'] === 'reject') { /* abort the submission */ }
```

---

## React, Next.js and other backends

The embed binds dynamically rendered forms too, but in a framework you usually own the submit
handler — validate in the API route:

```ts
// app/api/lead/route.ts (Next.js) — same idea in Express, Rails, Django, Laravel …
const r = await fetch(process.env.LEAD_VALIDATE_URL + '/v1/validate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.LEAD_VALIDATE_KEY! },
  body: JSON.stringify({ email, phone, token, honeypot, mode: 'submit', budget_ms: 300,
                         context: { site: 'my-site', form: 'contact' } }),
  signal: AbortSignal.timeout(500),
}).then((x) => x.json()).catch(() => null);   // null → fail-open, store the lead normally

if (r?.decision === 'reject') {
  // honeypot / too_fast / denied senders → neutral success response, store nothing
  // email_* / phone_* → 400 with a field error
}
```

For field-level feedback while typing, call `/v1/email` and `/v1/phone` from the browser (allowed
origins, no key) or proxy them through your API.

To get a time-to-submit token without the embed, fetch `GET /v1/token?site=my-site` when the form
renders and send the `token` value back on submit.

---

## Calendly

Public booking links are a favourite target: bots book every free slot without touching any form.

1. Create a webhook subscription for `invitee.created` pointing to
   `https://validate.example.com/v1/hooks/calendly?site=my-site` and put its signing key into
   `CALENDLY_WEBHOOK_SIGNING_KEY`.
2. The booking runs through the same pipeline (form key `calendly`): email, name, the phone answer
   (question matching *phone / telefon / mobile*), all answers as free text. Repeat counters are
   shared with your forms.
3. With `CALENDLY_TOKEN` (personal access token) a junk reject on a site in `enforce` mode cancels
   the booking; the invitee receives Calendly's normal cancellation email.

Useful rules for booking pages: `repeat_mode: block` with `repeat_max: 2`, and the contact blocklist
for names and addresses of a known wave.

---

## Forwarding to a CRM or lead store

The Webflow webhook can forward validated submissions to any HTTP endpoint (`FORWARD_URL`):

- per site, `forward: true` in the config **and** a `forward_token` in `SITES_JSON` (sent as
  `X-Source-Token`, with an optional `Origin` header from `forward_origin`);
- body = the original form fields minus honeypot and hidden fields, `phone` replaced by E.164,
  plus `_meta` (form, submission id, timestamps) and a flat `_validation` block with decision,
  score, flags and the email/phone details;
- `5xx` or network errors return `503` to Webflow, which retries the webhook;
- if your endpoint answers with `{ "lead_id": "…" }`, a later stage-2 result is PATCHed to
  `{origin of FORWARD_URL}/api/leads/{lead_id}/validation`.

If your site already pushes leads into the CRM client-side, leave `forward_token` empty: the webhook
then only validates and logs, and you avoid duplicates.

Secrets for forwarding stay in the service environment; the remote config can only switch
`forward` on or off.
