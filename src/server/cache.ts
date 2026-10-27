// Tiny TTL + LRU cache (Map keeps insertion order; re-insert on get → LRU). Lazy expiry + evict oldest at capacity.
export class TtlLru<K, V> {
  private map = new Map<K, { v: V; exp: number }>();
  constructor(private readonly max: number) {}

  get(key: K, now: number = Date.now()): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= now) { this.map.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  has(key: K, now: number = Date.now()): boolean { return this.get(key, now) !== undefined; }
  set(key: K, v: V, ttlMs: number, now: number = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v, exp: now + ttlMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: K): void { this.map.delete(key); }
  get size(): number { return this.map.size; }
  sweep(now: number = Date.now()): number {
    let n = 0;
    for (const [k, e] of this.map) if (e.exp <= now) { this.map.delete(k); n++; }
    return n;
  }
  clear(): void { this.map.clear(); }
}

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
