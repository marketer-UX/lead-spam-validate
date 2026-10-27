import { describe, expect, it } from 'vitest';
import { mintToken, parseToken, verifyToken } from '../src/core/token.js';

const secrets = { current: 'current-secret-0123456789', previous: 'old-secret' };

describe('time-to-submit token', () => {
  it('mint → parse → verify ok after 2.5 s', () => {
    const t0 = 1_800_000_000_000;
    const t = mintToken('demo', secrets, t0);
    expect(parseToken(t)?.site).toBe('demo');
    expect(verifyToken(t, secrets, { site: 'demo', now: t0 + 5000 })).toMatchObject({ state: 'ok', elapsed_ms: 5000 });
  });
  it('too fast / expired / invalid / missing', () => {
    const t0 = 1_800_000_000_000;
    const t = mintToken('demo', secrets, t0);
    expect(verifyToken(t, secrets, { now: t0 + 800 }).state).toBe('too_fast');
    expect(verifyToken(t, secrets, { now: t0 + 7 * 3600 * 1000 }).state).toBe('expired');
    expect(verifyToken(t + 'x', secrets, { now: t0 + 5000 }).state).toBe('invalid');
    expect(verifyToken(t.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAA'), secrets, { now: t0 + 5000 }).state).toBe('invalid');
    expect(verifyToken('', secrets).state).toBe('missing');
    expect(verifyToken(undefined, secrets).state).toBe('missing');
  });
  it('site binding', () => {
    const t0 = 1_800_000_000_000;
    const t = mintToken('demo', secrets, t0);
    expect(verifyToken(t, secrets, { site: 'other', now: t0 + 5000 }).state).toBe('invalid');
  });
  it('rotation: previous secret still verifies', () => {
    const t0 = 1_800_000_000_000;
    const t = mintToken('demo', { current: 'old-secret' }, t0);
    expect(verifyToken(t, secrets, { now: t0 + 5000 }).state).toBe('ok');
    expect(verifyToken(t, { current: 'brand-new' }, { now: t0 + 5000 }).state).toBe('invalid');
  });
});
