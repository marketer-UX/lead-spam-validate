// In-memory Stage-2 queue: bounded (backpressure → skip = unknown), small concurrency, result → cache + lead store PATCH.
import type { EmailFastResult } from '../core/types.js';
import type { EmailCheckResult } from '../core/types.js';
import type { DeepProvider } from '../providers/types.js';
import type { TtlLru } from './cache.js';
import { errMsg, log } from './log.js';
import { EMAIL_TTL, mergeDeep } from './pipeline.js';

export interface DeepJob { email: string; hash: string; lead_id?: string | null; site?: string }

export interface QueueOptions {
  max: number;
  concurrency: number;
  forwardTarget?: { baseUrl: string; apiKey: string } | null;
  fetchImpl?: typeof fetch;
  onResult?: (job: DeepJob, result: EmailCheckResult) => void;
}

export class DeepQueue {
  private pending: DeepJob[] = [];
  private inFlight = new Set<string>();
  private running = 0;
  public stats = { enqueued: 0, skipped: 0, done: 0, unknown: 0, lead_patched: 0, lead_patch_failed: 0 };

  constructor(private provider: DeepProvider, private cache: TtlLru<string, EmailFastResult & { deep?: EmailCheckResult }>, private opts: QueueOptions) {}

  get size(): number { return this.pending.length; }
  get active(): number { return this.running; }

  enqueue(job: DeepJob): boolean {
    if (this.provider.name === 'none') return false;
    if (this.inFlight.has(job.hash) || this.pending.some((j) => j.hash === job.hash)) return false;
    if (this.pending.length >= this.opts.max) { this.stats.skipped++; log.warn('deep.queue.full', { size: this.pending.length }); return false; }
    this.pending.push(job);
    this.stats.enqueued++;
    queueMicrotask(() => this.pump());
    return true;
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running++;
      this.inFlight.add(job.hash);
      this.work(job).catch((e) => log.error('deep.queue.crash', { err: errMsg(e) })).finally(() => {
        this.running--; this.inFlight.delete(job.hash); this.pump();
      });
    }
  }

  private async work(job: DeepJob): Promise<void> {
    const deep = await this.provider.checkDeep(job.email);
    this.stats.done++;
    if (deep.verdict === 'unknown') this.stats.unknown++;
    const fast = this.cache.get(job.hash);
    if (fast) {
      const merged = mergeDeep(fast, deep);
      this.cache.set(job.hash, merged, EMAIL_TTL[merged.verdict]);
    }
    log.info('deep.result', { email_h: job.hash.slice(0, 12), verdict: deep.verdict, flags: deep.flags, provider: deep.provider, ms: deep.latency_ms, lead: !!job.lead_id });
    this.opts.onResult?.(job, deep);
    if (job.lead_id && this.opts.forwardTarget && deep.verdict !== 'unknown') await this.patchLead(job, deep);
  }

  private async patchLead(job: DeepJob, deep: EmailCheckResult): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const r = await f(`${this.opts.forwardTarget!.baseUrl}/api/leads/${encodeURIComponent(job.lead_id!)}/validation`, {
        method: 'PATCH', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.forwardTarget!.apiKey },
        body: JSON.stringify({ _validation: { v: 1, stage: 2, email_verdict: deep.verdict, email_flags: deep.flags, provider: deep.provider, checked_at: new Date().toISOString() } }),
      });
      if (r.ok) this.stats.lead_patched++; else { this.stats.lead_patch_failed++; log.warn('deep.lead_patch.bad_status', { status: r.status }); }
    } catch (e) {
      this.stats.lead_patch_failed++;
      log.warn('deep.lead_patch.error', { err: errMsg(e) });
    } finally { clearTimeout(t); }
  }
}
