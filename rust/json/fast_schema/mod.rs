// rust/json/fast_schema/mod.rs — Zero-DOM JSON Schema validation (common keyword subset).
//
// Why this exists: `jsonschema::Validator::is_valid` requires a
// `serde_json::Value`, so the default path parses every document into a heap
// DOM. We measured that DOM build at ~95% of the validation cost for the bench
// fixture. This module instead compiles the same schema into a tiny structural
// AST (`types.rs`) and validates documents with a single, allocation-free pass
// over the raw bytes (`cursor.rs` + `validate.rs`) — no `serde_json::Value`,
// no per-key `String`s, no `BTreeMap`/`IndexMap`.
//
// Versatility is preserved: `compile` (`compile.rs`) returns `Err(())` for any
// schema using a keyword outside the supported subset (regex, format,
// anyOf/oneOf/allOf/not, $ref, enum/const, multipleOf, uniqueItems, …). The
// caller then falls back to the full `jsonschema` crate path, so the fast path
// only ever runs on schemas it can prove equivalent to the reference semantics.
//
// Limitations (accepted): documents must be well-formed UTF-8 JSON; malformed
// escapes/UTF-8 that the reference parser rejects may slip through. The
// fallback DOM path is authoritative for all inputs.
//
// Module split:
//   - types.rs     the compiled AST (FastNode + per-kind constraint structs)
//   - cursor.rs    byte-level JSON cursor + string/unicode helpers
//   - compile.rs   schema (serde_json::Value) → AST compiler
//   - validate.rs  AST + raw bytes → boolean validation
//   - tests.rs     fast-vs-jsonschema-crate parity tests

mod compile;
mod cursor;
mod types;
mod validate;

#[cfg(test)]
mod tests;

pub use self::compile::compile;
pub use self::types::FastNode;
