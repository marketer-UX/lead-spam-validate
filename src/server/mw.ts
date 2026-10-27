// Auth + CORS + body helpers. Browser callers: Origin whitelist; server callers: X-Api-Key. Same routes for both.
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { timingSafeEqual } from 'node:crypto';
import { originAllowed, type Config } from './config.js';
import { ipHash } from './hash.js';
import { checkRateLimit } from './rate-limit.js';
import type { RuntimeProvider } from './remote-config.js';

export type AuthCtx = { kind: 'browser'; origin: string } | { kind: 'server'; keyId: string };

/** `siteHint` = site slug owning the request Origin (runtime config), used when no explicit site is sent. */
export type AppEnv = { Variables: { auth: AuthCtx; ipHash: string; rid: string; siteHint: string | null } };

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** CF-Connecting-IP (Cloudflare-proxied canonical domain) → first XFF entry → X-Real-Ip → socket. */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  try { return getConnInfo(c).remote.address ?? '0.0.0.0'; } catch { return '0.0.0.0'; }
}

/**
 * Country of the client IP, as the edge resolved it: CF-IPCountry (Cloudflare, needs the host
 * proxied) → X-Vercel-IP-Country → X-Geo-Country. Unknown / 'XX' / 'T1' (Tor) → null, and null
 * means the geo rules simply do not fire (fail-open — we never guess a country ourselves).
 */
export function clientCountry(c: Context): string | null {
  for (const h of ['cf-ipcountry', 'x-vercel-ip-country', 'x-geo-country']) {
    const v = c.req.header(h)?.trim().toUpperCase();
    if (v && /^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1') return v;
  }
  return null;
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export function resolveAuth(cfg: Config, rt: RuntimeProvider, c: Context): { auth: AuthCtx } | { error: { status: 401 | 403; code: string } } {
  const key = c.req.header('x-api-key');
  if (key) {
    for (const [k, id] of cfg.apiKeys) if (safeEqual(k, key)) return { auth: { kind: 'server', keyId: id } };
    return { error: { status: 401, code: 'api_key_invalid' } };
  }
  const origin = c.req.header('origin') ?? null;
  if (origin && originAllowed(origin, rt.get().allowedOrigins())) return { auth: { kind: 'browser', origin } };
  return { error: { status: 403, code: 'origin_not_whitelisted' } };
}

/** API-key-only guard for /v1/admin/* (no Origin path, no CORS). */
export function requireApiKey(cfg: Config, c: Context): { keyId: string } | null {
  const key = c.req.header('x-api-key');
  if (!key) return null;
  for (const [k, id] of cfg.apiKeys) if (safeEqual(k, key)) return { keyId: id };
  return null;
}

export function jsonError(c: Context, status: 400 | 401 | 403 | 413 | 429 | 500 | 503, code: string, headers: Record<string, string> = {}) {
  return c.json({ ok: false, error: code }, status, headers);
}

/** Middleware factory for /v1/validate|email|phone|token: sets auth/ipHash/rid, applies CORS + abuse limit. */
export function authMiddleware(cfg: Config, rt: RuntimeProvider) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const runtime = rt.get();
    const res = resolveAuth(cfg, rt, c);
    const origin = c.req.header('origin') ?? null;
    const originOk = origin && originAllowed(origin, runtime.allowedOrigins()) ? origin : null;
    if ('error' in res) return jsonError(c, res.error.status, res.error.code, corsHeaders(originOk));
    const ip = clientIp(c);
    const ih = ipHash(ip, cfg.ipSalt);
    c.set('auth', res.auth);
    c.set('ipHash', ih);
    c.set('rid', crypto.randomUUID());
    c.set('siteHint', runtime.siteForOrigin(originOk));
    const rl = res.auth.kind === 'server'
      ? checkRateLimit(`key:${res.auth.keyId}`, cfg.rlKeyPerMin, 60_000)
      : checkRateLimit(`ip:${ih}`, cfg.rlIpPerMin, 60_000);
    if (!rl.ok) {
      return jsonError(c, 429, 'rate_limited', { ...corsHeaders(res.auth.kind === 'browser' ? res.auth.origin : null), 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) });
    }
    for (const [k, v] of Object.entries(corsHeaders(res.auth.kind === 'browser' ? res.auth.origin : null))) c.header(k, v);
    await next();
  };
}

export function preflight(cfg: Config, rt: RuntimeProvider) {
  return (c: Context) => {
    const origin = c.req.header('origin') ?? null;
    const ok = origin && originAllowed(origin, rt.get().allowedOrigins()) ? origin : null;
    if (!ok) return c.body(null, 403, corsHeaders(null));
    return c.body(null, 204, corsHeaders(ok));
  };
}

/** Reads JSON from application/json OR text/plain (embed sends text/plain to avoid preflight). */
export async function readJson(c: Context, maxBytes: number): Promise<{ body: Record<string, unknown> } | { error: 400 | 413 }> {
  const len = parseInt(c.req.header('content-length') ?? '0', 10);
  if (len > maxBytes) return { error: 413 };
  const raw = await c.req.text();
  if (raw.length > maxBytes) return { error: 413 };
  if (!raw.trim()) return { body: {} };
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 400 };
    return { body: j as Record<string, unknown> };
  } catch { return { error: 400 }; }
}
