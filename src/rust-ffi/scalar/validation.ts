// src/rust-ffi/scalar/validation.ts — Validation & text-utility scalar methods.
//
// Mirrors rust/util/validation.rs (batch fixed-width hex validation) and
// rust/util/text.rs (JS-RegExp metacharacter escaping). Stateless; on Bun the
// string paths cross as cstring ARGs (engine-transcoded — zero TextEncoder)
// and regexEscape returns via a cstring return (engine-cloned — zero decode).

import { encoder, toBytes } from '../../shared/bytes'
import { decodeUtf8 } from '../../shared/codec'
import type { RustClientContext } from '../context'
import { memoizeFfi, resolveNative } from '../context'

/**
 * Non-zeroing output allocation for the batch verdicts (`Buffer.allocUnsafe`
 * skips the 4 KB memset a plain `new Uint8Array` pays; every byte is
 * overwritten by the native write anyway).
 */
const allocOut = (n: number): Uint8Array =>
  typeof Buffer !== 'undefined' && typeof Buffer.allocUnsafe === 'function'
    ? Buffer.allocUnsafe(n)
    : new Uint8Array(n)

/** Validation / text-utility methods (`Pick<RustScalar, ...>`). */
export function buildValidation(ctx: RustClientContext) {
  const { transport } = ctx.runtime
  const n = (name: string) => resolveNative(ctx, name)
  // Lazy-memoized ffi surface: binds on first call (no eager dlopen at import).
  const ffi = memoizeFfi(transport)

  return {
    /**
     * Validate NEWLINE-separated strings as fixed-width hex (e.g. Mongo
     * ObjectIds at width 24) in ONE native call → one verdict byte per line.
     * Replaces the per-item `/^[0-9a-f]{24}$/` regex loops list endpoints
     * scatter everywhere. Accepts an array of id strings directly — the join
     * crosses as a `cstring` ARG, so the JS side never touches an encoder.
     *
     * @param input Newline-separated candidates as bytes, or an array of
     *   candidate strings (joined internally with `\n`)
     * @param width Exact expected length of each line (1..=4096)
     * @returns Uint8Array of 1/0 verdicts, one per line (trailing newline
     *   does not add an extra verdict)
     * @throws On `width` outside 1..=4096
     * @example
     * ```ts
     * rust.hexValidateBatch(['507f1f77bcf86cd799439011', 'nope'], 24) // [1, 0]
     * ```
     */
    hexValidateBatch(input: Uint8Array | readonly string[], width: number): Uint8Array {
      if (width === 0 || width > 4096 || !Number.isInteger(width)) {
        throw new Error('hex validate batch: width must be an integer 1..=4096')
      }
      const f = ffi()
      if (f) {
        // Verdict count ≤ line count ≤ input length — one native pass.
        const joined =
          typeof input === 'string'
            ? input
            : Array.isArray(input)
              ? (input as readonly string[]).join('\n')
              : null
        let out = allocOut(Math.min(joined !== null ? joined.length + 1 : input.length + 1, 4096))
        let w =
          joined !== null
            ? f.hexValidateBatchStr(joined, width, out)
            : f.hexValidateBatchInto(input as Uint8Array, width, out)
        if (w > out.length) {
          out = new Uint8Array(w)
          w =
            joined !== null
              ? f.hexValidateBatchStr(joined, width, out)
              : f.hexValidateBatchInto(input as Uint8Array, width, out)
        }
        return out.subarray(0, w)
      }
      const bytes = Array.isArray(input)
        ? encoder.encode((input as readonly string[]).join('\n'))
        : (input as Uint8Array)
      return n('hexValidateBatch')(bytes, width) as Uint8Array
    },

    /**
     * Escape JS-RegExp metacharacters (`\ . * + ? ^ $ { } | ( ) [ ]`) so a
     * pattern built with `new RegExp(rust.regexEscape(userInput), 'i')`
     * matches the input LITERALLY. Under Bun the whole call is the FFI
     * crossing + the escape: the input crosses as a `cstring` ARG (engine-
     * transcoded, zero encode) and the result returns as a `cstring`
     * (engine-cloned, zero decode).
     *
     * @param input Arbitrary text or bytes (multi-byte UTF-8 passes through)
     * @returns The escaped pattern string
     * @example
     * ```ts
     * const re = new RegExp(rust.regexEscape('a.c*(x)'), 'i')
     * re.test('A.C(X)') // true — literal match, not wildcard semantics
     * ```
     */
    regexEscape(input: Uint8Array | string): string {
      const f = ffi()
      if (f) {
        if (typeof input === 'string') {
          const escaped = f.regexEscapeStr(input)
          if (escaped === null) throw new Error('regex escape failed')
          return escaped
        }
        // Bytes path: needed-size convention with a generous first guess.
        const bytes = toBytes(input)
        let out = new Uint8Array(bytes.length + 16)
        let w = f.regexEscapeInto(bytes, out)
        if (w > out.length) {
          out = new Uint8Array(w)
          w = f.regexEscapeInto(bytes, out)
        }
        return decodeUtf8(out.subarray(0, w))
      }
      // napi takes/returns strings directly.
      const s = typeof input === 'string' ? input : decodeUtf8(toBytes(input))
      return n('regexEscape')(s) as string
    },
  }
}
