// src/bench/tasks/json-schema.ts — JSON Schema validation benchmarks.
//
// Native (jsonschema crate via SchemaValidator) vs JS baseline (ajv). Covers
// both single-document and batch validation.

import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import { nativeJsonSchemaValidate, nativeJsonSchemaValidateBatch } from '../schema-baseline'
import type { BenchTask } from '../types'

export function jsonSchemaTasks(f: BenchFixtures): BenchTask[] {
  // Compile the native validator once (schema compilation is a one-time cost).
  const validator = rust.createSchemaValidator(f.jsonSchema)

  return [
    {
      name: 'native:json_schema_validate',
      run: () => nativeJsonSchemaValidate(f.schemaDoc, f.jsonSchema),
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'rust:json_schema_validate',
      run: () => validator.validate(f.schemaDoc),
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'native:json_schema_validate_batch',
      run: () => nativeJsonSchemaValidateBatch(f.schemaDocs, f.jsonSchema),
      iterations: 50,
      warmup: 5,
    },
    {
      name: 'rust:json_schema_validate_batch',
      run: () => rust.batch.schemaValidateCount(validator, f.schemaDocs),
      iterations: 50,
      warmup: 5,
    },
  ]
}
