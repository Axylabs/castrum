import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decoder, encoder } from "../../shared/bytes";

export function nativeHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const hex = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest("hex");

  return encoder.encode(hex);
}

export function nativeHmacSha256Verify(
  key: Uint8Array,
  data: Uint8Array,
  sig: Uint8Array,
): boolean {
  const expected = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest();

  const providedHex = decoder.decode(sig).trim();

  if (!/^[0-9a-fA-F]*$/.test(providedHex)) {
    return false;
  }

  const provided = Buffer.from(providedHex, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
