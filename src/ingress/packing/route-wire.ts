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
// v5 adds the optional `program` part (tag 7): an OPEN op program — an ordered,
// fixed-width op stream interpreted by the native executor (`rust/ingress/
// native_route.rs`). Ops are `(tag, operands, out-slot)` in a versioned registry
// (`ROUTE_PROGRAM_VERSION` + `ROUTE_OP`); the program carries its own const
// table (response class sets, CORS/rate/IP-trust config, security header lists,
// body schemas). `PART_PRE` (tag 6) is GONE — one v5, not two. The frame gains
// optional method/ip/packed-headers sections. See `encodeProgram`.
//
// PURE: no addon import, no module state — safe for any consumer. The
// addon-touching factory lives in `src/ingress/native-route.ts`.

import { encoder } from '../../shared/bytes'
import { decodeUtf8RangeView } from '../../shared/codec'

/** Route descriptor magic (`"ROUT"` LE). Must match `ROUTE_DESC_MAGIC` in Rust. */
export const ROUTE_DESC_MAGIC = 0x524f5554
/** Wire version — bump on ANY descriptor/frame/result layout change. */
export const ROUTE_DESC_VERSION = 5

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
export const ROUTE_PART = { body: 3, response: 5, program: 7 } as const

/** Program IR sub-version (bump on any op-encoding change). */
export const ROUTE_PROGRAM_VERSION = 1

/**
 * Stable op registry tags (must match `OP_*` in `rust/ingress/native_route.rs`).
 * NEVER renumber a shipped tag; add a new one and bump
 * {@link ROUTE_PROGRAM_VERSION} only if the fixed-width operand encoding
 * changes. An unknown tag is a hard reject → the compiler falls back to JS.
 */
export const ROUTE_OP = {
  parseQuery: 1,
  parseCookies: 2,
  limits: 3,
  ipTrust: 4,
  cors: 5,
  rateLimit: 6,
  securityHeaders: 7,
  setHeader: 8,
  jsonValid: 9,
  schemaValidate: 10,
  responseProjection: 11,
  halt: 12,
  jump: 13,
  branch: 14,
  /** Documented in the registry; the executor HARD REJECTS it (JS fallback). */
  callout: 15,
} as const
/** A stable op registry tag (`ROUTE_OP` values). */
export type RouteOpTag = (typeof ROUTE_OP)[keyof typeof ROUTE_OP]

/** `set_header` value sources (must match `SET_VALUE_*` in Rust). */
export const ROUTE_SET_VALUE = {
  /** The value is the `b` operand's const-table blob. */
  const: 0,
  /** The value is the frame's request id. */
  requestId: 1,
} as const

/** Native response class tags (v5 response sets). */
export const ROUTE_CLASS = {
  okNoOrigin: 0,
  okWithOrigin: 1,
  preflightOk: 2,
  preflightForbidden: 3,
  rateLimited: 4,
  invalidJson: 5,
  schemaFailed: 6,
  bodyTooLarge: 7,
} as const
/** A native response class tag (`ROUTE_CLASS` values). */
export type RouteClassTag = (typeof ROUTE_CLASS)[keyof typeof ROUTE_CLASS]

/** Terminal classes 8..15 are the `+ WITH_ORIGIN` variants of 0..7. */
export const ROUTE_CLASS_WITH_ORIGIN_OFFSET = 8

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
/** Frame flag (v5): a one-byte HTTP method section follows the request-id. */
export const ROUTE_FRAME_FLAG_HAS_METHOD = 1 << 2
/** Frame flag (v5): an `[ipLen u32][ip]` section follows the method. */
export const ROUTE_FRAME_FLAG_HAS_IP = 1 << 3
/** Frame flag (v5): a `[headersLen u32][packed headers]` section follows. */
export const ROUTE_FRAME_FLAG_HAS_HEADERS = 1 << 4
/** Frame flag (v5): the connection is HTTPS (drives dynamic HSTS). */
export const ROUTE_FRAME_FLAG_HTTPS = 1 << 5

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
 * [maxPairs u32][stageCount u32][stages u8…][partCount u32]
 * { [part u8][len u32][part bytes] }…`
 *
 * `program` (v5) is an extra part (tag {@link ROUTE_PART.program}) appended
 * after the schemas when provided — build it with `encodeProgram`.
 */
export function encodeRouteDescriptor(
  pipeline: readonly RouteStageTag[],
  schemas: readonly RouteWireSchema[],
  limits: RouteWireLimits,
  program?: Uint8Array,
): Uint8Array {
  const partCount = schemas.length + (program ? 1 : 0)
  let total = 8 + 16 + 4 + pipeline.length + 4
  for (const s of schemas) total += 1 + 4 + s.bytes.byteLength
  if (program) total += 1 + 4 + program.byteLength
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
  view.setUint32(pos, partCount, true)
  pos += 4
  for (const s of schemas) {
    out[pos] = s.part
    pos += 1
    view.setUint32(pos, s.bytes.byteLength, true)
    pos += 4
    out.set(s.bytes, pos)
    pos += s.bytes.byteLength
  }
  if (program) {
    out[pos] = ROUTE_PART.program
    pos += 1
    view.setUint32(pos, program.byteLength, true)
    pos += 4
    out.set(program, pos)
  }
  return out
}

/**
 * Optional v5 pre-effect inputs for a request frame: the HTTP method kind
 * (0 = GET … 6 = OPTIONS), the socket peer IP, the request headers selected by
 * a native pre plan (packed as `[name, value]` pairs), and whether the
 * connection is HTTPS. Only needed when the descriptor carries a `pre` part.
 */
export interface RouteFramePre {
  /** `METHOD_KIND` numeric value (0 = GET … 6 = OPTIONS). Default 0. */
  methodKind?: number
  /** Socket peer IP (empty/omitted = unknown). */
  ip?: string
  /** Request headers to pack (`HeaderRefs` reads Origin/ACRM/ACRH/XFF/XFP/Cookie). */
  headers?: ReadonlyArray<readonly [string, string]>
  /** The connection is HTTPS (drives dynamic HSTS). */
  https?: boolean
}

/**
 * Pack raw `[name, value]` header pairs into the `HeaderRefs` packed layout
 * (`[u16 count] { [u16 nameLen][name][u32 valueLen][value] }`). Mirrors
 * `gatherRawHeadersPacked` but takes already-extracted pairs.
 */
export function packRawHeadersPacked(
  headers: ReadonlyArray<readonly [string, string]>,
): Uint8Array {
  const encoded = headers.map(([n, v]) => [encoder.encode(n), encoder.encode(v)] as const)
  let total = 2
  for (const [n, v] of encoded) total += 2 + n.byteLength + 4 + v.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, encoded.length, true)
  let pos = 2
  for (const [n, v] of encoded) {
    view.setUint16(pos, n.byteLength, true)
    pos += 2
    out.set(n, pos)
    pos += n.byteLength
    view.setUint32(pos, v.byteLength, true)
    pos += 4
    out.set(v, pos)
    pos += v.byteLength
  }
  return out
}

/**
 * Encode a request frame:
 * `[flags u32][qLen][query][cLen][cookie]([bLen][body])([ridLen][requestId])`
 * followed, in order, by the optional v5 sections `[method u8][ipLen][ip]
 * [headersLen][packed headers]`. `flags` carries `ROUTE_FRAME_FLAG_HAS_BODY`,
 * `ROUTE_FRAME_FLAG_HAS_REQUEST_ID`, and the v5 method/ip/headers/https bits.
 */
export function packRouteFrame(
  query: string,
  cookie: string,
  body: Uint8Array | null,
  requestId: string | null = null,
  pre: RouteFramePre | null = null,
): Uint8Array {
  const q = encoder.encode(query)
  const c = encoder.encode(cookie)
  const r = requestId !== null ? encoder.encode(requestId) : null
  const hasBody = body !== null && body.byteLength > 0
  const hasRequestId = r !== null
  const hasMethod = pre?.methodKind !== undefined
  const ip = pre?.ip !== undefined ? encoder.encode(pre.ip) : null
  const hasIp = ip !== null
  const packedHeaders = pre?.headers !== undefined ? packRawHeadersPacked(pre.headers) : null
  const hasHeaders = packedHeaders !== null
  const https = pre?.https === true
  let flags = 0
  if (hasBody) flags |= ROUTE_FRAME_FLAG_HAS_BODY
  if (hasRequestId) flags |= ROUTE_FRAME_FLAG_HAS_REQUEST_ID
  if (hasMethod) flags |= ROUTE_FRAME_FLAG_HAS_METHOD
  if (hasIp) flags |= ROUTE_FRAME_FLAG_HAS_IP
  if (hasHeaders) flags |= ROUTE_FRAME_FLAG_HAS_HEADERS
  if (https) flags |= ROUTE_FRAME_FLAG_HTTPS
  const total =
    4 +
    4 +
    q.byteLength +
    4 +
    c.byteLength +
    (hasBody ? 4 + (body?.byteLength ?? 0) : 0) +
    (hasRequestId ? 4 + (r?.byteLength ?? 0) : 0) +
    (hasMethod ? 1 : 0) +
    (hasIp ? 4 + (ip?.byteLength ?? 0) : 0) +
    (hasHeaders ? 4 + (packedHeaders?.byteLength ?? 0) : 0)
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
    pos += r.byteLength
  }
  if (hasMethod) {
    out[pos] = pre?.methodKind ?? 0
    pos += 1
  }
  if (ip) {
    view.setUint32(pos, ip.byteLength, true)
    pos += 4
    out.set(ip, pos)
    pos += ip.byteLength
  }
  if (packedHeaders) {
    view.setUint32(pos, packedHeaders.byteLength, true)
    pos += 4
    out.set(packedHeaders, pos)
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

// ── Op program (route-wire v5 `program` part) ──────────────────────

/** CORS evaluation config for a `cors` op (const-table blob). */
export interface RouteWireCorsConfig {
  /** Explicit allow-origin list (`['*']` for wildcard). */
  allowOrigin?: readonly string[]
  /** Explicit allow-methods list. */
  allowMethods?: readonly string[]
  /** Explicit allow-headers list. */
  allowHeaders?: readonly string[]
  /** Allow credentials (cannot combine with a wildcard allow-origin). */
  credentials?: boolean
}

/** Rate-limit config for a `rate_limit` op (const-table blob). */
export interface RouteWireRateConfig {
  limit: number
  windowMs: number
  maxEntries: number
}

/** IP / proxy-trust config for an `ip_trust` op (const-table blob). */
export interface RouteWireIpTrustConfig {
  /** `0` trust nothing, `1` trust every hop (deprecated `trustProxy`), `2` networks. */
  mode: 0 | 1 | 2
  /** Trusted networks when `mode === 2` (CIDR or single IP). */
  networks?: readonly string[]
}

/** One op in the fixed-width program stream (`a`/`b`/`c` default to 0). */
export interface RouteWireOp {
  tag: RouteOpTag
  a?: number
  b?: number
  c?: number
}

/** Encode a `[count u32]{[len u32][utf8]}…` string list. */
export function encodeStringList(values: readonly string[]): Uint8Array {
  const parts = values.map((v) => encoder.encode(v))
  let total = 4
  for (const p of parts) total += 4 + p.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, parts.length, true)
  let pos = 4
  for (const p of parts) {
    view.setUint32(pos, p.byteLength, true)
    pos += 4
    out.set(p, pos)
    pos += p.byteLength
  }
  return out
}

/** Encode the CORS config const: `[credentials u8][3 string lists]`. */
export function encodeCorsConfig(cors: RouteWireCorsConfig): Uint8Array {
  const lists = [
    encodeStringList(cors.allowOrigin ?? []),
    encodeStringList(cors.allowMethods ?? []),
    encodeStringList(cors.allowHeaders ?? []),
  ]
  let total = 1
  for (const l of lists) total += l.byteLength
  const out = new Uint8Array(total)
  out[0] = cors.credentials ? 1 : 0
  let pos = 1
  for (const l of lists) {
    out.set(l, pos)
    pos += l.byteLength
  }
  return out
}

/** Encode the rate config const: `[limit u32][windowMs u32][maxEntries u32]`. */
export function encodeRateConfig(rate: RouteWireRateConfig): Uint8Array {
  const out = new Uint8Array(12)
  const view = new DataView(out.buffer)
  view.setUint32(0, rate.limit, true)
  view.setUint32(4, rate.windowMs, true)
  view.setUint32(8, rate.maxEntries, true)
  return out
}

/** Encode the IP-trust config const: `[mode u8]([networks string list])`. */
export function encodeIpTrustConfig(cfg: RouteWireIpTrustConfig): Uint8Array {
  if (cfg.mode !== 2) {
    return new Uint8Array([cfg.mode])
  }
  const nets = encodeStringList(cfg.networks ?? [])
  const out = new Uint8Array(1 + nets.byteLength)
  out[0] = cfg.mode
  out.set(nets, 1)
  return out
}

/**
 * Encode a header-list const: `[count u32]{[nameLen u32][name][valueLen u32]
 * [value]}…` (the `security_headers` op's payload).
 */
export function encodeHeaderList(
  headers: ReadonlyArray<readonly [string, string]>,
): Uint8Array {
  const encoded = headers.map(([n, v]) => [encoder.encode(n), encoder.encode(v)] as const)
  let total = 4
  for (const [n, v] of encoded) total += 4 + n.byteLength + 4 + v.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, encoded.length, true)
  let pos = 4
  for (const [n, v] of encoded) {
    view.setUint32(pos, n.byteLength, true)
    pos += 4
    out.set(n, pos)
    pos += n.byteLength
    view.setUint32(pos, v.byteLength, true)
    pos += 4
    out.set(v, pos)
    pos += v.byteLength
  }
  return out
}

/**
 * Encode a response class set const:
 * `[classCount u32]{[tag u8][len u32][class payload]}…` (tags sorted). Each
 * class payload uses the {@link encodeResponseProjection} layout.
 */
export function encodeResponseSet(
  classes: Partial<Record<number, RouteWireResponse>>,
): Uint8Array {
  const encoded = (Object.entries(classes) as Array<[string, RouteWireResponse]>)
    .map(([tag, resp]) => [Number(tag), encodeResponseProjection(resp)] as const)
    .sort((a, b) => a[0] - b[0])
  let total = 4
  for (const [, b] of encoded) total += 1 + 4 + b.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, encoded.length, true)
  let pos = 4
  for (const [tag, bytes] of encoded) {
    out[pos] = tag
    pos += 1
    view.setUint32(pos, bytes.byteLength, true)
    pos += 4
    out.set(bytes, pos)
    pos += bytes.byteLength
  }
  return out
}

/**
 * Encode the v5 `program` part:
 * `[version u8][constCount u32]{[len u32][bytes]}…`
 * `[opCount u32]{[tag u8][a u32][b u32][c u32]}…`.
 *
 * Ops are fixed width (13 bytes each) so the native executor dispatches
 * branch-free on the tag; operands are pre-resolved const indices / out-slots.
 * A malformed op (unknown tag, out-of-range const, non-forward jump) is a hard
 * reject at native compile → the caller falls back to JS.
 */
export function encodeProgram(
  consts: readonly Uint8Array[],
  ops: readonly RouteWireOp[],
): Uint8Array {
  let total = 1 + 4 + 4
  for (const c of consts) total += 4 + c.byteLength
  total += ops.length * 13
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0
  out[pos] = ROUTE_PROGRAM_VERSION
  pos += 1
  view.setUint32(pos, consts.length, true)
  pos += 4
  for (const c of consts) {
    view.setUint32(pos, c.byteLength, true)
    pos += 4
    out.set(c, pos)
    pos += c.byteLength
  }
  view.setUint32(pos, ops.length, true)
  pos += 4
  for (const op of ops) {
    out[pos] = op.tag
    pos += 1
    view.setUint32(pos, op.a ?? 0, true)
    pos += 4
    view.setUint32(pos, op.b ?? 0, true)
    pos += 4
    view.setUint32(pos, op.c ?? 0, true)
    pos += 4
  }
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
 * Decode the v4/v5 native response frame from a route result whose flags
 * include {@link ROUTE_FLAG.HAS_RESPONSE}: `[status u16][hdrCount u32]
 * {[nameLen u32][name][valueLen u32][value]}…[bodyLen u32][body]`, starting
 * after the 8-byte verdict header (`offset`, default 8).
 */
export function decodeRouteResponse(buf: Uint8Array, offset = 8): RouteWireResponseResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // One zero-copy Buffer view for the whole result: ranged decode at absolute
  // offsets (ASCII latin1 fast path, UTF-8 fallback) instead of one
  // `decoder.decode`/`CString` allocation per header name+value. The bounded
  // DataView above stays so out-of-bounds reads still throw on malformed wire.
  const bview = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = offset
  const status = view.getUint16(pos, true)
  pos += 2
  const count = view.getUint32(pos, true)
  pos += 4
  const headers: RouteWirePair[] = []
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint32(pos, true)
    pos += 4
    const name = decodeUtf8RangeView(bview, pos, pos + nameLen)
    pos += nameLen
    const valueLen = view.getUint32(pos, true)
    pos += 4
    const value = decodeUtf8RangeView(bview, pos, pos + valueLen)
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
  /**
   * The native response frame (v4 `response` / v5 `pre` route) when the result
   * carries {@link ROUTE_FLAG.HAS_RESPONSE}. In that mode the pair sections are
   * empty.
   */
  response?: RouteWireResponseResult
}

/**
 * Decode the result wire: `[flags u32][errorCode u32]` + a query pair section
 * iff `query` and a cookie pair section iff `cookie` (the caller knows its own
 * plan). Sections are `[count u32] { [nameLen u32][name][valueLen u32][value] }`.
 *
 * When {@link ROUTE_FLAG.HAS_RESPONSE} is set (a `response` or `pre` route), the
 * payload after the verdict header is the framed response — it is decoded into
 * `response` and the pair sections are empty (they are not emitted).
 */
export function decodeRouteResult(
  buf: Uint8Array,
  opts: { query: boolean; cookie: boolean },
): RouteWireResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const flags = view.getUint32(0, true)
  const errorCode = view.getUint32(4, true)
  if ((flags & ROUTE_FLAG.HAS_RESPONSE) !== 0) {
    return { flags, errorCode, query: [], cookie: [], response: decodeRouteResponse(buf) }
  }
  // One zero-copy Buffer view shared by both pair sections (ranged decode).
  const bview = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  const readPairs = (): RouteWirePair[] => {
    const count = view.getUint32(pos, true)
    pos += 4
    const out: RouteWirePair[] = []
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint32(pos, true)
      pos += 4
      const name = decodeUtf8RangeView(bview, pos, pos + nameLen)
      pos += nameLen
      const valueLen = view.getUint32(pos, true)
      pos += 4
      const value = decodeUtf8RangeView(bview, pos, pos + valueLen)
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
