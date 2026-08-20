// src/native/ffi/build/codecs.ts — hashing / codec / crypto / auth BunFFI methods.
//
// Checksums, JSON/UTF-8 validity, hex + percent codecs, base64, HMAC, cookie
// signing, CSRF, random tokens, password hashing, PBKDF2, AEAD, and the
// cstring-based ws accept key + ETag. Receives the raw dlopen'd symbols and
// the per-bind context (argument adapters + pooled scratch) from `build()`.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import { SELFTEST_HEX, SELFTEST_JSON } from '../constants'
import type { BunFFI, Raw3, Raw4, Raw5, Raw6, Raw8, Raw9, Raw10, RawCStr } from '../types'
import type { BuildCtx } from './util'
import { argon2PhcLength, cstr, flag, growExact, writeOrThrow } from './util'

/**
 * Build the codec/crypto/auth methods of the BunFFI surface. `ctx` is
 * destructured so the method bodies read exactly as the original `build()`.
 */
export function buildCodecs(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView, oneArg, scratchFor, jsonSumOut, jsonSumView } = ctx

  const crc32 = sym.castrum_crc32 as (...a: unknown[]) => number | bigint
  const fnv = sym.castrum_fnv1a64 as (...a: unknown[]) => number | bigint
  const xxh = sym.castrum_xxh3 as (...a: unknown[]) => number | bigint
  const jsonValid = sym.castrum_json_valid as (...a: unknown[]) => number | bigint
  const utf8Valid = sym.castrum_utf8_valid as (...a: unknown[]) => number | bigint
  const hexEncode = sym.castrum_hex_encode as Raw4
  const hexDecode = sym.castrum_hex_decode as Raw4
  const urlEncode = sym.castrum_url_encode as Raw4
  const urlDecode = sym.castrum_url_decode as Raw4
  const validateEmail = sym.castrum_validate_email as (...a: unknown[]) => number | bigint
  const validateUuid = sym.castrum_validate_uuid as (...a: unknown[]) => number | bigint
  const validateIpv4 = sym.castrum_validate_ipv4 as (...a: unknown[]) => number | bigint
  const validateIpv6 = sym.castrum_validate_ipv6 as (...a: unknown[]) => number | bigint
  const jsonSumRaw = sym.castrum_json_sum_ids as Raw4
  const hmacVerify = sym.castrum_hmac_sha256_verify as Raw6
  const csrfVerify = sym.castrum_csrf_verify as Raw4
  const passwordVerify = sym.castrum_password_verify as Raw4
  const passwordVerifyBcrypt = sym.castrum_password_verify_bcrypt as Raw3
  const wsAcceptKey = sym.castrum_ws_accept_key as RawCStr
  const wsAcceptKeyInto = sym.castrum_ws_accept_key_into as Raw4
  const etagCStr = sym.castrum_etag as RawCStr
  const etagIntoRaw = sym.castrum_etag_into as Raw5
  const randomToken = sym.castrum_random_token as RawCStr
  const randomTokenInto = sym.castrum_random_token_into as Raw3
  const base64Encode = sym.castrum_base64_encode as Raw6
  const base64Decode = sym.castrum_base64_decode as Raw6
  const hmacSha256 = sym.castrum_hmac_sha256 as Raw6
  const signCookie = sym.castrum_sign_cookie as RawCStr
  const signCookieInto = sym.castrum_sign_cookie_into as Raw6
  const verifyCookie = sym.castrum_verify_cookie as RawCStr
  const verifyCookieInto = sym.castrum_verify_cookie_into as Raw6
  const csrfToken = sym.castrum_csrf_token as RawCStr
  const csrfTokenInto = sym.castrum_csrf_token_into as Raw4
  const passwordHash = sym.castrum_password_hash as Raw10
  const passwordHashBcrypt = sym.castrum_password_hash_bcrypt as Raw5
  const pbkdf2 = sym.castrum_pbkdf2_sha256 as Raw8
  const aeadEncrypt = sym.castrum_aead_encrypt as Raw9
  const aeadDecrypt = sym.castrum_aead_decrypt as Raw9

  // ── Encoder / decoder `Into` helpers ──────────────────────────────
  const hexEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    // Mirror napi error semantics: a too-small buffer throws, not returns 0.
    // Hex encode always writes exactly `input.length * 2` bytes on success.
    if (output.length < input.length * 2) {
      throw new Error('hex encode: output buffer too small')
    }
    return Number(hexEncode(input, lenOrView(input), output, lenOrView(output)))
  }

  const urlEncodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlEncode(input, lenOrView(input), output, lenOrView(output)))
    // Every input byte encodes to >= 1 output byte, so a 0 write on non-empty
    // input means the buffer was too small (napi throws there too). Empty
    // input legitimately writes 0.
    if (w === 0 && input.length !== 0) {
      throw new Error('url encode: output buffer too small')
    }
    return w
  }

  const hexDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(hexDecode(input, lenOrView(input), output, lenOrView(output)))
    return writeOrThrow(w, input.length, 'hex decode')
  }

  const urlDecodeInto = (input: Uint8Array, output: Uint8Array): number => {
    const w = Number(urlDecode(input, lenOrView(input), output, lenOrView(output)))
    return writeOrThrow(w, input.length, 'url decode')
  }

  const base64DecodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true (rust/crypto/base64.rs).
    const w = Number(
      base64Decode(
        input,
        lenOrView(input),
        output,
        lenOrView(output),
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    return writeOrThrow(w, input.length, 'base64 decode')
  }

  const base64EncodeInto = (
    input: Uint8Array,
    output: Uint8Array,
    urlSafe?: boolean,
    padding?: boolean,
  ): number => {
    // napi defaults: urlSafe=false, padding=true.
    const w = Number(
      base64Encode(
        input,
        lenOrView(input),
        output,
        lenOrView(output),
        flag(urlSafe),
        flag(padding ?? true),
      ),
    )
    // Empty input legitimately writes 0 bytes — only a 0 write on NON-empty
    // input is a real error (same convention as the decode/etag paths).
    return writeOrThrow(w, input.length, 'base64 encode')
  }

  const etagInto = (data: Uint8Array, output: Uint8Array, weak?: boolean): number => {
    // Native pooled `_into`: writes 10/12 bytes directly into the caller
    // buffer (no cstring round-trip). Needed-size convention: a write larger
    // than `output.length` reports the exact required size → throw.
    const w = Number(etagIntoRaw(data, lenOrView(data), flag(weak), output, lenOrView(output)))
    if (w === 0) {
      throw new Error('etag: invalid input')
    }
    if (w > output.length) {
      throw new Error('etag: output buffer too small')
    }
    return w
  }

  return {
    crc32: (input) => Number(oneArg(crc32, input)) >>> 0,
    fnv1a64: (input) => BigInt(oneArg(fnv, input)),
    xxh3: (input) => BigInt(oneArg(xxh, input)),
    jsonValid: (input) => Number(oneArg(jsonValid, input)) === 1,
    utf8Valid: (input) => Number(oneArg(utf8Valid, input)) === 1,
    hexEncode(input) {
      // Pooled scratch — decoded synchronously to an immutable string (safe;
      // removes the per-call `new Uint8Array(len*2)`). ALWAYS decode the
      // written subarray: the shared scratch may be larger than `w` (grown by
      // an earlier op), so decoding the whole buffer would read stale bytes.
      const out = scratchFor(input.length * 2)
      const w = hexEncodeInto(input, out)
      return decodeUtf8(out.subarray(0, w))
    },
    hexEncodeInto,
    urlEncode(input) {
      // RFC 3986 worst case is 3 bytes per input byte (`%XX`). Pooled scratch
      // (decoded synchronously — safe).
      const out = scratchFor(input.length * 3)
      const w = urlEncodeInto(input, out)
      return decodeUtf8(out.subarray(0, w))
    },
    urlEncodeInto,

    validateEmail: (input) => Number(validateEmail(input)) === 1,
    validateUuid: (input) => Number(validateUuid(input)) === 1,
    validateIpv4: (input) => Number(validateIpv4(input)) === 1,
    validateIpv6: (input) => Number(validateIpv6(input)) === 1,
    jsonSumIds: (input) => {
      // Packed [u8 ok][i64 sum LE] output (9 B): ok=1 → valid array (the sum
      // may be 0); ok=0 → invalid input. Bytes written: 9/1/0 (0 = real error).
      const w = Number(jsonSumRaw(input, lenOrView(input), jsonSumOut, lenOrView(jsonSumOut)))
      if (w === 0) {
        throw new Error('json sum ids: output buffer too small')
      }
      if (jsonSumOut[0] === 0) {
        // Mirrors the napi error phrasing (serde: "expected an array of objects
        // with numeric ids") so both transports throw the same message.
        throw new Error('json sum ids: expected an array of objects with numeric ids')
      }
      return jsonSumView.getBigInt64(1, true)
    },
    hmacSha256Verify: (key, data, signature) =>
      Number(
        hmacVerify(key, lenOrView(key), data, lenOrView(data), signature, lenOrView(signature)),
      ) === 1,
    csrfVerify: (token, secret) =>
      Number(csrfVerify(token, lenOrView(token), secret, lenOrView(secret))) === 1,
    passwordVerify: (password, phc) =>
      Number(passwordVerify(password, lenOrView(password), phc, lenOrView(phc))) === 1,
    passwordVerifyBcrypt: (password, phc) =>
      Number(passwordVerifyBcrypt(password, lenOrView(password), phc)) === 1,

    hexDecode(input) {
      const out = new Uint8Array(Math.floor(input.length / 2))
      const w = hexDecodeInto(input, out)
      return out.subarray(0, w)
    },
    hexDecodeInto,
    urlDecode(input) {
      const out = new Uint8Array(input.length)
      const w = urlDecodeInto(input, out)
      return out.subarray(0, w)
    },
    urlDecodeInto,
    base64Decode(input, urlSafe, padding) {
      const out = new Uint8Array(Math.ceil((input.length * 3) / 4))
      const w = base64DecodeInto(input, out, urlSafe, padding)
      return out.subarray(0, w)
    },
    base64DecodeInto,

    wsAcceptKey(key) {
      return cstr(wsAcceptKey(key), 'ws accept key: bad key')
    },
    wsAcceptKeyInto(key, output) {
      // Native pooled `_into`: writes the 28-byte accept key directly into the
      // caller buffer (no cstring round-trip). Needed-size convention.
      const w = Number(wsAcceptKeyInto(key, lenOrView(key), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('ws accept key: bad key')
      }
      if (w > output.length) {
        throw new Error('ws accept key: output buffer too small')
      }
      return w
    },
    etag(data, weak) {
      // cstring return (10 strong / 12 weak chars) — zero encode.
      return cstr(etagCStr(data, lenOrView(data), flag(weak)), 'etag: invalid input')
    },
    etagInto,
    randomToken(byteLen) {
      // cstring return of `byteLen*2` hex chars; byteLen 0 → empty string → empty
      // Uint8Array (napi returns empty too). null = random source failed / >16MiB.
      return cstr(
        randomToken(byteLen),
        'random token: output buffer too small or random source failed',
      )
    },
    randomTokenInto(byteLen, output) {
      // Pooled sibling: native writes `byteLen*2` hex chars directly into the
      // caller buffer (no cstring round-trip). Needed-size convention: a write
      // larger than `output.length` reports the exact required size → throw
      // (the caller owns the buffer); 0 = real error (cap / RNG).
      const w = Number(randomTokenInto(byteLen, output, lenOrView(output)))
      if (w === 0) {
        throw new Error('random token: random source failed or byteLen exceeds 16 MiB')
      }
      if (w > output.length) {
        throw new Error('random token: output buffer too small')
      }
      return w
    },
    base64Encode(input, urlSafe, padding) {
      // Pooled scratch — decoded synchronously to an immutable string (safe).
      const out = scratchFor(Math.ceil(input.length / 3) * 4)
      const w = base64EncodeInto(input, out, urlSafe, padding)
      return decodeUtf8(out.subarray(0, w))
    },
    base64EncodeInto,
    hmacSha256(key, data) {
      // Pooled 64-byte scratch — decoded synchronously (safe).
      const out = scratchFor(64)
      const w = Number(hmacSha256(key, lenOrView(key), data, lenOrView(data), out, lenOrView(out)))
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return decodeUtf8(out.subarray(0, w))
    },
    hmacSha256Into(key, data, output) {
      if (output.length < 64) {
        throw new Error('hmac sha256: output buffer too small')
      }
      const w = Number(
        hmacSha256(key, lenOrView(key), data, lenOrView(data), output, lenOrView(output)),
      )
      if (w === 0) {
        throw new Error('hmac sha256: output buffer too small')
      }
      return w
    },
    signCookie(value, secret) {
      // `value.<64-hex>` returned as a cstring (value.length + 1 + 64 chars).
      return cstr(
        signCookie(value, lenOrView(value), secret, lenOrView(secret)),
        'sign cookie: invalid input',
      )
    },
    signCookieInto(value, secret, output) {
      // Native pooled `_into`: writes `value.<64-hex>` directly into the caller
      // buffer (no cstring round-trip — this is why pooled sign_cookie was
      // previously a REGRESSION vs allocating). Needed-size convention.
      const w = Number(
        signCookieInto(
          value,
          lenOrView(value),
          secret,
          lenOrView(secret),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('sign cookie: invalid input')
      }
      if (w > output.length) {
        throw new Error('sign cookie: output buffer too small')
      }
      return w
    },
    verifyCookie(signed, secret) {
      // cstring return; `null` = invalid signature / malformed → null (napi parity).
      // CAVEAT (refactor): the engine clones a UTF-8 string, so a cookie VALUE
      // containing non-UTF-8 bytes or NUL cannot round-trip byte-faithfully on
      // the FFI path (napi still does). Signed values are ASCII in practice.
      const s = verifyCookie(signed, lenOrView(signed), secret, lenOrView(secret))
      return s === null ? null : s
    },
    verifyCookieInto(signed, secret, output) {
      // Native pooled `_into`: writes the verified value directly into the
      // caller buffer. 0 = invalid signature / malformed → null (napi parity,
      // like the allocating `verifyCookie`); a write larger than `output.length`
      // reports the exact required size → throw.
      const w = Number(
        verifyCookieInto(
          signed,
          lenOrView(signed),
          secret,
          lenOrView(secret),
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        return null
      }
      if (w > output.length) {
        throw new Error('verify cookie: output buffer too small')
      }
      return w
    },
    csrfToken(secret) {
      // 129-char `hex.hex` cstring return.
      return cstr(
        csrfToken(secret, lenOrView(secret)),
        'csrf token: output buffer too small or random source failed',
      )
    },
    csrfTokenInto(secret, output) {
      // Native pooled `_into`: writes the 129-char `hex.hex` token directly
      // into the caller buffer (no cstring round-trip). Needed-size convention.
      const w = Number(csrfTokenInto(secret, lenOrView(secret), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('csrf token: random source failed')
      }
      if (w > output.length) {
        throw new Error('csrf token: output buffer too small')
      }
      return w
    },
    passwordHash(password, salt, mCost, tCost, pCost, outLen) {
      // Pre-size with the EXACT PHC string length (computable from the params),
      // so the hash runs once — a grow-retry would re-run the whole argon2
      // hash on a miss. growExact remains the safety net.
      return decodeUtf8(
        growExact(
          (out) =>
            Number(
              passwordHash(
                password,
                lenOrView(password),
                salt,
                lenOrView(salt),
                mCost,
                tCost,
                pCost,
                outLen,
                out,
                lenOrView(out),
              ),
            ),
          argon2PhcLength(mCost, tCost, pCost, salt.length, outLen),
          2 * 1024 * 1024,
          'password hash: output buffer too small',
        ),
      )
    },
    passwordHashBcrypt(password, cost) {
      // `$2b$CC$` + 22 salt chars + 31 hash chars = 60 chars.
      const out = new Uint8Array(64)
      const w = Number(passwordHashBcrypt(password, lenOrView(password), cost, out, lenOrView(out)))
      if (w === 0) {
        throw new Error('password hash bcrypt: output buffer too small')
      }
      return decodeUtf8(out.subarray(0, w))
    },
    pbkdf2Sha256(password, salt, rounds, dkLen) {
      // Rust clamps dkLen to [1, 1MiB] (PBKDF2_MIN_LEN/MAX_LEN) AFTER sizing its
      // own buffer — so pre-clamp here so dkLen 0 still yields a 1-byte result.
      const dk = Math.min(Math.max(dkLen, 1), 1024 * 1024)
      const out = new Uint8Array(dk)
      const w = Number(
        pbkdf2(
          password,
          lenOrView(password),
          salt,
          lenOrView(salt),
          rounds,
          dkLen,
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('pbkdf2: output buffer too small')
      }
      return out.subarray(0, w)
    },
    aeadEncrypt(key, nonce, plaintext, algorithm = 0) {
      // ciphertext + 16-byte auth tag.
      const out = new Uint8Array(plaintext.length + 16)
      const w = Number(
        aeadEncrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          plaintext,
          lenOrView(plaintext),
          algorithm,
          out,
          lenOrView(out),
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return out.subarray(0, w)
    },
    aeadEncryptInto(key, nonce, plaintext, output, algorithm = 0) {
      const need = plaintext.length + 16
      if (output.length < need) {
        throw new Error('aead encrypt: output buffer too small')
      }
      const w = Number(
        aeadEncrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          plaintext,
          lenOrView(plaintext),
          algorithm,
          output,
          lenOrView(output),
        ),
      )
      if (w === 0) {
        throw new Error('aead encrypt: output buffer too small or bad parameters')
      }
      return w
    },
    aeadDecrypt(key, nonce, ciphertext, algorithm = 0) {
      const out = new Uint8Array(ciphertext.length)
      const w = Number(
        aeadDecrypt(
          key,
          lenOrView(key),
          nonce,
          lenOrView(nonce),
          ciphertext,
          lenOrView(ciphertext),
          algorithm,
          out,
          lenOrView(out),
        ),
      )
      return w === 0 ? null : out.subarray(0, w)
    },
  }
}

/**
 * Bind-time self-test for the codec/crypto/auth surface (the methods built in
 * `buildCodecs`). Exercises every bound function against known-good vectors;
 * `false` disables the ffi layer and forces the napi fallback.
 */
export function selfTestCodecs(b: BunFFI): boolean {
  const enc = { encode: encodeUtf8 }
  const dec = { decode: decodeUtf8 }

  // Checksums + validity probes.
  if (b.crc32(enc.encode('123456789')) !== 0xcbf4_3926) return false
  if (b.fnv1a64(enc.encode('foobar')) !== 0x8594_4171_f739_67e8n) return false
  // XXH3-64 of empty input = 0x2d06800538d394c2 (standard reference vector).
  if (b.xxh3(new Uint8Array(0)) !== 0x2d06800538d394c2n) return false
  if (b.jsonValid(SELFTEST_JSON) !== true || b.jsonValid(enc.encode('{not json')) !== false) {
    return false
  }
  // UTF-8 validity probe (native replacement for a fatal TextDecoder on the
  // Bun path — used by the urlDecode wrapper).
  if (!b.utf8Valid(enc.encode('héllo')) || b.utf8Valid(new Uint8Array([0xff, 0xfe]))) {
    return false
  }
  const hexOut = new Uint8Array(SELFTEST_HEX.length * 2)
  if (b.hexEncodeInto(SELFTEST_HEX, hexOut) !== 10 || dec.decode(hexOut) !== '68656c6c6f') {
    return false
  }
  const urlInput = enc.encode('a b/c')
  const urlOut = new Uint8Array(9)
  if (b.urlEncodeInto(urlInput, urlOut) !== 9 || dec.decode(urlOut) !== 'a%20b%2Fc') {
    return false
  }

  // Validators take `cstring` ARGs (the engine transcodes the JS string).
  if (
    !b.validateEmail('a@b.com') ||
    !b.validateUuid('550e8400-e29b-41d4-a716-446655440000') ||
    !b.validateIpv4('192.168.0.1') ||
    !b.validateIpv6('2001:db8::1') ||
    b.validateEmail('not-an-email') ||
    b.validateUuid('not-a-uuid')
  ) {
    return false
  }
  // Packed `[u8 ok][i64 sum LE]` ABI: legit zero-sum is ok, invalid input throws.
  if (b.jsonSumIds(enc.encode(`[{"id":1},{"id":2}]`)) !== 3n) return false
  if (b.jsonSumIds(enc.encode(`[{"id":0},{"id":0}]`)) !== 0n) return false
  let sumInvalidThrew = false
  try {
    b.jsonSumIds(enc.encode('nope'))
  } catch {
    sumInvalidThrew = true
  }
  if (!sumInvalidThrew) return false

  // HMAC RFC 4231 test case 1 (0x0b × 20 key, "Hi There" data).
  const hmacKey = new Uint8Array(20).fill(0x0b)
  const hmacData = enc.encode('Hi There')
  const hmacSig = enc.encode('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  if (
    b.hmacSha256(hmacKey, hmacData) !==
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  ) {
    return false
  }
  if (!b.hmacSha256Verify(hmacKey, hmacData, hmacSig)) {
    return false
  }

  // Decoders round-trip.
  const decoded = b.hexDecode(enc.encode('68656c6c6f'))
  if (
    dec.decode(decoded) !== 'hello' ||
    dec.decode(b.urlDecode(enc.encode('a%20b%2Fc'))) !== 'a b/c'
  ) {
    return false
  }

  // WebSocket accept key (RFC 6455 sample) — `key` is a `cstring` ARG.
  if (b.wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==') !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') {
    return false
  }
  // ETag: strong = 10 bytes, weak = 12 bytes.
  if (b.etag(SELFTEST_HEX).length !== 10 || b.etag(SELFTEST_HEX, true).length !== 12) {
    return false
  }

  // base64.
  if (b.base64Encode(SELFTEST_HEX) !== 'aGVsbG8=') {
    return false
  }
  if (dec.decode(b.base64Decode(enc.encode('aGVsbG8='))) !== 'hello') {
    return false
  }

  // Signed cookie round-trip.
  const secret = enc.encode('s3cr3t-secret')
  const signed = b.signCookie(SELFTEST_HEX, secret)
  const verified = b.verifyCookie(enc.encode(signed), secret)
  if (verified === null || verified !== 'hello') {
    return false
  }
  if (b.verifyCookie(enc.encode('tampered.0000'), secret) !== null) {
    return false
  }

  // CSRF token round-trip (issued token verifies against the same secret).
  const csrfTokenStr = b.csrfToken(secret)
  if (csrfTokenStr.length !== 129 || !b.csrfVerify(enc.encode(csrfTokenStr), secret)) {
    return false
  }

  // Argon2id round-trip at minimum cost (fast) — full defaults would take ~50ms.
  const pw = enc.encode('correct horse battery staple')
  const salt = enc.encode('salty-salt-16b')
  const phc = b.passwordHash(pw, salt, 8, 1, 1, 16)
  if (phc.length === 0 || !b.passwordVerify(pw, enc.encode(phc))) {
    return false
  }
  // bcrypt round-trip at minimum cost (fast) — `phc` is a `cstring` ARG.
  const bcryptPhc = b.passwordHashBcrypt(pw, 4)
  if (bcryptPhc.length === 0 || !b.passwordVerifyBcrypt(pw, bcryptPhc)) {
    return false
  }
  // PBKDF2-HMAC-SHA256: password="password", salt="salt", c=1, dkLen=32.
  const dk = b.pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 1, 32)
  if (b.hexEncode(dk) !== '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b') {
    return false
  }

  // AEAD AES-256-GCM round-trip (key 32B, nonce 12B).
  const aeadKey = new Uint8Array(32).fill(0x42)
  const nonce = new Uint8Array(12).fill(0x07)
  const ct = b.aeadEncrypt(aeadKey, nonce, SELFTEST_HEX, 0)
  const pt = b.aeadDecrypt(aeadKey, nonce, ct, 0)
  if (pt === null || dec.decode(pt) !== 'hello') {
    return false
  }

  // Random token pooled Into: writes byteLen*2 hex chars into the buffer.
  const rtOut = new Uint8Array(32)
  const rtW = b.randomTokenInto(16, rtOut)
  if (rtW !== 32 || !/^[0-9a-f]{32}$/.test(dec.decode(rtOut))) {
    return false
  }
  // Too-small buffer → throw (needed-size convention).
  try {
    b.randomTokenInto(16, new Uint8Array(8))
    return false
  } catch {
    // expected
  }

  // Fixed-size writers pooled Into: ws_accept_key + etag + csrf_token match the
  // cstring path byte-for-byte.
  const waOut = new Uint8Array(28)
  const waW = b.wsAcceptKeyInto(enc.encode('dGhlIHNhbXBsZSBub25jZQ=='), waOut)
  const waExpected = b.wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')
  if (waW !== 28 || dec.decode(waOut) !== waExpected) {
    return false
  }
  const etagData = enc.encode('hello')
  const etagOut = new Uint8Array(16)
  const etagW = b.etagInto(etagData, etagOut)
  if (etagW !== 10 || dec.decode(etagOut.subarray(0, etagW)) !== b.etag(etagData)) {
    return false
  }
  const csrfOut = new Uint8Array(129)
  const csrfW = b.csrfTokenInto(enc.encode('csrf-secret'), csrfOut)
  if (csrfW !== 129 || csrfOut[64] !== 46 /* '.' */) {
    return false
  }

  // sign/verify cookie pooled Into: round-trip value bytes.
  const ckVal = enc.encode('session-value')
  const ckSec = enc.encode('s3cr3t-secret')
  const ckOut = new Uint8Array(256)
  const ckW = b.signCookieInto(ckVal, ckSec, ckOut)
  if (ckW !== ckVal.length + 65) {
    return false
  }
  const ckVerifyOut = new Uint8Array(256)
  const ckV = b.verifyCookieInto(ckOut.subarray(0, ckW), ckSec, ckVerifyOut)
  if (ckV !== ckVal.length || dec.decode(ckVerifyOut.subarray(0, ckV)) !== 'session-value') {
    return false
  }

  // urlEncode string form.
  if (b.urlEncode(enc.encode('a b/c')) !== 'a%20b%2Fc') {
    return false
  }
  // hexDecodeInto.
  const hdInto = new Uint8Array(8)
  if (
    b.hexDecodeInto(enc.encode('68656c6c6f'), hdInto) !== 5 ||
    dec.decode(hdInto.subarray(0, 5)) !== 'hello'
  ) {
    return false
  }
  // urlDecodeInto.
  const udInto = new Uint8Array(16)
  if (
    b.urlDecodeInto(enc.encode('a%20b%2Fc'), udInto) !== 5 ||
    dec.decode(udInto.subarray(0, 5)) !== 'a b/c'
  ) {
    return false
  }
  // base64EncodeInto.
  const b64Into = new Uint8Array(16)
  if (
    b.base64EncodeInto(SELFTEST_HEX, b64Into) !== 8 ||
    dec.decode(b64Into.subarray(0, 8)) !== 'aGVsbG8='
  ) {
    return false
  }
  // base64DecodeInto.
  const bdInto = new Uint8Array(8)
  if (
    b.base64DecodeInto(enc.encode('aGVsbG8='), bdInto) !== 5 ||
    dec.decode(bdInto.subarray(0, 5)) !== 'hello'
  ) {
    return false
  }
  // randomToken string form.
  if (!/^[0-9a-f]{32}$/.test(b.randomToken(16))) {
    return false
  }
  // hmacSha256Into (RFC 4231 test case 1 hex vector).
  const hmacInto = new Uint8Array(64)
  if (
    b.hmacSha256Into(hmacKey, hmacData, hmacInto) !== 64 ||
    dec.decode(hmacInto) !== 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
  ) {
    return false
  }
  // aeadEncryptInto → decrypt round-trip.
  const ctInto = new Uint8Array(64)
  const ctW = b.aeadEncryptInto(aeadKey, nonce, SELFTEST_HEX, ctInto, 0)
  if (ctW === 0 || b.aeadDecrypt(aeadKey, nonce, ctInto.subarray(0, ctW), 0) === null) {
    return false
  }

  return true
}
