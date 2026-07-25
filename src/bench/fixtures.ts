import { nativeHmacSha256 } from "../baseline/tasks/hmac";
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
      encodeURIComponent("hello world & foo=bar " + "x".repeat(2000)),
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
  };
}