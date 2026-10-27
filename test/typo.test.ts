import { describe, expect, it } from 'vitest';
import { levenshtein, suggestDomain, suggestEmail } from '../src/core/typo.js';

describe('typo suggestion', () => {
  it('levenshtein/OSA', () => {
    expect(levenshtein('gmial.com', 'gmail.com')).toBe(1); // transposition = 1
    expect(levenshtein('gmail.con', 'gmail.com')).toBe(1);
    expect(levenshtein('web.de', 'web.de')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
  });
  it('k.mueller@gmial.com → gmail.com (distance 1, regardless of MX)', () => {
    expect(suggestEmail('k.mueller', 'gmial.com', { mx: 'mx' })).toBe('k.mueller@gmail.com');
  });
  it.each([['gmail.con', 'gmail.com'], ['gmx.dee', 'gmx.de'], ['wep.de', 'web.de'], ['t-onlin.de', 't-online.de'], ['outlok.de', 'outlook.de'], ['hotmial.de', 'hotmail.de']])(
    '%s → %s', (typed, expected) => { expect(suggestDomain(typed, { mx: 'nxdomain' })).toBe(expected); },
  );
  it('known-good domains never get a suggestion', () => {
    for (const d of ['gmx.at', 'gmx.ch', 'gmail.de', 'mail.de', 'live.de', 'posteo.net', 'web.de']) expect(suggestDomain(d, { mx: 'mx' })).toBeNull();
  });
  it('distance 2 only when no MX and length ≥ 8', () => {
    expect(suggestDomain('gmaol.cmo', { mx: 'mx' })).toBeNull(); // has MX → keep
    expect(suggestDomain('gmaol.cmo', { mx: 'nxdomain' })).toBe('gmail.com');
    expect(suggestDomain('bmw.de', { mx: 'mx' })).toBeNull(); // corporate, far away
  });
  it('corporate domains with MX are left alone', () => {
    expect(suggestDomain('example.com', { mx: 'mx' })).toBeNull();
    expect(suggestDomain('beispiel-gmbh.de', { mx: 'mx' })).toBeNull();
  });
});
