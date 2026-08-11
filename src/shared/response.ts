// src/shared/response.ts — Response helpers for pooled (reusable) output buffers.
//
// When a response body is backed by a pooled buffer, the pool handle must not
// be released until the body has actually been consumed, otherwise a later
// request could overwrite bytes the in-flight response still references.
// `pooledBodyResponse` wraps the slice in a streaming body that returns the
// handle to its pool once the body is read (or the request is aborted).

import type { PooledBuffer } from "./buffer-pool";

/**
 * Build a `Response` whose body is backed by a pooled byte slice, returning the
 * pool handle once the body has been fully consumed (stream closed) or the
 * request has been cancelled.
 *
 * The pooled buffer stays **in flight** (not reusable) until the response
 * stream is closed/cancelled — this is what makes zero-copy pooling safe: a
 * buffer is never handed to a second request while a previous response may
 * still alias it.
 *
 * @param handle - The pooled-buffer handle to release on consumption.
 * @param bytes - The (possibly shared) byte slice to serve as the body.
 * @param init - Standard `ResponseInit` (status, headers, ...).
 * @param timeoutMs - Optional abandonment guard (ms, default 0 = disabled):
 *   if the body is neither pulled nor cancelled within this window the pooled
 *   buffer is released and the stream closed. Opt-in — lets zero-copy
 *   responses bound memory under abandoned (unread) responses.
 * @returns A `Response` that releases `handle` once its body is consumed.
 *
 * @remarks
 * **Zero-copy caveat**: the body slice is served without copying — it aliases
 * the pooled buffer. Consumers that hold a response open for a long time keep
 * that buffer out of circulation. This helper is only intended for callers that
 * explicitly opt into zero-copy (e.g. `INGRESS_UNSAFE_ZERO_COPY`); the default
 * safe path copies the slice and releases the handle eagerly.
 *
 * @example
 * ```ts
 * const handle = pool.acquire(size);
 * const used = handle.buffer.subarray(0, written);
 * return pooledBodyResponse(handle, used, { status: 200, headers });
 * ```
 */
export function pooledBodyResponse(
  handle: PooledBuffer,
  bytes: Uint8Array,
  init: ResponseInit = {},
  timeoutMs = 0,
): Response {
  if (bytes.byteLength === 0) {
    // Nothing to serve: release immediately.
    handle.release();
    return new Response(null, init);
  }

  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    handle.release();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Abandonment guard (opt-in): if the body is neither pulled nor
      // cancelled within `timeoutMs`, release the pooled buffer so it can be
      // reused and close the stream. Without this, an abandoned Response would
      // hold the pooled buffer in flight forever (bounded only by maxInFlight).
      // `pull()` re-checks `released` so a late read never serves the reused
      // (potentially overwritten) bytes.
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (released) {
            return;
          }
          release();
          controller.close();
        }, timeoutMs);
      }
    },
    pull(controller) {
      if (released) {
        // Released by the abandonment guard (or a racing cancel): the pooled
        // bytes may already be reused — never serve them. End-of-stream.
        controller.close();
        return;
      }
      controller.enqueue(bytes);
      controller.close();
      release();
    },
    cancel() {
      release();
    },
  });

  return new Response(body, init);
}
