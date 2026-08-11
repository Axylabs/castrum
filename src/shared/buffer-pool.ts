// src/shared/buffer-pool.ts — generic reusable byte-buffer pool for hot-path FFI calls.
//
// Hot native-FFI paths (e.g. the ingress pipeline) write into large output
// buffers. Allocating a fresh buffer per call is a measurable cost at high
// request rates. This pool hands out buffers that are returned to the pool
// once the consumer is done with them, eliminating steady-state allocation.
//
// It is deliberately generic: it works with any `Uint8Array` consumer, is safe
// for a single-threaded event loop, and supports both eager release (callers
// that copy out immediately) and in-flight borrowing (zero-copy callers that
// hold the buffer past the call). Memory is bounded by `maxBuffers` retained
// buffers; under heavy concurrency, extra temporary buffers are allocated and
// discarded on release.

export interface BufferPoolOptions {
  /**
   * Initial buffer size in bytes. Default: 131072.
   */
  initialSize?: number;
  /**
   * Upper bound on buffers retained by the pool. When this is reached and no
   * free buffer is large enough, the largest free buffer is grown in place
   * (replaced) so memory stays bounded. If the pool is fully in-flight, a
   * temporary buffer is allocated and discarded on release. Default: 16.
   */
  maxBuffers?: number;
  /**
   * Hard cap on the number of buffers simultaneously in flight (acquired but
   * not yet released). When exceeded, `acquire()` throws a `RangeError` — a
   * backpressure signal for zero-copy responses consumed too slowly. 0
   * (default) is unlimited: when the retained set is exhausted, temporary
   * buffers are allocated and discarded on release (unbounded under a slow
   * zero-copy consumer — set this to bound it).
   */
  maxInFlight?: number;
}

export interface PooledBuffer {
  /**
   * The underlying buffer. Its byteLength is guaranteed to be at least the
   * `minSize` requested at acquire time.
   */
  readonly buffer: Uint8Array;
  /**
   * Whether this handle has already been returned to the pool.
   */
  readonly released: boolean;
  /**
   * Return the buffer to the pool for reuse. Safe to call more than once;
   * subsequent calls are no-ops.
   */
  release(): void;
}

/**
 * A pool of reusable `Uint8Array` buffers.
 *
 * @example
 * ```ts
 * const pool = new BufferPool({ initialSize: 131072 });
 *
 * const handle = pool.acquire(131072);
 * try {
 *   // write into handle.buffer ...
 *   useBytes(handle.buffer.subarray(0, written));
 * } finally {
 *   handle.release();
 * }
 * ```
 */
export class BufferPool {
  private readonly free: Uint8Array[] = [];
  private readonly initialSize: number;
  private readonly maxBuffers: number;
  private readonly maxInFlight: number;
  private created = 0;
  private inFlight = 0;

  constructor(options: BufferPoolOptions = {}) {
    this.initialSize = Math.max(1, Math.floor(options.initialSize ?? 131_072));
    this.maxBuffers = Math.max(1, Math.floor(options.maxBuffers ?? 16));
    this.maxInFlight = Math.max(0, Math.floor(options.maxInFlight ?? 0));
    this.free.push(new Uint8Array(this.initialSize));
    this.created = 1;
  }

  /** Number of buffers currently available for immediate reuse. */
  get freeCount(): number {
    return this.free.length;
  }

  /** Total number of buffers this pool has allocated (monotonic). */
  get createdCount(): number {
    return this.created;
  }

  /**
   * Acquire a buffer of at least `minSize` bytes. The returned handle must be
   * released (directly, or via a zero-copy Response) once the caller is done.
   *
   * @param minSize - Minimum buffer size in bytes. Default: 0 (any free buffer).
   * @throws RangeError when `maxInFlight` is set and that many buffers are
   *   already borrowed (never released).
   */
  acquire(minSize = 0): PooledBuffer {
    if (this.maxInFlight > 0 && this.inFlight >= this.maxInFlight) {
      throw new RangeError(
        `BufferPool: maxInFlight (${this.maxInFlight}) exceeded — too many ` +
          "buffers borrowed at once (unreleased zero-copy responses?). " +
          "Raise maxInFlight or consume/release responses faster.",
      );
    }
    const buffer = this.take(Math.max(0, Math.floor(minSize)));
    this.inFlight++;
    let released = false;

    return {
      buffer,
      get released(): boolean {
        return released;
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.inFlight--;
        this.releaseBuffer(buffer);
      },
    };
  }

  /** Take a buffer of at least `minSize` bytes out of circulation. */
  private take(minSize: number): Uint8Array {
    // 1) Reuse a free buffer that is already large enough.
    for (let i = 0; i < this.free.length; i++) {
      const candidate = this.free[i] as Uint8Array;
      if (candidate.byteLength >= minSize) {
        this.free.splice(i, 1);
        return candidate;
      }
    }

    const target = this.nextSize(minSize);

    // 2) No free buffer is large enough: grow the largest free buffer in place
    //    to keep the number of retained buffers bounded.
    let largestBuf: Uint8Array | null = null;
    let largest = -1;
    for (let i = 0; i < this.free.length; i++) {
      const candidate = this.free[i] as Uint8Array;
      if (largestBuf === null || candidate.byteLength > largestBuf.byteLength) {
        largestBuf = candidate;
        largest = i;
      }
    }
    if (largestBuf !== null) {
      this.free.splice(largest, 1);
      this.created++;
      return new Uint8Array(target);
    }

    // 3) Pool exhausted (all buffers in flight): allocate a fresh buffer.
    this.created++;
    return new Uint8Array(target);
  }

  /** Return a buffer to the free list, bounding total retained memory. */
  private releaseBuffer(buffer: Uint8Array): void {
    if (this.free.length >= this.maxBuffers) {
      // Free list is full: drop the smallest retained buffer to stay bounded.
      let smallestBuf: Uint8Array | null = null;
      let smallest = 0;
      for (let i = 0; i < this.free.length; i++) {
        const candidate = this.free[i] as Uint8Array;
        if (
          smallestBuf === null ||
          candidate.byteLength < smallestBuf.byteLength
        ) {
          smallestBuf = candidate;
          smallest = i;
        }
      }
      this.free.splice(smallest, 1);
    }
    this.free.push(buffer);
  }

  private nextSize(minSize: number): number {
    return Math.max(this.initialSize, minSize);
  }
}
