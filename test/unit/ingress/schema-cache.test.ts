/**
 * Tests for the process-wide compiled-schema cache (rust/ingress/schema_cache.rs)
 * as observed through the public TS surfaces.
 *
 * The Rust unit tests pin the cache itself (same bytes → `Arc::ptr_eq`, distinct
 * bytes → separate compiles, bounded LRU, clear). These tests pin that the
 * native wiring is transparent and stable from JS:
 *   - `rust.clearSchemaCache()` is exposed and idempotent,
 *   - N handlers built over the SAME schema bytes all enforce it identically
 *     (the cache must not change validation semantics),
 *   - distinct schemas still compile/behave separately after a clear,
 *   - `createNativeRoute` (the other cached call site) is unaffected.
 */

import { describe, expect, test } from 'bun:test'
import { createIngressHandler, jsonWriteHandler } from '../../../src/ingress/handlers'
import { createNativeRoute } from '../../../src/ingress/native-route'
import { getAddon } from '../../../src/native'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const baseOptions = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
}

const strictSchema = encoder.encode(
  JSON.stringify({
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
    additionalProperties: true,
  }),
)

const permissiveSchema = encoder.encode(JSON.stringify({ type: 'object' }))

function post(body: string): Request {
  return new Request('http://localhost:9999/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('compiled-schema cache (TS wiring)', () => {
  test('the napi addon exposes the clearSchemaCache export', () => {
    expect(typeof getAddon().clearSchemaCache).toBe('function')
  })

  test('rust.clearSchemaCache is exposed and idempotent', () => {
    expect(typeof rust.clearSchemaCache).toBe('function')
    expect(() => rust.clearSchemaCache()).not.toThrow()
    expect(() => rust.clearSchemaCache()).not.toThrow()
  })

  test('N handlers over identical schema bytes all enforce it identically', async () => {
    rust.clearSchemaCache()
    const handlers = Array.from({ length: 4 }, () =>
      createIngressHandler({ ...baseOptions, requireJsonBody: true, schema: strictSchema }, {}),
    )

    for (const h of handlers) {
      const write = jsonWriteHandler(h, { maxBodyBytes: 1024 })
      const valid = await write(post(JSON.stringify({ name: 'ada' })))
      expect(valid.status).toBe(200)
      await valid.text()

      const missing = await write(post(JSON.stringify({ age: 36 })))
      expect(missing.status).toBe(422)
      await missing.text()
    }
  })

  test('clearing the cache does not collapse distinct schemas', async () => {
    const strict = createIngressHandler(
      { ...baseOptions, requireJsonBody: true, schema: strictSchema },
      {},
    )
    // Drop the shared entry: the strict handler keeps its own Arc; the new
    // permissive handler must compile its own, distinct schema.
    rust.clearSchemaCache()
    const permissive = createIngressHandler(
      { ...baseOptions, requireJsonBody: true, schema: permissiveSchema },
      {},
    )

    const bad = post(JSON.stringify({ age: 36 }))
    const strictRes = await jsonWriteHandler(strict, { maxBodyBytes: 1024 })(bad)
    expect(strictRes.status).toBe(422)
    await strictRes.text()

    const permissiveRes = await jsonWriteHandler(permissive, { maxBodyBytes: 1024 })(
      post(JSON.stringify({ age: 36 })),
    )
    expect(permissiveRes.status).toBe(200)
    await permissiveRes.text()

    // The strict handler is still strict after the flush (its Arc survived).
    const strictAgain = await jsonWriteHandler(strict, { maxBodyBytes: 1024 })(
      post(JSON.stringify({ age: 36 })),
    )
    expect(strictAgain.status).toBe(422)
    await strictAgain.text()
  })

  test('createNativeRoute (the second cached call site) is unaffected', () => {
    rust.clearSchemaCache()
    const schema = encoder.encode(
      JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'number' } } }),
    )
    const route = createNativeRoute({ requireJsonBody: true, validateBody: true, schema })

    expect(route.run('', '', encoder.encode('{"x":1}')).errorCode).toBe(0)
    expect(route.run('', '', encoder.encode('{"x":"str"}')).errorCode).toBe(422)
    expect(route.run('', '', encoder.encode('not json')).errorCode).toBe(400)

    route.destroy()
  })
})
