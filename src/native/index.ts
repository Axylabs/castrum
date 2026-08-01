import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface IngressInstance {
  handleRequestPacked(
    input: Uint8Array,
    body: Uint8Array | null,
    output: Uint8Array,
  ): number;

  handleRequestFullSync(
    methodKind: number,
    url: string,
    ip: string,
    requestId: string,
    headers: Array<[string, string]>,
    body: Uint8Array | null,
    outputBufferSize?: number,
  ): Uint8Array;
}

function resolveAddonPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const platform = process.platform;
  const arch = process.arch;
  const base = join(__dirname, "..", "..");

  // napi-rs artifact naming: castrum.<platform>-<arch>[-<libc>].node
  // e.g. linux-x64-gnu, linux-x64-musl, win32-x64-msvc, darwin-arm64.
  const libcVariants =
    platform === "win32"
      ? ["msvc", "gnu"]
      : platform === "linux"
        ? ["gnu", "musl"]
        : [""];

  const names = libcVariants.map(
    (libc) => `castrum.${platform}-${arch}${libc ? `-${libc}` : ""}.node`,
  );
  names.push("castrum.node");

  const roots = [base, join(base, "target", "release")];

  const candidates: string[] = [];
  for (const root of roots) {
    for (const name of names) {
      candidates.push(join(root, name));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find castrum native addon.\n` +
      `Run: bun run build\n` +
      `Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

interface NativeAddon {
  HmacSigner: new (key: Uint8Array) => HmacSignerInstance;
  Ingress: new (options: Record<string, unknown>) => IngressInstance;

  // ── Ingress binary-layout constants (single source of truth: rust/ingress_constants.rs) ──
  INGRESS_OUT_VERDICT: number;
  INGRESS_OUT_ERROR_CODE: number;
  INGRESS_OUT_STATUS: number;
  INGRESS_OUT_FLAGS: number;
  INGRESS_OUT_RATE_LIMIT: number;
  INGRESS_OUT_RATE_REMAINING: number;
  INGRESS_OUT_RATE_RESET: number;
  INGRESS_OUT_RETRY_AFTER: number;
  INGRESS_OUT_COOKIES_JSON_LEN: number;
  INGRESS_OUT_QUERY_JSON_LEN: number;
  INGRESS_OUT_HEADER_VARIANT: number;
  INGRESS_OUT_BODY_JSON_LEN: number;
  INGRESS_OUT_DATA_START: number;
  INGRESS_FLAG_HAS_COOKIES: number;
  INGRESS_FLAG_HAS_QUERY: number;
  INGRESS_FLAG_BODY_VALID_JSON: number;
  INGRESS_FLAG_SCHEMA_VALID: number;
  INGRESS_FLAG_CORS_ALLOWED: number;
  INGRESS_FLAG_IS_PREFLIGHT: number;
  INGRESS_FLAG_RATE_LIMITED: number;
  INGRESS_FLAG_HTTPS: number;
  INGRESS_FLAG_TRUSTED_PROXY: number;
  INGRESS_FLAG_BODY_TRUNCATED: number;
  INGRESS_HV_JSON: number;
  INGRESS_HV_CORS_SIMPLE: number;
  INGRESS_HV_CORS_PREFLIGHT: number;
  INGRESS_HV_RATE_ACTIVE: number;
  INGRESS_HV_RATE_LIMITED: number;
  INGRESS_HV_COUNT: number;
  INGRESS_ERR_NONE: number;
  INGRESS_ERR_CORS_PREFLIGHT: number;
  INGRESS_ERR_RATE_LIMITED: number;
  INGRESS_ERR_BODY_TOO_LARGE: number;
  INGRESS_ERR_INVALID_JSON: number;
  INGRESS_ERR_SCHEMA_VALIDATION: number;
  INGRESS_ERR_BAD_REQUEST: number;
  INGRESS_ERR_REQUEST_TOO_LARGE: number;
  INGRESS_ERR_INTERNAL: number;

  crc32(input: Uint8Array): number;
  fnv1a64(input: Uint8Array): bigint;

  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean;

  jsonValid(input: Uint8Array): boolean;
  jsonSumIds(input: Uint8Array): bigint;

  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;

  mimeFromExtension(ext: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;

  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  urlDecodeBytes(input: Uint8Array): Uint8Array;

  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;

  wsAcceptKey(key: Uint8Array): Uint8Array;

  SchemaValidator: new (schema: Uint8Array) => SchemaValidatorInstance;

  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  jsonValidBatchPacked(input: Uint8Array): Uint8Array;
  validateEmailBatchPacked(input: Uint8Array): Uint8Array;
  validateUuidBatchPacked(input: Uint8Array): Uint8Array;
  validateIpv4BatchPacked(input: Uint8Array): Uint8Array;
  validateIpv6BatchPacked(input: Uint8Array): Uint8Array;

  jsonSumBatchPacked(input: Uint8Array): Uint8Array;
  queryParseBatchPacked(input: Uint8Array): Uint8Array;
  cookieParseBatchPacked(input: Uint8Array): Uint8Array;
  httpParseRequestBatchPacked(input: Uint8Array): Uint8Array;

  httpParseRequestPacked(input: Uint8Array): Uint8Array;

  queryParsePacked(input: Uint8Array): Uint8Array;

  cookieParsePacked(input: Uint8Array): Uint8Array;

  crc32BatchPacked(input: Uint8Array): Uint8Array;

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

const addonPath = resolveAddonPath();

let addon: NativeAddon;
try {
  addon = require(addonPath);
} catch (err) {
  const cause = err instanceof Error ? `\n  Underlying cause: ${err.message}` : "";
  throw new Error(
    `Failed to load castrum native addon from:\n  ${addonPath}\n` +
      `The addon exists but could not be loaded (ABI mismatch, missing system ` +
      `libraries, or a corrupt/partial artifact).\n` +
      `Run: bun run build\n` +
      `If the problem persists, verify the binary was built for this platform/CPU.` +
      cause,
  );
}

if (process.env.CASTRUM_DEBUG || process.env.RUST_BENCH_DEBUG) {
  console.log("Native addon loaded from:", addonPath);
  console.log("Exported keys:", Object.keys(addon).sort());
}

export interface SchemaValidatorInstance {
  validateBatchPackedCount(packed: Uint8Array): number;
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array;
  validateBatchStreaming(batchBytes: Uint8Array): number;
}

export interface HmacSignerInstance {
  sign(data: Uint8Array): Uint8Array;
  verify(data: Uint8Array, sig: Uint8Array): boolean;
}

export default addon;
export { addonPath };