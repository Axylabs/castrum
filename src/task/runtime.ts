// src/task/runtime.ts — Bun-first off-thread task runtime (impure boundary).
//
// Submits a named native op to the Rust task pool and resolves a JS promise
// when it finishes. The JS thread NEVER blocks: the pool pushes completions
// into a native ring and rings ONE thread-safe doorbell per batch, so a burst
// of tasks costs one crossing instead of one per task.
//
// Bun is the primary transport (`bun:ffi` + `JSCallback({threadsafe:true})`).
// On Node — or when `CASTRUM_FFI_MODE=napi` disables the ffi layer — the op
// runs synchronously on the caller thread; true Node offload needs the napi
// `AsyncTask` bridge (see docs/RND-CONCURRENCY.md, milestone M2).
//
// Side effects (doorbell registration, pooled drain buffer, in-flight map) are
// deliberately contained to this module, matching the repo's purity policy.

import { decodeUtf8 } from '../shared/codec'
import { isBun } from '../shared/runtime'
import { getBunFFI } from '../native/ffi'
import {
  TASK_OP,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_OK,
  TASK_STATUS_TOO_SMALL,
  TASK_STATUS_UNSUPPORTED,
  brotliCapacityGuess,
  encodeArgon2VerifyArgs,
  encodeBrotliDecompressArgs,
  encodeGzipCompressHeader,
  encodeGzipDecompressArgs,
  encodePbkdf2Args,
} from './op'

/** Per-call options for an offloaded task. */
export interface TaskRunOptions {
  /** Abort the task; it completes with a cancelled error. */
  signal?: AbortSignal
  /** Decompress ops: output cap in bytes (default native 64 MiB bomb cap). */
  maxDecompressed?: number
  /** `gzipCompress` only: deflate level `0`-`9` (default `6`). */
  level?: number
}

/** Options for {@link TaskRuntime.pbkdf2Sha256}. */
export interface Pbkdf2RunOptions extends TaskRunOptions {
  /** Iteration count (clamped to >= 1 natively). */
  rounds: number
  /** Derived-key length in bytes (default 32). */
  dkLen?: number
}

/** Runtime introspection snapshot. */
export interface TaskStats {
  /** Pool worker count (0 when the pool has not started). */
  threads: number
  /** Finished-but-undrained completions in the native ring. */
  pending: number
  /** JS promises currently awaiting a completion. */
  inflight: number
  /** Completions resolved since the runtime was created. */
  completed: number
  /** Drain rounds run on the JS thread (one per doorbell, plus coalesced work). */
  drains: number
  /** Largest number of completions carried by a single drain round. */
  maxBatch: number
  /** Zero-copy attempts that had to retry at the exact needed size. */
  tooSmallRetries: number
}

/** Off-thread task runtime handle. */
export interface TaskRuntime {
  /** gzip-decompress `data` on a pool thread (keeps the 64 MiB bomb cap). */
  gzipDecompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>
  /** brotli-decompress `data` on a pool thread (keeps the 64 MiB bomb cap). */
  brotliDecompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>
  /** gzip-compress `data` on a pool thread. */
  gzipCompress(data: Uint8Array, options?: TaskRunOptions): Promise<Uint8Array>
  /** Verify a password against a PHC string on a pool thread (10-200 ms CPU). */
  argon2Verify(
    password: Uint8Array,
    phc: Uint8Array,
    options?: TaskRunOptions,
  ): Promise<boolean>
  /** PBKDF2-HMAC-SHA256 on a pool thread (10-200 ms CPU, 1-64 B output). */
  pbkdf2Sha256(
    password: Uint8Array,
    salt: Uint8Array,
    options: Pbkdf2RunOptions,
  ): Promise<Uint8Array>
  /** Pool / ring / in-flight counters. */
  stats(): TaskStats
  /** Cancel everything in flight, stop the pool, release the doorbell. */
  shutdown(): void
}

/** Options for {@link createTaskRuntime}. */
export interface TaskRuntimeOptions {
  /** Pool worker count; `0`/omitted → native default (cores − 1). */
  threads?: number
}

interface Deferred {
  /** Set for zero-copy tasks: the JS-owned destination the pool thread writes. */
  out: Uint8Array | null
  /**
   * Set for zero-copy-INPUT tasks: the payload the pool thread reads in place.
   * Holding it here is what keeps it alive (and un-moved) until the completion
   * drains — without it the GC could free it under a running worker.
   */
  keep: Uint8Array | null
  resolve: (value: Uint8Array) => void
  reject: (reason: unknown) => void
}

/**
 * Read a little-endian u64 at `off` as a JS number, without allocating.
 * `getBigUint64` would box a BigInt per call; two u32 reads are exact for any
 * value below 2^53, which covers ids (a JS counter) and byte counts.
 */
function readU64At(view: DataView, off: number): number {
  return view.getUint32(off, true) + view.getUint32(off + 4, true) * 4294967296
}

/**
 * Materialize a completion body out of the drain buffer. A pooled buffer is
 * reused, so its body must be COPIED; a fresh large buffer is not reused, so a
 * view into it is free.
 */
function bodyOf(buf: Uint8Array, off: number, len: number, pooled: boolean): Uint8Array {
  return pooled ? buf.slice(off, off + len) : buf.subarray(off, off + len)
}

/** The zero-copy destination was too small; `needed` is the exact size. */
type TooSmallError = Error & { needed: number }

function tooSmallError(needed: number): TooSmallError {
  const err = new Error('task output buffer too small') as TooSmallError
  err.name = 'TaskTooSmallError'
  err.needed = needed
  return err
}

function isTooSmall(err: unknown): err is TooSmallError {
  return err instanceof Error && err.name === 'TaskTooSmallError'
}

/** The op has no zero-copy form (older addon) — use the copy path. */
function unsupportedError(): Error {
  const err = new Error('task op has no zero-copy form')
  err.name = 'TaskUnsupportedError'
  return err
}

function cancelledError(): Error {
  const err = new Error('task cancelled')
  err.name = 'TaskCancelledError'
  return err
}

/** Bunny-shaped doorbell handle (structural, so it needs no bun-types dep). */
interface Doorbell {
  ptr: number | null
  close(): void
}

/**
 * Process-wide singleton. The native pool, the completion ring, and the
 * doorbell are ONE per process, so multiple runtimes would each register a
 * doorbell and drain — and drop — each other's completions. `options` applies
 * to the first call only; later calls return the same handle.
 */
let shared: TaskRuntime | null = null

/**
 * Get the off-thread task runtime (created on first use, then shared). Binds
 * the Bun ffi surface lazily.
 *
 * @example
 * ```ts
 * const tasks = createTaskRuntime()
 * const out = await tasks.gzipDecompress(compressed)
 * ```
 */
export function createTaskRuntime(options: TaskRuntimeOptions = {}): TaskRuntime {
  if (shared) return shared
  const boundFfi = isBun() ? getBunFFI() : null

  if (!boundFfi) {
    // Node / napi fallback: synchronous on the caller thread. Imported lazily
    // so the Bun path never pulls the napi client into the hot module graph.
    const fallback: TaskRuntime = {
      async gzipDecompress(data, runOptions) {
        const { rust } = await import('../rust-ffi')
        return rust.gzipDecompress(data, runOptions?.maxDecompressed)
      },
      async pbkdf2Sha256(password, salt, runOptions) {
        const { rust } = await import('../rust-ffi')
        return rust.pbkdf2Sha256(password, salt, runOptions.rounds, runOptions.dkLen ?? 32)
      },
      async brotliDecompress(data, runOptions) {
        const { rust } = await import('../rust-ffi')
        return rust.brotliDecompress(data, runOptions?.maxDecompressed ?? null)
      },
      async gzipCompress(data, runOptions) {
        const { rust } = await import('../rust-ffi')
        return rust.gzipCompress(data, runOptions?.level ?? null)
      },
      async argon2Verify(password, phc) {
        const { rust } = await import('../rust-ffi')
        return rust.passwordVerify(password, phc)
      },
      stats: () => ({
        threads: 0,
        pending: 0,
        inflight: 0,
        completed: 0,
        drains: 0,
        maxBatch: 0,
        tooSmallRetries: 0,
      }),
      shutdown: () => {},
    }
    shared = fallback
    return fallback
  }

  // Bind to a non-null local so the nested closures keep the narrowing.
  const ffi = boundFfi
  ffi.taskInit(options.threads ?? 0)

  const inflight = new Map<number, Deferred>()
  let nextId = 1
  let drainBuf = new Uint8Array(64 * 1024)
  // A batch needing more than this grows the pooled buffer; anything larger
  // gets a fresh exact-sized buffer handed out as subarray views (one JS-side
  // copy instead of two + less GC churn).
  const MAX_POOLED_DRAIN = 256 * 1024
  // Outputs at least this big use the zero-copy (write-into-JS-buffer) path —
  // below it the pooled copy path is cheaper than allocating a destination.
  const ZERO_COPY_MIN = 64 * 1024
  let scheduled = false
  // Reusable packed-args destination for the SYNCHRONOUS copy path: native
  // copies args into the job on submit, so one buffer serves every submission
  // and the hot path allocates nothing per task. Deliberately NOT used for
  // secret-bearing ops (pbkdf2/argon2) — a shared buffer would keep plaintext
  // passwords alive far longer than a per-call allocation — nor for zero-copy
  // args, which are re-submitted after an await and must own their memory.
  let argScratch = new Uint8Array(256)
  function scratch(need: number): Uint8Array {
    if (argScratch.length < need) argScratch = new Uint8Array(need)
    return argScratch
  }
  // Drain-side counters, exposed through `stats()`. They are what tells you
  // whether a workload is RTT-bound (many tiny drains) or pool-bound (few big
  // drains): `completed / drains` is the coalescing factor actually achieved.
  let drains = 0
  let completed = 0
  let maxBatch = 0
  let tooSmallRetries = 0
  let doorbell: Doorbell | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null

  // Native pool threads are invisible to Bun's event loop, so an `await`ed task
  // would not keep a CLI process alive on its own. Hold a ref'd interval while
  // anything is in flight; it doubles as a polling safety net if a doorbell
  // ever fails to arrive.
  function retain(): void {
    if (keepAlive === null) {
      keepAlive = setInterval(() => {
        if (inflight.size === 0) release()
      }, 1000)
    }
  }
  function release(): void {
    if (keepAlive !== null) {
      clearInterval(keepAlive)
      keepAlive = null
    }
  }

  function drainNow(): void {
    scheduled = false
    let guard = 0
    // `taskDrain` returns the exact needed size, or 0/1 when nothing is pending,
    // so the loop condition needs no separate `taskPending` probe — one fewer FFI
    // crossing per drain round.
    while (guard++ < 1024) {
      // The ring buffer is only reused for batches that fit; a grow-initiated
      // buffer must NOT persist across iterations, because the previous
      // iteration's `subarray` bodies still reference it.
      let buf: Uint8Array = drainBuf
      let pooled = true
      // `taskDrain` follows the needed-size convention: a buffer that is too
      // small reports the exact required byte count WITHOUT consuming anything.
      // So this single call covers both the common (fits) and grow cases — there
      // is no separate probe round trip, and therefore one fewer FFI crossing
      // per drain.
      let written = ffi.taskDrain(buf)
      if (written < 4) break
      if (written > buf.length) {
        // Too small: re-run into a bigger buffer. A modest batch grows the
        // pooled buffer (so later drains are copy-only); a large one gets a
        // fresh buffer and is handed out as `subarray` views, never reused.
        if (written <= MAX_POOLED_DRAIN) {
          drainBuf = new Uint8Array(written)
          buf = drainBuf
          pooled = true
        } else {
          buf = new Uint8Array(written)
          pooled = false
        }
        written = ffi.taskDrain(buf)
        if (written < 4) break
        if (written > buf.length) continue // grew again — retry
      }
      const view = new DataView(buf.buffer, buf.byteOffset, written)
      const count = view.getUint32(0, true)
      drains++
      if (count > maxBatch) maxBatch = count
      let off = 4
      for (let i = 0; i < count; i++) {
        // Header reads come straight out of the drain view — no BigInt boxing
        // and no per-completion DataView.
        const id = readU64At(view, off)
        const status = view.getUint32(off + 8, true)
        const len = view.getUint32(off + 12, true)
        const bodyOff = off + 16
        off = bodyOff + len
        const deferred = inflight.get(id)
        if (!deferred) continue
        inflight.delete(id)
        if (status === TASK_STATUS_OK) {
          // Zero-copy tasks complete with the written length in the body; the
          // result itself is already in the buffer JS handed us, so no body
          // bytes are touched at all. The copy path hands the payload over.
          deferred.resolve(
            deferred.out
              ? deferred.out.subarray(0, len >= 8 ? readU64At(view, bodyOff) : len)
              : bodyOf(buf, bodyOff, len, pooled),
          )
        } else if (status === TASK_STATUS_TOO_SMALL) {
          tooSmallRetries++
          deferred.reject(tooSmallError(len >= 8 ? readU64At(view, bodyOff) : 0))
        } else if (status === TASK_STATUS_UNSUPPORTED) {
          deferred.reject(unsupportedError())
        } else if (status === TASK_STATUS_CANCELLED) {
          deferred.reject(cancelledError())
        } else {
          deferred.reject(
            new Error(decodeUtf8(bodyOf(buf, bodyOff, len, pooled)) || 'task failed'),
          )
        }
        completed++
      }
    }
    if (inflight.size === 0) release()
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(drainNow)
  }

  function submit(
    op: number,
    args: Uint8Array,
    runOptions?: TaskRunOptions,
  ): Promise<Uint8Array> {
    const id = nextId++
    return new Promise<Uint8Array>((resolve, reject) => {
      inflight.set(id, { out: null, keep: null, resolve, reject })
      retain()
      if (ffi.taskSubmit(op, args, id) === 0) {
        inflight.delete(id)
        release()
        reject(new Error('task rejected by the native runtime'))
        return
      }
      const signal = runOptions?.signal
      if (signal) {
        if (signal.aborted) {
          ffi.taskCancel(id)
        } else {
          signal.addEventListener('abort', () => ffi.taskCancel(id), { once: true })
        }
      }
    })
  }

  /**
   * Zero-copy submit: the op writes its result directly into `output` on a pool
   * thread (the buffer is held by this runtime until the completion drains, so
   * it cannot be collected or moved). Resolves a view of `output` — no copy.
   */
  function submitInto(
    op: number,
    args: Uint8Array,
    output: Uint8Array,
    runOptions?: TaskRunOptions,
  ): Promise<Uint8Array> {
    const id = nextId++
    return new Promise<Uint8Array>((resolve, reject) => {
      inflight.set(id, { out: output, keep: null, resolve, reject })
      retain()
      if (ffi.taskSubmitOut(op, args, id, output) === 0) {
        inflight.delete(id)
        release()
        reject(new Error('task rejected by the native runtime'))
        return
      }
      const signal = runOptions?.signal
      if (signal) {
        if (signal.aborted) {
          ffi.taskCancel(id)
        } else {
          signal.addEventListener('abort', () => ffi.taskCancel(id), { once: true })
        }
      }
    })
  }

  /**
   * Zero-copy-INPUT submit: only the small `hdr` is copied; the pool thread
   * reads `data` in place. The runtime holds `data` until the completion
   * drains, so the caller may drop its own reference immediately — but must
   * NOT mutate it or hand over a view of a recycled pooled buffer.
   */
  function submitSlice(
    op: number,
    hdr: Uint8Array,
    data: Uint8Array,
    runOptions?: TaskRunOptions,
  ): Promise<Uint8Array> {
    const id = nextId++
    return new Promise<Uint8Array>((resolve, reject) => {
      inflight.set(id, { out: null, keep: data, resolve, reject })
      retain()
      if (ffi.taskSubmitSlice(op, hdr, data, id) === 0) {
        inflight.delete(id)
        release()
        reject(new Error('task rejected by the native runtime'))
        return
      }
      const signal = runOptions?.signal
      if (signal) {
        if (signal.aborted) {
          ffi.taskCancel(id)
        } else {
          signal.addEventListener('abort', () => ffi.taskCancel(id), { once: true })
        }
      }
    })
  }

  // One process-wide trampoline; Bun marshals calls from pool threads onto the
  // JS thread. Rust coalesces so a burst rings it once.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSCallback } = require('bun:ffi') as typeof import('bun:ffi')
  const cb = new JSCallback(
    () => {
      drainNow()
    },
    { args: [], returns: 'void', threadsafe: true } as unknown as ConstructorParameters<
      typeof JSCallback
    >[1],
  )
  doorbell = cb
  ffi.taskSetDoorbell(Number(cb.ptr))

  // A zero-copy result handoff via `toArrayBuffer(ptr, 0, len, dealloc)` was
  // prototyped here and REVERTED: Bun 1.4.2's deallocator hook segfaults
  // (`docs/runtime/ffi.mdx` does not match the implementation). Zero-copy is
  // instead done by pre-allocating the destination in JS and having the pool
  // thread write into it (see docs/RND-CONCURRENCY.md §7a). If a completion
  // landed between bind and registration, drain it now.
  schedule()

  const runtime: TaskRuntime = {
    gzipDecompress(data, runOptions) {
      // Pre-size from the gzip ISIZE trailer; unknown (0) → copy path.
      const size = ffi.gzipIsize(data)
      if (size < ZERO_COPY_MIN) {
        // Copy path: consumed synchronously, so the scratch is safe to reuse.
        return submit(
          TASK_OP.gzipDecompress,
          encodeGzipDecompressArgs(data, runOptions?.maxDecompressed, scratch(4 + data.length)),
          runOptions,
        )
      }
      // Zero-copy: the pool thread writes straight into a JS-owned buffer. On
      // TOO_SMALL retry once with the exact size; on anything else (including
      // UNSUPPORTED from an older addon) fall back, so behavior can't regress.
      // Args are re-submitted on the retry step, so they own their memory.
      const args = encodeGzipDecompressArgs(data, runOptions?.maxDecompressed)
      const copyPath = (): Promise<Uint8Array> =>
        submit(TASK_OP.gzipDecompress, args, runOptions)
      const zeroCopyOnce = (cap: number): Promise<Uint8Array> =>
        submitInto(TASK_OP.gzipDecompressInto, args, Buffer.allocUnsafe(cap), runOptions)
      return zeroCopyOnce(size)
        .catch((err: unknown) => (isTooSmall(err) ? zeroCopyOnce(err.needed) : copyPath()))
        .catch(() => copyPath())
    },
    pbkdf2Sha256(password, salt, runOptions) {
      return submit(
        TASK_OP.pbkdf2Sha256,
        encodePbkdf2Args(password, salt, runOptions.rounds, runOptions.dkLen),
        runOptions,
      )
    },
    gzipCompress(data, runOptions) {
      // Zero-copy INPUT: the payload is read in place, so compressing a large
      // buffer no longer pays an O(input) copy on the JS thread (which measured
      // 3x the wall time of the synchronous built-in AND still stalled). The
      // 4-byte header is copied by Rust, so the shared scratch is safe.
      return submitSlice(
        TASK_OP.gzipCompress,
        encodeGzipCompressHeader(runOptions?.level ?? 6, scratch(4)),
        data,
        runOptions,
      )
    },
    brotliDecompress(data, runOptions) {
      const args = encodeBrotliDecompressArgs(data, runOptions?.maxDecompressed)
      const copyPath = (): Promise<Uint8Array> =>
        submit(TASK_OP.brotliDecompress, args, runOptions)
      // Brotli has no ISIZE trailer, so there is no exact size hint: start from
      // a ratio guess and let the needed-size retry land it exactly (at most
      // one extra pass; on anything but TOO_SMALL, fall back to the copy op).
      const zeroCopyOnce = (cap: number): Promise<Uint8Array> =>
        submitInto(TASK_OP.brotliDecompressInto, args, Buffer.allocUnsafe(cap), runOptions)
      return zeroCopyOnce(brotliCapacityGuess(data.length))
        .catch((err: unknown) => (isTooSmall(err) ? zeroCopyOnce(err.needed) : copyPath()))
        .catch(() => copyPath())
    },
    async argon2Verify(password, phc, runOptions) {
      const out = await submit(
        TASK_OP.argon2Verify,
        encodeArgon2VerifyArgs(password, phc),
        runOptions,
      )
      // The whole point of offloading argon2: a one-bit answer for tens of ms
      // of CPU. A malformed PHC string is a `false`, never an error.
      return out[0] === 1
    },
    stats: () => ({
      threads: ffi.taskThreads(),
      pending: ffi.taskPending(),
      inflight: inflight.size,
      completed,
      drains,
      maxBatch,
      tooSmallRetries,
    }),
    shutdown() {
      for (const [id, deferred] of inflight) {
        ffi.taskCancel(id)
        deferred.reject(cancelledError())
      }
      inflight.clear()
      ffi.taskShutdown()
      release()
      doorbell?.close()
      doorbell = null
    },
  }
  shared = runtime
  return runtime
}
