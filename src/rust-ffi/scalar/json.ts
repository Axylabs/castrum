// src/rust-ffi/scalar/json.ts — JSON scalar methods.
//
// Mirrors rust/json/*: validate, DOM parse, id-sum and RFC 6902 patch.
//
// Runtime dispatch is centralized in the adapter (`ctx.runtime`): the native
// call comes from `transport.ffi` / `transport.resolve` (bun:ffi first, napi
// fallback) — no inline `getBunFFI()`.

import { type RustClientContext, resolveNative } from '../context'
import { asBigInt } from '../options'
import { decodeJsonPacked } from './json-packed'

/** JSON scalar methods (`Pick<RustScalar, ...>`). */
export function buildJson(ctx: RustClientContext) {
  const { addon } = ctx
  const { transport } = ctx.runtime

  return {
    jsonValid(input: Uint8Array): boolean {
      return resolveNative(ctx, 'jsonValid')(input) as boolean
    },
    jsonParse(input: Uint8Array): unknown {
      // FFI-first STRUCTURAL parse: the C side parses once with sonic-rs and
      // emits a packed token stream (all strings in ONE blob, referenced by
      // char offsets); the JS decoder slices the blob with NO second JSON text
      // parse. (The old cstring path re-serialized to text and re-parsed it —
      // measured ~3.92x slower than Bun's JSON.parse on the 5k-row fixture.)
      // Invalid JSON → growExact throws (napi parity).
      //
      // Deliberately NOT delegated to JSON.parse despite the ~2x loss: the
      // native path throws on lone-surrogate escapes (`"\ude80"`) — a pinned,
      // reviewed contract (json-packed-roundtrip.test.ts) — while JSON.parse
      // accepts them. Delegating would diverge Bun from Node on that input.
      const f = transport.ffi
      if (f) {
        return decodeJsonPacked(f.jsonParsePacked(input))
      }
      return addon.jsonParse(input)
    },
    jsonSumIds(input: Uint8Array): bigint {
      // The C ABI returns a packed [u8 ok][i64 sum LE] output, so a legit
      // zero-sum and invalid input are unambiguous — no napi re-dispatch.
      return asBigInt(resolveNative(ctx, 'jsonSumIds')(input) as unknown)
    },
    jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array | string {
      const f = transport.ffi
      if (f) {
        try {
          return f.jsonPatch(doc, patch)
        } catch {
          // The C ABI's 0 is ambiguous (too-small buffer vs a real error) and
          // carries no message. Re-dispatch to napi for exact error semantics:
          // it either succeeds (too-small case) or throws the contextual
          // "invalid document"/"invalid patch"/"apply failed" message.
          return addon.jsonPatch(doc, patch)
        }
      }
      return addon.jsonPatch(doc, patch)
    },
  }
}
