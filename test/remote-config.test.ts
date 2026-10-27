import { describe, expect, it } from 'vitest';
import { effective } from '../src/core/effective.js';
import { loadConfig } from '../src/server/config.js';
import { RemoteConfigLoader } from '../src/server/remote-config.js';
import { baseEnv, remoteConfig, remoteSite } from './helpers.js';

const CONFIG_URL = 'https://control.test/api/lead-validate/config';

type Call = { url: string; headers: Record<string, string> };

type Responder = (init?: RequestInit) => Response | Promise<Response>;

function loader(responses: Responder[], env: NodeJS.ProcessEnv = {}) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r(init);
  }) as unknown as typeof fetch;
  const cfg = loadConfig({ ...baseEnv, CONFIG_URL: CONFIG_URL, ...env });
  return { calls, l: new RemoteConfigLoader(cfg, { fetchImpl, timeoutMs: 50 }) };
}

const ok = (body: unknown, etag = '"v-test-1"'): Responder =>
  () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag } });

/** like real fetch: pending until the AbortController fires */
const hangs: Responder = (init) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new Error('AbortError: The operation was aborted')));
});

describe('RemoteConfigLoader', () => {
  it('env fallback before the first fetch', () => {
    const { l } = loader([ok(remoteConfig())]);
    const rt = l.get();
    expect(rt.source).toBe('env');
    expect(rt.sites.get('demo')?.forward_token).toBe('PUB_demo_test');
    expect(l.configured).toBe(true);
  });

  it('200 → remote config, sends X-Api-Key, then If-None-Match; 304 keeps it', async () => {
    const { calls, l } = loader([
      ok(remoteConfig({ mode: 'observe' })),
      () => new Response(null, { status: 304 }),
    ]);
    const first = await l.reload();
    expect(first).toMatchObject({ ok: true, status: 200, changed: true, source: 'remote', version: 'v-test-1', sites: 1 });
    expect(calls[0].url).toBe(CONFIG_URL);
    expect(calls[0].headers['x-api-key']).toBe('control-key');
    expect(calls[0].headers['if-none-match']).toBeUndefined();
    expect(l.get().global.mode).toBe('observe');
    const before = l.get().fetched_at;
    expect(before).toBeTruthy();

    const second = await l.reload();
    expect(second).toMatchObject({ ok: true, status: 304, changed: false, version: 'v-test-1' });
    expect(calls[1].headers['if-none-match']).toBe('"v-test-1"');
    expect(l.get().source).toBe('remote');
    expect(l.get().global.mode).toBe('observe');
  });

  it('500, 401, network error and timeout keep the last good config', async () => {
    const { l } = loader([
      ok(remoteConfig({ mode: 'observe' })),
      () => new Response('boom', { status: 500 }),
      () => new Response('nope', { status: 401 }),
      () => Promise.reject(new Error('ECONNRESET')),
      hangs,
    ]);
    await l.reload();
    expect(l.get().version).toBe('v-test-1');
    for (const expected of ['http_500', 'http_401', 'Error: ECONNRESET']) {
      const r = await l.reload();
      expect(r.ok).toBe(false);
      expect(r.error).toContain(expected.split(':')[0]);
      expect(l.get().source).toBe('remote');
      expect(l.get().global.mode).toBe('observe');
    }
    const t = await l.reload();
    expect(t.ok).toBe(false);
    expect(l.get().version).toBe('v-test-1'); // timeout → last good stays
  });

  it('invalid JSON and invalid config are discarded, env fallback survives', async () => {
    const { l } = loader([
      () => new Response('{nope', { status: 200 }),
      () => new Response(JSON.stringify(remoteConfig({ mode: 'kaputt' })), { status: 200 }),
    ]);
    expect((await l.reload()).error).toBe('invalid_config');
    expect(l.get().source).toBe('env');
    expect((await l.reload()).error).toBe('invalid_config');
    expect(l.get().source).toBe('env');
  });

  it('a later good fetch replaces the previous version', async () => {
    const { l } = loader([
      ok(remoteConfig({ mode: 'observe' })),
      ok({ ...remoteConfig({ mode: 'enforce' }), version: 'v-test-2' }, '"v-test-2"'),
    ]);
    await l.reload();
    const r = await l.reload();
    expect(r).toMatchObject({ ok: true, changed: true, version: 'v-test-2' });
    expect(l.get().global.mode).toBe('enforce');
  });

  it('merges SITES_JSON secrets and keeps env site_id/honeypot as a fallback', async () => {
    const { l } = loader([ok(remoteConfig({}, [remoteSite({ webflow_site_id: null, honeypot: null })]))]);
    await l.reload();
    const site = l.get().sites.get('demo')!;
    expect(site.forward_token).toBe('PUB_demo_test');
    expect(site.forward_origin).toBe('https://example.com');
    expect(site.webflow_site_id).toBe('0123456789abcdef01234567');
    expect(effective(l.get(), 'demo', null).honeypot).toBe('company_url_confirm');
  });

  it('without CONFIG_URL it never calls out and stays on env', async () => {
    const { calls, l } = loader([ok(remoteConfig())], { CONFIG_URL: '' });
    expect(l.configured).toBe(false);
    const r = await l.reload();
    expect(r).toMatchObject({ ok: false, error: 'not_configured', source: 'env' });
    l.start();
    expect(calls).toHaveLength(0);
    l.stop();
  });

  it('start() fetches once and polls unref\'d; stop() ends it', async () => {
    const { calls, l } = loader([ok(remoteConfig())], { CONFIG_POLL_S: '1' });
    l.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    l.stop();
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(n);
  });
});
