// Public uptime probe vs. full diagnostics: without a valid X-Api-Key only ok/version/uptime_s.
import { Hono } from 'hono';
import type { Config } from '../config.js';
import { requireApiKey } from '../mw.js';
import type { Services } from '../pipeline.js';
import type { DeepQueue } from '../queue.js';

export interface HealthState { deepReachable: boolean | null; startedAt: number }

export function healthRoutes(cfg: Config, state: HealthState, queue: DeepQueue | null, svc: Services): Hono {
  const r = new Hono();
  r.get('/health', (c) => {
    c.header('Cache-Control', 'no-store');
    const base = { ok: true, version: cfg.version, uptime_s: Math.floor((Date.now() - state.startedAt) / 1000) };
    // fail-open: missing or wrong key → minimal response, never 401 (uptime monitoring stays green)
    if (!requireApiKey(cfg, c)) return c.json(base);
    const rt = svc.runtime.get(); // global defaults as the service applies them right now
    return c.json({
      ...base,
      provider: cfg.provider, deep_reachable: state.deepReachable, embed_mode: rt.global.mode, strict: rt.global.strict,
      config: { source: rt.source, version: rt.version, fetched_at: rt.fetched_at, sites: rt.sites.size },
      events: svc.events ? svc.events.stats : { buffered: 0, sent: 0, dropped: 0, failed: 0 },
      field_checks: svc.counters.field_checks,
      queue: queue ? { pending: queue.size, active: queue.active, ...queue.stats } : null,
    });
  });
  return r;
}
