import { describe, expect, it } from 'vitest';
import { effective, parseRemoteConfig } from '../src/core/effective.js';
import { RemoteConfigLoader } from '../src/server/remote-config.js';
import { loadConfig } from '../src/server/config.js';
import { checkSpam, DEFAULT_SPAM_RULE, localHour, primaryLang, type SpamRule } from '../src/core/spam.js';
import { checkPhone } from '../src/core/phone.js';
import { SCORE } from '../src/core/types.js';
import { baseEnv, makeApp, ORIGIN, post, remoteConfig, remoteSite } from './helpers.js';

const rule = (over: Partial<SpamRule> = {}): SpamRule => ({ ...DEFAULT_SPAM_RULE, ...over });

/** a typical click-farm submission: Nigeria, cheap Android, gmail, ~02:40 local */
const NG = { country: 'NG', tz: 'Africa/Lagos', lang: 'en-NG', hour: 2, phoneCountry: 'DE' };
/** a typical German B2B lead */
const DE = { country: 'DE', tz: 'Europe/Berlin', lang: 'de-DE', hour: 11, phoneCountry: 'DE' };

describe('checkSpam — geo', () => {
  it('off: nothing fires even for a denied country', () => {
    expect(checkSpam(NG, rule({ geo_deny: ['NG'] }))).toMatchObject({ flags: [], reject: null, country: 'NG' });
  });

  it('score: flags the denied country but never rejects', () => {
    const r = checkSpam(NG, rule({ geo_mode: 'score', geo_deny: ['NG'] }));
    expect(r.flags).toContain('geo_denied');
    expect(r.reject).toBeNull();
  });

  it('block: denied country rejects with geo_denied', () => {
    expect(checkSpam(NG, rule({ geo_mode: 'block', geo_deny: ['ng'] })).reject).toBe('geo_denied');
  });

  it('allowlist: a country outside DE/AT/CH is flagged geo_outside', () => {
    const r = checkSpam(NG, rule({ geo_mode: 'block', geo_allow: ['DE', 'AT', 'CH'] }));
    expect(r.flags).toContain('geo_outside');
    expect(r.reject).toBe('geo_denied');
  });

  it('allowlist lets the allowed country through, and the DE lead stays clean', () => {
    expect(checkSpam(DE, rule({ geo_mode: 'block', geo_allow: ['DE', 'AT', 'CH'], geo_deny: ['NG'] })))
      .toMatchObject({ flags: [], reject: null });
  });

  it('DE phone number on an unwanted IP country → phone_geo_mismatch', () => {
    const r = rule({ geo_mode: 'score', geo_deny: ['NG'] });
    expect(checkSpam(NG, r).flags).toContain('phone_geo_mismatch');
    expect(checkSpam(DE, r).flags).not.toContain('phone_geo_mismatch');
  });

  it('German number dialled from an allowed country (travel) collects no mismatch points', () => {
    const r = rule({ geo_mode: 'score', geo_allow: ['DE', 'AT', 'CH'], geo_deny: ['NG'] });
    const travelling = { country: 'AT', tz: 'Europe/Vienna', lang: 'de-DE', phoneCountry: 'DE' };
    expect(checkSpam(travelling, r)).toMatchObject({ flags: [], reject: null });
  });

  it('a mismatch alone, with no country rule matching, stays silent', () => {
    // US visitor, DE number, only NG denied → nothing unwanted about the country
    expect(checkSpam({ country: 'US', phoneCountry: 'DE' }, rule({ geo_mode: 'score', geo_deny: ['NG'] })).flags).toEqual([]);
  });

  it('unknown country (no edge header) → no geo flag at all (fail-open)', () => {
    const r = checkSpam({ ...NG, country: null }, rule({ geo_mode: 'block', geo_deny: ['NG'], geo_allow: ['DE'] }));
    expect(r).toMatchObject({ flags: [], reject: null, country: null });
  });

  it('garbage country values are ignored, not guessed', () => {
    expect(checkSpam({ country: 'Nigeria' }, rule({ geo_mode: 'block', geo_deny: ['NG'] })).country).toBeNull();
  });
});

describe('checkSpam — client fingerprint', () => {
  const clientRule = (mode: SpamRule['client_mode']) =>
    rule({ client_mode: mode, client_allow_tz: ['Europe/'], client_allow_lang: ['de', 'en'] });

  it('foreign timezone is flagged, German one is not', () => {
    expect(checkSpam(NG, clientRule('score')).flags).toContain('tz_foreign');
    expect(checkSpam(DE, clientRule('score')).flags).not.toContain('tz_foreign');
  });

  it('en-NG passes the language check (en is allowed) — only the timezone gives it away', () => {
    const r = checkSpam(NG, clientRule('score'));
    expect(r.flags).not.toContain('lang_foreign');
  });

  it('a language outside the list is flagged', () => {
    expect(checkSpam({ lang: 'ru-RU' }, clientRule('score')).flags).toContain('lang_foreign');
  });

  it('block mode rejects with client_denied', () => {
    expect(checkSpam(NG, clientRule('block')).reject).toBe('client_denied');
  });

  it('no signals (JS stripped, curl) → no flags', () => {
    expect(checkSpam({}, clientRule('block'))).toMatchObject({ flags: [], reject: null });
  });

  it('empty allow lists mean "do not check" instead of "block everything"', () => {
    expect(checkSpam(NG, rule({ client_mode: 'block' }))).toMatchObject({ flags: [], reject: null });
  });
});

describe('checkSpam — night window & text', () => {
  it('02:40 falls into 1..5, 11:00 does not', () => {
    const r = rule({ night_mode: 'score' });
    expect(checkSpam(NG, r).flags).toContain('night_submit');
    expect(checkSpam(DE, r).flags).not.toContain('night_submit');
  });

  it('window may wrap midnight (22..6)', () => {
    const r = rule({ night_mode: 'score', night_from: 22, night_to: 6 });
    expect(checkSpam({ hour: 23 }, r).flags).toContain('night_submit');
    expect(checkSpam({ hour: 3 }, r).flags).toContain('night_submit');
    expect(checkSpam({ hour: 12 }, r).flags).not.toContain('night_submit');
  });

  it('night never rejects on its own', () => {
    expect(checkSpam({ hour: 2 }, rule({ night_mode: 'score', night_from: 1, night_to: 5 })).reject).toBeNull();
  });

  it('keyword blocklist hits case-insensitively across all text fields', () => {
    const r = rule({ text_mode: 'block', text_deny: ['crypto loan'] });
    expect(checkSpam({ texts: ['Max', 'Muster GmbH', 'We offer a CRYPTO LOAN today'] }, r))
      .toMatchObject({ reject: 'text_denied' });
    expect(checkSpam({ texts: ['Max', 'Muster GmbH', 'Bitte um Rückruf'] }, r).flags).toEqual([]);
  });

  it('geo outranks text in the reject reason', () => {
    const r = rule({ geo_mode: 'block', geo_deny: ['NG'], text_mode: 'block', text_deny: ['loan'] });
    expect(checkSpam({ ...NG, texts: ['loan'] }, r).reject).toBe('geo_denied');
  });

  it('localHour returns a plausible hour and survives a bogus zone', () => {
    const h = localHour(Date.parse('2026-09-26T00:44:00Z'), 'Europe/Berlin');
    expect(h).toBe(2); // CEST
    expect(localHour(Date.now(), 'Nowhere/Nothing')).toBeNull();
  });

  it('primaryLang normalizes', () => {
    expect(primaryLang('de-DE')).toBe('de');
    expect(primaryLang('EN')).toBe('en');
    expect(primaryLang('')).toBeNull();
  });
});

describe('checkSpam — geo_freemail and device blocklist', () => {
  // rule 1: foreign country + freemail — real foreign enquiries tend to use company domains
  const r1 = rule({ geo_freemail_mode: 'block', geo_allow: ['DE', 'AT', 'CH'] });

  it('NG + gmail is rejected', () => {
    const r = checkSpam({ ...NG, freemail: true }, r1);
    expect(r.flags).toContain('geo_freemail');
    expect(r.reject).toBe('geo_denied');
  });

  it('a US enquiry from a company domain survives it', () => {
    expect(checkSpam({ country: 'US', tz: 'America/New_York', lang: 'en-US', freemail: false }, r1))
      .toMatchObject({ flags: [], reject: null });
  });

  it('a German lead with a gmail address survives it', () => {
    expect(checkSpam({ ...DE, freemail: true }, r1)).toMatchObject({ flags: [], reject: null });
  });

  it('score mode flags without blocking', () => {
    const r = checkSpam({ ...NG, freemail: true }, rule({ geo_freemail_mode: 'score', geo_allow: ['DE'] }));
    expect(r).toMatchObject({ flags: ['geo_freemail'], reject: null });
  });

  // rule 7: cheap Android models popular with click farms
  const r7 = rule({ ua_mode: 'block', ua_deny: ['tecno', 'infinix', 'itel'] });
  const TECNO = 'Mozilla/5.0 (Linux; Android 12; TECNO POP 7 Pro) AppleWebKit/537.36 Chrome/153 Mobile';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

  it('a Tecno device is rejected, an iPhone is not', () => {
    expect(checkSpam({ ua: TECNO }, r7)).toMatchObject({ flags: ['ua_denied'], reject: 'device_denied' });
    expect(checkSpam({ ua: IPHONE }, r7)).toMatchObject({ flags: [], reject: null });
  });

  it('no User-Agent (server-to-server webhook) → no device verdict', () => {
    expect(checkSpam({ ua: null }, r7)).toMatchObject({ flags: [], reject: null });
  });

  it('empty ua_deny never blocks everything', () => {
    expect(checkSpam({ ua: TECNO }, rule({ ua_mode: 'block' }))).toMatchObject({ flags: [], reject: null });
  });
});

describe('checkSpam — geo_phone_fallback (the webhook path has no IP country)', () => {
  /** a known spam sample: Nigerian mobile, gmail, no client IP → no CF-IPCountry */
  const WEBHOOK_NG = { country: null, phoneCountry: 'NG', freemail: true };
  /** rule 1 as recommended, now also reachable on the webhook path */
  const r1 = (over: Partial<SpamRule> = {}) =>
    rule({ geo_freemail_mode: 'block', geo_allow: ['DE', 'AT', 'CH'], ...over });

  it('libphonenumber really knows the country of that number — the fallback has something to read', () => {
    expect(checkPhone('+2348021234567', 'DE')).toMatchObject({ valid: true, country: 'NG' });
  });

  it('off (default): the sample stays unjudged — no geo flag, no reject', () => {
    expect(checkSpam(WEBHOOK_NG, r1())).toMatchObject({ flags: [], reject: null, country: null });
  });

  it('on: the same submission is rejected, and geo_from_phone says where the country came from', () => {
    const r = checkSpam(WEBHOOK_NG, r1({ geo_phone_fallback: true }));
    expect(r.flags).toEqual(['geo_from_phone', 'geo_freemail']);
    expect(r).toMatchObject({ reject: 'geo_denied', country: 'NG' });
  });

  it('the marker itself costs nothing — only the geo rule scores', () => {
    expect(SCORE.geo_from_phone).toBe(0);
  });

  it('on: a Swiss number with a gmail address stays clean (CH is allowed)', () => {
    const CH = { country: null, phoneCountry: checkPhone('+41 44 668 18 00', 'DE').country, freemail: true };
    expect(checkSpam(CH, r1({ geo_phone_fallback: true }))).toMatchObject({ flags: [], reject: null, country: 'CH' });
  });

  it('on: a US number from a company domain is flagged geo_outside, but never geo_freemail', () => {
    const US = { country: null, phoneCountry: checkPhone('+1 415 555 0132', 'DE').country, freemail: false };
    const r = checkSpam(US, r1({ geo_phone_fallback: true, geo_mode: 'score' }));
    expect(r.flags).toEqual(['geo_from_phone', 'geo_outside']);
    expect(r.flags).not.toContain('geo_freemail');
    expect(r.reject).toBeNull();
  });

  it('on: an arriving IP country wins over the phone, and the mismatch still fires', () => {
    const r = checkSpam({ country: 'NG', phoneCountry: 'DE' }, rule({
      geo_mode: 'score', geo_deny: ['NG'], geo_phone_fallback: true,
    }));
    expect(r.flags).toEqual(['geo_denied', 'phone_geo_mismatch']);
    expect(r.flags).not.toContain('geo_from_phone');
    expect(r.country).toBe('NG');
  });

  it('on: the phone as the only source never contradicts itself (no phone_geo_mismatch)', () => {
    const r = checkSpam({ country: null, phoneCountry: 'NG' }, rule({
      geo_mode: 'score', geo_deny: ['NG'], geo_phone_fallback: true,
    }));
    expect(r.flags).toEqual(['geo_from_phone', 'geo_denied']);
    expect(r.flags).not.toContain('phone_geo_mismatch');
  });

  it('on, but no phone at all (newsletter form) → no geo flag, country stays unknown', () => {
    expect(checkSpam({ country: null, freemail: true }, r1({ geo_phone_fallback: true })))
      .toMatchObject({ flags: [], reject: null, country: null });
  });

  it('on with the geo rules off: nothing is checked and no country is reported', () => {
    expect(checkSpam(WEBHOOK_NG, rule({ geo_phone_fallback: true, client_mode: 'score' })))
      .toMatchObject({ flags: [], reject: null, country: null });
  });
});

describe('spam rules in the remote config', () => {
  const spam = { geo_mode: 'block', geo_deny: ['ng'], client_allow_tz: ['Europe/'], block_threshold: 50 };

  it('global spam block is parsed, normalized and merged onto the defaults', () => {
    const cfg = parseRemoteConfig(remoteConfig({ spam }));
    expect(cfg!.global.spam).toMatchObject({
      geo_mode: 'block', geo_deny: ['NG'], client_allow_tz: ['europe/'], block_threshold: 50,
      client_mode: 'off', night_mode: 'off', text_mode: 'off', geo_phone_fallback: false,
    });
  });

  it('config without a spam block keeps the layer off', () => {
    expect(parseRemoteConfig(remoteConfig())!.global.spam).toEqual(DEFAULT_SPAM_RULE);
  });

  it.each([
    ['unknown mode', { geo_mode: 'maybe' }],
    ['country too long', { geo_deny: ['NGA'] }],
    ['threshold out of range', { block_threshold: 0 }],
    ['threshold not a number', { block_threshold: '50' }],
    ['hour out of range', { night_from: 24 }],
    ['deny list not an array', { geo_deny: 'NG' }],
    ['night mode not off/score', { night_mode: 'block' }],
    ['phone fallback not a boolean', { geo_phone_fallback: 'yes' }],
    ['phone fallback as a number', { geo_phone_fallback: 1 }],
  ])('invalid spam payload is rejected as a whole: %s', (_name, bad) => {
    expect(parseRemoteConfig(remoteConfig({ spam: bad }))).toBeNull();
  });

  it('cascade global → site → form merges field by field', () => {
    const cfg = parseRemoteConfig(remoteConfig({ spam }, [remoteSite({
      spam: { geo_deny: ['NG', 'PK'], night_mode: 'score' },
      forms: { Kontakt: { spam: { geo_mode: 'score' } } },
    })]));
    const rt = new RemoteConfigLoader(loadConfig(baseEnv));
    expect(rt.applyRemote(cfg)).toBe(true);

    const site = effective(rt.get(), 'demo', null).spam;
    expect(site).toMatchObject({ geo_mode: 'block', geo_deny: ['NG', 'PK'], night_mode: 'score', block_threshold: 50 });

    const form = effective(rt.get(), 'demo', 'Kontakt').spam;
    expect(form).toMatchObject({ geo_mode: 'score', geo_deny: ['NG', 'PK'], night_mode: 'score' });
  });

  it('geo_phone_fallback cascades global → site → form like every other field', () => {
    const cfg = parseRemoteConfig(remoteConfig({ spam }, [remoteSite({
      spam: { geo_phone_fallback: true },
      // one form gets its phone numbers from a partner feed → switch the stand-in off again
      forms: { Kontakt: { spam: { geo_phone_fallback: false } } },
    })]));
    const rt = new RemoteConfigLoader(loadConfig(baseEnv));
    expect(rt.applyRemote(cfg)).toBe(true);
    expect(effective(rt.get(), 'demo', null).spam.geo_phone_fallback).toBe(true);
    expect(effective(rt.get(), 'demo', 'Kontakt').spam.geo_phone_fallback).toBe(false);
    // a site that says nothing inherits the global default (off)
    expect(effective(rt.get(), 'unknown-site', null).spam.geo_phone_fallback).toBe(false);
  });

  it('block_threshold: null at site level switches an inherited threshold off', () => {
    const cfg = parseRemoteConfig(remoteConfig({ spam }, [remoteSite({ spam: { block_threshold: null } })]));
    const rt = new RemoteConfigLoader(loadConfig(baseEnv));
    expect(rt.applyRemote(cfg)).toBe(true);
    expect(effective(rt.get(), 'demo', null).spam.block_threshold).toBeNull();
  });
});

describe('/v1/validate with the spam layer', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    email: 'spam.sample@gmail.com', phone: '08034 123456', mode: 'submit', honeypot: '',
    signals: { i: true, wd: false, tz: 'Africa/Lagos', lg: 'en-NG' },
    context: { site: 'demo', form: 'Quote Request' }, ...over,
  });
  const H = (extra: Record<string, string> = {}) => ({ Origin: ORIGIN, ...extra });

  it('a click-farm lead is still accepted with the layer off', async () => {
    const { app } = makeApp({}, {}, remoteConfig());
    const r = await post(app, '/v1/validate', body(), H({ 'CF-IPCountry': 'NG' }));
    const j = await r.json() as { decision: string; flags: string[] };
    expect(j.decision).toBe('accept_flagged');
    expect(j.flags).not.toContain('geo_denied');
  });

  it('geo block on NG rejects it', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { geo_mode: 'block', geo_deny: ['NG'] } }));
    const r = await post(app, '/v1/validate', body(), H({ 'CF-IPCountry': 'NG' }));
    expect(await r.json()).toMatchObject({ decision: 'reject', reject_reason: 'geo_denied' });
  });

  it('a German visitor on the same config is untouched', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { geo_mode: 'block', geo_deny: ['NG'] } }));
    const r = await post(app, '/v1/validate', body({
      email: 'kontakt@existierende-gmbh.de', signals: { i: true, wd: false, tz: 'Europe/Berlin', lg: 'de-DE' },
    }), H({ 'CF-IPCountry': 'DE' }));
    const j = await r.json() as { decision: string; reject_reason: string | null };
    expect(j.reject_reason).toBeNull();
  });

  it('without the edge header the score gate still catches it via timezone', async () => {
    const { app } = makeApp({}, {}, remoteConfig({
      spam: { client_mode: 'score', client_allow_tz: ['Europe/'], client_allow_lang: ['de'], block_threshold: 50 },
    }));
    const r = await post(app, '/v1/validate', body(), H());
    const j = await r.json() as { decision: string; reject_reason: string; score: number; flags: string[] };
    expect(j.flags).toEqual(expect.arrayContaining(['tz_foreign', 'lang_foreign']));
    expect(j.score).toBeGreaterThanOrEqual(50);
    expect(j).toMatchObject({ decision: 'reject', reject_reason: 'spam_score' });
  });

  it('field checks never block on spam rules (only the submit does)', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { geo_mode: 'block', geo_deny: ['NG'], block_threshold: 10 } }));
    const r = await post(app, '/v1/validate', body({ mode: 'field' }), H({ 'CF-IPCountry': 'NG' }));
    const j = await r.json() as { decision: string; reject_reason: string | null };
    expect(j.reject_reason).toBeNull();
  });

  it('rule 1 end to end: NG + gmail is blocked, the same lead from a company domain is not', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { geo_freemail_mode: 'block', geo_allow: ['DE', 'AT', 'CH'] } }));
    const spamLead = await post(app, '/v1/validate', body(), H({ 'CF-IPCountry': 'NG' }));
    expect(await spamLead.json()).toMatchObject({ decision: 'reject', reject_reason: 'geo_denied' });

    const foreignButReal = await post(app, '/v1/validate', body({ email: 'partner@existierende-gmbh.de' }), H({ 'CF-IPCountry': 'US' }));
    expect((await foreignButReal.json() as { reject_reason: string | null }).reject_reason).toBeNull();
  });

  it('rule 7 end to end: the device blocklist reads the real User-Agent header', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { ua_mode: 'block', ua_deny: ['tecno', 'infinix'] } }));
    const r = await post(app, '/v1/validate', body(), H({
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12; TECNO POP 7 Pro) AppleWebKit/537.36 Chrome/153 Mobile',
    }));
    const j = await r.json() as { decision: string; reject_reason: string; flags: string[] };
    expect(j.flags).toContain('ua_denied');
    expect(j).toMatchObject({ decision: 'reject', reject_reason: 'device_denied' });
  });

  it('tor/unknown edge country (T1, XX) is treated as unknown', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { geo_mode: 'block', geo_allow: ['DE'] } }));
    for (const cc of ['T1', 'XX']) {
      const r = await post(app, '/v1/validate', body(), H({ 'CF-IPCountry': cc }));
      expect((await r.json() as { reject_reason: string | null }).reject_reason).toBeNull();
    }
  });
});

describe('/v1/hooks/webflow — a known spam sample with geo_phone_fallback', () => {
  // Webflow sends this server-to-server: no client IP, therefore no CF-IPCountry, therefore the geo
  // rules are blind. The country is in the number all along (+234 = NG).
  const SUBMITTED = '2026-09-28T01:12:00.000Z';
  const submission = (id: string) => ({
    triggerType: 'form_submission',
    payload: {
      id, name: 'Quote Request', siteId: '0123456789abcdef01234567', formId: 'f1', submittedAt: SUBMITTED,
      data: {
        'Name': 'Spam Sample', 'E-Mail': 'spam.sample@gmail.com',
        'Telefonnummer': '+2348021234567', 'company_url_confirm': '',
      },
    },
  });

  /** captures the forwarded lead store bodies; 201 like a real intake */
  function forwardMock() {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(JSON.stringify({ ok: true, lead_id: 'deal_1', status: 'received' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { bodies, fetchImpl };
  }

  /** rule 1 as recommended, site forwarding to the lead store */
  const config = (over: Record<string, unknown> = {}) => remoteConfig(
    { spam: { geo_freemail_mode: 'block', geo_allow: ['DE', 'AT', 'CH'], ...over } },
    [remoteSite({ forward: true })],
  );

  const send = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
    app.request('/v1/hooks/webflow?site=demo&k=hook-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('fallback off: forwarded with 45 points and only flagged', async () => {
    const { bodies, fetchImpl } = forwardMock();
    const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl }, config());
    const j = await (await send(app, submission('wf_case_a_off'))).json() as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, forwarded: true, decision: 'accept_flagged' });
    const v = bodies[0]._validation;
    expect(v.flags).toEqual(expect.arrayContaining(['freemail', 'foreign', 'typed_e164', 'token_missing']));
    expect(v.flags).not.toContain('geo_freemail');
    expect(v.score).toBe(45);
  });

  it('fallback on: the same submission is rejected and never reaches the lead store', async () => {
    const { bodies, fetchImpl } = forwardMock();
    const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl }, config({ geo_phone_fallback: true }));
    const j = await (await send(app, submission('wf_case_a_on'))).json() as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, forwarded: false, decision: 'reject', reason: 'geo_denied' });
    expect(bodies).toHaveLength(0);
  });

  it('fallback on: a German enquiry through the same hook is untouched', async () => {
    const { bodies, fetchImpl } = forwardMock();
    const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl }, config({ geo_phone_fallback: true }));
    const de = submission('wf_case_a_de');
    de.payload.data['E-Mail'] = 'k.mueller@web.de';
    de.payload.data['Telefonnummer'] = '0171 2345678';
    const j = await (await send(app, de)).json() as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, forwarded: true });
    expect(j.decision).not.toBe('reject');
    expect(bodies[0]._validation.flags).not.toContain('geo_from_phone');
  });
});
