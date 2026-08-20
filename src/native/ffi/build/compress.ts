// src/native/ffi/build/compress.ts — compression + JSON patch BunFFI methods.
//
// gzip / brotli compress-decompress (streaming C cores + the needed-size
// convention) and RFC 6902 JSON patch. Receives the raw dlopen'd symbols and
// the per-bind context from `build()`.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import {
  COMPRESS_HEADROOM,
  COMPRESS_INITIAL_CAP,
  COMPRESS_MAX_CAP,
  DECOMPRESS_FALLBACK_CAP,
  DECOMPRESS_GUESS_MULTIPLIER_BROTLI,
  DECOMPRESS_GUESS_MULTIPLIER_GZIP,
  DECOMPRESS_MIN_INITIAL,
  MAX_DECOMPRESSED,
  MAX_JSON_PATCH_OUTPUT,
  SELFTEST_HEX,
} from '../constants'
import type { BunFFI, Raw2, Raw5, Raw6 } from '../types'
import type { BuildCtx } from './util'
import { growExact } from './util'

/**
 * Build the compression/JSON-patch methods of the BunFFI surface. `ctx` is
 * destructured so the method bodies read exactly as the original `build()`.
 */
export function buildCompress(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView } = ctx

  const gzipCompress = sym.castrum_gzip_compress as Raw5
  const gzipDecompress = sym.castrum_gzip_decompress as Raw5
  const brotliCompress = sym.castrum_brotli_compress as Raw5
  const brotliDecompress = sym.castrum_brotli_decompress as Raw5
  const gzipIsize = sym.castrum_gzip_isize as Raw2
  const jsonPatch = sym.castrum_json_patch as Raw6

  return {
    jsonPatch(doc, patch) {
      return decodeUtf8(
        growExact(
          (out) =>
            Number(jsonPatch(doc, lenOrView(doc), patch, lenOrView(patch), out, lenOrView(out))),
          Math.min(Math.max(doc.length, patch.length) + 16, 64 * 1024),
          MAX_JSON_PATCH_OUTPUT,
          'json patch: output buffer too small or patch inapplicable',
        ),
      )
    },
    gzipCompress(data, level = 6) {
      // The C ABI streams the compressed output directly into `out` (no internal
      // Vec — see rust/payload/compress.rs gzip_compress_into). Cap the initial
      // so large compressible inputs don't pay a full-size allocation (measured:
      // a 75 KiB input compressed to <1 KiB — COMPRESS_INITIAL_CAP is plenty and
      // single-pass). growExact handles incompressible data with at most one
      // exact retry (no re-run loop).
      return growExact(
        (out) =>
          Number(gzipCompress(data, lenOrView(data), Math.min(level, 9), out, lenOrView(out))),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'gzip compress: output buffer too small',
      )
    },
    gzipCompressInto(data, output, level = 6) {
      const w = Number(
        gzipCompress(data, lenOrView(data), Math.min(level, 9), output, lenOrView(output)),
      )
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('gzip compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('gzip compress: output buffer too small')
      }
      return w
    },
    gzipDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Pre-size from the gzip ISIZE trailer via the C probe (exact for
      // single-member streams) so the happy path is a single native pass; fall
      // back to a multiplier guess. growExact handles any residual miss with
      // one exact retry, and invalid input throws immediately (no 64 MiB
      // grow-to-max allocation storm).
      const isize = Number(gzipIsize(data, lenOrView(data)))
      const initial =
        isize !== 0
          ? Math.min(isize, max)
          : Math.min(data.length * DECOMPRESS_GUESS_MULTIPLIER_GZIP, DECOMPRESS_FALLBACK_CAP)
      return growExact(
        (out) => Number(gzipDecompress(data, lenOrView(data), max, out, lenOrView(out))),
        initial,
        max,
        'gzip decompress: invalid stream or exceeded max decompressed size',
      )
    },
    gzipDecompressInto(data, output, maxDecompressed) {
      // Pooled sibling — the C ABI streams the decompressed output directly
      // into the caller buffer via the `_into` core (no internal Vec), keeping
      // the 64 MiB decompression-bomb cap. Needed-size convention: w === 0 =
      // real error (invalid stream / cap exceeded); w > output.length = exact
      // required size → throw (nothing to grow — the caller owns the buffer).
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      const w = Number(gzipDecompress(data, lenOrView(data), max, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('gzip decompress: invalid stream or exceeded max decompressed size')
      }
      if (w > output.length) {
        throw new Error('gzip decompress: output buffer too small')
      }
      return w
    },
    brotliCompress(data, quality = 5) {
      // Same cap rationale as gzipCompress (streaming core); growExact for
      // incompressible data.
      return growExact(
        (out) =>
          Number(brotliCompress(data, lenOrView(data), Math.min(quality, 11), out, lenOrView(out))),
        Math.min(data.length + COMPRESS_HEADROOM, COMPRESS_INITIAL_CAP),
        Math.max(data.length * 2 + COMPRESS_HEADROOM, COMPRESS_MAX_CAP),
        'brotli compress: output buffer too small',
      )
    },
    brotliCompressInto(data, output, quality = 5) {
      const w = Number(
        brotliCompress(data, lenOrView(data), Math.min(quality, 11), output, lenOrView(output)),
      )
      // Needed-size convention: w > output.length = too small; w === 0 = real error.
      if (w === 0) {
        throw new Error('brotli compress: invalid input')
      }
      if (w > output.length) {
        throw new Error('brotli compress: output buffer too small')
      }
      return w
    },
    brotliDecompress(data, maxDecompressed) {
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      // Brotli has no cheap trailer size: DECOMPRESS_GUESS_MULTIPLIER_BROTLI×
      // initial covers typical JSON/text ratios (~10-30x) while the fallback
      // cap bounds over-allocation on large streams; growExact handles
      // higher-ratio streams with one exact retry.
      return growExact(
        (out) => Number(brotliDecompress(data, lenOrView(data), max, out, lenOrView(out))),
        Math.min(
          Math.max(data.length * DECOMPRESS_GUESS_MULTIPLIER_BROTLI, DECOMPRESS_MIN_INITIAL),
          DECOMPRESS_FALLBACK_CAP,
        ),
        max,
        'brotli decompress: invalid stream or exceeded max decompressed size',
      )
    },
    brotliDecompressInto(data, output, maxDecompressed) {
      // Pooled sibling — streams into the caller buffer, keeps the 64 MiB cap
      // (same convention as gzipDecompressInto above).
      const max = maxDecompressed ?? MAX_DECOMPRESSED
      const w = Number(brotliDecompress(data, lenOrView(data), max, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('brotli decompress: invalid stream or exceeded max decompressed size')
      }
      if (w > output.length) {
        throw new Error('brotli decompress: output buffer too small')
      }
      return w
    },
  }
}

/**
 * Bind-time self-test for the compression/JSON-patch surface (the methods
 * built in `buildCompress`). `false` disables the ffi layer and forces the
 * napi fallback.
 */
export function selfTestCompress(b: BunFFI): boolean {
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  // JSON patch: add a key.
  const patched = b.jsonPatch(
    enc.encode(`{"a":"b"}`),
    enc.encode(`[{"op":"add","path":"/c","value":"d"}]`),
  )
  if (!patched.includes(`"c":"d"`)) {
    return false
  }

  // gzip / brotli round-trips.
  const gz = b.gzipCompress(SELFTEST_HEX)
  if (dec.decode(b.gzipDecompress(gz)) !== 'hello') {
    return false
  }
  const br = b.brotliCompress(SELFTEST_HEX)
  if (dec.decode(b.brotliDecompress(br)) !== 'hello') {
    return false
  }

  // Needed-size convention: invalid compressed input throws IMMEDIATELY (the C
  // ABI returns 0 = real error, so the JS wrapper does NOT grow-retry re-runs
  // or allocate up to the 64 MiB decompression cap per bad input).
  let decompressThrew = false
  try {
    b.gzipDecompress(enc.encode('not-a-gzip-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }
  decompressThrew = false
  try {
    b.brotliDecompress(enc.encode('not-brotli-stream'))
  } catch {
    decompressThrew = true
  }
  if (!decompressThrew) {
    return false
  }

  // gzipCompressInto → decompress round-trip.
  const gzInto = new Uint8Array(64)
  const gzW = b.gzipCompressInto(SELFTEST_HEX, gzInto)
  if (gzW === 0 || dec.decode(b.gzipDecompress(gzInto.subarray(0, gzW))) !== 'hello') {
    return false
  }
  // brotliCompressInto → decompress round-trip.
  const brInto = new Uint8Array(64)
  const brW = b.brotliCompressInto(SELFTEST_HEX, brInto)
  if (brW === 0 || dec.decode(b.brotliDecompress(brInto.subarray(0, brW))) !== 'hello') {
    return false
  }
  // gzipDecompressInto → decompress into a CALLER buffer round-trip.
  const gzDst = new Uint8Array(16)
  const gzDW = b.gzipDecompressInto(gzInto.subarray(0, gzW), gzDst)
  if (gzDW === 0 || dec.decode(gzDst.subarray(0, gzDW)) !== 'hello') {
    return false
  }
  // brotliDecompressInto → decompress into a CALLER buffer round-trip.
  const brDst = new Uint8Array(16)
  const brDW = b.brotliDecompressInto(brInto.subarray(0, brW), brDst)
  if (brDW === 0 || dec.decode(brDst.subarray(0, brDW)) !== 'hello') {
    return false
  }

  return true
}
