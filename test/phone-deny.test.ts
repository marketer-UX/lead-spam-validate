// Denied dial prefixes (`phone_deny_prefixes`) — example policy used throughout: nothing with
// +1, +2, +7, +8 or +9 may reach the forms. It is a PHONE rule, not a spam-layer rule: it
// rejects with the existing reason `phone_invalid` (so the embed shows the configured phone message
// unchanged), it does not need strict mode, and it fires in `field` mode as well — the visitor sees
// the message while typing, exactly like a structurally invalid number.
import { describe, expect, it } from 'vitest';
import { effective, parseRemoteConfig, type RuntimeConfig } from '../src/core/effective.js';
import { checkPhone, deniedDialPrefix } from '../src/core/phone.js';
import { decide } from '../src/core/score.js';
import { SCORE, type BotResult, type PhoneCheckResult } from '../src/core/types.js';
import { loadConfig } from '../src/server/config.js';
import { RemoteConfigLoader } from '../src/server/remote-config.js';
import { baseEnv, makeApp, ORIGIN, post, remoteConfig, remoteSite } from './helpers.js';

/** example configuration: everything outside Europe */
const DENY = ['1', '2', '7', '8', '9'];

/** a known spam sample: Nigerian mobile, formatted (accepted with score 40 without the rule) */
const NG_FORMATTED = '+234 802 765 4321';
/** a second spam sample, compact E.164 */
const NG_E164 = '+2348021234567';

const EUROPEAN = ['+49 211 1234567', '0211 1234567', '+43 1 2345678', '+41 44 668 18 00'];

describe('checkPhone with phone_deny_prefixes', () => {
  it('the two Nigerian spam samples are flagged', () => {
    for (const n of [NG_FORMATTED, NG_E164]) {
      const r = checkPhone(n, 'DE', DENY);
      expect(r.valid).toBe(true); // structurally fine — that is why only this rule catches them
      expect(r.country).toBe('NG');
      expect(r.flags).toContain('phone_prefix_denied');
    }
  });

  // Deliberate consequence of `+1`: North America is blocked too. A real US enquiry can no
  // longer use the form; with this policy that is the accepted trade-off for stopping +2xx spam.
  it('+1 415 555 0132 (North America) is flagged — accepted consequence of the `1` prefix', () => {
    const r = checkPhone('+1 415 555 0132', 'DE', DENY);
    expect(r.valid).toBe(true);
    expect(r.country).toBe('US');
    expect(r.flags).toContain('phone_prefix_denied');
  });

  it('+7 (Russia) is flagged as well', () => {
    expect(checkPhone('+7 495 1234567', 'DE', DENY).flags).toContain('phone_prefix_denied');
  });

  it.each(EUROPEAN)('European number stays untouched: %s', (input) => {
    const withRule = checkPhone(input, 'DE', DENY);
    const without = checkPhone(input, 'DE');
    expect(withRule.valid).toBe(true);
    expect(withRule.flags).not.toContain('phone_prefix_denied');
    expect(withRule).toEqual(without); // the rule changes nothing at all for +49/+43/+41
  });

  it('empty list = rule off: nothing is flagged, not even the Nigerian samples', () => {
    for (const n of [NG_FORMATTED, NG_E164, '+1 415 555 0132']) {
      expect(checkPhone(n, 'DE', []).flags).not.toContain('phone_prefix_denied');
      expect(checkPhone(n, 'DE').flags).not.toContain('phone_prefix_denied'); // default argument
    }
  });

  it('fail-open: no phone and unparseable input never fire the rule', () => {
    expect(checkPhone('', 'DE', DENY)).toEqual({ valid: false, flags: [] });
    expect(checkPhone('   ', 'DE', DENY)).toEqual({ valid: false, flags: [] });
    for (const x of ['123', 'abc', '12345']) {
      expect(checkPhone(x, 'DE', DENY).flags).not.toContain('phone_prefix_denied');
    }
  });

  it('a parseable but invalid foreign number is flagged too (the country code is known)', () => {
    const r = checkPhone('+234123', 'DE', DENY);
    expect(r.valid).toBe(false);
    expect(r.flags).toEqual(['invalid', 'phone_prefix_denied']);
  });

  it('08034 123456 parses as a German number — this rule cannot see it (the spam layer covers it)', () => {
    const r = checkPhone('08034 123456', 'DE', DENY);
    expect(r.country).toBe('DE');
    expect(r.flags).not.toContain('phone_prefix_denied');
  });

  it('deniedDialPrefix matches the calling code by prefix, tolerates a typed plus, needs a number', () => {
    expect(deniedDialPrefix('234', DENY)).toBe(true);
    expect(deniedDialPrefix('1', DENY)).toBe(true);
    expect(deniedDialPrefix('49', DENY)).toBe(false);
    expect(deniedDialPrefix('43', DENY)).toBe(false);
    expect(deniedDialPrefix('41', DENY)).toBe(false);
    expect(deniedDialPrefix('234', ['+234'])).toBe(true);
    expect(deniedDialPrefix('234', [])).toBe(false);
    expect(deniedDialPrefix(undefined, DENY)).toBe(false);
    expect(deniedDialPrefix(null, DENY)).toBe(false);
  });
});

describe('decide(): the flag rejects as phone_invalid, in every mode, without strict', () => {
  const bot = (): BotResult => ({ honeypot: 'empty', token: 'ok', elapsed_ms: 20_000, rate_limited: false, flags: [] });
  const denied = (): PhoneCheckResult => checkPhone(NG_FORMATTED, 'DE', DENY);
  const clean = (): PhoneCheckResult => checkPhone('0211 1234567', 'DE', DENY);

  it.each(['field', 'submit', 'webhook'] as const)('%s mode rejects with phone_invalid', (mode) => {
    const d = decide({ mode, email: null, phone: denied(), bot: bot(), strict: false });
    expect(d.decision).toBe('reject');
    expect(d.reject_reason).toBe('phone_invalid');
    expect(d.flags).toContain('phone_prefix_denied'); // visible in the log, the decision event and the statistics
  });

  it('a clean German number is not rejected by the rule', () => {
    expect(decide({ mode: 'submit', email: null, phone: clean(), bot: bot(), strict: false }).reject_reason).toBeNull();
  });

  it('the flag itself costs no points — the reject is a policy decision', () => {
    expect(SCORE.phone_prefix_denied).toBe(0);
  });
});

describe('phone_deny_prefixes in the cascading remote config', () => {
  function rtOf(remote: unknown, env: NodeJS.ProcessEnv = {}): RuntimeConfig {
    const cfg = loadConfig({ ...baseEnv, ...env });
    const l = new RemoteConfigLoader(cfg);
    if (!l.applyRemote(remote)) throw new Error('fixture rejected');
    return l.get();
  }

  it('inherits global → site → form, and an empty list switches the rule off again', () => {
    const rt = rtOf(remoteConfig({ phone_deny_prefixes: DENY }, [remoteSite({
      forms: { 'Nur hier erlaubt': { phone_deny_prefixes: [] }, 'Enger': { phone_deny_prefixes: ['234'] } },
    })]));
    expect(effective(rt, 'demo', 'Kontaktformular').phone_deny_prefixes).toEqual(DENY);
    expect(effective(rt, 'demo', 'Nur hier erlaubt').phone_deny_prefixes).toEqual([]);
    expect(effective(rt, 'demo', 'Enger').phone_deny_prefixes).toEqual(['234']);
  });

  it('a site list wins over global, a form list over the site', () => {
    const rt = rtOf(remoteConfig({ phone_deny_prefixes: ['9'] }, [remoteSite({
      phone_deny_prefixes: DENY, forms: { 'Quote Request': { phone_deny_prefixes: ['1'] } },
    })]));
    expect(effective(rt, 'demo', null).phone_deny_prefixes).toEqual(DENY);
    expect(effective(rt, 'demo', 'Quote Request').phone_deny_prefixes).toEqual(['1']);
    expect(effective(rt, 'unbekannt', null).phone_deny_prefixes).toEqual(['9']); // unknown slug → global
  });

  it('absent everywhere = off (env fallback included)', () => {
    expect(effective(rtOf(remoteConfig()), 'demo', 'Kontaktformular').phone_deny_prefixes).toEqual([]);
    // env source (config server never answered): the rule is off, exactly like the spam layer
    const envOnly = new RemoteConfigLoader(loadConfig({ ...baseEnv })).get();
    expect(envOnly.source).toBe('env');
    expect(effective(envOnly, 'demo', null).phone_deny_prefixes).toEqual([]);
  });

  it('duplicates are collapsed and the order is kept', () => {
    const c = parseRemoteConfig(remoteConfig({ phone_deny_prefixes: ['2', '2', '1'] }));
    expect(c!.global.phone_deny_prefixes).toEqual(['2', '1']);
  });

  it('one invalid value discards the WHOLE config (fail-safe, like every other field)', () => {
    const bad: unknown[] = [
      remoteConfig({ phone_deny_prefixes: '1,2' }), // not an array
      remoteConfig({ phone_deny_prefixes: ['+1'] }), // plus belongs to the service, not the config
      remoteConfig({ phone_deny_prefixes: ['12345'] }), // max. 4 digits
      remoteConfig({ phone_deny_prefixes: ['1a'] }),
      remoteConfig({ phone_deny_prefixes: [1] }),
      remoteConfig({ phone_deny_prefixes: Array.from({ length: 21 }, (_, i) => String(i)) }), // max. 20 entries
      remoteConfig({}, [remoteSite({ phone_deny_prefixes: ['abc'] })]),
      remoteConfig({}, [remoteSite({ forms: { 'X': { phone_deny_prefixes: ['99999'] } } })]),
    ];
    for (const b of bad) expect(parseRemoteConfig(b), JSON.stringify(b).slice(0, 110)).toBeNull();
  });
});

describe('routes: the rule blocks on the field path and on the webhook path', () => {
  const H = { origin: ORIGIN };
  /** strict OFF on purpose: the rule must reject on its own, not through strict mode */
  const config = (over: Record<string, unknown> = {}, site: Record<string, unknown> = {}) =>
    remoteConfig({ strict: false, phone_deny_prefixes: DENY, ...over }, [remoteSite(site)]);

  it('/v1/phone → reject_reason phone_invalid (that is what makes the embed show the phone message)', async () => {
    const { app } = makeApp({}, {}, config());
    const j = await (await post(app, '/v1/phone', { phone: NG_FORMATTED, site: 'demo', form: 'Quote Request' }, H)).json() as any;
    expect(j).toMatchObject({ valid: true, country: 'NG', reject_reason: 'phone_invalid', decision_hint: 'reject' });
    expect(j.flags).toContain('phone_prefix_denied');
  });

  it('/v1/phone → a German number stays clean, and with an empty list the Nigerian one does too', async () => {
    const { app } = makeApp({}, {}, config());
    const de = await (await post(app, '/v1/phone', { phone: '0211 1234567', site: 'demo' }, H)).json() as any;
    // decision_hint stays 'accept_flagged' because of the descriptive `fixed_line` flag — not a reject
    expect(de).toMatchObject({ valid: true, reject_reason: null, decision_hint: 'accept_flagged' });
    expect(de.flags).not.toContain('phone_prefix_denied');
    const { app: off } = makeApp({}, {}, config({ phone_deny_prefixes: [] }));
    const j = await (await post(off, '/v1/phone', { phone: NG_FORMATTED, site: 'demo' }, H)).json() as any;
    expect(j.reject_reason).toBeNull();
    expect(j.flags).not.toContain('phone_prefix_denied');
  });

  it('/v1/validate in field mode already rejects — the visitor sees it while typing', async () => {
    const { app } = makeApp({}, {}, config());
    const j = await (await post(app, '/v1/validate', {
      phone: NG_FORMATTED, email: 'spam.sample@gmail.com', mode: 'field', context: { site: 'demo', form: 'Quote Request' },
    }, H)).json() as any;
    expect(j).toMatchObject({ decision: 'reject', reject_reason: 'phone_invalid' });
    expect(j.flags).toContain('phone_prefix_denied');
  });

  it('/v1/hooks/webflow: a known spam submission is rejected and never reaches the lead store', async () => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(JSON.stringify({ ok: true, lead_id: 'deal_1', status: 'received' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl }, config({}, { forward: true }));
    const r = await app.request('/v1/hooks/webflow?site=demo&k=hook-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        triggerType: 'form_submission',
        payload: {
          id: 'wf_case_b', name: 'Quote Request', siteId: '0123456789abcdef01234567',
          formId: 'f1', submittedAt: '2026-10-02T06:57:00.000Z',
          // no lv_vt: the form was submitted without our token (flags freemail, foreign, token_missing)
          data: { 'Name': 'Sample', 'E-Mail': 'spam.sample@gmail.com', 'Telefonnummer': NG_FORMATTED, 'company_url_confirm': '' },
        },
      }),
    });
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, forwarded: false, decision: 'reject', reason: 'phone_invalid' });
    expect(bodies).toHaveLength(0);
  });

  it('/v1/hooks/webflow: the same form with a German number is forwarded untouched', async () => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(JSON.stringify({ ok: true, lead_id: 'deal_2', status: 'received' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl }, config({}, { forward: true }));
    const r = await app.request('/v1/hooks/webflow?site=demo&k=hook-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        triggerType: 'form_submission',
        payload: {
          id: 'wf_case_c', name: 'Quote Request', siteId: '0123456789abcdef01234567',
          formId: 'f1', submittedAt: '2026-10-02T06:58:00.000Z',
          data: { 'Name': 'Max Muster', 'E-Mail': 'max@beispiel-gmbh.de', 'Telefonnummer': '0211 1234567', 'company_url_confirm': '' },
        },
      }),
    });
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, forwarded: true, lead_id: 'deal_2' });
    expect(j.decision).not.toBe('reject');
    expect(bodies[0]._validation.phone_flags).not.toContain('phone_prefix_denied');
  });
});
