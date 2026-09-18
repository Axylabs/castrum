// src/native/ffi/build/parse-selftest.ts — bind-time self-test for the
// parser/wire-format BunFFI surface.
//
// Extracted from parse.ts so the method builders and the known-answer probes
// stay separate modules; `selftest.ts` ANDs this with the other per-domain
// probes.

import { decodeJsonPacked } from '../../../rust-ffi/scalar/json-packed'
import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import { SELFTEST_HEX } from '../constants'
import type { BunFFI } from '../types'

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
