// src/rust-ffi/index.ts — Flat, complete public API for the Rust utilities.
//
// This is the SINGLE implementation module for all Rust FFI functions. It wraps
// the raw NAPI addon directly (no intermediate wrapper layer), exposes every
// native function with normalized, easy-to-consume types, and selects optimized
// defaults that can be overridden per-instance via createRust() or on the
// shared `rust` instance via rust.configure().
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

import addon, {
  type HmacSignerInstance,
  type SchemaValidatorInstance,
} from "../native";
import { decoder, encoder } from "../shared/bytes";
import {
  packBatch,
  schemaValidateBatch,
  schemaValidateBatchCount,
  unpackBitset,
  unpackByteResults,
  unpackI64ArrayAsBigInt,
  unpackU32Array,
  type SchemaValidator,
} from "../shared/packed";

export type { HmacSignerInstance, SchemaValidatorInstance };
export type { SchemaValidator };

// ── Options & defaults ─────────────────────────────────────────

export interface RustOptions {
  /**
   * Rayon thread pool size.
   *
   * The rayon pool is process-wide and initialized **once** (native
   * `OnceLock`) — the first initialization wins. Importing this module
   * initializes the pool with defaults, so this option only takes effect when
   * the pool has not yet been created. For reliable control set
   * `CASTRUM_RAYON_THREADS` / `RUST_RAYON_THREADS` before import.
   * Default: max(1, hardwareConcurrency - 1).
   */
  rayonThreads?: number;
  /** Cache MIME lookups keyed by normalized extension. Default: true. */
  mimeCache?: boolean;
  /** Reuse HMAC signers keyed by key-buffer identity. Default: true. */
  hmacCache?: boolean;
}

const FALLBACK_CORES = 4;

function resolveRayonThreads(explicit?: number): number {
  const cores = navigator.hardwareConcurrency || FALLBACK_CORES;

  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(cores, Math.floor(explicit)));
  }

  const envThreads = Number(
    process.env.CASTRUM_RAYON_THREADS ??
      process.env.RUST_BENCH_RAYON_THREADS ??
      process.env.RUST_RAYON_THREADS,
  );

  if (Number.isFinite(envThreads) && envThreads > 0) {
    return Math.max(1, Math.min(cores, Math.floor(envThreads)));
  }

  return Math.max(1, cores - 1);
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value);
  }

  throw new TypeError(
    `Expected bigint-compatible value, got ${typeof value}: ${String(value)}`,
  );
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }

  return 0;
}

function normalizeExt(ext: Uint8Array): string {
  let s: string;

  try {
    s = decoder.decode(ext);
  } catch {
    return "";
  }

  if (s.charCodeAt(0) === 46) {
    s = s.slice(1);
  }

  return s.toLowerCase();
}

// ── Namespace types ────────────────────────────────────────────

export interface RustText {
  mimeFromExtension(ext: string): string;
  urlEncode(input: string): string;
  urlDecode(input: string): string;
  wsAcceptKey(key: string): string;
  validateEmail(input: string): boolean;
  validateUuid(input: string): boolean;
  validateIpv4(input: string): boolean;
  validateIpv6(input: string): boolean;
}

export interface RustBatch {
  jsonValid(items: Uint8Array[]): Uint8Array;
  crc32(items: Uint8Array[]): Uint32Array;
  validateEmail(items: Uint8Array[]): Uint8Array;
  validateUuid(items: Uint8Array[]): Uint8Array;
  validateIpv4(items: Uint8Array[]): Uint8Array;
  validateIpv6(items: Uint8Array[]): Uint8Array;
  jsonSumIds(items: Uint8Array[]): BigInt64Array;
  queryParse(items: Uint8Array[]): Uint8Array[];
  cookieParse(items: Uint8Array[]): Uint8Array[];
  httpParseRequest(items: Uint8Array[]): Uint8Array[];
  schemaValidate(validator: SchemaValidator, items: Uint8Array[]): Uint8Array;
  schemaValidateCount(validator: SchemaValidator, items: Uint8Array[]): number;
}

export interface RustPacked {
  // ── Sync batch (packed in → packed out) ──
  crc32BatchPacked(input: Uint8Array): Uint8Array;
  jsonValidBatchPacked(input: Uint8Array): Uint8Array;
  validateEmailBatchPacked(input: Uint8Array): Uint8Array;
  validateUuidBatchPacked(input: Uint8Array): Uint8Array;
  validateIpv4BatchPacked(input: Uint8Array): Uint8Array;
  validateIpv6BatchPacked(input: Uint8Array): Uint8Array;
  jsonSumBatchPacked(input: Uint8Array): Uint8Array;
  queryParseBatchPacked(input: Uint8Array): Uint8Array;
  cookieParseBatchPacked(input: Uint8Array): Uint8Array;
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array;

  // ── Batch metadata / counts ──
  jsonValidBatchCountPacked(input: Uint8Array): number;
  validateEmailBatchCountPacked(input: Uint8Array): number;
  validateUuidBatchCountPacked(input: Uint8Array): number;
  validateIpv4BatchCountPacked(input: Uint8Array): number;
  validateIpv6BatchCountPacked(input: Uint8Array): number;
  jsonSumBatchTotalPacked(input: Uint8Array): number;
  queryParseBatchTotalLenPacked(input: Uint8Array): number;
  cookieParseBatchTotalLenPacked(input: Uint8Array): number;
  httpParseRequestBatchTotalLenPacked(input: Uint8Array): number;
}

export interface RustClient {
  // ── Scalar utilities (bytes in → normalized out) ──
  crc32(input: Uint8Array): number;
  fnv1a64(input: Uint8Array): bigint;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha256Verify(
    key: Uint8Array,
    data: Uint8Array,
    sig: Uint8Array,
  ): boolean;
  jsonValid(input: Uint8Array): boolean;
  jsonSumIds(input: Uint8Array): bigint;
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
  mimeFromExtension(ext: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;
  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  /** Strict percent-decode without UTF-8 validation. */
  urlDecodeBytes(input: Uint8Array): Uint8Array;
  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;
  wsAcceptKey(key: Uint8Array): Uint8Array;

  // ── Low-level / packed scalar ──
  httpParseRequestPacked(input: Uint8Array): Uint8Array;
  queryParsePacked(input: Uint8Array): Uint8Array;
  cookieParsePacked(input: Uint8Array): Uint8Array;

  // ── Factories / runtime ──
  createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance;
  createHmacSigner(key: Uint8Array): HmacSignerInstance;
  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  // ── Namespaces ──
  text: RustText;
  batch: RustBatch;
  packed: RustPacked;

  // ── Configuration ──
  /**
   * Update defaults on this instance. `mimeCache` / `hmacCache` apply
   * immediately (per-instance). `rayonThreads` is applied only if the
   * process-wide pool is not yet initialized (see {@link RustOptions}).
   */
  configure(options: RustOptions): void;
}

// ── Implementation ─────────────────────────────────────────────

/**
 * Create an isolated Rust client with the given defaults.
 *
 * `mimeCache` / `hmacCache` are per-instance. `rayonThreads` only applies
 * before the process-wide rayon pool is initialized (once per process — see
 * {@link RustOptions.rayonThreads}); the pool defaults to the env var or
 * `max(1, hardwareConcurrency - 1)` otherwise.
 */
export function createRust(options: RustOptions = {}): RustClient {
  const mimeByText = new Map<string, Uint8Array>();
  const hmacSigners = new WeakMap<Uint8Array, HmacSignerInstance>();
  const state = {
    mimeCache: options.mimeCache !== false,
    hmacCache: options.hmacCache !== false,
  };

  // ── Lazy rayon pool initialization ─────────────────────────────
  // The native rayon pool is a process-wide OnceLock: the FIRST call wins.
  // We therefore defer init until the first batch/packed operation so that
  // rust.configure({ rayonThreads }) called at startup actually takes effect
  // (previously the pool was initialized eagerly at module load, silently
  // ignoring later rayonThreads tuning).
  let poolInitialized = false;
  let pendingThreads = options.rayonThreads;

  function ensurePool(): void {
    if (poolInitialized) return;
    poolInitialized = true;
    addon.initThreadPool(resolveRayonThreads(pendingThreads));
  }

  // Any access to a rayon-backed namespace triggers pool init exactly once.
  function withPoolInit<T extends object>(target: T): T {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        ensurePool();
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  function cachedMime(ext: Uint8Array): Uint8Array {
    if (!state.mimeCache) {
      return addon.mimeFromExtension(ext);
    }

    const key = normalizeExt(ext);

    let val = mimeByText.get(key);
    if (!val) {
      val = addon.mimeFromExtension(ext);
      mimeByText.set(key, val);
    }

    // Return a copy so callers cannot mutate cached bytes.
    return val.slice();
  }

  function hmacSigner(key: Uint8Array): HmacSignerInstance {
    if (!state.hmacCache) {
      return new addon.HmacSigner(key);
    }

    let signer = hmacSigners.get(key);

    if (!signer) {
      signer = new addon.HmacSigner(key);
      hmacSigners.set(key, signer);
    }

    return signer;
  }

  const text: RustText = {
    mimeFromExtension(ext) {
      return decoder.decode(cachedMime(encoder.encode(ext)));
    },
    urlEncode(input) {
      return decoder.decode(addon.urlEncode(encoder.encode(input)));
    },
    urlDecode(input) {
      return decoder.decode(addon.urlDecode(encoder.encode(input)));
    },
    wsAcceptKey(key) {
      return decoder.decode(addon.wsAcceptKey(encoder.encode(key)));
    },
    validateEmail(input) {
      return addon.validateEmail(encoder.encode(input));
    },
    validateUuid(input) {
      return addon.validateUuid(encoder.encode(input));
    },
    validateIpv4(input) {
      return addon.validateIpv4(encoder.encode(input));
    },
    validateIpv6(input) {
      return addon.validateIpv6(encoder.encode(input));
    },
  };

  const batch: RustBatch = withPoolInit<RustBatch>({
    jsonValid(items) {
      return unpackBitset(addon.jsonValidBatchPacked(packBatch(items)));
    },
    crc32(items) {
      return unpackU32Array(addon.crc32BatchPacked(packBatch(items)));
    },
    validateEmail(items) {
      return unpackBitset(addon.validateEmailBatchPacked(packBatch(items)));
    },
    validateUuid(items) {
      return unpackBitset(addon.validateUuidBatchPacked(packBatch(items)));
    },
    validateIpv4(items) {
      return unpackBitset(addon.validateIpv4BatchPacked(packBatch(items)));
    },
    validateIpv6(items) {
      return unpackBitset(addon.validateIpv6BatchPacked(packBatch(items)));
    },
    jsonSumIds(items) {
      return unpackI64ArrayAsBigInt(addon.jsonSumBatchPacked(packBatch(items)));
    },
    queryParse(items) {
      return unpackByteResults(addon.queryParseBatchPacked(packBatch(items)));
    },
    cookieParse(items) {
      return unpackByteResults(addon.cookieParseBatchPacked(packBatch(items)));
    },
    httpParseRequest(items) {
      return unpackByteResults(
        addon.httpParseRequestBatchPacked(packBatch(items)),
      );
    },
    schemaValidate(validator, items) {
      return schemaValidateBatch(validator, items);
    },
    schemaValidateCount(validator, items) {
      return schemaValidateBatchCount(validator, items);
    },
  });

  const packed: RustPacked = withPoolInit<RustPacked>({
    crc32BatchPacked(input) {
      return addon.crc32BatchPacked(input);
    },
    jsonValidBatchPacked(input) {
      return addon.jsonValidBatchPacked(input);
    },
    validateEmailBatchPacked(input) {
      return addon.validateEmailBatchPacked(input);
    },
    validateUuidBatchPacked(input) {
      return addon.validateUuidBatchPacked(input);
    },
    validateIpv4BatchPacked(input) {
      return addon.validateIpv4BatchPacked(input);
    },
    validateIpv6BatchPacked(input) {
      return addon.validateIpv6BatchPacked(input);
    },
    jsonSumBatchPacked(input) {
      return addon.jsonSumBatchPacked(input);
    },
    queryParseBatchPacked(input) {
      return addon.queryParseBatchPacked(input);
    },
    cookieParseBatchPacked(input) {
      return addon.cookieParseBatchPacked(input);
    },
    httpParseRequestBatchPacked(input) {
      return addon.httpParseRequestBatchPacked(input);
    },

    jsonValidBatchCountPacked(input) {
      return asNumber(addon.jsonValidBatchCountPacked(input));
    },
    validateEmailBatchCountPacked(input) {
      return asNumber(addon.validateEmailBatchCountPacked(input));
    },
    validateUuidBatchCountPacked(input) {
      return asNumber(addon.validateUuidBatchCountPacked(input));
    },
    validateIpv4BatchCountPacked(input) {
      return asNumber(addon.validateIpv4BatchCountPacked(input));
    },
    validateIpv6BatchCountPacked(input) {
      return asNumber(addon.validateIpv6BatchCountPacked(input));
    },
    jsonSumBatchTotalPacked(input) {
      return asNumber(addon.jsonSumBatchTotalPacked(input));
    },
    queryParseBatchTotalLenPacked(input) {
      return asNumber(addon.queryParseBatchTotalLenPacked(input));
    },
    cookieParseBatchTotalLenPacked(input) {
      return asNumber(addon.cookieParseBatchTotalLenPacked(input));
    },
    httpParseRequestBatchTotalLenPacked(input) {
      return asNumber(addon.httpParseRequestBatchTotalLenPacked(input));
    },
  });

  const client: RustClient = {
    // ── Scalar ──
    crc32(bytes) {
      return asNumber(addon.crc32(bytes) as unknown) >>> 0;
    },
    fnv1a64(bytes) {
      return asBigInt(addon.fnv1a64(bytes) as unknown);
    },
    hmacSha256(key, data) {
      return hmacSigner(key).sign(data);
    },
    hmacSha256Verify(key, data, sig) {
      return hmacSigner(key).verify(data, sig);
    },
    jsonValid(bytes) {
      return addon.jsonValid(bytes);
    },
    jsonSumIds(bytes) {
      return asBigInt(addon.jsonSumIds(bytes) as unknown);
    },
    jsonPatch(doc, patch) {
      return addon.jsonPatch(doc, patch);
    },
    mimeFromExtension(ext) {
      return cachedMime(ext);
    },
    randomToken(byteLen) {
      return addon.randomToken(byteLen);
    },
    urlEncode(bytes) {
      return addon.urlEncode(bytes);
    },
    urlDecode(bytes) {
      return addon.urlDecode(bytes);
    },
    urlDecodeBytes(bytes) {
      return addon.urlDecodeBytes(bytes);
    },
    validateEmail(bytes) {
      return addon.validateEmail(bytes);
    },
    validateUuid(bytes) {
      return addon.validateUuid(bytes);
    },
    validateIpv4(bytes) {
      return addon.validateIpv4(bytes);
    },
    validateIpv6(bytes) {
      return addon.validateIpv6(bytes);
    },
    wsAcceptKey(key) {
      return addon.wsAcceptKey(key);
    },

    // ── Low-level / packed scalar ──
    httpParseRequestPacked(bytes) {
      return addon.httpParseRequestPacked(bytes);
    },
    queryParsePacked(bytes) {
      return addon.queryParsePacked(bytes);
    },
    cookieParsePacked(bytes) {
      return addon.cookieParsePacked(bytes);
    },

    // ── Factories / runtime ──
    createSchemaValidator(schema) {
      return new addon.SchemaValidator(schema);
    },
    createHmacSigner(key) {
      return new addon.HmacSigner(key);
    },
    initThreadPool(threads) {
      // Explicit user call also establishes the pool state locally.
      poolInitialized = true;
      if (threads !== undefined) pendingThreads = threads;
      return addon.initThreadPool(threads);
    },
    rayonNumThreads() {
      return asNumber(addon.rayonNumThreads() as unknown);
    },

    // ── Namespaces ──
    text,
    batch,
    packed,

    // ── Configuration ──
    configure(next) {
      // rayonThreads only takes effect BEFORE the pool is first used.
      if (next.rayonThreads !== undefined && !poolInitialized) {
        pendingThreads = next.rayonThreads;
      }

      if (next.mimeCache !== undefined) {
        state.mimeCache = next.mimeCache;
      }

      if (next.hmacCache !== undefined) {
        state.hmacCache = next.hmacCache;
      }
    },
  };

  return client;
}

// ── Default instance (optimized defaults) ─────────────────────

export const rust = createRust();

// ── Back-compat alias (non-breaking) ───────────────────────────

/** @deprecated Use `rust.batch` (same object). */
export const rustBatch = rust.batch;