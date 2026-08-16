// src/bench/assert.ts — assertion helpers for the CPU-bench correctness checks.

import { decoder, encoder } from '../shared/bytes'

/**
 * Normalize the string-or-bytes union (the text-returning `rust.*` ops return
 * STRINGS on the Bun path — native transfer — and bytes on the napi path) to
 * bytes. Bench-local helper used to compare against byte-producing baselines.
 */
export function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? encoder.encode(v) : v
}

/**
 * Normalize the string-or-bytes union to a string. Bench-local helper used to
 * compare string-producing rust.* results against decoded baseline bytes.
 */
export function toText(v: Uint8Array | string): string {
  return typeof v === 'string' ? v : decoder.decode(v)
}

/**
 * Recursively sort object keys. Bench-local helper used by `assertDeepEqual`
 * to make key order irrelevant when comparing parsed JSON (serde_json /
 * sonic_rs may return a different key order than the JS baseline). It lives in
 * `src/bench/` (not `src/shared/`) because it exists solely for the benchmark
 * correctness checks.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}

  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key])
  }

  return sorted
}

export function parseJsonBytes(bytes: Uint8Array | string): unknown {
  return JSON.parse(typeof bytes === 'string' ? bytes : decoder.decode(bytes))
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Uint8Array) return 'Uint8Array'
  return typeof value
}

/**
 * Some Bun/NAPI builds return Rust i64/u64 as number when the value fits
 * inside Number.MAX_SAFE_INTEGER, while baseline code returns bigint.
 *
 * For benchmark correctness checks, integer number and bigint should be
 * treated as equal when their numeric value is the same.
 */
function normalizeScalar(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value
  }

  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(Math.trunc(value))
  }

  return value
}

export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = normalizeScalar(actual)
  const b = normalizeScalar(expected)

  if (a !== b) {
    console.error(`FAIL: ${label}`)
    console.error(`  actual:   ${String(actual)} (${typeName(actual)})`)
    console.error(`  expected: ${String(expected)} (${typeName(expected)})`)
    process.exit(1)
    throw new Error(`Assertion failed: ${label}`)
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(sortKeys(actual))
  const b = JSON.stringify(sortKeys(expected))

  if (a !== b) {
    console.error(`FAIL: ${label}`)
    console.error(`  actual:   ${a}`)
    console.error(`  expected: ${b}`)
    process.exit(1)
    throw new Error(`Assertion failed: ${label}`)
  }
}
