import { expect, test } from 'bun:test'
import * as castrum from '../../../index'
import { ffiAddonPath, getBunFFI } from '../../../src/native/ffi'

test('public ingress binding reuses the self-tested transport and reports its binary', () => {
  expect('getIngressBinding' in castrum).toBe(true)
  const getBinding = (castrum as unknown as { getIngressBinding: () => unknown }).getIngressBinding
  const binding = getBinding() as Record<string, unknown> | null
  const ffi = getBunFFI()
  if (!ffi) {
    expect(binding).toBeNull()
    return
  }
  expect(binding?.addonPath).toBe(ffiAddonPath())
  expect(binding?.ingressHandleComponents).toBe(ffi.ingressHandleComponents)
  expect(binding?.ingressHandlePacked).toBe(ffi.ingressHandlePacked)
  expect(binding?.ingressLayout).toBe(ffi.ingressLayout)
})
