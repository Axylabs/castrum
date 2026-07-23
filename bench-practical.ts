// bench-practical.ts
import { rust } from "./native";
import * as practical from "./shared-practical";
import { decoder, encoder } from "./shared";
import { jsonRowsBytes } from "./data";

type BenchResult = {
  name: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec: number;
  checksum: string;
};

function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000;
}

function bench(
  name: string,
  fn: () => unknown,
  iterations = 100,
  warmup = 10,
): BenchResult {
  let checksum = 0n;

  const consume = (v: unknown) => {
    if (typeof v === "bigint") checksum += v;
    else if (typeof v === "number") checksum += BigInt(Math.trunc(v));
    else if (typeof v === "boolean") checksum += v ? 1n : 0n;
    else if (typeof v === "string") checksum += BigInt(v.length);
    else if (v instanceof Uint8Array) {
      checksum += BigInt(v.byteLength);
      checksum += BigInt(v[0] ?? 0);
    } else if (v != null) checksum += 1n;
  };

  for (let i = 0; i < warmup; i++) consume(fn());

  const samples: number[] = new Array(iterations);

  for (let i = 0; i < iterations; i++) {
    const start = nowMs();
    consume(fn());
    samples[i] = nowMs() - start;
  }

  samples.sort((a, b) => a - b);

  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / iterations;

  return {
    name,
    iterations,
    avgMs: avg,
    p50Ms: samples[Math.floor(iterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(iterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${String(actual)}`);
    console.error(`  expected: ${String(expected)}`);
    process.exit(1);
  }
}

function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);

  const sorted: Record<string, any> = {};

  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }

  return sorted;
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${a}`);
    console.error(`  expected: ${b}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jsonPayload = jsonRowsBytes(5_000);

const httpRaw = encoder.encode(
  "GET /api/users?page=1&limit=20 HTTP/1.1\r\n" +
    "Host: example.com\r\n" +
    "Accept: application/json\r\n" +
    "Authorization: Bearer token\r\n" +
    "Cookie: sid=abc; theme=dark\r\n" +
    "\r\n",
);

const queryStr = encoder.encode(
  "name=John+Doe&age=30&tags[]=a&tags[]=b&empty=&enc=%20hi%20",
);

const cookieStr = encoder.encode("session=abc123; theme=dark; lang=en-US");

const hmacKey = encoder.encode("super-secret-key-2026");
const hmacData = encoder.encode("message to sign with HMAC-SHA256");
const hmacSig = practical.nativeHmacSha256V2(hmacKey, hmacData);

const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
const wsKeyBytes = encoder.encode(wsKey);

const jsonDoc = encoder.encode(JSON.stringify({ a: 1, b: { c: 2 } }));
const jsonPatch = encoder.encode(
  JSON.stringify([{ op: "replace", path: "/a", value: 42 }]),
);

const routePattern = encoder.encode("/users/:id/posts/:postId");
const routePath = encoder.encode("/users/42/posts/7");

const emailOk = encoder.encode("user@example.com");
const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
const ipv4Ok = encoder.encode("192.168.1.100");
const ipv6Ok = encoder.encode("2001:db8::1");
const luhnOk = encoder.encode("4532015112830366");

const crcInput = encoder.encode("Hello, practical CRC32 checksum test data!");
const mimeExt = encoder.encode("json");

const urlEncodeInput = encoder.encode("hello world & foo=bar");
const urlDecodeInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");

// ---------------------------------------------------------------------------
// Correctness checks
// ---------------------------------------------------------------------------

assertEqual(
  practical.nativeJsonValidV2(jsonPayload),
  rust.jsonValidV2(jsonPayload) === 1,
  "v2 json valid",
);

assertEqual(
  practical.nativeJsonSumV2(jsonPayload),
  rust.jsonSumIdsV2(jsonPayload),
  "v2 json sum",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeHttpParseRequestV2(httpRaw))),
  JSON.parse(decoder.decode(rust.httpParseRequestV2(httpRaw))),
  "v2 http parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeQueryParseV2(queryStr))),
  JSON.parse(decoder.decode(rust.queryParseV2(queryStr))),
  "v2 query parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeCookieParseV2(cookieStr))),
  JSON.parse(decoder.decode(rust.cookieParseV2(cookieStr))),
  "v2 cookie parse",
);

assertEqual(
  decoder.decode(practical.nativeWsAcceptKeyV2(wsKey)),
  decoder.decode(rust.wsAcceptKeyV2(wsKeyBytes)),
  "v2 ws accept key",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeJsonPatchV2(jsonDoc, jsonPatch))),
  JSON.parse(decoder.decode(rust.jsonPatchV2(jsonDoc, jsonPatch))),
  "v2 json patch",
);

assertEqual(
  practical.nativeHmacSha256VerifyV2(hmacKey, hmacData, hmacSig),
  rust.hmacSha256VerifyV2(hmacKey, hmacData, hmacSig) === 1,
  "v2 hmac verify",
);

assertDeepEqual(
  JSON.parse(
    decoder.decode(
      practical.nativeRouteMatchV2("/users/:id/posts/:postId", "/users/42/posts/7")!,
    ),
  ),
  JSON.parse(decoder.decode(rust.routeMatchV2(routePattern, routePath))),
  "v2 route match",
);

assertEqual(
  practical.nativeValidateEmailV2(emailOk),
  rust.validateEmailV2(emailOk) === 1,
  "v2 email valid",
);

assertEqual(
  practical.nativeValidateUuidV2(uuidOk),
  rust.validateUuidV2(uuidOk) === 1,
  "v2 uuid valid",
);

assertEqual(
  practical.nativeValidateIpv4V2(ipv4Ok),
  rust.validateIpv4V2(ipv4Ok) === 1,
  "v2 ipv4 valid",
);

assertEqual(
  practical.nativeValidateIpv6V2(ipv6Ok),
  rust.validateIpv6V2(ipv6Ok) === 1,
  "v2 ipv6 valid",
);

assertEqual(
  practical.nativeValidateLuhnV2(luhnOk),
  true,
  "v2 luhn valid",
);

assertEqual(
  practical.nativeCrc32V2(crcInput),
  rust.crc32V2(crcInput),
  "v2 crc32",
);

assertEqual(
  practical.nativeFnv1a64V2(crcInput),
  rust.fnv1a64V2(crcInput),
  "v2 fnv1a64",
);

assertEqual(
  practical.nativeMimeFromExtensionV2("json"),
  decoder.decode(rust.mimeFromExtensionV2(mimeExt)),
  "v2 mime",
);

assertEqual(
  practical.nativeUrlEncodeV2("hello world & foo=bar"),
  decoder.decode(rust.urlEncodeV2(urlEncodeInput)),
  "v2 url encode",
);

assertEqual(
  practical.nativeUrlDecodeV2("hello%20world%20%26%20foo%3Dbar"),
  decoder.decode(rust.urlDecodeV2(urlDecodeInput)),
  "v2 url decode",
);

console.log("Practical correctness checks passed. ✓");

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

const results: BenchResult[] = [];

function push(
  name: string,
  fn: () => unknown,
  iterations = 200,
  warmup = 20,
) {
  results.push(bench(name, fn, iterations, warmup));
}

push("native:v2:json_valid", () => practical.nativeJsonValidV2(jsonPayload), 100, 10);
push("rust:v2:json_valid", () => rust.jsonValidV2(jsonPayload), 100, 10);

push("native:v2:json_sum", () => practical.nativeJsonSumV2(jsonPayload), 100, 10);
push("rust:v2:json_sum", () => rust.jsonSumIdsV2(jsonPayload), 100, 10);

push("native:v2:http_parse", () => practical.nativeHttpParseRequestV2(httpRaw).byteLength, 500, 50);
push("rust:v2:http_parse", () => rust.httpParseRequestV2(httpRaw).byteLength, 500, 50);

push("native:v2:query_parse", () => practical.nativeQueryParseV2(queryStr).byteLength, 500, 50);
push("rust:v2:query_parse", () => rust.queryParseV2(queryStr).byteLength, 500, 50);

push("native:v2:cookie_parse", () => practical.nativeCookieParseV2(cookieStr).byteLength, 500, 50);
push("rust:v2:cookie_parse", () => rust.cookieParseV2(cookieStr).byteLength, 500, 50);

push("native:v2:random_token", () => practical.nativeRandomTokenV2(32).byteLength, 1000, 100);
push("rust:v2:random_token", () => rust.randomTokenV2(32).byteLength, 1000, 100);

push("native:v2:ws_accept_key", () => practical.nativeWsAcceptKeyV2(wsKey).byteLength, 1000, 100);
push("rust:v2:ws_accept_key", () => rust.wsAcceptKeyV2(wsKeyBytes).byteLength, 1000, 100);

push("native:v2:json_patch", () => practical.nativeJsonPatchV2(jsonDoc, jsonPatch).byteLength, 500, 50);
push("rust:v2:json_patch", () => rust.jsonPatchV2(jsonDoc, jsonPatch).byteLength, 500, 50);

push("native:v2:hmac_verify", () => practical.nativeHmacSha256VerifyV2(hmacKey, hmacData, hmacSig) ? 1 : 0, 500, 50);
push("rust:v2:hmac_verify", () => rust.hmacSha256VerifyV2(hmacKey, hmacData, hmacSig), 500, 50);

push("native:v2:route_match", () => practical.nativeRouteMatchV2("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:v2:route_match", () => rust.routeMatchV2(routePattern, routePath).byteLength, 500, 50);

push("native:v2:validate_email", () => practical.nativeValidateEmailV2(emailOk) ? 1 : 0, 1000, 100);
push("rust:v2:validate_email", () => rust.validateEmailV2(emailOk), 1000, 100);

push("native:v2:validate_uuid", () => practical.nativeValidateUuidV2(uuidOk) ? 1 : 0, 1000, 100);
push("rust:v2:validate_uuid", () => rust.validateUuidV2(uuidOk), 1000, 100);

push("native:v2:validate_ipv4", () => practical.nativeValidateIpv4V2(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:v2:validate_ipv4", () => rust.validateIpv4V2(ipv4Ok), 1000, 100);

push("native:v2:validate_ipv6", () => practical.nativeValidateIpv6V2(ipv6Ok) ? 1 : 0, 1000, 100);
push("rust:v2:validate_ipv6", () => rust.validateIpv6V2(ipv6Ok), 1000, 100);

push("native:v2:crc32", () => practical.nativeCrc32V2(crcInput), 1000, 100);
push("rust:v2:crc32", () => rust.crc32V2(crcInput), 1000, 100);

push("native:v2:fnv1a64", () => practical.nativeFnv1a64V2(crcInput), 1000, 100);
push("rust:v2:fnv1a64", () => rust.fnv1a64V2(crcInput), 1000, 100);

push("native:v2:mime", () => practical.nativeMimeFromExtensionV2("json").length, 1000, 100);
push("rust:v2:mime", () => rust.mimeFromExtensionV2(mimeExt).byteLength, 1000, 100);

push("native:v2:url_encode", () => practical.nativeUrlEncodeV2("hello world & foo=bar").length, 1000, 100);
push("rust:v2:url_encode", () => rust.urlEncodeV2(urlEncodeInput).byteLength, 1000, 100);

push("native:v2:url_decode", () => practical.nativeUrlDecodeV2("hello%20world%20%26%20foo%3Dbar").length, 1000, 100);
push("rust:v2:url_decode", () => rust.urlDecodeV2(urlDecodeInput).byteLength, 1000, 100);

console.table(
  results.map((r) => ({
    name: r.name,
    iters: r.iterations,
    "avg ms": r.avgMs.toFixed(4),
    "p50 ms": r.p50Ms.toFixed(4),
    "p95 ms": r.p95Ms.toFixed(4),
    "ops/s": r.opsPerSec.toFixed(1),
    checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
  })),
);

function report(label: string, nativeName: string, rustName: string): void {
  const n = results.find((x) => x.name === nativeName);
  const r = results.find((x) => x.name === rustName);

  if (!n || !r) return;

  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);

  if (ratio >= 1) {
    console.log(
      `${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    );
  } else {
    console.log(
      `${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    );
  }
}

console.log("\n═══ Practical Summary ═══");

report("JSON valid", "native:v2:json_valid", "rust:v2:json_valid");
report("JSON sum", "native:v2:json_sum", "rust:v2:json_sum");
report("HTTP parse", "native:v2:http_parse", "rust:v2:http_parse");
report("Query parse", "native:v2:query_parse", "rust:v2:query_parse");
report("Cookie parse", "native:v2:cookie_parse", "rust:v2:cookie_parse");
report("Random token", "native:v2:random_token", "rust:v2:random_token");
report("WebSocket accept", "native:v2:ws_accept_key", "rust:v2:ws_accept_key");
report("JSON Patch", "native:v2:json_patch", "rust:v2:json_patch");
report("HMAC verify", "native:v2:hmac_verify", "rust:v2:hmac_verify");
report("Route match", "native:v2:route_match", "rust:v2:route_match");
report("Email validation", "native:v2:validate_email", "rust:v2:validate_email");
report("UUID validation", "native:v2:validate_uuid", "rust:v2:validate_uuid");
report("IPv4 validation", "native:v2:validate_ipv4", "rust:v2:validate_ipv4");
report("IPv6 validation", "native:v2:validate_ipv6", "rust:v2:validate_ipv6");
report("CRC32", "native:v2:crc32", "rust:v2:crc32");
report("FNV-1a 64", "native:v2:fnv1a64", "rust:v2:fnv1a64");
report("MIME lookup", "native:v2:mime", "rust:v2:mime");
report("URL encode", "native:v2:url_encode", "rust:v2:url_encode");
report("URL decode", "native:v2:url_decode", "rust:v2:url_decode");