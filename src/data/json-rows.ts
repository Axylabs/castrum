// src/data/json-rows.ts — generated JSON row fixtures + row types for benchmarks.

import { encoder } from '../shared/bytes'

/** Nested metadata embedded in every generated JSON row. */
export interface JsonRowNested {
  version: number
  createdAt: string
}

/** One generated JSON fixture row (matches the JSON-path bench fixture shape). */
export interface JsonRow {
  id: number
  name: string
  active: boolean
  score: number
  tags: string[]
  nested: JsonRowNested
}

/** Generate `rows` JSON fixture rows (deterministic, shared with the bench). */
export function createJsonRows(rows: number): JsonRow[] {
  return Array.from({ length: rows }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    active: i % 2 === 0,
    score: i * 1.25,
    tags: ['alpha', 'beta', 'gamma'],
    nested: {
      version: i % 10,
      createdAt: '2026-01-01T00:00:00Z',
    },
  }))
}

/** Serialize `rows` generated rows to UTF-8 bytes. */
export function jsonRowsBytes(rows: number): Uint8Array {
  return encoder.encode(JSON.stringify(createJsonRows(rows)))
}
