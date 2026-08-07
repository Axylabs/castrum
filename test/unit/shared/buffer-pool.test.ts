/**
 * Tests for src/shared/buffer-pool.ts
 *
 * Covers:
 * - acquire/release lifecycle and idempotent release
 * - buffer sizes meet the requested minimum
 * - reuse of the same underlying buffer after release
 * - in-flight tracking (acquire never returns the same buffer twice)
 * - growth when a larger buffer is requested
 * - bounded retention (maxBuffers)
 */

import { describe, test, expect } from "bun:test";
import { BufferPool } from "../../../src/shared/buffer-pool";

describe("BufferPool", () => {
  test("acquire returns a buffer of at least the requested size", () => {
    const pool = new BufferPool({ initialSize: 64 });
    const h = pool.acquire(128);
    expect(h.buffer.byteLength).toBeGreaterThanOrEqual(128);
    expect(h.released).toBe(false);
    h.release();
    expect(h.released).toBe(true);
  });

  test("acquire(0) returns at least the initial size", () => {
    const pool = new BufferPool({ initialSize: 4096 });
    const h = pool.acquire();
    expect(h.buffer.byteLength).toBeGreaterThanOrEqual(4096);
    h.release();
  });

  test("release is idempotent and returns the buffer once", () => {
    const pool = new BufferPool({ initialSize: 64 });
    const h = pool.acquire();
    h.release();
    h.release();
    h.release();
    expect(h.released).toBe(true);
    expect(pool.freeCount).toBe(1);
  });

  test("reuses the same underlying buffer after release", () => {
    const pool = new BufferPool({ initialSize: 64 });
    const a = pool.acquire();
    const first = a.buffer;
    a.release();

    const second = pool.acquire();
    expect(second.buffer).toBe(first);
    second.release();
  });

  test("never hands out the same buffer twice while in flight", () => {
    const pool = new BufferPool({ initialSize: 64, maxBuffers: 3 });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    const buffers = new Set([a.buffer, b.buffer, c.buffer]);
    expect(buffers.size).toBe(3);
    expect(pool.freeCount).toBe(0);
    a.release();
    b.release();
    c.release();
    expect(pool.freeCount).toBe(3);
  });

  test("grows when a larger buffer is requested and retains it", () => {
    const pool = new BufferPool({ initialSize: 64 });
    const a = pool.acquire(8192);
    expect(a.buffer.byteLength).toBeGreaterThanOrEqual(8192);
    a.release();

    const b = pool.acquire(8192);
    expect(b.buffer.byteLength).toBeGreaterThanOrEqual(8192);
    b.release();
  });

  test("falls back to a smaller free buffer when it is large enough", () => {
    const pool = new BufferPool({ initialSize: 64 });
    const big = pool.acquire(2048);
    expect(big.buffer.byteLength).toBeGreaterThanOrEqual(2048);
    big.release();

    // A small acquire should reuse the big buffer (first-fit) — still valid.
    const small = pool.acquire(16);
    expect(small.buffer.byteLength).toBeGreaterThanOrEqual(16);
    small.release();
  });

  test("bounds the retained free list to maxBuffers", () => {
    const pool = new BufferPool({ initialSize: 16, maxBuffers: 2 });
    const a = pool.acquire();
    const b = pool.acquire();
    a.release();
    b.release();
    expect(pool.freeCount).toBe(2);

    // A third acquire+release keeps the free list at maxBuffers.
    const c = pool.acquire();
    c.release();
    expect(pool.freeCount).toBeLessThanOrEqual(2);
  });

  test("released buffers are reusable for a later acquire", () => {
    const pool = new BufferPool({ initialSize: 64, maxBuffers: 2 });
    const a = pool.acquire();
    a.release();
    const b = pool.acquire();
    expect(b.released).toBe(false);
    expect(b.buffer).toBe(a.buffer);
    b.release();
  });
});
