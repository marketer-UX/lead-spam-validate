// Boot: config → app → serve. Also: periodic provider health probe, disposable-list refresh, cache sweeps, graceful shutdown.
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { scheduleDisposableRefresh } from './disposable-refresh.js';
import { log, setLogLevel } from './log.js';
import { sweepRateLimits } from './rate-limit.js';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);
if (!process.env.TOKEN_SECRET) log.warn('boot.ephemeral_secret', { note: 'TOKEN_SECRET not set — tokens will not survive a restart' });

const built = buildApp(cfg);
const { app, svc, runtime, events, health, caches } = built;

// remote config (pull) + event push; both no-ops without CONFIG_URL/EVENTS_URL
runtime.start();
events?.start();

const probe = async () => { health.deepReachable = await svc.provider.health(); };
void probe();
setInterval(() => { void probe(); }, 10 * 60_000).unref();
scheduleDisposableRefresh(cfg.disposableRefreshUrl, cfg.disposableRefreshHours);
setInterval(() => {
  const n = sweepRateLimits() + caches.mx.sweep() + caches.email.sweep() + caches.phoneDup.sweep() + caches.seen.sweep();
  if (n) log.debug('sweep', { removed: n });
}, 5 * 60_000).unref();

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  const rt = runtime.get();
  log.info('boot', { port: info.port, version: cfg.version, provider: cfg.provider, embed_mode: rt.global.mode, origins: rt.allowedOrigins().length, keys: cfg.apiKeys.size, sites: [...rt.sites.keys()], config_source: rt.source, production: cfg.isProduction });
});

const shutdown = (sig: string) => {
  log.info('shutdown', { sig });
  runtime.stop();
  if (events) void events.flushNow().catch(() => 0).finally(() => events.stop());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
