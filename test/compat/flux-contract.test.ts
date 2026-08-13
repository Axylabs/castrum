/**
 * flux-core compatibility contract test.
 *
 * Guards the EXACT surface that flux-core's `@flux/native` package depends on,
 * so the contract cannot silently break when castrum evolves. Runs in
 * castrum's own CI (`bun test`) — if this fails, flux's native acceleration
 * is broken.
 *
 * The contract:
 *   1. Entry normalization `mod.rust ?? mod` exposes the flat surface
 *      (Bun `index.ts` exposes a `rust` namespace; Node `dist/index.js` is
 *      flat) — flux's loader relies on this.
 *   2. Every scalar / class / factory flux uses exists and behaves.
 *   3. Packed parsers produce the `readPairsPacked` wire format.
 */
import { describe, test, expect } from 'bun:test'
import * as mod from '../../index'
import { readPairsPacked } from '../../src/shared/packed'

/** The normalized surface exactly as flux's `@flux/native` loader sees it. */
const surface = (mod as { rust?: unknown }).rust ?? mod

const asRecord = surface as Record<string, unknown>

const requireFn = (name: string): ((...args: unknown[]) => unknown) => {
  expect(typeof asRecord[name], `${name} must be exported`).toBe('function')
  return asRecord[name] as (...args: unknown[]) => unknown
}

const enc = new TextEncoder()

describe('entry normalization (mod.rust ?? mod)', () => {
  test('exposes the scalar surface whether via `rust` namespace or flat', () => {
    // `mod.rust ?? mod` must yield an object with the core scalars — this is
    // the exact expression flux's loader evaluates.
    const candidate = (mod as { rust?: unknown }).rust ?? mod
    const record = candidate as Record<string, unknown>
    expect(typeof record.fnv1a64).toBe('function')
    expect(typeof record.crc32).toBe('function')
    expect(typeof record.jwtSign).toBe('function')
  })
})

describe('scalar surface', () => {
  test('hashing + crypto scalars exist and round-trip', () => {
    const fnv1a64 = requireFn('fnv1a64')
    const jwtSign = requireFn('jwtSign')
    const jwtVerify = requireFn('jwtVerify')
    const hmacSha256 = requireFn('hmacSha256')
    const passwordHash = requireFn('passwordHash')
    const passwordVerify = requireFn('passwordVerify')
    const aeadEncrypt = requireFn('aeadEncrypt')
    const aeadDecrypt = requireFn('aeadDecrypt')

    expect(fnv1a64(enc.encode(''))).toBe(0xcbf29ce484222325n)

    // `jwtSign` returns the compact token BYTES (Uint8Array), not a string —
    // assert against the actual API surface.
    const token = jwtSign({ sub: '42' }, enc.encode('s3cret'), null, 1_700_000_000)
    expect(token).toBeInstanceOf(Uint8Array)
    expect(jwtVerify(token, enc.encode('s3cret'), 1_700_000_000)).not.toBeNull()

    const sig = hmacSha256(enc.encode('key'), enc.encode('data'))
    expect(sig).toBeInstanceOf(Uint8Array)

    // Argon2 requires a salt of at least 8 bytes; "salt" (4) is too short.
    const phc = passwordHash(enc.encode('hunter2'), enc.encode('somesalt1234'))
    expect(passwordVerify(enc.encode('hunter2'), phc)).toBe(true)

    const key = new Uint8Array(32).fill(7)
    const nonce = new Uint8Array(12).fill(1)
    const ct = aeadEncrypt(key, nonce, enc.encode('msg'))
    expect(aeadDecrypt(key, nonce, ct)).not.toBeNull()
  })

  test('packed parsers produce the readPairsPacked wire format', () => {
    const queryParsePacked = requireFn('queryParsePacked')
    const cookieParsePacked = requireFn('cookieParsePacked')
    const formParsePacked = requireFn('formParsePacked')

    expect(
      readPairsPacked(queryParsePacked(enc.encode('a=1&b=two%20words')) as Uint8Array),
    ).toEqual([
      ['a', '1'],
      ['b', 'two words'],
    ])
    expect(
      readPairsPacked(cookieParsePacked(enc.encode('sid=abc; theme=dark')) as Uint8Array),
    ).toEqual([
      ['sid', 'abc'],
      ['theme', 'dark'],
    ])
    expect(readPairsPacked(formParsePacked(enc.encode('a=1&b=hello+world')) as Uint8Array)).toEqual(
      [
        ['a', '1'],
        ['b', 'hello world'],
      ],
    )
  })

  test('validation + payload scalars exist', () => {
    for (const name of [
      'validateEmail',
      'validateUuid',
      'validateIpv4',
      'validateIpv6',
      'etag',
      'multipartParse',
      'wsFrameEncode',
      'wsFrameDecode',
      'sseEncodeEvent',
      'gzipCompress',
      'jsonValid',
      'jsonPatch',
      'randomToken',
    ]) {
      expect(typeof asRecord[name], `${name} must be exported`).toBe('function')
    }
  })
})

describe('compiled factories (flux route-manager + 304 + schema bridges)', () => {
  test('factory functions exist', () => {
    for (const name of [
      'createConditionalRequest',
      'createAcceptNegotiator',
      'createFormParser',
      'createSchemaValidator',
      'createMediaTypeParser',
      'createMediaTypeMatcher',
      'createTemplateRenderer',
    ]) {
      expect(typeof asRecord[name], `${name} must be exported`).toBe('function')
    }
  })

  test('ConditionalRequest follows RFC 7232 (INM wins, weak compare)', () => {
    const createConditionalRequest = requireFn('createConditionalRequest')
    const cond = createConditionalRequest(enc.encode('W/"abc"'), 1_700_000_000) as {
      isNotModified(a: Uint8Array | null, b: Uint8Array | null): boolean
    }
    expect(cond.isNotModified(enc.encode('"abc"'), null)).toBe(true)
    expect(cond.isNotModified(enc.encode('W/"abc"'), null)).toBe(true)
    expect(cond.isNotModified(enc.encode('*'), null)).toBe(true)
    expect(cond.isNotModified(enc.encode('"other"'), null)).toBe(false)
  })

  test('TemplateRenderer renders and SchemaValidator validates', () => {
    const createTemplateRenderer = requireFn('createTemplateRenderer')
    const renderer = createTemplateRenderer('Hello {{ name }}!') as {
      render(ctx: unknown): Uint8Array
    }
    expect(new TextDecoder().decode(renderer.render({ name: 'flux' }))).toBe('Hello flux!')

    const createSchemaValidator = requireFn('createSchemaValidator')
    const validator = createSchemaValidator(
      enc.encode('{"type":"object","properties":{"a":{"type":"number"}},"required":["a"]}'),
    ) as { validate(input: Uint8Array): boolean }
    expect(validator.validate(enc.encode('{"a":1}'))).toBe(true)
    expect(validator.validate(enc.encode('{"a":"x"}'))).toBe(false)
  })
})

describe('RateLimiter contract (native per-key fixed-window)', () => {
  test('createRateLimiter factory enforces the budget', () => {
    // The public API is the `createRateLimiter` factory on the `rust`
    // namespace / flat entry (the raw `RateLimiter` class is addon-internal).
    expect(typeof asRecord.createRateLimiter).toBe('function')
    const createRateLimiter = asRecord.createRateLimiter as (
      limit: number,
      windowMs: number,
      maxEntries?: number | null,
    ) => {
      check(key: string, nowMs: number): { allowed: boolean; remaining: number; resetMs: number }
    }

    const now = Date.now()
    const rl = createRateLimiter(2, 60_000, 1024)
    expect(rl.check('user:1', now).allowed).toBe(true)
    expect(rl.check('user:1', now).allowed).toBe(true)
    expect(rl.check('user:1', now).allowed).toBe(false)
    // Independent keys are unaffected; resetMs is in the future.
    expect(rl.check('user:2', now).allowed).toBe(true)
    expect(rl.check('user:2', now).resetMs).toBeGreaterThan(now)
  })

  test('zero limit denies everything', () => {
    const createRateLimiter = asRecord.createRateLimiter as (
      limit: number,
      windowMs: number,
    ) => { check(key: string, nowMs: number): { allowed: boolean } }
    const rl = createRateLimiter(0, 60_000)
    expect(rl.check('k', Date.now()).allowed).toBe(false)
  })
})
