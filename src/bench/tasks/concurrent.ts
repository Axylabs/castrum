// src/bench/tasks/concurrent.ts — CPU benchmark tasks: concurrent worker scenario.

import type { BenchFixtures, ComplexFixtures } from '../fixtures'
import type { ConcurrentBenchTask } from '../types'

export function concurrentTasks(f: BenchFixtures, c: ComplexFixtures): ConcurrentBenchTask[] {
  return [
    // ── JSON validation: medium concurrency ──
    {
      name: 'native:json_valid_concurrent_10',
      op: 'native:json_valid',
      payload: f.jsonPayload,
      concurrency: 10,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:json_valid_concurrent_10',
      op: 'rust:json_valid',
      payload: f.jsonPayload,
      concurrency: 10,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },

    // ── JSON validation: high concurrency ──
    {
      name: 'native:json_valid_concurrent_50',
      op: 'native:json_valid',
      payload: f.jsonPayload,
      concurrency: 50,
      iterationsPerSlot: 20,
      warmupPerSlot: 2,
    },
    {
      name: 'rust:json_valid_concurrent_50',
      op: 'rust:json_valid',
      payload: f.jsonPayload,
      concurrency: 50,
      iterationsPerSlot: 20,
      warmupPerSlot: 2,
    },

    // ── HTTP parse burst ──
    {
      name: 'native:http_parse_concurrent_20',
      op: 'native:http_parse',
      payload: f.httpRaw,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:http_parse_concurrent_20',
      op: 'rust:http_parse',
      payload: f.httpRaw,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },

    // ── HMAC burst ──
    {
      name: 'native:hmac_sha256_concurrent_20',
      op: 'native:hmac_sha256',
      payload: {
        key: f.hmacKey,
        data: f.hmacData,
      },
      concurrency: 20,
      iterationsPerSlot: 30,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:hmac_sha256_concurrent_20',
      op: 'rust:hmac_sha256',
      payload: {
        key: f.hmacKey,
        data: f.hmacData,
      },
      concurrency: 20,
      iterationsPerSlot: 30,
      warmupPerSlot: 5,
    },

    // ── Validation burst: email ──
    {
      name: 'native:validate_email_concurrent_50',
      op: 'native:validate_email',
      payload: f.emailOk,
      concurrency: 50,
      iterationsPerSlot: 40,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:validate_email_concurrent_50',
      op: 'rust:validate_email',
      payload: f.emailOk,
      concurrency: 50,
      iterationsPerSlot: 40,
      warmupPerSlot: 5,
    },

    // ── Validation burst: uuid ──
    {
      name: 'native:validate_uuid_concurrent_50',
      op: 'native:validate_uuid',
      payload: f.uuidOk,
      concurrency: 50,
      iterationsPerSlot: 40,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:validate_uuid_concurrent_50',
      op: 'rust:validate_uuid',
      payload: f.uuidOk,
      concurrency: 50,
      iterationsPerSlot: 40,
      warmupPerSlot: 5,
    },

    // ── Query parse burst ──
    {
      name: 'native:query_parse_concurrent_20',
      op: 'native:query_parse',
      payload: f.queryStr,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:query_parse_concurrent_20',
      op: 'rust:query_parse',
      payload: f.queryStr,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },

    // ── Cookie parse burst ──
    {
      name: 'native:cookie_parse_concurrent_20',
      op: 'native:cookie_parse',
      payload: f.cookieStr,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },
    {
      name: 'rust:cookie_parse_concurrent_20',
      op: 'rust:cookie_parse',
      payload: f.cookieStr,
      concurrency: 20,
      iterationsPerSlot: 50,
      warmupPerSlot: 5,
    },

    // ── CRC32 burst ──
    {
      name: 'native:crc32_concurrent_20',
      op: 'native:crc32',
      payload: f.crcInput,
      concurrency: 20,
      iterationsPerSlot: 100,
      warmupPerSlot: 10,
    },
    {
      name: 'rust:crc32_concurrent_20',
      op: 'rust:crc32',
      payload: f.crcInput,
      concurrency: 20,
      iterationsPerSlot: 100,
      warmupPerSlot: 10,
    },

    // ── JSON sum burst ──
    {
      name: 'native:json_sum_concurrent_20',
      op: 'native:json_sum',
      payload: f.jsonPayload,
      concurrency: 20,
      iterationsPerSlot: 20,
      warmupPerSlot: 3,
    },
    {
      name: 'rust:json_sum_concurrent_20',
      op: 'rust:json_sum',
      payload: f.jsonPayload,
      concurrency: 20,
      iterationsPerSlot: 20,
      warmupPerSlot: 3,
    },

    // ── Batch JSON validation burst ──
    {
      name: 'native:json_valid_batch_concurrent_10',
      op: 'native:json_valid_batch',
      payload: c.batchJsonDocs,
      concurrency: 10,
      iterationsPerSlot: 20,
      warmupPerSlot: 3,
    },
    {
      name: 'rust:json_valid_batch_concurrent_10',
      op: 'rust:json_valid_batch_packed',
      payload: c.batchJsonDocs,
      concurrency: 10,
      iterationsPerSlot: 20,
      warmupPerSlot: 3,
    },
  ]
}
