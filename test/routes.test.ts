import { describe, expect, it } from 'vitest';
import { mintToken } from '../src/core/token.js';
import { makeApp, ORIGIN, post, baseEnv } from './helpers.js';

describe('auth matrix + CORS', () => {
  const { app } = makeApp();
  it('browser with whitelisted Origin → 200 + CORS echo, never *', async () => {
    const r = await post(app, '/v1/phone', { phone: '0211 12345678' }, { origin: ORIGIN });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(r.headers.get('vary')).toBe('Origin');
  });
  it('wildcard origin https://*.webflow.io', async () => {
    const r = await post(app, '/v1/phone', { phone: '0211 12345678' }, { origin: 'https://your-site.webflow.io' });
    expect(r.status).toBe(200);
  });
  it('foreign Origin → 403, no ACAO', async () => {
    const r = await post(app, '/v1/phone', { phone: '0211' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('no Origin, no key → 403; bad key → 401; good key → 200', async () => {
    expect((await post(app, '/v1/phone', { phone: '0211' })).status).toBe(403);
    expect((await post(app, '/v1/phone', { phone: '0211' }, { 'x-api-key': 'nope' })).status).toBe(401);
    expect((await post(app, '/v1/phone', { phone: '0211 12345678' }, { 'x-api-key': 'key-srv-123' })).status).toBe(200);
  });
  it('preflight 204 for allowed, 403 otherwise', async () => {
    const ok = await app.request('/v1/validate', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('X-Api-Key');
    const bad = await app.request('/v1/validate', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });
  it('413 on big body, 400 on bad JSON', async () => {
    expect((await post(app, '/v1/phone', 'x'.repeat(17 * 1024), { origin: ORIGIN })).status).toBe(413);
    expect((await post(app, '/v1/phone', '{nope', { origin: ORIGIN })).status).toBe(400);
  });
  it('abuse limit → 429 with Retry-After', async () => {
    const { app: a } = makeApp({ RL_IP_PER_MIN: '3' });
    for (let i = 0; i < 3; i++) expect((await post(a, '/v1/phone', { phone: '0211 12345678' }, { origin: ORIGIN, 'x-forwarded-for': '1.2.3.4' })).status).toBe(200);
    const r = await post(a, '/v1/phone', { phone: '0211 12345678' }, { origin: ORIGIN, 'x-forwarded-for': '1.2.3.4' });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    // different IP is unaffected
    expect((await post(a, '/v1/phone', { phone: '0211 12345678' }, { origin: ORIGIN, 'x-forwarded-for': '5.6.7.8' })).status).toBe(200);
  });
  it('health is public and unrate-limited; unknown path 404', async () => {
    const h = await app.request('/health');
    expect(h.status).toBe(200);
    expect((await h.json() as { ok: boolean }).ok).toBe(true);
    expect((await app.request('/nope')).status).toBe(404);
  });
  it('CANONICAL_FROM_SUFFIX host → 301 canonical, except /health', async () => {
    const { app: a } = makeApp({ CANONICAL_HOST: 'validate.example.com', CANONICAL_FROM_SUFFIX: '.up.platform.test' });
    const r = await a.request('http://x.up.platform.test/v1/token?site=demo', { headers: { host: 'x.up.platform.test' } });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://validate.example.com/v1/token?site=demo');
    expect((await a.request('http://x.up.platform.test/health', { headers: { host: 'x.up.platform.test' } })).status).toBe(200);
  });
});

describe('/v1/token', () => {
  const { app } = makeApp({ EMBED_MODE: 'enforce' });
  it('mints a site-bound token and reports the server mode', async () => {
    const r = await app.request('/v1/token?site=demo', { headers: { origin: ORIGIN } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json() as { token: string; ttl_s: number; mode: string; site: string };
    expect(j.token.startsWith('v1.demo.')).toBe(true);
    expect(j.mode).toBe('enforce');
    expect(j.ttl_s).toBe(21600);
  });
  it('requires Origin or key', async () => {
    expect((await app.request('/v1/token')).status).toBe(403);
  });
});

describe('/v1/email + /v1/validate via HTTP', () => {
  const { app } = makeApp();
  const H = { origin: ORIGIN };
  it('gmial.com → suggestion, accept_flagged', async () => {
    const j = await (await post(app, '/v1/email', { email: 'k.mueller@gmial.com' }, H)).json() as any;
    expect(j.suggestion).toBe('k.mueller@gmail.com');
    expect(j.decision_hint).toBe('accept_flagged');
    expect(j.verdict).toBe('unknown');
  });
  it('mailinator → reject/email_disposable (HTTP 200!)', async () => {
    const r = await post(app, '/v1/validate', { email: 'test@mailinator.com', mode: 'submit' }, H);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.decision).toBe('reject');
    expect(j.reject_reason).toBe('email_disposable');
  });
  it('no MX → reject/email_no_mx; role account passes flagged', async () => {
    expect((await (await post(app, '/v1/validate', { email: 'xyz@domain-ohne-mx.de' }, H)).json() as any).reject_reason).toBe('email_no_mx');
    const j = await (await post(app, '/v1/validate', { email: 'info@existierende-gmbh.de', phone: '0211 4870519' }, H)).json() as any;
    expect(j.decision).toBe('accept_flagged');
    expect(j.flags).toEqual(['role_account']);
    expect(j.phone.e164).toBe('+492114870519');
    expect(j.email.normalized).toBe('info@existierende-gmbh.de');
  });
  it('second call for the same address is served from cache (no resolver call)', async () => {
    let calls = 0;
    const { app: a } = makeApp({}, { resolveMx: async () => { calls++; return { status: 'mx', hosts: ['mx.x'] }; } });
    await post(a, '/v1/email', { email: 'Max@Beispiel-GmbH.de' }, H);
    const j = await (await post(a, '/v1/email', { email: 'max@beispiel-gmbh.de ' }, H)).json() as any;
    expect(calls).toBe(1);
    expect(j.cached).toBe(true);
  });
  it('honeypot filled → reject; autofill valve → flag', async () => {
    const j = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', honeypot: 'http://bot.example', mode: 'submit' }, H)).json() as any;
    expect(j.reject_reason).toBe('honeypot');
    const j2 = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', honeypot: 'Muster GmbH', context: { company: 'muster gmbh' }, mode: 'submit' }, H)).json() as any;
    expect(j2.decision).toBe('accept_flagged');
    expect(j2.flags).toContain('honeypot_autofill_suspect');
  });
  it('token: submit after 800 ms rejects (server), field mode only flags; missing token flags +30', async () => {
    const now = Date.now();
    const fast = mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, now - 800);
    const j = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', token: fast, mode: 'submit', context: { site: 'demo' } }, H)).json() as any;
    expect(j.reject_reason).toBe('too_fast');
    const f = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', token: fast, mode: 'field', context: { site: 'demo' } }, H)).json() as any;
    expect(f.decision).toBe('accept_flagged');
    expect(f.flags).toContain('token_too_fast');
    const ok = mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, now - 10_000);
    const g = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', phone: '0171 8765432', token: ok, mode: 'submit', context: { site: 'demo' } }, H)).json() as any;
    expect(g.decision).toBe('accept');
    expect(g.bot.token).toBe('ok');
    const m = await (await post(app, '/v1/validate', { email: 'a@beispiel-gmbh.de', mode: 'submit' }, H)).json() as any;
    expect(m.flags).toContain('token_missing');
    expect(m.score).toBe(30);
  });
  it('phone dup within 24h flags at submit; premium rate rejects', async () => {
    const { app: a } = makeApp();
    await post(a, '/v1/validate', { phone: '0171 9999888', mode: 'submit' }, H);
    const j = await (await post(a, '/v1/validate', { phone: '+49 171 9999888', mode: 'submit' }, H)).json() as any;
    expect(j.flags).toContain('phone_dup_24h');
    expect((await (await post(a, '/v1/validate', { phone: '0900 1234567', mode: 'submit' }, H)).json() as any).reject_reason).toBe('phone_premium_rate');
  });
  it('submission limits: 6th submit in 10 min from one IP → rate_limited flag (no reject by default)', async () => {
    const { app: a } = makeApp({ RL_SUBMIT_IP_10M: '2' });
    const hdr = { origin: ORIGIN, 'x-forwarded-for': '9.9.9.9' };
    await post(a, '/v1/validate', { email: 'a@beispiel-gmbh.de', mode: 'submit' }, hdr);
    await post(a, '/v1/validate', { email: 'b@beispiel-gmbh.de', mode: 'submit' }, hdr);
    const j = await (await post(a, '/v1/validate', { email: 'c@beispiel-gmbh.de', mode: 'submit' }, hdr)).json() as any;
    expect(j.bot.rate_limited).toBe(true);
    expect(j.decision).toBe('accept_flagged');
    const { app: b } = makeApp({ RL_SUBMIT_IP_10M: '1', RATE_LIMIT_HARD: 'true' });
    await post(b, '/v1/validate', { email: 'a@beispiel-gmbh.de', mode: 'submit' }, hdr);
    expect((await (await post(b, '/v1/validate', { email: 'b@beispiel-gmbh.de', mode: 'submit' }, hdr)).json() as any).reject_reason).toBe('rate_limited');
  });
  it('fail-open: internal exception → HTTP 200 accept/degraded', async () => {
    const built = makeApp();
    (built.svc.phoneDup as any).get = () => { throw new Error('boom'); };
    const r = await post(built.app, '/v1/validate', { email: 'a@beispiel-gmbh.de', phone: '0171 2345678', mode: 'submit' }, H);
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.decision).toBe('accept');
    expect(j.degraded).toBe(true);
    expect(j.email.verdict).toBe('unknown');
  });
  it('deep:true is only honoured for API-key callers and a configured provider', async () => {
    let deepCalls = 0;
    const provider = { name: 'aftership' as const, async checkDeep() { deepCalls++; return { verdict: 'valid' as const, flags: [], provider: 'aftership' as const, latency_ms: 5 }; }, async health() { return true; } };
    const { app: a } = makeApp({ EMAIL_VERIFIER_PROVIDER: 'aftership', DEEP_VERIFIER_URL: 'http://deep.test' }, { provider });
    await post(a, '/v1/validate', { email: 'x@beispiel-gmbh.de', deep: true }, H); // browser → ignored
    expect(deepCalls).toBe(0);
    const j = await (await post(a, '/v1/validate', { email: 'x@beispiel-gmbh.de', deep: true }, { 'x-api-key': 'key-srv-123' })).json() as any;
    expect(deepCalls).toBe(1);
    expect(j.email.verdict).toBe('valid');
    expect(j.email.provider).toBe('aftership');
    // fast path never calls the deep provider
    await post(a, '/v1/email', { email: 'y@beispiel-gmbh.de' }, H);
    expect(deepCalls).toBe(1);
  });
});
