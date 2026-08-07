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
// implementation so existing imports (`rust`, `rustBatch`, `createRust`, all
// types) keep working unchanged.
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
//
// Back-compat alias (non-breaking):
//   rustBatch           === rust.batch

export { createRust, rust, rustBatch } from "./client";
export type { RustClient } from "./client";
export type { RustOptions } from "./options";
export type { RustText } from "./text";
export type { RustBatch } from "./batch";
export type { RustPacked } from "./packed";
export type { SchemaValidator } from "../shared/packed";
export type {
  HmacSignerInstance,
  SchemaValidatorInstance,
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
