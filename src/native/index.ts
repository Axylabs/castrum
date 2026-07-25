import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);


interface HttpRouterInstance {
  matchRoute(path: Buffer | string): number;
  matchRouteBatchPacked(packed: Buffer): Buffer;
}

function resolveAddonPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const platform = process.platform;
  const arch = process.arch;

  const candidates = [
    // 1. Standard napi-rs output in project root.
    join(__dirname, "..", "..", `rust_bench.${platform}-${arch}-gnu.node`),
    join(__dirname, "..", "..", `rust_bench.${platform}-${arch}-musl.node`),
    join(__dirname, "..", "..", `rust_bench.${platform}-${arch}.node`),
    join(__dirname, "..", "..", "rust_bench.node"),

    // 2. Fallback to target/release directory.
    join(
      __dirname,
      "..",
      "..",
      "target",
      "release",
      `rust_bench.${platform}-${arch}-gnu.node`,
    ),
    join(
      __dirname,
      "..",
      "..",
      "target",
      "release",
      `rust_bench.${platform}-${arch}-musl.node`,
    ),
    join(
      __dirname,
      "..",
      "..",
      "target",
      "release",
      `rust_bench.${platform}-${arch}.node`,
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find rust_bench native addon.\n` +
    `Run: bun run build\n` +
    `Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

interface NativeAddon {
  cookieParse(input: Uint8Array): Uint8Array;
  crc32(input: Uint8Array): number;
  fnv1a64(input: Uint8Array): bigint;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  hmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean;
  httpParseRequest(input: Uint8Array): Uint8Array;
  jsonValid(input: Uint8Array): boolean;
  jsonSumIds(input: Uint8Array): bigint;
  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array;
  mimeFromExtension(ext: Uint8Array): Uint8Array;
  queryParse(input: Uint8Array): Uint8Array;
  randomToken(byteLen: number): Uint8Array;
  urlEncode(input: Uint8Array): Uint8Array;
  urlDecode(input: Uint8Array): Uint8Array;
  validateEmail(input: Uint8Array): boolean;
  validateUuid(input: Uint8Array): boolean;
  validateIpv4(input: Uint8Array): boolean;
  validateIpv6(input: Uint8Array): boolean;
  wsAcceptKey(key: Uint8Array): Uint8Array;
  SchemaValidator: new (schema: Uint8Array) => SchemaValidatorInstance;
  HttpRouter: new (routes: string[]) => HttpRouterInstance;

  initThreadPool(rayonThreads?: number): void;
  rayonNumThreads(): number;

  jsonValidAsync(input: Uint8Array): Promise<number>;
  jsonSumIdsAsync(input: Uint8Array): Promise<bigint>;
  httpParseRequestAsync(input: Uint8Array): Promise<Uint8Array>;
  queryParseAsync(input: Uint8Array): Promise<Uint8Array>;
  cookieParseAsync(input: Uint8Array): Promise<Uint8Array>;

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
  httpParseRequestPackedInto(input: Uint8Array, output: Uint8Array): number;

  queryParsePacked(input: Uint8Array): Uint8Array;
  queryParsePackedInto(input: Uint8Array, output: Uint8Array): number;

  cookieParsePacked(input: Uint8Array): Uint8Array;
  cookieParsePackedInto(input: Uint8Array, output: Uint8Array): number;
  
  jsonValidBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  validateEmailBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  validateUuidBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  validateIpv4BatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  validateIpv6BatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  jsonSumBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  queryParseBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  cookieParseBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
  httpParseRequestBatchPackedAsync(input: Uint8Array): Promise<Uint8Array>;
}
const addonPath = resolveAddonPath();
const addon: NativeAddon = require(addonPath);

if (process.env.RUST_BENCH_DEBUG) {
  console.log("Native addon loaded from:", addonPath);
  console.log("Exported keys:", Object.keys(addon).sort());
}
interface SchemaValidatorInstance {
  validateBatch(batchBytes: Uint8Array): number;
  validateBatchPackedCount(packed: Uint8Array): number;
  validateBatchPackedBitset(packed: Uint8Array): Uint8Array;
  validateBatchStreaming(batchBytes: Uint8Array): number;
}
export default addon;
export { addonPath };

export type { HttpRouterInstance, SchemaValidatorInstance };