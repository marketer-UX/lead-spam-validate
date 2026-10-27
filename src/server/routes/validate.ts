import { Hono } from 'hono';
import { effective } from '../../core/effective.js';
import { checkPhone } from '../../core/phone.js';
import { decide } from '../../core/score.js';
import { normalizeSite } from '../../core/token.js';
import type { Context } from 'hono';
import type { AppEnv } from '../mw.js';
import { clientCountry, clientIp, jsonError, readJson } from '../mw.js';
import { degradedResult, runValidate, type Services } from '../pipeline.js';
import { errMsg, log } from '../log.js';

const MAX_BODY = 16 * 1024;

function ctxOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.context && typeof body.context === 'object' ? body.context as Record<string, unknown> : {};
}

/** site: context.site → site → Origin (runtime config) → 'default' */
function siteOf(body: Record<string, unknown>, c: Context<AppEnv>): string {
  const ctx = ctxOf(body);
  const explicit = typeof ctx.site === 'string' ? ctx.site : typeof body.site === 'string' ? body.site : null;
  return normalizeSite(explicit ?? c.get('siteHint') ?? 'default');
}

/** form key = Webflow `data-name`; carried into logs, events and the per-form rules */
function formOf(body: Record<string, unknown>): string | null {
  const ctx = ctxOf(body);
  const v = typeof ctx.form === 'string' ? ctx.form : typeof body.form === 'string' ? body.form : null;
  const s = v?.trim();
  return s ? s.slice(0, 100) : null;
}

export function validateRoutes(svc: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/v1/validate', async (c) => {
    const start = Date.now();
    const rid = c.get('rid');
    const rb = await readJson(c, MAX_BODY);
    if ('error' in rb) return jsonError(c, rb.error, rb.error === 413 ? 'payload_too_large' : 'body_invalid_json');
    const body = rb.body;
    try {
      const auth = c.get('auth');
      const res = await runValidate(svc, body, {
        site: siteOf(body, c), form: formOf(body), ipHash: c.get('ipHash'), geoCountry: clientCountry(c),
        userAgent: c.req.header('user-agent') ?? null, ip: clientIp(c),
        allowDeep: auth.kind === 'server', requestId: rid,
      });
      const { _email, ...out } = res;
      return c.json(out, 200);
    } catch (e) {
      log.error('validate.failopen', { rid, err: errMsg(e) });
      return c.json(degradedResult(rid, start, typeof body.email === 'string', typeof body.phone === 'string'), 200);
    }
  });

  r.post('/v1/email', async (c) => {
    const start = Date.now();
    const rid = c.get('rid');
    const rb = await readJson(c, MAX_BODY);
    if ('error' in rb) return jsonError(c, rb.error, rb.error === 413 ? 'payload_too_large' : 'body_invalid_json');
    const body = rb.body;
    try {
      const auth = c.get('auth');
      const res = await runValidate(svc, { email: body.email, deep: body.deep, budget_ms: body.budget_ms, mode: 'field', context: body.context },
        { site: siteOf(body, c), form: formOf(body), ipHash: c.get('ipHash'), allowDeep: auth.kind === 'server', requestId: rid });
      const email = res.email ?? { verdict: 'unknown', flags: [], provider: 'native', latency_ms: 0 };
      return c.json({ ...email, decision_hint: res.decision, reject_reason: res.reject_reason, request_id: rid }, 200);
    } catch (e) {
      log.error('email.failopen', { rid, err: errMsg(e) });
      return c.json({ verdict: 'unknown', flags: [], provider: 'native', latency_ms: Date.now() - start, decision_hint: 'accept', reject_reason: null, degraded: true, request_id: rid }, 200);
    }
  });

  r.post('/v1/phone', async (c) => {
    const rid = c.get('rid');
    const rb = await readJson(c, MAX_BODY);
    if ('error' in rb) return jsonError(c, rb.error, rb.error === 413 ? 'payload_too_large' : 'body_invalid_json');
    const body = rb.body;
    try {
      const site = siteOf(body, c);
      const form = formOf(body);
      const eff = effective(svc.runtime.get(), site, form);
      const checkOn = eff.enabled && eff.fields.phone;
      const phone = typeof body.phone === 'string' ? body.phone : '';
      const country = typeof body.country === 'string' && body.country.length === 2 ? body.country : eff.country;
      const res = checkPhone(phone, country, eff.phone_deny_prefixes);
      svc.counters.field_checks++;
      const bot = { honeypot: 'absent' as const, token: 'missing' as const, elapsed_ms: null, rate_limited: false, flags: [] };
      const d = phone && checkOn ? decide({ mode: 'field', email: null, phone: res, bot, strict: eff.strict }) : null;
      const reject_reason = d && d.reject_reason && d.reject_reason.startsWith('phone') ? d.reject_reason : null;
      const decision_hint = reject_reason ? 'reject' as const : checkOn && res.flags.length ? 'accept_flagged' as const : 'accept' as const;
      log.info('phone', { rid, site, form, valid: res.valid, type: res.type ?? null, country: res.country ?? null, flags: res.flags, reject: reject_reason });
      svc.events?.emit({
        ts: new Date().toISOString(), rid, site, form, mode: 'field', decision: decision_hint, reason: reject_reason,
        score: d?.score ?? 0, flags: d?.flags ?? [], email_domain_class: null, email_tld: null, email_verdict: null,
        phone_type: res.type ?? null, phone_country: res.country ?? null, token: 'missing', blocked: false,
        geo_country: clientCountry(c),
      });
      return c.json({ ...res, reject_reason, decision_hint, request_id: rid }, 200);
    } catch (e) {
      log.error('phone.failopen', { rid, err: errMsg(e) });
      return c.json({ valid: false, flags: [], degraded: true, request_id: rid }, 200);
    }
  });

  return r;
}
