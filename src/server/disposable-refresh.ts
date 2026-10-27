// Periodic refresh of the disposable list (like AfterShip's EnableAutoUpdateDisposable). Failures are logged, never fatal.
import { addDisposableDomains, DISPOSABLE_DOMAINS } from '../core/lists/disposable.js';
import { errMsg, log } from './log.js';

export async function refreshDisposable(url: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const text = await r.text();
    const added = addDisposableDomains(text.split('\n'));
    log.info('disposable.refreshed', { added, total: DISPOSABLE_DOMAINS.size });
    return added;
  } catch (e) {
    log.warn('disposable.refresh_failed', { err: errMsg(e) });
    return 0;
  } finally { clearTimeout(t); }
}

export function scheduleDisposableRefresh(url: string | null, hours: number): void {
  if (!url) return;
  const run = () => { void refreshDisposable(url); };
  setTimeout(run, 5_000).unref();
  setInterval(run, Math.max(1, hours) * 60 * 60 * 1000).unref();
}
