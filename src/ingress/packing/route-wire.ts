// src/ingress/packing/route-wire.ts — route-wire v3 byte helpers (PURE).
//
// The per-route native stack (`rust/ingress/native_route.rs`,
// `castrum_route_*` / napi `Route`) compiles a descriptor ONCE and runs each
// request frame in ONE native call. This module owns the WIRE on the JS side:
// descriptor encoding, frame packing, and result decoding — byte-layout
// constants MUST match `rust/ingress/native_route.rs` and `@ignex/native`
// `route-wire.ts` EXACTLY (`ROUTE_DESC_VERSION` bumps on any layout change; a
// mismatched compiler/addon must be a hard reject, never a silent misparse).
//
// PURE: no addon import, no module state — safe for any consumer. The
// addon-touching factory lives in `src/ingress/native-route.ts`.

import { decoder, encoder } from '../../shared/bytes'

/** Route descriptor magic (`"ROUT"` LE). Must match `ROUTE_DESC_MAGIC` in Rust. */
export const ROUTE_DESC_MAGIC = 0x524f5554
/** Wire version — bump on ANY descriptor/frame/result layout change. */
export const ROUTE_DESC_VERSION = 3

/** Descriptor stage tags (the ordered pipeline a route instance runs). */
export const ROUTE_STAGE = {
  parseQuery: 0,
  parseCookies: 1,
  validateQuery: 2,
  validateCookies: 3,
  validateBody: 4,
  requireJsonBody: 5,
} as const
/** A descriptor stage tag (`ROUTE_STAGE` values, must match Rust). */
export type RouteStageTag = (typeof ROUTE_STAGE)[keyof typeof ROUTE_STAGE]

/** Descriptor part tags (`RoutePartKind`): the schema-bearing request parts. */
export const ROUTE_PART = { body: 3 } as const

/** Result flag bits (`ROUTE_RESULT_FLAG_*` in Rust). */
export const ROUTE_FLAG = {
  OK: 1 << 0,
  BODY_VALID_JSON: 1 << 1,
  QUERY_VALID: 1 << 2,
  COOKIE_VALID: 1 << 3,
  BODY_VALID: 1 << 4,
} as const

/** Frame flag: the body section is present (bit 0 of the frame flags word). */
export const ROUTE_FRAME_FLAG_HAS_BODY = 1 << 0

/** Size limits a route descriptor carries. */
export interface RouteWireLimits {
  maxBodyBytes: number
  maxQueryBytes: number
  maxCookieBytes: number
  maxPairs: number
}

/** A schema part carried by the descriptor (part tag + draft-07 JSON bytes). */
export interface RouteWireSchema {
  part: number
  bytes: Uint8Array
}

/**
 * Encode a route plan into the descriptor wire.
 *
 * Layout: `[magic u32][version u32][maxBody u32][maxQuery u32][maxCookie u32]
 * [maxPairs u32][stageCount u32][stages u8…][schemaCount u32]
 * { [part u8][len u32][schema] }…`
 */
export function encodeRouteDescriptor(
  pipeline: readonly RouteStageTag[],
  schemas: readonly RouteWireSchema[],
  limits: RouteWireLimits,
): Uint8Array {
  let total = 8 + 16 + 4 + pipeline.length + 4
  for (const s of schemas) total += 1 + 4 + s.bytes.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint32(pos, ROUTE_DESC_MAGIC, true)
  pos += 4
  view.setUint32(pos, ROUTE_DESC_VERSION, true)
  pos += 4
  for (const v of [
    limits.maxBodyBytes,
    limits.maxQueryBytes,
    limits.maxCookieBytes,
    limits.maxPairs,
  ]) {
    view.setUint32(pos, v, true)
    pos += 4
  }
  view.setUint32(pos, pipeline.length, true)
  pos += 4
  for (const stage of pipeline) {
    out[pos] = stage
    pos += 1
  }
  view.setUint32(pos, schemas.length, true)
  pos += 4
  for (const s of schemas) {
    out[pos] = s.part
    pos += 1
    view.setUint32(pos, s.bytes.byteLength, true)
    pos += 4
    out.set(s.bytes, pos)
    pos += s.bytes.byteLength
  }
  return out
}

/**
 * Encode a request frame: `[flags u32][qLen][query][cLen][cookie]([bLen][body])`.
 * The `flags` word currently only carries `ROUTE_FRAME_FLAG_HAS_BODY`.
 */
export function packRouteFrame(query: string, cookie: string, body: Uint8Array | null): Uint8Array {
  const q = encoder.encode(query)
  const c = encoder.encode(cookie)
  const hasBody = body !== null && body.byteLength > 0
  const total =
    4 + 4 + q.byteLength + 4 + c.byteLength + (hasBody ? 4 + (body?.byteLength ?? 0) : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint32(pos, hasBody ? ROUTE_FRAME_FLAG_HAS_BODY : 0, true)
  pos += 4
  view.setUint32(pos, q.byteLength, true)
  pos += 4
  out.set(q, pos)
  pos += q.byteLength
  view.setUint32(pos, c.byteLength, true)
  pos += 4
  out.set(c, pos)
  pos += c.byteLength
  if (hasBody && body) {
    view.setUint32(pos, body.byteLength, true)
    pos += 4
    out.set(body, pos)
  }
  return out
}

/** A decoded `[name, value]` pair from a result section. */
export type RouteWirePair = [string, string]

/** The decoded route result: the verdict header + optional pair sections. */
export interface RouteWireResult {
  /** `ROUTE_FLAG_*` bits from the result header. */
  flags: number
  /** `0` = ok; `400` = not-JSON under requireJsonBody; `422` = schema fail. */
  errorCode: number
  /** Decoded query pairs (present iff the plan compiled `parseQuery`). */
  query: RouteWirePair[]
  /** Decoded cookie pairs (present iff the plan compiled `parseCookies`). */
  cookie: RouteWirePair[]
}

/**
 * Decode the result wire: `[flags u32][errorCode u32]` + a query pair section
 * iff `query` and a cookie pair section iff `cookie` (the caller knows its own
 * plan). Sections are `[count u32] { [nameLen u32][name][valueLen u32][value] }`.
 */
export function decodeRouteResult(
  buf: Uint8Array,
  opts: { query: boolean; cookie: boolean },
): RouteWireResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const flags = view.getUint32(0, true)
  const errorCode = view.getUint32(4, true)
  let pos = 8
  const readPairs = (): RouteWirePair[] => {
    const count = view.getUint32(pos, true)
    pos += 4
    const out: RouteWirePair[] = []
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint32(pos, true)
      pos += 4
      const name = decoder.decode(buf.subarray(pos, pos + nameLen))
      pos += nameLen
      const valueLen = view.getUint32(pos, true)
      pos += 4
      const value = decoder.decode(buf.subarray(pos, pos + valueLen))
      pos += valueLen
      out.push([name, value])
    }
    return out
  }
  return {
    flags,
    errorCode,
    query: opts.query ? readPairs() : [],
    cookie: opts.cookie ? readPairs() : [],
  }
}
