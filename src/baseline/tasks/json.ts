// src/baseline/tasks/json.ts
import { decoder, encoder } from '../../shared/bytes'

/**
 * Older Bun builds accepted Uint8Array directly in JSON.parse().
 * Bun 1.4 canary builds may reject it.
 *
 * We feature-detect once. If byte parsing is supported, use it.
 * Otherwise fall back to standard UTF-8 decode + JSON.parse.
 */
const JSON_PARSE_BYTES_SUPPORTED: boolean = (() => {
  try {
    JSON.parse(encoder.encode('{"a":1}') as any)
    return true
  } catch {
    return false
  }
})()

const parseJsonBytes: (bytes: Uint8Array) => unknown = JSON_PARSE_BYTES_SUPPORTED
  ? (bytes) => JSON.parse(bytes as any)
  : (bytes) => JSON.parse(decoder.decode(bytes))

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    parseJsonBytes(bytes)
    return true
  } catch {
    return false
  }
}

/** Baseline `JSON.parse` — returns the parsed value (or throws on invalid). */
export function nativeJsonParse(bytes: Uint8Array): unknown {
  return parseJsonBytes(bytes)
}

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const parsed = parseJsonBytes(bytes)

  if (!Array.isArray(parsed)) {
    return 0n
  }

  let sum = 0n

  for (const row of parsed as Array<{ id?: unknown }>) {
    if (typeof row.id === 'number' && Number.isFinite(row.id)) {
      sum += BigInt(Math.trunc(row.id))
    }
  }

  return sum
}
