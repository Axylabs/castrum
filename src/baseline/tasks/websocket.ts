import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { decoder, encoder, toPlainBuffer } from "../../shared/bytes";

export function nativeWsAcceptKey(key: string | Uint8Array): Uint8Array {
  const keyText = typeof key === "string" ? key : decoder.decode(key);
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(keyText + magic);

  // node:crypto is available in BOTH runtimes and is synchronous — unlike
  // Bun.CryptoHasher, which throws a ReferenceError under Node.js.
  const hash = createHash("sha1").update(toPlainBuffer(combined)).digest();

  return encoder.encode(Buffer.from(hash).toString("base64"));
}
