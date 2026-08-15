// src/rust-ffi/scalar/json-packed.ts — packed JSON token-stream decoder.
//
// Decodes the output of `castrum_json_parse_packed` (layout documented in
// `src/native/ffi/types.ts`) into a JS value. The C side parses ONCE with
// sonic-rs and emits a typed token stream with a DEDUPLICATED string table, so
// the JS side never re-parses JSON text and decodes each unique string exactly
// once (no per-occurrence decode — a per-occurrence blob + JS `slice` was ~10x
// worse due to rope strings). This is what makes `rust.jsonParse` competitive
// with Bun's own `JSON.parse` (the old FFI cstring path re-serialized the whole
// doc to text and re-parsed it — measured ~3.92x slower on the 5k-row fixture).

import { decodeUtf8 } from '../../shared/codec'
import { isBun } from '../../shared/runtime'

const TAG_NULL = 0
const TAG_FALSE = 1
const TAG_TRUE = 2
const TAG_NUMBER = 3
const TAG_STRING = 4
const TAG_ARRAY_START = 5
const TAG_OBJECT_START = 6
const TAG_ARRAY_END = 7
const TAG_OBJECT_END = 8
const TAG_KEY = 9

// Hoisted `bun:ffi` codec. The generic `decodeUtf8` (src/shared/codec.ts) does
// a `require('bun:ffi')` on EVERY call, which is fine for the few strings the
// ingress path decodes per request but not for a string table with thousands
// of entries (the 5k-row fixture decodes ~5k unique strings). Resolve the
// codec ONCE and reuse it; the Node fallback just delegates to the codec.
let bunFfiCodec: typeof import('bun:ffi') | null | undefined

function fastDecodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return ''
  if (bunFfiCodec === undefined) {
    bunFfiCodec = null
    if (isBun()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        bunFfiCodec = require('bun:ffi') as typeof import('bun:ffi')
      } catch {
        bunFfiCodec = null
      }
    }
  }
  if (bunFfiCodec) {
    return new bunFfiCodec.CString(bunFfiCodec.ptr(bytes), 0, bytes.byteLength).toString()
  }
  // Node fallback — only reachable if the FFI transport isn't live (this
  // decoder is Bun-only in practice), so reuse the codec's TextDecoder branch.
  return decodeUtf8(bytes)
}

/**
 * Decode a packed token stream (from `ffi.jsonParsePacked`) into a JS value.
 *
 * Stream layout (all integers little-endian):
 * `[u32 strCount]{[u32 len][utf8 bytes]}... [u32 treeLen][tree]` — a
 * deduplicated string table followed by a single value encoded as a
 * start/end-marker token stream:
 * `0=null 1=false 2=true 3=number(f64 LE) 4=string(u32 table idx)
 * 5=array start 6=object start 7=array end 8=object end
 * 9=object key(u32 table idx)`.
 * Object body: `6, (9, keyIdx, value)*, 8`.
 *
 * The result is deep-equal to what `JSON.parse` produces — numbers are emitted
 * as f64 (JS number semantics) and duplicate object keys are last-wins.
 *
 * @param bytes - The packed stream from `ffi.jsonParsePacked`.
 * @returns The parsed JS value.
 *
 * @example
 * ```ts
 * decodeJsonPacked(ffi.jsonParsePacked(enc.encode('{"a":1}'))) // { a: 1 }
 * ```
 */
export function decodeJsonPacked(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 0
  const u32 = (): number => {
    const v = view.getUint32(p, true)
    p += 4
    return v
  }

  // Deduplicated string table — each unique string decoded exactly once.
  const strCount = u32()
  const strings = new Array<string>(strCount)
  for (let i = 0; i < strCount; i++) {
    const n = u32()
    strings[i] = fastDecodeUtf8(bytes.subarray(p, p + n))
    p += n
  }

  const treeLen = u32()
  const end = p + treeLen

  // Iterative decode with an explicit container stack (no recursion).
  let root: unknown
  // frame: { isObj, arr, obj, key } — for arrays values push into `arr`; for
  // objects the pending `key` (set by TAG_KEY) receives the next value.
  interface JsonFrame {
    isObj: boolean
    arr: unknown[]
    obj: Record<string, unknown>
    key: string
  }
  const frames: JsonFrame[] = []

  const popFrame = (): JsonFrame => {
    const f = frames.pop()
    if (f === undefined) throw new Error('json parse: malformed packed stream')
    return f
  }

  const attach = (v: unknown): void => {
    const f = frames[frames.length - 1]
    if (f === undefined) {
      root = v
      return
    }
    if (f.isObj) f.obj[f.key] = v
    else f.arr.push(v)
  }

  while (p < end) {
    // Tag byte — guaranteed in-bounds (p < end <= bytes.length).
    const t = view.getUint8(p)
    p += 1
    switch (t) {
      case TAG_NULL:
        attach(null)
        break
      case TAG_FALSE:
        attach(false)
        break
      case TAG_TRUE:
        attach(true)
        break
      case TAG_NUMBER: {
        const v = view.getFloat64(p, true)
        p += 8
        attach(v)
        break
      }
      case TAG_STRING:
        attach(strings[u32()] as string)
        break
      case TAG_ARRAY_START:
        frames.push({ isObj: false, arr: [], obj: {}, key: '' })
        break
      case TAG_OBJECT_START:
        frames.push({ isObj: true, arr: [], obj: {}, key: '' })
        break
      case TAG_ARRAY_END:
        attach(popFrame().arr)
        break
      case TAG_OBJECT_END:
        attach(popFrame().obj)
        break
      case TAG_KEY: {
        const f = frames[frames.length - 1] as JsonFrame
        f.key = strings[u32()] as string
        break
      }
      default:
        throw new Error('json parse: malformed packed token')
    }
  }

  if (p !== end || frames.length !== 0) {
    throw new Error('json parse: malformed packed stream')
  }
  return root
}
