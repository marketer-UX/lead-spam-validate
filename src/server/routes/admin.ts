// Admin routes for operators / the config server: pull the config now (reload trigger) and inspect what the service
// actually uses. API key only (no Origin path), never returns tokens or secrets.
import { Hono } from 'hono';
import type { Config } from '../config.js';
import { errMsg, log } from '../log.js';
import { jsonError, requireApiKey, type AppEnv } from '../mw.js';
import type { RemoteConfigLoader } from '../remote-config.js';

export function adminRoutes(cfg: Config, loader: RemoteConfigLoader): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.use('/v1/admin/*', async (c, next) => {
    const key = requireApiKey(cfg, c);
    if (!key) return jsonError(c, 401, 'api_key_required');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  r.post('/v1/admin/reload', async (c) => {
    try {
      const res = await loader.reload();
      const rt = loader.get();
      log.info('config.reload', { ok: res.ok, status: res.status, changed: res.changed, version: rt.version, source: rt.source });
      return c.json({
        ok: res.ok, version: rt.version, source: rt.source, sites: rt.sites.size,
        changed: res.changed, status: res.status, fetched_at: rt.fetched_at,
        ...(res.error ? { error: res.error } : {}),
      }, 200);
    } catch (e) {
      log.error('config.reload_failed', { err: errMsg(e) });
      return jsonError(c, 503, 'reload_failed');
    }
  });

  r.get('/v1/admin/config', (c) => {
    const rt = loader.get();
    return c.json({
      ok: true, source: rt.source, version: rt.version, fetched_at: rt.fetched_at,
      configured: loader.configured, last_error: loader.lastError, last_status: loader.lastStatus,
      global: rt.global,
      allowed_origins: rt.allowedOrigins(),
      sites: [...rt.sites.values()].map((s) => ({
        slug: s.slug, name: s.name, active: s.active, origins: s.origins, webflow_site_id: s.webflow_site_id,
        honeypot: s.honeypot, country: s.country, mode: s.mode, strict: s.strict, rate_limit_hard: s.rate_limit_hard,
        messages: s.messages, phone_deny_prefixes: s.phone_deny_prefixes, forward: s.forward,
        forward_ready: !!(cfg.forwardUrl && s.forward && s.forward_token), // token itself stays secret
        forms: s.forms,
      })),
    }, 200);
  });

  return r;
}
