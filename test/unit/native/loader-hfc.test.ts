/**
 * Tests for the global higher-order-function data loader (castrum.loader):
 * the HFC shape, scalar/bulk parity vs rust.*, the adaptive single-vs-bulk
 * dispatch, edge shapes, and per-op parity (expanded byte ops, backend
 * features, boolean-validity and paired ops, schema validation).
 *
 * Coalescing + caching lifecycle tests live in loader-hfc-coalesce.test.ts.
 */

import { describe, expect, test } from 'bun:test'
import { createLoader, LOADER_OP_NAMES, loader } from '../../../src/loader'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const bytes = (s: string): Uint8Array => encoder.encode(s)

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMAIL_OK = bytes('alice@example.com')
const EMAIL_BAD = bytes('not-an-email')
const JSON_OK = bytes('[{"id":1,"name":"alice"},{"id":2}]')
const QUERY = bytes('a=1&b=hello%20world&flag')
const UUID_OK = bytes('123e4567-e89b-12d3-a456-426614174000')
const HMAC_KEY = bytes('secret')
const HMAC_DATA = bytes('hello world')
// Expanded-op fixtures (moved from the original single file's tail section).
const SECRET = bytes('s3cr3t')
const FOO = bytes('foobar')
const RAW_FBFF = new Uint8Array([0xfb, 0xff])
const AEAD_KEY = new Uint8Array(32).fill(7)
const AEAD_NONCE = new Uint8Array(12).fill(1)

describe('loader: higher-order function shape', () => {
  test('loader(op) returns a specialized, memoized hot function', () => {
    const a = loader('validateEmail')
    const b = loader('validateEmail')

    expect(typeof a).toBe('function')
    expect(a).toBe(b) // memoized — no registry dispatch on repeat calls
    expect(a.name).toBe('validateEmail')
    expect(a.stats).toBeDefined()
    expect(typeof a.clear).toBe('function')
    expect(typeof a.cache).toBe('function')
    expect(typeof a.load).toBe('function')
  })

  test('opNames exposes the curated set', () => {
    expect(LOADER_OP_NAMES).toContain('validateEmail')
    expect(LOADER_OP_NAMES).toContain('hmacSha256')
    expect(LOADER_OP_NAMES).toContain('crc32')
  })

  test('ops with required extra args do not expose load()', () => {
    const fn = loader('hmacSha256')
    expect(fn.load).toBeUndefined()
    expect(() => loader.load('hmacSha256', HMAC_DATA)).toThrow(/requires extra arguments/)
  })
})

describe('loader: scalar parity', () => {
  test('single item → scalar result, matching rust.<op>', () => {
    const isEmail = loader('validateEmail')
    expect(isEmail(EMAIL_OK)).toBe(rust.validateEmail(EMAIL_OK))
    expect(isEmail(EMAIL_BAD)).toBe(rust.validateEmail(EMAIL_BAD))

    expect(loader('crc32')(HMAC_DATA)).toBe(rust.crc32(HMAC_DATA))
    expect(loader('jsonSumIds')(JSON_OK)).toBe(rust.jsonSumIds(JSON_OK))
    expect(loader('jsonValid')(JSON_OK)).toBe(rust.jsonValid(JSON_OK))
  })

  test('single item with extra args → scalar, matching rust.<op>', () => {
    const sign = loader('signCookie')
    expect(sign(HMAC_DATA, HMAC_KEY)).toEqual(encoder.encode(rust.signCookie(HMAC_DATA, HMAC_KEY)))

    const hmac = loader('hmacSha256')
    expect(hmac(HMAC_DATA, HMAC_KEY)).toEqual(encoder.encode(rust.hmacSha256(HMAC_KEY, HMAC_DATA)))

    const csrf = loader('csrfVerify')
    const token = encoder.encode(rust.csrfToken(HMAC_KEY))
    expect(csrf(token, HMAC_KEY)).toBe(rust.csrfVerify(token, HMAC_KEY))
  })

  test('run(op, single) is the scalar path', () => {
    const before = loader.stats.scalarCalls
    expect(loader.run('validateUuid', UUID_OK)).toBe(rust.validateUuid(UUID_OK))
    expect(loader.stats.scalarCalls).toBeGreaterThan(before)
  })
})

describe('loader: bulk (batch) parity', () => {
  test('array input → one packed batch call, matching rust.batch.<op>', () => {
    const emails = [EMAIL_OK, EMAIL_BAD, EMAIL_OK]
    const rustBits = rust.batch.validateEmail(emails)
    const loaderBits = loader('validateEmail')(emails)
    expect([...loaderBits]).toEqual([...rustBits])

    const crc = loader('crc32')([HMAC_DATA, EMAIL_OK])
    expect([...crc]).toEqual([...rust.batch.crc32([HMAC_DATA, EMAIL_OK])])

    const sum = loader('jsonSumIds')([EMAIL_OK, EMAIL_BAD])
    expect([...sum]).toEqual([...rust.batch.jsonSumIds([EMAIL_OK, EMAIL_BAD])])

    const q = loader('queryParse')([QUERY])
    expect(q.length).toBe(1)
    expect(q[0]).toEqual(rust.batch.queryParse([QUERY])[0])
  })

  test('bytes ops bulk → Uint8Array[]; hmac batch wired through', () => {
    const items = [HMAC_DATA, EMAIL_OK]
    const got = loader('hmacSha256')(items, HMAC_KEY)
    const expected = rust.batch.hmacSha256(items, HMAC_KEY)
    expect(got.length).toBe(2)
    expect(got[0]).toEqual(expected[0])
    expect(got[1]).toEqual(expected[1])
  })

  test('skip-on-error ops degrade per-item (no throw)', () => {
    const bits = loader('jsonValid')([JSON_OK, bytes('{broken')])
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
  })

  test('run(op, bulk) increments the batch counter', () => {
    const l = createLoader()
    const before = l.stats.batchCalls
    l.run('validateEmail', [EMAIL_OK, EMAIL_BAD])
    expect(l.stats.batchCalls).toBe(before + 1)
  })
})

describe('loader: adaptive scalar-loop fallback', () => {
  test('batchMin forces tiny bulks through the scalar loop with identical shape', () => {
    // adaptive:false pins the threshold; batchMin:8 → n=2 routes to scalar loop.
    const l = createLoader({ adaptive: false, batchMin: 8 })
    const before = l.stats.scalarCalls
    const got = l.run('validateEmail', [EMAIL_OK, EMAIL_BAD])
    expect([...got]).toEqual([...rust.batch.validateEmail([EMAIL_OK, EMAIL_BAD])])
    expect(l.stats.scalarCalls).toBeGreaterThan(before)
    expect(l.stats.batchCalls).toBe(0)
  })

  test('default (batchMin=2) batches n>=2', () => {
    const l = createLoader()
    const before = l.stats.batchCalls
    l.run('validateEmail', [EMAIL_OK, EMAIL_BAD])
    expect(l.stats.batchCalls).toBe(before + 1)
  })
})

describe('loader: edge shapes and error semantics', () => {
  test('empty bulk returns the correct empty result without throwing', () => {
    const l = createLoader()
    expect([...(l('validateEmail')([]) as Uint8Array)]).toEqual([])
    expect([...(l('crc32')([]) as Uint32Array)]).toEqual([])
    expect([...(l('jsonSumIds')([]) as BigInt64Array)]).toEqual([])
    expect(l('queryParse')([])).toEqual([])
    expect(l.stats.batchCalls).toBe(0) // empty bulk never takes the batch path
  })

  test('coalesced groups mirror rust.batch skip-on-error semantics', async () => {
    const l = createLoader()
    const sum = l('jsonSumIds')
    const badShape = bytes('{"id":1}') // invalid shape → batch skips it (0n)
    const [a, b, c] = await Promise.all([sum.load(JSON_OK), sum.load(badShape), sum.load(JSON_OK)])
    // The packed batch is skip-on-error, matching rust.batch.jsonSumIds.
    expect(a).toBe(3n)
    expect(b).toBe(0n) // skipped, not thrown
    expect(c).toBe(3n)
  })

  test('a single coalesced load of a throwing input rejects (scalar path)', async () => {
    const l = createLoader()
    const sum = l('jsonSumIds')
    // n=1 routes through the scalar op, which throws on the invalid shape.
    await expect(sum.load(bytes('{"id":1}'))).rejects.toThrow(/expected an array/)
  })

  test('load() on optional-arg ops coalesces with default args', async () => {
    const l = createLoader()
    const enc = l('base64Encode')
    const got = await enc.load(bytes('hello'))
    expect(got).toEqual(encoder.encode(rust.base64Encode(bytes('hello')))) // default urlSafe=false, padding=true
  })

  test('cache keys are namespaced per op (no cross-op collision)', async () => {
    const l = createLoader()
    await l('validateEmail').load(EMAIL_OK)
    await l('crc32').load(EMAIL_OK)
    expect(l('validateEmail').cache(EMAIL_OK)).toBe(true)
    expect(l('crc32').cache(EMAIL_OK)).toBe(rust.crc32(EMAIL_OK))
  })
})

describe('loader: expanded byte ops — scalar + bulk parity', () => {
  test('fnv1a64 scalar + bulk match rust (unsigned)', () => {
    const l = createLoader({ adaptive: false })
    expect(l('fnv1a64')(FOO)).toBe(rust.fnv1a64(FOO))
    const bulk = l('fnv1a64')([FOO, bytes('a')])
    expect(bulk).toBeInstanceOf(BigUint64Array)
    expect(bulk[0]).toBe(rust.fnv1a64(FOO))
    expect(bulk[1]).toBe(rust.fnv1a64(bytes('a')))
    // Bulk element equals the scalar (parity contract).
    expect(bulk[0]).toBe(l('fnv1a64')(FOO))
  })

  test('fnv1a64 adaptive scalar-loop fallback stays unsigned', () => {
    // batchMin=8 forces n=2 through the scalar loop, which must still build a
    // BigUint64Array so high-bit hashes keep parity with the packed batch.
    const l = createLoader({ adaptive: false, batchMin: 8 })
    const bulk = l('fnv1a64')([FOO, bytes('a')])
    expect(bulk).toBeInstanceOf(BigUint64Array)
    expect(bulk[0]).toBe(rust.fnv1a64(FOO))
    expect(bulk[1]).toBe(l('fnv1a64')(bytes('a')))
  })

  test('etag scalar + bulk match rust (strong + weak)', () => {
    const l = createLoader({ adaptive: false })
    expect(l('etag')(bytes('123456789'))).toEqual(encoder.encode(rust.etag(bytes('123456789'))))
    const weak = l('etag')([bytes('123456789')], true)
    expect(weak[0]).toEqual(bytes('W/"cbf43926"'))
    const strong = l('etag')([bytes('123456789')])
    expect(strong[0]).toEqual(bytes('"cbf43926"'))
  })

  test('url/base64url/ws/mime scalar + bulk match rust', () => {
    const l = createLoader({ adaptive: false })
    // urlEncode / urlDecode / urlDecodeBytes
    expect(l('urlEncode')(bytes('a b&c'))).toEqual(encoder.encode(rust.urlEncode(bytes('a b&c'))))
    expect(l('urlEncode')([bytes('a b&c')])[0]).toEqual(bytes('a%20b%26c'))
    expect(l('urlDecode')([bytes('a%20b')])[0]).toEqual(bytes('a b'))
    const utf8 = new Uint8Array([0xc3, 0xa9])
    expect(l('urlDecodeBytes')([bytes('%C3%A9')])[0]).toEqual(utf8)
    // base64url
    expect(l('base64UrlEncode')(RAW_FBFF)).toEqual(bytes('-_8'))
    expect(l('base64UrlDecode')(bytes('-_8'))).toEqual(RAW_FBFF)
    expect(l('base64UrlEncode')([RAW_FBFF])[0]).toEqual(bytes('-_8'))
    // wsAcceptKey (vector matches the scalar test in rust/payload/websocket.rs)
    const ws = l('wsAcceptKey')([bytes('dGhlIHNhbXBsZSBub25jZQ==')])
    expect(ws[0]).toEqual(bytes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='))
    // mime
    expect(l('mimeFromExtension')(bytes('.js'))).toEqual(bytes('text/javascript'))
    expect(l('mimeFromExtension')([bytes('PNG')])[0]).toEqual(bytes('image/png'))
  })
})

describe('loader: backend-feature op parity (aead/ws/sse/jwtSign)', () => {
  test('aeadEncrypt/aeadDecrypt scalar + bulk round-trip', () => {
    const l = createLoader({ adaptive: false })
    const ct = l('aeadEncrypt')(bytes('plaintext'), AEAD_KEY, AEAD_NONCE, 'aes-256-gcm')
    expect(ct).toEqual(rust.aeadEncrypt(AEAD_KEY, AEAD_NONCE, bytes('plaintext'), 'aes-256-gcm'))
    expect(l('aeadDecrypt')(ct, AEAD_KEY, AEAD_NONCE, 'aes-256-gcm')).toEqual(bytes('plaintext'))
    // bulk: encrypt N, decrypt N — per-item nonce derivation matches scalar order
    const cts = l('aeadEncrypt')([bytes('one'), bytes('two')], AEAD_KEY, AEAD_NONCE, 'aes-256-gcm')
    const pts = l('aeadDecrypt')(cts, AEAD_KEY, AEAD_NONCE, 'aes-256-gcm')
    expect(pts[0]).toEqual(bytes('one'))
    expect(pts[1]).toEqual(bytes('two'))
  })

  test('wsFrameEncode bulk matches rust.batch', () => {
    const l = createLoader({ adaptive: false })
    const got = l('wsFrameEncode')([bytes('hi')], 1, false, true)
    expect(got[0]).toEqual(rust.batch.wsFrameEncode([bytes('hi')], 1, false, true)[0])
    // scalar parity
    expect(l('wsFrameEncode')(bytes('hi'), 1, false, true)).toEqual(
      rust.wsFrameEncode(1, bytes('hi'), false, true),
    )
  })

  test('sseEncode scalar + bulk match rust', () => {
    const l = createLoader({ adaptive: false })
    expect(l('sseEncode')(bytes('hi'), 'evt', 'id1', 3000)).toEqual(
      rust.sseEncodeEvent('evt', bytes('hi'), 'id1', 3000),
    )
    expect(l('sseEncode')([bytes('hi')], 'evt')[0]).toEqual(
      rust.batch.sseEncode([bytes('hi')], 'evt')[0],
    )
  })

  test('jwtSign scalar + bulk produce identical tokens', () => {
    const l = createLoader({ adaptive: false })
    const claims = bytes('{"sub":"1"}')
    const single = l('jwtSign')(claims, SECRET, null, 1700000000)
    expect(single).toEqual(
      rust.jwtSign(JSON.parse('{"sub":"1"}') as Record<string, unknown>, SECRET, null, 1700000000),
    )
    const bulk = l('jwtSign')([claims], SECRET, null, 1700000000)
    expect(bulk[0]).toEqual(single)
    expect(rust.batch.jwtVerify(bulk, SECRET, 1700000000)[0]).toBe(1)
  })
})

describe('loader: boolean-validity ops (verifyCookie, jwtVerify)', () => {
  test('verifyCookie single returns valid/invalid matching the batch bitset', () => {
    const l = createLoader({ adaptive: false })
    const signed = encoder.encode(rust.signCookie(bytes('abc'), SECRET))
    expect(l('verifyCookie')(signed, SECRET)).toBe(true)
    expect(l('verifyCookie')(bytes('abc'), SECRET)).toBe(false)
    const bits = l('verifyCookie')([signed, bytes('abc')], SECRET)
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
    // The batch element equals the scalar (parity contract).
    expect(bits[0] === 1).toBe(l('verifyCookie')(signed, SECRET))
  })

  test('jwtVerify single returns valid/invalid matching the batch bitset', () => {
    const l = createLoader({ adaptive: false })
    const token = rust.jwtSign({ sub: '1' }, SECRET, null, 1700000000)
    expect(l('jwtVerify')(token, SECRET, 1700000000)).toBe(true)
    expect(l('jwtVerify')(bytes('bogus'), SECRET, 1700000000)).toBe(false)
    const bits = l('jwtVerify')([token, bytes('bogus')], SECRET, 1700000000)
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
  })
})

describe('loader: paired ops (jsonPatch, hmacSha256Verify, passwordVerify, urlResolve)', () => {
  test('jsonPatch scalar + bulk (packed + scalar-loop fallback)', () => {
    const doc = bytes('{"a":1}')
    const patch = bytes('[{"op":"add","path":"/b","value":2}]')
    const expected = bytes('{"a":1,"b":2}')
    const l = createLoader({ adaptive: false })
    // single
    expect(l('jsonPatch')(doc, patch)).toEqual(expected)
    // bulk n=2 → packed batch
    expect(l('jsonPatch')([doc, doc], [patch, patch])[0]).toEqual(expected)
    // bulk n=1 → adaptive scalar loop must split the companion correctly
    expect(l('jsonPatch')([doc], [patch])[0]).toEqual(expected)
    // forced scalar loop (batchMin raised) still splits companions
    const l2 = createLoader({ adaptive: false, batchMin: 8 })
    expect(l2('jsonPatch')([doc, doc], [patch, patch])[1]).toEqual(expected)
  })

  test('hmacSha256Verify scalar + bulk (key shared, sigs per-item)', () => {
    const data = bytes('msg')
    const sig = encoder.encode(rust.hmacSha256(SECRET, data))
    const l = createLoader({ adaptive: false })
    expect(l('hmacSha256Verify')(data, SECRET, sig)).toBe(true)
    const bits = l('hmacSha256Verify')([data, data], SECRET, [sig, bytes('bad')])
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
  })

  test('passwordVerify scalar + bulk', () => {
    const salt = bytes('0123456789abcdef')
    const phc = encoder.encode(
      rust.passwordHash(bytes('hunter2'), salt, {
        mCost: 8,
        tCost: 1,
        pCost: 1,
        outLen: 16,
      }),
    )
    const l = createLoader({ adaptive: false })
    expect(l('passwordVerify')(bytes('hunter2'), phc)).toBe(true)
    expect(l('passwordVerify')(bytes('nope'), phc)).toBe(false)
    const bits = l('passwordVerify')([bytes('hunter2'), bytes('nope')], [phc, phc])
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
  })

  test('urlResolve scalar + bulk (RFC 3986)', () => {
    const base = bytes('http://a/b/c/d;p?q')
    const ref = bytes('g')
    const l = createLoader({ adaptive: false })
    expect(l('urlResolve')(ref, base)).toEqual(bytes('http://a/b/c/g'))
    expect(l('urlResolve')([ref], [base])[0]).toEqual(bytes('http://a/b/c/g'))
  })
})

describe('loader: schema validation (schemaValidate op + loader.schema)', () => {
  const SCHEMA = bytes('{"type":"object","required":["id"]}')
  const GOOD = bytes('{"id":1}')
  const BAD = bytes('[]')

  test('schemaValidate scalar + bulk', () => {
    const validator = rust.createSchemaValidator(SCHEMA)
    const l = createLoader({ adaptive: false })
    expect(l('schemaValidate')(GOOD, validator)).toBe(true)
    expect(l('schemaValidate')(BAD, validator)).toBe(false)
    const bits = l('schemaValidate')([GOOD, BAD], validator)
    expect(bits[0]).toBe(1)
    expect(bits[1]).toBe(0)
  })

  test('loader.schema(validator) → callable single/bulk/count', () => {
    const validator = rust.createSchemaValidator(SCHEMA)
    const l = createLoader({ adaptive: false })
    const schema = l.schema(validator)
    expect(schema(GOOD)).toBe(true)
    expect(schema(BAD)).toBe(false)
    const bits = schema([GOOD, BAD, GOOD])
    expect([...bits]).toEqual([1, 0, 1])
    expect(schema.count([GOOD, BAD, GOOD])).toBe(2)
    // count is a whole-batch op (no per-element counterpart).
    expect(rust.batch.schemaValidateCount(validator, [GOOD, BAD])).toBe(1)
  })
})
