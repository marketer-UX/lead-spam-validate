// Fixed-window counters (same shape as the lead store checkRateLimit) + periodic sweep so the map cannot grow forever.
type Bucket = { count: number; windowStart: number; windowMs: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): { ok: boolean; remaining: number; resetAt: number; count: number } {
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) b = { count: 0, windowStart: now, windowMs };
  b.count += 1;
  buckets.set(key, b);
  return { ok: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.windowStart + windowMs, count: b.count };
}

/** Read-only peek (no increment) — used for "would this exceed" checks. */
export function peekRateLimit(key: string, now: number = Date.now()): number {
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= b.windowMs) return 0;
  return b.count;
}

export function sweepRateLimits(now: number = Date.now()): number {
  let n = 0;
  for (const [k, b] of buckets) if (now - b.windowStart >= b.windowMs) { buckets.delete(k); n++; }
  return n;
}

export function resetRateLimits(): void { buckets.clear(); }
