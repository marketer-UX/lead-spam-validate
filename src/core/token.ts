// Signed time-to-submit token: `v1.<site>.<ts_b36>.<nonce>.<sig>` — HMAC-SHA256(secret, "site.ts.nonce"), 16-byte sig (base64url).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenState } from './types.js';

export interface TokenSecrets {
  current: string;
  previous?: string | null; // rotation: tokens minted with the previous secret stay valid until they expire
}

export const TOKEN_MIN_ELAPSED_MS = 2500;
export const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const TOKEN_VERSION = 'v1';

const SITE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret: string, site: string, tsB36: string, nonce: string): string {
  return b64url(createHmac('sha256', secret).update(`${site}.${tsB36}.${nonce}`).digest().subarray(0, 16));
}

export function normalizeSite(site: string | null | undefined): string {
  const s = (site ?? '').toString().trim().toLowerCase();
  return SITE_RE.test(s) ? s : 'default';
}

export function mintToken(site: string, secrets: TokenSecrets, now: number = Date.now()): string {
  const s = normalizeSite(site);
  const tsB36 = now.toString(36);
  const nonce = b64url(randomBytes(8));
  return `${TOKEN_VERSION}.${s}.${tsB36}.${nonce}.${sign(secrets.current, s, tsB36, nonce)}`;
}

export interface ParsedToken { site: string; ts: number; nonce: string; sig: string }

export function parseToken(token: string): ParsedToken | null {
  if (typeof token !== 'string' || token.length > 120) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) return null;
  const [, site, tsB36, nonce, sig] = parts;
  if (!SITE_RE.test(site) || !/^[0-9a-z]{1,12}$/.test(tsB36) || !/^[A-Za-z0-9_-]{6,24}$/.test(nonce) || !/^[A-Za-z0-9_-]{22}$/.test(sig)) return null;
  const ts = parseInt(tsB36, 36);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { site, ts, nonce, sig };
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface VerifyOptions {
  site?: string | null; // when given, token must be bound to this site
  now?: number; // reference time (webhook: submittedAt)
  minElapsedMs?: number;
  maxAgeMs?: number;
}

export interface VerifyResult { state: TokenState; elapsed_ms: number | null; site: string | null }

export function verifyToken(token: string | null | undefined, secrets: TokenSecrets, opts: VerifyOptions = {}): VerifyResult {
  if (!token) return { state: 'missing', elapsed_ms: null, site: null };
  const p = parseToken(token);
  if (!p) return { state: 'invalid', elapsed_ms: null, site: null };
  const expected = sign(secrets.current, p.site, p.ts.toString(36), p.nonce);
  let ok = safeEq(p.sig, expected);
  if (!ok && secrets.previous) ok = safeEq(p.sig, sign(secrets.previous, p.site, p.ts.toString(36), p.nonce));
  if (!ok) return { state: 'invalid', elapsed_ms: null, site: p.site };
  if (opts.site && normalizeSite(opts.site) !== p.site) return { state: 'invalid', elapsed_ms: null, site: p.site };
  const now = opts.now ?? Date.now();
  const elapsed = now - p.ts;
  if (elapsed < (opts.minElapsedMs ?? TOKEN_MIN_ELAPSED_MS)) return { state: 'too_fast', elapsed_ms: elapsed, site: p.site };
  if (elapsed > (opts.maxAgeMs ?? TOKEN_MAX_AGE_MS)) return { state: 'expired', elapsed_ms: elapsed, site: p.site };
  return { state: 'ok', elapsed_ms: elapsed, site: p.site };
}
