import { rust } from "./native";
import * as practical from "./shared-practical";
import { decoder, encoder } from "./shared-practical";
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

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${a}`);
    console.error(`  expected: ${b}`);
    process.exit(1);
  }
}

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
const hmacSig = practical.nativeHmacSha256(hmacKey, hmacData);

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

const crcInput = encoder.encode("Hello, practical CRC32 checksum test data!");

const mimeExt = encoder.encode("json");

const urlEncodeInput = encoder.encode("hello world & foo=bar");
const urlDecodeInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");

assertEqual(
  practical.nativeJsonValid(jsonPayload),
  rust.jsonValid(jsonPayload) === 1,
  "json valid",
);

assertEqual(
  practical.nativeJsonSum(jsonPayload),
  rust.jsonSumIds(jsonPayload),
  "json sum",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeHttpParseRequest(httpRaw))),
  JSON.parse(decoder.decode(rust.httpParseRequest(httpRaw))),
  "http parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeQueryParse(queryStr))),
  JSON.parse(decoder.decode(rust.queryParse(queryStr))),
  "query parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeCookieParse(cookieStr))),
  JSON.parse(decoder.decode(rust.cookieParse(cookieStr))),
  "cookie parse",
);

assertEqual(
  decoder.decode(practical.nativeWsAcceptKey(wsKey)),
  decoder.decode(rust.wsAcceptKey(wsKeyBytes)),
  "ws accept key",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeJsonPatch(jsonDoc, jsonPatch))),
  JSON.parse(decoder.decode(rust.jsonPatch(jsonDoc, jsonPatch))),
  "json patch",
);

assertEqual(
  decoder.decode(hmacSig),
  decoder.decode(rust.hmacSha256(hmacKey, hmacData)),
  "hmac sha256",
);

assertEqual(
  practical.nativeHmacSha256Verify(hmacKey, hmacData, hmacSig),
  rust.hmacSha256Verify(hmacKey, hmacData, hmacSig) === 1,
  "hmac verify",
);

assertDeepEqual(
  JSON.parse(
    decoder.decode(
      practical.nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")!,
    ),
  ),
  JSON.parse(decoder.decode(rust.routeMatch(routePattern, routePath))),
  "route match",
);

assertEqual(
  practical.nativeValidateEmail(emailOk),
  rust.validateEmail(emailOk) === 1,
  "email valid",
);

assertEqual(
  practical.nativeValidateUuid(uuidOk),
  rust.validateUuid(uuidOk) === 1,
  "uuid valid",
);

assertEqual(
  practical.nativeValidateIpv4(ipv4Ok),
  rust.validateIpv4(ipv4Ok) === 1,
  "ipv4 valid",
);

assertEqual(
  practical.nativeValidateIpv6(ipv6Ok),
  rust.validateIpv6(ipv6Ok) === 1,
  "ipv6 valid",
);

assertEqual(
  practical.nativeCrc32(crcInput),
  rust.crc32(crcInput),
  "crc32",
);

assertEqual(
  practical.nativeFnv1a64(crcInput),
  rust.fnv1a64(crcInput),
  "fnv1a64",
);

assertEqual(
  practical.nativeMimeFromExtension("json"),
  decoder.decode(rust.mimeFromExtension(mimeExt)),
  "mime",
);

assertEqual(
  practical.nativeUrlEncode("hello world & foo=bar"),
  decoder.decode(rust.urlEncode(urlEncodeInput)),
  "url encode",
);

assertEqual(
  practical.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"),
  decoder.decode(rust.urlDecode(urlDecodeInput)),
  "url decode",
);

console.log("Practical correctness checks passed. ✓");

const results: BenchResult[] = [];

function push(
  name: string,
  fn: () => unknown,
  iterations = 200,
  warmup = 20,
) {
  results.push(bench(name, fn, iterations, warmup));
}

push("native:json_valid", () => practical.nativeJsonValid(jsonPayload), 100, 10);
push("rust:json_valid", () => rust.jsonValid(jsonPayload), 100, 10);

push("native:json_sum", () => practical.nativeJsonSum(jsonPayload), 100, 10);
push("rust:json_sum", () => rust.jsonSumIds(jsonPayload), 100, 10);

push("native:http_parse", () => practical.nativeHttpParseRequest(httpRaw).byteLength, 500, 50);
push("rust:http_parse", () => rust.httpParseRequest(httpRaw).byteLength, 500, 50);

push("native:query_parse", () => practical.nativeQueryParse(queryStr).byteLength, 500, 50);
push("rust:query_parse", () => rust.queryParse(queryStr).byteLength, 500, 50);

push("native:cookie_parse", () => practical.nativeCookieParse(cookieStr).byteLength, 500, 50);
push("rust:cookie_parse", () => rust.cookieParse(cookieStr).byteLength, 500, 50);

push("native:random_token", () => practical.nativeRandomToken(32).byteLength, 1000, 100);
push("rust:random_token", () => rust.randomToken(32).byteLength, 1000, 100);

push("native:ws_accept_key", () => practical.nativeWsAcceptKey(wsKey).byteLength, 1000, 100);
push("rust:ws_accept_key", () => rust.wsAcceptKey(wsKeyBytes).byteLength, 1000, 100);

push("native:json_patch", () => practical.nativeJsonPatch(jsonDoc, jsonPatch).byteLength, 500, 50);
push("rust:json_patch", () => rust.jsonPatch(jsonDoc, jsonPatch).byteLength, 500, 50);

push("native:hmac_sha256", () => practical.nativeHmacSha256(hmacKey, hmacData).byteLength, 500, 50);
push("rust:hmac_sha256", () => rust.hmacSha256(hmacKey, hmacData).byteLength, 500, 50);

push("native:hmac_verify", () => practical.nativeHmacSha256Verify(hmacKey, hmacData, hmacSig) ? 1 : 0, 500, 50);
push("rust:hmac_verify", () => rust.hmacSha256Verify(hmacKey, hmacData, hmacSig), 500, 50);

push("native:route_match", () => practical.nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:route_match", () => rust.routeMatch(routePattern, routePath).byteLength, 500, 50);

push("native:validate_email", () => practical.nativeValidateEmail(emailOk) ? 1 : 0, 1000, 100);
push("rust:validate_email", () => rust.validateEmail(emailOk), 1000, 100);

push("native:validate_uuid", () => practical.nativeValidateUuid(uuidOk) ? 1 : 0, 1000, 100);
push("rust:validate_uuid", () => rust.validateUuid(uuidOk), 1000, 100);

push("native:validate_ipv4", () => practical.nativeValidateIpv4(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv4", () => rust.validateIpv4(ipv4Ok), 1000, 100);

push("native:validate_ipv6", () => practical.nativeValidateIpv6(ipv6Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv6", () => rust.validateIpv6(ipv6Ok), 1000, 100);

push("native:crc32", () => practical.nativeCrc32(crcInput), 1000, 100);
push("rust:crc32", () => rust.crc32(crcInput), 1000, 100);

push("native:fnv1a64", () => practical.nativeFnv1a64(crcInput), 1000, 100);
push("rust:fnv1a64", () => rust.fnv1a64(crcInput), 1000, 100);

push("native:mime", () => practical.nativeMimeFromExtension("json").length, 1000, 100);
push("rust:mime", () => rust.mimeFromExtension(mimeExt).byteLength, 1000, 100);

push("native:url_encode", () => practical.nativeUrlEncode("hello world & foo=bar").length, 1000, 100);
push("rust:url_encode", () => rust.urlEncode(urlEncodeInput).byteLength, 1000, 100);

push("native:url_decode", () => practical.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length, 1000, 100);
push("rust:url_decode", () => rust.urlDecode(urlDecodeInput).byteLength, 1000, 100);

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

report("JSON valid", "native:json_valid", "rust:json_valid");
report("JSON sum", "native:json_sum", "rust:json_sum");
report("HTTP parse", "native:http_parse", "rust:http_parse");
report("Query parse", "native:query_parse", "rust:query_parse");
report("Cookie parse", "native:cookie_parse", "rust:cookie_parse");
report("Random token", "native:random_token", "rust:random_token");
report("WebSocket accept", "native:ws_accept_key", "rust:ws_accept_key");
report("JSON Patch", "native:json_patch", "rust:json_patch");
report("HMAC sign", "native:hmac_sha256", "rust:hmac_sha256");
report("HMAC verify", "native:hmac_verify", "rust:hmac_verify");
report("Route match", "native:route_match", "rust:route_match");
report("Email validation", "native:validate_email", "rust:validate_email");
report("UUID validation", "native:validate_uuid", "rust:validate_uuid");
report("IPv4 validation", "native:validate_ipv4", "rust:validate_ipv4");
report("IPv6 validation", "native:validate_ipv6", "rust:validate_ipv6");
report("CRC32", "native:crc32", "rust:crc32");
report("FNV-1a 64", "native:fnv1a64", "rust:fnv1a64");
report("MIME lookup", "native:mime", "rust:mime");
report("URL encode", "native:url_encode", "rust:url_encode");
report("URL decode", "native:url_decode", "rust:url_decode");
