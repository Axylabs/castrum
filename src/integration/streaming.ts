// src/integration/streaming.ts — SSE response helper.

import { rust } from "../rust-ffi";

export interface SseEvent {
  /** Optional `event:` field. */
  event?: string | null;
  /** Optional `id:` field. */
  id?: string | null;
  /** Optional `retry:` field (ms). */
  retry?: number | null;
  /** Event data. */
  data: string | Uint8Array;
}

/**
 * Build a `text/event-stream` Response from an (async) iterable of events.
 *
 * Each event is framed with the native `rust.sseEncodeEvent` (zero-DOM, byte
 * parity with the FFI primitive), so SSE stays on the fast path:
 *
 * @example
 * ```ts
 * async function* tick() {
 *   for (let i = 0; i < 5; i++) {
 *     await Bun.sleep(250);
 *     yield { event: "tick", data: String(i) };
 *   }
 * }
 * return sseResponse(tick(), { headers: { "x-request-id": rid } });
 * ```
 */
export function sseResponse(
  events: AsyncIterable<SseEvent> | Iterable<SseEvent>,
  init: ResponseInit = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of events) {
          const data =
            typeof ev.data === "string" ? encoder.encode(ev.data) : ev.data;
          controller.enqueue(
            rust.sseEncodeEvent(
              ev.event ?? null,
              data,
              ev.id ?? null,
              ev.retry ?? null,
            ),
          );
        }
      } finally {
        controller.close();
      }
    },
  });

  // Merge caller headers without relying on a specific `HeadersInit` type
  // (Bun vs undici global type drift), then force the SSE headers.
  const merged: Record<string, string> = {};
  const provided = init.headers;
  if (provided) {
    if (provided instanceof Headers) {
      provided.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (Array.isArray(provided)) {
      for (const [key, value] of provided) {
        merged[key] = String(value);
      }
    } else {
      Object.assign(merged, provided);
    }
  }
  merged["content-type"] = "text/event-stream";
  merged["cache-control"] = "no-cache";
  merged.connection = "keep-alive";

  return new Response(stream, {
    status: init.status,
    statusText: init.statusText,
    headers: merged,
  });
}
