// Stage 1 (native, no SMTP): normalize → syntax → disposable/freemail/role → MX (injected resolver) → typo suggestion.
// Pure module: no env, no cache, no network except through `deps.resolveMx`.
import type { DomainClass, EmailFastResult, EmailFlag, MxStatus } from './types.js';
import { isDisposableDomain } from './lists/disposable.js';
import { FREEMAIL_DOMAINS } from './lists/freemail.js';
import { ROLE_LOCAL_PARTS } from './lists/role.js';
import { suggestDomain } from './typo.js';

export interface MxLookupResult {
  status: MxStatus;
  hosts: string[]; // MX hosts (lowest preference first) when status === 'mx'
}

export type MxResolver = (domain: string) => Promise<MxLookupResult>;

export interface EmailCheckDeps {
  resolveMx: MxResolver;
  /** total budget for the MX lookup; on timeout status becomes 'error' (fail-open) */
  budgetMs?: number;
  now?: () => number;
}

export interface NormalizedEmail {
  normalized: string;
  local: string;
  domain: string; // punycode, lowercase
}

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/** Lowercase, trim, IDN domain → punycode. Returns null when unparseable (no '@', empty parts, bad lengths/characters). */
export function normalizeEmail(raw: string): NormalizedEmail | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^mailto:/i, '').replace(/^<|>$/g, '').trim();
  if (!s || s.length > 320) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  if (s.indexOf('@') !== at) return null; // more than one '@' (quoted locals are not worth supporting for lead forms)
  const local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.$/, '');
  if (!local || !domain) return null;
  if (/[\s<>()[\],;:"\\]/.test(local) || /[\s<>()[\],;:"\\/@]/.test(domain)) return null;
  if (!/^[\x21-\x7e]+$/.test(local)) return null; // non-ASCII local parts: not deliverable for practically all MX in DE
  if (!/^[\x21-\x7e]+$/.test(domain)) {
    try { domain = new URL(`http://${domain}`).hostname; } catch { return null; }
  }
  if (local.length > 64 || domain.length > 253) return null;
  if (local.length + 1 + domain.length > 254) return null;
  return { normalized: `${local}@${domain}`, local, domain };
}

export function checkSyntax(n: NormalizedEmail): boolean {
  if (!LOCAL_RE.test(n.local)) return false;
  const labels = n.domain.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) if (!LABEL_RE.test(l)) return false;
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld)) return false;
  return true;
}

export function classifyDomain(domain: string): DomainClass {
  if (isDisposableDomain(domain)) return 'disposable';
  if (FREEMAIL_DOMAINS.has(domain)) return 'freemail';
  return 'corporate';
}

export function isRoleAccount(local: string): boolean {
  const base = local.replace(/\+.*$/, ''); // info+tag@ → info
  return ROLE_LOCAL_PARTS.has(base);
}

const HARD_NO_MX = new Set<MxStatus>(['none', 'nxdomain', 'null_mx']);

function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p.then((v) => { clearTimeout(timer); return v; }, () => { clearTimeout(timer); return fallback; }), t]);
}

/** Stage 1 check. Never throws; DNS problems → mx 'error' / verdict 'unknown'. */
export async function checkFast(email: string, deps: EmailCheckDeps): Promise<EmailFastResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const base = { provider: 'native' as const, cached: false };
  const n = normalizeEmail(email);
  if (!n || !checkSyntax(n)) {
    return {
      ...base, verdict: 'undeliverable', flags: ['syntax_invalid'], latency_ms: now() - start,
      normalized: n?.normalized ?? null, local: n?.local ?? null, domain: n?.domain ?? null,
      domain_class: null, mx: null, hard_no_mx: false,
    };
  }
  const flags: EmailFlag[] = [];
  // Typo domains (distance 1 to gmail.com, web.de, …) sometimes sit on disposable blocklists (typo-squats).
  // A typo must never hard-reject a lead — the suggestion rescues it — so detect it BEFORE the disposable check.
  const typoOf = suggestDomain(n.domain, { maxDistance: 1 });
  const domainClass = typoOf ? 'corporate' : classifyDomain(n.domain);
  if (domainClass === 'disposable') flags.push('disposable');
  if (domainClass === 'freemail') flags.push('freemail');
  if (isRoleAccount(n.local)) flags.push('role_account');

  let mx: MxStatus | null = null;
  let verdict: EmailFastResult['verdict'] = 'unknown';
  let hardNoMx = false;
  if (domainClass !== 'disposable') {
    const res = await withBudget(deps.resolveMx(n.domain), deps.budgetMs ?? 1500, { status: 'error', hosts: [] } as MxLookupResult);
    mx = res.status;
    if (HARD_NO_MX.has(mx)) { flags.push('no_mx'); hardNoMx = true; verdict = 'undeliverable'; }
    else if (mx === 'a_only') { flags.push('no_mx'); }
    const suggestion = suggestDomain(n.domain, { mx });
    if (suggestion) flags.push('typo_suspected');
    return {
      ...base, verdict, flags, latency_ms: now() - start, normalized: n.normalized, local: n.local, domain: n.domain,
      domain_class: domainClass, mx, hard_no_mx: hardNoMx, ...(suggestion ? { suggestion: `${n.local}@${suggestion}` } : {}),
    };
  }
  return {
    ...base, verdict, flags, latency_ms: now() - start, normalized: n.normalized, local: n.local, domain: n.domain,
    domain_class: domainClass, mx, hard_no_mx: false,
  };
}
