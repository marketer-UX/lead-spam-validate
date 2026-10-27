// Typo suggestion for the domain part ("Did you mean k.mueller@gmail.com?"). Never blocks — suggestion only.
import { KNOWN_GOOD_DOMAINS, SUGGEST_DOMAINS } from './lists/de-domains.js';
import type { MxStatus } from './types.js';

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition = 1), so `gamil.com` → `gmail.com` is 1. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

export interface SuggestOptions {
  /** MX status of the typed domain; distance-2 suggestions only when the typed domain has no MX / is unknown. */
  mx?: MxStatus | null;
  candidates?: readonly string[];
  /** 1 = only distance-1 suggestions (used to detect typo domains before the disposable check) */
  maxDistance?: 1 | 2;
}

const NO_MX_FOR_SUGGEST = new Set<MxStatus>(['none', 'nxdomain', 'null_mx', 'error']);

/** Returns the suggested domain or null. Rules: typed ∉ known-good; d=1 → suggest; d=2 → only if len ≥ 8 and no/unknown MX. */
export function suggestDomain(domain: string, opts: SuggestOptions = {}): string | null {
  const typed = domain.toLowerCase();
  if (!typed || KNOWN_GOOD_DOMAINS.has(typed)) return null;
  const candidates = opts.candidates ?? SUGGEST_DOMAINS;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    // cheap length gate: distance >= |len diff|
    if (Math.abs(c.length - typed.length) > 2) continue;
    const d = levenshtein(typed, c);
    if (d < bestD) { bestD = d; best = c; if (d === 1) break; }
  }
  if (!best) return null;
  if (bestD === 1) return best;
  if ((opts.maxDistance ?? 2) < 2) return null;
  if (bestD === 2 && typed.length >= 8) {
    const mx = opts.mx ?? null;
    if (mx === null || NO_MX_FOR_SUGGEST.has(mx)) return best;
  }
  return null;
}

/** Convenience: full address suggestion. */
export function suggestEmail(local: string, domain: string, opts: SuggestOptions = {}): string | null {
  const s = suggestDomain(domain, opts);
  return s ? `${local}@${s}` : null;
}
