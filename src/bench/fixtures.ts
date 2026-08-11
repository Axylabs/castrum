import { nativeHmacSha256 } from "../baseline/tasks/hmac";
import { nativeJwtSign } from "../baseline/tasks/jwt";
import { nativeAeadEncrypt } from "../baseline/tasks/aead";
import {
  nativeBrotliCompress,
  nativeGzipCompress,
} from "../baseline/tasks/compress";
import { jsonRowsBytes } from "../data/json-rows";
import { encoder } from "../shared/bytes";

export interface BenchFixtures {
  jsonPayload: Uint8Array;
  httpRaw: Uint8Array;
  queryStr: Uint8Array;
  cookieStr: Uint8Array;
  hmacKey: Uint8Array;
  hmacData: Uint8Array;
  hmacSig: Uint8Array;
  wsKey: string;
  wsKeyBytes: Uint8Array;
  jsonDoc: Uint8Array;
  jsonPatch: Uint8Array;
  emailOk: Uint8Array;
  uuidOk: Uint8Array;
  ipv4Ok: Uint8Array;
  ipv6Ok: Uint8Array;
  crcInput: Uint8Array;
  mimeExt: Uint8Array;
  urlEncodeInput: Uint8Array;
  urlDecodeInput: Uint8Array;

  // ── Backend-framework features ──
  jwtSecret: Uint8Array;
  jwtClaims: Record<string, unknown>;
  jwtToken: Uint8Array;
  jwtNowSeconds: number;
  passwordBytes: Uint8Array;
  passwordSalt: Uint8Array;
  aeadKey: Uint8Array;
  aeadNonce: Uint8Array;
  aeadPlaintext: Uint8Array;
  aeadCiphertext: Uint8Array;
  compressPayload: Uint8Array;
  gzipCompressed: Uint8Array;
  brotliCompressed: Uint8Array;
  multipartBoundary: Uint8Array;
  multipartBody: Uint8Array;
  templateSource: string;
  templateContext: Record<string, unknown>;
  wsPayload: Uint8Array;
  sseData: Uint8Array;

  // ── JSON schema validation ──
  jsonSchema: Uint8Array;
  schemaDoc: Uint8Array;
  schemaBadDoc: Uint8Array;
  schemaDocs: Uint8Array[];

  // ── Form-urlencoded body (M1) ──
  formBody: Uint8Array;
  formBodies: Uint8Array[];

  // ── Media-type / Content-Type (M2) ──
  contentTypeJson: Uint8Array;
  contentTypeMultipart: Uint8Array;

  // ── ETag / HTTP-date / conditional (M3) ──
  etagData: Uint8Array;
  httpDateSecs: number;
  ifNoneMatchHeader: Uint8Array;
  ifModifiedSinceHeader: Uint8Array;

  // ── Accept-Encoding negotiation (M4) ──
  acceptEncodingHeader: Uint8Array;

  // ── Base64 / hex encoding (M5) ──
  encodeData: Uint8Array;

  // ── Cookie signing (M6) ──
  cookieValue: Uint8Array;
  cookieSecret: Uint8Array;

  // ── CSRF (M7) ──
  csrfSecret: Uint8Array;

  // ── URL join / building (M8) ──
  urlBase: Uint8Array;
  urlReference: Uint8Array;
  urlQueryParams: Record<string, string>;
}

export interface ComplexFixtures {
  jsonLarge: Uint8Array;
  jsonHuge: Uint8Array;
  jsonNestedDeep: Uint8Array;
  httpComplex: Uint8Array;
  httpHuge: Uint8Array;
  cookieLarge: Uint8Array;
  queryComplex: Uint8Array;
  urlLarge: Uint8Array;
  batchJsonDocs: Uint8Array[];
  batchEmails: Uint8Array[];
  batchUuids: Uint8Array[];
  batchIpv4s: Uint8Array[];
  batchQueries: Uint8Array[];

  // ── Backend-framework feature batches ──
  batchPasswords: Uint8Array[];
  batchTokens: Uint8Array[];
  batchCompressItems: Uint8Array[];
  batchContexts: Uint8Array[];
  passwordSalt: Uint8Array;
  batchSecret: Uint8Array;
  batchNow: number;
  templateSource: string;
}

export function createFixtures(): BenchFixtures {
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
  const hmacSig = nativeHmacSha256(hmacKey, hmacData);

  const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
  const wsKeyBytes = encoder.encode(wsKey);

  const jsonDoc = encoder.encode(JSON.stringify({ a: 1, b: { c: 2 } }));
  const jsonPatch = encoder.encode(
    JSON.stringify([{ op: "replace", path: "/a", value: 42 }]),
  );

  const emailOk = encoder.encode("user@example.com");
  const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
  const ipv4Ok = encoder.encode("192.168.1.100");
  const ipv6Ok = encoder.encode("2001:db8::1");

  const crcInput = encoder.encode(
    "Hello, practical CRC32 checksum test data!",
  );

  const mimeExt = encoder.encode("json");

  const urlEncodeInput = encoder.encode("hello world & foo=bar");
  const urlDecodeInput = encoder.encode(
    "hello%20world%20%26%20foo%3Dbar",
  );

  // ── Backend-framework features ──
  const jwtSecret = encoder.encode("castrum-bench-jwt-secret");
  const jwtClaims: Record<string, unknown> = {
    sub: "1234567890",
    name: "John Doe",
    role: "admin",
    iat: 1_516_239_022,
  };
  const jwtNowSeconds = 1_750_000_000;
  const jwtToken = nativeJwtSign(jwtClaims, jwtSecret, null, jwtNowSeconds);

  const passwordBytes = encoder.encode("correct horse battery staple");
  const passwordSalt = encoder.encode("0123456789abcdef");

  const aeadKey = encoder.encode("0123456789abcdef0123456789abcdef");
  const aeadNonce = encoder.encode("0123456789ab");
  const aeadPlaintext = encoder.encode(
    "sensitive session payload for the encryption benchmark",
  );
  const aeadCiphertext = nativeAeadEncrypt(aeadKey, aeadNonce, aeadPlaintext);

  const compressPayload = encoder.encode(
    Array.from(
      { length: 200 },
      (_, i) => `row ${i}: the quick brown fox jumps over the lazy dog ${i}`,
    ).join("\n"),
  );
  const gzipCompressed = nativeGzipCompress(compressPayload);
  const brotliCompressed = nativeBrotliCompress(compressPayload);

  const multipartBoundary = encoder.encode("FormBoundary1234");
  const multipartBody = encoder.encode(
    `--FormBoundary1234\r\n` +
      `Content-Disposition: form-data; name="field1"\r\n\r\n` +
      `hello world\r\n` +
      `--FormBoundary1234\r\n` +
      `Content-Disposition: form-data; name="upload"; filename="a.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `file contents here\r\n` +
      `--FormBoundary1234--\r\n`,
  );

  const templateSource =
    "{% for u in users %}<li>{{ u.name }} ({{ u.id }})</li>\n{% endfor %}";
  const templateContext: Record<string, unknown> = {
    users: Array.from({ length: 200 }, (_, i) => ({
      name: `User ${i}`,
      id: i,
    })),
  };

  const wsPayload = encoder.encode("Hello WebSocket! ".repeat(10));
  const sseData = encoder.encode("line1\nline2\nline3");

  // ── JSON schema validation ──
  // A draft-07 object schema matching the `jsonRows` shape (JsonRow).
  const jsonSchema = encoder.encode(
    JSON.stringify({
      type: "object",
      required: ["id", "name", "active", "score", "tags", "nested"],
      properties: {
        id: { type: "number" },
        name: { type: "string", minLength: 1 },
        active: { type: "boolean" },
        score: { type: "number" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        nested: {
          type: "object",
          required: ["version", "createdAt"],
          properties: {
            version: { type: "number" },
            createdAt: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    }),
  );

  const schemaDoc = encoder.encode(
    JSON.stringify({
      id: 1,
      name: "user_1",
      active: true,
      score: 1.25,
      tags: ["alpha", "beta"],
      nested: { version: 1, createdAt: "2026-01-01T00:00:00Z" },
    }),
  );

  // Deliberately invalid: wrong types + extra property (additionalProperties: false).
  const schemaBadDoc = encoder.encode(
    JSON.stringify({ id: "nope", name: 42, extra: true }),
  );

  const schemaDocs = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        active: i % 2 === 0,
        score: i * 1.25,
        tags: ["alpha", "beta", "gamma"],
        nested: { version: i % 10, createdAt: "2026-01-01T00:00:00Z" },
      }),
    ),
  );

  // ── Form-urlencoded body (M1) ──
  const formBody = encoder.encode(
    "name=John+Doe&email=john%40example.com&age=30&tags[]=a&tags[]=b&empty=&note=hello+world%21",
  );
  const formBodies = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      `name=user${i}&age=${20 + (i % 50)}&email=user${i}%40example.com&tag=a&tag=b&note=item+${i}`,
    ),
  );

  // ── Media-type / Content-Type (M2) ──
  const contentTypeJson = encoder.encode("application/json; charset=utf-8");
  const contentTypeMultipart = encoder.encode(
    "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW",
  );

  // ── ETag / HTTP-date / conditional (M3) ──
  const etagData = encoder.encode(
    "the quick brown fox jumps over the lazy dog 1234567890",
  );
  const httpDateSecs = 784111777; // Sun, 06 Nov 1994 08:49:37 GMT
  const ifNoneMatchHeader = encoder.encode('"abc123", W/"def456"');
  const ifModifiedSinceHeader = encoder.encode(
    "Sun, 06 Nov 1994 08:49:37 GMT",
  );

  // ── Accept-Encoding negotiation (M4) ──
  const acceptEncodingHeader = encoder.encode(
    "gzip;q=0.8, deflate, br;q=1.0, *;q=0.1",
  );

  // ── Base64 / hex encoding (M5) ──
  const encodeData = encoder.encode(
    "The quick brown fox jumps over the lazy dog. 0123456789!@#$%^&*()_+\n",
  );

  // ── Cookie signing (M6) ──
  const cookieValue = encoder.encode("session=abc123; theme=dark");
  const cookieSecret = encoder.encode("cookie-signing-secret-2026");

  // ── CSRF (M7) ──
  const csrfSecret = encoder.encode("csrf-protection-secret-2026");

  // ── URL join / building (M8) ──
  const urlBase = encoder.encode("http://example.com/api/users?page=1");
  const urlReference = encoder.encode("v2/items/42?active=true#top");
  const urlQueryParams: Record<string, string> = {
    q: "hello world",
    page: "2",
    tag: "a b",
  };

  return {
    jsonPayload,
    httpRaw,
    queryStr,
    cookieStr,
    hmacKey,
    hmacData,
    hmacSig,
    wsKey,
    wsKeyBytes,
    jsonDoc,
    jsonPatch,
    emailOk,
    uuidOk,
    ipv4Ok,
    ipv6Ok,
    crcInput,
    mimeExt,
    urlEncodeInput,
    urlDecodeInput,
    jwtSecret,
    jwtClaims,
    jwtToken,
    jwtNowSeconds,
    passwordBytes,
    passwordSalt,
    aeadKey,
    aeadNonce,
    aeadPlaintext,
    aeadCiphertext,
    compressPayload,
    gzipCompressed,
    brotliCompressed,
    multipartBoundary,
    multipartBody,
    templateSource,
    templateContext,
    wsPayload,
    sseData,
    jsonSchema,
    schemaDoc,
    schemaBadDoc,
    schemaDocs,
    formBody,
    formBodies,
    contentTypeJson,
    contentTypeMultipart,
    etagData,
    httpDateSecs,
    ifNoneMatchHeader,
    ifModifiedSinceHeader,
    acceptEncodingHeader,
    encodeData,
    cookieValue,
    cookieSecret,
    csrfSecret,
    urlBase,
    urlReference,
    urlQueryParams,
  };
}

export function createComplexFixtures(): ComplexFixtures {
  const jsonLarge = jsonRowsBytes(50_000);
  const jsonHuge = jsonRowsBytes(100_000);

  const jsonNestedDeep = encoder.encode(
    JSON.stringify({
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                data: Array.from({ length: 1000 }, (_, i) => ({
                  id: i,
                  value: `item_${i}`,
                  tags: ["alpha", "beta", "gamma"],
                })),
                meta: { created: "2026-01-01", updated: "2026-07-24", version: 42 },
              },
            },
          },
        },
      },
    }),
  );

  const httpComplex = encoder.encode(
    "POST /api/v1/users/123/orders?include=items,payments&expand=shipping HTTP/1.1\r\n" +
      "Host: api.example.com\r\n" +
      "Content-Type: application/json\r\n" +
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\r\n" +
      "X-Request-ID: 550e8400-e29b-41d4-a716-446655440000\r\n" +
      "X-Trace-ID: abcdef1234567890\r\n" +
      "X-Client-Version: 2.5.1\r\n" +
      "Accept: application/json, text/plain, */*\r\n" +
      "Accept-Language: en-US,en;q=0.9\r\n" +
      "Accept-Encoding: gzip, deflate, br\r\n" +
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n" +
      "Cookie: session=abc123; theme=dark; lang=en-US; prefs=compact; tracking=0\r\n" +
      "Content-Length: 256\r\n" +
      "Connection: keep-alive\r\n" +
      "Cache-Control: no-cache\r\n" +
      "Pragma: no-cache\r\n" +
      "\r\n",
  );

  const httpHuge = encoder.encode(
    "GET /api/search?q=" +
      "a".repeat(4000) +
      " HTTP/1.1\r\n" +
      "Host: example.com\r\n" +
      Array.from(
        { length: 50 },
        (_, i) => `X-Custom-Header-${i}: value-${i}\r\n`,
      ).join("") +
      "\r\n",
  );

  const cookieLarge = encoder.encode(
    Array.from(
      { length: 50 },
      (_, i) => `cookie_${i}=value_${i}_with_some_extra_data_${i}`,
    ).join("; "),
  );

  const queryComplex = encoder.encode(
    Array.from(
      { length: 100 },
      (_, i) => `param${i}=value${i}&arr[]=${i}a&arr[]=${i}b`,
    ).join("&"),
  );

  const urlLarge = encoder.encode(
    "https://example.com/path/to/resource?search=" +
      encodeURIComponent(`hello world & foo=bar ${String("x").repeat(2000)}`),
  );

  const batchJsonDocs = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      JSON.stringify({
        id: i,
        action: "update",
        payload: { count: i * 2, name: `item_${i}` },
      }),
    ),
  );

  const batchEmails = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(`user${i}@subdomain${i}.example.com`),
  );

  const batchUuids = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
    ),
  );

  const batchIpv4s = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(`192.168.${Math.floor(i / 256)}.${i % 256}`),
  );

  const batchQueries = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      `id=${i}&name=user${i}&active=${i % 2 === 0}&tags[]=${i}a&tags[]=${i}b`,
    ),
  );

  // ── Backend-framework feature batches ──
  // Small batch: the JS baseline (scrypt) is slow per item (~40ms), so 20 items
  // keeps the complex benchmark tractable.
  const batchPasswords = Array.from({ length: 20 }, (_, i) =>
    encoder.encode(`password-${i}-correct-horse-battery-staple`),
  );

  const passwordSalt = encoder.encode("0123456789abcdef");

  const batchSecret = encoder.encode("castrum-bench-jwt-secret");
  const batchNow = 1_750_000_000;
  const batchTokens = Array.from({ length: 100 }, (_, i) =>
    nativeJwtSign(
      { sub: String(i), name: `user${i}`, role: "admin" },
      batchSecret,
      3600,
      batchNow,
    ),
  );

  const batchCompressItems = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      JSON.stringify({
        id: i,
        name: `item_${i}`,
        description: "the quick brown fox jumps over the lazy dog ".repeat(3),
        tags: ["alpha", "beta", "gamma"],
      }),
    ),
  );

  const batchContexts = Array.from({ length: 100 }, (_, i) =>
    encoder.encode(
      JSON.stringify({
        users: Array.from({ length: 20 }, (_, j) => ({
          name: `User ${i}-${j}`,
          id: j,
        })),
      }),
    ),
  );

  const templateSource =
    "{% for u in users %}<li>{{ u.name }} ({{ u.id }})</li>\n{% endfor %}";

  return {
    jsonLarge,
    jsonHuge,
    jsonNestedDeep,
    httpComplex,
    httpHuge,
    cookieLarge,
    queryComplex,
    urlLarge,
    batchJsonDocs,
    batchEmails,
    batchUuids,
    batchIpv4s,
    batchQueries,
    batchPasswords,
    batchTokens,
    batchCompressItems,
    batchContexts,
    passwordSalt,
    batchSecret,
    batchNow,
    templateSource,
  };
}