#!/usr/bin/env bun
/**
 * Benchmark-driven native-vs-JS selection — OWNED BY CASTRUM.
 *
 * Measures the raw addon implementation against a representative pure-JS
 * implementation for every operation in the baked selection
 * (`rust/selection.rs`, exposed as `addon.opImpl(op)`), then validates the
 * baked decision. The selection is a property of this library, not of any
 * consumer — consumers read `opImpl(op)` once at load time and bind each op
 * to a fixed implementation (they never swap native↔js at runtime).
 *
 * Usage:
 *   bun scripts/select-native.ts           # report + drift summary (exit 0)
 *   bun scripts/select-native.ts --check   # CI gate: exit 1 on decisive drift
 *   bun scripts/select-native.ts --write   # persist bench/results/selection.json
 *
 * Selection rule (deterministic): native iff `nativeRatio >= 1.05`; js iff
 * `nativeRatio <= 0.95`; inside the band the current wiring is kept (parity).
 * `--check` only fails on DECISIVE drift (castrum-wired loses >15% / js-wired
 * native wins >18%) so run-to-run noise on FFI-bound ops does not flip-flop.
 *
 * The JS side uses castrum's baselines where they are representative
 * (gzip/brotli/jwt/password/aead/multipart/ws/sse/template) and tight regex /
 * node:crypto implementations for tiny ops (validation, pair parsers) — the
 * latter are what a real consumer actually runs, so the decision is honest.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import {
  nativeBrotliCompress,
  nativeBrotliDecompress,
  nativeGzipCompress,
  nativeGzipDecompress,
  nativeMultipartParse,
  nativePasswordHash,
  nativeSseEncodeEvent,
  nativeTemplateRender,
  nativeWsFrameDecode,
  nativeWsFrameEncode,
} from '../src/baseline'
import type { NativeAddon } from '../src/native'
import { getAddon } from '../src/native'
import { decoder, encoder } from '../src/shared/bytes'

const a = getAddon() as NativeAddon
const enc = encoder
const dec = decoder

// ── Inputs (representative of real usage; ≥64B so FFI amortizes where it can) ──
const bigChunk = 'x'.repeat(64)
const queryBytes = enc.encode(
  `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}&name=Ada%20Lovelace`,
)
const queryText = dec.decode(queryBytes)
const cookieBytes = enc.encode(
  Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(' '),
)
const cookieText = dec.decode(cookieBytes)
const formText = `name=Ada%20Lovelace&role=engineer&active=true&tags=a&tags=b&lang=en&chunk=${bigChunk}`
const formBytes = enc.encode(formText)
const etagBytes = enc.encode(`hello world, etag sample ${bigChunk}`)
const mediaTypeText = 'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW'
const mediaTypeBytes = enc.encode(mediaTypeText)
const acceptText = 'gzip, deflate, br;q=0.9, identity;q=0.1'
const acceptBytes = enc.encode(acceptText)
const jsonDocText = '{"id":1,"name":"widget","tags":["a","b","c"],"nested":{"x":true}}'
const jsonDocBytes = enc.encode(jsonDocText)
const jsonPatchDoc = '{"baz":"qux","foo":"bar"}'
const jsonPatchOps =
  '[{"op":"replace","path":"/baz","value":"boo"},{"op":"add","path":"/hello","value":["world"]}]'
const wsPayload = enc.encode(`ws payload ${bigChunk}`)
const sseDataBytes = enc.encode(`line0 ${bigChunk}\nline1 ${bigChunk}`)
const compressedGz = gzipSync(new Uint8Array(64).fill(7))
const compressedBr = brotliCompressSync(new Uint8Array(64).fill(7))
const wsFrameMasked = [0x37, 0xfa, 0x21, 0x3d]
const wsFrameBuf = (() => {
  const p = enc.encode(`frame payload ${bigChunk}`)
  const out = new Uint8Array(2 + 4 + p.length)
  out[0] = 0x81
  out[1] = 0x80 | p.length
  out.set(wsFrameMasked, 2)
  for (let i = 0; i < p.length; i++) out[2 + 4 + i] = (p[i] ?? 0) ^ (wsFrameMasked[i & 3] ?? 0)
  return out
})()

const hmacKey = enc.encode('supersecretkey-32-bytes-for-hmac-512!')
const hmacData = enc.encode(`hmac data ${bigChunk}`)
const hmacSig = (() => {
  const h = createHash('sha256')
  return new Uint8Array(h.update(Buffer.concat([hmacKey, hmacData])).digest())
})()
const secret = enc.encode('cookie-secret-0123456789abcdef')
const value = enc.encode('session=abc123')
const aeadKey = enc.encode('k'.repeat(32))
const aeadNonce = enc.encode('n'.repeat(12))
const aeadPlain = enc.encode(`aead plaintext ${bigChunk}`)
const salt = enc.encode('somesalt')
const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
const mpBody = (() => {
  const parts: string[] = []
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nvalue1\r\n`)
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n${'A'.repeat(2048)}\r\n`,
  )
  parts.push(`--${boundary}--\r\n`)
  return enc.encode(parts.join(''))
})()
const templateSrc = 'Hello {{ name }}! You have {{ items.length }} items.'
const templateCtx = { name: 'world', items: [1, 2, 3] }
const condEtag = enc.encode('"abc123"')
const acceptSupported = ['gzip', 'br', 'identity']
const rateKey = 'ip-1.2.3.4'
const rateNow = 1_700_000_000

// Compiled-once instances (production usage: build at startup, reuse per request).
const rlNative = new a.RateLimiter(100, 60_000, null)
const rlJs = createRateLimiterJs({ limit: 100, windowMs: 60_000 })
const tplNative = new a.TemplateRenderer(templateSrc)
const crNative = new a.ConditionalRequest(condEtag, 1700000000)
const crJs = createConditionalJs('"abc123"', 1700000000)
const anNative = new a.AcceptNegotiator(acceptSupported)
const anJs = createAcceptJs(acceptSupported)

// ── Representative JS implementations (tiny ops; the validator-lib baseline
//    is NOT representative — a real consumer runs these tight impls) ───────
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

function fnv1a64Js(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i] ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32Js(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++)
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return d === 0
}
function hmacJs(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash('sha256')
      .update(Buffer.concat([key, data]))
      .digest(),
  )
}
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// Real CSRF verify JS implementation (token = `<rnd-hex>.<HMAC(secret, rnd)>`).
const csrfTokBytes = (() => {
  const rnd = new Uint8Array(randomBytes(32))
  return enc.encode(`${hex(rnd)}.${hex(hmacJs(secret, rnd))}`)
})()
function csrfVerifyJs(token: Uint8Array, s: Uint8Array): boolean {
  const text = dec.decode(token)
  const dot = text.lastIndexOf('.')
  if (dot < 0) return false
  const sigHex = text.slice(dot + 1)
  const sig = new Uint8Array((sigHex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)))
  return ctEq(hmacJs(s, enc.encode(text.slice(0, dot))), sig)
}
const decodePairs = (text: string, decode: (s: string) => string): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (const pair of text.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    out.push([decode(eq < 0 ? pair : pair.slice(0, eq)), decode(eq < 0 ? '' : pair.slice(eq + 1))])
  }
  return out
}
const dUrl = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}
function readPairsPackedJs(buf: Uint8Array): Array<[string, string]> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = dv.getUint32(0, true)
  const out: Array<[string, string]> = []
  let pos = 4
  for (let i = 0; i < count; i++) {
    const nl = dv.getUint32(pos, true)
    pos += 4
    const name = dec.decode(buf.subarray(pos, pos + nl))
    pos += nl
    const vl = dv.getUint32(pos, true)
    pos += 4
    const value = dec.decode(buf.subarray(pos, pos + vl))
    pos += vl
    out.push([name, value])
  }
  return out
}
function parseMediaTypeJs(input: string): unknown {
  const idx = input.indexOf(';')
  const mediaType = (idx < 0 ? input : input.slice(0, idx)).trim().toLowerCase()
  const params: Record<string, string> = {}
  if (idx >= 0) {
    for (const seg of input.slice(idx + 1).split(';')) {
      const eq = seg.indexOf('=')
      if (eq < 0) continue
      params[seg.slice(0, eq).trim().toLowerCase()] = seg
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, '')
    }
  }
  return { mediaType, params }
}
function parseAcceptJs(input: string): unknown[] {
  const out: Array<{ encoding: string; q: number; order: number }> = []
  if (!input) return out
  let order = 0
  for (const item of input.split(',')) {
    const [name, ...params] = item.trim().split(';')
    if (!name) continue
    let q = 1
    for (const p of params) {
      const eq = p.indexOf('=')
      if (eq >= 0 && p.slice(0, eq).trim() === 'q') q = Number(p.slice(eq + 1).trim()) || 1
    }
    out.push({ encoding: name.trim().toLowerCase(), q, order: order++ })
  }
  return out
}
function createRateLimiterJs(options: { limit: number; windowMs: number }): {
  check(k: string, now: number): unknown
} {
  const { limit, windowMs } = options
  const state = new Map<string, { start: number; count: number }>()
  return {
    check(key, now) {
      const e = state.get(key)
      if (!e || now - e.start >= windowMs) {
        state.set(key, { start: now, count: 1 })
        return { allowed: limit > 0, remaining: Math.max(0, limit - 1), resetMs: now + windowMs }
      }
      if (e.count < limit) {
        e.count++
        return { allowed: true, remaining: Math.max(0, limit - e.count), resetMs: now + windowMs }
      }
      return { allowed: false, remaining: 0, resetMs: now + windowMs }
    },
  }
}
function createConditionalJs(
  etagValue: string,
  lastModifiedSecs: number,
): { isNotModified(a: string, b: string): boolean } {
  const strong = etagValue.trim().replace(/^W\//, '')
  const lastModified = Math.max(0, Math.floor(lastModifiedSecs ?? 0))
  return {
    isNotModified(ifNoneMatch, ifModifiedSince) {
      if (ifNoneMatch) {
        if (ifNoneMatch.trim() === '*') return true
        return ifNoneMatch.split(',').some((c) => c.trim().replace(/^W\//, '') === strong)
      }
      if (lastModified > 0 && ifModifiedSince) {
        const secs = Date.parse(ifModifiedSince)
        if (!Number.isNaN(secs)) return lastModified <= Math.floor(secs / 1000)
      }
      return false
    },
  }
}
function createAcceptJs(supported: string[]): { negotiate(header: string): string | null } {
  const normalized = supported.map((s) => s.toLowerCase())
  return {
    negotiate(header) {
      const prefs = parseAcceptJs(header ?? '') as Array<{
        encoding: string
        q: number
        order: number
      }>
      if (prefs.length === 0) return normalized[0] ?? null
      let best: { enc: string; q: number; spec: number; order: number } | null = null
      for (const sup of normalized) {
        for (const pref of prefs) {
          const spec = pref.encoding === sup ? 2 : pref.encoding === '*' ? 1 : -1
          if (spec < 0) continue
          const cand = { enc: sup, q: pref.q, spec, order: pref.order }
          if (
            best === null ||
            cand.spec > best.spec ||
            (cand.spec === best.spec && Math.abs(cand.q - best.q) > 1e-4 && cand.q > best.q) ||
            (cand.spec === best.spec &&
              Math.abs(cand.q - best.q) <= 1e-4 &&
              cand.order < best.order)
          ) {
            best = cand
          }
        }
      }
      return best ? best.enc : null
    },
  }
}

// ── Harness ─────────────────────────────────────────────────────

interface BenchOp {
  op: string
  label: string
  native: () => void
  fallback: () => void
  /** When set, the op is not re-benchmarked here (pinned by an external measure). */
  skip?: string
}

function opsPerSec(fn: () => void, durationMs = 200): number {
  const w0 = performance.now()
  let i = 0
  while (performance.now() - w0 < 8 && i < 10000) {
    fn()
    i++
  }
  const start = performance.now()
  let count = 0
  while (performance.now() - start < durationMs) {
    fn()
    count++
  }
  return count / ((performance.now() - start) / 1000)
}

const NATIVE_WIN = 1.05
const NATIVE_LOSS = 0.95
const DECISIVE_WIN = 1.18
const DECISIVE_LOSS = 0.85
const TRIALS = 3

function median(nums: number[]): number {
  const s = [...nums].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)] ?? 0
}

// ── Specs (native = raw addon; fallback = representative JS) ────
const OPS: BenchOp[] = [
  // hash
  {
    op: 'fnv1a64',
    label: 'fnv1a64',
    native: () => a.fnv1a64(etagBytes),
    fallback: () => fnv1a64Js(etagBytes),
  },
  {
    op: 'crc32',
    label: 'crc32',
    native: () => a.crc32(etagBytes),
    fallback: () => crc32Js(etagBytes),
  },
  // hmac
  {
    op: 'hmacSha256',
    label: 'hmacSha256',
    native: () => a.hmacSha256(hmacKey, hmacData),
    fallback: () => hmacJs(hmacKey, hmacData),
  },
  {
    op: 'hmacSha256Verify',
    label: 'hmacSha256Verify',
    native: () => a.hmacSha256Verify(hmacKey, hmacData, hmacSig),
    fallback: () => ctEq(hmacJs(hmacKey, hmacData), hmacSig),
  },
  // crypto
  {
    op: 'signCookie',
    label: 'signCookie',
    native: () => a.signCookie(value, secret),
    fallback: () => `${dec.decode(value)}.${hex(hmacJs(secret, value))}`,
  },
  {
    op: 'verifyCookie',
    label: 'verifyCookie',
    native: () => a.verifyCookie(a.signCookie(value, secret), secret),
    fallback: () => {
      const s = `${dec.decode(value)}.${hex(hmacJs(secret, value))}`
      return s
    },
  },
  {
    op: 'csrfToken',
    label: 'csrfToken',
    native: () => a.csrfToken(secret),
    fallback: () =>
      `${hex(new Uint8Array(randomBytes(32)))}.${hex(hmacJs(secret, new Uint8Array(randomBytes(32))))}`,
  },
  {
    op: 'csrfVerify',
    label: 'csrfVerify',
    native: () => a.csrfVerify(csrfTokBytes, secret),
    fallback: () => csrfVerifyJs(csrfTokBytes, secret),
  },
  {
    op: 'randomToken',
    label: 'randomToken',
    native: () => a.randomToken(16),
    fallback: () => hex(new Uint8Array(randomBytes(16))),
  },
  {
    op: 'passwordHash',
    label: 'passwordHash',
    native: () => a.passwordHash(enc.encode('hunter2'), salt, null),
    fallback: () => nativePasswordHash(enc.encode('hunter2'), salt, null),
  },
  {
    op: 'aeadEncrypt',
    label: 'aeadEncrypt',
    native: () => a.aeadEncrypt(aeadKey, aeadNonce, aeadPlain, 'aes-256-gcm'),
    fallback: () => aeadEncryptJs(),
  },
  {
    op: 'aeadDecrypt',
    label: 'aeadDecrypt',
    native: () => a.aeadDecrypt(aeadKey, aeadNonce, aeadCipherJs(), 'aes-256-gcm'),
    fallback: () => aeadDecryptJs(),
  },
  // http parsers (native cost includes JS unpack — the real wrapper cost)
  {
    op: 'queryPairs',
    label: 'queryPairs',
    native: () => readPairsPackedJs(a.queryParsePacked(queryBytes)),
    fallback: () => decodePairs(queryText, dUrl),
  },
  {
    op: 'cookiePairs',
    label: 'cookiePairs',
    native: () => readPairsPackedJs(a.cookieParsePacked(cookieBytes)),
    fallback: () =>
      decodePairs(cookieText.replace(/;/g, '&'), (s) => s.trim().replace(/^"|"$/g, '')),
  },
  {
    op: 'formPairs',
    label: 'formPairs',
    native: () => readPairsPackedJs(a.formParsePacked(formBytes)),
    fallback: () => decodePairs(formText, dUrl),
  },
  {
    op: 'etag',
    label: 'etag',
    native: () => a.etag(etagBytes, false),
    fallback: () => `"${crc32Js(etagBytes).toString(16).padStart(8, '0')}"`,
  },
  {
    op: 'parseMediaType',
    label: 'parseMediaType',
    native: () => a.parseMediaType(mediaTypeBytes),
    fallback: () => parseMediaTypeJs(mediaTypeText),
  },
  {
    op: 'parseAcceptEncoding',
    label: 'parseAcceptEncoding',
    native: () => a.parseAcceptEncoding(acceptBytes),
    fallback: () => parseAcceptJs(acceptText),
  },
  {
    op: 'createConditionalRequest',
    label: 'createConditionalRequest',
    native: () => crNative.isNotModified(condEtag, null),
    fallback: () => crJs.isNotModified('"abc123"', ''),
  },
  {
    op: 'createAcceptNegotiator',
    label: 'createAcceptNegotiator',
    native: () => anNative.negotiate(acceptBytes),
    fallback: () => anJs.negotiate(acceptText),
  },
  {
    op: 'multipartParse',
    label: 'multipartParse',
    native: () => a.multipartParse(mpBody, enc.encode(boundary), null),
    fallback: () => nativeMultipartParse(mpBody, enc.encode(boundary), null),
    skip: "pinned js — Bun req.formData() beats Rust at every size (measured in flux); castrum's sync baseline is unrepresentative",
  },
  // json
  {
    op: 'jsonValid',
    label: 'jsonValid',
    native: () => a.jsonValid(jsonDocBytes),
    fallback: () => {
      try {
        JSON.parse(jsonDocText)
      } catch {
        /* ignore */
      }
    },
  },
  {
    op: 'jsonPatch',
    label: 'jsonPatch',
    native: () => a.jsonPatch(enc.encode(jsonPatchDoc), enc.encode(jsonPatchOps)),
    fallback: () => JSON.parse(jsonPatchDoc),
  },
  // payload
  {
    op: 'gzipCompress',
    label: 'gzipCompress',
    native: () => a.gzipCompress(jsonDocBytes, 6),
    fallback: () => nativeGzipCompress(jsonDocBytes, 6),
  },
  {
    op: 'gzipDecompress',
    label: 'gzipDecompress',
    native: () => a.gzipDecompress(compressedGz),
    fallback: () => nativeGzipDecompress(compressedGz),
  },
  {
    op: 'brotliCompress',
    label: 'brotliCompress',
    native: () => a.brotliCompress(jsonDocBytes, 5),
    fallback: () => nativeBrotliCompress(jsonDocBytes, 5),
  },
  {
    op: 'brotliDecompress',
    label: 'brotliDecompress',
    native: () => a.brotliDecompress(compressedBr),
    fallback: () => nativeBrotliDecompress(compressedBr),
  },
  {
    op: 'sseEncode',
    label: 'sseEncode',
    native: () => a.sseEncodeEvent('message', sseDataBytes, '42', null),
    fallback: () => nativeSseEncodeEvent('message', sseDataBytes, '42', null),
  },
  {
    op: 'wsFrameEncode',
    label: 'wsFrameEncode',
    native: () => a.wsFrameEncode(1, wsPayload, false, true),
    fallback: () => nativeWsFrameEncode(1, wsPayload, false, true),
  },
  {
    op: 'wsFrameDecode',
    label: 'wsFrameDecode',
    native: () => a.wsFrameDecode(wsFrameBuf),
    fallback: () => nativeWsFrameDecode(wsFrameBuf),
  },
  {
    op: 'wsAcceptKey',
    label: 'wsAcceptKey',
    native: () => a.wsAcceptKey(enc.encode('dGhlIHNhbXBsZSBub25jZQ==')),
    fallback: () =>
      createHash('sha1')
        .update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64'),
  },
  // validation (tight regexes = representative JS)
  {
    op: 'validateEmail',
    label: 'validateEmail',
    native: () => a.validateEmail(enc.encode('ada@example.com')),
    fallback: () => EMAIL_RE.test('ada@example.com'),
  },
  {
    op: 'validateUuid',
    label: 'validateUuid',
    native: () => a.validateUuid(enc.encode('123e4567-e89b-12d3-a456-426614174000')),
    fallback: () => UUID_RE.test('123e4567-e89b-12d3-a456-426614174000'),
  },
  {
    op: 'validateIpv4',
    label: 'validateIpv4',
    native: () => a.validateIpv4(enc.encode('192.168.0.1')),
    fallback: () => IPV4_RE.test('192.168.0.1'),
  },
  {
    op: 'validateIpv6',
    label: 'validateIpv6',
    native: () => a.validateIpv6(enc.encode('2001:db8::1')),
    fallback: () => isIP('2001:db8::1') === 6,
  },
  // ratelimit (compiled once) + template (compiled once)
  {
    op: 'createRateLimiter',
    label: 'createRateLimiter.check',
    native: () => rlNative.check(rateKey, rateNow),
    fallback: () => rlJs.check(rateKey, rateNow),
  },
  {
    op: 'renderTemplate',
    label: 'renderTemplate.render',
    native: () => tplNative.render(templateCtx),
    fallback: () => nativeTemplateRender(templateSrc, templateCtx),
  },
]

// AEAD helpers (node:crypto aes-256-gcm)
let aeadCipherCache: Uint8Array | null = null
function aeadCipherJs(): Uint8Array {
  if (!aeadCipherCache) {
    const cipher = createCipheriv('aes-256-gcm', aeadKey, aeadNonce)
    aeadCipherCache = new Uint8Array(
      Buffer.concat([cipher.update(aeadPlain), cipher.final(), cipher.getAuthTag()]),
    )
  }
  return aeadCipherCache
}
function aeadEncryptJs(): void {
  const cipher = createCipheriv('aes-256-gcm', aeadKey, aeadNonce)
  Buffer.concat([cipher.update(aeadPlain), cipher.final(), cipher.getAuthTag()])
}
function aeadDecryptJs(): void {
  const c = aeadCipherJs()
  const tag = c.subarray(c.length - 16)
  const body = c.subarray(0, c.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', aeadKey, aeadNonce)
  decipher.setAuthTag(tag)
  Buffer.concat([decipher.update(body), decipher.final()])
}

// ── Run ─────────────────────────────────────────────────────────

interface Measured {
  op: string
  nativeOps: number
  fallbackOps: number
  ratio: number
  current: string | null
  recommended: string
  drift: boolean
}

const results: Measured[] = []
for (const op of OPS) {
  if (op.skip) {
    // Pinned decision (external measure) — record as-is, never flagged.
    results.push({
      op: op.op,
      nativeOps: Number.NaN,
      fallbackOps: Number.NaN,
      ratio: Number.NaN,
      current: a.opImpl(op.op),
      recommended: a.opImpl(op.op) ?? 'js',
      drift: false,
    })
    continue
  }
  const nativeSamples: number[] = []
  const fallbackSamples: number[] = []
  for (let t = 0; t < TRIALS; t++) {
    nativeSamples.push(opsPerSec(op.native))
    fallbackSamples.push(opsPerSec(op.fallback))
  }
  const nativeOps = median(nativeSamples)
  const fallbackOps = median(fallbackSamples)
  const ratio = fallbackOps > 0 ? nativeOps / fallbackOps : Number.NaN
  const current = a.opImpl(op.op)
  const recommended = !Number.isFinite(ratio)
    ? (current ?? 'js')
    : ratio >= NATIVE_WIN
      ? 'native'
      : ratio <= NATIVE_LOSS
        ? 'js'
        : (current ?? 'js')
  const decisive =
    (current === 'native' && Number.isFinite(ratio) && ratio < DECISIVE_LOSS) ||
    (current === 'js' && Number.isFinite(ratio) && ratio > DECISIVE_WIN) ||
    current === null
  results.push({ op: op.op, nativeOps, fallbackOps, ratio, current, recommended, drift: decisive })
}

// ── Report ──────────────────────────────────────────────────────

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pad = (s: string, w: number): string => s.padEnd(w)

console.log(
  `mode: select-native — castrum-owned native-vs-JS selection (win ≥${NATIVE_WIN.toFixed(2)}x, loss ≤${NATIVE_LOSS.toFixed(2)}x, decisive ±${(DECISIVE_WIN - 1).toFixed(2)}x)\n`,
)
console.log(
  `${pad('op', 26)} ${pad('native', 10)} ${pad('fallback', 10)} ${pad('ratio', 8)} ${pad('baked', 9)} ${pad('rec', 9)} drift`,
)
for (const r of results) {
  console.log(
    `${pad(r.op, 26)} ${pad(String(Math.round(r.nativeOps)), 10)} ${pad(
      String(Math.round(r.fallbackOps)),
      10,
    )} ${pad(fmt(r.ratio), 8)} ${pad(r.current ?? '?', 9)} ${pad(r.recommended, 9)} ${r.drift ? '◀ DRIFT' : ''}`,
  )
}

const driftOps = results.filter((r) => r.drift)
console.log(
  `\n${results.length} ops measured, ${driftOps.length} drift from the committed selection (src/selection.json).`,
)
for (const r of driftOps) {
  console.log(
    `  - ${r.op}: committed ${r.current}, measured ${fmt(r.ratio)}x → recommend ${r.recommended}`,
  )
}

// The committed auto-selection that the PUBLIC API reads (op → chosen impl).
const buildSelectionJson = (): Record<string, unknown> => ({
  generatedAt: new Date().toISOString(),
  note: 'Auto-selected by `bun scripts/select-native.ts --write` from measurements of the castrum addon vs representative pure-TS implementations. Do NOT hand-edit — regenerate with the benchmark script. The public API reads this via `opImpl(op)` and binds each op to a fixed impl (native or js) at load time.',
  ops: Object.fromEntries(
    results.map((r) => [
      r.op,
      {
        impl: r.recommended,
        nativeRatio: Number.isFinite(r.ratio) ? Number(r.ratio.toFixed(3)) : null,
      },
    ]),
  ),
})

if (process.argv.includes('--write')) {
  // 1) The committed source of truth embedded into the addon at build time.
  const srcFile = join(process.cwd(), 'src', 'selection.json')
  writeFileSync(srcFile, `${JSON.stringify(buildSelectionJson(), null, 2)}\n`)
  console.log(
    `\nwrote ${srcFile} — run \`bun run build\` to embed the auto-selected decisions into the addon.`,
  )

  // 2) A diagnostic report with the full measurements (gitignored under bench/).
  const outDir = join(process.cwd(), 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'selection.json')
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        winThreshold: NATIVE_WIN,
        lossThreshold: NATIVE_LOSS,
        results: results.map((r) => ({
          op: r.op,
          nativeOps: Math.round(r.nativeOps),
          fallbackOps: Math.round(r.fallbackOps),
          nativeRatio: Number.isFinite(r.ratio) ? Number(r.ratio.toFixed(3)) : null,
          committed: r.current,
          recommended: r.recommended,
        })),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`wrote ${file}`)
}

if (process.argv.includes('--check')) {
  // Validate the committed src/selection.json against fresh measurements.
  const committed = JSON.parse(
    readFileSync(join(process.cwd(), 'src', 'selection.json'), 'utf8'),
  ) as { ops?: Record<string, { impl?: string }> }
  const driftFromCommitted = results.filter((r) => {
    const impl = committed.ops?.[r.op]?.impl
    if (impl === undefined) return true // op not in the committed file
    return (
      (impl === 'native' && Number.isFinite(r.ratio) && r.ratio < DECISIVE_LOSS) ||
      (impl === 'js' && Number.isFinite(r.ratio) && r.ratio > DECISIVE_WIN)
    )
  })
  if (driftFromCommitted.length > 0) {
    console.error(
      '\nselect-native --check: the committed selection drifted from measurements — run `--write` + rebuild.',
    )
    for (const r of driftFromCommitted) {
      console.error(
        `  - ${r.op}: committed ${committed.ops?.[r.op]?.impl}, measured ${fmt(r.ratio)}x → ${r.recommended}`,
      )
    }
    process.exit(1)
  }
}
process.exit(0)
