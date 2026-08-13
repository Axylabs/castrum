// src/rust-ffi/scalar/json.ts — JSON scalar methods.
//
// Mirrors rust/json/*: validate, DOM parse, id-sum and RFC 6902 patch.

import { getBunFFI } from '../../native/ffi'
import type { RustClientContext } from '../context'
import { asBigInt } from '../options'

/** JSON scalar methods (`Pick<RustScalar, ...>`). */
export function buildJson(ctx: RustClientContext) {
  const { addon } = ctx

  return {
    jsonValid(input: Uint8Array): boolean {
      const ffi = getBunFFI()
      if (ffi) return ffi.jsonValid(input)
      return addon.jsonValid(input)
    },
    jsonParse(input: Uint8Array): unknown {
      return addon.jsonParse(input)
    },
    jsonSumIds(input: Uint8Array): bigint {
      // The C ABI returns a packed [u8 ok][i64 sum LE] output, so a legit
      // zero-sum and invalid input are unambiguous — no napi re-dispatch.
      const ffi = getBunFFI()
      if (ffi) return ffi.jsonSumIds(input)
      return asBigInt(addon.jsonSumIds(input) as unknown)
    },
    jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
      const ffi = getBunFFI()
      if (ffi) {
        try {
          return ffi.jsonPatch(doc, patch)
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
