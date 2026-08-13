// rust/json/fast_schema/mod.rs — Zero-DOM JSON Schema validation.
//
// Why this exists: `jsonschema::Validator::is_valid` requires a
// `serde_json::Value`, so the default path parses every document into a heap
// DOM. We measured that DOM build at ~95% of the validation cost for the bench
// fixture. This module instead compiles the same schema into a tiny structural
// AST (`types.rs`) and validates documents with a single pass over the raw
// bytes (`cursor.rs` + `validate.rs`) — no `serde_json::Value`, no per-key
// `String`s, no `BTreeMap`/`IndexMap`.
//
// Coverage (draft-07): type, enum, const, multipleOf, minimum/maximum,
// exclusiveMinimum/exclusiveMaximum (numeric), minLength/maxLength, pattern
// (fancy-regex, same engine as jsonschema), items (single + tuple),
// additionalItems, minItems/maxItems, uniqueItems, contains, minProperties/
// maxProperties, required, properties, patternProperties, additionalProperties,
// dependencies (array form), if/then/else, allOf, anyOf, oneOf, not, in-document
// $ref, format: "email".
//
// Versatility is preserved: `compile` (`compile.rs`) returns `Err(())` for any
// schema using a keyword outside the supported subset (propertyNames,
// dependencies-with-schema, boolean exclusive bounds, other formats,
// remote/dynamic/anchor refs, non-draft-07 `$schema`). The caller then falls
// back to the full `jsonschema` crate path, so the fast path only ever runs on
// schemas it can prove equivalent to the reference semantics.
//
// Validation runs in two modes (validate.rs): bool mode (`Ctx::bool_mode`) is
// allocation-free for the core subset; detailed mode (`validate_errors`)
// collects `SchemaError`s carrying an instance JSON pointer, schema pointer,
// keyword, and message.
//
// Limitations (accepted): documents must be well-formed UTF-8 JSON; malformed
// escapes/UTF-8 that the reference parser rejects may slip through. The
// fallback DOM path is authoritative for all inputs.
//
// Module split:
//   - types.rs     the compiled AST (FastNode + per-kind constraint structs)
//   - cursor.rs    byte-level JSON cursor + string/unicode helpers
//   - compile.rs   schema (serde_json::Value) → AST compiler
//   - validate.rs  AST + raw bytes → validation (bool or detailed errors)
//   - errors.rs    error sink/context + SchemaError (instance/schema paths)
//   - tests.rs     fast-vs-jsonschema-crate parity tests

mod capture;
mod compile;
mod cursor;
mod email;
mod errors;
mod types;
mod validate;

#[cfg(test)]
mod tests;

pub use self::capture::{parse_target, Capture, CaptureKind, TargetPath};
pub use self::compile::compile;
pub use self::errors::SchemaError;
pub use self::types::FastNode;
