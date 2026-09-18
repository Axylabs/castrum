// src/ingress/body.ts — Streaming request-body reading for the async ingress
// API.

import { isBun } from '../shared/runtime'
import { ABORT_CODE } from './abort'

const EMPTY_BODY = new Uint8Array(0)

/**
 * Read the request body as bytes. Bun's `req.bytes()` returns a `Uint8Array`
 * directly (no `ArrayBuffer` → view wrapper and no copy) — feature-detected so
 * Node (which lacks `Response.bytes()` on some versions) falls back to
 * `arrayBuffer()` + a zero-copy view. This is the hot-path body read for every
 * write route.
 */
async function readBodyBytes(req: Request): Promise<Uint8Array> {
  const bytes = (req as { bytes?: () => Promise<Uint8Array> }).bytes
  if (typeof bytes === 'function') {
    return bytes.call(req)
  }
  return new Uint8Array(await req.arrayBuffer())
}

/**
 * Bun-only synchronous peek of an already-buffered body.
 *
 * Under Bun a body fully received during HTTP parsing resolves `req.bytes()`
 * IMMEDIATELY — `Bun.peek` hands back the `Uint8Array` without awaiting, so a
 * declared-Content-Length write route can read the body with no deadline race,
 * no watchdog entry and no microtask turn (the common small-body case).
 *
 * Returns:
 * - `{ bytes }` — already buffered; the caller reads it synchronously and
 *   must NOT pay the deadline race (the body is already here).
 * - `Promise<Uint8Array>` — the read is still pending (slow/trickling body);
 *   the caller MUST still enforce its deadline against this promise.
 * - `false` — no `req.bytes()` on this runtime (Node); the caller falls back
 *   to the async `readBodyBytes` + race as before.
 */
function peekBufferedBody(req: Request): { bytes: Uint8Array } | Promise<Uint8Array> | false {
  const bytes = (req as { bytes?: () => Promise<Uint8Array> }).bytes
  if (typeof bytes !== 'function') return false
  const pending = bytes.call(req)
  if (!isBun()) return pending
  const peeked = Bun.peek(pending)
  return peeked instanceof Promise ? peeked : { bytes: peeked }
}

/** Read the request body once, enforcing the size guard when enabled. */
export function readRequestBodyOnce(
  req: Request,
  maxBytes: number,
  guard: boolean,
  timeoutMs?: number,
): Promise<Uint8Array> {
  if (req.body === null) {
    return Promise.resolve(EMPTY_BODY)
  }

  return readBodyWithLimit(req, maxBytes, guard, timeoutMs)
}

function bodyTooLargeError(): Error & { code?: string } {
  const err = new Error('BODY_TOO_LARGE') as Error & { code?: string }
  err.code = 'BODY_TOO_LARGE'
  return err
}

function abortError(): Error & { code?: string } {
  const err = new Error(ABORT_CODE) as Error & { code?: string }
  err.code = ABORT_CODE
  return err
}

/** Reject when `signal` is already aborted (the entry guard for every path). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/** A reusable rejection promise + listener-cleanup pair for a read race. */
interface ReadGuard {
  promise: Promise<never>
  cancel: () => void
}

/**
 * Track `req.signal` as a rejection racer: settles with a `REQUEST_ABORTED`
 * error when the client disconnects. Returns `null` when the request carries no
 * signal, so runtimes without `Request.signal` are unaffected. The
 * `{ once: true }` listener self-removes when it fires; `cancel()` detaches it
 * on the read-completed-first path so no listener outlives the read.
 */
function createAbortGuard(signal: AbortSignal | undefined): ReadGuard | null {
  if (!signal) return null
  if (signal.aborted) {
    return { promise: Promise.reject(abortError()), cancel: () => {} }
  }
  let listener: (() => void) | null = null
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortError())
    signal.addEventListener('abort', listener, { once: true })
  })
  return {
    promise,
    cancel: () => {
      if (listener !== null) {
        signal.removeEventListener('abort', listener)
        listener = null
      }
    },
  }
}

/** Race a read against guard rejections (a plain await when there are none). */
function raceRead<T>(read: Promise<T>, guards: ReadonlyArray<ReadGuard>): Promise<T> {
  if (guards.length === 0) return read
  const racers: Promise<unknown>[] = [read]
  for (const guard of guards) racers.push(guard.promise)
  return Promise.race(racers) as Promise<T>
}

// ── Shared body-read deadline watchdog ──────────────────────────────────────
// One interval timer sweeps ALL in-flight body reads that carry a deadline,
// replacing a per-request `setTimeout` + `clearTimeout` + `timer.unref` on
// every write-route body read (that per-request timer alloc is measurable in
// the POST micro-bench — ~800ns of the ~2.3µs body read). Abort semantics are
// unchanged: a read that outlives its deadline rejects with REQUEST_TIMEOUT.
// Entries are removed on completion or when the deadline fires; the interval
// only runs while at least one read is pending.
const bodyWatchdog = (() => {
  const inflight = new Set<WatchdogEntry>()
  let timer: ReturnType<typeof setInterval> | null = null
  const SWEEP_MS = 250

  function sweep() {
    const now = Date.now()
    for (const entry of inflight) {
      if (entry.settled) {
        inflight.delete(entry)
        continue
      }
      if (now >= entry.deadlineWall) {
        entry.settled = true
        inflight.delete(entry)
        entry.reject(timeoutError())
      }
    }
    if (inflight.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function track(entry: WatchdogEntry) {
    inflight.add(entry)
    if (timer === null) {
      timer = setInterval(sweep, SWEEP_MS)
    }
  }

  function untrack(entry: WatchdogEntry) {
    entry.settled = true
    inflight.delete(entry)
    if (inflight.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return { track, untrack }
})()

interface WatchdogEntry {
  deadlineWall: number
  settled: boolean
  reject: (err: Error) => void
}

/** Create a deadline tracked by the shared watchdog (no per-read setTimeout). */
function createDeadline(deadlineMs: number): { promise: Promise<never>; cancel: () => void } {
  const entry: WatchdogEntry = {
    deadlineWall: Date.now() + deadlineMs,
    settled: false,
    reject: () => {},
  }
  const promise = new Promise<never>((_resolve, reject) => {
    entry.reject = reject
  })
  bodyWatchdog.track(entry)
  return { promise, cancel: () => bodyWatchdog.untrack(entry) }
}

/**
 * Stream-read the request body, enforcing the size guard when enabled and an
 * optional overall deadline.
 *
 * Errors carry `err.code`:
 * - `BODY_TOO_LARGE` when `guard` is on and the body exceeds `maxBytes`
 *   (thrown as soon as the limit is crossed — the body is never fully
 *   buffered first, which is the slowloris/large-body protection).
 * - `REQUEST_TIMEOUT` when `timeoutMs` elapses before the body completes.
 * - `REQUEST_ABORTED` when `req.signal` aborts (client disconnect) before the
 *   read settles — including an already-aborted signal at entry. The race's
 *   abort listener is removed once the read settles.
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
  guard: boolean,
  timeoutMs?: number,
): Promise<Uint8Array> {
  // Client disconnect before any read work: reject immediately (also covers an
  // already-aborted signal on every downstream path).
  throwIfAborted(req.signal)

  const deadline = timeoutMs && timeoutMs > 0 ? timeoutMs : 0

  // Fast path: a declared Content-Length lets us PROVE the body fits the
  // guard before reading, so one native `bytes()`/`arrayBuffer()` read
  // replaces the reader + per-chunk `Promise.race` + `concatUint8Arrays`
  // churn (the bench POSTs are single-shot bodies — this removes ~4-6
  // allocations per write request). The deadline (when set) is still enforced
  // with a single race, not one per chunk. The read is bounded by the
  // server's `maxRequestBodySize`, and the post-read length re-check catches
  // a client that lies about Content-Length.
  const declared = req.headers.get('content-length')
  if (declared !== null) {
    const declaredLen = Number(declared)
    if (Number.isFinite(declaredLen)) {
      if (guard && declaredLen > maxBytes) {
        throw bodyTooLargeError()
      }
      // `req.body` (the stream getter) is deliberately NOT touched on this
      // path — `req.bytes()` (Bun) / `arrayBuffer()` (Node) read the buffered
      // body directly, avoiding a lazily-constructed stream per write request.
      if (deadline <= 0) {
        const abort = createAbortGuard(req.signal)
        try {
          const bytes = await raceRead(readBodyBytes(req), abort !== null ? [abort] : [])
          throwIfAborted(req.signal)
          if (guard && bytes.byteLength > maxBytes) {
            throw bodyTooLargeError()
          }
          return bytes
        } finally {
          abort?.cancel()
        }
      }
      // Deadline path. Under Bun, a small declared-length body is usually
      // already buffered — `Bun.peek` returns the bytes synchronously, so we
      // skip the deadline race + watchdog + microtask entirely for the common
      // case. Only a genuinely pending read (slow/trickling body) pays the
      // race; non-Bun runtimes keep the previous behavior.
      const buffered = peekBufferedBody(req)
      if (buffered === false) {
        const dl = createDeadline(deadline)
        const abort = createAbortGuard(req.signal)
        try {
          const bytes = await raceRead(readBodyBytes(req), abort !== null ? [dl, abort] : [dl])
          throwIfAborted(req.signal)
          if (guard && bytes.byteLength > maxBytes) {
            throw bodyTooLargeError()
          }
          return bytes
        } finally {
          dl.cancel()
          abort?.cancel()
        }
      }
      if ('bytes' in buffered) {
        throwIfAborted(req.signal)
        if (guard && buffered.bytes.byteLength > maxBytes) {
          throw bodyTooLargeError()
        }
        return buffered.bytes
      }
      const dl = createDeadline(deadline)
      const abort = createAbortGuard(req.signal)
      try {
        const bytes = await raceRead(buffered, abort !== null ? [dl, abort] : [dl])
        throwIfAborted(req.signal)
        if (guard && bytes.byteLength > maxBytes) {
          throw bodyTooLargeError()
        }
        return bytes
      } finally {
        dl.cancel()
        abort?.cancel()
      }
    }
  }

  // No (usable) Content-Length: fall back to the streaming reader. `req.body`
  // is only touched here — the declared-length fast path never needs it.
  const body = req.body
  if (!body) {
    throwIfAborted(req.signal)
    return EMPTY_BODY
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // True when the stream was fully read to `done` — on that path the reader is
  // already closed, so the `cancel()` in `finally` is a wasted async round-trip
  // per request. It is still required when the loop exits early (timeout/error).
  let completed = false
  const dl = deadline > 0 ? createDeadline(deadline) : null
  const abort = createAbortGuard(req.signal)
  const guards: ReadGuard[] = []
  if (dl !== null) guards.push(dl)
  if (abort !== null) guards.push(abort)

  try {
    for (;;) {
      const { done, value } = await raceRead(reader.read(), guards)

      if (done) {
        completed = true
        break
      }
      if (!value) continue

      total += value.byteLength

      if (guard && total > maxBytes) {
        throw bodyTooLargeError()
      }

      chunks.push(value)
    }
  } finally {
    dl?.cancel()
    abort?.cancel()
    // Release the underlying stream. Cancelling while a read() is still
    // pending (the timeout case) can resolve that pending read() as `done`
    // and RACE the timeout rejection — so reject first, cancel only AFTER
    // the loop has settled. The `.catch` keeps the cancel from masking a
    // thrown REQUEST_TIMEOUT / BODY_TOO_LARGE. On the normal `done` path the
    // stream is already closed, so skip the cancel entirely.
    if (!completed) {
      await reader.cancel().catch(() => {})
    }
  }

  return concatUint8Arrays(chunks, total)
}

function timeoutError(): Error & { code?: string } {
  const err = new Error('REQUEST_TIMEOUT') as Error & { code?: string }
  err.code = 'REQUEST_TIMEOUT'
  return err
}

function concatUint8Arrays(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) return EMPTY_BODY
  if (chunks.length === 1) return chunks[0] ?? EMPTY_BODY

  const out = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  return out
}
