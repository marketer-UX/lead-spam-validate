// Combined decision: hard rejects (policy) + additive risk score (bot signals). German B2B defaults: flag, don't reject.
import type { SpamReject } from './spam.js';
import {
  REVIEW_THRESHOLD, SCORE, SUSPICIOUS_THRESHOLD,
  type BotResult, type Decision, type EmailCheckResult, type PhoneCheckResult, type RejectReason, type RiskFlag, type ValidateMode,
} from './types.js';

export interface DecideInput {
  mode: ValidateMode;
  email: (EmailCheckResult & { hard_no_mx?: boolean }) | null;
  phone: PhoneCheckResult | null;
  bot: BotResult;
  /** RATE_LIMIT_HARD env: submission limits reject instead of flag */
  rateLimitHard?: boolean;
  /** STRICT_CONTACT env: invalid phone, invalid email syntax and domains without mail reception (incl. A-only) reject */
  strict?: boolean;
  extraFlags?: RiskFlag[];
  /** spam layer in 'block' mode fired (src/core/spam.ts) — policy reject, outranks email/phone findings */
  spamReject?: SpamReject | null;
  /** reject as soon as the summed score reaches this value. null/undefined = off (flag only). */
  blockThreshold?: number | null;
}

export interface DecideOutput {
  decision: Decision;
  reject_reason: RejectReason | null;
  score: number;
  flags: RiskFlag[];
  suspicious: boolean;
  review: boolean;
}

const PHONE_RISK = new Set(['invalid', 'voip', 'premium_rate', 'foreign', 'phone_prefix_denied', 'repeated_digits', 'sequential_digits', 'no_trunk_prefix']);
/** bot-typical patterns that reject in strict mode even when the number is structurally valid */
const PHONE_BOT = ['repeated_digits', 'sequential_digits', 'no_trunk_prefix'] as const;

export function decide(i: DecideInput): DecideOutput {
  const flags = new Set<RiskFlag>();
  if (i.email) for (const f of i.email.flags) flags.add(f);
  if (i.phone) for (const f of i.phone.flags) if (PHONE_RISK.has(f)) flags.add(f as RiskFlag);
  for (const f of i.bot.flags) flags.add(f);
  for (const f of i.extraFlags ?? []) flags.add(f);

  // token state → flags (only evaluated at submit/webhook time; field-mode calls may legitimately lack a token)
  if (i.mode !== 'field') {
    if (i.bot.token === 'missing') flags.add('token_missing');
    if (i.bot.token === 'invalid') flags.add('token_invalid');
    if (i.bot.token === 'expired') flags.add('token_expired');
  }
  if (i.bot.token === 'too_fast' && i.mode === 'field') flags.add('token_too_fast');
  if (i.bot.rate_limited) flags.add('rate_limited');

  let reject: RejectReason | null = null;
  const honeypotAutofill = i.bot.flags.includes('honeypot_autofill_suspect');
  if (i.bot.honeypot === 'filled' && !honeypotAutofill) reject = 'honeypot';
  else if (i.bot.token === 'too_fast' && i.mode !== 'field') reject = 'too_fast';
  else if (i.rateLimitHard && i.bot.rate_limited) reject = 'rate_limited';
  else if (i.spamReject) reject = i.spamReject;
  else if (i.email?.flags.includes('syntax_invalid') && (i.strict || !i.phone?.valid)) reject = 'email_syntax';
  else if (i.email?.flags.includes('disposable')) reject = 'email_disposable';
  else if (i.email?.hard_no_mx || (i.strict && i.email?.flags.includes('no_mx'))) reject = 'email_no_mx';
  else if (i.phone?.flags.includes('premium_rate')) reject = 'phone_premium_rate';
  // denied dial prefix (`phone_deny_prefixes`): a hard phone rule, not a spam policy — it rejects
  // without strict mode and in every mode, `field` included, so the embed shows the phone message
  // while the visitor is still typing. Same reason as a structurally invalid number on purpose.
  else if (i.phone?.flags.includes('phone_prefix_denied')) reject = 'phone_invalid';
  else if (i.strict && i.phone && (!i.phone.valid || PHONE_BOT.some((f) => i.phone!.flags.includes(f)))) reject = 'phone_invalid';

  let score = 0;
  for (const f of flags) score += SCORE[f] ?? 0;
  const suspicious = score >= SUSPICIOUS_THRESHOLD;
  const review = score >= REVIEW_THRESHOLD;
  // score gate: many weak signals together (foreign timezone + night + freemail …) instead of one hard rule
  const gate = i.blockThreshold;
  if (!reject && typeof gate === 'number' && gate > 0 && score >= gate) reject = 'spam_score';
  const decision: Decision = reject ? 'reject' : flags.size > 0 ? 'accept_flagged' : 'accept';
  return { decision, reject_reason: reject, score, flags: [...flags], suspicious, review };
}

/**
 * Rejects that mean "this is junk", as opposed to "the visitor mistyped". Only these may trigger
 * an action outside the form — deleting a Webflow submission, cancelling a Calendly booking —
 * because a real person with an ad blocker (no embed) and a typo in the phone number must never
 * lose a booking over it. A denied dial prefix rejects as `phone_invalid` but is policy, hence in.
 */
const JUNK_REJECTS = new Set<RejectReason>([
  'honeypot', 'too_fast', 'rate_limited', 'email_disposable', 'phone_premium_rate',
  'geo_denied', 'client_denied', 'device_denied', 'text_denied',
  'contact_denied', 'ip_denied', 'repeat_denied', 'embed_missing', 'spam_score',
]);

export function isJunkReject(r: { decision: Decision; reject_reason: RejectReason | null; flags: RiskFlag[] }): boolean {
  if (r.decision !== 'reject' || !r.reject_reason) return false;
  if (JUNK_REJECTS.has(r.reject_reason)) return true;
  return r.reject_reason === 'phone_invalid' && r.flags.includes('phone_prefix_denied');
}
