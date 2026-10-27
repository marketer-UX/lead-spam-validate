import type { EmailCheckResult } from '../core/types.js';

export interface DeepProvider {
  readonly name: 'none' | 'aftership' | 'reacher';
  /** Stage 2 (SMTP). MUST never throw — errors become verdict 'unknown'. */
  checkDeep(email: string): Promise<EmailCheckResult>;
  /** null = unknown/not applicable, true/false = provider health (incl. port-25 reachability when reported). */
  health(): Promise<boolean | null>;
}

export function unknownResult(provider: EmailCheckResult['provider'], start: number, raw?: unknown): EmailCheckResult {
  return { verdict: 'unknown', flags: [], provider, latency_ms: Date.now() - start, ...(raw !== undefined ? { raw } : {}) };
}

export async function fetchJson(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, signal: ctrl.signal });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}
