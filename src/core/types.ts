// Shared contract — the email types (EmailFlag/EmailVerdict/EmailCheckResult/EmailVerifier),
// plus phone, bot and combined validation types used by the HTTP API and the embed.

export type EmailFlag =
  | 'syntax_invalid'
  | 'no_mx'
  | 'disposable'
  | 'role_account'
  | 'freemail'
  | 'catch_all'
  | 'undeliverable'
  | 'full_inbox'
  | 'disabled'
  | 'typo_suspected';

export type EmailVerdict = 'valid' | 'catch_all' | 'undeliverable' | 'unknown';

export type EmailProvider = 'reacher' | 'aftership' | 'native';

export interface EmailCheckResult {
  verdict: EmailVerdict;
  flags: EmailFlag[];
  suggestion?: string; // corrected address on suspected typo
  provider: EmailProvider;
  latency_ms: number;
  raw?: unknown; // original provider response, only when DEBUG=true
}

export interface EmailVerifier {
  /** Stage 1: synchronous, no SMTP, budget ~100 ms */
  checkFast(email: string): Promise<EmailCheckResult>;
  /** Stage 2: asynchronous, with SMTP */
  checkDeep(email: string): Promise<EmailCheckResult>;
}

/** MX resolution outcome (Stage 1). `a_only` = no MX but A/AAAA exists (RFC 5321 implicit MX). */
export type MxStatus = 'mx' | 'a_only' | 'none' | 'nxdomain' | 'null_mx' | 'error';

export type DomainClass = 'corporate' | 'freemail' | 'disposable';

/** Stage-1 result of the native checker (superset of EmailCheckResult). */
export interface EmailFastResult extends EmailCheckResult {
  provider: 'native';
  normalized: string | null; // lowercased, punycode domain; null if unparseable
  local: string | null;
  domain: string | null;
  domain_class: DomainClass | null;
  mx: MxStatus | null; // null when syntax failed (no lookup)
  /** true when the MX status alone justifies a hard reject (nxdomain / null_mx / none) */
  hard_no_mx: boolean;
  cached: boolean;
}

export type PhoneFlag =
  | 'invalid'
  | 'mobile'
  | 'fixed_line'
  | 'voip'
  | 'premium_rate'
  | 'toll_free'
  | 'foreign'
  | 'phone_prefix_denied'
  | 'repeated_digits'
  | 'sequential_digits'
  | 'no_trunk_prefix';

export type PhoneType = 'mobile' | 'fixed_line' | 'voip' | 'premium_rate' | 'toll_free' | 'other';

export interface PhoneCheckResult {
  valid: boolean;
  e164?: string; // +4921112345678  -> store this
  national?: string; // 0211 12345678   -> display this
  international?: string; // +49 211 12345678
  country?: string; // 'DE'
  type?: PhoneType;
  flags: PhoneFlag[];
}

export type HoneypotState = 'empty' | 'filled' | 'absent';
export type TokenState = 'ok' | 'missing' | 'invalid' | 'too_fast' | 'expired';

export type BotFlag =
  | 'token_missing'
  | 'token_invalid'
  | 'token_expired'
  | 'token_too_fast'
  | 'honeypot_autofill_suspect'
  | 'rate_limited'
  | 'webdriver'
  | 'no_interaction'
  | 'phone_dup_24h'
  | 'typed_e164'
  | 'client_mismatch'
  | 'validator_unreachable';

export interface BotResult {
  honeypot: HoneypotState;
  token: TokenState;
  elapsed_ms: number | null; // render -> submit, when token parsed
  rate_limited: boolean;
  flags: BotFlag[];
}

/** Spam layer (src/core/spam.ts): IP country, browser fingerprint, submission hour, text blocklist. */
export type SpamFlag =
  | 'geo_denied'
  | 'geo_outside'
  | 'geo_freemail'
  | 'geo_from_phone'
  | 'ua_denied'
  | 'phone_geo_mismatch'
  | 'tz_foreign'
  | 'lang_foreign'
  | 'night_submit'
  | 'text_denied'
  | 'contact_denied'
  | 'ip_denied'
  | 'repeat_contact'
  | 'embed_missing';

export type RiskFlag = EmailFlag | Exclude<PhoneFlag, 'mobile' | 'fixed_line' | 'toll_free'> | BotFlag | SpamFlag;

export type Decision = 'accept' | 'accept_flagged' | 'reject';

export type RejectReason =
  | 'honeypot'
  | 'too_fast'
  | 'rate_limited'
  | 'email_syntax'
  | 'email_disposable'
  | 'email_no_mx'
  | 'phone_invalid'
  | 'phone_premium_rate'
  | 'geo_denied'
  | 'client_denied'
  | 'device_denied'
  | 'text_denied'
  | 'contact_denied'
  | 'ip_denied'
  | 'repeat_denied'
  | 'embed_missing'
  | 'spam_score';

export type ValidateMode = 'field' | 'submit' | 'webhook';

export interface ValidateResult {
  decision: Decision;
  reject_reason: RejectReason | null;
  score: number;
  flags: RiskFlag[];
  suspicious: boolean; // score >= 50
  review: boolean; // score >= 80
  email: (EmailCheckResult & { normalized?: string | null; cached?: boolean }) | null;
  phone: PhoneCheckResult | null;
  bot: BotResult;
  degraded: boolean; // an internal error was swallowed (fail-open)
  request_id: string;
  latency_ms: number;
}

/** Score weights — single source of truth. */
export const SCORE: Record<string, number> = {
  token_missing: 30,
  token_invalid: 50,
  token_expired: 20,
  token_too_fast: 50, // browser/field mode only; submit/webhook reject instead
  honeypot_autofill_suspect: 20,
  rate_limited: 40,
  webdriver: 40,
  no_interaction: 20,
  repeated_digits: 40,
  sequential_digits: 40,
  no_trunk_prefix: 20,
  phone_dup_24h: 30,
  foreign: 10,
  // marker only: a denied dial prefix is a policy reject (`phone_invalid`), never a matter of points
  phone_prefix_denied: 0,
  voip: 10,
  typed_e164: 5,
  typo_suspected: 10,
  invalid: 10, // phone invalid (soft)
  undeliverable: 40, // Stage-2 result
  client_mismatch: 10,
  validator_unreachable: 0,
  // spam layer — tuned so two independent foreign signals reach SUSPICIOUS_THRESHOLD together
  geo_denied: 60,
  geo_outside: 40,
  geo_freemail: 60,
  geo_from_phone: 0, // marker: the country came from the phone, not from the IP — no risk on its own
  ua_denied: 40,
  phone_geo_mismatch: 40,
  tz_foreign: 30,
  lang_foreign: 20,
  night_submit: 15,
  text_denied: 40,
  contact_denied: 60,
  ip_denied: 60,
  repeat_contact: 40,
  embed_missing: 30,
  // German B2B: flag only, no score
  freemail: 0,
  role_account: 0,
  catch_all: 0,
  full_inbox: 0,
  disabled: 0,
  no_mx: 0, // a_only case (hard cases reject)
  syntax_invalid: 0, // rejects unless phone valid
  disposable: 0, // rejects
  premium_rate: 0, // rejects
};

export const SUSPICIOUS_THRESHOLD = 50;
export const REVIEW_THRESHOLD = 80;

/** Names of the hidden fields the embed injects into forms (also the webhook reads them). */
export const HIDDEN_FIELDS = {
  email_verdict: 'email_verdict',
  email_flags: 'email_flags',
  phone_e164: 'phone_e164',
  phone_type: 'phone_type',
  lead_risk_score: 'lead_risk_score',
  lead_risk_flags: 'lead_risk_flags',
  token: 'lv_vt',
  signals: 'lv_vs',
} as const;

export const DEFAULT_HONEYPOT = 'company_url_confirm';
