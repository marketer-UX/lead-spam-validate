import { describe, expect, it } from 'vitest';
import { checkFast, checkSyntax, classifyDomain, normalizeEmail, type MxLookupResult } from '../src/core/email.js';
import { addDisposableDomains, DISPOSABLE_DOMAINS, isDisposableDomain } from '../src/core/lists/disposable.js';

const mx = (status: MxLookupResult['status'], hosts: string[] = []) => async () => ({ status, hosts });
const table: Record<string, MxLookupResult['status']> = {
  'gmail.com': 'mx', 'gmial.com': 'mx', 'existierende-gmbh.de': 'mx', 'domain-ohne-mx.de': 'nxdomain', 'a-only.de': 'a_only', 'web.de': 'mx', 'nullmx.de': 'null_mx',
};
const resolveMx = async (d: string): Promise<MxLookupResult> => ({ status: table[d] ?? 'none', hosts: [] });

describe('normalize + syntax', () => {
  it('lowercases, trims, strips mailto', () => {
    expect(normalizeEmail('  MailTo:K.Mueller@Gmail.COM ')?.normalized).toBe('k.mueller@gmail.com');
  });
  it('IDN domain → punycode', () => {
    expect(normalizeEmail('info@münchen.de')?.domain).toBe('xn--mnchen-3ya.de');
  });
  it.each(['', 'foo', 'foo@', '@bar.de', 'a@b', 'a b@c.de', 'a@@b.de', 'a@b..de', '.a@b.de', 'a.@b.de', 'a@-b.de', 'a@b.d'])('invalid: %s', (s) => {
    const n = normalizeEmail(s);
    expect(n === null || !checkSyntax(n)).toBe(true);
  });
  it.each(['info@beispiel-gmbh.de', 'k.mueller+tag@gmail.com', "o'brien@example.co.uk", 'x@sub.domain.example'])('valid: %s', (s) => {
    const n = normalizeEmail(s);
    expect(n && checkSyntax(n)).toBe(true);
  });
});

describe('classification', () => {
  it('disposable list + wildcard + allowlist', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('foo.10mail.org')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isDisposableDomain('web.de')).toBe(false);
    expect(classifyDomain('gmx.de')).toBe('freemail');
    expect(classifyDomain('beispiel-gmbh.de')).toBe('corporate');
  });
});

describe('checkFast', () => {
  it('k.mueller@gmial.com → suggestion, no block', async () => {
    const r = await checkFast('k.mueller@gmial.com', { resolveMx });
    expect(r.suggestion).toBe('k.mueller@gmail.com');
    expect(r.flags).toContain('typo_suspected');
    expect(r.hard_no_mx).toBe(false);
    expect(r.verdict).toBe('unknown');
  });
  it('test@mailinator.com → disposable (hard reject by policy), no MX lookup', async () => {
    let called = 0;
    const r = await checkFast('test@mailinator.com', { resolveMx: async (d) => { called++; return resolveMx(d); } });
    expect(r.flags).toContain('disposable');
    expect(r.domain_class).toBe('disposable');
    expect(called).toBe(0);
  });
  it('info@existierende-gmbh.de → passes with role_account', async () => {
    const r = await checkFast('info@existierende-gmbh.de', { resolveMx });
    expect(r.flags).toEqual(['role_account']);
    expect(r.verdict).toBe('unknown');
    expect(r.mx).toBe('mx');
  });
  it('xyz@domain-ohne-mx.de → hard no_mx', async () => {
    const r = await checkFast('xyz@domain-ohne-mx.de', { resolveMx });
    expect(r.hard_no_mx).toBe(true);
    expect(r.verdict).toBe('undeliverable');
    expect(r.flags).toContain('no_mx');
  });
  it('A-only domain → flag no_mx but NOT hard (fail-open, RFC 5321 implicit MX)', async () => {
    const r = await checkFast('x@a-only.de', { resolveMx });
    expect(r.flags).toContain('no_mx');
    expect(r.hard_no_mx).toBe(false);
    expect(r.verdict).toBe('unknown');
  });
  it('null MX → hard', async () => {
    const r = await checkFast('x@nullmx.de', { resolveMx });
    expect(r.hard_no_mx).toBe(true);
  });
  it('DNS error/timeout → unknown, no no_mx flag (fail-open)', async () => {
    const slow = () => new Promise<MxLookupResult>((res) => setTimeout(() => res({ status: 'mx', hosts: [] }), 500));
    const r = await checkFast('x@slow.de', { resolveMx: slow, budgetMs: 20 });
    expect(r.mx).toBe('error');
    expect(r.verdict).toBe('unknown');
    expect(r.flags).not.toContain('no_mx');
    const boom = async () => { throw new Error('dns down'); };
    const r2 = await checkFast('x@boom.de', { resolveMx: boom });
    expect(r2.mx).toBe('error');
  });
  it('typo domain listed as disposable (typo-squat) → suggestion, NOT disposable reject', async () => {
    addDisposableDomains(['gmial.com', 'wep.de']);
    expect(isDisposableDomain('gmial.com')).toBe(true);
    const r = await checkFast('k.mueller@gmial.com', { resolveMx });
    expect(r.flags).not.toContain('disposable');
    expect(r.suggestion).toBe('k.mueller@gmail.com');
    expect(r.domain_class).toBe('corporate');
    const r2 = await checkFast('x@wep.de', { resolveMx });
    expect(r2.flags).not.toContain('disposable');
    expect(r2.suggestion).toBe('x@web.de');
    DISPOSABLE_DOMAINS.delete('gmial.com'); DISPOSABLE_DOMAINS.delete('wep.de');
  });
  it('freemail flagged only', async () => {
    const r = await checkFast('max@web.de', { resolveMx });
    expect(r.flags).toEqual(['freemail']);
    expect(r.domain_class).toBe('freemail');
  });
  it('syntax invalid → undeliverable + syntax_invalid', async () => {
    const r = await checkFast('not-an-email', { resolveMx });
    expect(r.verdict).toBe('undeliverable');
    expect(r.flags).toEqual(['syntax_invalid']);
    expect(r.mx).toBeNull();
  });
});
