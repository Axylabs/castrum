// src/shared/trace.ts — W3C Trace Context helpers (zero-dep).
//
// Parses the `traceparent` request header and generates span ids so ingress
// logs/hooks can correlate requests across services. This is the "tracing"
// primitive — wire `parseTraceContext(req)` in an `onRequest` hook and pass the
// traceId/spanId into your structured logger (pino/otel), or use it directly.
//
// Format: `version-traceid-spanid-flags` (e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`).

/** A parsed W3C trace context (valid per the spec's length/hex rules). */
export interface TraceContext {
  /** Version, always `"00"` for accepted headers. */
  version: string
  /** 32 hex chars — the trace id (shared across the whole trace). */
  traceId: string
  /** 16 hex chars — the current span id. */
  spanId: string
  /** The flags byte (bit 0 = sampled). */
  flags: number
  /** True when the `sampled` (bit 0) flag is set. */
  sampled: boolean
}

const HEX = /^[0-9a-fA-F]+$/
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

/**
 * Parse a `traceparent` header value into a {@link TraceContext}, or `null`
 * when malformed (wrong version / length / non-hex / all-zero id). Invalid
 * contexts are ignored per the spec — callers should generate a fresh trace then.
 */
export function parseTraceParent(header: string | null | undefined): TraceContext | null {
  if (!header) return null
  const parts = header.trim().split('-')
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flagsStr] = parts
  // Only version 00 is currently defined.
  if (version !== '00') return null
  if (traceId === undefined || traceId.length !== 32 || !HEX.test(traceId)) return null
  if (spanId === undefined || spanId.length !== 16 || !HEX.test(spanId)) return null
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null
  if (flagsStr === undefined || flagsStr.length !== 2 || !HEX.test(flagsStr)) return null
  const flags = Number.parseInt(flagsStr, 16)
  return {
    version,
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    flags,
    sampled: (flags & 0x01) === 0x01,
  }
}

/** Random 32-hex trace id backed by Web Crypto. */
export function createTraceId(): string {
  return randomHex(16)
}

/** Random 16-hex span id backed by Web Crypto. */
export function createSpanId(): string {
  return randomHex(8)
}

/** Generate `n` cryptographically random, non-zero bytes as lowercase hex. */
function randomHex(bytes: number): string {
  const crypto = globalThis.crypto
  if (!crypto?.getRandomValues) {
    throw new Error('Secure trace ID generation requires Web Crypto')
  }
  const buf = new Uint8Array(bytes)
  do {
    crypto.getRandomValues(buf)
  } while (buf.every((byte) => byte === 0))
  let out = ''
  for (let i = 0; i < bytes; i++) {
    out += (buf[i] ?? 0).toString(16).padStart(2, '0')
  }
  return out
}

/** Serialize a trace context back to a `traceparent` header value. */
export function serializeTraceParent(ctx: TraceContext): string {
  const flags = ctx.flags.toString(16).padStart(2, '0')
  return `${ctx.version}-${ctx.traceId}-${ctx.spanId}-${flags}`
}
