import { Hono } from 'hono';
import { effective } from '../../core/effective.js';
import { mintToken, normalizeSite, TOKEN_MAX_AGE_MS } from '../../core/token.js';
import type { Config } from '../config.js';
import type { AppEnv } from '../mw.js';
import type { RuntimeProvider } from '../remote-config.js';

export function tokenRoutes(cfg: Config, rt: RuntimeProvider): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/v1/token', (c) => {
    const q = c.req.query('site');
    // explicit ?site= wins; otherwise the site owning the request Origin (runtime config)
    const site = q ? normalizeSite(q) : normalizeSite(c.get('siteHint'));
    const runtime = rt.get();
    const eff = effective(runtime, site, null);
    const token = mintToken(site, { current: cfg.tokenSecret, previous: cfg.tokenSecretPrev });
    c.header('Cache-Control', 'no-store');
    return c.json({
      token, ttl_s: Math.floor(TOKEN_MAX_AGE_MS / 1000), site,
      mode: eff.mode, strict: eff.strict, country: eff.country, messages: eff.messages,
      forms: runtime.sites.get(site)?.forms ?? {},
    }, 200);
  });
  return r;
}
