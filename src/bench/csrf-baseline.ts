// src/bench/csrf-baseline.ts — JS baseline for CSRF tokens.
// randomBytes + HMAC-SHA256 via node:crypto, `<random-hex>.<sig-hex>` format.
// Bench-local only.

import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { decoder, encoder } from '../shared/bytes'

/** Create a CSRF token: 32-byte random hex + "." + hex(HMAC-SHA256(secret, random-hex)). */
export function nativeCsrfToken(secret: Uint8Array): Uint8Array {
  const rnd = randomBytes(32).toString('hex')
  const sig = createHmac('sha256', Buffer.from(secret)).update(rnd).digest('hex')
  return encoder.encode(`${rnd}.${sig}`)
}

/** Constant-time verify a CSRF token. */
export function nativeCsrfVerify(token: Uint8Array, secret: Uint8Array): boolean {
  const t = decoder.decode(token)
  const dot = t.indexOf('.')
  if (dot === -1) return false
  const rnd = t.slice(0, dot)
  const sig = t.slice(dot + 1)
  const expected = createHmac('sha256', Buffer.from(secret)).update(rnd).digest()
  const provided = Buffer.from(sig, 'hex')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
