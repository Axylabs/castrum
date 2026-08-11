//! JSON & schema (zero-DOM validate/sum + DOM parse + fast schema engine).
//
//   - json_ops.rs       zero-DOM validate/sum + DOM parse
//   - json_ser.rs       zero-alloc JSON escaping + cookie/query → JSON writers
//   - json_patch_ops.rs RFC 6902 JSON patch
//   - json_schema.rs    SchemaValidator napi class (fast + fallback)
//   - fast_schema/      zero-DOM JSON Schema fast path (compiles the common
//                       keyword subset into a FastNode AST; unsupported
//                       keywords fall back to the jsonschema crate DOM path)

pub mod fast_schema;
pub mod json_ops;
pub mod json_patch_ops;
pub mod json_schema;
pub mod json_ser;
