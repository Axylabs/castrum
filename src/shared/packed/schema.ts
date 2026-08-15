// src/shared/packed/schema.ts — Native JSON-Schema validator + batch helpers.
//
// Thin wrapper over the native `SchemaValidator` instance: single-item handle
// alias plus packed-batch validate helpers (bitset / count). The batch entry
// points reuse the pure pack-scratch pool from ./wire.ts.

import type { SchemaValidatorInstance } from '../../native'
import { unpackBitset, withPackScratch } from './wire'

/** Native JSON-Schema validator handle (see `createSchemaValidator`). */
export type SchemaValidator = SchemaValidatorInstance

/** Validate each item against `validator`; returns a packed validity bitset. */
export function schemaValidateBatch(validator: SchemaValidator, items: Uint8Array[]): Uint8Array {
  return withPackScratch(items, (packed) =>
    unpackBitset(validator.validateBatchPackedBitset(packed)),
  )
}

/** Validate each item against `validator`; returns the count of valid items. */
export function schemaValidateBatchCount(validator: SchemaValidator, items: Uint8Array[]): number {
  return withPackScratch(items, (packed) => validator.validateBatchPackedCount(packed))
}
