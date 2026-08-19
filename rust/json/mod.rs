//! JSON & schema (zero-DOM validate/sum + DOM parse + fast schema engine).
//
//   - json_ops.rs       zero-DOM validate/sum + DOM parse
//   - json_ser.rs       zero-alloc JSON escaping + cookie/query → JSON writers
//   - patch/            RFC 6902 JSON patch (pointer/ops/engine/api)
//   - json_schema.rs    SchemaValidator napi class (fast + fallback)
//   - napi_marshal.rs   sonic_rs::Value → JS marshaling + sonic values_equal
//                       (serde_json::Value DOM swap; jsonschema-compatible
//                       equality for fast_schema enum/const/uniqueItems)
//   - fast_schema/      zero-DOM JSON Schema fast path (compiles the common
//                       keyword subset into a FastNode AST; unsupported
//                       keywords fall back to the jsonschema crate DOM path)

pub mod fast_schema;
pub mod json_ops;
pub mod json_schema;
pub mod json_ser;
pub mod napi_marshal;
pub mod patch;
