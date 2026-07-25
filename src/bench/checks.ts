import * as native from "../baseline";
import { rust, rustBatch } from "../rust-ffi/raw";
import { decoder } from "../shared/bytes";
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
    rust.hmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig) === 1,
    "hmac verify",
  );

  assertEqual(
    native.nativeValidateEmail(f.emailOk),
    rust.validateEmail(f.emailOk) === 1,
    "email valid",
  );

  assertEqual(
    native.nativeValidateUuid(f.uuidOk),
    rust.validateUuid(f.uuidOk) === 1,
    "uuid valid",
  );

  assertEqual(
    native.nativeValidateIpv4(f.ipv4Ok),
    rust.validateIpv4(f.ipv4Ok) === 1,
    "ipv4 valid",
  );

  assertEqual(
    native.nativeValidateIpv6(f.ipv6Ok),
    rust.validateIpv6(f.ipv6Ok) === 1,
    "ipv6 valid",
  );

  assertEqual(
    native.nativeCrc32(f.crcInput),
    rust.crc32(f.crcInput),
    "crc32",
  );

  assertEqual(
    native.nativeFnv1a64(f.crcInput),
    rust.fnv1A64(f.crcInput),
    "fnv1A64",
  );

   assertEqual(
    native.nativeJsonValid(f.jsonPayload),
    rust.jsonValid(f.jsonPayload) === 1,
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
    (acc, doc) => acc + rust.jsonValid(doc),
    0,
  );
  assertEqual(nativeBatch, rustBatchTest, "batch json valid");

  // Batch email validation
  const nativeEmails = c.batchEmails.reduce(
    (acc, e) => acc + (native.nativeValidateEmail(e) ? 1 : 0),
    0,
  );
  const rustEmails = c.batchEmails.reduce(
    (acc, e) => acc + rust.validateEmail(e),
    0,
  );
  assertEqual(nativeEmails, rustEmails, "batch email valid");

  // Batch UUID validation
  const nativeUuids = c.batchUuids.reduce(
    (acc, u) => acc + (native.nativeValidateUuid(u) ? 1 : 0),
    0,
  );
  const rustUuids = c.batchUuids.reduce(
    (acc, u) => acc + rust.validateUuid(u),
    0,
  );
  assertEqual(nativeUuids, rustUuids, "batch uuid valid");

  // Batch IPv4 validation
  const nativeIps = c.batchIpv4s.reduce(
    (acc, ip) => acc + (native.nativeValidateIpv4(ip) ? 1 : 0),
    0,
  );
  const rustIps = c.batchIpv4s.reduce(
    (acc, ip) => acc + rust.validateIpv4(ip),
    0,
  );
  assertEqual(nativeIps, rustIps, "batch ipv4 valid");



  // Large JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonLarge),
    rust.jsonValid(c.jsonLarge) === 1,
    "large json valid",
  );

  // Huge JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonHuge),
    rust.jsonValid(c.jsonHuge) === 1,
    "huge json valid",
  );

  // Deep nested JSON validation
  assertEqual(
    native.nativeJsonValid(c.jsonNestedDeep),
    rust.jsonValid(c.jsonNestedDeep) === 1,
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