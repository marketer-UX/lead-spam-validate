import { describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGES, effective, parseRemoteConfig, type RuntimeConfig } from '../src/core/effective.js';
import { loadConfig } from '../src/server/config.js';
import { envRuntime, RemoteConfigLoader } from '../src/server/remote-config.js';
import { baseEnv, MESSAGES, remoteConfig, remoteSite } from './helpers.js';

function rtOf(remote: unknown, env: NodeJS.ProcessEnv = {}): RuntimeConfig {
  const cfg = loadConfig({ ...baseEnv, ...env });
  const l = new RemoteConfigLoader(cfg);
  if (!l.applyRemote(remote)) throw new Error('fixture rejected');
  return l.get();
}

describe('effective() cascade global → site → form', () => {
  it('inherits from global when site/form say null', () => {
    const rt = rtOf(remoteConfig());
    const e = effective(rt, 'demo', 'Kontaktformular');
    expect(e).toMatchObject({ mode: 'enforce', strict: true, rate_limit_hard: false, country: 'DE', enabled: true, known_site: true });
    expect(e.fields).toEqual({ email: true, phone: true });
    expect(e.messages).toEqual(MESSAGES);
    expect(e.honeypot).toBe('company_url_confirm');
  });

  it('site overrides global, form overrides site', () => {
    const rt = rtOf(remoteConfig({ mode: 'observe', strict: false }, [remoteSite({
      mode: 'enforce', strict: false, country: 'AT', honeypot: 'firma_url', rate_limit_hard: true,
      messages: { email: 'E-Mail falsch', phone: 'Telefon falsch' },
      forms: { 'Quote Request': { mode: 'off', strict: true } },
    })]));
    expect(effective(rt, 'demo', null)).toMatchObject({ mode: 'enforce', strict: false, country: 'AT', honeypot: 'firma_url', rate_limit_hard: true });
    expect(effective(rt, 'demo', null).messages).toEqual({ email: 'E-Mail falsch', phone: 'Telefon falsch' });
    expect(effective(rt, 'demo', 'Quote Request')).toMatchObject({ mode: 'off', strict: true });
    // unknown form falls back to the site rule
    expect(effective(rt, 'demo', 'Andere')).toMatchObject({ mode: 'enforce', strict: false });
  });

  it('form rules: enabled=false → no validation, fields switch single checks off', () => {
    const rt = rtOf(remoteConfig({}, [remoteSite({
      forms: {
        'Site Audit': { enabled: false },
        'Newsletter Subscription': { enabled: true, fields: { email: true, phone: false } },
      },
    })]));
    expect(effective(rt, 'demo', 'Site Audit').enabled).toBe(false);
    const nl = effective(rt, 'demo', 'Newsletter Subscription');
    expect(nl.enabled).toBe(true);
    expect(nl.fields).toEqual({ email: true, phone: false });
  });

  it('site active=false → enabled false and mode off (delivered as-is)', () => {
    const rt = rtOf(remoteConfig({ mode: 'enforce' }, [remoteSite({ active: false })]));
    expect(effective(rt, 'demo', null)).toMatchObject({ enabled: false, mode: 'off', known_site: true });
  });

  it('unknown slug: observe with the remote config as source, env defaults with the env fallback', () => {
    const remote = rtOf(remoteConfig({ mode: 'enforce', strict: true }));
    expect(effective(remote, 'fremd', null)).toMatchObject({ mode: 'observe', strict: true, enabled: true, known_site: false });
    const env = envRuntime(loadConfig({ ...baseEnv, EMBED_MODE: 'enforce', STRICT_CONTACT: 'true' }));
    expect(effective(env, 'fremd', null)).toMatchObject({ mode: 'enforce', strict: true, known_site: false });
  });

  it('env fallback mirrors EMBED_MODE/STRICT_CONTACT/RATE_LIMIT_HARD and SITES_JSON', () => {
    const rt = envRuntime(loadConfig({ ...baseEnv, EMBED_MODE: 'observe', STRICT_CONTACT: 'false', RATE_LIMIT_HARD: 'true' }));
    expect(rt.source).toBe('env');
    expect(rt.version).toBe('env');
    const e = effective(rt, 'demo', null);
    expect(e).toMatchObject({ mode: 'observe', strict: false, rate_limit_hard: true, forward: true, honeypot: 'company_url_confirm' });
    expect(e.forward_token).toBe('PUB_demo_test');
    expect(e.forward_origin).toBe('https://example.com');
    expect(e.messages).toEqual(DEFAULT_MESSAGES);
  });

  it('forward_token/forward_origin come from SITES_JSON, never from the remote config payload', () => {
    const rt = rtOf(remoteConfig({}, [remoteSite({ forward: true, forward_token: 'PUB_from_remote' })]));
    const e = effective(rt, 'demo', null);
    expect(e.forward).toBe(true);
    expect(e.forward_token).toBe('PUB_demo_test'); // env wins, remote value ignored
    expect(rt.sites.get('demo')?.forward_origin).toBe('https://example.com');
  });

  it('allowedOrigins = env ∪ active sites; siteForOrigin resolves exact and wildcard', () => {
    const rt = rtOf(remoteConfig({}, [
      remoteSite({ origins: ['https://example.com', 'https://*.webflow.io'] }),
      remoteSite({ slug: 'kunde2', origins: ['https://kunde2.de'], webflow_site_id: null }),
      remoteSite({ slug: 'inaktiv', active: false, origins: ['https://inaktiv.de'], webflow_site_id: null }),
    ]));
    const origins = rt.allowedOrigins();
    expect(origins).toContain('https://kunde2.de');
    expect(origins).toContain('https://www.example.com'); // from ALLOWED_ORIGINS
    expect(origins).not.toContain('https://inaktiv.de');
    expect(rt.siteForOrigin('https://kunde2.de')).toBe('kunde2');
    expect(rt.siteForOrigin('https://your-site.webflow.io')).toBe('demo');
    expect(rt.siteForOrigin('https://fremd.example')).toBeNull();
  });
});

describe('parseRemoteConfig', () => {
  it('accepts the contract example and normalizes slug/country/origins', () => {
    const c = parseRemoteConfig(remoteConfig({}, [remoteSite({
      slug: 'DEMO', country: 'de', origins: ['https://Example.com/'],
      forms: { 'Newsletter Subscription': { enabled: true, fields: { email: true, phone: false } } },
    })]));
    expect(c).not.toBeNull();
    expect(c!.sites[0].slug).toBe('demo');
    expect(c!.sites[0].country).toBe('DE');
    expect(c!.sites[0].origins).toEqual(['https://example.com']);
    expect(c!.sites[0].forms['Newsletter Subscription'].fields).toEqual({ email: true, phone: false });
    expect(c!.global.messages).toEqual(MESSAGES);
  });

  it('rejects bad input (enums, regexes, lengths, duplicates, shapes)', () => {
    const bad: unknown[] = [
      null, 'nope', [], {},
      { ...remoteConfig(), version: '' },
      remoteConfig({ mode: 'blocken' }),
      remoteConfig({ strict: 'yes' }),
      remoteConfig({ country: 'Deutschland' }),
      remoteConfig({ messages: { email: 'x'.repeat(201), phone: 'ok' } }),
      remoteConfig({ messages: { email: 'nur mail' } }),
      { ...remoteConfig(), sites: {} },
      remoteConfig({}, [remoteSite({ slug: 'Ünsinn' })]),
      remoteConfig({}, [remoteSite({ slug: 'x'.repeat(33) })]),
      remoteConfig({}, [remoteSite({ honeypot: '1_startet_mit_ziffer' })]),
      remoteConfig({}, [remoteSite({ webflow_site_id: 'nope' })]),
      remoteConfig({}, [remoteSite({ mode: 'strenger' })]),
      remoteConfig({}, [remoteSite({ origins: ['javascript:alert(1)'] })]),
      remoteConfig({}, [remoteSite({ origins: Array.from({ length: 51 }, (_, i) => `https://o${i}.de`) })]),
      remoteConfig({}, [remoteSite({ forms: { 'X': { enabled: 'ja' } } })]),
      remoteConfig({}, [remoteSite({ forms: { 'X': { fields: { email: 'nein' } } } })]),
      remoteConfig({}, [remoteSite({ forms: { 'X': 'aus' } })]),
      remoteConfig({}, [remoteSite({ forms: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`F${i}`, {}])) })]),
      remoteConfig({}, [remoteSite(), remoteSite()]), // duplicate slug
      remoteConfig({}, Array.from({ length: 201 }, (_, i) => remoteSite({ slug: `s${i}`, webflow_site_id: null }))),
    ];
    for (const b of bad) expect(parseRemoteConfig(b), JSON.stringify(b).slice(0, 90)).toBeNull();
  });

  it('treats missing optional fields as inherit and defaults global', () => {
    const c = parseRemoteConfig({ version: 'v1', global: {}, sites: [{ slug: 'k1' }] });
    expect(c!.global).toMatchObject({ mode: 'observe', strict: false, rate_limit_hard: false, country: 'DE' });
    expect(c!.global.messages).toEqual(DEFAULT_MESSAGES);
    expect(c!.sites[0]).toMatchObject({ active: true, mode: null, strict: null, honeypot: null, forward: false });
    expect(c!.sites[0].origins).toEqual([]);
    expect(c!.sites[0].forms).toEqual({});
  });
});
