export * from "./src/rust-ffi";

// Performance-proven surface: only `rust.*` functions that beat their JS
// baseline in benchmarks. See src/shared/proven.ts for the registry.
export {
  proven,
  PROVEN_SURFACE,
  provenStatus,
  isProven,
  provenSurface,
  provenSummary,
} from "./src/rust-ffi/proven";
export type { ProvenClient, ProvenKey } from "./src/rust-ffi/proven";
export type { PerformanceStatus, ProvenEntry } from "./src/shared/proven";

export { encoder, decoder } from "./src/shared/bytes";

export {
  packBatch,
  packPairs,
  readPairsPacked,
  readHttpPacked,
  pairsToObject,
  parseQueryString,
  parseCookieHeader,
  parseFormBody,
  unpackBitset,
  unpackByteResults,
  unpackI64ArrayAsBigInt,
  unpackU32Array,
} from "./src/shared/packed";
export type { Pair, ParsedHttpRequestPacked } from "./src/shared/packed";

export * from "./src/ingress";