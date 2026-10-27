// Webflow `form_submission` webhook → server-side re-validation → forward to the lead store intake.
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { effective } from '../../core/effective.js';
import { isJunkReject } from '../../core/score.js';
import { mapFields } from '../../core/fields.js';
import { normalizeSite } from '../../core/token.js';
import { HIDDEN_FIELDS, type RiskFlag } from '../../core/types.js';
import { HOUR, TtlLru } from '../cache.js';
import type { Config } from '../config.js';
import { forwardLead } from '../forward.js';
import { emailHash, sha256Hex } from '../hash.js';
import { errMsg, log } from '../log.js';
import { safeEqual } from '../mw.js';
import { runValidate, type Services } from '../pipeline.js';
import { deleteWebflowSubmission } from '../webflow-api.js';

const MAX_BODY = 256 * 1024;
const HIDDEN = new Set<string>(Object.values(HIDDEN_FIELDS));

export interface WebhookDeps { svc: Services; seen: TtlLru<string, number>; fetchImpl?: typeof fetch }

function verifySignature(cfg: Config, c: { header(n: string): string | undefined; query(n: string): string | undefined }, raw: string, now: number): 'signature' | 'fallback' | null {
  const sig = c.header('x-webflow-signature');
  const ts = c.header('x-webflow-timestamp');
  if (sig && ts && cfg.webflowWebhookSecret) {
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 5 * 60_000) return null;
    const expected = createHmac('sha256', cfg.webflowWebhookSecret).update(`${ts}:${raw}`).digest('hex');
    return safeEqual(expected, sig) ? 'signature' : null;
  }
  const k = c.query('k');
  if (k && cfg.webhookFallbackSecret && safeEqual(k, cfg.webhookFallbackSecret)) return 'fallback';
  return null;
}

function parseSignals(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v.startsWith('v1')) return null;
  const out: Record<string, unknown> = {};
  for (const part of v.split(';').slice(1)) {
    const [k, val] = part.split('=');
    if (k === 'i' || k === 'wd') out[k] = val === '1';
    if (k === 'pl') out[k] = parseInt(val ?? '', 10);
  }
  return out;
}

export function webflowHookRoutes(deps: WebhookDeps): Hono {
  const { svc } = deps;
  const cfg = svc.cfg;
  const r = new Hono();

  r.post('/v1/hooks/webflow', async (c) => {
    const now = Date.now();
    const rid = crypto.randomUUID();
    let raw = '';
    try {
      const len = parseInt(c.req.header('content-length') ?? '0', 10);
      if (len > MAX_BODY) return c.json({ ok: false, error: 'payload_too_large' }, 413);
      raw = await c.req.text();
      if (raw.length > MAX_BODY) return c.json({ ok: false, error: 'payload_too_large' }, 413);
      const how = verifySignature(cfg, { header: (n) => c.req.header(n), query: (n) => c.req.query(n) }, raw, now);
      if (!how) { log.warn('webhook.unauthorized', { rid }); return c.json({ ok: false, error: 'unauthorized' }, 401); }

      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: 'body_invalid_json' }, 400); }
      const payload = (body.payload && typeof body.payload === 'object' ? body.payload : body) as Record<string, unknown>;
      const trigger = typeof body.triggerType === 'string' ? body.triggerType : 'form_submission';
      if (trigger !== 'form_submission') return c.json({ ok: true, ignored: trigger }, 200);
      const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
      const formName = typeof payload.name === 'string' ? payload.name : 'unknown';
      const siteId = typeof payload.siteId === 'string' ? payload.siteId : typeof payload.site === 'string' ? payload.site : null;
      const submittedAtRaw = typeof payload.submittedAt === 'string' ? payload.submittedAt : typeof payload.d === 'string' ? payload.d : null;
      const submittedAt = submittedAtRaw ? Date.parse(submittedAtRaw) : NaN;
      const refNow = Number.isFinite(submittedAt) ? submittedAt : now;
      const subId = typeof payload.id === 'string' ? payload.id : typeof payload._id === 'string' ? payload._id : null;

      const site = normalizeSite(c.req.query('site'));
      const runtime = svc.runtime.get();
      const eff = effective(runtime, site, formName); // per-form rule from the remote config
      const siteCfg = runtime.sites.get(site);
      if (siteCfg?.webflow_site_id && siteId && siteCfg.webflow_site_id !== siteId.toLowerCase()) {
        log.warn('webhook.site_mismatch', { rid, site });
        return c.json({ ok: false, error: 'site_mismatch' }, 403);
      }

      const { std, keys } = mapFields(data);
      const dedupKey = subId ? `wf:${subId}` : `wf:${sha256Hex(`${payload.formId ?? formName}|${submittedAtRaw ?? ''}|${std.email ? emailHash(std.email) : ''}`)}`;
      if (deps.seen.get(dedupKey, now)) return c.json({ ok: true, duplicate: true }, 200);

      const honeypotName = eff.honeypot;
      const honeypotVal = typeof data[honeypotName] === 'string' ? data[honeypotName] as string : undefined;
      const extraFlags: RiskFlag[] = [];
      const clientVerdict = typeof data[HIDDEN_FIELDS.email_verdict] === 'string' ? data[HIDDEN_FIELDS.email_verdict] as string : null;
      // The embed writes a token and a signals field into every form it touched. Neither present =
      // the submission was posted straight to Webflow's form endpoint, without the page ever loading.
      const filled = (k: string) => typeof data[k] === 'string' && (data[k] as string).trim() !== '';
      const embedMissing = !filled(HIDDEN_FIELDS.token) && !filled(HIDDEN_FIELDS.signals);

      const res = await runValidate(svc, {
        email: std.email, phone: std.phone, phone_raw: std.phone, country: 'DE',
        token: data[HIDDEN_FIELDS.token], honeypot: honeypotVal, honeypot_name: honeypotName,
        signals: parseSignals(data[HIDDEN_FIELDS.signals]),
        // name/message only exist on this path (the browser sends just the company field) — the
        // text blocklist of the spam layer therefore sees the full submission here.
        context: {
          site, form: formName, company: std.company ?? null,
          name: std.name ?? [std.first_name, std.last_name].filter(Boolean).join(' ') ?? null,
          message: std.message ?? null,
        },
      }, { site, form: formName, ipHash: null, allowDeep: false, refNow, requestId: rid, mode: 'webhook', skipQueue: true, extraFlags, embedMissing });
      if (clientVerdict && res.email && clientVerdict !== res.email.verdict && clientVerdict !== 'unknown') {
        // informational only (client had a different/older view)
        res.flags.push('client_mismatch');
      }

      // Junk that got past the embed (or never met it) still sits in Webflow and in its notification
      // mail. On an enforcing site, remove it from Webflow — only for junk rejects, never for a typo.
      let deleted = false;
      if (subId && cfg.webflowDeleteRejected && cfg.webflowApiToken && eff.mode === 'enforce' && isJunkReject(res)) {
        deleted = await deleteWebflowSubmission(cfg.webflowApiToken, subId, deps.fetchImpl);
        log.info('webhook.webflow_delete', { rid, site, form: formName, reason: res.reject_reason, ok: deleted });
      }

      // Sites whose forms already push leads to the lead store client-side (an intake script on the page) have no
      // forward_token: the webhook then only validates/logs and warms the Stage-2 queue — no duplicate lead.
      const forwardEnabled = !!(cfg.forwardUrl && eff.forward && eff.forward_token);
      const forwarded = forwardEnabled && (cfg.webhookEnforce ? res.decision !== 'reject' : true);
      if (!forwardEnabled) {
        deps.seen.set(dedupKey, now, HOUR, now);
        if (svc.queue && res._email?.normalized && res.decision !== 'reject' && res._email.domain_class !== 'disposable' && !res._email.hard_no_mx) {
          svc.queue.enqueue({ email: res._email.normalized, hash: emailHash(res._email.normalized), lead_id: null, site });
        }
        log.info('webhook.observed', { rid, site, form: formName, decision: res.decision, reason: res.reject_reason, score: res.score, flags: res.flags, how, forward: 'disabled' });
        return c.json({ ok: true, forwarded: false, forward: 'disabled', decision: res.decision, reason: res.reject_reason, score: res.score, deleted }, 200);
      }
      if (!forwarded) {
        deps.seen.set(dedupKey, now, HOUR, now);
        log.info('webhook.rejected', { rid, site, form: formName, reason: res.reject_reason, score: res.score, how });
        return c.json({ ok: true, forwarded: false, decision: res.decision, reason: res.reject_reason, deleted }, 200);
      }

      // Build the lead store body: original display-name fields minus our hidden/honeypot fields, phone replaced by E.164.
      const leadBody: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (HIDDEN.has(k) || k === honeypotName || k === 'website') continue;
        if (keys.phone && k === keys.phone) continue;
        if (/^(lv_|email_|phone_|lead_risk_)/.test(k)) continue;
        leadBody[k] = v;
      }
      if (std.phone) leadBody.phone = res.phone?.valid && res.phone.e164 ? res.phone.e164 : std.phone;
      leadBody._meta = { source: 'webflow-webhook', form: formName, submitted_at: submittedAtRaw, webflow_submission_id: subId, site, url: null };
      leadBody._validation = {
        v: 1, decision: res.decision, reject_reason: res.reject_reason, score: res.score, flags: res.flags, review: res.review, suspicious: res.suspicious,
        email_verdict: res.email?.verdict ?? null, email_flags: res.email?.flags ?? [], email_suggestion: res.email?.suggestion ?? null,
        phone_e164: res.phone?.e164 ?? null, phone_type: res.phone?.type ?? null, phone_flags: res.phone?.flags ?? [],
        token: res.bot.token, honeypot: res.bot.honeypot, at: new Date(now).toISOString(),
      };
      const fw = await forwardLead(cfg, { forward_token: eff.forward_token, forward_origin: eff.forward_origin }, leadBody, deps.fetchImpl);
      if (!fw.ok) {
        if (fw.retryable) {
          log.warn('webhook.forward_retryable', { rid, status: fw.status, error: fw.error });
          return c.json({ ok: false, error: 'forward_unavailable' }, 503);
        }
        deps.seen.set(dedupKey, now, HOUR, now);
        log.error('webhook.forward_rejected', { rid, status: fw.status, error: fw.error });
        return c.json({ ok: false, forwarded: false, error: fw.error ?? 'forward_rejected', decision: res.decision }, 200);
      }
      deps.seen.set(dedupKey, now, HOUR, now);
      if (svc.queue && res._email?.normalized && res.decision !== 'reject' && res._email.domain_class !== 'disposable' && !res._email.hard_no_mx) {
        svc.queue.enqueue({ email: res._email.normalized, hash: emailHash(res._email.normalized), lead_id: fw.lead_id, site });
      }
      log.info('webhook.forwarded', { rid, site, form: formName, decision: res.decision, score: res.score, lead_id: fw.lead_id, how });
      return c.json({ ok: true, forwarded: true, lead_id: fw.lead_id, decision: res.decision, score: res.score }, 200);
    } catch (e) {
      log.error('webhook.degraded', { rid, err: errMsg(e) });
      return c.json({ ok: false, degraded: true }, 200);
    }
  });
  return r;
}
