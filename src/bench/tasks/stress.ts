import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures, ComplexFixtures } from "../fixtures";
import type { StressBenchTask } from "../types";

export function stressTasks(
  f: BenchFixtures,
  _c: ComplexFixtures,
): StressBenchTask[] {
  return [
    // ── JSON validation stress ──
    {
      name: "native:json_valid_stress",
      run: () => native.nativeJsonValid(f.jsonPayload),
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:json_valid_stress",
      run: () => rust.jsonValid(f.jsonPayload),
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── JSON sum stress ──
    {
      name: "native:json_sum_stress",
      run: () => native.nativeJsonSum(f.jsonPayload),
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:json_sum_stress",
      run: () => rust.jsonSumIds(f.jsonPayload),
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── HTTP parse stress ──
    {
      name: "native:http_parse_stress",
      run: () => native.nativeHttpParseRequestPacked(f.httpRaw).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:http_parse_stress",
      run: () => rust.httpParseRequestPacked(f.httpRaw).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── HMAC stress ──
    {
      name: "native:hmac_sha256_stress",
      run: () => native.nativeHmacSha256(f.hmacKey, f.hmacData).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:hmac_sha256_stress",
      run: () => rust.hmacSha256(f.hmacKey, f.hmacData).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── CRC32 stress ──
    {
      name: "native:crc32_stress",
      run: () => native.nativeCrc32(f.crcInput),
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:crc32_stress",
      run: () => rust.crc32(f.crcInput),
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── Query parse stress ──
    {
      name: "native:query_parse_stress",
      run: () => native.nativeQueryParsePacked(f.queryStr).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:query_parse_stress",
      run: () => rust.queryParsePacked(f.queryStr).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── Email validation stress ──
    {
      name: "native:validate_email_stress",
      run: () => (native.nativeValidateEmail(f.emailOk) ? 1 : 0),
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:validate_email_stress",
      run: () => rust.validateEmail(f.emailOk),
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── UUID validation stress ──
    {
      name: "native:validate_uuid_stress",
      run: () => (native.nativeValidateUuid(f.uuidOk) ? 1 : 0),
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:validate_uuid_stress",
      run: () => rust.validateUuid(f.uuidOk),
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── Cookie parse stress ──
    {
      name: "native:cookie_parse_stress",
      run: () => native.nativeCookieParsePacked(f.cookieStr).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:cookie_parse_stress",
      run: () => rust.cookieParsePacked(f.cookieStr).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    // ── WebSocket accept stress ──
    {
      name: "native:ws_accept_key_stress",
      run: () => native.nativeWsAcceptKey(f.wsKey).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
    {
      name: "rust:ws_accept_key_stress",
      run: () => rust.wsAcceptKey(f.wsKeyBytes).byteLength,
      durationMs: 2000,
      warmupMs: 200,
    },
  ];
}