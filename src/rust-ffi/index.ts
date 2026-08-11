// src/rust-ffi/index.ts — Flat, complete public API for the Rust utilities.
//
// Barrel module. The implementation is decomposed into task-focused modules:
//   - options.ts   RustOptions + input-normalization helpers
//   - addon.ts     shared lazy addon proxy
//   - context.ts   per-instance state + shared namespace helpers
//   - scalar.ts    scalar/feature methods
//   - text.ts      string namespace
//   - batch.ts     array-of-bytes namespace
//   - packed.ts    raw packed-wire namespace
//   - client.ts    createRust() factory + default `rust` instance
//
// This barrel re-exports the exact public surface of the original single-file
// implementation so existing imports (`rust`, `createRust`, all types) keep
// working unchanged. The deprecated `rustBatch` alias was removed — use
// `rust.batch` instead.
//
//   import { rust } from "castrum";
//
//   rust.crc32(bytes);                    // number
//   rust.fnv1a64(bytes);                  // bigint
//   rust.jsonValid(bytes);                // boolean
//   rust.text.mimeFromExtension(".js");   // "text/javascript"
//   rust.text.urlEncode("a b");           // "a%20b"
//   rust.batch.jsonValid(docs);           // Uint8Array bitset
//   rust.packed.jsonValidBatchPacked(p);  // raw packed in/out
//   rust.configure({ rayonThreads: 8 });  // override defaults

export { createRust, rust } from "./client";
export type { RustClient } from "./client";
export type { RustOptions } from "./options";
export type { RustText } from "./text";
export type { RustBatch } from "./batch";
export type { RustPacked } from "./packed";
export type { SchemaValidator } from "../shared/packed";
export type {
  HmacSignerInstance,
  SchemaValidatorInstance,
  SchemaError,
  TemplateRendererInstance,
  FormParserInstance,
  MediaTypeParserInstance,
  MediaTypeResult,
  ConditionalRequestInstance,
  EncodingPrefResult,
  AcceptNegotiatorInstance,
  Base64CodecInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  UrlBuilderInstance,
  MultipartPart,
  PasswordHashOptions,
  WsFrame,
} from "../native";
