// Forward a validated Webflow submission to the lead store intake.
import type { Config, SiteConfig } from './config.js';
import { errMsg, log } from './log.js';

export interface ForwardResult { ok: boolean; status: number; lead_id: string | null; error?: string; retryable: boolean }

export async function forwardLead(cfg: Config, site: SiteConfig, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<ForwardResult> {
  if (!cfg.forwardUrl || !site.forward_token) return { ok: false, status: 0, lead_id: null, error: 'forward_not_configured', retryable: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetchImpl(cfg.forwardUrl, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-source-token': site.forward_token, ...(site.forward_origin ? { origin: site.forward_origin } : {}) },
      body: JSON.stringify(body),
    });
    let j: { ok?: boolean; lead_id?: string; error?: string } = {};
    try { j = await r.json() as typeof j; } catch { /* non-json */ }
    if (r.status === 201 || r.status === 200) return { ok: true, status: r.status, lead_id: j.lead_id ?? null, retryable: false };
    log.warn('forward.rejected', { status: r.status, error: j.error ?? null });
    return { ok: false, status: r.status, lead_id: null, error: j.error ?? `http_${r.status}`, retryable: r.status >= 500 };
  } catch (e) {
    log.warn('forward.error', { err: errMsg(e) });
    return { ok: false, status: 0, lead_id: null, error: errMsg(e), retryable: true };
  } finally { clearTimeout(t); }
}
