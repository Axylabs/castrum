// bench/ffi/ffi-all.ts — FFI (PRIMARY on Bun) vs NAPI (fallback/reference) for
// EVERY migrated function.
//
// bun:ffi is the PRIMARY transport under Bun; the napi addon is the fallback
// (Node, `CASTRUM_FFI_MODE=napi`, or a failed bind-time self-test). This bench
// measures the napi addon call (`getAddon().<fn>`) against the ffi path
// (`rust.<fn>`, which is bun:ffi when the fast path is live) and reports the
// speedup — napi is the reference oracle that guards byte-for-byte parity. The
// ingress request handler (`Ingress.handleRequestPacked`) is compared directly
// via the opaque inner handle. Min-of-trials with `Bun.gc()` between trials
// (the host is noisy; min isolates the true crossing + core cost).
//
// Run: bun run bench/ffi-all.ts
import { rust } from '../../index'
import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { toBytes } from '../../src/bench/assert'
import { IngressInputPacker } from '../../src/ingress/packing/input-packer'

const addon = getAddon()
const ffi = getBunFFI()
const encoder = new TextEncoder()

if (ffi === null) {
  throw new Error(
    'bun:ffi (the PRIMARY transport on Bun) is NOT active — nothing to compare. ' +
      '(Node, CASTRUM_FFI_MODE=napi, or a failed bind-time self-test?)',
  )
}
console.log('bun:ffi primary transport active:', true)

// ── Input fixtures ───────────────────────────────────────────────
const SMALL = encoder.encode('Hello, practical CRC32 checksum test data! hello world & foo=bar')
const MEDIUM = encoder.encode('the quick brown fox jumps over the lazy dog 1234567890 '.repeat(20))
const LARGE = encoder.encode('the quick brown fox jumps over the lazy dog 1234567890 '.repeat(1280))
const jsonArr = encoder.encode(
  JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user_${i}` }))),
)
const jsonDoc = encoder.encode('{"a":1,"b":{"c":[1,2,3]}}')
const jsonPatch = encoder.encode('[{"op":"replace","path":"/a","value":42}]')
const email = encoder.encode('user@example.com')
const uuid = encoder.encode('550e8400-e29b-41d4-a716-446655440000')
const ipv4 = encoder.encode('192.168.1.100')
const ipv6 = encoder.encode('2001:db8::1')
const hmacKey = new Uint8Array(32).fill(0x42)
const cookieSecret = encoder.encode('s3cr3t-secret-0123456789')
const aeadNonce = new Uint8Array(12).fill(0x07)
const wsKey = encoder.encode('dGhlIHNhbXBsZSBub25jZQ==')
const boundary = encoder.encode('----castrum')
const multipartBody = encoder.encode(
  '------castrum\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n' +
    '------castrum\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
    '------castrum--',
)
const httpReq = encoder.encode('GET /api/users?page=1&x=2 HTTP/1.1\r\nhost: example.com\r\naccept: */*\r\n\r\n')
const query = encoder.encode('a=1&b=hello%20world&c=%C3%A9&d=4')
const cookies = encoder.encode('sid=abc123; theme=dark; locale=en-US')
const form = encoder.encode('a=1&b=hello%20world&c=%C3%A9')
const jwtClaims = encoder.encode(JSON.stringify({ sub: 'user-1', role: 'admin' }))
const jwtSecret = encoder.encode('my-secret')
const pass = encoder.encode('correct horse battery staple')
const passSalt = encoder.encode('salty-salt-16bytes')
const pwOpts = { mCost: 8, tCost: 1, pCost: 1, outLen: 16 }

// Reusable output buffers for the pooled _into / handler paths.
const hexOut = new Uint8Array(LARGE.length * 2)
const urlOut = new Uint8Array(LARGE.length * 3)
const ingressOut = new Uint8Array(4096)

// ── Measurement harness ──────────────────────────────────────────
interface BenchEntry {
  name: string
  napi: () => unknown
  ffi: () => unknown
  /** approx ns per call for the slowest path — sets the loop count */
  n?: number
  verify?: () => boolean
}

function measure(fn: () => unknown, n: number, trials = 7): number {
  for (let i = 0; i < Math.min(n, 2000); i++) fn() // warmup (absorbs ffi bind + JIT)
  let best = Infinity
  for (let t = 0; t < trials; t++) {
    if (Bun.gc) Bun.gc(true)
    const start = performance.now()
    for (let i = 0; i < n; i++) fn()
    best = Math.min(best, ((performance.now() - start) / n) * 1e3)
  }
  return best // µs
}

const results: Array<{ name: string; napi: number; ffi: number; speedup: number }> = []

function run(entries: BenchEntry[], label: string): void {
  console.log(`\n═══ ${label} ═══`)
  console.log(`${'function'.padEnd(44)} ${'napi µs'.padStart(10)} ${'ffi µs'.padStart(10)} ${'speedup'.padStart(9)}`)
  for (const e of entries) {
    if (e.verify && !e.verify()) {
      console.log(`${e.name.padEnd(44)} ${'MISMATCH — skipped'.padStart(29)}`)
      continue
    }
    const n = e.n ?? 200_000
    const tN = measure(e.napi, n)
    const tF = measure(e.ffi, n)
    const speedup = tN / tF
    results.push({ name: e.name, napi: tN, ffi: tF, speedup })
    console.log(
      `${e.name.padEnd(44)} ${tN.toFixed(3).padStart(10)} ${tF.toFixed(3).padStart(10)} ${speedup.toFixed(2).padStart(8)}x`,
    )
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => b[i] === v)

// ── Hashing ──────────────────────────────────────────────────────
run(
  [
    { name: 'crc32 (small)', napi: () => addon.crc32(SMALL), ffi: () => rust.crc32(SMALL), verify: () => rust.crc32(SMALL) === addon.crc32(SMALL) },
    { name: 'crc32 (64 KiB)', n: 50_000, napi: () => addon.crc32(LARGE), ffi: () => rust.crc32(LARGE) },
    { name: 'fnv1a64 (small)', napi: () => addon.fnv1a64(SMALL), ffi: () => rust.fnv1a64(SMALL) },
    { name: 'xxh3 (small)', napi: () => addon.xxh3(SMALL), ffi: () => rust.xxh3(SMALL) },
    { name: 'xxh3 (64 KiB)', n: 50_000, napi: () => addon.xxh3(LARGE), ffi: () => rust.xxh3(LARGE) },
  ],
  'Hashing',
)

// ── JSON ─────────────────────────────────────────────────────────
run(
  [
    { name: 'jsonValid (small)', napi: () => addon.jsonValid(jsonDoc), ffi: () => rust.jsonValid(jsonDoc) },
    { name: 'jsonValid (200 rows)', n: 50_000, napi: () => addon.jsonValid(jsonArr), ffi: () => rust.jsonValid(jsonArr) },
    { name: 'jsonSumIds (200 rows)', n: 50_000, napi: () => addon.jsonSumIds(jsonArr), ffi: () => rust.jsonSumIds(jsonArr) },
    { name: 'jsonPatch (small)', n: 50_000, napi: () => addon.jsonPatch(jsonDoc, jsonPatch), ffi: () => rust.jsonPatch(jsonDoc, jsonPatch) },
  ],
  'JSON',
)

// ── Codecs ───────────────────────────────────────────────────────
run(
  [
    { name: 'hexEncode (small)', napi: () => addon.hexEncode(SMALL), ffi: () => rust.hexEncode(SMALL) },
    { name: 'hexEncode (64 KiB)', n: 20_000, napi: () => addon.hexEncode(LARGE), ffi: () => rust.hexEncode(LARGE) },
    { name: 'hexEncodeInto (pooled)', n: 50_000, napi: () => addon.hexEncodeInto(LARGE, hexOut), ffi: () => rust.hexEncodeInto(LARGE, hexOut) },
    { name: 'hexDecode', napi: () => addon.hexDecode(encoder.encode('68656c6c6f20776f726c64')), ffi: () => rust.hexDecode(encoder.encode('68656c6c6f20776f726c64')) },
    { name: 'urlEncode (small)', napi: () => addon.urlEncode(SMALL), ffi: () => rust.urlEncode(SMALL) },
    { name: 'urlEncodeInto (pooled)', n: 50_000, napi: () => addon.urlEncodeInto(SMALL, urlOut), ffi: () => rust.urlEncodeInto(SMALL, urlOut) },
    { name: 'urlDecode', napi: () => addon.urlDecode(encoder.encode('a%20b%2Fc%3Fd%3De')), ffi: () => rust.urlDecode(encoder.encode('a%20b%2Fc%3Fd%3De')) },
    { name: 'base64Encode', napi: () => addon.base64Encode(MEDIUM), ffi: () => rust.base64Encode(MEDIUM) },
    { name: 'base64Decode', napi: () => addon.base64Decode(encoder.encode('aGVsbG8gd29ybGQ=')), ffi: () => rust.base64Decode(encoder.encode('aGVsbG8gd29ybGQ=')) },
    { name: 'base64UrlEncode', napi: () => addon.base64UrlEncode(MEDIUM), ffi: () => rust.base64UrlEncode(MEDIUM) },
    { name: 'base64UrlDecode', napi: () => addon.base64UrlDecode(encoder.encode('aGVsbG8')), ffi: () => rust.base64UrlDecode(encoder.encode('aGVsbG8')) },
  ],
  'Codecs',
)

// ── Validators ───────────────────────────────────────────────────
run(
  [
    { name: 'validateEmail', napi: () => addon.validateEmail(email), ffi: () => rust.validateEmail(email) },
    { name: 'validateUuid', napi: () => addon.validateUuid(uuid), ffi: () => rust.validateUuid(uuid) },
    { name: 'validateIpv4', napi: () => addon.validateIpv4(ipv4), ffi: () => rust.validateIpv4(ipv4) },
    { name: 'validateIpv6', napi: () => addon.validateIpv6(ipv6), ffi: () => rust.validateIpv6(ipv6) },
  ],
  'Validators',
)

// ── Crypto ───────────────────────────────────────────────────────
const hmacData = MEDIUM
const hmacSig = toBytes(rust.hmacSha256(hmacKey, hmacData))
run(
  [
    { name: 'hmacSha256 (medium)', n: 50_000, napi: () => addon.hmacSha256(hmacKey, hmacData), ffi: () => rust.hmacSha256(hmacKey, hmacData) },
    { name: 'hmacSha256Verify', n: 50_000, napi: () => addon.hmacSha256Verify(hmacKey, hmacData, hmacSig), ffi: () => rust.hmacSha256Verify(hmacKey, hmacData, hmacSig) },
    { name: 'signCookie', n: 50_000, napi: () => addon.signCookie(SMALL, cookieSecret), ffi: () => rust.signCookie(SMALL, cookieSecret) },
    { name: 'verifyCookie', n: 50_000, napi: () => addon.verifyCookie(toBytes(rust.signCookie(SMALL, cookieSecret)), cookieSecret), ffi: () => rust.verifyCookie(toBytes(rust.signCookie(SMALL, cookieSecret)), cookieSecret) },
    { name: 'csrfToken', n: 50_000, napi: () => addon.csrfToken(cookieSecret), ffi: () => rust.csrfToken(cookieSecret) },
    { name: 'csrfVerify', n: 50_000, napi: () => addon.csrfVerify(toBytes(rust.csrfToken(cookieSecret)), cookieSecret), ffi: () => rust.csrfVerify(toBytes(rust.csrfToken(cookieSecret)), cookieSecret) },
    { name: 'randomToken (16B)', n: 50_000, napi: () => addon.randomToken(16), ffi: () => rust.randomToken(16) },
    { name: 'pbkdf2Sha256 (c=1)', n: 10_000, napi: () => addon.pbkdf2Sha256(pass, passSalt, 1, 32), ffi: () => rust.pbkdf2Sha256(pass, passSalt, 1, 32) },
    { name: 'aeadEncrypt (AES-GCM)', n: 20_000, napi: () => addon.aeadEncrypt(hmacKey, aeadNonce, MEDIUM), ffi: () => rust.aeadEncrypt(hmacKey, aeadNonce, MEDIUM) },
    { name: 'aeadDecrypt', n: 20_000, napi: () => addon.aeadDecrypt(hmacKey, aeadNonce, rust.aeadEncrypt(hmacKey, aeadNonce, MEDIUM)), ffi: () => rust.aeadDecrypt(hmacKey, aeadNonce, rust.aeadEncrypt(hmacKey, aeadNonce, MEDIUM)) },
    { name: 'jwtSignBytes', n: 50_000, napi: () => addon.jwtSignBytes(jwtClaims, jwtSecret, 60, 1700000000), ffi: () => rust.jwtSignBytes(jwtClaims, jwtSecret, 60, 1700000000) },
    { name: 'passwordHash (m=8)', n: 2_000, napi: () => addon.passwordHash(pass, passSalt, pwOpts), ffi: () => rust.passwordHash(pass, passSalt, pwOpts) },
    { name: 'passwordVerify (argon2)', n: 2_000, napi: () => addon.passwordVerify(pass, toBytes(rust.passwordHash(pass, passSalt, pwOpts))), ffi: () => rust.passwordVerify(pass, toBytes(rust.passwordHash(pass, passSalt, pwOpts))) },
    { name: 'passwordHashBcrypt (c=4)', n: 2_000, napi: () => addon.passwordHashBcrypt(pass, 4), ffi: () => rust.passwordHashBcrypt(pass, 4) },
    { name: 'passwordVerifyBcrypt', n: 2_000, napi: () => addon.passwordVerifyBcrypt(pass, rust.passwordHashBcrypt(pass, 4)), ffi: () => rust.passwordVerifyBcrypt(pass, rust.passwordHashBcrypt(pass, 4)) },
  ],
  'Crypto',
)

// ── HTTP / parsing ───────────────────────────────────────────────
run(
  [
    { name: 'wsAcceptKey', napi: () => addon.wsAcceptKey(wsKey), ffi: () => rust.wsAcceptKey(wsKey) },
    { name: 'etag', napi: () => addon.etag(SMALL), ffi: () => rust.etag(SMALL) },
    { name: 'etag (weak)', napi: () => addon.etag(SMALL, true), ffi: () => rust.etag(SMALL, true) },
    { name: 'httpParseRequestPacked', n: 50_000, napi: () => addon.httpParseRequestPacked(httpReq), ffi: () => rust.httpParseRequestPacked(httpReq) },
    { name: 'queryParsePacked', n: 50_000, napi: () => addon.queryParsePacked(query), ffi: () => rust.queryParsePacked(query) },
    { name: 'cookieParsePacked', n: 50_000, napi: () => addon.cookieParsePacked(cookies), ffi: () => rust.cookieParsePacked(cookies) },
    { name: 'formParsePacked', n: 50_000, napi: () => addon.formParsePacked(form), ffi: () => rust.formParsePacked(form) },
  ],
  'HTTP / parsing',
)

// ── Payload ──────────────────────────────────────────────────────
const gz = rust.gzipCompress(MEDIUM)
const br = rust.brotliCompress(MEDIUM, 5)
const wsFrame = rust.wsFrameEncode(1, SMALL, true, true)
run(
  [
    { name: 'gzipCompress (medium)', n: 10_000, napi: () => addon.gzipCompress(MEDIUM), ffi: () => rust.gzipCompress(MEDIUM) },
    { name: 'gzipDecompress', n: 10_000, napi: () => addon.gzipDecompress(gz), ffi: () => rust.gzipDecompress(gz) },
    { name: 'brotliCompress (q5)', n: 5_000, napi: () => addon.brotliCompress(MEDIUM, 5), ffi: () => rust.brotliCompress(MEDIUM, 5) },
    { name: 'brotliDecompress', n: 10_000, napi: () => addon.brotliDecompress(br), ffi: () => rust.brotliDecompress(br) },
    { name: 'wsFrameEncode', n: 50_000, napi: () => addon.wsFrameEncode(1, SMALL, true, true), ffi: () => rust.wsFrameEncode(1, SMALL, true, true) },
    { name: 'wsFrameDecode', n: 50_000, napi: () => addon.wsFrameDecode(wsFrame), ffi: () => rust.wsFrameDecode(wsFrame) },
    { name: 'multipartParsePacked', n: 50_000, napi: () => addon.multipartParsePacked(multipartBody, boundary), ffi: () => rust.multipartParsePacked(multipartBody, boundary) },
  ],
  'Payload',
)

// ── Ingress request handler (the headline) ───────────────────────
const handler = new addon.Ingress({ parseQuery: true, parseCookies: true })
const ingressPtr =
  typeof handler.ingressInnerPtr === 'function' ? Number(handler.ingressInnerPtr()) : 0
const packer = new IngressInputPacker()
const ingressInput = packer.pack(
  0,
  encoder.encode('/api/users?page=1&limit=10'),
  encoder.encode('127.0.0.1'),
  encoder.encode('rid-0123456789'),
  new Uint8Array(0), // empty headers section
)
const ingressBody = encoder.encode('{"name":"alice","role":"admin"}')

function benchIngressDirect(): void {
  // Function declarations are hoisted, so TS won't carry the module-level `ffi`
  // narrowing in here — re-narrow explicitly (guarded by the throw at the top).
  const ffiLive = ffi!
  console.log('\n═══ Ingress request handler (native handleRequestPacked) ═══')
  console.log(`${'function'.padEnd(44)} ${'napi µs'.padStart(10)} ${'ffi µs'.padStart(10)} ${'speedup'.padStart(9)}`)
  const napiRun = () => handler.handleRequestPacked(ingressInput, ingressBody, ingressOut)
  const ffiRun = () => ffiLive.ingressHandlePacked(ingressPtr, ingressInput, ingressBody, ingressOut)
  // correctness
  const outA = new Uint8Array(4096)
  const wA = handler.handleRequestPacked(ingressInput, ingressBody, outA)
  const outB = new Uint8Array(4096)
  const wB = ffiLive.ingressHandlePacked(ingressPtr, ingressInput, ingressBody, outB)
  if (wA !== wB || !sameBytes(outA.subarray(0, wA), outB.subarray(0, wB))) {
    console.log('MISMATCH between napi and ffi ingress output — aborting')
    process.exit(1)
  }
  const n = 100_000
  const tN = measure(napiRun, n)
  const tF = measure(ffiRun, n)
  const speedup = tN / tF
  results.push({ name: 'ingress.handleRequestPacked', napi: tN, ffi: tF, speedup })
  console.log(
    `${'ingress.handleRequestPacked'.padEnd(44)} ${tN.toFixed(3).padStart(10)} ${tF.toFixed(3).padStart(10)} ${speedup.toFixed(2).padStart(8)}x`,
  )
}
benchIngressDirect()

// ── Sustained high-throughput load: does FFI degrade? ────────────
// Runs fixed-duration windows in sequence and reports ops/sec per window for
// BOTH paths. `last/first` ≈ 1.0 means throughput holds steady under sustained
// load; <1.0 means it degrades (JIT deopt / GC pressure / allocation churn).
// FFI's per-call fresh-buffer allocations are the main degradation risk, so an
// explicit-GC "pressure" variant is included for the allocation-heavy
// functions (hexEncode + the ingress handler). NAPI and FFI are interleaved
// per window so any host drift is shared by both.
//
// Longer runs: CASTRUM_FFI_LOAD_WINDOWS=n CASTRUM_FFI_LOAD_MS=m bun run bench/ffi-all.ts
interface LoadCase {
  name: string
  napi: () => unknown
  ffi: () => unknown
  gcEvery?: number // force Bun.gc(true) every N ops (simulates allocation churn)
}

function sustainedOps(fn: () => unknown, durationMs: number, gcEvery?: number): number {
  let ops = 0
  const end = performance.now() + durationMs
  if (gcEvery === undefined) {
    while (performance.now() < end) {
      fn()
      ops++
    }
    return (ops / durationMs) * 1000
  }
  let since = 0
  while (performance.now() < end) {
    fn()
    ops++
    if (++since >= gcEvery) {
      since = 0
      if (Bun.gc) Bun.gc(true)
    }
  }
  return (ops / durationMs) * 1000
}

const fmtOps = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M/s' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k/s' : n.toFixed(0) + '/s'

const opsLine = (ops: number[]): string => ops.map(fmtOps).join('  ')

function runLoadStability(cases: LoadCase[], label: string, windows: number, durationMs: number): void {
  console.log(`\n═══ ${label} (${windows} × ${durationMs}ms windows) ═══`)
  for (const c of cases) {
    // warmup both paths (absorbs the one-time ffi bind + JIT)
    for (let i = 0; i < 2000; i++) c.napi()
    for (let i = 0; i < 2000; i++) c.ffi()
    const napiOps: number[] = []
    const ffiOps: number[] = []
    for (let w = 0; w < windows; w++) {
      napiOps.push(sustainedOps(c.napi, durationMs, c.gcEvery))
      ffiOps.push(sustainedOps(c.ffi, durationMs, c.gcEvery))
    }
    const nFirst = napiOps[0]!
    const fFirst = ffiOps[0]!
    const nRatio = napiOps[napiOps.length - 1]! / nFirst
    const fRatio = ffiOps[ffiOps.length - 1]! / fFirst
    const tag = c.gcEvery !== undefined ? ' [gc-pressure]' : ''
    console.log(`\n${c.name}${tag}:`)
    console.log(`  napi:  ${opsLine(napiOps)}   last/first=${nRatio.toFixed(3)}x`)
    console.log(
      `  ffi:   ${opsLine(ffiOps)}   last/first=${fRatio.toFixed(3)}x   ffi/napi=${(fFirst / nFirst).toFixed(2)}x`,
    )
  }
}

const loadWindows = Number(process.env.CASTRUM_FFI_LOAD_WINDOWS ?? 4)
const loadMs = Number(process.env.CASTRUM_FFI_LOAD_MS ?? 400)

runLoadStability(
  [
    { name: 'crc32 (small)', napi: () => addon.crc32(SMALL), ffi: () => rust.crc32(SMALL) },
    { name: 'hexEncode (64 KiB)', napi: () => addon.hexEncode(LARGE), ffi: () => rust.hexEncode(LARGE) },
    {
      name: 'hexEncode (64 KiB)',
      napi: () => addon.hexEncode(LARGE),
      ffi: () => rust.hexEncode(LARGE),
      gcEvery: 2048,
    },
    { name: 'jsonValid (200 rows)', napi: () => addon.jsonValid(jsonArr), ffi: () => rust.jsonValid(jsonArr) },
    { name: 'jsonSumIds (200 rows)', napi: () => addon.jsonSumIds(jsonArr), ffi: () => rust.jsonSumIds(jsonArr) },
    {
      name: 'ingress.handleRequestPacked',
      napi: () => handler.handleRequestPacked(ingressInput, ingressBody, ingressOut),
      ffi: () => ffi.ingressHandlePacked(ingressPtr, ingressInput, ingressBody, ingressOut),
    },
    {
      name: 'ingress.handleRequestPacked',
      napi: () => handler.handleRequestPacked(ingressInput, ingressBody, ingressOut),
      ffi: () => ffi.ingressHandlePacked(ingressPtr, ingressInput, ingressBody, ingressOut),
      gcEvery: 2048,
    },
  ],
  'Sustained high-throughput load (does FFI slow down?)',
  loadWindows,
  loadMs,
)

// ── Summary ──────────────────────────────────────────────────────
console.log('\n════════════════════ SUMMARY ════════════════════')
const fast = results.filter((r) => r.speedup >= 1.05)
const slow = results.filter((r) => r.speedup <= 0.95)
console.log(`functions measured: ${results.length}`)
console.log(`ffi faster (≥1.05x): ${fast.length}`)
console.log(`ffi slower (≤0.95x): ${slow.length}`)
if (slow.length > 0) {
  console.log('\nffi slower than napi:')
  for (const r of slow) console.log(`  ${r.name}: ${r.speedup.toFixed(2)}x`)
}
console.log('\nbiggest wins:')
const sorted = [...results].sort((a, b) => b.speedup - a.speedup).slice(0, 12)
for (const r of sorted) {
  console.log(`  ${r.name.padEnd(44)} ${r.speedup.toFixed(2).padStart(8)}x  (${r.napi.toFixed(3)} → ${r.ffi.toFixed(3)} µs)`)
}
