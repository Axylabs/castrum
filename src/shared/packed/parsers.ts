// src/shared/packed/parsers.ts — High-level string parsers (convenience).
//
// Wrap the native packed parsers + decoders for ergonomic use, so consumers
// don't have to hand-pack buffers or decode packed pairs:
//   parseQueryString("a=1&b=2")    // { a: "1", b: "2" }
//   parseCookieHeader("a=1; b=2")  // { a: "1", b: "2" }
//
// Transport: bun:ffi PRIMARY — the packed pairs are consumed SYNCHRONOUSLY
// (readPairsPacked + pairsToObject materialize strings before return), so a
// reused per-parser scratch is safe (same model as the scalar unpackers);
// the bytes never escape. Node / `CASTRUM_FFI_MODE=napi` / bind failure fall
// back to the napi addon (same wire output — pinned by packed-parsers-routing).

import { getBunFFI } from '../../native/ffi'
import { getAddon, lazyAddon } from '../../native'
import { encoder } from '../bytes'
import { pairsToObject, readPairsPacked } from './wire'

// Lazy: importing this module does not dlopen the addon until first use
// (getBunFFI binds on first call; the napi proxy loads on first get).
const addon = lazyAddon(getAddon)

// FFI scratch (documented impure module state, per-Worker): grown lazily and
// reused across calls — the parsed result is a JS object, the packed bytes
// never escape.
const ffiCaches: Record<'query' | 'cookie' | 'form', Uint8Array | null> = {
  query: null,
  cookie: null,
  form: null,
}
function scratchFor(kind: 'query' | 'cookie' | 'form', input: Uint8Array): Uint8Array {
  // Packed pairs worst case ≈ 9× input (u32 len + bytes per key/value) + header.
  const need = input.length * 9 + 16
  let s = ffiCaches[kind]
  if (s === null || s.length < need) {
    s = new Uint8Array(need)
    ffiCaches[kind] = s
  }
  return s
}

function parsePackedInto(
  kind: 'query' | 'cookie' | 'form',
  input: Uint8Array,
): Record<string, string | string[]> | null {
  const f = getBunFFI()
  if (!f) return null
  const out = scratchFor(kind, input)
  const w =
    kind === 'query'
      ? f.queryParsePackedInto(input, out)
      : kind === 'cookie'
        ? f.cookieParsePackedInto(input, out)
        : f.formParsePackedInto(input, out)
  if (w === 0 || w > out.length) return null
  return pairsToObject(readPairsPacked(out.subarray(0, w)))
}

/** Parse a query string (`a=1&b=2`) into an object via the native parser. */
export function parseQueryString(query: string): Record<string, string | string[]> {
  const fast = parsePackedInto('query', encoder.encode(query))
  if (fast) return fast
  const packed = addon.queryParsePacked(encoder.encode(query))
  return pairsToObject(readPairsPacked(packed))
}

/** Parse a cookie header (`a=1; b=2`) into an object via the native parser. */
export function parseCookieHeader(header: string): Record<string, string | string[]> {
  const fast = parsePackedInto('cookie', encoder.encode(header))
  if (fast) return fast
  const packed = addon.cookieParsePacked(encoder.encode(header))
  return pairsToObject(readPairsPacked(packed))
}

/** Parse an application/x-www-form-urlencoded body into a key/value object. */
export function parseFormBody(body: Uint8Array): Record<string, string | string[]> {
  const fast = parsePackedInto('form', body)
  if (fast) return fast
  const packed = addon.formParsePacked(body)
  return pairsToObject(readPairsPacked(packed))
}
