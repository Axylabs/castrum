// src/ingress/packing/route-wire.ts — route-wire v4 byte helpers (PURE).
//
// The per-route native stack (`rust/ingress/native_route.rs`,
// `castrum_route_*` / napi `Route`) compiles a descriptor ONCE and runs each
// request frame in ONE native call. This module owns the WIRE on the JS side:
// descriptor encoding, frame packing, and result decoding — byte-layout
// constants MUST match `rust/ingress/native_route.rs` and `@ignex/native`
// `route-wire.ts` EXACTLY (`ROUTE_DESC_VERSION` bumps on any layout change; a
// mismatched compiler/addon must be a hard reject, never a silent misparse).
//
// v4 adds the optional `response` projection part: when a descriptor carries it
// AND the pipeline is OK, the native result payload is a framed HTTP response
// `[status u16][hdrCount u32]{[name][value]}…[bodyLen u32][body]` instead of the
// pair sections, with a single `{requestId}` placeholder substituted from the
// frame's request-id section. See `encodeResponseProjection` /
// `decodeRouteResponse`.
//
// PURE: no addon import, no module state — safe for any consumer. The
// addon-touching factory lives in `src/ingress/native-route.ts`.

import { decoder, encoder } from '../../shared/bytes'

/** Route descriptor magic (`"ROUT"` LE). Must match `ROUTE_DESC_MAGIC` in Rust. */
export const ROUTE_DESC_MAGIC = 0x524f5554
/** Wire version — bump on ANY descriptor/frame/result layout change. */
export const ROUTE_DESC_VERSION = 4

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
export const ROUTE_PART = { body: 3, response: 5 } as const

/** Result flag bits (`ROUTE_RESULT_FLAG_*` in Rust). */
export const ROUTE_FLAG = {
  OK: 1 << 0,
  BODY_VALID_JSON: 1 << 1,
  QUERY_VALID: 1 << 2,
  COOKIE_VALID: 1 << 3,
  BODY_VALID: 1 << 4,
  /** v4: the payload is a framed native response, not pair sections. */
  HAS_RESPONSE: 1 << 7,
} as const

/** Frame flag: the body section is present (bit 0 of the frame flags word). */
export const ROUTE_FRAME_FLAG_HAS_BODY = 1 << 0
/**
 * Frame flag: the request-id section is present (bit 1). The section is
 * appended AFTER the optional body section: `[ridLen u32][rid]`.
 */
export const ROUTE_FRAME_FLAG_HAS_REQUEST_ID = 1 << 1

/** The single accepted response-body placeholder (byte-exact ASCII). */
export const ROUTE_REQUEST_ID_PLACEHOLDER = '{requestId}'

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
 * Encode a request frame:
 * `[flags u32][qLen][query][cLen][cookie]([bLen][body])([ridLen][requestId])`.
 * `flags` carries `ROUTE_FRAME_FLAG_HAS_BODY` and
 * `ROUTE_FRAME_FLAG_HAS_REQUEST_ID`. The request-id section (v4) is appended
 * LAST, after the optional body section — it is only needed by a descriptor
 * that carries a `response` projection with a `{requestId}` placeholder.
 */
export function packRouteFrame(
  query: string,
  cookie: string,
  body: Uint8Array | null,
  requestId: string | null = null,
): Uint8Array {
  const q = encoder.encode(query)
  const c = encoder.encode(cookie)
  const r = requestId !== null ? encoder.encode(requestId) : null
  const hasBody = body !== null && body.byteLength > 0
  const hasRequestId = r !== null
  let flags = 0
  if (hasBody) flags |= ROUTE_FRAME_FLAG_HAS_BODY
  if (hasRequestId) flags |= ROUTE_FRAME_FLAG_HAS_REQUEST_ID
  const total =
    4 +
    4 +
    q.byteLength +
    4 +
    c.byteLength +
    (hasBody ? 4 + (body?.byteLength ?? 0) : 0) +
    (hasRequestId ? 4 + (r?.byteLength ?? 0) : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint32(pos, flags, true)
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
    pos += body.byteLength
  }
  if (r) {
    view.setUint32(pos, r.byteLength, true)
    pos += 4
    out.set(r, pos)
  }
  return out
}

/** A static header in a {@link RouteWireResponse} projection. */
export interface RouteWireResponseHeader {
  /** Header name (ASCII/UTF-8 bytes on the wire). */
  name: string
  /** Header value (ASCII/UTF-8 bytes on the wire). */
  value: string
}

/** A native response projection (route-wire v4 `response` part). */
export interface RouteWireResponse {
  /** HTTP status (u16). */
  status: number
  /** Static headers, emitted in order. */
  headers: readonly RouteWireResponseHeader[]
  /**
   * Pre-encoded body bytes. May contain ONE literal `{requestId}`
   * placeholder, substituted by the native stack from the frame's request-id
   * section (at most once).
   */
  body: Uint8Array
}

/**
 * Encode the `response` projection part payload:
 * `[status u16][hdrCount u32]{[nameLen u32][name][valueLen u32][value]}…`
 * `[bodyLen u32][body]`.
 */
export function encodeResponseProjection(resp: RouteWireResponse): Uint8Array {
  const nameBytes = resp.headers.map((h) => encoder.encode(h.name))
  const valueBytes = resp.headers.map((h) => encoder.encode(h.value))
  let total = 2 + 4 + 4 + resp.body.byteLength
  for (let i = 0; i < resp.headers.length; i++) {
    total += 4 + (nameBytes[i]?.byteLength ?? 0) + 4 + (valueBytes[i]?.byteLength ?? 0)
  }
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  view.setUint16(pos, resp.status, true)
  pos += 2
  view.setUint32(pos, resp.headers.length, true)
  pos += 4
  for (let i = 0; i < resp.headers.length; i++) {
    const name = nameBytes[i]!
    const value = valueBytes[i]!
    view.setUint32(pos, name.byteLength, true)
    pos += 4
    out.set(name, pos)
    pos += name.byteLength
    view.setUint32(pos, value.byteLength, true)
    pos += 4
    out.set(value, pos)
    pos += value.byteLength
  }
  view.setUint32(pos, resp.body.byteLength, true)
  pos += 4
  out.set(resp.body, pos)
  return out
}

/** A decoded native response frame. */
export interface RouteWireResponseResult {
  /** HTTP status. */
  status: number
  /** Emitted headers in order. */
  headers: RouteWirePair[]
  /** The body bytes (a subarray view of the result buffer — no copy). */
  body: Uint8Array
}

/**
 * Decode the v4 native response frame from a route result whose flags include
 * {@link ROUTE_FLAG.HAS_RESPONSE}: `[status u16][hdrCount u32]{[nameLen u32]
 * [name][valueLen u32][value]}…[bodyLen u32][body]`, starting after the 8-byte
 * verdict header (`offset`, default 8).
 */
export function decodeRouteResponse(buf: Uint8Array, offset = 8): RouteWireResponseResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = offset
  const status = view.getUint16(pos, true)
  pos += 2
  const count = view.getUint32(pos, true)
  pos += 4
  const headers: RouteWirePair[] = []
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint32(pos, true)
    pos += 4
    const name = decoder.decode(buf.subarray(pos, pos + nameLen))
    pos += nameLen
    const valueLen = view.getUint32(pos, true)
    pos += 4
    const value = decoder.decode(buf.subarray(pos, pos + valueLen))
    pos += valueLen
    headers.push([name, value])
  }
  const bodyLen = view.getUint32(pos, true)
  pos += 4
  return { status, headers, body: buf.subarray(pos, pos + bodyLen) }
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
