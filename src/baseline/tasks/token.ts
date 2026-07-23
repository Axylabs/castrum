import { Buffer } from "node:buffer";
import { encoder } from "../../shared/bytes";

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return encoder.encode(Buffer.from(bytes).toString("hex"));
}
