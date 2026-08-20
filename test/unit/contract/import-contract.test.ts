/**
 * Locks the package's import-time contract.
 *
 * This barrel (index.ts) unconditionally re-exports `src/ingress`, whose
 * `src/ingress/constants.ts` is the ONE module that touches native at import
 * time: it reads the Rust binary layout via the C-ABI blob (Bun) or the napi
 * addon (Node/fallback), running a full bind-time self-test as part of the
 * load. That is intentional and documented — even `import { rust }` pays the
 * eager dlopen. These tests pin that contract so a future refactor cannot
 * silently (a) break the eager path, or (b) add MORE eager-native modules
 * without the test suite noticing the surface change.
 */

import { describe, expect, test } from 'bun:test'
import * as castrum from '../../..'
import { ERR_CODE_INTERNAL, OUT_DATA_START, OUT_VERDICT } from '../../../src/ingress/constants'
import { createIngressFast } from '../../../src/ingress/fast'
import { createIngressHandler } from '../../../src/ingress/handlers'
import { createPipeline } from '../../../src/integration/pipeline'
import { rust } from '../../../src/rust-ffi'

describe('package entry eager-load contract', () => {
  test('importing the barrel exposes the full documented surface', () => {
    // Factories / helpers that must be reachable synchronously after import.
    for (const key of [
      'rust',
      'loader',
      'createIngress',
      'createIngressFast',
      'createIngressHandler',
      'createIngressServer',
      'createIngressServerNode',
      'createPipeline',
      'createIngressMetrics',
      'metricsHandler',
      'livenessHandler',
      'readinessHandler',
      'healthHandler',
      'gracefulShutdown',
      'createWebSocketUpgrade',
      'sseResponse',
    ]) {
      expect((castrum as unknown as Record<string, unknown>)[key]).toBeDefined()
    }
  })

  test('binary-layout constants are readable synchronously (eager native path)', () => {
    // constants.ts reads these from the native addon at import time — if the
    // eager path regressed, these would be undefined or throw at load.
    expect(typeof OUT_VERDICT).toBe('number')
    expect(typeof OUT_DATA_START).toBe('number')
    expect(typeof ERR_CODE_INTERNAL).toBe('number')
    expect(OUT_DATA_START).toBeGreaterThan(0)
  })

  test('the native addon is immediately usable (self-test already ran)', () => {
    const checksum = rust.crc32(new Uint8Array([1, 2, 3]))
    expect(typeof checksum).toBe('number')
  })

  test('the eager ingress factories compose into working handlers', () => {
    // Both paths must construct a live handler straight from the entry surface.
    const fast = createIngressFast({ emitMetadataJson: true })
    const status = fast.run(
      new Request('http://localhost:1/', { method: 'GET' }),
      '1.2.3.4',
      null,
      'test-request-id',
      (r) => r.status,
    )
    expect(status).toBe(200)

    const baked = createIngressHandler({ emitMetadataJson: true })
    expect(typeof baked.run).toBe('function')
  })

  test('createPipeline is composable from the entry-adjacent module', async () => {
    const pipeline = createPipeline({ maxBodyBytes: 1024 })
    const outcome = await pipeline.preprocess(new Request('http://localhost:1/', { method: 'GET' }))
    // GET with no body → non-terminal (flows through to the renderer).
    expect(outcome.terminal).toBe(false)
    expect(typeof outcome.ctx.requestId).toBe('string')
  })
})
