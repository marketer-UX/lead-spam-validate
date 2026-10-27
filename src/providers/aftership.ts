// Adapter for the Go deep-verifier (deep-verifier/, AfterShip email-verifier). Mapping: catch_all BEFORE deliverable.
import type { EmailCheckResult, EmailFlag } from '../core/types.js';
import { errMsg, log } from '../server/log.js';
import { fetchJson, unknownResult, type DeepProvider } from './types.js';

export interface AfterShipResult {
  email?: string;
  reachable?: string;
  syntax?: { username?: string; domain?: string; valid?: boolean };
  smtp?: { host_exists?: boolean; full_inbox?: boolean; catch_all?: boolean; deliverable?: boolean; disabled?: boolean } | null;
  suggestion?: string;
  disposable?: boolean;
  role_account?: boolean;
  free?: boolean;
  has_mx_records?: boolean;
}

export function mapAfterShip(r: AfterShipResult, latency_ms: number, raw?: unknown): EmailCheckResult {
  const flags: EmailFlag[] = [];
  let verdict: EmailCheckResult['verdict'] = 'unknown';
  if (r.syntax && r.syntax.valid === false) { verdict = 'undeliverable'; flags.push('syntax_invalid'); }
  // AfterShip short-circuits Verify() on disposable domains BEFORE the MX check (has_mx_records=false) → check disposable first.
  else if (r.disposable === true) { /* verdict stays unknown; 'disposable' flag added below */ }
  else if (r.has_mx_records === false) { verdict = 'undeliverable'; flags.push('no_mx'); }
  else if (r.smtp && typeof r.smtp === 'object') {
    if (r.smtp.catch_all === true) { verdict = 'catch_all'; flags.push('catch_all'); }
    else if (r.smtp.deliverable === true) verdict = 'valid';
    else if (r.smtp.deliverable === false) { verdict = 'undeliverable'; flags.push('undeliverable'); }
    if (r.smtp.full_inbox) flags.push('full_inbox');
    if (r.smtp.disabled) flags.push('disabled');
  }
  if (r.disposable) flags.push('disposable');
  if (r.role_account) flags.push('role_account');
  if (r.free) flags.push('freemail');
  const out: EmailCheckResult = { verdict, flags, provider: 'aftership', latency_ms };
  if (r.suggestion) { out.suggestion = r.suggestion; flags.push('typo_suspected'); }
  if (raw !== undefined) out.raw = raw;
  return out;
}

export interface AfterShipOptions { url: string; apiKey: string | null; timeoutMs?: number; debug?: boolean; fetchImpl?: typeof fetch }

export function makeAfterShipProvider(o: AfterShipOptions): DeepProvider {
  const timeout = o.timeoutMs ?? 27_000; // Go side caps at 25 s; stay above so its fail-open JSON wins over our abort
  return {
    name: 'aftership',
    async checkDeep(email: string): Promise<EmailCheckResult> {
      const start = Date.now();
      try {
        const { status, body } = await fetchJson(`${o.url}/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(o.apiKey ? { 'x-api-key': o.apiKey } : {}) },
          body: JSON.stringify({ email, mode: 'deep' }),
        }, timeout, o.fetchImpl);
        if (status !== 200 || !body || typeof body !== 'object') {
          log.warn('deep.aftership.bad_status', { status });
          return unknownResult('aftership', start);
        }
        const b = body as { result?: AfterShipResult; verdict?: string; error?: string };
        if (!b.result) { // fail-open shape from the Go handler
          log.info('deep.aftership.unknown', { error: (b.error ?? '').slice(0, 80) });
          return unknownResult('aftership', start, o.debug ? body : undefined);
        }
        return mapAfterShip(b.result, Date.now() - start, o.debug ? body : undefined);
      } catch (e) {
        log.warn('deep.aftership.error', { err: errMsg(e) });
        return unknownResult('aftership', start);
      }
    },
    async health(): Promise<boolean | null> {
      try {
        const { status, body } = await fetchJson(`${o.url}/health`, { method: 'GET' }, 5_000, o.fetchImpl);
        if (status !== 200 || !body || typeof body !== 'object') return false;
        const h = body as { ok?: boolean; smtp25?: boolean };
        if (typeof h.smtp25 === 'boolean') return h.smtp25;
        return h.ok === true ? null : false;
      } catch { return false; }
    },
  };
}
