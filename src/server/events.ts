// Push side: buffered, PII-free decision events → POST EVENTS_URL (batch ≤ 200, ≤ 256 KB).
// Never blocks a request, never throws: a full buffer drops the oldest events, a broken event sink backs off.
import type { Decision, TokenState, ValidateMode } from '../core/types.js';
import type { Config } from './config.js';
import { errMsg, log } from './log.js';

/** Exactly the contract fields — no email, no phone, no name, no IP. */
export interface LeadEvent {
  ts: string;
  rid: string;
  site: string;
  form: string | null;
  mode: ValidateMode;
  decision: Decision;
  reason: string | null;
  score: number;
  flags: string[];
  email_domain_class: string | null;
  email_tld: string | null;
  email_verdict: string | null;
  phone_type: string | null;
  phone_country: string | null;
  token: TokenState;
  blocked: boolean;
  /** ISO-3166-1 alpha-2 of the client IP, null when the edge reported none. Country only — no IP, no PII. */
  geo_country: string | null;
}

export interface EventSinkOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBuffer?: number;
  batchSize?: number;
  maxBatch?: number;
  maxBytes?: number;
  backoffMs?: number;
}

export interface EventStats { buffered: number; sent: number; dropped: number; failed: number }

const FLUSH_AT = 100;      // flush as soon as this many events are queued
const MAX_BATCH = 200;     // contract: ≤ 200 events per POST
const MAX_BYTES = 256 * 1024;
const MAX_BUFFER = 2000;
const BACKOFF_MS = 30_000;

export class EventSink {
  private cfg: Config;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxBuffer: number;
  private batchSize: number;
  private maxBatch: number;
  private maxBytes: number;
  private backoffMs: number;
  private buf: LeadEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private retryAfter = 0;
  private sent = 0;
  private dropped = 0;
  private failed = 0;

  constructor(cfg: Config, opts: EventSinkOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
    this.batchSize = opts.batchSize ?? FLUSH_AT;
    this.maxBatch = opts.maxBatch ?? MAX_BATCH;
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
    this.backoffMs = opts.backoffMs ?? BACKOFF_MS;
  }

  get configured(): boolean {
    return !!(this.cfg.eventsUrl && this.cfg.controlApiKey);
  }

  get stats(): EventStats {
    return { buffered: this.buf.length, sent: this.sent, dropped: this.dropped, failed: this.failed };
  }

  /** field-mode noise never leaves the box: only rejects/flagged field checks are interesting. */
  emit(e: LeadEvent): void {
    if (!this.configured) return;
    if (e.mode === 'field' && e.decision !== 'reject' && e.decision !== 'accept_flagged') return;
    this.buf.push(e);
    while (this.buf.length > this.maxBuffer) { this.buf.shift(); this.dropped++; }
    if (this.buf.length >= this.batchSize && !this.flushing && Date.now() >= this.retryAfter) {
      setTimeout(() => { void this.flushNow(); }, 0).unref?.();
    }
  }

  /** Flush one batch (tests await this; the interval and emit() fire it too). */
  async flushNow(now: number = Date.now()): Promise<void> {
    if (!this.configured || this.flushing || !this.buf.length || now < this.retryAfter) return;
    this.flushing = true;
    try {
      let batch = this.buf.slice(0, this.maxBatch);
      let body = JSON.stringify({ events: batch });
      while (body.length > this.maxBytes && batch.length > 1) {
        batch = batch.slice(0, Math.floor(batch.length / 2));
        body = JSON.stringify({ events: batch });
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let status = 0;
      try {
        const r = await this.fetchImpl(this.cfg.eventsUrl as string, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.controlApiKey as string },
          body,
        });
        status = r.status;
      } catch (e) {
        this.failed++;
        this.retryAfter = Date.now() + this.backoffMs;
        log.warn('events.flush_error', { err: errMsg(e), buffered: this.buf.length });
        return;
      } finally { clearTimeout(t); }

      if (status >= 500) {
        this.failed++;
        this.retryAfter = Date.now() + this.backoffMs;
        log.warn('events.flush_retry', { status, buffered: this.buf.length });
        return;
      }
      // 2xx and 4xx alike: this batch is done. 4xx/202 means the event sink did not store it — dropping
      // is deliberate (a rejected batch would loop forever).
      this.buf.splice(0, batch.length);
      if (status === 200) this.sent += batch.length;
      else {
        this.dropped += batch.length;
        if (status !== 202) log.warn('events.batch_rejected', { status, n: batch.length });
      }
    } finally { this.flushing = false; }
  }

  start(): void {
    if (!this.configured || this.timer) return;
    this.timer = setInterval(() => { void this.flushNow(); }, Math.max(1, this.cfg.eventsFlushS) * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
