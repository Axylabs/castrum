// index.ts — castrum package entry (barrel).
//
// Re-exports the full public API: the flat `rust.*` FFI surface
// (src/rust-ffi), the runtime selection hints (src/selection), and the
// higher-order loader (src/loader). See AGENTS.md for the layout map.
//
// EAGER-DLOPEN CONTRACT: this barrel unconditionally re-exports `src/ingress`
// → `src/ingress/constants.ts`, which is the ONE module that touches native at
// import time (it reads the Rust binary layout and runs the bind-time
// self-test). This is intentional — even `import { rust }` pays the eager
// load. Do NOT add more eager-native modules; keep everything else lazy (see
// test/unit/features/import-contract.test.ts).

export * from './src/rust-ffi'

// Native-vs-JS selection (OWNED HERE, not by consumers): `opImpl(op)` is the
// benchmark-driven recommendation for which operations should use the Rust
// addon vs a pure-JS implementation. Consumers read it once at load time and
// bind each op to a fixed impl. Source: rust/selection.rs (audited by
// `bun run check:selection`). See src/selection.ts.
export { opImpl, isNativeOp, opDecision } from './src/selection'
export type { OpImpl, OpDecision } from './src/selection'

export { encoder, decoder } from './src/shared/bytes'
// Bounded EWMA adaptive-estimate utility (drives BufferPool adaptive sizing
// and reusable runtime self-optimization decisions).
export { AdaptiveEstimate } from './src/shared/adaptive'
export type { AdaptiveEstimateOptions } from './src/shared/adaptive'
// UUIDv7 generation — delegates to Bun.randomUUIDv7, crypto.randomUUID on Node.
export { uuidv7 } from './src/shared/uuid'
// Zero-dep metrics registry (counters/gauges/histograms + Prometheus render).
export { createMetrics, DEFAULT_BUCKETS } from './src/shared/metrics'
export type { MetricsRegistry, Counter, Gauge, Histogram } from './src/shared/metrics'

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
} from './src/shared/packed'
export type { Pair, ParsedHttpRequestPacked } from './src/shared/packed'

export * from './src/ingress'

// Framework-agnostic integration helpers: run the ingress pipeline as a
// request stage (createPipeline), RFC 6455 upgrade (createWebSocketUpgrade),
// and SSE framing (sseResponse). See docs/INGRESS.md.
export * from './src/integration'

// Higher-order loader (HFC) over the curated op set: createLoader / loader
// dispatch single items, packed batches, and load() coalescing. See README.
export * from './src/loader'
