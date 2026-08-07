import * as native from "../baseline";
import { rust, rustBatch } from "../rust-ffi";
import { decoder, encoder } from "../shared/bytes";
import { pairsToObject, readHttpPacked, readPairsPacked } from "../shared/packed";
import { assertDeepEqual, assertEqual, parseJsonBytes } from "./assert";
import type { BenchFixtures, ComplexFixtures } from "./fixtures";

export function runCorrectnessChecks(f: BenchFixtures): void {

    assertDeepEqual(
    readHttpPacked(native.nativeHttpParseRequestPacked(f.httpRaw)),
    readHttpPacked(rust.httpParseRequestPacked(f.httpRaw)),
    "http parse packed native writer",
  );

  assertDeepEqual(
    pairsToObject(readPairsPacked(native.nativeQueryParsePacked(f.queryStr))),
    pairsToObject(readPairsPacked(rust.queryParsePacked(f.queryStr))),
    "query parse packed native writer",
  );

  assertDeepEqual(
    pairsToObject(readPairsPacked(native.nativeCookieParsePacked(f.cookieStr))),
    pairsToObject(readPairsPacked(rust.cookieParsePacked(f.cookieStr))),
    "cookie parse packed native writer",
  );

  assertEqual(
    native.nativeJsonSum(f.jsonPayload),
    rust.jsonSumIds(f.jsonPayload),
    "json sum",
  );


  assertEqual(
    decoder.decode(native.nativeWsAcceptKey(f.wsKey)),
    decoder.decode(rust.wsAcceptKey(f.wsKeyBytes)),
    "ws accept key",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeJsonPatch(f.jsonDoc, f.jsonPatch)),
    parseJsonBytes(rust.jsonPatch(f.jsonDoc, f.jsonPatch)),
    "json patch",
  );

  assertEqual(
    decoder.decode(f.hmacSig),
    decoder.decode(rust.hmacSha256(f.hmacKey, f.hmacData)),
    "hmac sha256",
  );

  assertEqual(
    native.nativeHmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig),
    rust.hmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig),
    "hmac verify",
  );

  assertEqual(
    native.nativeValidateEmail(f.emailOk),
    rust.validateEmail(f.emailOk),
    "email valid",
  );

  assertEqual(
    native.nativeValidateUuid(f.uuidOk),
    rust.validateUuid(f.uuidOk),
    "uuid valid",
  );

  assertEqual(
    native.nativeValidateIpv4(f.ipv4Ok),
    rust.validateIpv4(f.ipv4Ok),
    "ipv4 valid",
  );

  assertEqual(
    native.nativeValidateIpv6(f.ipv6Ok),
    rust.validateIpv6(f.ipv6Ok),
    "ipv6 valid",
  );

  assertEqual(
    native.nativeCrc32(f.crcInput),
    rust.crc32(f.crcInput),
    "crc32",
  );

  assertEqual(
    native.nativeFnv1a64(f.crcInput),
    rust.fnv1a64(f.crcInput),
    "fnv1a64",
  );

   assertEqual(
    native.nativeJsonValid(f.jsonPayload),
    rust.jsonValid(f.jsonPayload),
    "json valid",
  );


  assertEqual(
    native.nativeMimeFromExtension("json"),
    decoder.decode(rust.mimeFromExtension(f.mimeExt)),
    "mime",
  );

  assertEqual(
    native.nativeUrlEncode("hello world & foo=bar"),
    decoder.decode(rust.urlEncode(f.urlEncodeInput)),
    "url encode",
  );

  assertEqual(
    native.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"),
    decoder.decode(rust.urlDecode(f.urlDecodeInput)),
    "url decode",
  );

  // ── Backend-framework feature checks ──

  // JWT: cross-impl verify + tamper rejection.
  const rustToken = rust.jwtSign(f.jwtClaims, f.jwtSecret, 3600, f.jwtNowSeconds);
  const nativeToken = native.nativeJwtSign(
    f.jwtClaims,
    f.jwtSecret,
    3600,
    f.jwtNowSeconds,
  );
  assertEqual(
    rust.jwtVerify(rustToken, f.jwtSecret, f.jwtNowSeconds) !== null,
    true,
    "jwt rust self-verify",
  );
  assertEqual(
    rust.jwtVerify(nativeToken, f.jwtSecret, f.jwtNowSeconds) !== null,
    true,
    "jwt rust verifies native token",
  );
  assertEqual(
    native.nativeJwtVerify(rustToken, f.jwtSecret, f.jwtNowSeconds),
    true,
    "jwt native verifies rust token",
  );
  assertEqual(
    native.nativeJwtVerify(nativeToken, f.jwtSecret, f.jwtNowSeconds),
    true,
    "jwt native self-verify",
  );
  const tamperedToken = rustToken.slice();
  tamperedToken[tamperedToken.length - 1] =
    (tamperedToken[tamperedToken.length - 1] ?? 0) ^ 0x01;
  assertEqual(
    rust.jwtVerify(tamperedToken, f.jwtSecret, f.jwtNowSeconds) !== null,
    false,
    "jwt rejects tampered (rust)",
  );
  assertEqual(
    native.nativeJwtVerify(tamperedToken, f.jwtSecret, f.jwtNowSeconds),
    false,
    "jwt rejects tampered (native)",
  );

  // AEAD: byte parity with the JS baseline + roundtrip + tamper rejection.
  const rustCt = rust.aeadEncrypt(f.aeadKey, f.aeadNonce, f.aeadPlaintext);
  assertDeepEqual(rustCt, f.aeadCiphertext, "aead encrypt bytes match native");
  const aeadDec = rust.aeadDecrypt(f.aeadKey, f.aeadNonce, rustCt);
  assertEqual(aeadDec !== null, true, "aead decrypt returns plaintext");
  if (aeadDec) {
    assertDeepEqual(aeadDec, f.aeadPlaintext, "aead plaintext matches");
  }
  const tamperedCt = rustCt.slice();
  tamperedCt[0] = (tamperedCt[0] ?? 0) ^ 0xff;
  assertEqual(
    rust.aeadDecrypt(f.aeadKey, f.aeadNonce, tamperedCt) !== null,
    false,
    "aead rejects tampered",
  );

  // Compression: rust/native roundtrips + cross-impl decompress.
  assertDeepEqual(
    rust.gzipDecompress(rust.gzipCompress(f.compressPayload)),
    f.compressPayload,
    "gzip rust roundtrip",
  );
  assertDeepEqual(
    rust.gzipDecompress(f.gzipCompressed),
    f.compressPayload,
    "gzip rust decompresses native",
  );
  assertDeepEqual(
    native.nativeGzipDecompress(rust.gzipCompress(f.compressPayload)),
    f.compressPayload,
    "gzip native decompresses rust",
  );
  assertDeepEqual(
    rust.brotliDecompress(rust.brotliCompress(f.compressPayload)),
    f.compressPayload,
    "brotli rust roundtrip",
  );
  assertDeepEqual(
    rust.brotliDecompress(f.brotliCompressed),
    f.compressPayload,
    "brotli rust decompresses native",
  );
  assertDeepEqual(
    native.nativeBrotliDecompress(rust.brotliCompress(f.compressPayload)),
    f.compressPayload,
    "brotli native decompresses rust",
  );

  // Multipart: parsed parts match the JS baseline.
  const nativeParts = native.nativeMultipartParse(
    f.multipartBody,
    f.multipartBoundary,
  );
  const rustParts = rust.multipartParse(f.multipartBody, f.multipartBoundary);
  assertEqual(rustParts.length, nativeParts.length, "multipart part count");
  assertEqual(rustParts[0]?.name, nativeParts[0]?.name, "multipart first name");
  assertEqual(
    rustParts[1]?.filename,
    nativeParts[1]?.filename,
    "multipart filename",
  );
  assertDeepEqual(
    rustParts[1]?.data,
    nativeParts[1]?.data,
    "multipart file data",
  );

  // Template: rendered bytes match the JS mini-renderer.
  const renderer = rust.createTemplateRenderer(f.templateSource);
  assertEqual(
    decoder.decode(renderer.render(f.templateContext)),
    native.nativeTemplateRender(f.templateSource, f.templateContext),
    "template render bytes match",
  );

  // WS frames: byte parity + decode roundtrip.
  const nativeWs = native.nativeWsFrameEncode(0x2, f.wsPayload, true, true);
  const rustWs = rust.wsFrameEncode(0x2, f.wsPayload, true, true);
  assertDeepEqual(rustWs, nativeWs, "ws frame encode bytes match");
  assertDeepEqual(
    rust.wsFrameDecode(rustWs)?.payload,
    f.wsPayload,
    "ws frame decode roundtrip",
  );

  // SSE: byte parity.
  assertDeepEqual(
    rust.sseEncodeEvent("update", f.sseData, "42", 3000),
    native.nativeSseEncodeEvent("update", f.sseData, "42", 3000),
    "sse encode bytes match",
  );

  // Password hashing: argon2id hash → verify roundtrip (no byte parity — the
  // baseline uses scrypt, a different KDF).
  const phc = rust.passwordHash(f.passwordBytes, f.passwordSalt, {
    mCost: 4096,
    tCost: 1,
    pCost: 1,
  });
  assertEqual(rust.passwordVerify(f.passwordBytes, phc), true, "argon2 hash then verify");
  assertEqual(
    rust.passwordVerify(encoder.encode("wrong password"), phc),
    false,
    "argon2 rejects wrong password",
  );

  console.log("Practical correctness checks passed. ✓");
}

export function runComplexCorrectnessChecks(
  _f: BenchFixtures,
  c: ComplexFixtures,
): void {
  // Batch JSON validation
  const nativeBatch = c.batchJsonDocs.reduce(
    (acc, doc) => acc + (native.nativeJsonValid(doc) ? 1 : 0),
    0,
  );
  const rustBatchTest = c.batchJsonDocs.reduce(
    (acc, doc) => acc + (rust.jsonValid(doc) ? 1 : 0),
    0,
  );
  assertEqual(nativeBatch, rustBatchTest, "batch json valid");

  // Batch email validation
  const nativeEmails = c.batchEmails.reduce(
    (acc, e) => acc + (native.nativeValidateEmail(e) ? 1 : 0),
    0,
  );
  const rustEmails = c.batchEmails.reduce(
    (acc, e) => acc + (rust.validateEmail(e) ? 1 : 0),
    0,
  );
  assertEqual(nativeEmails, rustEmails, "batch email valid");

  // Batch UUID validation
  const nativeUuids = c.batchUuids.reduce(
    (acc, u) => acc + (native.nativeValidateUuid(u) ? 1 : 0),
    0,
  );
  const rustUuids = c.batchUuids.reduce(
    (acc, u) => acc + (rust.validateUuid(u) ? 1 : 0),
    0,
  );
  assertEqual(nativeUuids, rustUuids, "batch uuid valid");

  // Batch IPv4 validation
  const nativeIps = c.batchIpv4s.reduce(
    (acc, ip) => acc + (native.nativeValidateIpv4(ip) ? 1 : 0),
    0,
  );
  const rustIps = c.batchIpv4s.reduce(
    (acc, ip) => acc + (rust.validateIpv4(ip) ? 1 : 0),
    0,
  );
  assertEqual(nativeIps, rustIps, "batch ipv4 valid");



  // Large JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonLarge),
    rust.jsonValid(c.jsonLarge),
    "large json valid",
  );

  // Huge JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonHuge),
    rust.jsonValid(c.jsonHuge),
    "huge json valid",
  );

  // Deep nested JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonNestedDeep),
    rust.jsonValid(c.jsonNestedDeep),
    "deep json valid",
  );


    const rustBatchJson = rustBatch
    .jsonValid(c.batchJsonDocs)
    .reduce((acc, b) => acc + b, 0);
  assertEqual(nativeBatch, rustBatchJson, "batch json valid packed");

  const rustBatchEmails = rustBatch
    .validateEmail(c.batchEmails)
    .reduce((acc, b) => acc + b, 0);
  assertEqual(nativeEmails, rustBatchEmails, "batch email valid packed");

  const rustBatchUuids = rustBatch
    .validateUuid(c.batchUuids)
    .reduce((acc, b) => acc + b, 0);
  assertEqual(nativeUuids, rustBatchUuids, "batch uuid valid packed");

  const rustBatchIpv4s = rustBatch
    .validateIpv4(c.batchIpv4s)
    .reduce((acc, b) => acc + b, 0);
  assertEqual(nativeIps, rustBatchIpv4s, "batch ipv4 valid packed");

  const nativeQueryCount = c.batchQueries.reduce(
    (acc, q) => acc + readPairsPacked(native.nativeQueryParsePacked(q)).length,
    0,
  );

  const rustQueryCount = rustBatch
    .queryParse(c.batchQueries)
    .reduce((acc, bytes) => acc + readPairsPacked(bytes).length, 0);

  assertEqual(nativeQueryCount, rustQueryCount, "batch query packed count");

  console.log("Complex correctness checks passed. ✓");
}