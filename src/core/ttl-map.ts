/**
 * TtlMap — Map with per-entry time-to-live expiry.
 *
 * Entries are evicted lazily on `get()` / `has()` when their TTL has elapsed.
 * The TTL is reset on every `set()` call for the same key, so actively-used
 * entries never expire.
 *
 * Intended as a drop-in replacement for the built-in `Map` in places where
 * stale entries should be reclaimed automatically (e.g. in-process session
 * caches that should not grow indefinitely across long-running daemons).
 */

export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;
