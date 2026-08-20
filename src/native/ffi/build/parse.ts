// src/native/ffi/build/parse.ts — parser / wire-format BunFFI methods.
//
// The packed parsers (HTTP request, query, cookie, form, multipart, ws frame
// decode), the packed structural JSON parser, media-type / http-date /
// accept-encoding verdicts, MIME lookup, URL resolve, http-date formatting,
// and SSE encoding. Receives the raw dlopen'd symbols and the per-bind context
// from `build()`.

import { decodeJsonPacked } from '../../../rust-ffi/scalar/json-packed'
import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import { EMPTY_VIEW, SELFTEST_HEX } from '../constants'
import type { BunFFI, Raw3, Raw4, Raw6, Raw7, Raw10 } from '../types'
import type { BuildCtx } from './util'
import { flag, growExact } from './util'

/**
 * Build the parser/wire-format methods of the BunFFI surface. `ctx` is
 * destructured so the method bodies read exactly as the original `build()`.
 */
export function buildParse(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView, scratchFor, dateScratch, dateScratchView } = ctx

  const httpParsePacked = sym.castrum_http_parse_request_packed as Raw4
  const queryParsePacked = sym.castrum_query_parse_packed as Raw4
  const cookieParsePacked = sym.castrum_cookie_parse_packed as Raw4
  const httpDateIntoRaw = sym.castrum_http_date_into as Raw3
  const sseEncodeIntoRaw = sym.castrum_sse_encode_into as Raw10
  const jsonParsePackedSym = sym.castrum_json_parse_packed as Raw4
  const wsFrameDecodePacked = sym.castrum_ws_frame_decode_packed as Raw4
  const multipartParsePacked = sym.castrum_multipart_parse_packed as Raw6
  const formParsePacked = sym.castrum_form_parse_packed as Raw4
  const wsFrameEncode = sym.castrum_ws_frame_encode as Raw7
  const parseMediaTypeSym = sym.castrum_parse_media_type as Raw4
  const parseHttpDateSym = sym.castrum_parse_http_date as Raw4
  const parseAcceptEncodingSym = sym.castrum_parse_accept_encoding as Raw4
  const urlEncodeQuerySym = sym.castrum_url_encode_query as (...a: unknown[]) => string | null
  const urlResolveSym = sym.castrum_url_resolve as (...a: unknown[]) => string | null
  const mimeFromExtensionSym = sym.castrum_mime_from_extension as (...a: unknown[]) => string | null

  return {
    httpParseRequestPackedInto(input, output) {
      const w = Number(httpParsePacked(input, lenOrView(input), output, lenOrView(output)))
      if (w === 0 && input.length !== 0) {
        throw new Error('http parse: output buffer too small or malformed request')
      }
      return w
    },
    queryParsePackedInto(input, output) {
      const w = Number(queryParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention: w > output.length = exact required size →
      // too-small (throw — the caller owns the buffer, nothing to grow);
      // w === 0 = real error (malformed %XX).
      if (w === 0 || w > output.length) {
        throw new Error('query parse: output buffer too small')
      }
      return w
    },
    cookieParsePackedInto(input, output) {
      const w = Number(cookieParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention (same as queryParsePackedInto).
      if (w === 0 || w > output.length) {
        throw new Error('cookie parse: output buffer too small')
      }
      return w
    },
    wsFrameEncode(opcode, payload, mask, fin) {
      // Header (max 10) + payload + mask key (4).
      const out = new Uint8Array(payload.length + 14)
      const w = Number(
        wsFrameEncode(
          opcode,
          payload,
          lenOrView(payload),
          flag(mask),
          flag(fin),
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return out.subarray(0, w)
    },
    wsFrameEncodeInto(opcode, payload, mask, fin, output) {
      // Header (max 10) + payload + mask key (4).
      const need = payload.length + 14
      if (output.length < need) {
        throw new Error('ws frame encode: output buffer too small')
      }
      const w = Number(
        wsFrameEncode(
          opcode,
          payload,
          lenOrView(payload),
          flag(mask),
          flag(fin),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('ws frame encode: output buffer too small')
      }
      return w
    },
    wsFrameDecodePacked(data) {
      // Max packed output = 6-byte header + payload.
      const out = new Uint8Array(data.length + 6)
      const w = Number(wsFrameDecodePacked(data, lenOrView(data), out, lenOrView(out)))
      return w === 0 ? null : out.subarray(0, w)
    },
    wsFrameDecodePackedInto(data, output) {
      // Pooled sibling: the caller provides the output buffer, sized to at
      // least `data.length + 6` (6-byte header + payload — the Rust core
      // returns 0 for BOTH too-small and malformed, so the caller must size
      // to the max; the allocating path always does). 0 = malformed → null,
      // mirroring the allocating path's return contract.
      const w = Number(wsFrameDecodePacked(data, lenOrView(data), output, lenOrView(output)))
      return w === 0 ? null : w
    },
    multipartParsePacked(body, boundary) {
      return growExact(
        (out) =>
          Number(
            multipartParsePacked(
              body,
              lenOrView(body),
              boundary,
              lenOrView(boundary),
              out,
              lenOrView(out),
            ),
          ),
        Math.min(body.length + boundary.length + 64, 64 * 1024),
        128 * 1024 * 1024,
        'multipart parse: output buffer too small',
      )
    },
    multipartParsePackedInto(body, boundary, output) {
      // Pooled sibling: the caller provides the output buffer. Needed-size
      // convention (same as queryParsePackedInto): w > output.length = exact
      // required size → throw; w === 0 = real error (malformed).
      const w = Number(
        multipartParsePacked(
          body,
          lenOrView(body),
          boundary,
          lenOrView(boundary),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0 || w > output.length) {
        throw new Error('multipart parse: output buffer too small or malformed body')
      }
      return w
    },
    formParsePackedInto(input, output) {
      const w = Number(formParsePacked(input, lenOrView(input), output, lenOrView(output)))
      // Needed-size convention (form aliases the query core — same convention).
      if (w === 0 || w > output.length) {
        throw new Error('form parse: output buffer too small')
      }
      return w
    },
    jsonParsePacked(input) {
      // Packed token stream (deduped string table + typed value tree) — the
      // scalar wrapper assembles the JS value from the tokens with NO second
      // JSON text parse. `0` = invalid JSON (real error → growExact throws);
      // `w > out.length` = exact required size (one exact retry).
      return growExact(
        (out) => Number(jsonParsePackedSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + (input.length >> 1), 16 * 1024 * 1024),
        Math.max(1024 * 1024, input.length * 16),
        'json parse packed: invalid JSON or output buffer too small',
      )
    },
    parseMediaType(input) {
      // Packed verdict: [u32 mediaTypeLen][mediaType][u32 charsetLen
      // (0xFFFFFFFF = none)][charset][u32 boundaryLen][boundary]
      // [u32 paramCount]{[u32 keyLen][key][u32 valLen][val]}. 0 = invalid media
      // type (real error → growExact throws); w > output.length = exact needed
      // size (one exact retry).
      return growExact(
        (out) => Number(parseMediaTypeSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + 64, 64 * 1024),
        1024 * 1024,
        'media type parse: invalid media type or output buffer too small',
      )
    },
    parseHttpDate(input) {
      // Packed [u8 ok][i64 secs LE] (9 B) / 1 B (ok=0). A too-small buffer is
      // never a 0 here — the Rust side reports the exact size (9/1) — so a 9-byte
      // buffer always succeeds. Reused scratch + cached DataView (no per-call
      // allocs).
      const out = dateScratch
      const w = Number(parseHttpDateSym(input, lenOrView(input), out, lenOrView(out)))
      if (w === 0) {
        throw new Error('http date parse: output buffer too small')
      }
      if (out[0] === 0) return null
      return dateScratchView.getBigInt64(1, true)
    },
    parseAcceptEncoding(input) {
      // Packed: [u32 count]{[u32 encLen][enc][f32 q][u32 order]} (empty header →
      // count 0, 4 bytes). 0 = too small (real error → growExact throws).
      return growExact(
        (out) => Number(parseAcceptEncodingSym(input, lenOrView(input), out, lenOrView(out))),
        Math.min(input.length + 64, 64 * 1024),
        1024 * 1024,
        'accept encoding parse: output buffer too small',
      )
    },
    urlEncodeQuery(input) {
      // Packed pairs `[u32 count]{[u32 keyLen][key][u32 valLen][val]}` (the JS
      // `packPairs` layout) → percent-encoded query TEXT as a cstring, keys
      // SORTED (matches the napi BTreeMap ordering). `null` = malformed packed
      // input / non-UTF-8 (napi parity: throws).
      return urlEncodeQuerySym(input, lenOrView(input))
    },
    urlResolve(base, reference) {
      // RFC 3986 resolution → cstring; `null` = non-UTF-8 input (napi parity).
      return urlResolveSym(base, lenOrView(base), reference, lenOrView(reference))
    },
    mimeFromExtension(ext) {
      // Extension → MIME → cstring (cstring ARG: the engine transcodes the JS
      // extension in-engine); unknown → `application/octet-stream` (never null).
      return mimeFromExtensionSym(ext)
    },
    httpDateInto(secs, output) {
      // 29-byte HTTP-date into the caller buffer. 0 = too-small buffer or
      // out-of-range year (napi httpDateInto throws on both).
      const w = Number(httpDateIntoRaw(secs, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('http date: output buffer too small or year out of range')
      }
      return w
    },
    httpDate(secs) {
      // Allocating sibling — 32-byte buffer always fits the 29-byte date, so
      // the only 0 case is an out-of-range year (napi falls back to the
      // allocating format! there — mirror with Date.toUTCString). Pooled
      // scratch (decoded synchronously — safe).
      const out = scratchFor(32)
      const w = Number(httpDateIntoRaw(secs ?? 0, out, lenOrView(out)))
      if (w !== 0) return decodeUtf8(out.subarray(0, w))
      return new Date((secs ?? 0) * 1000).toUTCString()
    },
    sseEncodeEvent(event, data, id, retry) {
      // One SSE event → bytes. event/id are encoded to UTF-8 only when
      // non-null (flag bits 1/2/4 = present) so a present-but-empty string is
      // distinct from absent (napi Option parity). growExact with the needed-size
      // convention; `data.length + 64` covers the common single-line case.
      const ev = event === null ? EMPTY_VIEW : encodeUtf8(event)
      const idv = id === null ? EMPTY_VIEW : encodeUtf8(id)
      const flags = (event === null ? 0 : 1) | (id === null ? 0 : 2) | (retry === null ? 0 : 4)
      return growExact(
        (out) =>
          Number(
            sseEncodeIntoRaw(
              ev,
              lenOrView(ev),
              data,
              lenOrView(data),
              idv,
              lenOrView(idv),
              flags,
              retry ?? 0,
              out,
              lenOrView(out),
            ),
          ),
        data.length + 64,
        1 << 20,
        'sse encode: output buffer too small',
      )
    },
    sseEncodeEventInto(event, data, id, retry, output) {
      // Pooled sibling — caller-owned output buffer (sized ≥ `data.length + 64`
      // for the common single-line case). Needed-size convention: w > output.length
      // = exact required size → throw; w === 0 = real error (invalid UTF-8).
      const ev = event === null ? EMPTY_VIEW : encodeUtf8(event)
      const idv = id === null ? EMPTY_VIEW : encodeUtf8(id)
      const flags = (event === null ? 0 : 1) | (id === null ? 0 : 2) | (retry === null ? 0 : 4)
      const w = Number(
        sseEncodeIntoRaw(
          ev,
          lenOrView(ev),
          data,
          lenOrView(data),
          idv,
          lenOrView(idv),
          flags,
          retry ?? 0,
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('sse encode: invalid UTF-8 in event/id')
      }
      if (w > output.length) {
        throw new Error('sse encode: output buffer too small')
      }
      return w
    },
  }
}

/**
 * Bind-time self-test for the parser/wire-format surface (the methods built
 * in `buildParse`). `false` disables the ffi layer and forces the napi
 * fallback.
 */
export function selfTestParse(b: BunFFI): boolean {
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  // WebSocket frame: text frame, FIN, no mask → first byte 0x81.
  const frame = b.wsFrameEncode(1, SELFTEST_HEX, false, true)
  if (frame.length === 0 || frame[0] !== 0x81) {
    return false
  }

  // Packed parsers (non-empty output). Packed output is LARGER than input
  // (each component gets a u32 length prefix), so size with the Rust
  // allocator's conservative upper bound (`input.len() * 9 + 16` in
  // query_parser.rs).
  const req = enc.encode('GET /a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n')
  const reqOut = new Uint8Array(req.length * 9 + 16)
  if (b.httpParseRequestPackedInto(req, reqOut) === 0) {
    return false
  }
  const qIn = enc.encode('a=1&b=2')
  const qOut = new Uint8Array(qIn.length * 9 + 16)
  if (b.queryParsePackedInto(qIn, qOut) === 0) {
    return false
  }
  const cIn = enc.encode('a=1; b=2')
  const cOut = new Uint8Array(cIn.length * 9 + 16)
  if (b.cookieParsePackedInto(cIn, cOut) === 0) {
    return false
  }

  // form parse shares the query core → 2 pairs.
  const fIn = enc.encode('a=1&b=2')
  const fOut = new Uint8Array(fIn.length * 9 + 16)
  if (b.formParsePackedInto(fIn, fOut) === 0 || fOut[0] !== 2) {
    return false
  }

  // multipart parse → 1 part named "field".
  const boundary = enc.encode('----boundary')
  // Wire format is `--{boundary}` — boundary is `----boundary`, so the body
  // must open with `------boundary`.
  const mBody = enc.encode(
    '------boundary\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n------boundary--',
  )
  const mOut = b.multipartParsePacked(mBody, boundary)
  if (mOut[0] !== 1) {
    return false
  }
  // Packed layout: [u32 count][u32 name_len][name]... → name_len at offset 4.
  const mNameLen =
    (mOut[4] ?? 0) | ((mOut[5] ?? 0) << 8) | ((mOut[6] ?? 0) << 16) | ((mOut[7] ?? 0) << 24)
  if (dec.decode(mOut.subarray(8, 8 + mNameLen)) !== 'field') {
    return false
  }

  // WS frame decode: encode("hello") → decode → fin=1, opcode=1, payload="hello".
  const wf = b.wsFrameEncode(1, SELFTEST_HEX, true, true)
  const wd = b.wsFrameDecodePacked(wf)
  if (wd === null || wd[0] !== 1 || wd[1] !== 1 || dec.decode(wd.subarray(6)) !== 'hello') {
    return false
  }
  if (b.wsFrameDecodePacked(enc.encode('\x80')) !== null) {
    return false
  }
  // Pooled sibling: same decode into a caller buffer; malformed → null.
  const wdInto = new Uint8Array(wf.length + 6)
  const wdW = b.wsFrameDecodePackedInto(wf, wdInto)
  if (
    wdW === null ||
    wdInto[0] !== 1 ||
    wdInto[1] !== 1 ||
    dec.decode(wdInto.subarray(6, wdW)) !== 'hello'
  ) {
    return false
  }
  if (b.wsFrameDecodePackedInto(enc.encode('\x80'), wdInto) !== null) {
    return false
  }

  // Multipart parse Into (pooled): 1 part named "field".
  const mOutInto = new Uint8Array(mBody.length + boundary.length + 64)
  const mW = b.multipartParsePackedInto(mBody, boundary, mOutInto)
  if (mW === 0 || mOutInto[0] !== 1) {
    return false
  }
  const mNameLenInto =
    (mOutInto[4] ?? 0) |
    ((mOutInto[5] ?? 0) << 8) |
    ((mOutInto[6] ?? 0) << 16) |
    ((mOutInto[7] ?? 0) << 24)
  if (dec.decode(mOutInto.subarray(8, 8 + mNameLenInto)) !== 'field') {
    return false
  }

  // HTTP-date Into: Sun, 06 Nov 1994 08:49:37 GMT (fixed 29 bytes).
  const dateOut = new Uint8Array(32)
  const dateW = b.httpDateInto(784111777, dateOut)
  if (dateW !== 29 || dec.decode(dateOut.subarray(0, dateW)) !== 'Sun, 06 Nov 1994 08:49:37 GMT') {
    return false
  }

  // SSE encode Into: event/id/retry present + null-omission parity.
  const sseData = enc.encode('hello')
  const sse1 = dec.decode(b.sseEncodeEvent('update', sseData, '42', 3000))
  if (sse1 !== 'id: 42\nevent: update\nretry: 3000\ndata: hello\n\n') {
    return false
  }
  const sse2 = dec.decode(b.sseEncodeEvent(null, sseData, null, null))
  if (sse2 !== 'data: hello\n\n') {
    return false
  }
  // Present-but-empty event string emits the line (Option parity vs napi).
  const sse3 = dec.decode(b.sseEncodeEvent('', sseData, null, null))
  if (sse3 !== 'event: \ndata: hello\n\n') {
    return false
  }
  // Pooled sibling: same bytes into a caller buffer; too-small throws.
  const ssePool = new Uint8Array(128)
  const sseW = b.sseEncodeEventInto('update', sseData, '42', 3000, ssePool)
  if (sseW !== sse1.length || dec.decode(ssePool.subarray(0, sseW)) !== sse1) {
    return false
  }
  try {
    b.sseEncodeEventInto('update', sseData, '42', 3000, new Uint8Array(4))
    return false
  } catch {
    // expected
  }

  // jsonParsePacked: packed token stream decodes (via the REAL public decoder)
  // to the same value as JSON.parse, with NO second text parse; invalid JSON
  // throws (napi parity). Also verifies the needed-size retry path.
  {
    const packed = b.jsonParsePacked(enc.encode('{"a":1,"b":[true,null,"x"],"n":{"v":2.5}}'))
    const v = decodeJsonPacked(packed) as { a: number; b: unknown[]; n: { v: number } }
    if (v.a !== 1 || v.b[0] !== true || v.b[1] !== null || v.b[2] !== 'x' || v.n.v !== 2.5) {
      return false
    }
    try {
      b.jsonParsePacked(enc.encode('nope'))
      return false
    } catch {
      // expected: invalid JSON → growExact throws
    }
  }

  // parseMediaType: packed verdict, mediaType at [4..4+len].
  const mt = b.parseMediaType(enc.encode('application/json; charset=utf-8'))
  const mtLen = new DataView(mt.buffer, mt.byteOffset, mt.byteLength).getUint32(0, true)
  if (mtLen === 0 || dec.decode(mt.subarray(4, 4 + mtLen)) !== 'application/json') {
    return false
  }

  // parseHttpDate: RFC 7231 vector → epoch; malformed → null.
  if (b.parseHttpDate(enc.encode('Sun, 06 Nov 1994 08:49:37 GMT')) !== 784111777n) {
    return false
  }
  if (b.parseHttpDate(enc.encode('not a date')) !== null) {
    return false
  }

  // parseAcceptEncoding: count, first encoding + q (f32 LE at offset 8+encLen).
  const ae = b.parseAcceptEncoding(enc.encode('gzip, deflate;q=0.5'))
  const aeView = new DataView(ae.buffer, ae.byteOffset, ae.byteLength)
  if (aeView.getUint32(0, true) !== 2) {
    return false
  }
  const aeLen = aeView.getUint32(4, true)
  if (dec.decode(ae.subarray(8, 8 + aeLen)) !== 'gzip') {
    return false
  }
  if (aeView.getFloat32(8 + aeLen, true) !== 1.0) {
    return false
  }

  // urlEncodeQuery (packed pairs → sorted query text). Build the packed pairs
  // inline — no shared/packed import on the bind-time critical path.
  const qpPacked = new Uint8Array(4 + 2 * (4 + 1 + 4 + 1))
  const qpView = new DataView(qpPacked.buffer)
  qpView.setUint32(0, 2, true)
  let qpOff = 4
  for (const [k, v] of [
    ['a', '1'],
    ['b', '2'],
  ] as const) {
    qpView.setUint32(qpOff, k.length, true)
    qpOff += 4
    qpPacked.set(enc.encode(k), qpOff)
    qpOff += k.length
    qpView.setUint32(qpOff, v.length, true)
    qpOff += 4
    qpPacked.set(enc.encode(v), qpOff)
    qpOff += v.length
  }
  if (b.urlEncodeQuery(qpPacked) !== 'a=1&b=2') {
    return false
  }

  // urlResolve: RFC 3986 §5.4.1.
  if (b.urlResolve(enc.encode('http://a/b/c/d;p?q'), enc.encode('g')) !== 'http://a/b/c/g') {
    return false
  }
  // mimeFromExtension: known + unknown fallback.
  if (b.mimeFromExtension('.js') !== 'text/javascript') {
    return false
  }
  if (b.mimeFromExtension('nope') !== 'application/octet-stream') {
    return false
  }
  // httpDate string form (RFC 7231 vector).
  if (b.httpDate(784111777) !== 'Sun, 06 Nov 1994 08:49:37 GMT') {
    return false
  }
  // wsFrameEncodeInto.
  const frameInto = new Uint8Array(64)
  if (b.wsFrameEncodeInto(1, SELFTEST_HEX, false, true, frameInto) === 0 || frameInto[0] !== 0x81) {
    return false
  }

  return true
}
