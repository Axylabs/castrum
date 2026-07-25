import * as native from "../../baseline";
import { rust, rustBatch } from "../../rust-ffi/raw";
import type { ComplexFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function complexTasks(c: ComplexFixtures): BenchTask[] {
  return [
    // ── Large JSON payloads ──
    {
      name: "native:json_valid_large",
      run: () => native.nativeJsonValid(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: "rust:json_valid_large",
      run: () => rust.jsonValid(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: "native:json_sum_large",
      run: () => native.nativeJsonSum(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: "rust:json_sum_large",
      run: () => rust.jsonSumIds(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },

    // ── Huge JSON payloads ──
    {
      name: "native:json_valid_huge",
      run: () => native.nativeJsonValid(c.jsonHuge),
      iterations: 10,
      warmup: 3,
    },
    {
      name: "rust:json_valid_huge",
      run: () => rust.jsonValid(c.jsonHuge),
      iterations: 10,
      warmup: 3,
    },

    // ── Deep nested JSON ──
    {
      name: "native:json_valid_deep",
      run: () => native.nativeJsonValid(c.jsonNestedDeep),
      iterations: 100,
      warmup: 20,
    },
    {
      name: "rust:json_valid_deep",
      run: () => rust.jsonValid(c.jsonNestedDeep),
      iterations: 100,
      warmup: 20,
    },

    // ── Complex HTTP ──
    {
      name: "native:http_parse_complex",
      run: () => native.nativeHttpParseRequestPacked(c.httpComplex).byteLength,
      iterations: 200,
      warmup: 50,
    },
    {
      name: "rust:http_parse_complex",
      run: () => rust.httpParseRequestPacked(c.httpComplex).byteLength,
      iterations: 200,
      warmup: 50,
    },

    // ── Huge HTTP ──
    {
      name: "native:http_parse_huge",
      run: () => native.nativeHttpParseRequestPacked(c.httpHuge).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: "rust:http_parse_huge",
      run: () => rust.httpParseRequestPacked(c.httpHuge).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Large cookie string ──
    {
      name: "native:cookie_parse_large",
      run: () => native.nativeCookieParsePacked(c.cookieLarge).byteLength,
      iterations: 200,
      warmup: 50,
    },
    {
      name: "rust:cookie_parse_large",
      run: () => rust.cookieParsePacked(c.cookieLarge).byteLength,
      iterations: 200,
      warmup: 50,
    },

    // ── Complex query string ──
    {
      name: "native:query_parse_complex",
      run: () => native.nativeQueryParsePacked(c.queryComplex).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: "rust:query_parse_complex",
      run: () => rust.queryParsePacked(c.queryComplex).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Large URL encode/decode ──
    {
      name: "native:url_encode_large",
      run: () => native.nativeUrlEncode(c.urlLarge).length,
      iterations: 100,
      warmup: 20,
    },
    {
      name: "rust:url_encode_large",
      run: () => rust.urlEncode(c.urlLarge).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: "native:url_decode_large",
      run: () => native.nativeUrlDecode(c.urlLarge).length,
      iterations: 100,
      warmup: 20,
    },
    {
      name: "rust:url_decode_large",
      run: () => rust.urlDecode(c.urlLarge).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Batch operations ──
    {
      name: "native:json_valid_batch",
      run: () =>
        c.batchJsonDocs.reduce(
          (acc, doc) => acc + (native.nativeJsonValid(doc) ? 1 : 0),
          0,
        ),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "rust:json_valid_batch",
      run: () => rustBatch.jsonValid(c.batchJsonDocs).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "native:validate_email_batch",
      run: () =>
        c.batchEmails.reduce(
          (acc, e) => acc + (native.nativeValidateEmail(e) ? 1 : 0),
          0,
        ),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "rust:validate_email_batch",
      run: () =>
        rustBatch.validateEmail(c.batchEmails).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "native:validate_uuid_batch",
      run: () =>
        c.batchUuids.reduce(
          (acc, u) => acc + (native.nativeValidateUuid(u) ? 1 : 0),
          0,
        ),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "rust:validate_uuid_batch",
      run: () =>
        rustBatch.validateUuid(c.batchUuids).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "native:validate_ipv4_batch",
      run: () =>
        c.batchIpv4s.reduce(
          (acc, ip) => acc + (native.nativeValidateIpv4(ip) ? 1 : 0),
          0,
        ),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "rust:validate_ipv4_batch",
      run: () =>
        rustBatch.validateIpv4(c.batchIpv4s).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: "native:query_parse_batch",
      run: () =>
        c.batchQueries.reduce(
          (acc, q) => acc + native.nativeQueryParsePacked(q).byteLength,
          0,
        ),
      iterations: 30,
      warmup: 5,
    },
    {
      name: "rust:query_parse_batch",
      run: () =>
        rustBatch
          .queryParse(c.batchQueries)
          .reduce((acc, bytes) => acc + bytes.byteLength, 0),
      iterations: 30,
      warmup: 5,
    },
  ];
}