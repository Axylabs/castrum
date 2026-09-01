// src/rust-ffi/index.ts — Flat, complete public API for the Rust utilities.
//
// Barrel module. The implementation is decomposed into task-focused modules:
//   - options.ts   RustOptions + input-normalization helpers
//   - addon.ts     shared lazy addon proxy
//   - context.ts   per-instance state + shared namespace helpers
//   - scalar/      scalar/feature methods (hashing, json, http, crypto, payload, factories)
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

export type {
  AcceptNegotiatorInstance,
  Base64CodecInstance,
  ConditionalRequestInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  EncodingPrefResult,
  FormParserInstance,
  HmacSignerInstance,
  MediaTypeParserInstance,
  MediaTypeResult,
  MetricsRegistryInstance,
  MultipartPart,
  PasswordHashOptions,
  SchemaError,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  UrlBuilderInstance,
  WsFrame,
} from '../native'
export type { SchemaValidator } from '../shared/packed'
export type { ProvenEntry, ProvenImpl, ProvenStatus } from '../shared/proven'
export {
  isProven,
  PROVEN_SELECTION,
  provenEntry,
  provenImpl,
  provenStatus,
  provenSummary,
  provenSurface,
} from '../shared/proven'
export type { RustBatch } from './batch'
export type { RustClient } from './client'
export { createRust, rust } from './client'
export type { RustOptions } from './options'
export type { RustPacked } from './packed'
export { proven } from './proven'
export type { RustText } from './text'
