// Remote config end-to-end through the HTTP surface: token shape, per-form rules, dynamic origins,
// admin routes, health and the decision events the statistics feed on.
import { describe, expect, it } from 'vitest';
import { mintToken } from '../src/core/token.js';
import { loadConfig } from '../src/server/config.js';
import { EventSink, type LeadEvent } from '../src/server/events.js';
import { baseEnv, makeApp, MESSAGES, ORIGIN, post, remoteConfig, remoteSite } from './helpers.js';

const H = { origin: ORIGIN };
const KEY = { 'x-api-key': 'key-srv-123' };
const EVENTS_URL = 'https://control.test/api/lead-validate/events';
const tok = () => mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, Date.now() - 10_000);

/** app + a sink whose POSTs we can read */
function withEvents(remote?: unknown, env: NodeJS.ProcessEnv = {}) {
  const sent: LeadEvent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(...JSON.parse(String(init?.body)).events);
    return new Response(JSON.stringify({ ok: true, stored: true, received: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = loadConfig({ ...baseEnv, ...env, EVENTS_URL: EVENTS_URL });
  const events = new EventSink(cfg, { fetchImpl, batchSize: 9999 });
  const built = makeApp(env, { events }, remote);
  return { ...built, events, sent };
}

describe('/v1/token with remote config', () => {
  it('delivers mode/strict/country/messages/forms of the site', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ mode: 'observe' }, [remoteSite({
      mode: 'enforce', country: 'AT', messages: { email: 'Mail falsch', phone: 'Nummer falsch' },
      forms: { 'Newsletter Subscription': { enabled: true, fields: { email: true, phone: false } } },
    })]));
    const j = await (await app.request('/v1/token?site=demo', { headers: H })).json() as any;
    expect(j.token.startsWith('v1.demo.')).toBe(true);
    expect(j).toMatchObject({ ttl_s: 21600, site: 'demo', mode: 'enforce', strict: true, country: 'AT' });
    expect(j.messages).toEqual({ email: 'Mail falsch', phone: 'Nummer falsch' });
    expect(j.forms['Newsletter Subscription']).toMatchObject({ enabled: true, fields: { email: true, phone: false } });
  });

  it('falls back to the site owning the Origin when ?site= is missing', async () => {
    const { app } = makeApp({}, {}, remoteConfig());
    const j = await (await app.request('/v1/token', { headers: { origin: 'https://your-site.webflow.io' } })).json() as any;
    expect(j.site).toBe('demo');
    expect(j.token.startsWith('v1.demo.')).toBe(true);
    expect(j.forms).toEqual({});
  });

  it('unknown site → observe with the remote config, EMBED_MODE with the env fallback', async () => {
    const remote = makeApp({}, {}, remoteConfig({ mode: 'enforce' }));
    const a = await (await remote.app.request('/v1/token?site=fremd', { headers: H })).json() as any;
    expect(a).toMatchObject({ site: 'fremd', mode: 'observe', strict: true });
    expect(a.messages).toEqual(MESSAGES);
    const env = makeApp({ EMBED_MODE: 'enforce', STRICT_CONTACT: 'true' });
    const b = await (await env.app.request('/v1/token?site=fremd', { headers: H })).json() as any;
    expect(b).toMatchObject({ site: 'fremd', mode: 'enforce', strict: true });
  });
});

describe('pipeline uses the effective config', () => {
  const remote = remoteConfig({ mode: 'enforce', strict: true }, [remoteSite({
    forms: {
      'Newsletter Subscription': { enabled: true, fields: { email: true, phone: false } },
      'Site Audit': { enabled: false },
      'Locker': { strict: false },
    },
  })]);

  it('fields.phone=false → phone is not evaluated', async () => {
    const { app } = makeApp({}, {}, remote);
    const body = (form: string) => ({ email: 'max@beispiel-gmbh.de', phone: '123', token: tok(), mode: 'submit', context: { site: 'demo', form } });
    const off = await (await post(app, '/v1/validate', body('Newsletter Subscription'), H)).json() as any;
    expect(off.phone).toBeNull();
    expect(off.reject_reason).toBeNull();
    expect(off.decision).toBe('accept');
    const on = await (await post(app, '/v1/validate', body('Kontaktformular'), H)).json() as any;
    expect(on.reject_reason).toBe('phone_invalid');
  });

  it('fields.email=false → e-mail is not evaluated', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ strict: true }, [remoteSite({ forms: { 'Nur Telefon': { fields: { email: false, phone: true } } } })]));
    const j = await (await post(app, '/v1/validate', { email: 'x@mailinator.com', phone: '0171 2345678', token: tok(), mode: 'submit', context: { site: 'demo', form: 'Nur Telefon' } }, H)).json() as any;
    expect(j.email).toBeNull();
    expect(j.decision).toBe('accept');
  });

  it('enabled=false → accept without any check', async () => {
    const { app } = makeApp({}, {}, remote);
    const j = await (await post(app, '/v1/validate', { email: 'x@mailinator.com', honeypot: 'spam', mode: 'submit', context: { site: 'demo', form: 'Site Audit' } }, H)).json() as any;
    expect(j).toMatchObject({ decision: 'accept', reject_reason: null, score: 0, email: null, phone: null });
    expect(j.flags).toEqual([]);
  });

  it('per-form strict override loosens a strict site', async () => {
    const { app } = makeApp({}, {}, remote);
    const strict = await (await post(app, '/v1/validate', { phone: '123', token: tok(), mode: 'submit', context: { site: 'demo', form: 'Kontaktformular' } }, H)).json() as any;
    expect(strict.reject_reason).toBe('phone_invalid');
    const loose = await (await post(app, '/v1/validate', { phone: '123', token: tok(), mode: 'submit', context: { site: 'demo', form: 'Locker' } }, H)).json() as any;
    expect(loose.reject_reason).toBeNull();
    expect(loose.decision).toBe('accept_flagged');
  });

  it('site-level rate_limit_hard beats the env default', async () => {
    const { app } = makeApp({ RL_SUBMIT_IP_10M: '1' }, {}, remoteConfig({ rate_limit_hard: false }, [remoteSite({ rate_limit_hard: true })]));
    const hdr = { origin: ORIGIN, 'x-forwarded-for': '7.7.7.7' };
    await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', mode: 'submit', context: { site: 'demo' } }, hdr);
    const j = await (await post(app, '/v1/validate', { email: 'b@beispiel-gmbh.de', mode: 'submit', context: { site: 'demo' } }, hdr)).json() as any;
    expect(j.reject_reason).toBe('rate_limited');
  });

  it('/v1/phone honours strict and the form rule', async () => {
    const { app } = makeApp({}, {}, remote);
    const bad = await (await post(app, '/v1/phone', { phone: '123', site: 'demo', form: 'Kontaktformular' }, H)).json() as any;
    expect(bad.reject_reason).toBe('phone_invalid');
    const off = await (await post(app, '/v1/phone', { phone: '123', site: 'demo', form: 'Newsletter Subscription' }, H)).json() as any;
    expect(off.reject_reason).toBeNull();
    expect(off.decision_hint).toBe('accept');
  });
});

describe('origins come from the runtime config', () => {
  it('an origin of a remote config site is allowed even when ALLOWED_ORIGINS does not list it', async () => {
    const remote = remoteConfig({}, [remoteSite(), remoteSite({ slug: 'kunde2', origins: ['https://kunde2.de'], webflow_site_id: null })]);
    const { app } = makeApp({}, {}, remote);
    const r = await post(app, '/v1/phone', { phone: '0211 12345678' }, { origin: 'https://kunde2.de' });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://kunde2.de');
    expect((await post(app, '/v1/phone', { phone: '0211 12345678' }, { origin: 'https://evil.example' })).status).toBe(403);
    const pre = await app.request('/v1/validate', { method: 'OPTIONS', headers: { origin: 'https://kunde2.de' } });
    expect(pre.status).toBe(204);
  });

  it('an inactive site does not open its origins', async () => {
    const { app } = makeApp({}, {}, remoteConfig({}, [remoteSite({ slug: 'aus', active: false, origins: ['https://aus.de'], webflow_site_id: null })]));
    expect((await post(app, '/v1/phone', { phone: '0211 12345678' }, { origin: 'https://aus.de' })).status).toBe(403);
  });

  it('the site is derived from the Origin when the body carries none', async () => {
    const { sent, events, app } = withEvents(remoteConfig({}, [remoteSite({ slug: 'kunde2', origins: ['https://kunde2.de'], webflow_site_id: null })]));
    await post(app, '/v1/validate', { email: 'x@mailinator.com', mode: 'submit' }, { origin: 'https://kunde2.de' });
    await events.flushNow();
    expect(sent[0].site).toBe('kunde2');
  });
});

describe('decision events', () => {
  it('carries site/form/decision/blocked and no PII', async () => {
    const { app, events, sent } = withEvents(remoteConfig({ mode: 'enforce' }));
    await post(app, '/v1/validate', { email: 'x@mailinator.com', phone: '0171 2345678', token: tok(), mode: 'submit', context: { site: 'demo', form: 'Kontaktformular' } }, H);
    await events.flushNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      site: 'demo', form: 'Kontaktformular', mode: 'submit', decision: 'reject', reason: 'email_disposable',
      email_domain_class: 'disposable', email_tld: 'com', phone_type: 'mobile', phone_country: 'DE', token: 'ok', blocked: true,
    });
    expect(JSON.stringify(sent[0])).not.toContain('mailinator.com');
    expect(JSON.stringify(sent[0])).not.toContain('2345678');
  });

  it('blocked=false in observe mode (unknown site under the remote config), true with the env fallback', async () => {
    const remote = withEvents(remoteConfig({ mode: 'enforce' }));
    await post(remote.app, '/v1/validate', { email: 'x@mailinator.com', token: tok(), mode: 'submit', context: { site: 'fremd' } }, H);
    await remote.events.flushNow();
    expect(remote.sent[0]).toMatchObject({ site: 'fremd', decision: 'reject', blocked: false });

    const env = withEvents(undefined, { EMBED_MODE: 'enforce' });
    await post(env.app, '/v1/validate', { email: 'x@mailinator.com', token: tok(), mode: 'submit', context: { site: 'fremd' } }, H);
    await env.events.flushNow();
    expect(env.sent[0]).toMatchObject({ site: 'fremd', decision: 'reject', blocked: true });
  });

  it('field checks only report rejects/flags', async () => {
    const { app, events, sent } = withEvents(remoteConfig());
    await post(app, '/v1/email', { email: 'max@beispiel-gmbh.de', site: 'demo' }, H); // clean → silent
    await post(app, '/v1/phone', { phone: '0211 12345678', site: 'demo' }, H); // fixed_line flag → flagged
    await post(app, '/v1/email', { email: 'k.mueller@gmial.com', site: 'demo' }, H); // typo → flagged
    await events.flushNow();
    expect(sent.map((e) => e.mode)).toEqual(['field', 'field']);
    expect(sent.map((e) => e.decision)).toEqual(['accept_flagged', 'accept_flagged']);
  });

  it('the webhook reports mode webhook with the form name', async () => {
    const { app, events, sent } = withEvents(remoteConfig());
    const body = { triggerType: 'form_submission', payload: { id: 'ev1', name: 'Kontaktformular', siteId: '0123456789abcdef01234567', submittedAt: new Date().toISOString(), data: { 'E-Mail': 'x@mailinator.com' } } };
    await app.request('/v1/hooks/webflow?site=demo&k=hook-secret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await events.flushNow();
    expect(sent[0]).toMatchObject({ mode: 'webhook', site: 'demo', form: 'Kontaktformular', decision: 'reject', blocked: false });
  });
});

describe('webhook honours the remote site config', () => {
  const hook = (app: any, body: unknown, q = '?site=demo&k=hook-secret') =>
    app.request('/v1/hooks/webflow' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = (data: Record<string, unknown>, name = 'Kontaktformular', id = 'w1') =>
    ({ triggerType: 'form_submission', payload: { id, name, siteId: '0123456789abcdef01234567', submittedAt: new Date().toISOString(), data } });

  function forwardMock() {
    const calls: any[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, lead_id: 'deal_9' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('forward=false → validate only, forward=true → forward with the env token', async () => {
    const off = forwardMock();
    const a = makeApp({}, { fetchImpl: off.fetchImpl }, remoteConfig({}, [remoteSite({ forward: false })]));
    const ja = await (await hook(a.app, payload({ 'E-Mail': 'max@beispiel-gmbh.de' }))).json() as any;
    expect(ja).toMatchObject({ forwarded: false, forward: 'disabled' });
    expect(off.calls).toHaveLength(0);

    const on = forwardMock();
    const b = makeApp({}, { fetchImpl: on.fetchImpl }, remoteConfig({}, [remoteSite({ forward: true })]));
    const jb = await (await hook(b.app, payload({ 'E-Mail': 'max@beispiel-gmbh.de' }, 'Kontaktformular', 'w2'))).json() as any;
    expect(jb).toMatchObject({ forwarded: true, lead_id: 'deal_9' });
    expect(on.calls).toHaveLength(1);
  });

  it('honeypot name and per-form rule come from the config', async () => {
    const { fetchImpl } = forwardMock();
    const { app } = makeApp({}, { fetchImpl }, remoteConfig({}, [remoteSite({
      honeypot: 'firma_url', forms: { 'Site Audit': { enabled: false } },
    })]));
    const hp = await (await hook(app, payload({ 'E-Mail': 'a@beispiel-gmbh.de', firma_url: 'http://spam' }, 'Kontaktformular', 'w3'))).json() as any;
    expect(hp.decision).toBe('reject');
    const skipped = await (await hook(app, payload({ 'E-Mail': 'x@mailinator.com' }, 'Site Audit', 'w4'))).json() as any;
    expect(skipped.decision).toBe('accept');
  });
});

describe('admin routes', () => {
  it('POST /v1/admin/reload needs the api key and reports version/source/sites', async () => {
    const { app } = makeApp({}, {}, remoteConfig());
    expect((await app.request('/v1/admin/reload', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/admin/reload', { method: 'POST', headers: { 'x-api-key': 'nope' } })).status).toBe(401);
    expect((await app.request('/v1/admin/reload', { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(401);
    const r = await app.request('/v1/admin/reload', { method: 'POST', headers: KEY });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ version: 'v-test-1', source: 'remote', sites: 1 });
  });

  it('GET /v1/admin/config shows the effective config without secrets', async () => {
    const { app } = makeApp({}, {}, remoteConfig({}, [remoteSite({ forward: true })]));
    expect((await app.request('/v1/admin/config')).status).toBe(401);
    const j = await (await app.request('/v1/admin/config', { headers: KEY })).json() as any;
    expect(j).toMatchObject({ source: 'remote', version: 'v-test-1' });
    expect(j.global.messages).toEqual(MESSAGES);
    expect(j.allowed_origins).toContain('https://example.com');
    expect(j.sites[0]).toMatchObject({ slug: 'demo', active: true, forward: true, forward_ready: true });
    const raw = JSON.stringify(j);
    expect(raw).not.toContain('PUB_demo_test');
    expect(raw).not.toContain('key-srv-123');
    expect(raw).not.toContain(baseEnv.TOKEN_SECRET);
  });
});

describe('/health', () => {
  it('reports config source/version/sites, event stats and the field-check counter (with key)', async () => {
    const { app, events } = withEvents(remoteConfig({ mode: 'enforce' }));
    await post(app, '/v1/email', { email: 'k.mueller@gmial.com', site: 'demo' }, H);
    await post(app, '/v1/phone', { phone: '0211 12345678', site: 'demo' }, H);
    const j = await (await app.request('/health', { headers: KEY })).json() as any;
    expect(j.config).toMatchObject({ source: 'remote', version: 'v-test-1', sites: 1 });
    expect(j.config.fetched_at).toBeTruthy();
    expect(j.embed_mode).toBe('enforce');
    expect(j.field_checks).toBe(2);
    expect(j.events.buffered).toBeGreaterThan(0);
    await events.flushNow();
    expect((await (await app.request('/health', { headers: KEY })).json() as any).events).toMatchObject({ buffered: 0, sent: 2, dropped: 0, failed: 0 });
  });

  it('env fallback shows source env (with key)', async () => {
    const { app } = makeApp({ EMBED_MODE: 'observe' });
    const j = await (await app.request('/health', { headers: KEY })).json() as any;
    expect(j.config).toMatchObject({ source: 'env', version: 'env', fetched_at: null, sites: 1 });
    expect(j.events).toEqual({ buffered: 0, sent: 0, dropped: 0, failed: 0 });
  });

  it('without a key only ok/version/uptime_s — no config/events/queue/provider', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ mode: 'enforce' }));
    const r = await app.request('/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json() as any;
    expect(Object.keys(j).sort()).toEqual(['ok', 'uptime_s', 'version']);
    expect(j.ok).toBe(true);
    expect(typeof j.version).toBe('string');
    expect(typeof j.uptime_s).toBe('number');
    for (const k of ['config', 'events', 'queue', 'provider', 'deep_reachable', 'embed_mode', 'strict', 'field_checks']) {
      expect(j[k]).toBeUndefined();
    }
  });

  it('valid key → full diagnostics body', async () => {
    const { app } = makeApp({}, {}, remoteConfig({ mode: 'enforce' }));
    const r = await app.request('/health', { headers: KEY });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, provider: 'none', deep_reachable: null, embed_mode: 'enforce', strict: true, field_checks: 0, queue: null });
    expect(j.config).toMatchObject({ source: 'remote', version: 'v-test-1', sites: 1 });
    expect(j.events).toEqual({ buffered: 0, sent: 0, dropped: 0, failed: 0 });
  });

  it('wrong key is treated like no key: 200 + minimal, never 401', async () => {
    const { app } = makeApp({}, {}, remoteConfig());
    const r = await app.request('/health', { headers: { 'x-api-key': 'nope' } });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(Object.keys(j).sort()).toEqual(['ok', 'uptime_s', 'version']);
    expect(JSON.stringify(j)).not.toContain('v-test-1');
  });
});
