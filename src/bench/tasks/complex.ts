// src/bench/tasks/complex.ts — CPU benchmark tasks: complex multi-op scenarios.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
// Public `rustBatch` alias removed in 0.8.0 — bench-local shorthand.
const rustBatch = rust.batch
import { rawUrlDecode, rawUrlEncode } from '../raw-native'
import type { ComplexFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function complexTasks(c: ComplexFixtures): BenchTask[] {
  return [
    // ── Large JSON payloads ──
    {
      name: 'native:json_valid_large',
      run: () => native.nativeJsonValid(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: 'rust:json_valid_large',
      run: () => rust.jsonValid(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: 'native:json_sum_large',
      run: () => native.nativeJsonSum(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },
    {
      name: 'rust:json_sum_large',
      run: () => rust.jsonSumIds(c.jsonLarge),
      iterations: 20,
      warmup: 5,
    },

    // ── Huge JSON payloads ──
    {
      name: 'native:json_valid_huge',
      run: () => native.nativeJsonValid(c.jsonHuge),
      iterations: 10,
      warmup: 3,
    },
    {
      name: 'rust:json_valid_huge',
      run: () => rust.jsonValid(c.jsonHuge),
      iterations: 10,
      warmup: 3,
    },

    // ── Deep nested JSON ──
    {
      name: 'native:json_valid_deep',
      run: () => native.nativeJsonValid(c.jsonNestedDeep),
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'rust:json_valid_deep',
      run: () => rust.jsonValid(c.jsonNestedDeep),
      iterations: 100,
      warmup: 20,
    },

    // ── Complex HTTP ──
    {
      name: 'native:http_parse_complex',
      run: () => native.nativeHttpParseRequestPacked(c.httpComplex).byteLength,
      iterations: 200,
      warmup: 50,
    },
    {
      name: 'rust:http_parse_complex',
      run: () => rust.httpParseRequestPacked(c.httpComplex).byteLength,
      iterations: 200,
      warmup: 50,
    },

    // ── Huge HTTP ──
    {
      name: 'native:http_parse_huge',
      run: () => native.nativeHttpParseRequestPacked(c.httpHuge).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'rust:http_parse_huge',
      run: () => rust.httpParseRequestPacked(c.httpHuge).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Large cookie string ──
    {
      name: 'native:cookie_parse_large',
      run: () => native.nativeCookieParsePacked(c.cookieLarge).byteLength,
      iterations: 200,
      warmup: 50,
    },
    {
      name: 'rust:cookie_parse_large',
      run: () => rust.cookieParsePacked(c.cookieLarge).byteLength,
      iterations: 200,
      warmup: 50,
    },

    // ── Complex query string ──
    {
      name: 'native:query_parse_complex',
      run: () => native.nativeQueryParsePacked(c.queryComplex).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'rust:query_parse_complex',
      run: () => rust.queryParsePacked(c.queryComplex).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Large URL encode/decode ──
    {
      name: 'native:url_encode_large',
      run: () => native.nativeUrlEncode(c.urlLarge).length,
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'rust:url_encode_large',
      // Public `rust.urlEncode` delegates to `encodeURIComponent` under Bun
      // (BUN_WINS) — measure the raw addon for the large-input variant too.
      run: () => rawUrlEncode(c.urlLarge).byteLength,
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'native:url_decode_large',
      run: () => native.nativeUrlDecode(c.urlLarge).length,
      iterations: 100,
      warmup: 20,
    },
    {
      name: 'rust:url_decode_large',
      run: () => rawUrlDecode(c.urlLarge).byteLength,
      iterations: 100,
      warmup: 20,
    },

    // ── Batch operations ──
    {
      name: 'native:json_valid_batch',
      run: () =>
        c.batchJsonDocs.reduce((acc, doc) => acc + (native.nativeJsonValid(doc) ? 1 : 0), 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'rust:json_valid_batch',
      run: () => rustBatch.jsonValid(c.batchJsonDocs).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'native:validate_email_batch',
      run: () => c.batchEmails.reduce((acc, e) => acc + (native.nativeValidateEmail(e) ? 1 : 0), 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'rust:validate_email_batch',
      run: () => rustBatch.validateEmail(c.batchEmails).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'native:validate_uuid_batch',
      run: () => c.batchUuids.reduce((acc, u) => acc + (native.nativeValidateUuid(u) ? 1 : 0), 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'rust:validate_uuid_batch',
      run: () => rustBatch.validateUuid(c.batchUuids).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'native:validate_ipv4_batch',
      run: () => c.batchIpv4s.reduce((acc, ip) => acc + (native.nativeValidateIpv4(ip) ? 1 : 0), 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'rust:validate_ipv4_batch',
      run: () => rustBatch.validateIpv4(c.batchIpv4s).reduce((acc, b) => acc + b, 0),
      iterations: 50,
      warmup: 10,
    },
    {
      name: 'native:query_parse_batch',
      run: () =>
        c.batchQueries.reduce((acc, q) => acc + native.nativeQueryParsePacked(q).byteLength, 0),
      iterations: 30,
      warmup: 5,
    },
    {
      name: 'rust:query_parse_batch',
      run: () =>
        rustBatch.queryParse(c.batchQueries).reduce((acc, bytes) => acc + bytes.byteLength, 0),
      iterations: 30,
      warmup: 5,
    },

    // ── Backend-framework feature batches ──
    {
      name: 'native:password_hash_batch',
      run: () =>
        c.batchPasswords.reduce(
          (acc, p) => acc + native.nativePasswordHash(p, c.passwordSalt).byteLength,
          0,
        ),
      iterations: 3,
      warmup: 1,
    },
    {
      name: 'rust:password_hash_batch',
      run: () =>
        rustBatch
          .passwordHash(c.batchPasswords, c.passwordSalt, {
            mCost: 4096,
            tCost: 1,
            pCost: 1,
          })
          .reduce((acc, phc) => acc + phc.byteLength, 0),
      iterations: 3,
      warmup: 1,
    },
    {
      name: 'native:jwt_verify_batch',
      run: () =>
        c.batchTokens.reduce(
          (acc, t) => acc + (native.nativeJwtVerify(t, c.batchSecret, c.batchNow) ? 1 : 0),
          0,
        ),
      iterations: 30,
      warmup: 5,
    },
    {
      name: 'rust:jwt_verify_batch',
      run: () =>
        rustBatch
          .jwtVerify(c.batchTokens, c.batchSecret, c.batchNow)
          .reduce((acc, b) => acc + b, 0),
      iterations: 30,
      warmup: 5,
    },
    {
      name: 'native:gzip_compress_batch',
      run: () =>
        c.batchCompressItems.reduce(
          (acc, item) => acc + native.nativeGzipCompress(item).byteLength,
          0,
        ),
      iterations: 20,
      warmup: 5,
    },
    {
      name: 'rust:gzip_compress_batch',
      run: () =>
        rustBatch
          .gzipCompress(c.batchCompressItems)
          .reduce((acc, bytes) => acc + bytes.byteLength, 0),
      iterations: 20,
      warmup: 5,
    },
    {
      name: 'native:template_render_batch',
      run: () =>
        c.batchContexts.reduce(
          (acc, ctx) =>
            acc +
            native.nativeTemplateRender(
              c.templateSource,
              JSON.parse(new TextDecoder().decode(ctx)) as Record<string, unknown>,
            ).length,
          0,
        ),
      iterations: 30,
      warmup: 5,
    },
    {
      name: 'rust:template_render_batch',
      run: () =>
        rustBatch
          .templateRender(c.templateSource, c.batchContexts)
          .reduce((acc, bytes) => acc + bytes.byteLength, 0),
      iterations: 30,
      warmup: 5,
    },
  ]
}
