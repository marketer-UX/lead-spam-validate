# Rollout playbook

The expensive mistake with lead validation is not letting spam through — it is silently rejecting
real customers. This playbook keeps that risk measurable at every step.

## Phase 1 — Observe (1–2 weeks)

1. Deploy the service, add the embed with `data-mode="observe"`, register the webhook with
   `WEBHOOK_ENFORCE=false`.
2. Leave every spam rule `off` or `score`. Nothing is blocked; every decision is logged and lands
   in the hidden fields and in `_validation` of forwarded leads.
3. Collect a labelled sample: for each lead of the period, note *real* or *spam* (your sales team
   knows). Thirty to fifty leads are enough to see patterns.

## Phase 2 — Measure each rule against the sample

For every candidate rule, count on the labelled sample:

| | spam caught | real leads hit (false positives) |
|---|---|---|
| rule A | 33 / 41 | 0 |
| rule B | 20 / 41 | 0 |
| rule C | 14 / 41 | 1 |

- A rule with **zero false positives** and meaningful coverage → candidate for `block`.
- A rule with false positives → `score` only. Several weak signals together can still cross
  `block_threshold` — but check that threshold against the sample, too.
- Combinations beat single signals. *Foreign country* alone hits real international enquiries;
  *foreign country + freemail address* typically does not, because real foreign B2B leads use
  company domains.

**Measure per site, not once for all.** The same rule that is perfect on one website can destroy
another: a business whose real leads come from social-media ads in in-app browsers, or from
abroad, or mostly from freemail addresses, has a completely different baseline. That is why the
cascade exists — keep global defaults at `off`/`score` and set `block` per site or per form.

## Phase 3 — Enforce, step by step

1. Switch the embed to `enforce` (server-side mode in the config — no republish needed) with
   `strict: false`. This blocks only unambiguous input: disposable addresses, domains without mail,
   premium-rate numbers, honeypot.
2. After a few days, enable `strict` where it makes sense (invalid numbers and addresses blocked
   with a friendly message — the visitor can correct them).
3. Set `WEBHOOK_ENFORCE=true` to drop rejected webhook submissions.
4. Switch the measured spam rules to `block`, one at a time, and watch the decision events.
5. Only then enable destructive actions: `WEBFLOW_DELETE_REJECTED`, Calendly cancellation.
   These act only on *junk* rejects, never on typos.

## Kill switches

| Problem | Switch | Effect |
|---|---|---|
| embed blocks real leads | `mode: "observe"` (config) or `EMBED_MODE=observe` | embed stops blocking on the next page load — no website publish |
| one rule misfires | set that rule to `score` or `off` at site/form level | next config poll (≤ 60 s) or `POST /v1/admin/reload` |
| one form misbehaves | `forms["Form name"].enabled: false` | that form is not validated at all |
| config endpoint broken | remove `CONFIG_URL` and redeploy | env values apply again |
| service down | nothing to do | embed and webhook callers fail open; leads arrive unvalidated |

## Lessons that are easy to miss

- **Activate before you embed.** When a remote config is the source of truth, an unknown site slug
  runs in `observe`. Configure and activate the site first, then add the embed — otherwise you get
  a window without protection.
- **Two validation scripts on one page** fight over the submit event. Remove any old phone/email
  validator in the same publish that adds the embed.
- **"DNS only" means no geo.** Behind Cloudflare the record must be proxied, or `CF-IPCountry`
  never arrives. Check the `geo_country` field in your decision events.
- **Webhooks have no visitor.** Webflow and Calendly call server-to-server: no IP, no User-Agent,
  no country header. Rules that depend on them stay silent; `geo_phone_fallback` closes the
  country gap.
- **Repeat counters live in memory.** A deploy resets them. They are a brake for waves, not a
  permanent ledger — use the contact blocklist for known senders.
- **Dynamic IPs.** Residential connections often get a new IP daily. An IP blocklist complements
  name/address blocklists and the repeat rule; it does not replace them.
- **Keywords are dangerous.** Words that look spammy ("SEO", "web design", "loan") often appear in
  real enquiries of the very businesses that buy those services. Test keyword lists against real
  leads before blocking.
- **Ad-blocker visitors look like bots.** Somebody whose blocker filters your validation domain
  submits without token and signals — exactly like a bot posting directly. Keep `no_embed_mode` at
  `score` until you have numbers.
- **Fix the channel, not only the form.** If one ad campaign delivers most of the spam, tightening
  its targeting (location *presence* instead of *interest*, excluding placements) removes more
  junk than any form rule.
- **Never reveal the reason to a bot.** Denied senders get a fake success; only fixable input
  errors produce a visible message.
