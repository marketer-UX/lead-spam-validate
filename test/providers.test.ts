import { describe, expect, it } from 'vitest';
import { makeAfterShipProvider, mapAfterShip } from '../src/providers/aftership.js';
import { mapReacher } from '../src/providers/reacher.js';
import { setLogLevel } from '../src/server/log.js';

setLogLevel('error');

describe('AfterShip mapping', () => {
  it('catch_all is evaluated BEFORE deliverable', () => {
    const r = mapAfterShip({ syntax: { valid: true }, has_mx_records: true, smtp: { host_exists: true, catch_all: true, deliverable: true } }, 5);
    expect(r.verdict).toBe('catch_all');
    expect(r.flags).toContain('catch_all');
  });
  it('deliverable → valid; not deliverable → undeliverable; smtp nil → unknown', () => {
    expect(mapAfterShip({ syntax: { valid: true }, has_mx_records: true, smtp: { deliverable: true } }, 1).verdict).toBe('valid');
    expect(mapAfterShip({ syntax: { valid: true }, has_mx_records: true, smtp: { deliverable: false } }, 1)).toMatchObject({ verdict: 'undeliverable', flags: ['undeliverable'] });
    expect(mapAfterShip({ syntax: { valid: true }, has_mx_records: true, smtp: null }, 1).verdict).toBe('unknown');
  });
  it('disposable short-circuit: flag disposable, not no_mx', () => {
    const r = mapAfterShip({ syntax: { valid: true }, has_mx_records: false, disposable: true, smtp: null }, 1);
    expect(r.flags).toEqual(['disposable']);
    expect(r.verdict).toBe('unknown');
  });
  it('flags: full_inbox, disabled, role, free, suggestion', () => {
    const r = mapAfterShip({ syntax: { valid: true }, has_mx_records: true, smtp: { deliverable: true, full_inbox: true, disabled: true }, role_account: true, free: true, suggestion: 'x@gmail.com' }, 1);
    expect(r.flags).toEqual(expect.arrayContaining(['full_inbox', 'disabled', 'role_account', 'freemail', 'typo_suspected']));
    expect(r.suggestion).toBe('x@gmail.com');
  });
  it('provider fail-open: bad status / network error / Go fail-open shape → unknown, never throws', async () => {
    const mk = (f: typeof fetch) => makeAfterShipProvider({ url: 'http://deep.test', apiKey: 'k', fetchImpl: f });
    const r1 = await mk((async () => new Response('x', { status: 502 })) as typeof fetch).checkDeep('a@b.de');
    expect(r1.verdict).toBe('unknown');
    const r2 = await mk((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch).checkDeep('a@b.de');
    expect(r2.verdict).toBe('unknown');
    const r3 = await mk((async () => new Response(JSON.stringify({ verdict: 'unknown', flags: [], provider: 'aftership', error: 'timeout' }), { status: 200 })) as typeof fetch).checkDeep('a@b.de');
    expect(r3.verdict).toBe('unknown');
    const r4 = await mk((async () => new Response(JSON.stringify({ result: { syntax: { valid: true }, has_mx_records: true, smtp: { deliverable: true } } }), { status: 200 })) as typeof fetch).checkDeep('a@b.de');
    expect(r4.verdict).toBe('valid');
    const h = await mk((async () => new Response(JSON.stringify({ ok: true, smtp25: false }), { status: 200 })) as typeof fetch).health();
    expect(h).toBe(false);
  });
});

describe('Reacher mapping', () => {
  it('safe → valid; risky+catch_all → catch_all; risky+full_inbox → valid+full_inbox; invalid → undeliverable; unknown', () => {
    expect(mapReacher({ is_reachable: 'safe', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true } }, 1).verdict).toBe('valid');
    expect(mapReacher({ is_reachable: 'risky', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true }, smtp: { is_catch_all: true, is_deliverable: true } }, 1)).toMatchObject({ verdict: 'catch_all', flags: ['catch_all'] });
    expect(mapReacher({ is_reachable: 'risky', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true }, smtp: { has_full_inbox: true } }, 1)).toMatchObject({ verdict: 'valid', flags: ['full_inbox'] });
    expect(mapReacher({ is_reachable: 'invalid', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true }, smtp: { is_deliverable: false } }, 1).verdict).toBe('undeliverable');
    expect(mapReacher({ is_reachable: 'unknown', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true } }, 1).verdict).toBe('unknown');
    expect(mapReacher({ is_reachable: 'safe', misc: { is_disposable: true, is_role_account: true } }, 1).flags).toEqual(expect.arrayContaining(['disposable', 'role_account']));
  });
});
