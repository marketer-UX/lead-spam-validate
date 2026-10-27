// MX resolution: node:dns first (container resolver, fast), Cloudflare DoH fallback on resolver errors. Cached per domain.
import dns from 'node:dns/promises';
import type { MxLookupResult, MxResolver } from '../core/email.js';
import { DAY, TtlLru } from './cache.js';
import { log } from './log.js';

export interface DnsOptions {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  dohUrl?: string; // default cloudflare
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function codeOf(e: unknown): string {
  return (e as { code?: string })?.code ?? '';
}

export async function resolveMxNode(domain: string, timeoutMs: number): Promise<MxLookupResult> {
  try {
    const recs = await withTimeout(dns.resolveMx(domain), timeoutMs);
    if (recs.length) {
      const sorted = [...recs].sort((a, b) => a.priority - b.priority);
      const hosts = sorted.map((r) => r.exchange.replace(/\.$/, '').toLowerCase()).filter(Boolean);
      if (hosts.length === 0 || (sorted.length === 1 && sorted[0].priority === 0 && !hosts[0])) return { status: 'null_mx', hosts: [] };
      return { status: 'mx', hosts };
    }
  } catch (e) {
    const code = codeOf(e);
    if (code === 'ENOTFOUND') return { status: 'nxdomain', hosts: [] };
    if (code !== 'ENODATA') throw e; // ETIMEOUT / ESERVFAIL / ECONNREFUSED → let caller fall back to DoH
  }
  // no MX → implicit MX via A/AAAA
  try {
    const a = await withTimeout(dns.resolve4(domain), timeoutMs);
    if (a.length) return { status: 'a_only', hosts: [] };
  } catch (e) {
    const code = codeOf(e);
    if (code === 'ENOTFOUND') return { status: 'nxdomain', hosts: [] };
    if (code !== 'ENODATA') throw e;
  }
  try {
    const aaaa = await withTimeout(dns.resolve6(domain), timeoutMs);
    if (aaaa.length) return { status: 'a_only', hosts: [] };
  } catch (e) {
    const code = codeOf(e);
    if (code === 'ENOTFOUND') return { status: 'nxdomain', hosts: [] };
    if (code !== 'ENODATA') throw e;
  }
  return { status: 'none', hosts: [] };
}

interface DohAnswer { type: number; data: string }
interface DohResponse { Status: number; Answer?: DohAnswer[] }

export async function resolveMxDoh(domain: string, opts: DnsOptions): Promise<MxLookupResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.dohUrl ?? 'https://cloudflare-dns.com/dns-query';
  const q = async (type: 'MX' | 'A'): Promise<DohResponse> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const r = await f(`${base}?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`doh ${r.status}`);
      return (await r.json()) as DohResponse;
    } finally { clearTimeout(t); }
  };
  const mx = await q('MX');
  if (mx.Status === 3) return { status: 'nxdomain', hosts: [] };
  if (mx.Status !== 0) throw new Error(`doh status ${mx.Status}`);
  const recs = (mx.Answer ?? []).filter((a) => a.type === 15).map((a) => {
    const [pri, host] = a.data.trim().split(/\s+/);
    return { priority: parseInt(pri, 10) || 0, host: (host ?? '').replace(/\.$/, '').toLowerCase() };
  });
  if (recs.length) {
    if (recs.length === 1 && recs[0].priority === 0 && recs[0].host === '') return { status: 'null_mx', hosts: [] };
    return { status: 'mx', hosts: recs.sort((a, b) => a.priority - b.priority).map((r) => r.host).filter(Boolean) };
  }
  const a = await q('A');
  if (a.Status === 3) return { status: 'nxdomain', hosts: [] };
  if ((a.Answer ?? []).some((x) => x.type === 1)) return { status: 'a_only', hosts: [] };
  return { status: 'none', hosts: [] };
}

export const MX_TTL: Record<MxLookupResult['status'], number> = {
  mx: 7 * DAY, a_only: 7 * DAY, none: DAY, nxdomain: DAY, null_mx: DAY, error: 60_000,
};

/** Cached resolver: node → DoH fallback; any failure → 'error' (fail-open). Never throws. */
export function makeMxResolver(cache: TtlLru<string, MxLookupResult>, opts: DnsOptions): MxResolver {
  return async (domain: string): Promise<MxLookupResult> => {
    const hit = cache.get(domain);
    if (hit) return hit;
    let res: MxLookupResult;
    const t0 = Date.now();
    try {
      res = await resolveMxNode(domain, opts.timeoutMs);
    } catch (e1) {
      try {
        res = await resolveMxDoh(domain, opts);
      } catch (e2) {
        log.warn('dns.error', { tld: domain.split('.').pop(), node: codeOf(e1) || String((e1 as Error).message).slice(0, 60), doh: String((e2 as Error).message).slice(0, 60) });
        res = { status: 'error', hosts: [] };
      }
    }
    cache.set(domain, res, MX_TTL[res.status]);
    log.debug('dns.lookup', { tld: domain.split('.').pop(), status: res.status, ms: Date.now() - t0 });
    return res;
  };
}
