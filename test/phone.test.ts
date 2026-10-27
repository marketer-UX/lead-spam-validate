import { describe, expect, it } from 'vitest';
import { checkPhone, normalizePhoneInput, repeatedDigits, sequentialRun } from '../src/core/phone.js';

describe('phone', () => {
  const E164 = '+4921112345678';
  it.each(['+49 (0)211 12345678', '0049 211 12345678', '0211/12345678', '021112345678', '+49 211 12345678', '0211 - 123 456 78'])(
    'all spellings → same E.164: %s', (input) => {
      const r = checkPhone(input);
      expect(r.valid).toBe(true);
      expect(r.e164).toBe(E164);
      expect(r.type).toBe('fixed_line');
      expect(r.flags).toContain('fixed_line');
      expect(r.country).toBe('DE');
      expect(r.national).toBe('0211 12345678');
    },
  );
  it('0171 2345678 → mobile (proves /max metadata — default bundle would return undefined type)', () => {
    const r = checkPhone('0171 2345678');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('mobile');
    expect(r.e164).toBe('+491712345678');
  });
  it('+41 44 1234567 → valid, foreign', () => {
    const r = checkPhone('+41 44 1234567');
    expect(r.valid).toBe(true);
    expect(r.country).toBe('CH');
    expect(r.flags).not.toContain('foreign'); // CH is DACH
  });
  it('+33 1 23456789 → foreign', () => {
    const r = checkPhone('+33 1 23456789');
    expect(r.valid).toBe(true);
    expect(r.flags).toContain('foreign');
  });
  it('+49 111 111 1111 → repeated_digits', () => {
    const r = checkPhone('+49 111 111 1111');
    expect(r.flags).toContain('repeated_digits');
  });
  it('0900 1234567 → premium_rate (hard reject by policy)', () => {
    const r = checkPhone('0900 1234567');
    expect(r.valid).toBe(true);
    expect(r.type).toBe('premium_rate');
    expect(r.flags).toContain('premium_rate');
  });
  it('12345 → invalid, no crash', () => {
    const r = checkPhone('12345');
    expect(r.valid).toBe(false);
    expect(r.flags).toContain('invalid');
  });
  it('empty → no check, no flag', () => {
    expect(checkPhone('')).toEqual({ valid: false, flags: [] });
    expect(checkPhone('   ')).toEqual({ valid: false, flags: [] });
  });
  it('Italy keeps trunk zero (+39 02 …)', () => {
    const r = checkPhone('+39 02 1234 5678');
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+390212345678');
  });
  it('0800 → toll_free, 0180 shared-cost → other (libphonenumber classifies DE 032 as FIXED_LINE, so voip is rare for DE)', () => {
    expect(checkPhone('0800 1234567').type).toBe('toll_free');
    expect(checkPhone('0180 5123456').type).toBe('other');
    expect(checkPhone('032 221234567').type).toBe('fixed_line');
  });
  it('helpers', () => {
    expect(normalizePhoneInput('0049 (0)211/12-34')).toBe('+49021112-34'.replace('-', ''));
    expect(repeatedDigits('1111111')).toBe(true);
    expect(repeatedDigits('21112345678')).toBe(false);
  });
  it('runs fast (< 5 ms per check warm)', () => {
    checkPhone('0211 12345678');
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) checkPhone('0211 1234567' + (i % 10));
    const per = (performance.now() - t0) / 200;
    expect(per).toBeLessThan(5);
  });
});

describe('DACH fallback + bot patterns', () => {
  it.each([
    ['0316 873 0', 'AT', '+433168730'], ['01 5129999', 'AT', '+4315129999'], ['0660 8765432', 'AT', '+436608765432'], ['0664 1934567', 'DE', '+496641934567'],
    ['044 668 18 00', 'DE', '+49446681800'], ['031 312 45 67', 'AT', '+43313124567'], ['079 918 45 67', 'CH', '+41799184567'],
  ])('national format without country code: %s → valid (%s)', (input, country, e164) => {
    const r = checkPhone(input);
    expect(r.valid).toBe(true);
    expect(r.country).toBe(country);
    expect(r.e164).toBe(e164);
    expect(r.flags).not.toContain('foreign');
    expect(r.flags.filter((f) => ['repeated_digits', 'sequential_digits', 'no_trunk_prefix'].includes(f))).toEqual([]);
  });
  it.each(['0211 4870519', '0211/4870519-0', '0911 41872-123', '030 41872', '0341 48705196901', '+43 512 418725-12', '+41 44 668 18 00', '0049 211 4870519', '0660 8765432'])(
    'real DACH formats stay clean: %s', (input) => {
      const r = checkPhone(input);
      expect(r.valid).toBe(true);
      expect(r.flags.filter((f) => ['repeated_digits', 'sequential_digits', 'no_trunk_prefix', 'invalid'].includes(f))).toEqual([]);
    },
  );
  it('a known bot sample (9677306983, structurally valid DE) → no_trunk_prefix', () => {
    const r = checkPhone('9677306983');
    expect(r.flags).toContain('no_trunk_prefix');
  });
  it.each([['1234567890', 'sequential_digits'], ['0123456789', 'sequential_digits'], ['0171 1111111', 'repeated_digits'], ['5555555', 'repeated_digits'], ['2345678901', 'no_trunk_prefix'], ['123456789', 'no_trunk_prefix']])(
    'bot pattern %s → %s', (input, flag) => { expect(checkPhone(input).flags).toContain(flag); },
  );
  it('too short / garbage → invalid', () => {
    for (const x of ['12345', '0', 'abc', '+49 123', '123456789']) expect(checkPhone(x).valid).toBe(false);
  });
  it('sequentialRun', () => {
    expect(sequentialRun('1234567890')).toBe(9); // 1..9 ascending, the 0 breaks the run
    expect(sequentialRun('2114870519')).toBeLessThan(4);
    expect(sequentialRun('9876543')).toBe(7);
    expect(checkPhone('0211 4870519').flags).not.toContain('sequential_digits');
    expect(checkPhone('0171 2345678').flags).not.toContain('sequential_digits'); // a run of 8 is still allowed
    expect(checkPhone('123456789').flags).toContain('sequential_digits'); // a run of 9 = bot
  });
});
