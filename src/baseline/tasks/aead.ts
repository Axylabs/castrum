import { createCipheriv, createDecipheriv, type CipherGCM, type DecipherGCM } from "node:crypto";

const TAG_LEN = 16;

/** JS baseline AEAD encrypt → ciphertext+tag (matches `rust.aeadEncrypt`). */
export function nativeAeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  algorithm?: string | null,
): Uint8Array {
  const alg = algorithm ?? "aes-256-gcm";
  const cipher = createCipheriv(alg, Buffer.from(key), Buffer.from(nonce)) as CipherGCM;
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([ct, tag]));
}

/** JS baseline AEAD decrypt (ciphertext+tag) → plaintext, or null on auth failure. */
export function nativeAeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  algorithm?: string | null,
): Uint8Array | null {
  const alg = algorithm ?? "aes-256-gcm";
  const ct = Buffer.from(ciphertext);
  if (ct.length < TAG_LEN) return null;

  const body = ct.subarray(0, ct.length - TAG_LEN);
  const tag = ct.subarray(ct.length - TAG_LEN);

  const decipher = createDecipheriv(alg, Buffer.from(key), Buffer.from(nonce)) as DecipherGCM;
  decipher.setAuthTag(tag);

  try {
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
}
