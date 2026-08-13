/**
 * Tests for the DELETE and OPTIONS route-factory exports:
 *
 * - `deleteHandler` and `optionsHandler` are documented in docs/INGRESS.md as
 *   public route factories but were NOT re-exported from the package entry —
 *   this test pins the export surface so the docs↔code drift cannot regress.
 * - `deleteHandler` shares the read pipeline (DELETE is a read-style method).
 * - `optionsHandler` serves a 204 for a plain (non-preflight) OPTIONS request.
 */

import { describe, test, expect } from 'bun:test'
import {
  deleteHandler,
  optionsHandler,
  readHandler,
  createIngressHandler,
} from '../../../src/ingress/handlers'
import { deleteHandler as entryDeleteHandler } from '../../../index'
import { optionsHandler as entryOptionsHandler } from '../../../index'

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
})

describe('package-entry exports', () => {
  test('deleteHandler and optionsHandler are exported from the package entry', () => {
    expect(typeof entryDeleteHandler).toBe('function')
    expect(typeof entryOptionsHandler).toBe('function')
    // Same identity as the handlers.ts export (single source).
    expect(entryDeleteHandler).toBe(deleteHandler)
    expect(entryOptionsHandler).toBe(optionsHandler)
  })
})

describe('deleteHandler', () => {
  test('is the read factory (DELETE shares the read pipeline)', () => {
    expect(deleteHandler).toBe(readHandler)
  })
})

describe('optionsHandler', () => {
  test('serves 204 for a plain (non-preflight) OPTIONS request', async () => {
    const route = optionsHandler(ingress)
    const res = await route(new Request('http://localhost:1/', { method: 'OPTIONS' }))
    expect(res.status).toBe(204)
  })

  test('returns a fresh route function per handler wiring', () => {
    const a = optionsHandler(ingress)
    const b = optionsHandler(ingress)
    expect(a).not.toBe(b)
  })
})
