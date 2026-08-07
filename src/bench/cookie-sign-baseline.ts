// src/bench/cookie-sign-baseline.ts — JS baseline for signed cookies.
// HMAC-SHA256 via node:crypto, `value.signature` hex format. Bench-local only.

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decoder, encoder } from "../shared/bytes";

/** Sign `value` as `value` ++ "." ++ lowercase-hex(HMAC-SHA256(secret, value)). */
export function nativeSignCookie(
  value: Uint8Array,
  secret: Uint8Array,
): Uint8Array {
  const sig = createHmac("sha256", Buffer.from(secret))
    .update(Buffer.from(value))
    .digest("hex");
  const out = new Uint8Array(value.byteLength + 1 + 64);
  out.set(value, 0);
  out[value.byteLength] = 46; // '.'
  out.set(encoder.encode(sig), value.byteLength + 1);
  return out;
}

/** Constant-time verify; returns the signed value or null on invalid. */
export function nativeVerifyCookie(
  signed: Uint8Array,
  secret: Uint8Array,
): Uint8Array | null {
  let dot = -1;
  for (let i = signed.length - 1; i >= 0; i--) {
    if (signed[i] === 46) {
      dot = i;
      break;
    }
  }
  if (dot === -1) return null;
  const value = signed.subarray(0, dot);
  const sigStr = decoder.decode(signed.subarray(dot + 1));
  const expected = createHmac("sha256", Buffer.from(secret))
    .update(Buffer.from(value))
    .digest();
  const provided = Buffer.from(sigStr, "hex");
  if (expected.length !== provided.length) return null;
  return timingSafeEqual(expected, provided) ? new Uint8Array(value) : null;
}
