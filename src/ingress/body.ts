// src/ingress/body.ts — Streaming request-body reading for the async ingress
// API.

const EMPTY_BODY = new Uint8Array(0);

/** Read the request body once, enforcing the size guard when enabled. */
export function readRequestBodyOnce(
  req: Request,
  maxBytes: number,
  guard: boolean,
): Promise<Uint8Array> {
  if (req.body === null) {
    return Promise.resolve(EMPTY_BODY);
  }

  return readBodyWithLimit(req, maxBytes, guard);
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
 */
export async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
  guard: boolean,
  timeoutMs?: number,
): Promise<Uint8Array> {
  const body = req.body;

  if (!body) {
    return EMPTY_BODY;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    if (!timeoutMs || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      const err = new Error("REQUEST_TIMEOUT") as Error & { code?: string };
      err.code = "REQUEST_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });

  try {
    for (;;) {
      const { done, value } =
        timeoutMs && timeoutMs > 0
          ? await Promise.race([reader.read(), timeout])
          : await reader.read();

      if (done) break;
      if (!value) continue;

      total += value.byteLength;

      if (guard && total > maxBytes) {
        await reader.cancel().catch(() => {});

        const err = new Error("BODY_TOO_LARGE") as Error & { code?: string };
        err.code = "BODY_TOO_LARGE";

        throw err;
      }

      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }

  return concatUint8Arrays(chunks, total);
}

function concatUint8Arrays(
  chunks: Uint8Array[],
  total: number,
): Uint8Array {
  if (chunks.length === 0) return EMPTY_BODY;
  if (chunks.length === 1) return chunks[0]!;

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}
