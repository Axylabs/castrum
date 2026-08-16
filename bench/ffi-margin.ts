// bench/ffi-margin.ts — FULL native vs bun:ffi margin pinpointer.
//
// Runs the ENTIRE C-ABI surface (every op `bun:ffi` wraps) two ways and merges
// them into a loss-breakdown table that pinpoints WHERE the FFI-vs-native
// runtime cost is:
//
//   total      = ffi_alloc   − native          (what you pay vs pure native)
//   alloc      = ffi_alloc   − ffi_pooled      (output Uint8Array alloc)
//   resid      = ffi_pooled  − native − floor  (BigInt boxing + view/arg conv +
//                                               JS wrapper residual)
//   floor      = noop + view-conv + BigInt     (the irreducible C-ABI cost,
//                                               measured with ffi_probe_*)
//
// Native side = `native-bench` (release Rust binary, no JS/FFI boundary, the
// same pure cores the addon wraps). FFI side = the public `rust.*` path +
// pooled `*Into` variants on byte-identical inputs (sent to native-bench as
// base64 NDJSON on stdin).
//
// Run: `bun run bench:margin` (== `bun bench/ffi-margin.ts`). Requires the
// addon (`bun run build`) and the Rust toolchain for the native side (first
// run compiles native-bench, fat LTO ~1-2 min).

import { dlopen, type FFITypeOrString } from 'bun:ffi'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAddonPath } from '../src/native/loader'
import { getBunFFI } from '../src/native/ffi'
import { toBytes } from '../src/bench/assert'
import { rust } from '../src/rust-ffi'
import { encodeUtf8 } from '../src/shared/codec'
import {
  rawBase64Encode,
  rawCrc32,
  rawGzipCompress,
  rawHmacSha256,
  rawUrlEncode,
  rawXxh3,
} from '../src/bench/raw-native'
import { isBun } from '../src/shared/runtime'

// ── Inputs (small-input regime — where the crossing cost is visible) ──────
const encoder = new TextEncoder()
const enc = (s: string): Uint8Array => encoder.encode(s)
const inputs: Record<string, Uint8Array> = {
  crc_input: enc('Hello, practical CRC32 checksum test data!'),
  encode_data: enc(
    'the quick brown fox jumps over the lazy dog 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789',
  ),
  hex_input: enc(
    '74686520717569636b2062726f776e20666f78206a756d7073206f76657220746865206c617a7920646f6720303132333435363738392030313233343536373839203031323334353637383920303132333435363738392030313233343536373839203031323334353637383920303132333435363738392030313233343536373839',
  ),
  url_encode_input: enc('hello world & foo=bar'),
  url_decode_input: enc('hello%20world%20%26%20foo%3Dbar'),
  email_ok: enc('user@example.com'),
  uuid_ok: enc('550e8400-e29b-41d4-a716-446655440000'),
  ipv4_ok: enc('192.168.1.100'),
  ipv6_ok: enc('2001:db8::1'),
  json_payload: enc('[{"id":1,"name":"a"},{"id":2,"name":"b"}]'),
  etag_data: enc('etag data payload for the margin bench'),
  ws_key: enc('dGhlIHNhbXBsZSBub25jZQ=='),
  http_raw: enc(
    'GET /api/users?page=1&limit=20 HTTP/1.1\r\nHost: example.com\r\nAccept: application/json\r\n\r\n',
  ),
  query_str: enc('name=John+Doe&age=30&tags[]=a&tags[]=b'),
  cookie_str: enc('session=abc123; theme=dark; lang=en-US'),
  hmac_key: enc('super-secret-key-2026'),
  hmac_data: enc('message to sign with HMAC-SHA256'),
  compress_payload: enc(
    'row 0: the quick brown fox jumps over the lazy dog 0\nrow 1: the quick brown fox jumps over the lazy dog 1\nrow 2: the quick brown fox jumps over the lazy dog 2',
  ),
  cookie_value: enc('session-value'),
  cookie_secret: enc('s3cr3t-secret'),
  csrf_secret: enc('csrf-secret-2026'),
  password_bytes: enc('correct horse battery staple'),
  password_salt: enc('0123456789abcdef'),
  pbkdf2_password: enc('password'),
  pbkdf2_salt: enc('salt'),
  aead_key: enc('0123456789abcdef0123456789abcdef'),
  aead_nonce: enc('0123456789ab'),
  aead_plaintext: enc('sensitive session payload for the margin bench'),
  ws_payload: enc('Hello WebSocket! x10'),
  json_doc: enc('{"a":"b","c":1}'),
  json_patch_data: enc('[{"op":"replace","path":"/a","value":42}]'),
  jwt_claims: enc('{"sub":"user-1"}'),
  jwt_secret: enc('my-secret'),
  multipart_body: enc(
    '--FormBoundary1234\r\nContent-Disposition: form-data; name="field1"\r\n\r\nhello world\r\n--FormBoundary1234--\r\n',
  ),
  multipart_boundary: enc('FormBoundary1234'),
  content_type_multipart: enc('multipart/form-data; boundary=FormBoundary1234; charset=UTF-8'),
}

// Derived inputs shared with native-bench (byte-identical).
function derived(): Record<string, Uint8Array> {
  const encode = inputs.encode_data!
  const hmacKey = inputs.hmac_key!
  const hmacData = inputs.hmac_data!
  const compress = inputs.compress_payload!
  return {
    base64_input: encoder.encode(Buffer.from(encode).toString('base64')),
    hmac_sig: rawHmacSha256(hmacKey, hmacData),
    gzip_compressed: rawGzipCompress(compress),
    brotli_compressed: rust.brotliCompress(compress),
  }
}

// ── Timing helper (min-of-5 batches after warmup → ns/op) ─────────────────
function measure(fn: () => unknown, iterations: number): number {
  for (let i = 0; i < Math.max(iterations / 20, 1); i++) fn()
  let best = Infinity
  for (let b = 0; b < 5; b++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    const ns = ((performance.now() - start) * 1e6) / iterations
    if (ns < best) best = ns
  }
  return best
}

/** Bind a raw C-ABI symbol via bun:ffi for the diagnostic probes. */
function bindRaw(
  path: string,
  symbol: string,
  args: readonly string[],
  returns: string,
): ((...a: unknown[]) => number | bigint | void) | null {
  try {
    const { symbols } = dlopen(path, {
      [symbol]: {
        args: args as readonly FFITypeOrString[],
        returns: returns as FFITypeOrString,
      },
    })
    return symbols[symbol] as (...a: unknown[]) => number | bigint | void
  } catch {
    return null
  }
}

// ── Native side ────────────────────────────────────────────────────────────
function runNative(derivedInputs: Record<string, Uint8Array>): Map<string, number> {
  const all = { ...inputs, ...derivedInputs }
  const ndjson = Object.entries(all)
    .map(([k, v]) => `${k}\t${Buffer.from(v).toString('base64')}`)
    .join('\n')
  console.log('Running native-bench (Rust, release, no FFI boundary)...')
  const res = spawnSync('cargo', ['run', '--release', '--quiet', '--bin', 'native-bench'], {
    cwd: join(dirname(new URL(import.meta.url).pathname), '..'),
    input: ndjson,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (res.status !== 0) {
    throw new Error(
      `native-bench failed (exit ${res.status}): ${(res.stderr ?? '').slice(0, 2000)}`,
    )
  }
  const out = new Map<string, number>()
  for (const line of (res.stdout ?? '').split('\n')) {
    const [name, ns] = line.split('\t')
    if (name && ns) out.set(name, Number(ns))
  }
  return out
}

// ── Ops: FULL C-ABI surface ───────────────────────────────────────────────
interface Op {
  name: string
  native: string
  ffiAlloc: () => unknown
  ffiPooled: (() => unknown) | null
  iters: number
}

function makeOps(derivedInputs: Record<string, Uint8Array>): Op[] {
  const encode = inputs.encode_data!
  const hexIn = inputs.hex_input!
  const b64Pool = new Uint8Array(4096)
  const hexPool = new Uint8Array(4096)
  const urlEncPool = new Uint8Array(1024)
  const urlDecPool = new Uint8Array(1024)
  const etagPool = new Uint8Array(32)
  const hmacPool = new Uint8Array(64)
  const cookiePoolOut = new Uint8Array(256)
  const aeadPool = new Uint8Array(256)
  const wsFramePool = new Uint8Array(256)
  const wsFrameDecodePool = new Uint8Array(256)
  const httpPool = new Uint8Array(inputs.http_raw!.length * 9 + 16)
  const queryPool = new Uint8Array(inputs.query_str!.length * 9 + 16)
  const cookieParsePool = new Uint8Array(inputs.cookie_str!.length * 9 + 16)
  const formPool = new Uint8Array(inputs.query_str!.length * 9 + 16)
  const multipartPool = new Uint8Array(inputs.multipart_body!.length * 2 + 256)
  const rtPool = new Uint8Array(64)
  const gzPool = new Uint8Array(64 * 1024)
  const brPool = new Uint8Array(64 * 1024)

  // Precomputed inputs (once — the ops measure the op, not setup/derivation).
  const base64Input = derivedInputs.base64_input!
  const hmacSig = derivedInputs.hmac_sig!
  const gzipCompressed = derivedInputs.gzip_compressed!
  const brotliCompressed = derivedInputs.brotli_compressed!
  const signedCookie = toBytes(rust.signCookie(inputs.cookie_value!, inputs.cookie_secret!))
  const csrfTok = toBytes(rust.csrfToken(inputs.csrf_secret!))
  const aeadCt = rust.aeadEncrypt(inputs.aead_key!, inputs.aead_nonce!, inputs.aead_plaintext!)
  const wsFrame = rust.wsFrameEncode(1, inputs.ws_payload!, false, true)
  const pwOpts = { mCost: 8, tCost: 1, pCost: 1, outLen: 16 }
  const argonPhc = toBytes(rust.passwordHash(inputs.password_bytes!, inputs.password_salt!, pwOpts))
  const bcryptHash = rust.passwordHashBcrypt(inputs.password_bytes!, 4)

  return [
    // ── Hash / checksum ──
    { name: 'crc32', native: 'crc32', ffiAlloc: () => rawCrc32(inputs.crc_input!), ffiPooled: null, iters: 200_000 },
    { name: 'fnv1a64', native: 'fnv1a64', ffiAlloc: () => rust.fnv1a64(inputs.crc_input!), ffiPooled: null, iters: 200_000 },
    { name: 'xxh3', native: 'xxh3', ffiAlloc: () => rawXxh3(inputs.crc_input!), ffiPooled: null, iters: 200_000 },

    // ── Encode / decode ──
    { name: 'hex_encode', native: 'hex_encode', ffiAlloc: () => rust.hexEncode(encode), ffiPooled: () => rust.hexEncodeInto(encode, hexPool), iters: 100_000 },
    { name: 'hex_decode', native: 'hex_decode', ffiAlloc: () => rust.hexDecode(hexIn), ffiPooled: () => rust.hexDecodeInto(hexIn, hexPool), iters: 100_000 },
    { name: 'base64_encode', native: 'base64_encode', ffiAlloc: () => rawBase64Encode(encode), ffiPooled: () => rust.base64EncodeInto(encode, b64Pool), iters: 100_000 },
    { name: 'base64_decode', native: 'base64_decode', ffiAlloc: () => rust.base64Decode(base64Input), ffiPooled: () => rust.base64DecodeInto(base64Input, b64Pool), iters: 100_000 },
    { name: 'url_encode', native: 'url_encode', ffiAlloc: () => rawUrlEncode(inputs.url_encode_input!), ffiPooled: () => rust.urlEncodeInto(inputs.url_encode_input!, urlEncPool), iters: 100_000 },
    { name: 'url_decode', native: 'url_decode', ffiAlloc: () => rust.urlDecodeBytes(inputs.url_decode_input!), ffiPooled: () => rust.urlDecodeInto(inputs.url_decode_input!, urlDecPool), iters: 100_000 },

    // ── Validators ──
    { name: 'validate_email', native: 'validate_email', ffiAlloc: () => rust.validateEmail(inputs.email_ok!), ffiPooled: null, iters: 200_000 },
    { name: 'validate_uuid', native: 'validate_uuid', ffiAlloc: () => rust.validateUuid(inputs.uuid_ok!), ffiPooled: null, iters: 200_000 },
    { name: 'validate_ipv4', native: 'validate_ipv4', ffiAlloc: () => rust.validateIpv4(inputs.ipv4_ok!), ffiPooled: null, iters: 200_000 },
    { name: 'validate_ipv6', native: 'validate_ipv6', ffiAlloc: () => rust.validateIpv6(inputs.ipv6_ok!), ffiPooled: null, iters: 200_000 },

    // ── JSON (zero-DOM) ──
    { name: 'json_valid', native: 'json_valid', ffiAlloc: () => rust.jsonValid(inputs.json_payload!), ffiPooled: null, iters: 100_000 },
    { name: 'json_sum_ids', native: 'json_sum_ids', ffiAlloc: () => rust.jsonSumIds(inputs.json_payload!), ffiPooled: null, iters: 100_000 },

    // ── ETag / HTTP-date / WebSocket accept ──
    { name: 'etag', native: 'etag', ffiAlloc: () => rust.etag(inputs.etag_data!), ffiPooled: () => rust.etagInto(inputs.etag_data!, etagPool), iters: 100_000 },
    { name: 'ws_accept_key', native: 'ws_accept_key', ffiAlloc: () => rust.wsAcceptKey(inputs.ws_key!), ffiPooled: () => rust.wsAcceptKeyInto(inputs.ws_key!, etagPool), iters: 100_000 },
    { name: 'http_date', native: 'http_date', ffiAlloc: () => rust.httpDate(784111777), ffiPooled: () => rust.httpDateInto(784111777, etagPool), iters: 100_000 },

    // ── SSE (now FFI — new castrum_sse_encode_into) ──
    { name: 'sse_encode', native: 'sse_encode', ffiAlloc: () => rust.sseEncodeEvent('update', inputs.ws_payload!, '42', 3000), ffiPooled: () => rust.sseEncodeEventInto('update', inputs.ws_payload!, '42', 3000, wsFramePool), iters: 100_000 },

    // ── Media type (napi-only — reference for the object-marshal loss) ──
    { name: 'media_type_parse', native: 'media_type_parse', ffiAlloc: () => rust.parseMediaType(inputs.content_type_multipart!).mediaType.length, ffiPooled: null, iters: 100_000 },

    // ── HMAC ──
    { name: 'hmac_sha256', native: 'hmac_sha256', ffiAlloc: () => rawHmacSha256(inputs.hmac_key!, inputs.hmac_data!), ffiPooled: () => rust.hmacSha256Into(inputs.hmac_key!, inputs.hmac_data!, hmacPool), iters: 100_000 },
    { name: 'hmac_sha256_verify', native: 'hmac_sha256_verify', ffiAlloc: () => rust.hmacSha256Verify(inputs.hmac_key!, inputs.hmac_data!, toBytes(hmacSig)), ffiPooled: null, iters: 100_000 },

    // ── Cookies / CSRF ──
    { name: 'sign_cookie', native: 'sign_cookie', ffiAlloc: () => rust.signCookie(inputs.cookie_value!, inputs.cookie_secret!), ffiPooled: () => rust.signCookieInto(inputs.cookie_value!, inputs.cookie_secret!, cookiePoolOut), iters: 100_000 },
    { name: 'verify_cookie', native: 'verify_cookie', ffiAlloc: () => rust.verifyCookie(signedCookie, inputs.cookie_secret!), ffiPooled: () => rust.verifyCookieInto(signedCookie, inputs.cookie_secret!, cookiePoolOut), iters: 100_000 },
    { name: 'csrf_token', native: 'csrf_token', ffiAlloc: () => rust.csrfToken(inputs.csrf_secret!), ffiPooled: () => rust.csrfTokenInto(inputs.csrf_secret!, cookiePoolOut), iters: 100_000 },
    { name: 'csrf_verify', native: 'csrf_verify', ffiAlloc: () => rust.csrfVerify(csrfTok, inputs.csrf_secret!), ffiPooled: null, iters: 100_000 },

    // ── Password KDFs (work-bound; low iterations) ──
    { name: 'password_hash', native: 'password_hash', ffiAlloc: () => rust.passwordHash(inputs.password_bytes!, inputs.password_salt!, pwOpts).length, ffiPooled: null, iters: 50 },
    { name: 'password_verify', native: 'password_verify', ffiAlloc: () => rust.passwordVerify(inputs.password_bytes!, argonPhc), ffiPooled: null, iters: 50 },
    { name: 'password_hash_bcrypt', native: 'password_hash_bcrypt', ffiAlloc: () => rust.passwordHashBcrypt(inputs.password_bytes!, 4).length, ffiPooled: null, iters: 3 },
    { name: 'password_verify_bcrypt', native: 'password_verify_bcrypt', ffiAlloc: () => rust.passwordVerifyBcrypt(inputs.password_bytes!, bcryptHash), ffiPooled: null, iters: 3 },
    { name: 'pbkdf2_sha256', native: 'pbkdf2_sha256', ffiAlloc: () => rust.pbkdf2Sha256(inputs.pbkdf2_password!, inputs.pbkdf2_salt!, 1, 32).byteLength, ffiPooled: null, iters: 200 },

    // ── AEAD ──
    { name: 'aead_encrypt', native: 'aead_encrypt', ffiAlloc: () => rust.aeadEncrypt(inputs.aead_key!, inputs.aead_nonce!, inputs.aead_plaintext!), ffiPooled: () => rust.aeadEncryptInto(inputs.aead_key!, inputs.aead_nonce!, inputs.aead_plaintext!, aeadPool), iters: 100_000 },
    { name: 'aead_decrypt', native: 'aead_decrypt', ffiAlloc: () => rust.aeadDecrypt(inputs.aead_key!, inputs.aead_nonce!, aeadCt), ffiPooled: null, iters: 100_000 },

    // ── WebSocket frames ──
    { name: 'ws_frame_encode', native: 'ws_frame_encode', ffiAlloc: () => rust.wsFrameEncode(1, inputs.ws_payload!, false, true), ffiPooled: () => rust.wsFrameEncodeInto(1, inputs.ws_payload!, false, true, wsFramePool), iters: 100_000 },
    { name: 'ws_frame_decode', native: 'ws_frame_decode', ffiAlloc: () => rust.wsFrameDecode(wsFrame), ffiPooled: () => rust.wsFrameDecodePackedInto(wsFrame, wsFrameDecodePool), iters: 100_000 },

    // ── JSON patch ──
    { name: 'json_patch', native: 'json_patch', ffiAlloc: () => rust.jsonPatch(inputs.json_doc!, inputs.json_patch_data!), ffiPooled: null, iters: 100_000 },

    // ── Random token ──
    { name: 'random_token', native: 'random_token', ffiAlloc: () => rust.randomToken(16), ffiPooled: () => rust.randomTokenInto(16, rtPool), iters: 100_000 },

    // ── Packed parsers ──
    { name: 'http_parse_packed', native: 'http_parse_packed', ffiAlloc: () => rust.httpParseRequestPacked(inputs.http_raw!), ffiPooled: () => rust.httpParseRequestPackedInto(inputs.http_raw!, httpPool), iters: 50_000 },
    { name: 'query_parse_packed', native: 'query_parse_packed', ffiAlloc: () => rust.queryParsePacked(inputs.query_str!), ffiPooled: () => rust.queryParsePackedInto(inputs.query_str!, queryPool), iters: 50_000 },
    { name: 'cookie_parse_packed', native: 'cookie_parse_packed', ffiAlloc: () => rust.cookieParsePacked(inputs.cookie_str!), ffiPooled: () => rust.cookieParsePackedInto(inputs.cookie_str!, cookieParsePool), iters: 50_000 },
    { name: 'form_parse_packed', native: 'form_parse_packed', ffiAlloc: () => rust.formParsePacked(inputs.query_str!), ffiPooled: () => rust.formParsePackedInto(inputs.query_str!, formPool), iters: 50_000 },
    { name: 'multipart_parse_packed', native: 'multipart_parse_packed', ffiAlloc: () => rust.multipartParsePacked(inputs.multipart_body!, inputs.multipart_boundary!), ffiPooled: () => rust.multipartParsePackedInto(inputs.multipart_body!, inputs.multipart_boundary!, multipartPool), iters: 50_000 },

    // ── JWT ──
    { name: 'jwt_sign_bytes', native: 'jwt_sign_bytes', ffiAlloc: () => rust.jwtSignBytes(inputs.jwt_claims!, inputs.jwt_secret!, 0, 0), ffiPooled: () => rust.jwtSignBytesInto(inputs.jwt_claims!, inputs.jwt_secret!, cookiePoolOut, 0, 0), iters: 100_000 },

    // ── Compression ──
    { name: 'gzip_compress', native: 'gzip_compress', ffiAlloc: () => rawGzipCompress(inputs.compress_payload!), ffiPooled: () => rust.gzipCompressInto(inputs.compress_payload!, gzPool), iters: 3_000 },
    { name: 'brotli_compress', native: 'brotli_compress', ffiAlloc: () => rust.brotliCompress(inputs.compress_payload!), ffiPooled: () => rust.brotliCompressInto(inputs.compress_payload!, brPool), iters: 3_000 },
    { name: 'gzip_decompress', native: 'gzip_decompress', ffiAlloc: () => rust.gzipDecompress(gzipCompressed), ffiPooled: null, iters: 3_000 },
    { name: 'brotli_decompress', native: 'brotli_decompress', ffiAlloc: () => rust.brotliDecompress(brotliCompressed), ffiPooled: null, iters: 3_000 },
  ]
}

// ── The loss-breakdown table ──────────────────────────────────────────────
function render(rows: {
  name: string
  native: number
  ffi: number
  pooled: number
  floor: number
  alloc: number
  resid: number
}[]): void {
  console.log('\n=== native vs bun:ffi — FULL surface loss breakdown (ns/op) ===')
  console.log(
    'op'.padEnd(22),
    'native'.padStart(9),
    'ffi'.padStart(9),
    'pooled'.padStart(9),
    'overhead'.padStart(9),
    'x'.padStart(5),
    '|',
    'alloc'.padStart(7),
    'resid'.padStart(7),
  )
  for (const r of rows) {
    const overhead = r.ffi - r.native
    const mult = r.native > 0 ? r.ffi / r.native : 0
    console.log(
      r.name.padEnd(22),
      r.native.toFixed(1).padStart(9),
      r.ffi.toFixed(1).padStart(9),
      r.pooled.toFixed(1).padStart(9),
      overhead.toFixed(1).padStart(9),
      mult.toFixed(1).padStart(5),
      '|',
      r.alloc.toFixed(0).padStart(7),
      r.resid.toFixed(0).padStart(7),
    )
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
if (!isBun()) {
  throw new Error('bench:margin requires Bun (bun:ffi is the transport under study)')
}
if (getBunFFI() === null) {
  throw new Error(
    'bun:ffi is NOT active — cannot measure the FFI margin. Unset CASTRUM_FFI_MODE / ensure the addon self-test passes.',
  )
}

const addonPath = getAddonPath()
console.log(`addon: ${addonPath}`)

// 1. Diagnostic C-ABI floor probes (bench-only `ffi_probe_*` symbols).
const noop = bindRaw(addonPath, 'ffi_probe_noop', [], 'void')
const echoUsize = bindRaw(addonPath, 'ffi_probe_echo_usize', ['usize'], 'usize')
const echoUsizeFast = bindRaw(addonPath, 'ffi_probe_echo_usize', ['usize'], 'u64_fast')
const echoViewFast = bindRaw(
  addonPath,
  'ffi_probe_echo_view',
  ['buffer', 'buffer_length'],
  'u64_fast',
)
const view = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])

const tNoop = measure(() => noop?.(), 200_000)
const tEchoUsize = measure(() => echoUsize?.(1), 200_000)
const tEchoUsizeFast = measure(() => echoUsizeFast?.(1), 200_000)
const tEchoViewFast = measure(() => echoViewFast?.(view, view), 200_000)

const floorNoop = tNoop
const floorScalarConv = Math.max(tEchoUsizeFast - tNoop, 0)
const floorBigInt = Math.max(tEchoUsize - tEchoUsizeFast, 0)
const floorViewConv = Math.max(tEchoViewFast - tNoop - floorScalarConv, 0)
const floorTotal = floorNoop + floorViewConv + floorBigInt

console.log('\n=== fixed C-ABI per-call floor (ns) ===')
console.log(`  trampoline (noop)        : ${floorNoop.toFixed(1)}`)
console.log(`  scalar arg conversion    : ${floorScalarConv.toFixed(1)}`)
console.log(`  view->ptr + (ptr,len)    : ${floorViewConv.toFixed(1)}`)
console.log(`  BigInt boxing (usize ret): ${floorBigInt.toFixed(1)}`)
console.log(`  total floor (view+usize) : ${floorTotal.toFixed(1)}`)

// Cross-check the BigInt floor on a real op (hex_encode: usize vs u64_fast).
const hexEncodeUsize = bindRaw(
  addonPath,
  'castrum_hex_encode',
  ['buffer', 'buffer_length', 'buffer', 'buffer_length'],
  'usize',
)
const hexEncodeFast = bindRaw(
  addonPath,
  'castrum_hex_encode',
  ['buffer', 'buffer_length', 'buffer', 'buffer_length'],
  'u64_fast',
)
const hexProbeIn = inputs.encode_data!
const hexProbeOut = new Uint8Array(hexProbeIn.length * 2)
const tHexUsize = measure(
  () => hexEncodeUsize?.(hexProbeIn, hexProbeIn, hexProbeOut, hexProbeOut),
  100_000,
)
const tHexFast = measure(
  () => hexEncodeFast?.(hexProbeIn, hexProbeIn, hexProbeOut, hexProbeOut),
  100_000,
)
console.log(`  real-op BigInt: hex_encode usize=${tHexUsize.toFixed(1)}ns u64_fast=${tHexFast.toFixed(1)}ns Δ=${(tHexUsize - tHexFast).toFixed(1)}`)

// ── cstring-ARG vs JS-encode + (ptr,len) — Phase-1 gate ───────────────────
// This is the measurement that decides whether the string-input ops should be
// converted from `(ptr,len)` (with a JS-side `encoder.encode` per call) to a
// `'cstring'` ARG (the engine transcodes the JS string to a call-scoped
// NUL-terminated buffer; JS does zero encode). Both strategies are measured
// END-TO-END per call on representative inputs:
//   encode-path : encodeUtf8 (Bun ArrayBufferSink) + (ptr,len) probe call
//   cstr-path   : raw JS string → 'cstring' arg probe (no JS-side encode)
const echoCstr = bindRaw(addonPath, 'ffi_probe_echo_cstr', ['cstring'], 'u64_fast')
const strSamples: Record<string, string> = {
  email_ascii: 'user@example.com',
  uuid_ascii: '550e8400-e29b-41d4-a716-446655440000',
  token_ascii: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJpYXQiOjE3MDAwMDAwMDB9.sig',
  long_ascii:
    'the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog',
  unicode_utf16: 'héllo wörld — ünïcode ✓ ünïcode ✓ ünïcode ✓ ünïcode ✓',
}
console.log('\n=== cstring-ARG vs encode+(ptr,len) input strategy (ns/call) ===')
console.log(
  'sample'.padEnd(16),
  'encode+ptrlen'.padStart(13),
  'cstring-arg'.padStart(12),
  'Δ'.padStart(9),
  'cstr faster'.padStart(12),
)
const cstrRows: Record<string, { encodePath: number; cstrPath: number }> = {}
for (const [name, s] of Object.entries(strSamples)) {
  const tEncode = measure(() => {
    const v = encodeUtf8(s) // full production per-call cost (encode + call)
    void echoViewFast?.(v, v)
  }, 200_000)
  const tCstr = measure(() => echoCstr?.(s), 200_000)
  cstrRows[name] = { encodePath: tEncode, cstrPath: tCstr }
  const delta = tEncode - tCstr
  console.log(
    name.padEnd(16),
    tEncode.toFixed(1).padStart(13),
    tCstr.toFixed(1).padStart(12),
    delta.toFixed(1).padStart(9),
    (delta > 0 ? `${Math.round((delta / tEncode) * 100)}%` : 'LOSS').padStart(12),
  )
}
const cstrSamples = Object.values(cstrRows)
const cstrWinCount = cstrSamples.filter(r => r.cstrPath < r.encodePath).length
const cstrSampleCount = Object.keys(strSamples).length
const cstrMedEncode = (() => {
  const s = cstrSamples.map(r => r.encodePath).sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
})()
const cstrMedCstr = (() => {
  const s = cstrSamples.map(r => r.cstrPath).sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
})()
console.log(
  `\n  cstring-arg wins ${cstrWinCount}/${cstrSampleCount} samples; median ${cstrMedCstr.toFixed(1)}ns vs encode-path ${cstrMedEncode.toFixed(1)}ns (${cstrMedCstr <= cstrMedEncode ? 'ADOPT' : 'REJECT'})`,
)

// 2. Native timings (pure Rust, no boundary). Derived inputs computed ONCE so
//    the FFI ops below reference precomputed bytes (never re-run derivation).
const derivedInputs = derived()
const nativeNs = runNative(derivedInputs)

// 3. FFI-side timings for the same ops.
console.log('\nMeasuring bun:ffi side...')
const ops = makeOps(derivedInputs)
const rows: {
  name: string
  native: number
  ffi: number
  pooled: number
  floor: number
  alloc: number
  resid: number
}[] = []
for (const op of ops) {
  const tAlloc = measure(op.ffiAlloc, op.iters)
  const tPooled = op.ffiPooled ? measure(op.ffiPooled, op.iters) : tAlloc
  const nNative = nativeNs.get(op.native) ?? 0
  const alloc = op.ffiPooled ? tAlloc - tPooled : 0
  const resid = op.ffiPooled
    ? Math.max(tPooled - nNative - floorTotal, 0)
    : Math.max(tAlloc - nNative - floorTotal, 0)
  rows.push({ name: op.name, native: nNative, ffi: tAlloc, pooled: tPooled, floor: floorTotal, alloc, resid })
}
render(rows)

// 4. Persist a machine-readable report.
const outDir = join(dirname(new URL(import.meta.url).pathname), 'results', 'ffi-margin')
mkdirSync(outDir, { recursive: true })
const report = {
  addon: addonPath,
  bunVersion: process.versions.bun,
  floor: {
    noop: floorNoop,
    scalarConv: floorScalarConv,
    bigInt: floorBigInt,
    viewConv: floorViewConv,
    total: floorTotal,
  },
  hexEncodeBigIntDelta: tHexUsize - tHexFast,
  cstringArg: {
    samples: cstrRows,
    winCount: cstrWinCount,
    sampleCount: Object.keys(strSamples).length,
    medianEncodePath: cstrMedEncode,
    medianCstrPath: cstrMedCstr,
    verdict: cstrMedCstr <= cstrMedEncode ? 'adopt' : 'reject',
  },
  rows,
}
const reportPath = join(outDir, `latest-${Date.now()}.json`)
writeFileSync(reportPath, JSON.stringify(report, null, 2))
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(report, null, 2))
console.log(`\nMargin report written to ${reportPath}`)
