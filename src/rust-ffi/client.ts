import * as native from "../baseline";
import { createRawRustClient } from "./raw";
import { decoder, encoder } from "../shared/bytes";

const SMALL_CRC = 128;
const SMALL_UUID = 48;
const SMALL_URL = 96;

export function createHybridClient() {
  const r = createRawRustClient();

  return {
    ...r,

    crc32(bytes: Uint8Array): number {
      if (bytes.byteLength <= SMALL_CRC) {
        return native.nativeCrc32(bytes);
      }
      return r.crc32(bytes);
    },

    validateUuid(bytes: Uint8Array): number {
      if (bytes.byteLength <= SMALL_UUID) {
        return native.nativeValidateUuid(bytes) ? 1 : 0;
      }
      return r.validateUuid(bytes);
    },

    urlEncode(bytes: Uint8Array): Uint8Array {
      if (bytes.byteLength <= SMALL_URL) {
        try {
          return encoder.encode(encodeURIComponent(decoder.decode(bytes)));
        } catch {
          // fall through to Rust
        }
      }
      return r.urlEncode(bytes);
    },

    urlDecode(bytes: Uint8Array): Uint8Array {
      if (bytes.byteLength <= SMALL_URL) {
        try {
          return encoder.encode(decodeURIComponent(decoder.decode(bytes)));
        } catch {
          // fall through to Rust
        }
      }
      return r.urlDecode(bytes);
    },
  };
}

export type HybridClient = ReturnType<typeof createHybridClient>;