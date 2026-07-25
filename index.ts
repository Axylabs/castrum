export {
  rust,
  createRustClient,
} from "./src/rust-ffi";

export type { RustClient } from "./src/rust-ffi";

export * as native from "./src/baseline";

export { encoder, decoder } from "./src/shared/bytes";

export {
  packBatch,
  unpackBitset,
  unpackByteResults,
  unpackI32Array,
  unpackI64ArrayAsBigInt,
} from "./src/shared/packed";

export { jsonRowsBytes, createJsonRows } from "./src/data/json-rows";
export type { JsonRow } from "./src/data/json-rows";