import * as native from "../baseline";
import { Buffer } from "node:buffer";
import { rust } from "../rust-ffi";
// The public `rustBatch` alias was removed in 0.8.0 — keep a bench-local
// shorthand for `rust.batch` so the checks below stay readable.
const rustBatch = rust.batch;
import { decoder, encoder } from "../shared/bytes";
import { pairsToObject, readHttpPacked, readPairsPacked } from "../shared/packed";
import {
  nativeJsonSchemaValidate,
  nativeJsonSchemaValidateBatch,
} from "./schema-baseline";
import { nativeFormParsePacked } from "./form-baseline";
import { nativeParseMediaType } from "./media-type-baseline";
import { nativeEtag, nativeHttpDate, nativeIsNotModified } from "./etag-baseline";
import { nativeNegotiateEncoding } from "./accept-baseline";
import {
  nativeBase64Decode,
  nativeBase64Encode,
  nativeHexDecode,
  nativeHexEncode,
} from "./encoding-baseline";
import {
  nativeSignCookie,
  nativeVerifyCookie,
} from "./cookie-sign-baseline";
import { nativeCsrfToken, nativeCsrfVerify } from "./csrf-baseline";
import {
  nativeUrlEncodeQuery,
  nativeUrlResolve,
} from "./url-join-baseline";
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

  assertDeepEqual(
    native.nativeJsonParse(f.jsonPayload),
    rust.jsonParse(f.jsonPayload),
    "json parse",
  );

  // ── JSON schema validation (native jsonschema vs ajv baseline) ──
  const schemaValidator = rust.createSchemaValidator(f.jsonSchema);
  assertEqual(
    nativeJsonSchemaValidate(f.schemaDoc, f.jsonSchema),
    true,
    "schema: native accepts valid doc",
  );
  assertEqual(
    schemaValidator.validate(f.schemaDoc),
    true,
    "schema: rust accepts valid doc",
  );
  assertEqual(
    nativeJsonSchemaValidate(f.schemaBadDoc, f.jsonSchema),
    false,
    "schema: native rejects bad doc",
  );
  assertEqual(
    schemaValidator.validate(f.schemaBadDoc),
    false,
    "schema: rust rejects bad doc",
  );
  assertEqual(
    nativeJsonSchemaValidateBatch(f.schemaDocs, f.jsonSchema),
    f.schemaDocs.length,
    "schema batch native",
  );
  assertEqual(
    rust.batch.schemaValidateCount(schemaValidator, f.schemaDocs),
    f.schemaDocs.length,
    "schema batch rust",
  );

  // ── Form-urlencoded body parsing (URLSearchParams baseline vs rust) ──
  assertDeepEqual(
    pairsToObject(readPairsPacked(rust.formParsePacked(f.formBody))),
    pairsToObject(readPairsPacked(nativeFormParsePacked(f.formBody))),
    "form parse parity native vs rust",
  );
  assertEqual(
    rust.batch.formParse(f.formBodies).length,
    f.formBodies.length,
    "form parse batch count",
  );

  // ── Media-type / Content-Type parsing (hand-rolled JS baseline vs rust) ──
  const mediaParser = rust.createMediaTypeParser();
  for (const header of [f.contentTypeJson, f.contentTypeMultipart]) {
    const rustM = mediaParser.parse(header);
    const nativeM = nativeParseMediaType(decoder.decode(header));
    assertEqual(rustM.mediaType, nativeM.mediaType, "media type: essence parity");
    assertDeepEqual(rustM.params, nativeM.params, "media type: params parity");
  }
  assertEqual(
    mediaParser.matches(f.contentTypeJson, f.contentTypeJson),
    true,
    "media type: exact match",
  );
  assertEqual(
    mediaParser.matches(f.contentTypeJson, encoder.encode("application/*")),
    true,
    "media type: subtype wildcard",
  );
  assertEqual(
    mediaParser.matches(f.contentTypeJson, encoder.encode("text/*")),
    false,
    "media type: mismatched wildcard",
  );

  // ── ETag / HTTP-date / conditional (M3) ──
  const etagStr = decoder.decode(rust.etag(f.etagData));
  assertEqual(etagStr, decoder.decode(nativeEtag(f.etagData)), "etag parity");
  assertEqual(
    decoder.decode(rust.etag(f.etagData, true)).startsWith('W/"'),
    true,
    "etag weak prefix",
  );
  assertEqual(
    decoder.decode(rust.httpDate(f.httpDateSecs)),
    decoder.decode(nativeHttpDate(f.httpDateSecs)),
    "http date parity",
  );
  assertEqual(
    rust.parseHttpDate(f.ifModifiedSinceHeader),
    BigInt(f.httpDateSecs),
    "http date parse",
  );
  const conditional = rust.createConditionalRequest(rust.etag(f.etagData), f.httpDateSecs);
  assertEqual(
    conditional.isNotModified(
      encoder.encode(`"nope", ${etagStr}`),
      null,
    ),
    true,
    "conditional: matching etag → 304",
  );
  assertEqual(
    conditional.isNotModified(encoder.encode('"nope"'), null),
    false,
    "conditional: non-matching etag → 200",
  );
  assertEqual(
    conditional.isNotModified(null, f.ifModifiedSinceHeader),
    nativeIsNotModified(
      etagStr,
      f.httpDateSecs,
      null,
      decoder.decode(f.ifModifiedSinceHeader),
    ),
    "conditional: if-modified-since parity",
  );

  // ── Accept-Encoding negotiation (M4) ──
  const negotiator = rust.createAcceptNegotiator(["gzip", "br", "identity"]);
  assertEqual(
    negotiator.negotiate(f.acceptEncodingHeader),
    nativeNegotiateEncoding(
      ["gzip", "br", "identity"],
      decoder.decode(f.acceptEncodingHeader),
    ),
    "accept-encoding negotiate parity",
  );
  assertEqual(
    negotiator.negotiate(encoder.encode("gzip;q=0, *;q=1")),
    "br",
    "accept-encoding: gzip q=0 disables gzip only; br via wildcard",
  );
  assertEqual(
    negotiator.negotiate(encoder.encode("gzip;q=0, br;q=0, *;q=0")),
    null,
    "accept-encoding: all disabled → identity",
  );

  // ── Base64 / hex encoding (M5) ──
  assertEqual(
    decoder.decode(rust.base64Encode(f.encodeData)),
    decoder.decode(nativeBase64Encode(f.encodeData)),
    "base64 encode parity",
  );
  assertEqual(
    decoder.decode(rust.base64UrlEncode(f.encodeData)),
    Buffer.from(f.encodeData).toString("base64url"),
    "base64url encode parity",
  );
  assertEqual(
    decoder.decode(rust.hexEncode(f.encodeData)),
    decoder.decode(nativeHexEncode(f.encodeData)),
    "hex encode parity",
  );
  const b64Sample = encoder.encode(Buffer.from(f.encodeData).toString("base64"));
  const hexSample = encoder.encode(Buffer.from(f.encodeData).toString("hex"));
  assertEqual(
    decoder.decode(rust.base64Decode(b64Sample)),
    decoder.decode(nativeBase64Decode(b64Sample)),
    "base64 decode parity",
  );
  assertEqual(
    decoder.decode(rust.hexDecode(hexSample)),
    decoder.decode(nativeHexDecode(hexSample)),
    "hex decode parity",
  );

  // ── Cookie signing (M6) ──
  const cookieSigner = rust.createCookieSigner(f.cookieSecret);
  const signedCookie = cookieSigner.sign(f.cookieValue);
  assertEqual(
    decoder.decode(signedCookie),
    decoder.decode(nativeSignCookie(f.cookieValue, f.cookieSecret)),
    "cookie sign parity",
  );
  assertEqual(
    decoder.decode(cookieSigner.verify(signedCookie) ?? new Uint8Array(0)),
    decoder.decode(f.cookieValue),
    "cookie verify roundtrip",
  );
  assertEqual(
    cookieSigner.verify(encoder.encode("tampered.deadbeef")) === null,
    true,
    "cookie verify rejects tampered",
  );
  assertEqual(
    rust.batch.verifyCookie(
      [signedCookie, encoder.encode("bad.deadbeef")],
      f.cookieSecret,
    )[0],
    1,
    "cookie verify batch bitset",
  );

  // ── CSRF (M7) ──
  const csrfProtector = rust.createCsrfProtector(f.csrfSecret);
  const csrfTok = csrfProtector.create();
  assertEqual(csrfProtector.verify(csrfTok), true, "csrf verify roundtrip");
  assertEqual(
    csrfProtector.verify(encoder.encode("deadbeef.deadbeef")),
    false,
    "csrf verify rejects tampered",
  );
  assertEqual(
    rust.batch.csrfVerify(
      [csrfTok, encoder.encode("bad.bad")],
      f.csrfSecret,
    )[0],
    1,
    "csrf batch bitset",
  );
  assertEqual(
    nativeCsrfVerify(csrfTok, f.csrfSecret),
    true,
    "csrf verify parity with native baseline",
  );

  // ── URL join / building (M8) ──
  assertEqual(
    decoder.decode(rust.urlResolve(f.urlBase, f.urlReference)),
    decoder.decode(nativeUrlResolve(f.urlBase, f.urlReference)),
    "url resolve parity",
  );
  assertEqual(
    decoder.decode(rust.urlEncodeQuery(f.urlQueryParams)),
    decoder.decode(nativeUrlEncodeQuery(f.urlQueryParams)),
    "url query build parity",
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