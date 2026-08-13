// src/bench/schema-baseline.ts — JS JSON Schema baseline (ajv, draft-07).
//
// Deliberately lives under `src/bench/` (NOT the public `src/baseline` barrel)
// so the ajv devDependency never ships in the published package. `native:json_*`
// tasks measure the baseline; `rust:json_*` measure the native jsonschema path.

import Ajv from 'ajv'
import { decoder } from '../shared/bytes'

const ajv = new Ajv({ strict: false })

let cachedKey: string | null = null
let cachedValidate: ((data: unknown) => boolean) | null = null

function getValidator(schemaBytes: Uint8Array): (data: unknown) => boolean {
  const key = decoder.decode(schemaBytes)
  if (cachedValidate === null || cachedKey !== key) {
    const schema = JSON.parse(key) as object
    cachedValidate = ajv.compile(schema) as (data: unknown) => boolean
    cachedKey = key
  }
  return cachedValidate
}

/** Validate a single JSON document against `schema` with ajv. */
export function nativeJsonSchemaValidate(doc: Uint8Array, schema: Uint8Array): boolean {
  const validate = getValidator(schema)
  return validate(JSON.parse(decoder.decode(doc))) as boolean
}

/** Validate a batch of JSON documents; returns how many pass. */
export function nativeJsonSchemaValidateBatch(docs: Uint8Array[], schema: Uint8Array): number {
  const validate = getValidator(schema)
  let count = 0
  for (const doc of docs) {
    if (validate(JSON.parse(decoder.decode(doc)))) count++
  }
  return count
}
