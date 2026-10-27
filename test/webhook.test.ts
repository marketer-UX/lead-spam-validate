import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintToken } from '../src/core/token.js';
import { makeApp, baseEnv } from './helpers.js';

type Captured = { url: string; init: RequestInit; body: any };

function forwardMock(status = 201, lead = 'deal_1') {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (status >= 500) return new Response('nope', { status });
    if (status === 403) return new Response(JSON.stringify({ ok: false, error: 'origin_not_whitelisted' }), { status: 403 });
    return new Response(JSON.stringify({ ok: true, lead_id: lead, status: 'received' }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SUBMITTED = '2026-08-23T10:00:30.000Z';
function payload(data: Record<string, unknown>, id = 'sub_1') {
  return { triggerType: 'form_submission', payload: { id, name: 'Download Form', siteId: '0123456789abcdef01234567', formId: 'f1', submittedAt: SUBMITTED, data } };
}
const goodToken = () => mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, Date.parse(SUBMITTED) - 20_000);

function send(app: any, body: unknown, q = '?site=demo&k=hook-secret', headers: Record<string, string> = {}) {
  return app.request('/v1/hooks/webflow' + q, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('Webflow webhook', () => {
  it('rejects without auth; accepts fallback secret; accepts valid HMAC signature', async () => {
    const { fetchImpl } = forwardMock();
    const { app } = makeApp({}, { fetchImpl });
    const p = payload({ 'E-Mail': 'max@beispiel-gmbh.de', 'Name': 'Max' });
    expect((await send(app, p, '?site=demo')).status).toBe(401);
    expect((await send(app, p, '?site=demo&k=wrong')).status).toBe(401);
    expect((await send(app, p)).status).toBe(200);
    const raw = JSON.stringify(payload({ 'E-Mail': 'max@beispiel-gmbh.de' }, 'sub_sig'));
    const ts = String(Date.now());
    const sig = createHmac('sha256', 'wf-secret').update(`${ts}:${raw}`).digest('hex');
    expect((await send(app, raw, '?site=demo', { 'x-webflow-signature': sig, 'x-webflow-timestamp': ts })).status).toBe(200);
    expect((await send(app, raw, '?site=demo', { 'x-webflow-signature': 'deadbeef', 'x-webflow-timestamp': ts })).status).toBe(401);
    const old = String(Date.now() - 10 * 60_000);
    const sigOld = createHmac('sha256', 'wf-secret').update(`${old}:${raw}`).digest('hex');
    expect((await send(app, raw, '?site=demo', { 'x-webflow-signature': sigOld, 'x-webflow-timestamp': old })).status).toBe(401);
  });

  it('maps display names, replaces phone by E.164, strips hidden/honeypot fields, adds flat _validation, forwards with token+origin', async () => {
    const { calls, fetchImpl } = forwardMock();
    const { app } = makeApp({}, { fetchImpl });
    const r = await send(app, payload({
      'Name': 'Max Muster', 'Firma': 'Muster GmbH', 'E-Mail': 'k.mueller@gmial.com', 'Telefonnummer': '+49 (0)211 12345678',
      'Einwilligung-zur-Datenschutzerkl-rung': 'on', 'company_url_confirm': '', 'lv_vt': goodToken(), 'lv_vs': 'v1;i=1;wd=0;pl=900',
      'email_verdict': 'unknown', 'email_flags': 'typo_suspected', 'phone_e164': '+4921112345678', 'lead_risk_score': '10', 'lead_risk_flags': '',
    }));
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ ok: true, forwarded: true, lead_id: 'deal_1', decision: 'accept_flagged' });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://leads.example.test/api/leads/intake');
    const h = c.init.headers as Record<string, string>;
    expect(h['x-source-token']).toBe('PUB_demo_test');
    expect(h['origin']).toBe('https://example.com');
    expect(c.body['Name']).toBe('Max Muster');
    expect(c.body['E-Mail']).toBe('k.mueller@gmial.com');
    expect(c.body.phone).toBe('+4921112345678');
    expect(c.body['Telefonnummer']).toBeUndefined();
    for (const k of ['company_url_confirm', 'lv_vt', 'lv_vs', 'email_verdict', 'email_flags', 'phone_e164', 'lead_risk_score', 'lead_risk_flags']) expect(c.body[k]).toBeUndefined();
    expect(c.body._meta).toMatchObject({ source: 'webflow-webhook', form: 'Download Form', submitted_at: SUBMITTED, webflow_submission_id: 'sub_1', site: 'demo' });
    const v = c.body._validation;
    expect(v).toMatchObject({ v: 1, decision: 'accept_flagged', email_verdict: 'unknown', email_suggestion: 'k.mueller@gmail.com', phone_e164: '+4921112345678', phone_type: 'fixed_line', token: 'ok' });
    expect(v.flags).toContain('typo_suspected');
    // flat: no nested objects
    for (const val of Object.values(v)) expect(val === null || typeof val !== 'object' || Array.isArray(val)).toBe(true);
  });

  it('site without forward_token → validated + logged, NOT forwarded (forms already push to the lead store client-side)', async () => {
    const { calls, fetchImpl } = forwardMock();
    const sites = JSON.stringify({ demo: { site_id: '0123456789abcdef01234567', honeypot: 'company_url_confirm', forward_token: '', forward_origin: 'https://example.com' } });
    const { app } = makeApp({ SITES_JSON: sites }, { fetchImpl });
    const j = await (await send(app, payload({ 'E-Mail': 'max@beispiel-gmbh.de', 'Telefonnummer': '0171 2345678' }, 'nofwd'))).json() as any;
    expect(j).toMatchObject({ ok: true, forwarded: false, forward: 'disabled', decision: 'accept_flagged' }); // token_missing → flagged
    expect(calls).toHaveLength(0);
    expect((await (await send(app, payload({ 'E-Mail': 'max@beispiel-gmbh.de' }, 'nofwd'))).json() as any).duplicate).toBe(true);
  });

  it('idempotent on submission id', async () => {
    const { calls, fetchImpl } = forwardMock();
    const { app } = makeApp({}, { fetchImpl });
    const p = payload({ 'E-Mail': 'max@beispiel-gmbh.de' }, 'dup_1');
    await send(app, p);
    const j = await (await send(app, p)).json() as any;
    expect(j.duplicate).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('observe mode forwards rejects annotated; enforce mode drops them (honeypot, too_fast, disposable)', async () => {
    const hp = payload({ 'E-Mail': 'max@beispiel-gmbh.de', 'company_url_confirm': 'http://spam' }, 'hp');
    const fast = payload({ 'E-Mail': 'max@beispiel-gmbh.de', 'lv_vt': mintToken('demo', { current: baseEnv.TOKEN_SECRET! }, Date.parse(SUBMITTED) - 800) }, 'fast');
    const disp = payload({ 'E-Mail': 'x@mailinator.com' }, 'disp');
    {
      const { calls, fetchImpl } = forwardMock();
      const { app } = makeApp({ WEBHOOK_ENFORCE: 'false' }, { fetchImpl });
      await send(app, hp); await send(app, fast); await send(app, disp);
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.body._validation.reject_reason)).toEqual(['honeypot', 'too_fast', 'email_disposable']);
    }
    {
      const { calls, fetchImpl } = forwardMock();
      const { app } = makeApp({ WEBHOOK_ENFORCE: 'true' }, { fetchImpl });
      const a = await (await send(app, hp)).json() as any;
      const b = await (await send(app, fast)).json() as any;
      const c = await (await send(app, disp)).json() as any;
      expect([a.reason, b.reason, c.reason]).toEqual(['honeypot', 'too_fast', 'email_disposable']);
      expect(calls).toHaveLength(0);
    }
  });

  it('site mismatch → 403; non form events ignored; legacy v1 payload shape accepted', async () => {
    const { calls, fetchImpl } = forwardMock();
    const { app } = makeApp({}, { fetchImpl });
    const wrong = { triggerType: 'form_submission', payload: { id: 'w', name: 'X', siteId: 'other', submittedAt: SUBMITTED, data: { 'E-Mail': 'a@beispiel-gmbh.de' } } };
    expect((await send(app, wrong)).status).toBe(403);
    expect((await (await send(app, { triggerType: 'site_publish', payload: {} })).json() as any).ignored).toBe('site_publish');
    const legacy = { name: 'Kontaktformular', site: '0123456789abcdef01234567', d: SUBMITTED, _id: 'legacy1', data: { 'E-Mail': 'a@beispiel-gmbh.de', 'Telefon': '0171 2345678' } };
    const j = await (await send(app, legacy)).json() as any;
    expect(j.forwarded).toBe(true);
    expect(calls.at(-1)!.body.phone).toBe('+491712345678');
  });

  it('lead store 5xx → 503 (Webflow retries, not marked seen); lead store 4xx → 200 not forwarded, marked seen', async () => {
    {
      const { fetchImpl } = forwardMock(503);
      const { app } = makeApp({}, { fetchImpl });
      const p = payload({ 'E-Mail': 'a@beispiel-gmbh.de' }, 'r1');
      expect((await send(app, p)).status).toBe(503);
      expect((await send(app, p)).status).toBe(503); // not deduped
    }
    {
      const { fetchImpl } = forwardMock(403);
      const { app } = makeApp({}, { fetchImpl });
      const p = payload({ 'E-Mail': 'a@beispiel-gmbh.de' }, 'r2');
      const j = await (await send(app, p)).json() as any;
      expect(j).toMatchObject({ ok: false, forwarded: false, error: 'origin_not_whitelisted' });
      expect((await (await send(app, p)).json() as any).duplicate).toBe(true);
    }
  });

  it('own bug → 200 degraded (no retry storm)', async () => {
    const built = makeApp({}, { fetchImpl: forwardMock().fetchImpl });
    (built.svc.phoneDup as any).get = () => { throw new Error('boom'); };
    const r = await send(built.app, payload({ 'E-Mail': 'a@beispiel-gmbh.de', 'Telefon': '0171 2345678' }, 'bug'));
    expect(r.status).toBe(200);
    expect((await r.json() as any).degraded).toBe(true);
  });
});
