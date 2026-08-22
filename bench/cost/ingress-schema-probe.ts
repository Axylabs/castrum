// bench/cost/ingress-schema-probe.ts — isolate the per-request schema cost on
// the bench body: measure the opaque-handle `SchemaValidator.validate` (fast
// path when engaged) vs the napi instance, plus a DOM-only comparison, so we
// know whether the ~214ns body-scan delta is the fast_schema walk or a DOM
// fallback for USER_SCHEMA.
//
// Run: `bun bench/cost/ingress-schema-probe.ts`
import { getBunFFI } from '../../src/native/ffi'
import { rust } from '../../src/rust-ffi'
import { USER_SCHEMA_BYTES } from '../http/servers/shared'
import { measureNs as measure } from '../measure'

const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

const BODY = new TextEncoder().encode('{"id":1,"name":"stress_test"}')
const INVALID = new TextEncoder().encode('{"id":"not-a-number"}')

const validator = rust.createSchemaValidator(USER_SCHEMA_BYTES)
const tValidate = measure(() => validator.validate(BODY), 50_000)
const tValidateInvalid = measure(() => validator.validate(INVALID), 50_000)

// DOM-ish comparison: the DOM fallback parses to a Value (JSON.parse on the
// same bytes is the JS-visible proxy for that cost).
const tJsonParse = measure(() => JSON.parse(new TextDecoder().decode(BODY)), 50_000)

console.log('═══ schema probe (ns/op, min-of-5) ═══')
console.log(`  SchemaValidator.validate (valid)   : ${tValidate.toFixed(0).padStart(7)}`)
console.log(`  SchemaValidator.validate (invalid) : ${tValidateInvalid.toFixed(0).padStart(7)}`)
console.log(`  JSON.parse reference               : ${tJsonParse.toFixed(0).padStart(7)}`)
