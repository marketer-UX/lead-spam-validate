// Adapter for a Reacher backend (reacherhq/backend). AGPL-3.0 / commercial — only use with a license.
import type { EmailCheckResult, EmailFlag } from '../core/types.js';
import { errMsg, log } from '../server/log.js';
import { fetchJson, unknownResult, type DeepProvider } from './types.js';

export interface ReacherResult {
  is_reachable?: 'safe' | 'risky' | 'invalid' | 'unknown';
  syntax?: { is_valid_syntax?: boolean; suggestion?: string | null };
  mx?: { accepts_mail?: boolean };
  smtp?: { is_deliverable?: boolean; is_catch_all?: boolean; has_full_inbox?: boolean; is_disabled?: boolean; can_connect_smtp?: boolean };
  misc?: { is_disposable?: boolean; is_role_account?: boolean };
}

export function mapReacher(r: ReacherResult, latency_ms: number, raw?: unknown): EmailCheckResult {
  const flags: EmailFlag[] = [];
  let verdict: EmailCheckResult['verdict'] = 'unknown';
  if (r.syntax && r.syntax.is_valid_syntax === false) { verdict = 'undeliverable'; flags.push('syntax_invalid'); }
  else if (r.mx && r.mx.accepts_mail === false) { verdict = 'undeliverable'; flags.push('no_mx'); }
  else if (r.smtp?.is_catch_all === true) { verdict = 'catch_all'; flags.push('catch_all'); }
  else if (r.is_reachable === 'safe') verdict = 'valid';
  else if (r.is_reachable === 'risky' && r.smtp?.has_full_inbox) verdict = 'valid';
  else if (r.is_reachable === 'invalid') { verdict = 'undeliverable'; flags.push('undeliverable'); }
  if (r.smtp?.has_full_inbox) flags.push('full_inbox');
  if (r.smtp?.is_disabled) flags.push('disabled');
  if (r.misc?.is_disposable) flags.push('disposable');
  if (r.misc?.is_role_account) flags.push('role_account');
  const out: EmailCheckResult = { verdict, flags, provider: 'reacher', latency_ms };
  if (r.syntax?.suggestion) { out.suggestion = r.syntax.suggestion; flags.push('typo_suspected'); }
  if (raw !== undefined) out.raw = raw;
  return out;
}

export interface ReacherOptions { url: string; secret: string | null; fromEmail: string; helloName: string; timeoutMs?: number; debug?: boolean; fetchImpl?: typeof fetch }

export function makeReacherProvider(o: ReacherOptions): DeepProvider {
  const timeout = o.timeoutMs ?? 25_000;
  return {
    name: 'reacher',
    async checkDeep(email: string): Promise<EmailCheckResult> {
      const start = Date.now();
      try {
        const { status, body } = await fetchJson(`${o.url}/v0/check_email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(o.secret ? { 'x-reacher-secret': o.secret } : {}) },
          body: JSON.stringify({ to_email: email, from_email: o.fromEmail, hello_name: o.helloName }),
        }, timeout, o.fetchImpl);
        if (status !== 200 || !body || typeof body !== 'object') {
          log.warn('deep.reacher.bad_status', { status });
          return unknownResult('reacher', start);
        }
        return mapReacher(body as ReacherResult, Date.now() - start, o.debug ? body : undefined);
      } catch (e) {
        log.warn('deep.reacher.error', { err: errMsg(e) });
        return unknownResult('reacher', start);
      }
    },
    async health(): Promise<boolean | null> {
      try {
        const { status } = await fetchJson(`${o.url}/v0/check_email`, { method: 'GET' }, 5_000, o.fetchImpl);
        return status > 0 && status < 500;
      } catch { return false; }
    },
  };
}
