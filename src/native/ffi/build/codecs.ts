// src/native/ffi/build/codecs.ts — hashing / codec / crypto / auth BunFFI methods.
//
// Checksums, JSON/UTF-8 validity, hex + percent codecs, base64, HMAC, cookie
// signing, CSRF, random tokens, password hashing, PBKDF2, AEAD, and the
// cstring-based ws accept key + ETag. Receives the raw dlopen'd symbols and
// the per-bind context (argument adapters + pooled scratch) from `build()`.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import type { BunFFI, Raw3, Raw4, Raw5, Raw6, Raw8, Raw9, Raw10, RawCStr } from '../types'
import type { BuildCtx } from './util'
import { allocOut, argon2PhcLength, cstr, flag, growExact, hasNul, writeOrThrow } from './util'

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
  const validateEmailBytes = sym.castrum_validate_email_bytes as (
    ...a: unknown[]
  ) => number | bigint
  const validateUuidBytes = sym.castrum_validate_uuid_bytes as (...a: unknown[]) => number | bigint
  const validateIpv4Bytes = sym.castrum_validate_ipv4_bytes as (...a: unknown[]) => number | bigint
  const validateIpv6Bytes = sym.castrum_validate_ipv6_bytes as (...a: unknown[]) => number | bigint
  const jsonSumRaw = sym.castrum_json_sum_ids as Raw4
  const hexBatchRaw = sym.castrum_hex_validate_batch as Raw5
  const hexBatchStrRaw = sym.castrum_hex_validate_batch_str as Raw4
  const regexEscapeRaw = sym.castrum_regex_escape as Raw4
  const regexEscapeStrRaw = sym.castrum_regex_escape_str as RawCStr
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

    // Verdict guards: the `cstring` form would truncate at an embedded NUL, so
    // `"a@b.com\0<script>"` would be reported VALID — a verdict callers act on.
    // No address / UUID / IP contains U+0000, so short-circuit without an FFI
    // call (one `indexOf` scan, far cheaper than the encode fallback).
    validateEmail: (input) => !hasNul(input) && Number(validateEmail(input)) === 1,
    validateUuid: (input) => !hasNul(input) && Number(validateUuid(input)) === 1,
    validateIpv4: (input) => !hasNul(input) && Number(validateIpv4(input)) === 1,
    validateIpv6: (input) => !hasNul(input) && Number(validateIpv6(input)) === 1,
    // Byte-input validators: `(ptr,len)` — zero transcode (no CString decode
    // + engine re-encode like the cstring-ARG string forms above).
    validateEmailBytes: (input) => Number(oneArg(validateEmailBytes, input)) === 1,
    validateUuidBytes: (input) => Number(oneArg(validateUuidBytes, input)) === 1,
    validateIpv4Bytes: (input) => Number(oneArg(validateIpv4Bytes, input)) === 1,
    validateIpv6Bytes: (input) => Number(oneArg(validateIpv6Bytes, input)) === 1,
    hexValidateBatchInto(input, width, output) {
      // Batch fixed-width hex validation: NEWLINE-separated lines in; one
      // verdict byte (1/0) per line out. Needed-size convention: `0` = bad
      // width / null pointers (real error → throw); `> output.length` = the
      // exact required size (caller grows once and retries). Width is
      // validated here so an empty input can't mask it.
      if (width === 0 || width > 4096) {
        throw new Error('hex validate batch: width must be 1..=4096')
      }
      const w = Number(hexBatchRaw(input, lenOrView(input), width >>> 0, output, lenOrView(output)))
      return w
    },
    regexEscapeInto(input, output) {
      const w = Number(regexEscapeRaw(input, lenOrView(input), output, lenOrView(output)))
      if (w === 0) {
        throw new Error('regex escape: output buffer too small')
      }
      return w
    },
    // Zero-copy text path: cstring ARG in (engine-transcoded), cstring return
    // out (engine-cloned) — the JS side does zero encode AND zero decode. A NUL
    // would truncate the INPUT, so that case routes to the `(ptr,len)` sibling
    // (exact length) instead of returning a silently shortened string.
    regexEscapeStr: (input) => {
      if (!hasNul(input)) return regexEscapeStrRaw(input)
      const bytes = encodeUtf8(input)
      const escaped = growExact(
        (out) => Number(regexEscapeRaw(bytes, lenOrView(bytes), out, lenOrView(out))),
        16,
        1 << 20,
        'regex escape: output buffer too small',
      )
      return decodeUtf8(escaped)
    },
    hexValidateBatchStr(ids, width, output) {
      if (width === 0 || width > 4096) {
        throw new Error('hex validate batch: width must be 1..=4096')
      }
      // A NUL in the joined ids would truncate the line list, so a bad id could
      // pass as its own prefix. Fall back to the byte form (exact length).
      if (hasNul(ids)) {
        const bytes = encodeUtf8(ids)
        return Number(hexBatchRaw(bytes, lenOrView(bytes), width >>> 0, output, lenOrView(output)))
      }
      const w = Number(hexBatchStrRaw(ids, width >>> 0, output, lenOrView(output)))
      return w
    },
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
      const out = allocOut(Math.floor(input.length / 2))
      const w = hexDecodeInto(input, out)
      return out.subarray(0, w)
    },
    hexDecodeInto,
    urlDecode(input) {
      const out = allocOut(input.length)
      const w = urlDecodeInto(input, out)
      return out.subarray(0, w)
    },
    urlDecodeInto,
    base64Decode(input, urlSafe, padding) {
      const out = allocOut(Math.ceil((input.length * 3) / 4))
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
      const out = allocOut(64)
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
      const out = allocOut(dk)
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
      const out = allocOut(plaintext.length + 16)
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
      const out = allocOut(ciphertext.length)
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
