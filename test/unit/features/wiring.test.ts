/**
 * Transport / selection wiring guard tests.
 *
 * Guards the integrity of the native-vs-JS / ffi-vs-napi wiring so the class
 * of regression where "a faster addon/FFI call is silently replaced by a JS
 * call" cannot slip through:
 *
 *   1. `selection.json` completeness — every op in the baked selection (and
 *      every BUN_WINS op) must resolve to a NON-NULL `opImpl` from the addon
 *      (the Node-side decision). A `--write` that drops an op (e.g.
 *      `createSchemaValidator`) makes consumers bind "js" and regresses.
 *   2. BUN_WINS correctness — all 9 delegated ops resolve to "js" under Bun.
 *   3. Critical ops stay native-bound — schema validation and the
 *      constant-time crypto ops must never flip to "js".
 *   4. Raw-accessor contract — `src/bench/raw-native.ts` must export a `raw*`
 *      accessor for every BUN_WINS op, and each must return the ADDON's output
 *      (not the delegated Bun built-in), so the CPU bench's `rust:` columns
 *      measure the addon.
 *   5. Bench-task source contract — the CPU bench `rust:` columns for BUN_WINS
 *      ops must reference the `raw-*` accessors (not the delegated public
 *      `rust.*` wrapper), so the report never silently starts reflecting Bun
 *      built-ins.
 *
 * Runs under `bun test` (Bun), like the rest of the suite.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  rawBase64Encode,
  rawCrc32,
  rawGzipCompress,
  rawHmacSha256,
  rawHttpDate,
  rawRandomToken,
  rawUrlDecode,
  rawUrlEncode,
  rawXxh3,
} from '../../../src/bench/raw-native'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { isBun } from '../../../src/shared/runtime'
import { opImpl } from '../../../src/selection'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The 9 BUN_WINS ops (mirrors src/selection.ts) — delegated to Bun built-ins under Bun. */
const BUN_WINS = [
  'gzipCompress',
  'crc32',
  'randomToken',
  'hmacSha256',
  'xxh3',
  'urlEncode',
  'urlDecode',
  'base64Encode',
  'httpDate',
] as const

/** Ops whose decision is security/semantics-driven and must stay native. */
const MUST_STAY_NATIVE = [
  'createSchemaValidator', // the ignus schema-validate regression
  'createTemplate',
  'passwordVerify',
  'jwtSign', // constant-time canonical
  'jwtVerify', // constant-time canonical
  'gzipDecompress', // 64 MiB decompression-bomb cap — never delegated
] as const

/** src/selection.json as embedded in the addon — read for cross-checking. */
function readSelectionJson(): { ops?: Record<string, { impl?: 'native' | 'js' }> } {
  return JSON.parse(readFileSync(join(import.meta.dir, '../../../src/selection.json'), 'utf8')) as {
    ops?: Record<string, { impl?: 'native' | 'js' }>
  }
}

describe('selection completeness (opImpl must be non-null for every public op)', () => {
  const addon = getAddon()
  const selection = readSelectionJson()

  test('every selection.json op has a baked (Node) decision from the addon', () => {
    const ops = selection.ops ?? {}
    const keys = Object.keys(ops)
    expect(keys.length).toBeGreaterThan(40) // sanity: the table is populated
    for (const op of keys) {
      const baked = addon.opImpl(op)
      expect(baked, `${op} missing from addon opImpl (Node decision is null)`).not.toBeNull()
      expect(baked).toBe(ops[op]?.impl ?? null)
    }
  })

  test('every BUN_WINS op is present in selection.json (a --write must never drop them)', () => {
    const ops = selection.ops ?? {}
    for (const op of BUN_WINS) {
      expect(ops[op], `${op} must stay in selection.json`).toBeDefined()
    }
  })

  test('critical ops are baked native under Node', () => {
    for (const op of MUST_STAY_NATIVE) {
      expect(addon.opImpl(op), `${op} must be native-bound`).toBe('native')
    }
  })
})

describe('BUN_WINS runtime resolution', () => {
  test('all 9 BUN_WINS ops resolve to "js" under Bun (delegate to the faster built-in)', () => {
    if (!isBun()) return
    for (const op of BUN_WINS) {
      expect(opImpl(op), `${op} must be js under Bun`).toBe('js')
    }
  })

  test('non-BUN_WINS native ops are NOT masked to js under Bun', () => {
    if (!isBun()) return
    for (const op of ['fnv1a64', 'createSchemaValidator', 'gzipDecompress', 'jsonValid']) {
      expect(opImpl(op)).not.toBeNull()
    }
  })
})

describe('raw-accessor contract (CPU bench measures the ADDON, not the delegated built-in)', () => {
  const addon = getAddon()
  const input = encoder.encode('hello world & foo=bar?x=1')
  const key = encoder.encode('secret-key-0123456789abcdef')

  test('a raw-* accessor exists and matches the addon for every BUN_WINS op', () => {
    // crc32 (unsigned-32 contract)
    expect(rawCrc32(input)).toBe(addon.crc32(input) >>> 0)
    // xxh3
    expect(rawXxh3(input)).toBe(addon.xxh3(input))
    // url encode/decode
    expect(Array.from(rawUrlEncode(input))).toEqual(Array.from(addon.urlEncode(input)))
    const encoded = encoder.encode('hello%20world%20%26%20foo%3Dbar')
    expect(Array.from(rawUrlDecode(encoded))).toEqual(Array.from(addon.urlDecode(encoded)))
    // base64 (standard padded case)
    expect(Array.from(rawBase64Encode(input))).toEqual(Array.from(addon.base64Encode(input)))
    // http date
    expect(Array.from(rawHttpDate(1_700_000_000))).toEqual(
      Array.from(addon.httpDate(1_700_000_000)),
    )
    // hmac (hex output contract)
    const sig = rawHmacSha256(key, input)
    const sigAddon = new addon.HmacSigner(key).sign(input)
    expect(Array.from(sig)).toEqual(Array.from(sigAddon))
    expect(sig.byteLength).toBe(64)
    // gzip (decompression-parity with the addon)
    const gz = rawGzipCompress(input)
    expect(decoder.decode(addon.gzipDecompress(gz))).toBe(decoder.decode(input))
    // random token (shape: 2n lowercase-hex bytes)
    const tok = rawRandomToken(16)
    expect(tok.byteLength).toBe(32)
    for (const b of tok) {
      expect((b >= 48 && b <= 57) || (b >= 97 && b <= 102)).toBe(true)
    }
  })

  test('the public delegated path and the raw path are distinct channels (measurement honesty)', () => {
    if (!isBun()) return
    // Under Bun the PUBLIC `rust.gzipCompress` delegates to `Bun.gzipSync`
    // (BUN_WINS) — its output is Bun's, NOT the addon's. The `raw*` accessor
    // is the ADDON's output. The two relationships below are what keep the CPU
    // bench honest: a task wired to `rust.gzipCompress` would measure the
    // built-in; a task wired to `rawGzipCompress` measures the addon.
    const delegated = rust.gzipCompress(input) // Bun.gzipSync
    const raw = rawGzipCompress(input) // addon
    expect(Array.from(delegated)).toEqual(Array.from(Bun.gzipSync(input)))
    expect(Array.from(raw)).toEqual(Array.from(addon.gzipCompress(input)))
    // Both transports decompress back to the original (only the header OS byte
    // may differ), so the delegated path is byte-compatible with the addon.
    expect(decoder.decode(addon.gzipDecompress(delegated))).toBe(decoder.decode(input))
    expect(decoder.decode(addon.gzipDecompress(raw))).toBe(decoder.decode(input))
  })
})

describe('CPU bench task source contract (rust: columns use raw-* for BUN_WINS ops)', () => {
  const tasksDir = join(import.meta.dir, '../../../src/bench/tasks')

  test('task files reference the raw accessors for their BUN_WINS rust: columns', () => {
    const expectations: Record<string, string[]> = {
      'url.ts': ['rawUrlEncode', 'rawUrlDecode'],
      'etag.ts': ['rawHttpDate'],
      'complex.ts': ['rawUrlEncode', 'rawUrlDecode'],
      'bun-builtins.ts': [
        'rawCrc32',
        'rawXxh3',
        'rawHmacSha256',
        'rawGzipCompress',
        'rawRandomToken',
      ],
    }
    for (const [file, symbols] of Object.entries(expectations)) {
      const src = readFileSync(join(tasksDir, file), 'utf8')
      for (const sym of symbols) {
        expect(src.includes(sym), `${file} must use ${sym}`).toBe(true)
      }
    }
  })

  test('the delegated public wrappers are NOT called in those BUN_WINS rust: columns', () => {
    const src = ['url.ts', 'etag.ts', 'complex.ts', 'bun-builtins.ts']
      .map((f) => readFileSync(join(tasksDir, f), 'utf8'))
      .join('\n')
      // Strip comment lines (a comment mentioning `rust.randomToken(16)` etc.
      // is documentation, not a call).
      .replace(/^\s*\/\/.*$/gm, '')
    // urlEncodeInto / urlDecodeInto / httpDateInto are legitimately used (they
    // are NOT delegated), so match the bare call form (no trailing `Into`).
    expect(src.match(/rust\.urlEncode\(/g)).toBeNull()
    expect(src.match(/rust\.urlDecode\(/g)).toBeNull()
    expect(src.match(/rust\.httpDate\(/g)).toBeNull()
    expect(src.match(/rust\.crc32\(/g)).toBeNull()
    expect(src.match(/rust\.xxh3\(/g)).toBeNull()
    expect(src.match(/rust\.hmacSha256\(/g)).toBeNull()
    expect(src.match(/rust\.gzipCompress\(/g)).toBeNull()
    expect(src.match(/rust\.randomToken\(/g)).toBeNull()
    expect(src.match(/rust\.base64Encode\(/g)).toBeNull()
  })
})
