import { describe, expect, it } from 'vitest';
import { EventSink, type LeadEvent } from '../src/server/events.js';
import { loadConfig } from '../src/server/config.js';
import { baseEnv } from './helpers.js';

const EVENTS_URL = 'https://control.test/api/lead-validate/events';

type Batch = { url: string; headers: Record<string, string>; events: LeadEvent[] };

function ev(over: Partial<LeadEvent> = {}): LeadEvent {
  return {
    ts: '2026-08-23T10:00:00.000Z', rid: 'r-' + Math.random().toString(36).slice(2), site: 'demo', form: 'Kontaktformular',
    mode: 'submit', decision: 'reject', reason: 'email_disposable', score: 40, flags: ['disposable'],
    email_domain_class: 'disposable', email_tld: 'com', email_verdict: 'unknown',
    phone_type: null, phone_country: null, token: 'ok', blocked: true, ...over,
  };
}

function sink(statuses: number[], env: NodeJS.ProcessEnv = {}, opts = {}) {
  const batches: Batch[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    batches.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, events: JSON.parse(String(init?.body)).events });
    if (status === 0) throw new Error('ECONNREFUSED');
    return new Response(status === 204 ? null : JSON.stringify({ ok: true, stored: status === 200, received: 1 }), { status });
  }) as unknown as typeof fetch;
  const cfg = loadConfig({ ...baseEnv, EVENTS_URL: EVENTS_URL, ...env });
  return { batches, s: new EventSink(cfg, { fetchImpl, timeoutMs: 50, ...opts }) };
}

describe('EventSink', () => {
  it('posts a batch with the api key and counts sent', async () => {
    const { batches, s } = sink([200]);
    s.emit(ev());
    s.emit(ev({ decision: 'accept', reason: null, blocked: false }));
    expect(s.stats.buffered).toBe(2);
    await s.flushNow();
    expect(batches).toHaveLength(1);
    expect(batches[0].url).toBe(EVENTS_URL);
    expect(batches[0].headers['x-api-key']).toBe('control-key');
    expect(batches[0].events).toHaveLength(2);
    expect(s.stats).toMatchObject({ buffered: 0, sent: 2, dropped: 0, failed: 0 });
  });

  it('field mode only reaches the event sink when it was rejected or flagged', () => {
    const { s } = sink([200]);
    s.emit(ev({ mode: 'field', decision: 'accept', reason: null }));
    expect(s.stats.buffered).toBe(0);
    s.emit(ev({ mode: 'field', decision: 'accept_flagged' }));
    s.emit(ev({ mode: 'field', decision: 'reject' }));
    s.emit(ev({ mode: 'webhook', decision: 'accept', reason: null }));
    expect(s.stats.buffered).toBe(3);
  });

  it('carries no PII — only the contract keys', async () => {
    const { batches, s } = sink([200]);
    s.emit(ev());
    await s.flushNow();
    expect(Object.keys(batches[0].events[0]).sort()).toEqual([
      'blocked', 'decision', 'email_domain_class', 'email_tld', 'email_verdict', 'flags', 'form', 'mode',
      'phone_country', 'phone_type', 'reason', 'rid', 'score', 'site', 'token', 'ts',
    ]);
  });

  it('5xx keeps the batch and backs off, then retries', async () => {
    const { batches, s } = sink([500, 200], {}, { backoffMs: 30 });
    s.emit(ev());
    await s.flushNow();
    expect(s.stats).toMatchObject({ buffered: 1, sent: 0, failed: 1 });
    await s.flushNow(); // inside the backoff window → no call
    expect(batches).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 40));
    await s.flushNow();
    expect(batches).toHaveLength(2);
    expect(s.stats).toMatchObject({ buffered: 0, sent: 1, failed: 1 });
  });

  it('network error behaves like 5xx (kept + backoff)', async () => {
    const { s } = sink([0], {}, { backoffMs: 10 });
    s.emit(ev());
    await s.flushNow();
    expect(s.stats).toMatchObject({ buffered: 1, failed: 1, sent: 0 });
  });

  it('4xx and 202 drop the batch (no retry loop)', async () => {
    const { batches, s } = sink([400]);
    s.emit(ev());
    await s.flushNow();
    expect(s.stats).toMatchObject({ buffered: 0, sent: 0, dropped: 1 });
    const two = sink([202]);
    two.s.emit(ev());
    await two.s.flushNow();
    expect(two.s.stats).toMatchObject({ buffered: 0, sent: 0, dropped: 1 });
    expect(batches).toHaveLength(1);
  });

  it('buffer cap drops the oldest events', () => {
    const { s } = sink([200], {}, { maxBuffer: 3, batchSize: 99 });
    for (let i = 0; i < 5; i++) s.emit(ev({ rid: `r${i}` }));
    expect(s.stats).toMatchObject({ buffered: 3, dropped: 2 });
  });

  it('never posts more than 200 events per batch', async () => {
    const { batches, s } = sink([200, 200], {}, { batchSize: 9999 });
    for (let i = 0; i < 250; i++) s.emit(ev({ rid: `r${i}` }));
    await s.flushNow();
    expect(batches[0].events).toHaveLength(200);
    expect(s.stats.buffered).toBe(50);
    await s.flushNow();
    expect(batches[1].events).toHaveLength(50);
  });

  it('splits a batch that would exceed 256 KB', async () => {
    const { batches, s } = sink([200, 200], {}, { batchSize: 9999, maxBytes: 4000 });
    for (let i = 0; i < 40; i++) s.emit(ev({ rid: `r${i}` }));
    await s.flushNow();
    expect(batches[0].events.length).toBeLessThan(40);
    expect(JSON.stringify({ events: batches[0].events }).length).toBeLessThanOrEqual(4000);
  });

  it('reaching the flush threshold pushes without waiting for the interval', async () => {
    const { batches, s } = sink([200], {}, { batchSize: 2 });
    s.emit(ev());
    s.emit(ev());
    await new Promise((r) => setTimeout(r, 10));
    expect(batches).toHaveLength(1);
    expect(s.stats.sent).toBe(2);
  });

  it('without EVENTS_URL emit() is a no-op', async () => {
    const { batches, s } = sink([200], { EVENTS_URL: '' });
    expect(s.configured).toBe(false);
    s.emit(ev());
    await s.flushNow();
    expect(batches).toHaveLength(0);
    expect(s.stats).toEqual({ buffered: 0, sent: 0, dropped: 0, failed: 0 });
  });

  it('start()/stop() flush on the interval', async () => {
    const { batches, s } = sink([200], { EVENTS_FLUSH_S: '1' }, { batchSize: 9999 });
    s.emit(ev());
    s.start();
    await new Promise((r) => setTimeout(r, 1100));
    expect(batches).toHaveLength(1);
    s.stop();
    s.emit(ev());
    await new Promise((r) => setTimeout(r, 1100));
    expect(batches).toHaveLength(1);
  });
});
