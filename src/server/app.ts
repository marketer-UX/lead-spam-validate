// App assembly (testable): builds the Hono app from a Config + injectable deps (fetch, DNS).
import { Hono } from 'hono';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MxLookupResult, MxResolver } from '../core/email.js';
import type { EmailCheckResult, EmailFastResult } from '../core/types.js';
import { getProvider, type DeepProvider } from '../providers/index.js';
import { TtlLru } from './cache.js';
import type { Config } from './config.js';
import { makeMxResolver } from './dns.js';
import { EventSink } from './events.js';
import { log } from './log.js';
import { authMiddleware, preflight, type AppEnv } from './mw.js';
import type { Counters, RepeatEntry, Services } from './pipeline.js';
import { DeepQueue } from './queue.js';
import { RemoteConfigLoader } from './remote-config.js';
import { adminRoutes } from './routes/admin.js';
import { calendlyHookRoutes } from './routes/hooks-calendly.js';
import { embedRoutes } from './routes/embed.js';
import { healthRoutes, type HealthState } from './routes/health.js';
import { webflowHookRoutes } from './routes/hooks-webflow.js';
import { tokenRoutes } from './routes/token.js';
import { validateRoutes } from './routes/validate.js';

export interface AppDeps {
  resolveMx?: MxResolver;
  provider?: DeepProvider;
  fetchImpl?: typeof fetch;
  embedPath?: string;
  queue?: DeepQueue | null;
  /** remote config loader (tests inject a seeded/mocked one; never auto-started here) */
  runtime?: RemoteConfigLoader;
  /** decision-event sink (null = off) */
  events?: EventSink | null;
}

export interface BuiltApp {
  app: Hono<AppEnv>;
  svc: Services;
  runtime: RemoteConfigLoader;
  events: EventSink | null;
  health: HealthState;
  caches: { mx: TtlLru<string, MxLookupResult>; email: TtlLru<string, EmailFastResult & { deep?: EmailCheckResult }>; phoneDup: TtlLru<string, number>; seen: TtlLru<string, number> };
}

export function buildApp(cfg: Config, deps: AppDeps = {}): BuiltApp {
  const mx = new TtlLru<string, MxLookupResult>(20_000);
  const email = new TtlLru<string, EmailFastResult & { deep?: EmailCheckResult }>(50_000);
  const phoneDup = new TtlLru<string, number>(20_000);
  const seen = new TtlLru<string, number>(10_000);
  const repeats = new TtlLru<string, RepeatEntry[]>(50_000);
  const resolveMx = deps.resolveMx ?? makeMxResolver(mx, { timeoutMs: cfg.mxTimeoutMs, fetchImpl: deps.fetchImpl });
  const provider = deps.provider ?? getProvider(cfg);
  const queue = deps.queue !== undefined ? deps.queue : (provider.name === 'none' ? null : new DeepQueue(provider, email, {
    max: cfg.deepQueueMax, concurrency: cfg.deepConcurrency, fetchImpl: deps.fetchImpl,
    forwardTarget: cfg.forwardBaseUrl && cfg.controlApiKey ? { baseUrl: cfg.forwardBaseUrl, apiKey: cfg.controlApiKey } : null,
  }));
  const runtime = deps.runtime ?? new RemoteConfigLoader(cfg, { fetchImpl: deps.fetchImpl });
  const events = deps.events !== undefined ? deps.events : new EventSink(cfg, { fetchImpl: deps.fetchImpl });
  const counters: Counters = { field_checks: 0 };
  const svc: Services = { cfg, resolveMx, emailCache: email, phoneDup, repeats, provider, queue, runtime, events, counters };
  const health: HealthState = { deepReachable: null, startedAt: Date.now() };

  const app = new Hono<AppEnv>();

  // canonical host: requests on the platform default domain (CANONICAL_FROM_SUFFIX, e.g. .up.railway.app,
  // .fly.dev, .onrender.com) → 301 to CANONICAL_HOST, except /health so the platform health check keeps working
  app.use('*', async (c, next) => {
    const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '').split(',')[0].trim().toLowerCase();
    if (cfg.canonicalHost && cfg.canonicalFromSuffix && host.endsWith(cfg.canonicalFromSuffix) && c.req.path !== '/health') {
      return c.redirect(`https://${cfg.canonicalHost}${c.req.path}${new URL(c.req.url).search}`, 301);
    }
    c.header('X-Robots-Tag', 'noindex');
    await next();
  });

  app.route('/', healthRoutes(cfg, health, queue, svc));
  const here = dirname(fileURLToPath(import.meta.url));
  app.route('/', embedRoutes(deps.embedPath ?? resolve(here, '../../dist/embed/v1/validate.js')));
  app.route('/', webflowHookRoutes({ svc, seen, fetchImpl: deps.fetchImpl }));
  app.route('/', calendlyHookRoutes({ svc, seen, fetchImpl: deps.fetchImpl }));

  app.route('/', adminRoutes(cfg, runtime));

  app.options('/v1/*', preflight(cfg, runtime));
  for (const p of ['/v1/validate', '/v1/email', '/v1/phone', '/v1/token']) app.use(p, authMiddleware(cfg, runtime));
  app.route('/', tokenRoutes(cfg, runtime));
  app.route('/', validateRoutes(svc));

  app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));
  app.onError((err, c) => {
    log.error('unhandled', { path: c.req.path, err: `${err.name}: ${err.message}`.slice(0, 200) });
    if (/^\/v1\/(validate|email|phone)$/.test(c.req.path)) {
      return c.json({ decision: 'accept', reject_reason: null, score: 0, flags: [], suspicious: false, review: false, email: { verdict: 'unknown', flags: [], provider: 'native', latency_ms: 0 }, phone: null,
        bot: { honeypot: 'absent', token: 'missing', elapsed_ms: null, rate_limited: false, flags: [] }, degraded: true, request_id: c.get('rid') ?? 'n/a', latency_ms: 0 }, 200);
    }
    return c.json({ ok: false, error: 'internal' }, 500);
  });

  return { app, svc, runtime, events, health, caches: { mx, email, phoneDup, seen } };
}
