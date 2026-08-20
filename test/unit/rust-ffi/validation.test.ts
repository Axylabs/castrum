/**
 * Tests for the Rust validation FFI: `rust.validateIpv4/validateIpv6` plus the
 * already-covered email/UUID, in scalar, text and batch forms
 * (rust/util/validation.rs).
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { encoder } from '../../../src/shared/bytes'

const enc = (s: string) => encoder.encode(s)

describe('validateIpv4', () => {
  test('scalar accepts valid IPv4', () => {
    expect(rust.validateIpv4(enc('192.168.1.1'))).toBe(true)
    expect(rust.validateIpv4(enc('0.0.0.0'))).toBe(true)
    expect(rust.validateIpv4(enc('255.255.255.255'))).toBe(true)
  })

  test('scalar rejects invalid IPv4', () => {
    expect(rust.validateIpv4(enc('999.1.1.1'))).toBe(false)
    expect(rust.validateIpv4(enc('1.2.3'))).toBe(false)
    expect(rust.validateIpv4(enc('1.2.3.4.5'))).toBe(false)
    expect(rust.validateIpv4(enc('a.b.c.d'))).toBe(false)
    expect(rust.validateIpv4(enc(''))).toBe(false)
  })

  test('text namespace', () => {
    expect(rust.text.validateIpv4('10.0.0.1')).toBe(true)
    expect(rust.text.validateIpv4('not-an-ip')).toBe(false)
  })
})

describe('validateIpv6', () => {
  test('scalar accepts valid IPv6', () => {
    expect(rust.validateIpv6(enc('::1'))).toBe(true)
    expect(rust.validateIpv6(enc('2001:db8::8a2e:370:7334'))).toBe(true)
    expect(rust.validateIpv6(enc('fe80::1ff:fe23:4567:890a'))).toBe(true)
  })

  test('scalar rejects invalid IPv6', () => {
    expect(rust.validateIpv6(enc('::1::'))).toBe(false)
    expect(rust.validateIpv6(enc('12345::'))).toBe(false)
    expect(rust.validateIpv6(enc('not-an-ip'))).toBe(false)
  })

  test('text namespace', () => {
    expect(rust.text.validateIpv6('::1')).toBe(true)
    expect(rust.text.validateIpv6('nope')).toBe(false)
  })
})

describe('validation batch (per-item 0/1)', () => {
  test('validateIpv4 batch matches scalar per item', () => {
    const items = [enc('192.168.1.1'), enc('bad'), enc('10.0.0.1'), enc('999.0.0.1')]
    const out = rust.batch.validateIpv4(items)
    // The batch returns one 0/1 byte per item (not a bit-packed bitset).
    expect(out.length).toBe(items.length)
    for (let i = 0; i < items.length; i++) {
      expect(out[i]).toBe(rust.validateIpv4(items[i]) ? 1 : 0)
    }
  })

  test('validateIpv6 batch matches scalar per item', () => {
    const items = [enc('::1'), enc('nope'), enc('2001:db8::1')]
    const out = rust.batch.validateIpv6(items)
    expect(out.length).toBe(items.length)
    for (let i = 0; i < items.length; i++) {
      expect(out[i]).toBe(rust.validateIpv6(items[i]) ? 1 : 0)
    }
  })
})
