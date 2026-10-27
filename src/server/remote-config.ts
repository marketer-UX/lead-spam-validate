// RuntimeConfig = env defaults ⊕ remote config. Pull only: the service fetches GET CONFIG_URL
// (X-Api-Key, If-None-Match, 3 s) at boot and every CONFIG_POLL_S, and keeps the last good
// config on every error — a config server outage never changes behaviour.
import {
  DEFAULT_COUNTRY, DEFAULT_MESSAGES, parseRemoteConfig,
  type RemoteConfig, type RuntimeConfig, type SiteRuntimeConfig,
} from '../core/effective.js';
import { DEFAULT_SPAM_RULE } from '../core/spam.js';
import { normalizeSite } from '../core/token.js';
import { originAllowed, type Config, type SiteConfig } from './config.js';
import { errMsg, log } from './log.js';

const MAX_BODY = 512 * 1024;

export interface LoaderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ReloadResult {
  ok: boolean;
  status: number | null;
  changed: boolean;
  version: string;
  source: 'remote' | 'env';
  sites: number;
  error?: string;
}

/** Read-only view the rest of the service depends on (keeps pipeline/routes testable). */
export interface RuntimeProvider {
  get(): RuntimeConfig;
}

function makeRuntime(
  source: 'remote' | 'env',
  version: string,
  fetchedAt: string | null,
  global: RuntimeConfig['global'],
  siteList: SiteRuntimeConfig[],
  envOrigins: string[],
): RuntimeConfig {
  const sites = new Map<string, SiteRuntimeConfig>();
  for (const s of siteList) sites.set(s.slug, s);
  return {
    source, version, fetched_at: fetchedAt, global, sites,
    allowedOrigins(): string[] {
      const out: string[] = [];
      const push = (o: string) => { const v = o.trim().toLowerCase().replace(/\/+$/, ''); if (v && !out.includes(v)) out.push(v); };
      for (const o of envOrigins) push(o);
      for (const s of sites.values()) if (s.active) for (const o of s.origins) push(o);
      return out;
    },
    siteForOrigin(origin: string | null | undefined): string | null {
      if (!origin) return null;
      const o = origin.trim().toLowerCase().replace(/\/+$/, '');
      if (!o) return null;
      for (const s of sites.values()) if (s.origins.includes(o)) return s.slug; // exact wins
      for (const s of sites.values()) if (originAllowed(o, s.origins)) return s.slug; // then wildcards
      return null;
    },
  };
}

/** Sites known from the service env (SITES_JSON): tokens/origins for forwarding leads. */
function envSites(cfg: Config): SiteRuntimeConfig[] {
  const out: SiteRuntimeConfig[] = [];
  for (const [rawSlug, s] of Object.entries(cfg.sites ?? {})) {
    const slug = normalizeSite(rawSlug);
    if (slug === 'default' && rawSlug !== 'default') {
      log.warn('config.env_site_slug_invalid', { slug: rawSlug.slice(0, 40) });
      continue;
    }
    out.push({
      slug, name: null, active: true, origins: [], webflow_site_id: s.site_id ?? null,
      honeypot: s.honeypot ?? null, country: null, mode: null, strict: null, rate_limit_hard: null,
      messages: null, phone_deny_prefixes: null, spam: null, forward: true, forms: {},
      ...(s.forward_token ? { forward_token: s.forward_token } : {}),
      ...(s.forward_origin ? { forward_origin: s.forward_origin } : {}),
    });
  }
  return out;
}

/** Env fallback = behaviour without a config server (EMBED_MODE/STRICT_CONTACT/RATE_LIMIT_HARD/SITES_JSON/ALLOWED_ORIGINS). */
export function envRuntime(cfg: Config): RuntimeConfig {
  return makeRuntime('env', 'env', null, {
    mode: cfg.embedMode, strict: cfg.strictContact, rate_limit_hard: cfg.rateLimitHard,
    country: DEFAULT_COUNTRY, messages: { ...DEFAULT_MESSAGES },
    phone_deny_prefixes: [], // like the spam layer: off until the remote config sets it
    spam: { ...DEFAULT_SPAM_RULE }, // env fallback keeps the spam layer off — only the remote config can switch it on
  }, envSites(cfg), cfg.allowedOrigins);
}

/** remote config sites ⊕ SITES_JSON (forward_token/forward_origin, plus site_id/honeypot as a fallback). */
function mergeEnvSecrets(cfg: Config, sites: SiteRuntimeConfig[]): SiteRuntimeConfig[] {
  return sites.map((s) => {
    const env: SiteConfig = cfg.sites?.[s.slug] ?? {};
    return {
      ...s,
      webflow_site_id: s.webflow_site_id ?? env.site_id ?? null,
      honeypot: s.honeypot ?? env.honeypot ?? null,
      ...(env.forward_token ? { forward_token: env.forward_token } : {}),
      ...(env.forward_origin ? { forward_origin: env.forward_origin } : {}),
    };
  });
}

export class RemoteConfigLoader implements RuntimeProvider {
  private cfg: Config;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private current: RuntimeConfig;
  private etag: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<ReloadResult> | null = null;
  /** outcome of the last config server fetch attempt (health/debug) */
  public lastError: string | null = null;
  public lastStatus: number | null = null;

  constructor(cfg: Config, opts: LoaderOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.current = envRuntime(cfg);
  }

  get configured(): boolean {
    return !!(this.cfg.configUrl && this.cfg.controlApiKey);
  }

  get(): RuntimeConfig {
    return this.current;
  }

  /** Apply a payload directly (boot fixture / tests) — same validation as the HTTP path. */
  applyRemote(json: unknown, fetchedAt: string = new Date().toISOString()): boolean {
    const parsed = parseRemoteConfig(json);
    if (!parsed) return false;
    this.setRemote(parsed, fetchedAt);
    return true;
  }

  private setRemote(parsed: RemoteConfig, fetchedAt: string): void {
    this.current = makeRuntime('remote', parsed.version, fetchedAt, parsed.global,
      mergeEnvSecrets(this.cfg, parsed.sites), this.cfg.allowedOrigins);
  }

  private summary(ok: boolean, status: number | null, changed: boolean, error?: string): ReloadResult {
    return {
      ok, status, changed, version: this.current.version, source: this.current.source,
      sites: this.current.sites.size, ...(error ? { error } : {}),
    };
  }

  /** Fetch once. Never throws; on any failure the last good config stays in place. */
  async reload(): Promise<ReloadResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doReload().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doReload(): Promise<ReloadResult> {
    if (!this.configured) return this.summary(false, null, false, 'not_configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(this.cfg.configUrl as string, {
        method: 'GET', signal: ctrl.signal, headers: {
          'x-api-key': this.cfg.controlApiKey as string, accept: 'application/json',
          ...(this.etag ? { 'if-none-match': this.etag } : {}),
        },
      });
      this.lastStatus = r.status;
      if (r.status === 304) {
        this.lastError = null;
        this.current = { ...this.current, fetched_at: new Date().toISOString() };
        return this.summary(true, 304, false);
      }
      if (r.status !== 200) {
        this.lastError = `http_${r.status}`;
        log.warn('config.fetch_failed', { status: r.status, source: this.current.source, version: this.current.version });
        return this.summary(false, r.status, false, `http_${r.status}`);
      }
      const raw = await r.text();
      if (raw.length > MAX_BODY) {
        this.lastError = 'too_large';
        log.warn('config.too_large', { bytes: raw.length });
        return this.summary(false, 200, false, 'too_large');
      }
      let json: unknown;
      try { json = JSON.parse(raw); } catch { json = undefined; }
      const parsed = json === undefined ? null : parseRemoteConfig(json);
      if (!parsed) {
        this.lastError = 'invalid_config';
        log.error('config.invalid', { source: this.current.source, version: this.current.version });
        return this.summary(false, 200, false, 'invalid_config');
      }
      const before = this.current.version;
      const wasEnv = this.current.source === 'env';
      this.etag = r.headers.get('etag') ?? `"${parsed.version}"`;
      this.setRemote(parsed, new Date().toISOString());
      this.lastError = null;
      const changed = wasEnv || before !== parsed.version;
      if (changed) log.info('config.loaded', { version: parsed.version, sites: parsed.sites.length, from: before });
      return this.summary(true, 200, changed);
    } catch (e) {
      this.lastError = errMsg(e);
      this.lastStatus = null;
      log.warn('config.fetch_error', { err: this.lastError, source: this.current.source, version: this.current.version });
      return this.summary(false, null, false, this.lastError);
    } finally { clearTimeout(t); }
  }

  /** Boot fetch + poll (unref'd: never keeps the process alive). */
  start(): void {
    if (!this.configured) {
      log.info('config.env_only', { note: 'CONFIG_URL/CONTROL_API_KEY not set — env fallback', sites: this.current.sites.size });
      return;
    }
    void this.reload();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.reload(); }, Math.max(5, this.cfg.configPollS) * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
