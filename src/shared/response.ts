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
): Response {
  if (bytes.byteLength === 0) {
    // Nothing to serve: release immediately.
    handle.release();
    return new Response(null, init);
  }

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    handle.release();
  };

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
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
