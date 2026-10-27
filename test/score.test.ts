import { describe, expect, it } from 'vitest';
import { decide } from '../src/core/score.js';
import type { BotResult } from '../src/core/types.js';

const bot = (o: Partial<BotResult> = {}): BotResult => ({ honeypot: 'empty', token: 'ok', elapsed_ms: 5000, rate_limited: false, flags: [], ...o });
const email = (flags: any[] = [], hard = false) => ({ verdict: 'unknown' as const, flags, provider: 'native' as const, latency_ms: 1, hard_no_mx: hard });
const phone = (flags: any[] = [], valid = true) => ({ valid, flags });

describe('decide()', () => {
  it('clean lead → accept, score 0', () => {
    const r = decide({ mode: 'submit', email: email(), phone: phone(['fixed_line']), bot: bot() });
    expect(r).toMatchObject({ decision: 'accept', reject_reason: null, score: 0, flags: [] });
  });
  it('role_account + freemail → accept_flagged, score 0 (German B2B)', () => {
    const r = decide({ mode: 'submit', email: email(['role_account', 'freemail']), phone: null, bot: bot() });
    expect(r.decision).toBe('accept_flagged');
    expect(r.score).toBe(0);
  });
  it('honeypot → reject; autofill-suspect → flag only', () => {
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot({ honeypot: 'filled' }) }).reject_reason).toBe('honeypot');
    const r = decide({ mode: 'submit', email: email(), phone: null, bot: bot({ honeypot: 'filled', flags: ['honeypot_autofill_suspect'] }) });
    expect(r.decision).toBe('accept_flagged');
    expect(r.score).toBe(20);
  });
  it('too_fast rejects at submit/webhook, flags only in field mode', () => {
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot({ token: 'too_fast', elapsed_ms: 800 }) }).reject_reason).toBe('too_fast');
    expect(decide({ mode: 'webhook', email: email(), phone: null, bot: bot({ token: 'too_fast' }) }).reject_reason).toBe('too_fast');
    const f = decide({ mode: 'field', email: email(), phone: null, bot: bot({ token: 'too_fast' }) });
    expect(f.decision).toBe('accept_flagged');
    expect(f.flags).toContain('token_too_fast');
  });
  it('token missing: flag (+30) at submit, ignored in field mode', () => {
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot({ token: 'missing' }) }).score).toBe(30);
    expect(decide({ mode: 'field', email: email(), phone: null, bot: bot({ token: 'missing' }) }).score).toBe(0);
  });
  it('hard rejects by policy', () => {
    expect(decide({ mode: 'submit', email: email(['disposable']), phone: null, bot: bot() }).reject_reason).toBe('email_disposable');
    expect(decide({ mode: 'submit', email: email(['no_mx'], true), phone: null, bot: bot() }).reject_reason).toBe('email_no_mx');
    expect(decide({ mode: 'submit', email: email(['no_mx'], false), phone: null, bot: bot() }).decision).toBe('accept_flagged');
    expect(decide({ mode: 'submit', email: email(), phone: phone(['premium_rate']), bot: bot() }).reject_reason).toBe('phone_premium_rate');
  });
  it('syntax invalid: reject unless a valid phone exists', () => {
    expect(decide({ mode: 'submit', email: email(['syntax_invalid']), phone: null, bot: bot() }).reject_reason).toBe('email_syntax');
    expect(decide({ mode: 'submit', email: email(['syntax_invalid']), phone: phone(['mobile']), bot: bot() }).decision).toBe('accept_flagged');
  });
  it('score thresholds: repeated_digits + webdriver = 80 → review', () => {
    const r = decide({ mode: 'submit', email: email(), phone: phone(['repeated_digits']), bot: bot({ flags: ['webdriver'] }) });
    expect(r.score).toBe(80);
    expect(r.suspicious).toBe(true);
    expect(r.review).toBe(true);
    expect(r.decision).toBe('accept_flagged');
  });
  it('rate_limited: flag +40 by default, reject with rateLimitHard', () => {
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot({ rate_limited: true }) })).toMatchObject({ decision: 'accept_flagged', score: 40 });
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot({ rate_limited: true }), rateLimitHard: true }).reject_reason).toBe('rate_limited');
  });
  it('VOIP alone never rejects (Sipgate/Placetel customers)', () => {
    expect(decide({ mode: 'submit', email: email(), phone: phone(['voip']), bot: bot() })).toMatchObject({ decision: 'accept_flagged', score: 10 });
  });
});

describe('strict contact mode (STRICT_CONTACT)', () => {
  it('invalid phone rejects; valid phone passes', () => {
    expect(decide({ mode: 'submit', email: email(), phone: phone(['invalid'], false), bot: bot(), strict: true }).reject_reason).toBe('phone_invalid');
    expect(decide({ mode: 'submit', email: email(), phone: phone(['invalid'], false), bot: bot() }).decision).toBe('accept_flagged'); // non-strict: flag only
    expect(decide({ mode: 'submit', email: email(), phone: phone(['mobile']), bot: bot(), strict: true }).decision).toBe('accept');
  });
  it('email syntax rejects even with a valid phone; A-only domain (no_mx soft) rejects', () => {
    expect(decide({ mode: 'submit', email: email(['syntax_invalid']), phone: phone(['mobile']), bot: bot(), strict: true }).reject_reason).toBe('email_syntax');
    expect(decide({ mode: 'submit', email: email(['no_mx'], false), phone: null, bot: bot(), strict: true }).reject_reason).toBe('email_no_mx');
    expect(decide({ mode: 'submit', email: email(['no_mx'], false), phone: null, bot: bot() }).decision).toBe('accept_flagged');
  });
  it('empty phone (optional field) never rejects', () => {
    expect(decide({ mode: 'submit', email: email(), phone: null, bot: bot(), strict: true }).decision).toBe('accept');
  });
});

describe('strict: bot-pattern phones reject even when structurally valid', () => {
  it.each(['repeated_digits', 'sequential_digits', 'no_trunk_prefix'])('%s → phone_invalid (strict), flag only (non-strict)', (flag) => {
    expect(decide({ mode: 'submit', email: email(), phone: phone(['fixed_line', flag as any]), bot: bot(), strict: true }).reject_reason).toBe('phone_invalid');
    expect(decide({ mode: 'submit', email: email(), phone: phone(['fixed_line', flag as any]), bot: bot() }).decision).toBe('accept_flagged');
  });
});
