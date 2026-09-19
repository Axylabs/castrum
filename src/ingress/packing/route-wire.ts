// src/ingress/packing/route-wire.ts — route-wire v6 byte helpers (PURE).
//
// The per-route native stack (`rust/ingress/native_route.rs`,
// `castrum_route_*` / napi `Route`) compiles a descriptor ONCE and runs each
// request frame in ONE native call. This module owns the WIRE on the JS side:
// descriptor encoding, frame packing, result decoding, and the compile-time
// response template the JS responder assembles against — byte-layout constants
// MUST match `rust/ingress/native_route.rs` (`ROUTE_DESC_VERSION` bumps on any
// layout change; a mismatched compiler/addon must be a hard reject, never a
// silent misparse).
//
// v5 added the optional `program` part (tag 7): an OPEN op program — an ordered,
// fixed-width op stream interpreted by the native executor. Ops are
// `(tag, operands, out-slot)` in a versioned registry (`ROUTE_PROGRAM_VERSION` +
// `ROUTE_OP`); the program carries its own const table (response class sets,
// CORS/rate/IP-trust config, security header lists, body schemas).
//
// v6 (this version): the native side NO LONGER returns an assembled response
// frame. A `response`/class template (status + STATIC headers + a body with
// explicit substitution slots) is owned by JS and compiled ONCE (see
// `compileResponseTemplate`); the run result carries the verdict + selected
// class tag (in the flags' high byte) + a compact substitution section
// `[subCount u16]{[slot u16][len u32][bytes]}…`. JS assembles the `Response`
// against the memoized template: static headers are a prebuilt `Headers` reused
// verbatim when no dynamic header is present, and the body is spliced from
// pre-encoded static segments. Nothing but the few dynamic values crosses the
// boundary on the hot path.
//
// PURE: no addon import, no module state — safe for any consumer. The
// addon-touching factory lives in `src/ingress/native-route.ts`.

import { decoder, encoder } from '../../shared/bytes'
import { decodeUtf8RangeView } from '../../shared/codec'

/** Route descriptor magic (`"ROUT"` LE). Must match `ROUTE_DESC_MAGIC` in Rust. */
export const ROUTE_DESC_MAGIC = 0x524f5554
/** Wire version — bump on ANY descriptor/frame/result layout change. */
export const ROUTE_DESC_VERSION = 6

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
  /**
   * v4/v6: the payload after the verdict header is the response substitution
   * section, not query/cookie pair sections.
   */
  HAS_RESPONSE: 1 << 7,
  /**
   * v6: the selected response class tag occupies the flags' high byte. Read it
   * with `(flags >>> ROUTE_FLAG.CLASS_SHIFT) & 0xff`.
   */
  CLASS_SHIFT: 8,
} as const

/**
 * Substitution slot ids (route-wire v6). A response template references its
 * dynamic values through these ids; the native result carries only the slots
 * the selected class references. Must match `SLOT_*` in Rust.
 */
export const ROUTE_SLOT = {
  /** The frame's request id bytes. */
  requestId: 0,
  /** The allowed CORS origin (echoed into `access-control-allow-origin`). */
  origin: 1,
  /** Rate-limit remaining count (decimal). */
  remaining: 2,
  /** Rate-limit reset seconds (decimal). */
  resetSecs: 3,
  /** Retry-after seconds (decimal, rate-limited only). */
  retryAfterSecs: 4,
  /** Retry-after milliseconds (decimal, rate-limited only). */
  retryAfterMs: 5,
} as const
/** A substitution slot id (`ROUTE_SLOT` values). */
export type RouteSlot = (typeof ROUTE_SLOT)[keyof typeof ROUTE_SLOT]

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
  /**
   * A pre-packed `[u16 count]{...}` header block. When set, `headers` is
   * ignored — lets the impure caller memoize the block for a repeating header
   * set (the origin echoes per request; encoding it once kills the per-request
   * re-encode).
   */
  packedHeaders?: Uint8Array
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
  requestId: string | Uint8Array | null = null,
  pre: RouteFramePre | null = null,
): Uint8Array {
  const q = encoder.encode(query)
  const c = encoder.encode(cookie)
  const r =
    requestId === null
      ? null
      : typeof requestId === 'string'
        ? encoder.encode(requestId)
        : requestId
  const hasBody = body !== null && body.byteLength > 0
  const hasRequestId = r !== null
  const hasMethod = pre?.methodKind !== undefined
  const ip = pre?.ip !== undefined ? encoder.encode(pre.ip) : null
  const hasIp = ip !== null
  const packedHeaders =
    pre?.packedHeaders ?? (pre?.headers !== undefined ? packRawHeadersPacked(pre.headers) : null)
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
export function encodeHeaderList(headers: ReadonlyArray<readonly [string, string]>): Uint8Array {
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
export function encodeResponseSet(classes: Partial<Record<number, RouteWireResponse>>): Uint8Array {
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

// ── v6 response template (compile once) + assembly (per response) ────

/** One segment of a compiled template value: static bytes or a slot. */
export type RouteTemplateSegment = { readonly bytes: Uint8Array } | { readonly slot: number }

/** A header whose value references at least one substitution slot. */
export interface RouteDynamicHeader {
  readonly name: string
  readonly segments: readonly RouteTemplateSegment[]
}

/**
 * A compile-time response template. Built ONCE per class from the plan (or the
 * `response` projection) and reused for every response:
 * - `baseHeaders` is a `Headers` of the fully-static header pairs, reused
 *   verbatim when the class has no dynamic headers (Bun copies it into the
 *   `Response`, so sharing the instance is safe).
 * - `dynamicHeaders` are spliced per response from the native substitution
 *   slots.
 * - `body` is the pre-encoded static segments with slots in between.
 */
export interface RouteWireTemplate {
  /** HTTP status. */
  readonly status: number
  /** The memoized static-header `Headers` (reused when `dynamicHeaders` is empty). */
  readonly baseHeaders: Headers
  /** The static `[name, value]` pairs `baseHeaders` was built from. */
  readonly baseHeaderPairs: readonly [string, string][]
  /** Headers with at least one substitution slot, in emit order. */
  readonly dynamicHeaders: readonly RouteDynamicHeader[]
  /** Body segments (static bytes interspersed with slots). */
  readonly body: readonly RouteTemplateSegment[]
  /** Every slot id referenced by this template. */
  readonly slots: readonly number[]
}

/** The compiled template for one response class tag. */
export type RouteWireTemplateSet = ReadonlyMap<number, RouteWireTemplate>

const PH_REQUEST_ID_BYTES = encoder.encode('{requestId}')
const PH_ORIGIN_BYTES = encoder.encode('{origin}')
const PH_REMAINING_BYTES = encoder.encode('{remaining}')
const PH_RESET_SECS_BYTES = encoder.encode('{resetSecs}')
const PH_RETRY_SECS_BYTES = encoder.encode('{retryAfterSecs}')
const PH_RETRY_MS_BYTES = encoder.encode('{retryAfterMs}')

const PH_TOKENS: ReadonlyArray<{ token: Uint8Array; slot: number }> = [
  { token: PH_REQUEST_ID_BYTES, slot: ROUTE_SLOT.requestId },
  { token: PH_ORIGIN_BYTES, slot: ROUTE_SLOT.origin },
  { token: PH_REMAINING_BYTES, slot: ROUTE_SLOT.remaining },
  { token: PH_RESET_SECS_BYTES, slot: ROUTE_SLOT.resetSecs },
  { token: PH_RETRY_SECS_BYTES, slot: ROUTE_SLOT.retryAfterSecs },
  { token: PH_RETRY_MS_BYTES, slot: ROUTE_SLOT.retryAfterMs },
]

/** Match a known placeholder token at `at` in `src` (`null` = literal `{`). */
function matchTemplateToken(src: Uint8Array, at: number): { slot: number; length: number } | null {
  for (const { token, slot } of PH_TOKENS) {
    if (at + token.byteLength > src.byteLength) continue
    let ok = true
    for (let i = 0; i < token.byteLength; i++) {
      if (src[at + i] !== token[i]) {
        ok = false
        break
      }
    }
    if (ok) return { slot, length: token.byteLength }
  }
  return null
}

/** Split a template value into static segments + substitution slots. */
function splitTemplate(src: Uint8Array): {
  segments: RouteTemplateSegment[]
  slots: number[]
} {
  const segments: RouteTemplateSegment[] = []
  const slots: number[] = []
  let i = 0
  let start = 0
  while (i < src.byteLength) {
    if (src[i] === 0x7b /* { */) {
      const match = matchTemplateToken(src, i)
      if (match !== null) {
        if (i > start) segments.push({ bytes: src.subarray(start, i) })
        segments.push({ slot: match.slot })
        if (!slots.includes(match.slot)) slots.push(match.slot)
        i += match.length
        start = i
        continue
      }
    }
    i += 1
  }
  if (start < src.byteLength) segments.push({ bytes: src.subarray(start) })
  return { segments, slots }
}

/** The bytes of a segment (empty when the slot is absent). */
function segmentBytes(
  seg: RouteTemplateSegment,
  slots: ReadonlyArray<Uint8Array | undefined>,
): Uint8Array | undefined {
  return 'slot' in seg ? slots[seg.slot] : seg.bytes
}

/** Concatenate a value's segments into a fresh buffer. */
function assembleSegments(
  segments: readonly RouteTemplateSegment[],
  slots: ReadonlyArray<Uint8Array | undefined>,
): Uint8Array {
  let total = 0
  for (const seg of segments) total += segmentBytes(seg, slots)?.byteLength ?? 0
  const out = new Uint8Array(total)
  let pos = 0
  for (const seg of segments) {
    const bytes = segmentBytes(seg, slots)
    if (bytes !== undefined && bytes.byteLength > 0) {
      out.set(bytes, pos)
      pos += bytes.byteLength
    }
  }
  return out
}

/** Assemble one header value into a string (single-segment fast path). */
function assembleHeaderValue(
  segments: readonly RouteTemplateSegment[],
  slots: ReadonlyArray<Uint8Array | undefined>,
): string {
  if (segments.length === 1) {
    const bytes = segmentBytes(segments[0]!, slots)
    return bytes === undefined ? '' : decoder.decode(bytes)
  }
  return decoder.decode(assembleSegments(segments, slots))
}

/**
 * Compile one response projection into a reusable template. Fully-static
 * headers become the memoized `baseHeaders`; header/body values with
 * placeholders are split into static segments + slots.
 */
export function compileResponseTemplate(resp: RouteWireResponse): RouteWireTemplate {
  const baseHeaderPairs: [string, string][] = []
  const dynamicHeaders: RouteDynamicHeader[] = []
  const allSlots: number[] = []
  for (const header of resp.headers) {
    const { segments, slots } = splitTemplate(encoder.encode(header.value))
    if (slots.length === 0) {
      baseHeaderPairs.push([header.name, header.value])
    } else {
      dynamicHeaders.push({ name: header.name, segments })
      for (const slot of slots) if (!allSlots.includes(slot)) allSlots.push(slot)
    }
  }
  const { segments: body, slots: bodySlots } = splitTemplate(resp.body)
  for (const slot of bodySlots) if (!allSlots.includes(slot)) allSlots.push(slot)
  return {
    status: resp.status,
    baseHeaders: new Headers(baseHeaderPairs),
    baseHeaderPairs,
    dynamicHeaders,
    body,
    slots: allSlots,
  }
}

/** Compile a class-tagged response template map (program response set). */
export function compileResponseTemplates(
  classes: Partial<Record<number, RouteWireResponse>>,
): RouteWireTemplateSet {
  const out = new Map<number, RouteWireTemplate>()
  for (const [tag, resp] of Object.entries(classes)) {
    if (resp !== undefined) out.set(Number(tag), compileResponseTemplate(resp))
  }
  return out
}

/** A response assembled against a compile-time template. */
export interface RouteAssembledResponse {
  /** HTTP status from the template. */
  status: number
  /** Static headers (reused instance) or a clone with dynamic headers set. */
  headers: Headers
  /** The fresh body buffer. */
  body: Uint8Array
}

/**
 * Assemble a response from a compile-time template + the native substitution
 * slots. When the class has no dynamic headers the memoized `baseHeaders` is
 * reused verbatim (no parse/clone); otherwise it is cloned once and the dynamic
 * values set. The body is built by splicing the substitution bytes into the
 * pre-encoded static segments — no full-frame decode.
 */
export function assembleRouteResponse(
  tmpl: RouteWireTemplate,
  slots: ReadonlyArray<Uint8Array | undefined>,
): RouteAssembledResponse {
  let headers: Headers
  if (tmpl.dynamicHeaders.length === 0) {
    headers = tmpl.baseHeaders
  } else {
    headers = new Headers(tmpl.baseHeaders)
    for (const dyn of tmpl.dynamicHeaders) {
      headers.set(dyn.name, assembleHeaderValue(dyn.segments, slots))
    }
  }
  return { status: tmpl.status, headers, body: assembleSegments(tmpl.body, slots) }
}

/** A decoded `[name, value]` pair from a result section. */
export type RouteWirePair = [string, string]

/** The decoded v6 substitution section of a response-mode result. */
export interface RouteWireSubstitutions {
  /** The selected response class tag (`0..15`). */
  classTag: number
  /** Slot bytes indexed by slot id; absent slots stay `undefined`. */
  slots: (Uint8Array | undefined)[]
}

const EMPTY_SLOTS: readonly (Uint8Array | undefined)[] = Object.freeze([])

/**
 * Decode the v6 substitution section from a response-mode result whose flags
 * include {@link ROUTE_FLAG.HAS_RESPONSE}: `[subCount u16]{[slot u16][len u32]
 * [bytes]}…`, starting after the 8-byte verdict header (`offset`, default 8).
 * The class tag is read from the flags' high byte.
 */
export function decodeRouteSubstitutions(buf: Uint8Array, offset = 8): RouteWireSubstitutions {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const flags = view.getUint32(0, true)
  const classTag = (flags >>> ROUTE_FLAG.CLASS_SHIFT) & 0xff
  const count = view.getUint16(offset, true)
  let pos = offset + 2
  const slots: (Uint8Array | undefined)[] = []
  for (let i = 0; i < count; i++) {
    const slot = view.getUint16(pos, true)
    pos += 2
    const len = view.getUint32(pos, true)
    pos += 4
    slots[slot] = buf.subarray(pos, pos + len)
    pos += len
  }
  return { classTag, slots }
}

/** The decoded route result: the verdict header + optional sections. */
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
   * The selected response class tag when {@link ROUTE_FLAG.HAS_RESPONSE} is set
   * (`-1` otherwise). Use it to select the compile-time template.
   */
  classTag: number
  /**
   * Native substitution slots (indexed by slot id) when the result is
   * response-mode; empty otherwise. The bytes are zero-copy subarrays of the
   * output buffer.
   */
  slots: readonly (Uint8Array | undefined)[]
}

/**
 * Decode the result wire: `[flags u32][errorCode u32]` + a query pair section
 * iff `query` and a cookie pair section iff `cookie` (the caller knows its own
 * plan). Sections are `[count u32] { [nameLen u32][name][valueLen u32][value] }`.
 *
 * When {@link ROUTE_FLAG.HAS_RESPONSE} is set (a `response`/`program` route),
 * the payload after the verdict header is the v6 substitution section — it is
 * decoded into `classTag` + `slots` and the pair sections are empty (they are
 * not emitted).
 */
export function decodeRouteResult(
  buf: Uint8Array,
  opts: { query: boolean; cookie: boolean },
): RouteWireResult {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const flags = view.getUint32(0, true)
  const errorCode = view.getUint32(4, true)
  if ((flags & ROUTE_FLAG.HAS_RESPONSE) !== 0) {
    const { classTag, slots } = decodeRouteSubstitutions(buf)
    return { flags, errorCode, query: [], cookie: [], classTag, slots }
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
    classTag: -1,
    slots: EMPTY_SLOTS,
  }
}
