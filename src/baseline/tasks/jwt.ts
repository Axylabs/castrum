// src/baseline/tasks/jwt.ts — JS baseline: JWT sign/verify.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { decoder, encoder } from '../../shared/bytes'

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url')
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  return new Uint8Array(Buffer.from(padded, 'base64url'))
}

/**
 * JS baseline HS256 JWT sign (mirrors `rust.jwtSign`).
 * Adds `iat`/`exp` from `ttlSeconds` + `nowSeconds` when the claims object
 * doesn't already set them.
 */
export function nativeJwtSign(
  claims: Record<string, unknown>,
  secret: Uint8Array,
  ttlSeconds: number | null,
  nowSeconds: number,
): Uint8Array {
  const payload: Record<string, unknown> = { ...claims }
  if (ttlSeconds && ttlSeconds > 0) {
    if (payload.iat === undefined) payload.iat = nowSeconds
    if (payload.exp === undefined) payload.exp = nowSeconds + ttlSeconds
  }

  const headerB64 = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const sig = createHmac('sha256', Buffer.from(secret)).update(signingInput).digest('base64url')

  return encoder.encode(`${signingInput}.${sig}`)
}

/** JS baseline HS256 JWT verify: signature (constant-time) + `exp` check. */
export function nativeJwtVerify(
  token: Uint8Array,
  secret: Uint8Array,
  nowSeconds: number,
): boolean {
  const parts = decoder.decode(token).split('.')
  if (parts.length !== 3) return false

  const [headerB64, payloadB64, sigB64] = parts
  const signingInput = `${headerB64 ?? ''}.${payloadB64 ?? ''}`

  const expected = createHmac('sha256', Buffer.from(secret)).update(signingInput).digest()

  let provided: Buffer
  try {
    provided = Buffer.from(b64urlDecode(sigB64 ?? ''))
  } catch {
    return false
  }

  if (expected.length !== provided.length) return false
  if (!timingSafeEqual(expected, provided)) return false

  // `exp` claim check.
  try {
    const payload = JSON.parse(decoder.decode(b64urlDecode(payloadB64 ?? '')))
    if (
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as Record<string, unknown>).exp === 'number' &&
      nowSeconds >= ((payload as Record<string, unknown>).exp as number)
    ) {
      return false
    }
  } catch {
    return false
  }

  return true
}
