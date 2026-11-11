// test/unit/native/bridge.test.ts — configured framework-native bridge contract.

import { describe, expect, it } from 'bun:test'
import { createNativeBridge } from '../../../native'
import { ffiAddonPath, getBunFFI } from '../../../src/native/ffi'
import { getAddonPath, getAddonPathCandidates } from '../../../src/native/loader'

describe('createNativeBridge', () => {
  it('binds NAPI and lazy C-ABI transports to the same explicit binary', () => {
    const addonPath = getAddonPath()
    const bridge = createNativeBridge({ addonPath })
    expect(bridge.addonPath).toBe(addonPath)
    expect(bridge.ffiError).toBeNull()
    expect(typeof bridge.addon.crc32).toBe('function')

    const ffi = bridge.getFfi()
    expect(ffi).not.toBeNull()
    expect(bridge.getFfi()).toBe(ffi)
    expect(ffi?.crc32(new Uint8Array([1, 2, 3]))).toBe(
      bridge.addon.crc32(new Uint8Array([1, 2, 3])),
    )
  })

  it('honors forced NAPI without eagerly attempting C-ABI', () => {
    const bridge = createNativeBridge({ ffiMode: 'napi' })
    expect(bridge.getFfi()).toBeNull()
    expect(bridge.ffiError).toBeNull()
  })

  it('keeps independent bridge bindings out of process-global state', () => {
    const first = createNativeBridge()
    const second = createNativeBridge()
    expect(first.addon).toBe(second.addon)
    expect(first.getFfi()).not.toBe(second.getFfi())
  })

  it('preserves the default transport path and surface across custom binds', () => {
    const defaultSurface = getBunFFI()
    const defaultPath = ffiAddonPath()
    const alternate = getAddonPathCandidates().find((path) => path !== defaultPath)
    if (!alternate) return

    createNativeBridge({ addonPath: alternate }).getFfi()
    expect(ffiAddonPath()).toBe(defaultPath)
    expect(getBunFFI()).toBe(defaultSurface)
  })

  it('exposes allocating parsers and caller-output instance operations', () => {
    const ffi = createNativeBridge().getFfi()
    expect(ffi).not.toBeNull()
    if (!ffi) return

    const query = ffi.queryParsePacked(new TextEncoder().encode('a=1&b=two'))
    const cookie = ffi.cookieParsePacked(new TextEncoder().encode('sid=abc'))
    const form = ffi.formParsePacked(new TextEncoder().encode('x=hello+world'))
    expect(query.byteLength).toBeGreaterThan(4)
    expect(cookie.byteLength).toBeGreaterThan(4)
    expect(form.byteLength).toBeGreaterThan(4)
    expect(typeof ffi.templateRenderInto).toBe('function')
    expect(typeof ffi.acceptNegotiatorNegotiateServerText).toBe('function')
  })
})
