// src/loader/batch.ts — Microtask coalescer + bounded LRU cache.
//
// The coalescer is the DataLoader-style engine: N `load()` calls made within
// the same event-loop tick are grouped by op and flushed together in ONE
// packed native batch call (reducing N native crossings → 1). The cache is a
// bounded LRU (default key = fnv1a64 of the input) for repeated-key hot loads.

/** A pending `load()` request inside a coalescing tick. */
export interface LoadRequest {
  input: Uint8Array;
  resolve(value: unknown): void;
  reject(err: unknown): void;
  /** Cache key (only set when caching is enabled for this request). */
  key?: string | bigint;
}

/** Bounded LRU cache used by the loader (Hot Function Cache). */
export interface LoaderCache {
  get(key: string | bigint): unknown;
  set(key: string | bigint, value: unknown): void;
  clear(): void;
  readonly size: number;
  readonly evictions: number;
  readonly hits: number;
}

/** A cache that never stores anything (maxKeys <= 0). */
const NULL_CACHE: LoaderCache = {
  get: () => undefined,
  set: () => {},
  clear: () => {},
  size: 0,
  evictions: 0,
  hits: 0,
};

/**
 * Bounded LRU cache. `maxKeys <= 0` disables caching entirely.
 * LRU order is maintained by delete+re-insert on access (Map order).
 */
export function createLruCache(maxKeys: number): LoaderCache {
  if (maxKeys <= 0) return NULL_CACHE;
  const map = new Map<string | bigint, unknown>();
  let evictions = 0;
  let hits = 0;

  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      hits++;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > maxKeys) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
          map.delete(oldest);
          evictions++;
        }
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
    get evictions() {
      return evictions;
    },
    get hits() {
      return hits;
    },
  };
}

/**
 * Per-tick coalescer. `enqueue` schedules a single `queueMicrotask` flush that
 * drains ALL pending ops; the flush callback receives one group per op.
 */
export interface TickCoalescer {
  enqueue(op: string, request: LoadRequest): void;
  /** Number of requests not yet flushed. */
  readonly pending: number;
}

export function createTickCoalescer(
  flush: (op: string, requests: LoadRequest[]) => void,
): TickCoalescer {
  let buffer = new Map<string, LoadRequest[]>();
  let scheduled = false;
  let pending = 0;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const snapshot = buffer;
      buffer = new Map();
      pending = 0;
      for (const [op, requests] of snapshot) {
        if (requests.length > 0) flush(op, requests);
      }
    });
  }

  return {
    enqueue(op, request) {
      let list = buffer.get(op);
      if (!list) {
        list = [];
        buffer.set(op, list);
      }
      list.push(request);
      pending++;
      schedule();
    },
    get pending() {
      return pending;
    },
  };
}
