import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRemoteConfig } from '../src/core/effective.js';
import { isJunkReject } from '../src/core/score.js';
import { checkSpam, DEFAULT_SPAM_RULE, ipDenied, normName, type SpamRule } from '../src/core/spam.js';
import { mintToken } from '../src/core/token.js';
import { baseEnv, makeApp, remoteConfig, remoteSite } from './helpers.js';

const rule = (over: Partial<SpamRule> = {}): SpamRule => ({ ...DEFAULT_SPAM_RULE, ...over });

/** a fake-lead wave using a fixed set of German-looking names (freemail, DE number, DE IP) */
const SAMPLE = { email: 'john.sample@gmx.net', name: 'John Sample', country: 'DE', phoneCountry: 'DE', freemail: true };

describe('checkSpam — contact blocklist', () => {
  it('default: empty lists, nothing fires', () => {
    expect(checkSpam(SAMPLE, rule())).toMatchObject({ flags: [], reject: null });
  });

  it('exact address, whole domain and full name all hit; block rejects with contact_denied', () => {
    for (const over of [
      { contact_deny_emails: ['john.sample@gmx.net'] },
      { contact_deny_emails: ['@gmx.net'] },
      { contact_deny_names: ['john  sample'] },
    ]) {
      const r = checkSpam(SAMPLE, rule(over));
      expect(r.flags).toContain('contact_denied');
      expect(r.reject).toBe('contact_denied');
    }
  });

  it('no substring matches: another address on the same provider, another John', () => {
    const r = rule({ contact_deny_emails: ['john.sample@gmx.net'], contact_deny_names: ['john sample'] });
    expect(checkSpam({ email: 'john.sample2@gmx.net', name: 'John Sampleer' }, r).flags).toEqual([]);
    expect(checkSpam({ email: 'x@notgmx.net' }, rule({ contact_deny_emails: ['@gmx.net'] })).flags).toEqual([]);
  });

  it('score mode flags only; contact wins the reject reason over geo', () => {
    expect(checkSpam(SAMPLE, rule({ contact_mode: 'score', contact_deny_names: ['john sample'] })).reject).toBeNull();
    const r = checkSpam({ ...SAMPLE, country: 'NG' }, rule({ contact_deny_names: ['john sample'], geo_mode: 'block', geo_deny: ['NG'] }));
    expect(r.reject).toBe('contact_denied');
    expect(r.flags).toContain('geo_denied');
  });

  it('normName collapses case, punctuation and spacing', () => {
    expect(normName('  JOHN-Sample ')).toBe('john sample');
    expect(normName('Al')).toBeNull();
  });
});

describe('checkSpam — repeat and no_embed', () => {
  it('repeat fires once the earlier count reaches repeat_max', () => {
    const r = rule({ repeat_mode: 'block', repeat_max: 2 });
    expect(checkSpam({ repeatCount: 1 }, r).flags).toEqual([]);
    expect(checkSpam({ repeatCount: 2 }, r)).toMatchObject({ flags: ['repeat_contact'], reject: 'repeat_denied' });
    expect(checkSpam({ repeatCount: 9 }, rule({ repeat_max: 2 })).flags).toEqual([]); // off by default
    expect(checkSpam({ repeatCount: null }, r).flags).toEqual([]);
  });

  it('no_embed fires only when the caller says the embed never ran', () => {
    expect(checkSpam({ embedMissing: true }, rule({ no_embed_mode: 'block' }))).toMatchObject({ flags: ['embed_missing'], reject: 'embed_missing' });
    expect(checkSpam({ embedMissing: false }, rule({ no_embed_mode: 'block' })).flags).toEqual([]);
    expect(checkSpam({ embedMissing: true }, rule()).flags).toEqual([]);
  });
});

describe('checkSpam — IP blocklist', () => {
  const IP = '203.0.113.7';
  it('exact IPv4, CIDR, IPv4-mapped IPv6 and exact IPv6 match', () => {
    expect(ipDenied(IP, [IP])).toBe(true);
    expect(ipDenied(IP, ['203.0.0.0/16'])).toBe(true);
    expect(ipDenied('::ffff:' + IP, [IP])).toBe(true);
    expect(ipDenied('2001:DB8::1', ['2001:db8::1'])).toBe(true);
    expect(ipDenied('203.0.113.8', [IP])).toBe(false);
    expect(ipDenied('203.1.0.1', ['203.0.0.0/16'])).toBe(false);
    expect(ipDenied(IP, ['0.0.0.0/0'])).toBe(true);
    expect(ipDenied(IP, ['203.0.0.0/40', 'garbage'])).toBe(false);
  });

  it('block rejects with ip_denied, score only flags, empty list or missing IP does nothing', () => {
    expect(checkSpam({ ip: IP }, rule({ ip_deny: [IP] }))).toMatchObject({ flags: ['ip_denied'], reject: 'ip_denied' });
    expect(checkSpam({ ip: IP }, rule({ ip_mode: 'score', ip_deny: [IP] })).reject).toBeNull();
    expect(checkSpam({ ip: IP }, rule()).flags).toEqual([]);
    expect(checkSpam({ ip: null }, rule({ ip_deny: [IP] })).flags).toEqual([]);
  });

  it('remote config accepts IPs/CIDRs and rejects garbage', () => {
    expect(parseRemoteConfig(remoteConfig({ spam: { ip_deny: [IP, '198.51.100.0/24', '2001:db8::1'] } }))?.global.spam.ip_deny)
      .toEqual([IP, '198.51.100.0/24', '2001:db8::1']);
    expect(parseRemoteConfig(remoteConfig({ spam: { ip_deny: ['not an ip'] } }))).toBeNull();
  });

  it('/v1/validate: submit from a denied IP (CF-Connecting-IP) is rejected with ip_denied', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ spam: { ip_deny: [IP] } }));
    const call = (ip: string) => app.request('/v1/validate', { method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://www.example.com', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'max@beispiel-gmbh.de', phone: '0211 1234567', mode: 'submit', context: { site: 'demo' } }) });
    expect(await (await call(IP)).json()).toMatchObject({ decision: 'reject', reject_reason: 'ip_denied' });
    expect(((await (await call('84.1.2.3')).json()) as any).reject_reason).not.toBe('ip_denied');
  });
});

describe('isJunkReject', () => {
  const r = (reject_reason: any, flags: any[] = []) => ({ decision: 'reject' as const, reject_reason, flags });
  it('junk yes, typos no', () => {
    expect(isJunkReject(r('contact_denied'))).toBe(true);
    expect(isJunkReject(r('repeat_denied'))).toBe(true);
    expect(isJunkReject(r('ip_denied'))).toBe(true);
    expect(isJunkReject(r('phone_invalid', ['phone_prefix_denied']))).toBe(true);
    expect(isJunkReject(r('phone_invalid', ['invalid']))).toBe(false);
    expect(isJunkReject(r('email_syntax'))).toBe(false);
    expect(isJunkReject({ decision: 'accept_flagged', reject_reason: null, flags: [] })).toBe(false);
  });
});

describe('remote config — new spam fields', () => {
  it('parses lists, ints and modes; normalizes case and spaces', () => {
    const c = parseRemoteConfig(remoteConfig({ spam: {
      contact_mode: 'block', contact_deny_emails: ['John.Sample@GMX.net', '@example.org'], contact_deny_names: ['Paul   Example'],
      repeat_mode: 'block', repeat_max: 2, repeat_window_h: 72, no_embed_mode: 'score',
    } }));
    expect(c?.global.spam).toMatchObject({
      contact_deny_emails: ['john.sample@gmx.net', '@example.org'], contact_deny_names: ['paul example'],
      repeat_mode: 'block', repeat_max: 2, repeat_window_h: 72, no_embed_mode: 'score',
    });
  });

  it('rejects the whole config on a bad value (fail-safe)', () => {
    for (const bad of [{ repeat_max: 0 }, { repeat_window_h: 1000 }, { contact_deny_emails: ['kein-at-zeichen'] }, { no_embed_mode: 'maybe' }]) {
      expect(parseRemoteConfig(remoteConfig({ spam: bad }))).toBeNull();
    }
  });
});

// ── Webflow webhook ──────────────────────────────────────────────────────────
type Call = { url: string; method: string; body: any };
function fetchMock() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).includes('api.webflow.com')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ok: true, lead_id: 'deal_1' }), { status: 201 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SUBMITTED = new Date().toISOString();
let n = 0;
function wfPayload(data: Record<string, unknown>) {
  n++;
  const id = (n.toString(16) + 'a'.repeat(24)).slice(0, 24);
  return { triggerType: 'form_submission', payload: { id, name: 'Branding Anfrage', siteId: '0123456789abcdef01234567', formId: 'f1', submittedAt: SUBMITTED, data } };
}
const sendWf = (app: any, body: unknown) => app.request('/v1/hooks/webflow?site=demo&k=hook-secret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bot = { Name: 'Godfred', 'E-Mail': 'godfred@gmail.com', Telefonnummer: '+49 211 1234567' };
const DELETE_ENV = { WEBFLOW_API_TOKEN: 'wf-api', WEBFLOW_DELETE_REJECTED: 'true' };

describe('Webflow webhook — embed bypass, deletion, repeats', () => {
  it('no token + no signals → embed_missing; with no_embed_mode block on an enforcing site the submission is deleted in Webflow', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(DELETE_ENV, { fetchImpl }, remoteConfig({ spam: { no_embed_mode: 'block' } }));
    const j = await (await sendWf(app, wfPayload(bot))).json() as any;
    expect(j).toMatchObject({ decision: 'reject', deleted: true });
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toMatch(/^https:\/\/api\.webflow\.com\/v2\/form_submissions\/[a-f0-9]{24}$/);
  });

  it('a submission that ran the embed is not embed_missing', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(DELETE_ENV, { fetchImpl }, remoteConfig({ spam: { no_embed_mode: 'block' } }));
    const token = mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, Date.parse(SUBMITTED) - 20_000);
    const j = await (await sendWf(app, wfPayload({ ...bot, lv_vt: token, lv_vs: 'v1;i=1;wd=0;pl=900' }))).json() as any;
    expect(j.decision).not.toBe('reject');
    expect(j.deleted).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('never deletes without the kill switch, on an observing site, or for a typo reject', async () => {
    const cases: [NodeJS.ProcessEnv, unknown, Record<string, unknown>][] = [
      [{ WEBFLOW_API_TOKEN: 'wf-api' }, remoteConfig({ spam: { no_embed_mode: 'block' } }), bot],
      [DELETE_ENV, remoteConfig({ spam: { no_embed_mode: 'block' } }, [remoteSite({ mode: 'observe' })]), bot],
      [DELETE_ENV, remoteConfig(), { ...bot, Telefonnummer: '12' }], // strict → phone_invalid, a typo
    ];
    for (const [env, remote, data] of cases) {
      const { calls, fetchImpl } = fetchMock();
      const { app } = makeApp(env, { fetchImpl }, remote);
      const j = await (await sendWf(app, wfPayload(data))).json() as any;
      expect(j.deleted).toBe(false);
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    }
  });

  it('blocklisted name is rejected and deleted', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(DELETE_ENV, { fetchImpl }, remoteConfig({ spam: { contact_deny_names: ['John Sample'] } }));
    const j = await (await sendWf(app, wfPayload({ Name: 'John Sample', 'E-Mail': 'john.sample@gmx.net', Telefonnummer: '0211600123' }))).json() as any;
    expect(j).toMatchObject({ decision: 'reject', reason: 'contact_denied', deleted: true });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('repeat: third submission with the same e-mail inside the window is rejected', async () => {
    const { fetchImpl } = fetchMock();
    const { app } = makeApp({}, { fetchImpl }, remoteConfig({ spam: { repeat_mode: 'block', repeat_max: 2 } }));
    const d = { Name: 'Paul Example', 'E-Mail': 'paul.example@web.de', Telefonnummer: '+49 211 5885212' };
    const out: string[] = [];
    for (let i = 0; i < 3; i++) out.push(((await (await sendWf(app, wfPayload(d))).json()) as any).decision);
    expect(out[0]).not.toBe('reject');
    expect(out[1]).not.toBe('reject');
    expect(out[2]).toBe('reject');
  });

  it('repeat by full name catches a new address under the same name', async () => {
    const { fetchImpl } = fetchMock();
    const { app } = makeApp({}, { fetchImpl }, remoteConfig({ spam: { repeat_mode: 'block', repeat_max: 2 } }));
    const res: any[] = [];
    for (const mail of ['john.sample@web.de', 'j.sample@web.de', 'sample.john@web.de']) {
      res.push(await (await sendWf(app, wfPayload({ Name: 'John Sample', 'E-Mail': mail, Telefonnummer: '0211600123' }))).json());
    }
    expect(res[2]).toMatchObject({ decision: 'reject', reason: 'repeat_denied' });
  });
});

// ── Calendly webhook ─────────────────────────────────────────────────────────
const SIGNING = 'cal-signing-key';
const CAL_ENV = { CALENDLY_TOKEN: 'cal-token', CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING };
let inv = 0;
function calBody(over: Record<string, unknown> = {}, event = 'invitee.created') {
  inv++;
  return {
    event, created_at: new Date().toISOString(),
    payload: {
      uri: `https://api.calendly.com/scheduled_events/EV${inv}/invitees/INV${inv}`,
      email: 'john.sample@gmx.net', name: 'John Sample',
      scheduled_event: { uri: `https://api.calendly.com/scheduled_events/EV${inv}`, name: 'Termine finden für Erstgespräch' },
      questions_and_answers: [{ question: 'Telefonnummer', answer: '+49 211 500537' }],
      ...over,
    },
  };
}
function signed(app: any, body: unknown, key = SIGNING, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const v1 = createHmac('sha256', key).update(`${t}.${raw}`).digest('hex');
  return app.request('/v1/hooks/calendly?site=demo', { method: 'POST', headers: { 'content-type': 'application/json', 'calendly-webhook-signature': `t=${t},v1=${v1}` }, body: raw });
}

describe('Calendly webhook', () => {
  it('auth: valid signature, fallback secret; wrong key / stale timestamp / nothing → 401', async () => {
    const { fetchImpl } = fetchMock();
    const { app } = makeApp(CAL_ENV, { fetchImpl }, remoteConfig());
    expect((await signed(app, calBody())).status).toBe(200);
    expect((await signed(app, calBody(), 'wrong')).status).toBe(401);
    expect((await signed(app, calBody(), SIGNING, Math.floor(Date.now() / 1000) - 600)).status).toBe(401);
    expect((await app.request('/v1/hooks/calendly?site=demo', { method: 'POST', body: JSON.stringify(calBody()) })).status).toBe(401);
    const { app: app2 } = makeApp({ CALENDLY_TOKEN: 'cal-token' }, { fetchImpl }, remoteConfig());
    expect((await app2.request('/v1/hooks/calendly?site=demo&k=hook-secret', { method: 'POST', body: JSON.stringify(calBody()) })).status).toBe(200);
  });

  it('blocklisted invitee on an enforcing site → booking cancelled via the Calendly API', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(CAL_ENV, { fetchImpl }, remoteConfig({ spam: { contact_deny_names: ['john sample'] } }));
    const body = calBody();
    const j = await (await signed(app, body)).json() as any;
    expect(j).toMatchObject({ decision: 'reject', reason: 'contact_denied', cancelled: true });
    const c = calls.find((x) => x.url.endsWith('/cancellation'));
    expect(c?.url).toBe(`${(body.payload.scheduled_event as any).uri}/cancellation`);
    expect(c?.method).toBe('POST');
  });

  it('booking burst: the third booking under the same e-mail is cancelled, the first two stay', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(CAL_ENV, { fetchImpl }, remoteConfig({ spam: { repeat_mode: 'block', repeat_max: 2 } }));
    const res: any[] = [];
    for (let i = 0; i < 3; i++) res.push(await (await signed(app, calBody({ email: 'paul.example@gmx.net', name: 'Paul Example' }))).json());
    expect(res.map((r) => r.cancelled)).toEqual([false, false, true]);
    expect(calls.filter((x) => x.url.endsWith('/cancellation'))).toHaveLength(1);
  });

  it('never cancels: observing site, missing token, a real lead, a foreign event URI', async () => {
    const deny = { spam: { contact_deny_names: ['john sample'] } };
    const cases: [NodeJS.ProcessEnv, unknown, Record<string, unknown>][] = [
      [CAL_ENV, remoteConfig(deny, [remoteSite({ mode: 'observe' })]), {}],
      [{ CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING }, remoteConfig(deny), {}],
      [CAL_ENV, remoteConfig(deny), { name: 'Thomas Finck', email: 'tf@zu-heiss.de' }],
      [CAL_ENV, remoteConfig(deny), { scheduled_event: { uri: 'https://evil.example/scheduled_events/X' } }],
    ];
    for (const [env, remote, over] of cases) {
      const { calls, fetchImpl } = fetchMock();
      const { app } = makeApp(env, { fetchImpl }, remote);
      const j = await (await signed(app, calBody(over))).json() as any;
      expect(j.cancelled).toBe(false);
      expect(calls.some((x) => x.url.endsWith('/cancellation'))).toBe(false);
    }
  });

  it('other events ignored; same invitee twice handled once', async () => {
    const { calls, fetchImpl } = fetchMock();
    const { app } = makeApp(CAL_ENV, { fetchImpl }, remoteConfig({ spam: { contact_deny_names: ['john sample'] } }));
    expect(await (await signed(app, calBody({}, 'invitee.canceled'))).json()).toMatchObject({ ok: true, ignored: 'invitee.canceled' });
    const body = calBody();
    await signed(app, body);
    expect(await (await signed(app, body)).json()).toMatchObject({ duplicate: true });
    expect(calls.filter((x) => x.url.endsWith('/cancellation'))).toHaveLength(1);
  });
});
