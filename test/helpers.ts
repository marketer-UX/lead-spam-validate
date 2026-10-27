import type { MxLookupResult } from '../src/core/email.js';
import { buildApp, type AppDeps } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { resetRateLimits } from '../src/server/rate-limit.js';
import { setLogLevel } from '../src/server/log.js';
import { RemoteConfigLoader } from '../src/server/remote-config.js';

setLogLevel('error');

export const MX_TABLE: Record<string, MxLookupResult['status']> = {
  'gmail.com': 'mx', 'gmial.com': 'mx', 'existierende-gmbh.de': 'mx', 'domain-ohne-mx.de': 'nxdomain', 'web.de': 'mx', 'example.com': 'mx', 'beispiel-gmbh.de': 'mx',
};

export const baseEnv: NodeJS.ProcessEnv = {
  TOKEN_SECRET: 'test-token-secret-xxxxxxxxxxxxxxxx',
  IP_SALT_SECRET: 'salt',
  API_KEYS: 'server:key-srv-123,next:key-next-456',
  ALLOWED_ORIGINS: 'https://example.com,https://www.example.com,https://*.webflow.io',
  EMBED_MODE: 'observe',
  EMAIL_VERIFIER_PROVIDER: 'none',
  WEBHOOK_FALLBACK_SECRET: 'hook-secret',
  WEBFLOW_WEBHOOK_SECRET: 'wf-secret',
  FORWARD_URL: 'https://leads.example.test/api/leads/intake',
  CONTROL_API_KEY: 'control-key',
  SITES_JSON: JSON.stringify({ demo: { site_id: '0123456789abcdef01234567', honeypot: 'company_url_confirm', forward_token: 'PUB_demo_test', forward_origin: 'https://example.com' } }),
  LOG_LEVEL: 'error',
};

/**
 * Without `remote` the app runs on the env fallback = behaviour without a config server.
 * With `remote` a seeded RemoteConfigLoader is injected (source `remote`, no HTTP).
 */
export function makeApp(envOverrides: NodeJS.ProcessEnv = {}, deps: AppDeps = {}, remote?: unknown) {
  resetRateLimits();
  const cfg = loadConfig({ ...baseEnv, ...envOverrides });
  const resolveMx = deps.resolveMx ?? (async (d: string): Promise<MxLookupResult> => ({ status: MX_TABLE[d] ?? 'none', hosts: [] }));
  let runtime = deps.runtime;
  if (remote !== undefined && !runtime) {
    runtime = new RemoteConfigLoader(cfg);
    if (!runtime.applyRemote(remote)) throw new Error('test fixture rejected by parseRemoteConfig');
  }
  return buildApp(cfg, { resolveMx, queue: null, events: null, ...deps, ...(runtime ? { runtime } : {}) });
}

export const MESSAGES = {
  email: 'Please enter a valid email address.',
  phone: 'Please enter a valid phone number.',
};

type Json = Record<string, unknown>;

/** Valid remote config payload; `over` patches global, `sites` replaces the site list. */
export function remoteConfig(over: Json = {}, sites?: Json[]): Json {
  return {
    version: 'v-test-1',
    global: { mode: 'enforce', strict: true, rate_limit_hard: false, country: 'DE', messages: MESSAGES, ...over },
    sites: sites ?? [remoteSite()],
  };
}

/** Valid remote config site entry (demo, with its origins). */
export function remoteSite(over: Json = {}): Json {
  return {
    slug: 'demo', name: 'Example Co', active: true,
    origins: ['https://example.com', 'https://www.example.com', 'https://*.webflow.io'],
    webflow_site_id: '0123456789abcdef01234567', honeypot: 'company_url_confirm', country: 'DE',
    mode: null, strict: null, messages: null, forward: false, forms: {}, ...over,
  };
}

export const ORIGIN = 'https://www.example.com';

export function post(app: ReturnType<typeof makeApp>['app'], path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
