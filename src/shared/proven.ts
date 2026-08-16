// src/shared/proven.ts — baked "proven selection" registry (PURE DATA, no addon).
//
// The proven selection answers: "for op X, which implementation is the
// benchmark-proven winner, and is that what we wire as the default?"
//
//   - 'native' → the rust addon wins (bun:ffi on Bun / napi on Node)
//   - 'js'     → the pure-TS implementation wins
//   - 'bun'    → a Bun built-in wins UNDER BUN and is delegated there
//                (see src/runtime/builtins.ts)
//
// This is BAKED (committed), benchmark-derived data — the winners were
// measured by `scripts/select-native.ts` (the `nativeRatio` in
// `src/selection.json`) and the Bun built-in decision matrix
// (`docs/bun-builtins-decision-matrix.md`). It is PURE DATA: no addon import,
// no dlopen, no live benchmark audit. That live audit was the friction of the
// old `check:proven`/`check:annotate` machinery (flaky on noisy hosts) — it
// is intentionally NOT re-added. Instead `test/unit/shared/proven.test.ts`
// verifies every entry is wired to the impl it claims (`opImpl`, the Bun
// built-in registry, and the addon's embedded selection.json), so drift is
// caught deterministically instead of by re-running benchmarks.
//
// `typicalRatio` is the addon-vs-pure-TS-baseline ratio (rust faster = >1) for
// native/js entries, and the Bun-built-in-vs-addon ratio for 'bun' entries
// (higher = the built-in wins by more).

/** The benchmark-proven default implementation for an op. */
export type ProvenImpl = 'native' | 'js' | 'bun'

/** How decisive the baked winner is. */
export type ProvenStatus = 'proven' | 'parity' | 'unmeasured'

/** One entry in the baked proven-selection registry. */
export interface ProvenEntry {
  /** Selection op name (matches `opImpl(op)` / `src/selection.json` keys). */
  name: string
  /** The baked default implementation: the benchmark-proven winner. */
  impl: ProvenImpl
  /** `proven` = decisive win, `parity` = borderline, `unmeasured` = pinned by policy. */
  status: ProvenStatus
  /** Measured ratio behind the decision (see module doc for the axis). */
  typicalRatio?: number
  /** Why this classification. */
  note?: string
}

/**
 * Baked proven-winner registry. Covering the FULL selection surface
 * (`src/selection.json` ops + every Bun built-in delegation) so nothing can be
 * silently dropped. Classifications are based on release/perf-build results;
 * `test/unit/shared/proven.test.ts` re-checks them against the LIVE wiring.
 */
export const PROVEN_SELECTION: readonly ProvenEntry[] = [
  // ── Bun built-in delegation — 'bun' (wins under Bun; consumer binding = 'js') ──
  {
    name: 'crc32',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 4,
    note: 'Bun.hash.crc32 wins 2.8–8.4×; selection.json records js (0.659)',
  },
  {
    name: 'xxh3',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 4.15,
    note: 'Bun.hash.xxHash3 ~4.15×; addon kept as the Node / non-Bun path',
  },
  {
    name: 'hmacSha256',
    impl: 'bun',
    status: 'parity',
    typicalRatio: 1.2,
    note: 'Bun.CryptoHasher mild 1.1–1.4×; the addon still beats the pure-JS baseline (1.212)',
  },
  {
    name: 'randomToken',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 1.62,
    note: 'Bun.randomUUIDv7 / crypto.getRandomValues for token-sized output',
  },
  {
    name: 'gzipCompress',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 2.02,
    note: 'Bun.gzipSync ~2×; gzipDecompress deliberately NOT delegated (64 MiB bomb cap)',
  },
  {
    name: 'urlEncode',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 11.5,
    note: 'encodeURIComponent ~11.5×, zero alloc',
  },
  {
    name: 'urlDecode',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 6,
    note: 'decodeURIComponent ~4–8×',
  },
  {
    name: 'base64Encode',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 2,
    note: 'Buffer.toString("base64") ~2×; url-safe / unpadded fall through to native',
  },
  {
    name: 'base64UrlEncode',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 2,
    note: 'Buffer.toString("base64url")',
  },
  {
    name: 'hexEncode',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 1.35,
    note: 'Buffer.toString("hex")',
  },
  {
    name: 'httpDate',
    impl: 'bun',
    status: 'proven',
    typicalRatio: 3.7,
    note: 'Date.toUTCString() ~3.7×',
  },

  // ── Native winners — 'native' (addon beats the pure-TS baseline) ──
  { name: 'fnv1a64', impl: 'native', status: 'proven', typicalRatio: 12.603 },
  { name: 'hmacSha256Verify', impl: 'native', status: 'proven', typicalRatio: 9.028 },
  { name: 'signCookie', impl: 'native', status: 'proven', typicalRatio: 3.64 },
  { name: 'verifyCookie', impl: 'native', status: 'proven', typicalRatio: 1.772 },
  { name: 'csrfToken', impl: 'native', status: 'proven', typicalRatio: 12.671 },
  { name: 'csrfVerify', impl: 'native', status: 'proven', typicalRatio: 12.458 },
  {
    name: 'passwordHash',
    impl: 'native',
    status: 'proven',
    typicalRatio: 1.657,
    note: 'argon2id — rust ~1.83× vs Bun.password at equal cost; never delegate',
  },
  {
    name: 'passwordVerify',
    impl: 'native',
    status: 'proven',
    typicalRatio: 1.88,
    note: 'argon2id verify — rust wins; no representative pure-TS baseline (pinned)',
  },
  { name: 'aeadEncrypt', impl: 'native', status: 'proven', typicalRatio: 1.288 },
  {
    name: 'aeadDecrypt',
    impl: 'native',
    status: 'parity',
    typicalRatio: 1.108,
    note: 'borderline — kept native',
  },
  { name: 'createAcceptNegotiator', impl: 'native', status: 'proven', typicalRatio: 2.01 },
  {
    name: 'gzipDecompress',
    impl: 'native',
    status: 'proven',
    typicalRatio: 61.039,
    note: 'deliberately NOT delegated — Bun.gunzipSync has no bomb cap; native 64 MiB cap kept',
  },
  {
    name: 'brotliCompress',
    impl: 'native',
    status: 'proven',
    typicalRatio: 9.983,
    note: 'no synchronous Bun API',
  },
  {
    name: 'brotliDecompress',
    impl: 'native',
    status: 'proven',
    typicalRatio: 33.327,
    note: 'no synchronous Bun API',
  },
  {
    name: 'jwtSign',
    impl: 'native',
    status: 'unmeasured',
    note: 'pinned native — constant-time canonical (not pure-perf)',
  },
  {
    name: 'jwtVerify',
    impl: 'native',
    status: 'unmeasured',
    note: 'pinned native — constant-time canonical',
  },
  {
    name: 'createTemplate',
    impl: 'native',
    status: 'unmeasured',
    note: 'pinned native — compiled-once instance',
  },
  {
    name: 'createSchemaValidator',
    impl: 'native',
    status: 'unmeasured',
    note: 'pinned native — compiled-once instance',
  },

  // ── JS winners — 'js' (pure-TS beats the addon) ──
  { name: 'queryPairs', impl: 'js', status: 'proven', typicalRatio: 0.279 },
  { name: 'cookiePairs', impl: 'js', status: 'proven', typicalRatio: 0.105 },
  { name: 'formPairs', impl: 'js', status: 'proven', typicalRatio: 0.328 },
  { name: 'etag', impl: 'js', status: 'proven', typicalRatio: 0.187 },
  { name: 'parseMediaType', impl: 'js', status: 'proven', typicalRatio: 0.378 },
  { name: 'parseAcceptEncoding', impl: 'js', status: 'proven', typicalRatio: 0.367 },
  { name: 'createConditionalRequest', impl: 'js', status: 'proven', typicalRatio: 0.275 },
  {
    name: 'multipartParse',
    impl: 'js',
    status: 'unmeasured',
    note: 'no ratio recorded — JS baseline kept',
  },
  {
    name: 'jsonValid',
    impl: 'js',
    status: 'parity',
    typicalRatio: 0.749,
    note: 'borderline — JSON.parse wins',
  },
  {
    name: 'jsonPatch',
    impl: 'js',
    status: 'proven',
    typicalRatio: 0.014,
    note: 'custom JSON.patch beats the addon at small sizes',
  },
  { name: 'sseEncode', impl: 'js', status: 'proven', typicalRatio: 0.586 },
  { name: 'wsFrameEncode', impl: 'js', status: 'proven', typicalRatio: 0.152 },
  {
    name: 'wsFrameDecode',
    impl: 'js',
    status: 'parity',
    typicalRatio: 0.988,
    note: 'parity boundary — JS baseline kept',
  },
  { name: 'wsAcceptKey', impl: 'js', status: 'parity', typicalRatio: 0.939 },
  { name: 'validateEmail', impl: 'js', status: 'proven', typicalRatio: 0.007 },
  { name: 'validateUuid', impl: 'js', status: 'proven', typicalRatio: 0.008 },
  { name: 'validateIpv4', impl: 'js', status: 'proven', typicalRatio: 0.012 },
  { name: 'validateIpv6', impl: 'js', status: 'proven', typicalRatio: 0.078 },
  { name: 'createRateLimiter', impl: 'js', status: 'proven', typicalRatio: 0.061 },
  { name: 'renderTemplate', impl: 'js', status: 'proven', typicalRatio: 0.141 },
] as const satisfies readonly ProvenEntry[]

const INDEX = new Map<string, ProvenEntry>(PROVEN_SELECTION.map((e) => [e.name, e]))

/**
 * The baked {@link ProvenEntry} for `op`, or `undefined` for unknown ops.
 * Pure data — never dlopens the addon.
 */
export function provenEntry(op: string): ProvenEntry | undefined {
  return INDEX.get(op)
}

/** The baked default implementation for `op` (`native` / `js` / `bun`), or `null`. */
export function provenImpl(op: string): ProvenImpl | null {
  return INDEX.get(op)?.impl ?? null
}

/** The baked status for `op`, or `null` for unknown ops. */
export function provenStatus(op: string): ProvenStatus | null {
  return INDEX.get(op)?.status ?? null
}

/** Whether the op's baked winner is a decisive (`proven`) win. */
export function isProven(op: string): boolean {
  return INDEX.get(op)?.status === 'proven'
}

/** The full baked registry (same array as {@link PROVEN_SELECTION}). */
export function provenSurface(): readonly ProvenEntry[] {
  return PROVEN_SELECTION
}

/** A one-line summary of the baked selection (counts per implementation). */
export function provenSummary(): string {
  const byImpl = { native: 0, js: 0, bun: 0 }
  for (const e of PROVEN_SELECTION) byImpl[e.impl] += 1
  return `proven selection: ${byImpl.native} native, ${byImpl.js} js, ${byImpl.bun} bun built-in (${PROVEN_SELECTION.length} ops)`
}
