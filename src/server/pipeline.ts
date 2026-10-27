// The validation pipeline shared by /v1/validate|email|phone and the Webflow webhook.
// Order: Stage 0 (honeypot, token, submission limits, signals) → Stage 1 email ∥ phone → optional Stage 2 → decide().
import { randomUUID } from 'node:crypto';
import { effective } from '../core/effective.js';
import { checkFast, type MxResolver } from '../core/email.js';
import type { EmailFastResult } from '../core/types.js';
import { checkPhone } from '../core/phone.js';
import { decide } from '../core/score.js';
import { checkSpam, localHour, normName } from '../core/spam.js';
import { verifyToken } from '../core/token.js';
import type { BotFlag, BotResult, EmailCheckResult, RiskFlag, ValidateMode, ValidateResult } from '../core/types.js';
import type { DeepProvider } from '../providers/types.js';
import { DAY, HOUR, TtlLru } from './cache.js';
import type { Config } from './config.js';
import type { EventSink, LeadEvent } from './events.js';
import { emailHash, phoneHash, sha256Hex } from './hash.js';
import { log } from './log.js';
import type { DeepQueue } from './queue.js';
import { checkRateLimit } from './rate-limit.js';
import type { RuntimeProvider } from './remote-config.js';

/** Counters shown on /health (no PII, process-local). */
export interface Counters { field_checks: number }

export interface Services {
  cfg: Config;
  resolveMx: MxResolver;
  emailCache: TtlLru<string, EmailFastResult & { deep?: EmailCheckResult }>;
  phoneDup: TtlLru<string, number>;
  /** earlier submissions per e-mail / full name (hashed keys) — the spam layer's repeat rule */
  repeats: TtlLru<string, RepeatEntry[]>;
  provider: DeepProvider;
  queue: DeepQueue | null;
  /** effective config (remote config with env fallback) */
  runtime: RuntimeProvider;
  /** decision events → event sink (null = disabled) */
  events: EventSink | null;
  counters: Counters;
}

export interface ValidateInput {
  email?: unknown; phone?: unknown; phone_raw?: unknown; country?: unknown; token?: unknown;
  honeypot?: unknown; honeypot_name?: unknown; mode?: unknown; deep?: unknown; budget_ms?: unknown;
  signals?: unknown; context?: unknown;
}

export interface ValidateCtx {
  site: string;
  form?: string | null; // Webflow data-name / context.form — selects the per-form rule
  ipHash: string | null; // null = webhook (no client IP)
  /** ISO-3166-1 alpha-2 of the client IP (CF-IPCountry at the edge); null = unknown → no geo rule */
  geoCountry?: string | null;
  /** User-Agent of the submitting browser — device blocklist only, never stored */
  userAgent?: string | null;
  allowDeep: boolean; // API-key callers may request a synchronous deep check
  refNow?: number; // webhook: submittedAt for token elapsed computation
  requestId?: string;
  mode?: ValidateMode; // override (webhook)
  leadRef?: string | null; // lead id for the deep queue (webhook after forward)
  skipQueue?: boolean; // webhook enqueues itself after forwarding the lead (needs lead_id)
  extraFlags?: RiskFlag[];
  /** raw client IP for the IP blocklist (embed path only) — never logged, never stored */
  ip?: string | null;
  /** webhook only: the submission carries neither the embed token nor its signals */
  embedMissing?: boolean;
  /**
   * Identity of this submission for the repeat counter, so one form submit seen twice (embed
   * submit check + Webflow webhook share the token) counts once. Default: the token, else the rid.
   */
  submissionId?: string | null;
}

export interface RepeatEntry { id: string; t: number }

/** how long a contact is remembered at all — the configured window (repeat_window_h) is capped at 720 h */
const REPEAT_KEEP = 30 * DAY;

/**
 * Record this submission under every key and return the highest number of *earlier* submissions
 * (other ids) inside the window. Process-local like the rate limits: a restart forgets.
 */
export function countRepeat(store: TtlLru<string, RepeatEntry[]>, keys: string[], id: string, now: number, windowMs: number): number {
  let max = 0;
  for (const k of keys) {
    const list = (store.get(k, now) ?? []).filter((e) => now - e.t < REPEAT_KEEP);
    const prior = list.filter((e) => e.id !== id && now - e.t < windowMs).length;
    if (!list.some((e) => e.id === id)) list.push({ id, t: now });
    store.set(k, list.slice(-50), REPEAT_KEEP, now);
    if (prior > max) max = prior;
  }
  return max;
}

export const EMAIL_TTL: Record<EmailCheckResult['verdict'], number> = { valid: 30 * DAY, undeliverable: 90 * DAY, unknown: 7 * DAY, catch_all: 7 * DAY };

function str(v: unknown, max = 320): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function modeOf(v: unknown, override?: ValidateMode): ValidateMode {
  if (override) return override;
  return v === 'submit' ? 'submit' : 'field';
}

export function mergeDeep(fast: EmailFastResult, deep: EmailCheckResult): EmailFastResult & { deep: EmailCheckResult } {
  const flags = new Set([...fast.flags, ...deep.flags]);
  const verdict = deep.verdict === 'unknown' ? fast.verdict : deep.verdict;
  // Stage-1 hard facts win over provider noise (syntax/no_mx already decided)
  return { ...fast, verdict, flags: [...flags], provider: fast.provider, latency_ms: fast.latency_ms + deep.latency_ms,
    suggestion: fast.suggestion ?? deep.suggestion, deep, ...(deep.raw !== undefined ? { raw: deep.raw } : {}) };
}

export async function runValidate(svc: Services, input: ValidateInput, ctx: ValidateCtx): Promise<ValidateResult & { _email: EmailFastResult | null }> {
  const { cfg } = svc;
  const start = Date.now();
  const now = ctx.refNow ?? start;
  const mode = modeOf(input.mode, ctx.mode);
  const rid = ctx.requestId ?? randomUUID();
  const context = (input.context && typeof input.context === 'object') ? input.context as Record<string, unknown> : {};
  const signals = (input.signals && typeof input.signals === 'object') ? input.signals as Record<string, unknown> : null;
  const form = ctx.form ?? null;
  const eff = effective(svc.runtime.get(), ctx.site, form);
  if (mode === 'field') svc.counters.field_checks++;

  // form/site excluded from validation → accept, no checks at all
  if (!eff.enabled) {
    const bot: BotResult = { honeypot: 'absent', token: 'missing', elapsed_ms: null, rate_limited: false, flags: [] };
    const out: ValidateResult & { _email: EmailFastResult | null } = {
      decision: 'accept', reject_reason: null, score: 0, flags: [], suspicious: false, review: false,
      email: null, phone: null, bot, degraded: false, request_id: rid, latency_ms: Date.now() - start, _email: null,
    };
    log.info('validate', { rid, mode, site: ctx.site, form, decision: 'accept', skipped: 'disabled' });
    emitEvent(svc, { rid, now: start, site: ctx.site, form, mode, res: out, tokenState: 'missing', email: null, blocked: false });
    return out;
  }

  // ── Stage 0 ────────────────────────────────────────────────────────────────
  const botFlags: BotFlag[] = [];
  let honeypot: BotResult['honeypot'] = 'absent';
  if (typeof input.honeypot === 'string') {
    honeypot = input.honeypot.trim() ? 'filled' : 'empty';
    if (honeypot === 'filled') {
      const company = str(context.company);
      if (company && company.toLowerCase() === input.honeypot.trim().toLowerCase()) botFlags.push('honeypot_autofill_suspect');
    }
  }
  const tok = verifyToken(str(input.token, 160), { current: cfg.tokenSecret, previous: cfg.tokenSecretPrev }, { site: ctx.site, now });
  if (signals) {
    if (signals.wd === true) botFlags.push('webdriver');
    if (signals.i === false) botFlags.push('no_interaction');
  }

  // ── Stage 1: email ─────────────────────────────────────────────────────────
  const rawEmail = eff.fields.email ? str(input.email) : null;
  const budget = Math.min(5000, Math.max(100, typeof input.budget_ms === 'number' ? input.budget_ms : 1500));
  let email: EmailFastResult | null = null;
  let cached = false;
  if (rawEmail) {
    // cache is keyed by the normalized address; normalize via checkFast's own normalizer by a cheap pre-pass
    const probe = await checkFast(rawEmail, { resolveMx: async () => ({ status: 'error', hosts: [] }), budgetMs: 1 });
    const key = probe.normalized ? emailHash(probe.normalized) : null;
    const hit = key ? svc.emailCache.get(key) : undefined;
    if (hit) { email = { ...hit, cached: true }; cached = true; }
    else {
      email = await checkFast(rawEmail, { resolveMx: svc.resolveMx, budgetMs: budget });
      if (key && email.mx !== 'error' && email.domain_class !== null) svc.emailCache.set(key, email, EMAIL_TTL[email.verdict]);
    }
    // Stage 2 (synchronous, API-key callers only)
    if (input.deep === true && ctx.allowDeep && svc.provider.name !== 'none' && email.normalized && !email.flags.includes('syntax_invalid') && !email.hard_no_mx && email.domain_class !== 'disposable') {
      if (!('deep' in email) || !(email as { deep?: EmailCheckResult }).deep) {
        const deep = await svc.provider.checkDeep(email.normalized);
        email = mergeDeep(email, deep);
        if (key && deep.verdict !== 'unknown') svc.emailCache.set(key, email, EMAIL_TTL[email.verdict]);
      }
    }
  }

  // ── Stage 1: phone ─────────────────────────────────────────────────────────
  const rawPhone = eff.fields.phone ? str(input.phone, 64) : null;
  const phone = rawPhone ? checkPhone(rawPhone, str(input.country, 2) ?? eff.country, eff.phone_deny_prefixes) : null;
  const extra: RiskFlag[] = [...(ctx.extraFlags ?? [])];
  const phoneRaw = str(input.phone_raw, 64);
  if (phoneRaw && /^\+\d{8,15}$/.test(phoneRaw)) extra.push('typed_e164');

  // ── submission counters (submit / webhook only) ────────────────────────────
  let rateLimited = false;
  if (mode !== 'field') {
    if (ctx.ipHash) {
      const a = checkRateLimit(`sub10m:${ctx.ipHash}`, cfg.rlSubmitIp10m, 10 * 60_000, start);
      const b = checkRateLimit(`sub24h:${ctx.ipHash}`, cfg.rlSubmitIp24h, DAY, start);
      if (!a.ok || !b.ok) rateLimited = true;
      if (email?.domain_class === 'freemail' && email.domain) {
        const c = checkRateLimit(`fm1h:${ctx.ipHash}:${email.domain}`, cfg.rlSubmitFreemail1h, HOUR, start);
        if (!c.ok) rateLimited = true;
      }
    } else if (email?.normalized) {
      const c = checkRateLimit(`wh1h:${emailHash(email.normalized)}`, cfg.rlWebhookEmail1h, HOUR, start);
      if (!c.ok) rateLimited = true;
    }
    if (phone?.valid && phone.e164) {
      const k = phoneHash(phone.e164);
      if (svc.phoneDup.get(k, start)) botFlags.push('phone_dup_24h');
      else svc.phoneDup.set(k, start, DAY, start);
    }
  }

  // ── repeat counter (submit / webhook only — a field check is not a submission) ──
  let repeatCount: number | null = null;
  if (mode !== 'field') {
    const keys: string[] = [];
    if (email?.normalized) keys.push('e:' + emailHash(email.normalized));
    // full names only: a lone first name ("Alfred") is shared by too many real people
    const nm = normName(context.name);
    if (nm && nm.includes(' ')) keys.push('n:' + sha256Hex(nm));
    if (keys.length > 0) {
      const id = ctx.submissionId ?? str(input.token, 160) ?? rid;
      repeatCount = countRepeat(svc.repeats, keys, id, start, eff.spam.repeat_window_h * HOUR);
    }
  }

  // ── spam layer (geo, browser fingerprint, night window, text/contact blocklist, repeats) ──
  const spam = checkSpam({
    country: ctx.geoCountry ?? null,
    tz: signals ? str(signals.tz, 60) : null,
    lang: signals ? str(signals.lg, 20) : null,
    hour: mode === 'field' ? null : localHour(now), // field checks fire while typing — no night verdict
    phoneCountry: phone?.country ?? null,
    freemail: email?.domain_class === 'freemail',
    ua: ctx.userAgent ?? null,
    texts: [str(context.company, 200), str(context.name, 200), str(context.message, 1000)],
    email: email?.normalized ?? null,
    name: str(context.name, 200),
    repeatCount,
    embedMissing: mode === 'webhook' && ctx.embedMissing === true,
    ip: ctx.ip ?? null,
  }, eff.spam);
  extra.push(...spam.flags);

  const bot: BotResult = { honeypot, token: tok.state, elapsed_ms: tok.elapsed_ms, rate_limited: rateLimited, flags: botFlags };
  const d = decide({
    mode, email, phone, bot, rateLimitHard: eff.rate_limit_hard, strict: eff.strict, extraFlags: extra,
    // a policy block only ever applies to a real submission, never to a keystroke-level field check
    spamReject: mode === 'field' ? null : spam.reject,
    blockThreshold: mode === 'field' ? null : eff.spam.block_threshold,
  });

  // ── Stage 2 async (queue) ──────────────────────────────────────────────────
  if (mode !== 'field' && !ctx.skipQueue && svc.queue && email?.normalized && d.decision !== 'reject' && !cached && !(email as { deep?: unknown }).deep
    && email.domain_class !== 'disposable' && !email.hard_no_mx) {
    svc.queue.enqueue({ email: email.normalized, hash: emailHash(email.normalized), lead_id: ctx.leadRef ?? null, site: ctx.site });
  }

  const emailOut = email ? {
    verdict: email.verdict, flags: email.flags, ...(email.suggestion ? { suggestion: email.suggestion } : {}),
    provider: (email as { deep?: EmailCheckResult }).deep?.provider ?? email.provider, latency_ms: email.latency_ms,
    normalized: email.normalized, cached: email.cached, mx: email.mx, ...(cfg.debug && email.raw !== undefined ? { raw: email.raw } : {}),
  } : null;

  const result: ValidateResult & { _email: EmailFastResult | null } = {
    decision: d.decision, reject_reason: d.reject_reason, score: d.score, flags: d.flags, suspicious: d.suspicious, review: d.review,
    email: emailOut, phone, bot, degraded: false, request_id: rid, latency_ms: Date.now() - start, _email: email,
  };
  // the embed only blocks in enforce mode at submit time — that is what the event sink counts as "blocked"
  const blocked = mode === 'submit' && d.decision === 'reject' && eff.mode === 'enforce';
  log.info('validate', {
    rid, mode, site: ctx.site, form, ip_h: ctx.ipHash?.slice(0, 8) ?? null, email_h: email?.normalized ? emailHash(email.normalized).slice(0, 12) : null,
    domain_class: email?.domain_class ?? null, tld: email?.domain?.split('.').pop() ?? null, mx: email?.mx ?? null,
    decision: d.decision, reason: d.reject_reason, score: d.score, flags: d.flags, phone_valid: phone?.valid ?? null, phone_type: phone?.type ?? null,
    token: tok.state, lat_ms: result.latency_ms, cache: cached, blocked, geo: spam.country,
  });
  emitEvent(svc, { rid, now: start, site: ctx.site, form, mode, res: result, tokenState: tok.state, email, blocked, geoCountry: spam.country });
  return result;
}

/** Fail-open response used by onError and the routes when something unexpected throws. */
export function degradedResult(rid: string, start: number, hasEmail: boolean, hasPhone: boolean): ValidateResult {
  return {
    decision: 'accept', reject_reason: null, score: 0, flags: [], suspicious: false, review: false,
    email: hasEmail ? { verdict: 'unknown', flags: [], provider: 'native', latency_ms: 0 } : null,
    phone: hasPhone ? { valid: false, flags: [] } : null,
    bot: { honeypot: 'absent', token: 'missing', elapsed_ms: null, rate_limited: false, flags: [] },
    degraded: true, request_id: rid, latency_ms: Date.now() - start,
  };
}

interface EmitArgs {
  rid: string; now: number; site: string; form: string | null; mode: ValidateMode;
  res: ValidateResult; tokenState: BotResult['token']; email: EmailFastResult | null; blocked: boolean;
  geoCountry?: string | null;
}

/** PII-free event for the statistics (domain class/TLD only — never the address itself). */
export function emitEvent(svc: Services, a: EmitArgs): void {
  if (!svc.events) return;
  const e: LeadEvent = {
    ts: new Date(a.now).toISOString(), rid: a.rid, site: a.site, form: a.form, mode: a.mode,
    decision: a.res.decision, reason: a.res.reject_reason, score: a.res.score, flags: a.res.flags,
    email_domain_class: a.email?.domain_class ?? null,
    email_tld: a.email?.domain ? a.email.domain.split('.').pop() ?? null : null,
    email_verdict: a.res.email?.verdict ?? null,
    phone_type: a.res.phone?.type ?? null, phone_country: a.res.phone?.country ?? null,
    token: a.tokenState, blocked: a.blocked, geo_country: a.geoCountry ?? null,
  };
  svc.events.emit(e);
}
