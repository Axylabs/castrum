import { rust } from "./native";
import {
  batchBytes, hashBytes, jsonRowsBytes, productAddBytes, productIdBytes, taskBytes, urlBytes,
} from "./data";
import {
  decoder, encoder,
  nativeBatchBytes, nativeHashU64, nativeJsonSum, nativeJsonValid,
  nativePrimeCount, nativeProductsAddBytes, nativeProductsGetIdBytes,
  nativeSha256U64, nativeTaskProcess, nativeUrlSumHostLens,
  nativeHttpParseRequest, nativeQueryParse, nativeCookieParse,
  nativeRouteMatch,
  nativeValidateEmail, nativeValidateUuid, nativeValidateIpv4, nativeValidateLuhn,
  nativeHmacSha256, nativeBase64Encode, nativeBase64Decode,
  nativeGzipCompress, nativeGzipDecompress,
  nativeHtmlEscape, nativeSlugify, nativeTemplateRender,
  nativeJsonSortBy, nativeJsonPaginate, nativeJsonAggregate, nativeJsonGroupBy, nativeJsonDedup,
  nativeCrc32, nativeFnv1a64,
  nativeMimeFromExtension, nativePathNormalize, nativePathIsSafe,
  nativeHttpResponseBuild, nativeErrorResponse,
  nativeWsFrameParse, nativeWsFrameBuild,
  nativeLogFormat, nativeHistogramBucket,
  nativeContentNegotiate,
  nativeJsonExtract, nativeJsonFlatten, nativeJsonMerge,
  nativeTextSearchCount, nativeBinarySearch,
  nativeFormatBytes, nativeEtagGenerate,
  nativeUrlEncode, nativeUrlDecode,
  nativeCookieSerialize, nativeMultipartParse, nativeCorsHeaders, nativeRateLimitCheck

} from "./shared";

type BenchResult = {
  name: string; iterations: number; avgMs: number;
  p50Ms: number; p95Ms: number; opsPerSec: number; checksum: string;
};

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
function nowMs(): number { return Bun.nanoseconds() / 1_000_000; }

function bench(name: string, fn: () => unknown, iterations = 50, warmup = 5): BenchResult {
  let checksum = 0n;
  const consume = (v: unknown) => {
    if (typeof v === "bigint") checksum += v;
    else if (typeof v === "number") checksum += BigInt(Math.trunc(v));
    else if (typeof v === "boolean") checksum += v ? 1n : 0n;
    else if (typeof v === "string") checksum += BigInt(v.length);
    else if (v instanceof Uint8Array) { checksum += BigInt(v.byteLength); checksum += BigInt(v[0] ?? 0); }
    else if (v != null) checksum += 1n;
  };
  for (let i = 0; i < warmup; i++) consume(fn());
  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const s = nowMs(); consume(fn()); samples[i] = nowMs() - s;
  }
  samples.sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / iterations;
  return {
    name, iterations, avgMs: avg,
    p50Ms: samples[Math.floor(iterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(iterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}\n  actual:   ${String(actual)}\n  expected: ${String(expected)}`);
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
    console.error(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${b}`);
    process.exit(1);
  }
}

// ── config ──
const JSON_ROWS = envInt("JSON_ROWS", 5_000);
const BATCH_OPS = envInt("BATCH_OPS", 200);
const URL_ROWS = envInt("URL_ROWS", 2_000);
const HASH_BYTES = envInt("HASH_BYTES", 100_000);
const PRIME_LIMIT = envInt("PRIME_LIMIT", 1_000_000);
const TASK_EVENTS = envInt("TASK_EVENTS", 5_000);

const jsonPayload = jsonRowsBytes(JSON_ROWS);
const addPayload = productAddBytes();
const idPayload = productIdBytes("123");
const batchPayload = batchBytes(BATCH_OPS);
const urlPayload = urlBytes(URL_ROWS);
const hashPayload = hashBytes(HASH_BYTES);
const taskPayload = taskBytes(TASK_EVENTS);

const outSmall = new Uint8Array(64 * 1024);
const outLarge = new Uint8Array(2 * 1024 * 1024);
const status = new Uint16Array(1);
// Multipart payload
const multipartBoundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
const multipartBody = encoder.encode(
  `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n` +
  `Content-Disposition: form-data; name="field1"\r\n\r\n` +
  `value1\r\n` +
  `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n` +
  `Content-Disposition: form-data; name="file"; filename="test.txt"\r\n` +
  `Content-Type: text/plain\r\n\r\n` +
  `Hello World\r\n` +
  `------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`
);
const multipartBoundaryBytes = encoder.encode(multipartBoundary);

// Rate limit state buffer (16 bytes: 8 for f64 tokens, 8 for u64 last_refill_ms)
const rateLimitState = new Uint8Array(16);
const rateLimitView = new DataView(rateLimitState.buffer);
rateLimitView.setFloat64(0, 10.0, true); // tokens
rateLimitView.setBigUint64(8, BigInt(Date.now() - 1000), true); // last refill 1 sec ago

// ── extra test payloads ──
const httpRaw = encoder.encode("GET /api/users?page=1&limit=20 HTTP/1.1\r\nHost: example.com\r\nAccept: application/json\r\nAuthorization: Bearer tok\r\nCookie: sid=abc; theme=dark\r\n\r\n");
const queryStr = encoder.encode("name=John+Doe&age=30&tags[]=a&tags[]=b&empty=&enc=%20hi%20");
const cookieStr = encoder.encode("session=abc123; theme=dark; lang=en-US");
const emailOk = encoder.encode("user@example.com");
const emailBad = encoder.encode("invalid@@email");
const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
const uuidBad = encoder.encode("not-a-uuid-at-all-12345678901234567");
const ipv4Ok = encoder.encode("192.168.1.100");
const ipv4Bad = encoder.encode("999.999.999.999");
const luhnOk = encoder.encode("4532015112830366");
const luhnBad = encoder.encode("1234567890123456");
const htmlIn = encoder.encode('<script>alert("xss")</script> & <b>bold</b>');
const slugIn = encoder.encode("Hello World! This is a Test -- 2026");
const hmacKey = encoder.encode("super-secret-key-2026");
const hmacData = encoder.encode("message to sign with HMAC-SHA256");
const b64Input = encoder.encode("The quick brown fox jumps over the lazy dog");
const gzipInput = hashBytes(50_000);
const smallJsonArr = encoder.encode(JSON.stringify([
  { id: 1, name: "alice", active: true, score: 90 },
  { id: 2, name: "bob", active: false, score: 75 },
  { id: 3, name: "alice", active: true, score: 85 },
  { id: 1, name: "alice", active: true, score: 90 },
]));
const sortedArr = encoder.encode(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i * 3)));
const searchCorpus = encoder.encode("the quick brown fox jumps over the lazy dog the fox");
const searchTerm = encoder.encode("fox");
const crcInput = encoder.encode("Hello, CRC32 checksum test data!");
const pathIn = encoder.encode("/api/v1/../v2/./users/../../admin");
const mimeIn = encoder.encode("json");
const acceptHdr = encoder.encode("text/html, application/json;q=0.9, */*;q=0.1");
const availTypes = encoder.encode("application/json, text/html, text/plain");
const wsPayload = encoder.encode("Hello WebSocket!");
const nestedJson = encoder.encode(JSON.stringify({ user: { name: "Alice", address: { city: "NYC", zip: "10001" } }, scores: [95, 87] }));
const extractPath = encoder.encode("user.address.city");
const jsonDoc1 = encoder.encode(JSON.stringify({ a: 1, b: 2, c: 3 }));
const jsonDoc2 = encoder.encode(JSON.stringify({ b: 20, d: 4 }));
const etagBody = encoder.encode("some response body content for etag");
const respBody = encoder.encode(JSON.stringify({ ok: true }));
const respCT = encoder.encode("application/json");
const respExtra = encoder.encode("X-Request-Id: abc-123\r\n");
const errMsg = encoder.encode("Resource not found");
const errCode = encoder.encode("NOT_FOUND");
const logLevel = encoder.encode("INFO");
const logMsg = encoder.encode("Request completed");
const logCtx = encoder.encode(JSON.stringify({ method: "GET", path: "/api", status: 200 }));
const logReqId = encoder.encode("req-abc-123");
const routePattern = encoder.encode("/users/:id/posts/:postId");
const routePath = encoder.encode("/users/42/posts/7");
const urlEncInput = encoder.encode("hello world & foo=bar");
const urlDecInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");
const templateStr = "Hello {{name}}, welcome to {{place}}! You have {{count}} messages.";
const templateData = encoder.encode(JSON.stringify({ name: "Alice", place: "Wonderland", count: 42 }));
const pipelineData = encoder.encode(JSON.stringify({ name: "widget", price: 9.99, category: "tools" }));
const pipelineOps = encoder.encode(JSON.stringify([
  { op: "uppercase_field", field: "name" },
  { op: "add_field", field: "tax", value: 0.08 },
  { op: "rename_field", field: "category", new_name: "group" },
]));



// ── correctness checks ──
assertEqual(nativeJsonSum(jsonPayload), rust.jsonSumIds(jsonPayload), "json sum");
assertEqual(nativeJsonValid(jsonPayload), true, "native json valid");
assertEqual(rust.jsonValid(jsonPayload), 1, "rust json valid");
assertEqual(rust.jsonValid(encoder.encode("{bad")), 0, "rust json invalid");
assertEqual(nativeUrlSumHostLens(urlPayload), rust.urlSumHostLens(urlPayload), "url host sum");
assertEqual(nativePrimeCount(PRIME_LIMIT), rust.primeCount(PRIME_LIMIT), "prime count");
assertEqual(nativeSha256U64(hashPayload), rust.sha256(hashPayload), "sha256");

// HTTP parsing
assertDeepEqual(JSON.parse(decoder.decode(nativeHttpParseRequest(httpRaw))), JSON.parse(decoder.decode(rust.httpParseRequest(httpRaw))), "http parse");
assertDeepEqual(JSON.parse(decoder.decode(nativeQueryParse(queryStr))), JSON.parse(decoder.decode(rust.queryParse(queryStr))), "query parse");
assertDeepEqual(JSON.parse(decoder.decode(nativeCookieParse(cookieStr))), JSON.parse(decoder.decode(rust.cookieParse(cookieStr))), "cookie parse");

// Routing
assertDeepEqual(
  JSON.parse(decoder.decode(nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")!)),
  JSON.parse(decoder.decode(rust.routeMatch(routePattern, routePath))),
  "route match",
);

// Validation
assertEqual(nativeValidateEmail(emailOk), rust.validateEmail(emailOk) === 1, "email valid");
assertEqual(nativeValidateEmail(emailBad), rust.validateEmail(emailBad) === 1, "email invalid");
assertEqual(nativeValidateUuid(uuidOk), rust.validateUuid(uuidOk) === 1, "uuid valid");
assertEqual(nativeValidateUuid(uuidBad), rust.validateUuid(uuidBad) === 1, "uuid invalid");
assertEqual(nativeValidateIpv4(ipv4Ok), rust.validateIpv4(ipv4Ok) === 1, "ipv4 valid");
assertEqual(nativeValidateIpv4(ipv4Bad), rust.validateIpv4(ipv4Bad) === 1, "ipv4 invalid");
assertEqual(nativeValidateLuhn(luhnOk), rust.validateLuhn(luhnOk) === 1, "luhn valid");
assertEqual(nativeValidateLuhn(luhnBad), rust.validateLuhn(luhnBad) === 1, "luhn invalid");

// Crypto
assertEqual(decoder.decode(nativeHmacSha256(hmacKey, hmacData)), decoder.decode(rust.hmacSha256(hmacKey, hmacData)), "hmac sha256");
assertEqual(decoder.decode(nativeBase64Encode(b64Input)), decoder.decode(rust.base64Encode(b64Input)), "base64 encode");
const b64Enc = rust.base64Encode(b64Input);
assertEqual(decoder.decode(nativeBase64Decode(b64Enc)), decoder.decode(rust.base64Decode(b64Enc)), "base64 decode");

// Compression roundtrip
const gzCompressed = rust.gzipCompress(gzipInput);
const gzDecompressed = rust.gzipDecompress(gzCompressed);
assertEqual(decoder.decode(gzDecompressed), decoder.decode(gzipInput), "gzip roundtrip");

// String
assertEqual(decoder.decode(nativeHtmlEscape(htmlIn)), decoder.decode(rust.htmlEscape(htmlIn)), "html escape");
assertEqual(decoder.decode(nativeSlugify(slugIn)), decoder.decode(rust.slugify(slugIn)), "slugify");
assertEqual(
  decoder.decode(nativeTemplateRender(templateStr, { name: "Alice", place: "Wonderland", count: 42 })),
  decoder.decode(rust.templateRender(encoder.encode(templateStr), templateData)),
  "template render",
);

// Data processing
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonSortBy(smallJsonArr, "score", false))), JSON.parse(decoder.decode(rust.jsonSortBy(smallJsonArr, encoder.encode("score"), 0))), "json sort");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonPaginate(smallJsonArr, 1, 2))), JSON.parse(decoder.decode(rust.jsonPaginate(smallJsonArr, 1, 2))), "json paginate");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonAggregate(smallJsonArr, "score"))), JSON.parse(decoder.decode(rust.jsonAggregate(smallJsonArr, encoder.encode("score")))), "json aggregate");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonGroupBy(smallJsonArr, "name"))), JSON.parse(decoder.decode(rust.jsonGroupBy(smallJsonArr, encoder.encode("name")))), "json group by");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonDedup(smallJsonArr, "id"))), JSON.parse(decoder.decode(rust.jsonDedup(smallJsonArr, encoder.encode("id")))), "json dedup");

// Hashing
assertEqual(nativeCrc32(crcInput), rust.crc32(crcInput), "crc32");
assertEqual(nativeFnv1a64(crcInput), rust.fnv1a64(crcInput), "fnv1a64");

// MIME & Path
assertEqual(nativeMimeFromExtension("json"), decoder.decode(rust.mimeFromExtension(mimeIn)), "mime from ext");
assertEqual(nativePathNormalize("/api/v1/../v2/./users/../../admin"), decoder.decode(rust.pathNormalize(pathIn)), "path normalize");
assertEqual(nativePathIsSafe("/api/../../../etc/passwd"), rust.pathIsSafe(encoder.encode("/api/../../../etc/passwd")) === 1, "path unsafe");
assertEqual(nativePathIsSafe("/api/users/123"), rust.pathIsSafe(encoder.encode("/api/users/123")) === 1, "path safe");

// HTTP response
assertEqual(
  decoder.decode(nativeHttpResponseBuild(200, respBody, "application/json", "X-Request-Id: abc-123\r\n")),
  decoder.decode(rust.httpResponseBuild(200, respBody, respCT, respExtra)),
  "http response build",
);

// WebSocket
const wsFrame = nativeWsFrameBuild(1, wsPayload);
assertDeepEqual(JSON.parse(decoder.decode(nativeWsFrameParse(wsFrame)!)), JSON.parse(decoder.decode(rust.wsFrameParse(wsFrame))), "ws frame parse");
assertEqual(decoder.decode(nativeWsFrameBuild(1, wsPayload)), decoder.decode(rust.wsFrameBuild(1, wsPayload)), "ws frame build");

// Logging
assertEqual(nativeHistogramBucket(750), rust.histogramBucket(750), "histogram bucket");
assertEqual(nativeHistogramBucket(2_000_000), rust.histogramBucket(2_000_000), "histogram bucket 2");

// Content negotiation
assertEqual(
  nativeContentNegotiate("text/html, application/json;q=0.9, */*;q=0.1", ["application/json", "text/html", "text/plain"]),
  decoder.decode(rust.contentNegotiate(acceptHdr, availTypes)),
  "content negotiate",
);

// JSON utilities
assertEqual(decoder.decode(nativeJsonExtract(nestedJson, "user.address.city")!), decoder.decode(rust.jsonExtract(nestedJson, extractPath)), "json extract");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonFlatten(nestedJson))), JSON.parse(decoder.decode(rust.jsonFlatten(nestedJson))), "json flatten");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonMerge(jsonDoc1, jsonDoc2))), JSON.parse(decoder.decode(rust.jsonMerge(jsonDoc1, jsonDoc2))), "json merge");

// Search
assertEqual(nativeBinarySearch(sortedArr, 150), Number(rust.binarySearch(sortedArr, 150)), "binary search");
assertEqual(nativeTextSearchCount(searchCorpus, searchTerm), Number(rust.textSearchCount(searchCorpus, searchTerm)), "text search");

// Misc
assertEqual(nativeFormatBytes(1536), decoder.decode(rust.formatBytes(1536)), "format bytes");
assertEqual(nativeEtagGenerate(etagBody), decoder.decode(rust.etagGenerate(etagBody)), "etag generate");
assertEqual(nativeUrlEncode("hello world & foo=bar"), decoder.decode(rust.urlEncode(urlEncInput)), "url encode");
assertEqual(nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"), decoder.decode(rust.urlDecode(urlDecInput)), "url decode");

// Pipeline
assertDeepEqual(
  JSON.parse(decoder.decode((() => {
    let obj = JSON.parse(decoder.decode(pipelineData));
    const ops = JSON.parse(decoder.decode(pipelineOps));
    for (const op of ops) {
      if (op.op === "uppercase_field") obj[op.field] = obj[op.field].toUpperCase();
      else if (op.op === "add_field") obj[op.field] = op.value;
      else if (op.op === "rename_field") { obj[op.new_name] = obj[op.field]; delete obj[op.field]; }
    }
    return encoder.encode(JSON.stringify(obj));
  })())),
  JSON.parse(decoder.decode(rust.jsonPipeline(pipelineData, pipelineOps))),
  "json pipeline",
);

console.log("All correctness checks passed. ✓");
console.log("Config:", { JSON_ROWS, BATCH_OPS, URL_ROWS, HASH_BYTES, PRIME_LIMIT, TASK_EVENTS });

// ── benchmarks ──
const R: BenchResult[] = [];
const push = (n: string, fn: () => unknown, iters = 50, warm = 5) => R.push(bench(n, fn, iters, warm));



// Cookie Serialize (flux-core context.ts)
push("native:cookie_serialize", () => nativeCookieSerialize("session", "abc123xyz", 3600, true, true, 1).byteLength, 1000, 100);
push("rust:cookie_serialize", () => rust.cookieSerialize(encoder.encode("session"), encoder.encode("abc123xyz"), 3600, 1, 1, 1).byteLength, 1000, 100);

// Multipart Parse (flux-core body.ts)
push("native:multipart_parse", () => nativeMultipartParse(multipartBody, multipartBoundary).byteLength, 500, 50);
push("rust:multipart_parse", () => rust.multipartParse(multipartBody, multipartBoundaryBytes).byteLength, 500, 50);

// CORS Headers (flux-core plugins/cors.ts)
push("native:cors_headers", () => nativeCorsHeaders("https://example.com", "https://example.com, *", "GET, POST", 86400).byteLength, 1000, 100);
push("rust:cors_headers", () => rust.corsHeaders(encoder.encode("https://example.com"), encoder.encode("https://example.com, *"), encoder.encode("GET, POST"), 86400).byteLength, 1000, 100);

// Rate Limit (flux-core plugins/ratelimit.ts)
push("native:rate_limit", () => nativeRateLimitCheck({ tokens: 10, lastRefillMs: Date.now() - 1000 }, 10, 1, Date.now(), 1) ? 1 : 0, 1000, 100);
push("rust:rate_limit", () => rust.rateLimitCheck(rateLimitState, 16, 10.0, 1.0, Date.now(), 1.0), 1000, 100);

// 1-10: Original
push("native:json_parse_sum", () => nativeJsonSum(jsonPayload), envInt("JSON_ITERS", 50));
push("rust:json_parse_sum", () => rust.jsonSumIds(jsonPayload), envInt("JSON_ITERS", 50));
push("native:json_valid", () => nativeJsonValid(jsonPayload), envInt("JSON_VALID_ITERS", 50));
push("rust:json_valid", () => rust.jsonValid(jsonPayload), envInt("JSON_VALID_ITERS", 50));
push("native:products_add", () => nativeProductsAddBytes(addPayload).byteLength, 200, 20);
push("rust:products_add", () => { status[0] = 0; const w = rust.productsAdd(addPayload, outSmall, status); return Number(w) + status[0]; }, 200, 20);
push("native:products_get", () => nativeProductsGetIdBytes("123").byteLength, 300, 30);
push("rust:products_get", () => { status[0] = 0; const w = rust.productsGetId(idPayload, outSmall, status); return Number(w) + status[0]; }, 300, 30);
push("native:batch_execute", () => nativeBatchBytes(batchPayload).byteLength, 50);
push("rust:batch_execute", () => { status[0] = 0; const w = rust.batchExecute(batchPayload, outLarge, status); return Number(w) + status[0]; }, 50);
push("native:url_parse_batch", () => nativeUrlSumHostLens(urlPayload), 50);
push("rust:url_parse_batch", () => rust.urlSumHostLens(urlPayload), 50);
push("native:xxhash", () => nativeHashU64(hashPayload), 300, 30);
push("rust:xxhash", () => rust.xxh3(hashPayload), 300, 30);
push("native:sha256", () => nativeSha256U64(hashPayload), 200, 20);
push("rust:sha256", () => rust.sha256(hashPayload), 200, 20);
push("native:prime_count", () => nativePrimeCount(PRIME_LIMIT), 20, 3);
push("rust:prime_count", () => rust.primeCount(PRIME_LIMIT), 20, 3);
push("native:task_process", () => nativeTaskProcess(taskPayload).byteLength, 50);
push("rust:task_process", () => { const w = rust.taskProcess(taskPayload, outSmall); return Number(w); }, 50);

// 11-16: HTTP parsing
push("native:http_parse", () => nativeHttpParseRequest(httpRaw).byteLength, 500, 50);
push("rust:http_parse", () => rust.httpParseRequest(httpRaw).byteLength, 500, 50);
push("native:query_parse", () => nativeQueryParse(queryStr).byteLength, 500, 50);
push("rust:query_parse", () => rust.queryParse(queryStr).byteLength, 500, 50);
push("native:cookie_parse", () => nativeCookieParse(cookieStr).byteLength, 500, 50);
push("rust:cookie_parse", () => rust.cookieParse(cookieStr).byteLength, 500, 50);
push("native:url_encode", () => nativeUrlEncode("hello world & foo=bar").length, 500, 50);
push("rust:url_encode", () => rust.urlEncode(urlEncInput).byteLength, 500, 50);
push("native:url_decode", () => nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length, 500, 50);
push("rust:url_decode", () => rust.urlDecode(urlDecInput).byteLength, 500, 50);

// 17-18: Routing
push("native:route_match", () => nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:route_match", () => rust.routeMatch(routePattern, routePath).byteLength, 500, 50);

// 19-23: Validation
push("native:validate_email", () => nativeValidateEmail(emailOk) ? 1 : 0, 1000, 100);
push("rust:validate_email", () => rust.validateEmail(emailOk), 1000, 100);
push("native:validate_uuid", () => nativeValidateUuid(uuidOk) ? 1 : 0, 1000, 100);
push("rust:validate_uuid", () => rust.validateUuid(uuidOk), 1000, 100);
push("native:validate_ipv4", () => nativeValidateIpv4(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv4", () => rust.validateIpv4(ipv4Ok), 1000, 100);
push("native:validate_luhn", () => nativeValidateLuhn(luhnOk) ? 1 : 0, 1000, 100);
push("rust:validate_luhn", () => rust.validateLuhn(luhnOk), 1000, 100);

// 24-26: Crypto
push("native:hmac_sha256", () => nativeHmacSha256(hmacKey, hmacData).byteLength, 300, 30);
push("rust:hmac_sha256", () => rust.hmacSha256(hmacKey, hmacData).byteLength, 300, 30);
push("native:base64_encode", () => nativeBase64Encode(b64Input).byteLength, 500, 50);
push("rust:base64_encode", () => rust.base64Encode(b64Input).byteLength, 500, 50);
push("native:base64_decode", () => nativeBase64Decode(b64Enc).byteLength, 500, 50);
push("rust:base64_decode", () => rust.base64Decode(b64Enc).byteLength, 500, 50);

// 27-28: Compression
push("native:gzip_compress", () => nativeGzipCompress(gzipInput).byteLength, 100, 10);
push("rust:gzip_compress", () => rust.gzipCompress(gzipInput).byteLength, 100, 10);
push("native:gzip_decompress", () => nativeGzipDecompress(nativeGzipCompress(gzipInput)).byteLength, 100, 10);
push("rust:gzip_decompress", () => rust.gzipDecompress(gzCompressed).byteLength, 100, 10);

// 29-31: String
push("native:html_escape", () => nativeHtmlEscape(htmlIn).byteLength, 500, 50);
push("rust:html_escape", () => rust.htmlEscape(htmlIn).byteLength, 500, 50);
push("native:slugify", () => nativeSlugify(slugIn).byteLength, 500, 50);
push("rust:slugify", () => rust.slugify(slugIn).byteLength, 500, 50);
push("native:template_render", () => nativeTemplateRender(templateStr, { name: "Alice", place: "Wonderland", count: 42 }).byteLength, 500, 50);
push("rust:template_render", () => rust.templateRender(encoder.encode(templateStr), templateData).byteLength, 500, 50);

// 32-37: Data processing
push("native:json_sort", () => nativeJsonSortBy(smallJsonArr, "score", false).byteLength, 300, 30);
push("rust:json_sort", () => rust.jsonSortBy(smallJsonArr, encoder.encode("score"), 0).byteLength, 300, 30);
push("native:json_paginate", () => nativeJsonPaginate(smallJsonArr, 1, 2).byteLength, 300, 30);
push("rust:json_paginate", () => rust.jsonPaginate(smallJsonArr, 1, 2).byteLength, 300, 30);
push("native:json_aggregate", () => nativeJsonAggregate(smallJsonArr, "score").byteLength, 300, 30);
push("rust:json_aggregate", () => rust.jsonAggregate(smallJsonArr, encoder.encode("score")).byteLength, 300, 30);
push("native:json_group_by", () => nativeJsonGroupBy(smallJsonArr, "name").byteLength, 300, 30);
push("rust:json_group_by", () => rust.jsonGroupBy(smallJsonArr, encoder.encode("name")).byteLength, 300, 30);
push("native:json_dedup", () => nativeJsonDedup(smallJsonArr, "id").byteLength, 300, 30);
push("rust:json_dedup", () => rust.jsonDedup(smallJsonArr, encoder.encode("id")).byteLength, 300, 30);

// 38-39: Caching
push("native:etag_generate", () => nativeEtagGenerate(etagBody).length, 500, 50);
push("rust:etag_generate", () => rust.etagGenerate(etagBody).byteLength, 500, 50);

// 40-41: HTTP response
push("native:http_response", () => nativeHttpResponseBuild(200, respBody, "application/json", "X-Request-Id: abc\r\n").byteLength, 500, 50);
push("rust:http_response", () => rust.httpResponseBuild(200, respBody, respCT, respExtra).byteLength, 500, 50);
push("native:error_response", () => nativeErrorResponse(404, "Not found", "NOT_FOUND").byteLength, 500, 50);
push("rust:error_response", () => rust.errorResponse(404, errMsg, errCode).byteLength, 500, 50);

// 42-44: WebSocket
push("native:ws_frame_parse", () => nativeWsFrameParse(wsFrame)?.byteLength ?? 0, 500, 50);
push("rust:ws_frame_parse", () => rust.wsFrameParse(wsFrame).byteLength, 500, 50);
push("native:ws_frame_build", () => nativeWsFrameBuild(1, wsPayload).byteLength, 500, 50);
push("rust:ws_frame_build", () => rust.wsFrameBuild(1, wsPayload).byteLength, 500, 50);

// 45-46: MIME
push("native:mime_from_ext", () => nativeMimeFromExtension("json").length, 1000, 100);
push("rust:mime_from_ext", () => rust.mimeFromExtension(mimeIn).byteLength, 1000, 100);
push("native:content_negotiate", () => nativeContentNegotiate("text/html, application/json;q=0.9", ["application/json", "text/html"])?.length ?? 0, 500, 50);
push("rust:content_negotiate", () => rust.contentNegotiate(acceptHdr, availTypes).byteLength, 500, 50);

// 47-48: Logging
push("native:log_format", () => nativeLogFormat("INFO", "Request completed", { method: "GET" }, "req-123").byteLength, 500, 50);
push("rust:log_format", () => rust.logFormat(logLevel, logMsg, logCtx, logReqId).byteLength, 500, 50);
push("native:histogram_bucket", () => nativeHistogramBucket(750), 1000, 100);
push("rust:histogram_bucket", () => rust.histogramBucket(750), 1000, 100);

// 49-51: Path
push("native:path_normalize", () => nativePathNormalize("/api/v1/../v2/./users").length, 500, 50);
push("rust:path_normalize", () => rust.pathNormalize(pathIn).byteLength, 500, 50);
push("native:path_is_safe", () => nativePathIsSafe("/api/users/123") ? 1 : 0, 1000, 100);
push("rust:path_is_safe", () => rust.pathIsSafe(encoder.encode("/api/users/123")), 1000, 100);

// 52-53: Search
push("native:binary_search", () => nativeBinarySearch(sortedArr, 150), 500, 50);
push("rust:binary_search", () => Number(rust.binarySearch(sortedArr, 150)), 500, 50);
push("native:text_search", () => nativeTextSearchCount(searchCorpus, searchTerm), 500, 50);
push("rust:text_search", () => Number(rust.textSearchCount(searchCorpus, searchTerm)), 500, 50);

// 54-55: Math
push("native:crc32", () => nativeCrc32(crcInput), 500, 50);
push("rust:crc32", () => rust.crc32(crcInput), 500, 50);
push("native:fnv1a64", () => nativeFnv1a64(crcInput), 500, 50);
push("rust:fnv1a64", () => rust.fnv1a64(crcInput), 500, 50);

// 56: Misc
push("native:format_bytes", () => nativeFormatBytes(1536).length, 1000, 100);
push("rust:format_bytes", () => rust.formatBytes(1536).byteLength, 1000, 100);

// 57: JSON utilities
push("native:json_extract", () => nativeJsonExtract(nestedJson, "user.address.city")?.byteLength ?? 0, 500, 50);
push("rust:json_extract", () => rust.jsonExtract(nestedJson, extractPath).byteLength, 500, 50);
push("native:json_flatten", () => nativeJsonFlatten(nestedJson).byteLength, 300, 30);
push("rust:json_flatten", () => rust.jsonFlatten(nestedJson).byteLength, 300, 30);
push("native:json_merge", () => nativeJsonMerge(jsonDoc1, jsonDoc2).byteLength, 500, 50);
push("rust:json_merge", () => rust.jsonMerge(jsonDoc1, jsonDoc2).byteLength, 500, 50);

// 58: Pipeline
push("native:json_pipeline", () => {
  let obj = JSON.parse(decoder.decode(pipelineData));
  const ops = JSON.parse(decoder.decode(pipelineOps));
  for (const op of ops) {
    if (op.op === "uppercase_field") obj[op.field] = obj[op.field].toUpperCase();
    else if (op.op === "add_field") obj[op.field] = op.value;
    else if (op.op === "rename_field") { obj[op.new_name] = obj[op.field]; delete obj[op.field]; }
  }
  return encoder.encode(JSON.stringify(obj)).byteLength;
}, 300, 30);
push("rust:json_pipeline", () => rust.jsonPipeline(pipelineData, pipelineOps).byteLength, 300, 30);

// ── output ──
console.table(
  R.map((r) => ({
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
  const n = R.find((x) => x.name === nativeName);
  const r = R.find((x) => x.name === rustName);
  if (!n || !r) return;
  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);
  if (ratio >= 1) {
    console.log(`${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`);
  } else {
    console.log(`${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`);
  }
}

console.log("\n═══ Summary ═══");
report("JSON parse + sum", "native:json_parse_sum", "rust:json_parse_sum");
report("JSON validation", "native:json_valid", "rust:json_valid");
report("POST /products/add", "native:products_add", "rust:products_add");
report("GET /products/:id", "native:products_get", "rust:products_get");
report("Batch execution", "native:batch_execute", "rust:batch_execute");
report("URL batch parsing", "native:url_parse_batch", "rust:url_parse_batch");
report("Non-crypto hash", "native:xxhash", "rust:xxhash");
report("SHA-256", "native:sha256", "rust:sha256");
report("CPU-bound prime sieve", "native:prime_count", "rust:prime_count");
report("Background task", "native:task_process", "rust:task_process");
report("HTTP request parse", "native:http_parse", "rust:http_parse");
report("Query string parse", "native:query_parse", "rust:query_parse");
report("Cookie parse", "native:cookie_parse", "rust:cookie_parse");
report("URL encode", "native:url_encode", "rust:url_encode");
report("URL decode", "native:url_decode", "rust:url_decode");
report("Route match", "native:route_match", "rust:route_match");
report("Email validation", "native:validate_email", "rust:validate_email");
report("UUID validation", "native:validate_uuid", "rust:validate_uuid");
report("IPv4 validation", "native:validate_ipv4", "rust:validate_ipv4");
report("Luhn validation", "native:validate_luhn", "rust:validate_luhn");
report("HMAC-SHA256", "native:hmac_sha256", "rust:hmac_sha256");
report("Base64 encode", "native:base64_encode", "rust:base64_encode");
report("Base64 decode", "native:base64_decode", "rust:base64_decode");
report("Gzip compress", "native:gzip_compress", "rust:gzip_compress");
report("Gzip decompress", "native:gzip_decompress", "rust:gzip_decompress");
report("HTML escape", "native:html_escape", "rust:html_escape");
report("Slugify", "native:slugify", "rust:slugify");
report("Template render", "native:template_render", "rust:template_render");
report("JSON sort", "native:json_sort", "rust:json_sort");
report("JSON paginate", "native:json_paginate", "rust:json_paginate");
report("JSON aggregate", "native:json_aggregate", "rust:json_aggregate");
report("JSON group by", "native:json_group_by", "rust:json_group_by");
report("JSON dedup", "native:json_dedup", "rust:json_dedup");
report("ETag generate", "native:etag_generate", "rust:etag_generate");
report("HTTP response build", "native:http_response", "rust:http_response");
report("Error response", "native:error_response", "rust:error_response");
report("WS frame parse", "native:ws_frame_parse", "rust:ws_frame_parse");
report("WS frame build", "native:ws_frame_build", "rust:ws_frame_build");
report("MIME from extension", "native:mime_from_ext", "rust:mime_from_ext");
report("Content negotiate", "native:content_negotiate", "rust:content_negotiate");
report("Log format", "native:log_format", "rust:log_format");
report("Histogram bucket", "native:histogram_bucket", "rust:histogram_bucket");
report("Path normalize", "native:path_normalize", "rust:path_normalize");
report("Path is safe", "native:path_is_safe", "rust:path_is_safe");
report("Binary search", "native:binary_search", "rust:binary_search");
report("Text search", "native:text_search", "rust:text_search");
report("CRC32", "native:crc32", "rust:crc32");
report("FNV-1a 64", "native:fnv1a64", "rust:fnv1a64");
report("Format bytes", "native:format_bytes", "rust:format_bytes");
report("JSON extract", "native:json_extract", "rust:json_extract");
report("JSON flatten", "native:json_flatten", "rust:json_flatten");
report("JSON merge", "native:json_merge", "rust:json_merge");
report("JSON pipeline", "native:json_pipeline", "rust:json_pipeline");
report("Cookie serialize",     "native:cookie_serialize",   "rust:cookie_serialize");
report("Multipart parse",      "native:multipart_parse",    "rust:multipart_parse");
report("CORS headers",         "native:cors_headers",       "rust:cors_headers");
report("Rate limit check",     "native:rate_limit",         "rust:rate_limit");