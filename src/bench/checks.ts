import * as native from "../baseline";
import { rust } from "../rust-ffi/raw";
import { decoder } from "../shared/bytes";
import { assertDeepEqual, assertEqual, parseJsonBytes } from "./assert";
import type { BenchFixtures } from "./fixtures";

export function runCorrectnessChecks(f: BenchFixtures): void {
  assertEqual(
    native.nativeJsonValid(f.jsonPayload),
    rust.jsonValid(f.jsonPayload) === 1,
    "json valid",
  );

  assertEqual(
    native.nativeJsonSum(f.jsonPayload),
    rust.jsonSumIds(f.jsonPayload),
    "json sum",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeHttpParseRequest(f.httpRaw)),
    parseJsonBytes(rust.httpParseRequest(f.httpRaw)),
    "http parse",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeQueryParse(f.queryStr)),
    parseJsonBytes(rust.queryParse(f.queryStr)),
    "query parse",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeCookieParse(f.cookieStr)),
    parseJsonBytes(rust.cookieParse(f.cookieStr)),
    "cookie parse",
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
    rust.fnv1a64(f.crcInput),
    "fnv1a64",
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