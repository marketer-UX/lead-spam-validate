// Single place that reads process.env. Boot guard refuses to start in production (NODE_ENV=production) without the critical secrets.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { EmbedMode } from '../core/effective.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

export type { EmbedMode };
export type ProviderName = 'none' | 'aftership' | 'reacher';

export interface SiteConfig {
  site_id?: string; // Webflow site id (webhook guard)
  honeypot?: string;
  forward_token?: string; // X-Source-Token for the lead store intake
  forward_origin?: string; // Origin header the lead store intake whitelists for this source
}

export interface Config {
  version: string;
  port: number;
  isProduction: boolean;
  canonicalHost: string | null;
  canonicalFromSuffix: string | null;
  tokenSecret: string;
  tokenSecretPrev: string | null;
  ipSalt: string;
  apiKeys: Map<string, string>; // key → id
  allowedOrigins: string[]; // exact origins or wildcard patterns like https://*.webflow.io
  embedMode: EmbedMode;
  provider: ProviderName;
  deepVerifierUrl: string | null;
  deepVerifierKey: string | null;
  reacherUrl: string | null;
  reacherSecret: string | null;
  fromEmail: string;
  helloName: string;
  mxTimeoutMs: number;
  rlIpPerMin: number;
  rlKeyPerMin: number;
  rlSubmitIp10m: number;
  rlSubmitIp24h: number;
  rlSubmitFreemail1h: number;
  rlWebhookEmail1h: number;
  rateLimitHard: boolean;
  strictContact: boolean;
  webflowWebhookSecret: string | null;
  webhookFallbackSecret: string | null;
  webhookEnforce: boolean;
  /** Webflow API token with forms:write — deletes junk submissions that reached Webflow past the embed */
  webflowApiToken: string | null;
  /** kill switch for the deletion above (default off) */
  webflowDeleteRejected: boolean;
  /** Calendly personal access token — cancels junk bookings */
  calendlyToken: string | null;
  /** signing key of the Calendly webhook subscription (Calendly-Webhook-Signature) */
  calendlyWebhookSigningKey: string | null;
  sites: Record<string, SiteConfig>;
  forwardUrl: string | null;
  forwardBaseUrl: string | null; // derived from intake url; used for PATCH /api/leads/:id/validation
  controlApiKey: string | null;
  configUrl: string | null; // config server: GET remote config (pull)
  eventsUrl: string | null; // event sink: POST decision events (push)
  configPollS: number;
  eventsFlushS: number;
  deepQueueMax: number;
  deepConcurrency: number;
  disposableRefreshUrl: string | null;
  disposableRefreshHours: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  debug: boolean;
}

function int(v: string | undefined, d: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
}
function bool(v: string | undefined, d = false): boolean {
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
}
function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === "production";
  const missing: string[] = [];
  if (!env.TOKEN_SECRET) missing.push('TOKEN_SECRET');
  if (!env.API_KEYS) missing.push('API_KEYS');
  if (!env.ALLOWED_ORIGINS) missing.push('ALLOWED_ORIGINS');
  if (isProduction && missing.length) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', ev: 'boot.missing_env', missing }));
    process.exit(1);
  }
  const apiKeys = new Map<string, string>();
  for (const entry of list(env.API_KEYS)) {
    const idx = entry.indexOf(':');
    if (idx > 0) apiKeys.set(entry.slice(idx + 1), entry.slice(0, idx));
    else apiKeys.set(entry, 'key' + apiKeys.size);
  }
  let sites: Record<string, SiteConfig> = {};
  if (env.SITES_JSON) {
    try { sites = JSON.parse(env.SITES_JSON); } catch { console.error(JSON.stringify({ level: 'error', ev: 'boot.sites_json_invalid' })); }
  }
  const embedMode = (['observe', 'enforce', 'off'].includes(env.EMBED_MODE ?? '') ? env.EMBED_MODE : 'observe') as EmbedMode;
  const provider = (['none', 'aftership', 'reacher'].includes(env.EMAIL_VERIFIER_PROVIDER ?? '') ? env.EMAIL_VERIFIER_PROVIDER : 'none') as ProviderName;
  const forwardUrl = env.FORWARD_URL || null;
  let forwardBaseUrl: string | null = null;
  if (forwardUrl) { try { forwardBaseUrl = new URL(forwardUrl).origin; } catch { forwardBaseUrl = null; } }
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL ?? '') ? env.LOG_LEVEL : 'info') as Config['logLevel'];
  return {
    version: pkg.version,
    port: int(env.PORT, 8787),
    isProduction,
    canonicalHost: env.CANONICAL_HOST || null,
    canonicalFromSuffix: env.CANONICAL_FROM_SUFFIX?.toLowerCase() || null,
    tokenSecret: env.TOKEN_SECRET || randomBytes(32).toString('hex'),
    tokenSecretPrev: env.TOKEN_SECRET_PREV || null,
    ipSalt: env.IP_SALT_SECRET || env.TOKEN_SECRET || randomBytes(16).toString('hex'),
    apiKeys,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    embedMode,
    provider,
    deepVerifierUrl: env.DEEP_VERIFIER_URL?.replace(/\/+$/, '') || null,
    deepVerifierKey: env.DEEP_VERIFIER_KEY || null,
    reacherUrl: env.REACHER_URL?.replace(/\/+$/, '') || null,
    reacherSecret: env.REACHER_SECRET || null,
    fromEmail: env.FROM_EMAIL || 'noreply@example.com',
    helloName: env.HELLO_NAME || 'verify.example.com',
    mxTimeoutMs: int(env.MX_TIMEOUT_MS, 1500),
    rlIpPerMin: int(env.RL_IP_PER_MIN, 60),
    rlKeyPerMin: int(env.RL_KEY_PER_MIN, 600),
    rlSubmitIp10m: int(env.RL_SUBMIT_IP_10M, 5),
    rlSubmitIp24h: int(env.RL_SUBMIT_IP_24H, 20),
    rlSubmitFreemail1h: int(env.RL_SUBMIT_FREEMAIL_1H, 3),
    rlWebhookEmail1h: int(env.RL_WEBHOOK_EMAIL_1H, 3),
    rateLimitHard: bool(env.RATE_LIMIT_HARD, false),
    strictContact: bool(env.STRICT_CONTACT, false),
    webflowWebhookSecret: env.WEBFLOW_WEBHOOK_SECRET || null,
    webhookFallbackSecret: env.WEBHOOK_FALLBACK_SECRET || null,
    webhookEnforce: bool(env.WEBHOOK_ENFORCE, false),
    webflowApiToken: env.WEBFLOW_API_TOKEN || null,
    webflowDeleteRejected: bool(env.WEBFLOW_DELETE_REJECTED, false),
    calendlyToken: env.CALENDLY_TOKEN || null,
    calendlyWebhookSigningKey: env.CALENDLY_WEBHOOK_SIGNING_KEY || null,
    sites,
    forwardUrl,
    forwardBaseUrl,
    controlApiKey: env.CONTROL_API_KEY || null,
    configUrl: env.CONFIG_URL || null,
    eventsUrl: env.EVENTS_URL || null,
    configPollS: int(env.CONFIG_POLL_S, 60),
    eventsFlushS: int(env.EVENTS_FLUSH_S, 10),
    deepQueueMax: int(env.DEEP_QUEUE_MAX, 500),
    deepConcurrency: int(env.DEEP_CONCURRENCY, 2),
    disposableRefreshUrl: env.DISPOSABLE_REFRESH_URL === 'off' ? null
      : (env.DISPOSABLE_REFRESH_URL || 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf'),
    disposableRefreshHours: int(env.DISPOSABLE_REFRESH_HOURS, 24),
    logLevel,
    debug: bool(env.DEBUG, false),
  };
}

/** Origin allow check with `https://*.example.com` wildcards. */
export function originAllowed(origin: string | null | undefined, patterns: string[]): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase().replace(/\/+$/, '');
  for (const p of patterns) {
    const pat = p.toLowerCase().replace(/\/+$/, '');
    if (pat === o) return true;
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$');
      if (re.test(o)) return true;
    }
  }
  return false;
}
