// Calendly `invitee.created` webhook → same validation as a form submission → cancel junk bookings.
// Booking pages are public links: bots fill them without ever touching a Webflow form, and a
// burst of fake bookings can block every free slot within minutes.
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { effective } from '../../core/effective.js';
import { isJunkReject } from '../../core/score.js';
import { normalizeSite } from '../../core/token.js';
import { HOUR, type TtlLru } from '../cache.js';
import type { Config } from '../config.js';
import { errMsg, log } from '../log.js';
import { safeEqual } from '../mw.js';
import { runValidate, type Services } from '../pipeline.js';

const MAX_BODY = 256 * 1024;
const EVENT_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+$/;
const PHONE_Q = /telefon|phone|handy|mobil|rufnummer/i;
/** form key in the remote config: per-form rules for Calendly live under this name */
export const CALENDLY_FORM = 'calendly';

export interface CalendlyDeps { svc: Services; seen: TtlLru<string, number>; fetchImpl?: typeof fetch }

/** Calendly-Webhook-Signature: `t=<unix s>,v1=<hex hmac-sha256 of "t.body">` */
function verify(cfg: Config, header: string | undefined, k: string | undefined, raw: string, now: number): 'signature' | 'fallback' | null {
  if (header && cfg.calendlyWebhookSigningKey) {
    const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
    const t = parseInt(parts.t ?? '', 10);
    if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t * 1000) > 5 * 60_000) return null;
    const expected = createHmac('sha256', cfg.calendlyWebhookSigningKey).update(`${parts.t}.${raw}`).digest('hex');
    return safeEqual(expected, parts.v1) ? 'signature' : null;
  }
  if (k && cfg.webhookFallbackSecret && safeEqual(k, cfg.webhookFallbackSecret)) return 'fallback';
  return null;
}

async function cancelEvent(token: string, eventUri: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${eventUri}/cancellation`, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'lead-spam-validate (+https://validate.example.com)' },
      body: JSON.stringify({ reason: 'Automatisch storniert: Buchung als Spam erkannt.' }),
    });
    if (r.ok) return true;
    log.warn('calendly.cancel.rejected', { status: r.status });
    return false;
  } catch (e) {
    log.warn('calendly.cancel.error', { err: errMsg(e) });
    return false;
  }
}

export function calendlyHookRoutes(deps: CalendlyDeps): Hono {
  const { svc } = deps;
  const cfg = svc.cfg;
  const r = new Hono();

  r.post('/v1/hooks/calendly', async (c) => {
    const now = Date.now();
    const rid = crypto.randomUUID();
    try {
      const raw = await c.req.text();
      if (raw.length > MAX_BODY) return c.json({ ok: false, error: 'payload_too_large' }, 413);
      const how = verify(cfg, c.req.header('calendly-webhook-signature'), c.req.query('k'), raw, now);
      if (!how) { log.warn('calendly.unauthorized', { rid }); return c.json({ ok: false, error: 'unauthorized' }, 401); }

      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: 'body_invalid_json' }, 400); }
      if (body.event !== 'invitee.created') return c.json({ ok: true, ignored: body.event ?? null }, 200);
      const p = (body.payload && typeof body.payload === 'object' ? body.payload : {}) as Record<string, unknown>;
      const se = (p.scheduled_event && typeof p.scheduled_event === 'object' ? p.scheduled_event : {}) as Record<string, unknown>;
      const eventUri = typeof se.uri === 'string' ? se.uri : typeof p.event === 'string' ? p.event : null;
      const inviteeUri = typeof p.uri === 'string' ? p.uri : null;
      const dedupKey = `cal:${inviteeUri ?? rid}`;
      if (deps.seen.get(dedupKey, now)) return c.json({ ok: true, duplicate: true }, 200);
      deps.seen.set(dedupKey, now, HOUR, now);

      const qa = Array.isArray(p.questions_and_answers) ? p.questions_and_answers as { question?: unknown; answer?: unknown }[] : [];
      const phoneQa = qa.find((x) => typeof x.question === 'string' && PHONE_Q.test(x.question) && typeof x.answer === 'string');
      const phone = (phoneQa?.answer as string | undefined) ?? (typeof p.text_reminder_number === 'string' ? p.text_reminder_number : null);
      const name = typeof p.name === 'string' ? p.name
        : [p.first_name, p.last_name].filter((x) => typeof x === 'string').join(' ') || null;

      const site = normalizeSite(c.req.query('site'));
      const eff = effective(svc.runtime.get(), site, CALENDLY_FORM);
      const res = await runValidate(svc, {
        email: p.email, phone, phone_raw: phone, country: eff.country,
        context: { site, form: CALENDLY_FORM, name, message: qa.map((x) => (typeof x.answer === 'string' ? x.answer : '')).join('\n') || null },
      }, { site, form: CALENDLY_FORM, ipHash: null, allowDeep: false, requestId: rid, mode: 'webhook', skipQueue: true, submissionId: inviteeUri });

      // Cancel only junk, only where the site enforces, only a real Calendly event URI.
      let cancelled = false;
      const junk = isJunkReject(res);
      if (junk && eff.mode === 'enforce' && cfg.calendlyToken && eventUri && EVENT_URI.test(eventUri)) {
        cancelled = await cancelEvent(cfg.calendlyToken, eventUri, deps.fetchImpl ?? fetch);
      }
      log.info('calendly.checked', { rid, site, decision: res.decision, reason: res.reject_reason, score: res.score, flags: res.flags, junk, cancelled, how });
      return c.json({ ok: true, decision: res.decision, reason: res.reject_reason, cancelled }, 200);
    } catch (e) {
      log.error('calendly.degraded', { rid, err: errMsg(e) });
      return c.json({ ok: false, degraded: true }, 200); // fail-open: never make Calendly retry into a loop
    }
  });
  return r;
}
