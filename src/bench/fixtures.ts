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