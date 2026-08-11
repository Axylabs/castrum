// rust/json/fast_schema/types.rs — Compiled fast-path schema AST.
//
// `compile` (compile.rs) builds these nodes from a schema; `validate`
// (validate.rs) walks them against raw JSON bytes. Fields are `pub(crate)` so
// the sibling compile/validate modules can build and read them; the only
// public surface is `FastNode` (re-exported from mod.rs).

use rustc_hash::FxHashMap;
use std::sync::Arc;

pub(crate) const T_NULL: u8 = 1 << 0;
pub(crate) const T_BOOL: u8 = 1 << 1;
pub(crate) const T_NUM: u8 = 1 << 2;
pub(crate) const T_INT: u8 = 1 << 3;
pub(crate) const T_STR: u8 = 1 << 4;
pub(crate) const T_ARR: u8 = 1 << 5;
pub(crate) const T_OBJ: u8 = 1 << 6;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

pub(crate) fn kind_of(b: u8) -> Option<Kind> {
    match b {
        b'{' => Some(Kind::Object),
        b'[' => Some(Kind::Array),
        b'"' => Some(Kind::String),
        b't' | b'f' => Some(Kind::Boolean),
        b'n' => Some(Kind::Null),
        b'-' | b'0'..=b'9' => Some(Kind::Number),
        _ => None,
    }
}

pub(crate) struct FastString {
    pub(crate) min_len: Option<usize>,
    pub(crate) max_len: Option<usize>,
    /// `pattern` — compiled with fancy-regex (the SAME engine jsonschema uses)
    /// for exact ECMA-262 semantics (lookahead/backrefs). Matched UNANCHORED
    /// (is_match) against the decoded string, like the reference.
    pub(crate) pattern: Option<Arc<fancy_regex::Regex>>,
    /// `format: "email"` — validated on the (unescaped) string body via
    /// `super::email::is_valid_email_format` (byte-parity with jsonschema).
    pub(crate) format_email: bool,
}

pub(crate) struct FastNumber {
    pub(crate) minimum: Option<f64>,
    pub(crate) maximum: Option<f64>,
    pub(crate) exclusive_min: Option<f64>,
    pub(crate) exclusive_max: Option<f64>,
    /// `multipleOf` — exact divisibility via fraction::BigFraction, the same
    /// crate/type jsonschema uses (avoids f64 drift on e.g. 0.01).
    pub(crate) multiple_of: Option<f64>,
}

pub(crate) struct FastArray {
    /// `items` single-schema form (draft-07 non-tuple `items`, or the sole
    /// schema when `items` is not an array).
    pub(crate) items: Option<Arc<FastNode>>,
    /// draft-07 tuple form (`items` is an array of schemas).
    pub(crate) tuple_items: Option<Vec<Arc<FastNode>>>,
    /// draft-07 `additionalItems` (only meaningful alongside tuple items).
    pub(crate) additional_items: Option<Additional>,
    pub(crate) min_items: Option<usize>,
    pub(crate) max_items: Option<usize>,
    /// `uniqueItems` — duplicate detection over parsed element values.
    pub(crate) unique: bool,
    /// draft-07 `contains` — at least one element must validate.
    pub(crate) contains: Option<Arc<FastNode>>,
}

pub(crate) enum Additional {
    Allow,
    Deny,
    Schema(Arc<FastNode>),
}

/// draft-07 `dependencies` (array-of-required-strings form):
/// `(property, required-properties)` pairs.
pub(crate) type DependentRequired = Vec<(Box<[u8]>, Vec<Box<[u8]>>)>;

pub(crate) struct FastObject {
    pub(crate) props: FxHashMap<Box<[u8]>, Arc<FastNode>>,
    /// `patternProperties` — (regex, schema) pairs; a key matching a regex gets
    /// that schema (checked before `additionalProperties`).
    pub(crate) patterns: Vec<(fancy_regex::Regex, Arc<FastNode>)>,
    /// Maps required key -> bit index (0..=63); compile fails beyond 64.
    pub(crate) required: FxHashMap<Box<[u8]>, u32>,
    pub(crate) required_count: usize,
    pub(crate) additional: Additional,
    pub(crate) min_props: Option<usize>,
    pub(crate) max_props: Option<usize>,
    pub(crate) dependent_required: DependentRequired,
}

/// `(if, then, else)` — then/else are optional (draft-07).
pub(crate) type IfThenElse =
    (Arc<FastNode>, Option<Arc<FastNode>>, Option<Arc<FastNode>>);

/// Logical combinators: allOf / anyOf / oneOf / not / if-then-else.
pub(crate) struct FastComb {
    pub(crate) all_of: Vec<Arc<FastNode>>,
    pub(crate) any_of: Vec<Arc<FastNode>>,
    pub(crate) one_of: Vec<Arc<FastNode>>,
    pub(crate) not: Option<Arc<FastNode>>,
    pub(crate) if_then_else: Option<IfThenElse>,
}

/// `enum` / `const` constraints, stored as the schema's literal values and
/// compared with jsonschema-compatible exact equality (incl. `1 == 1.0` and
/// order-insensitive object keys).
#[derive(Clone)]
pub(crate) enum ValueConstraint {
    Enum(Vec<Arc<serde_json::Value>>),
    Const(Arc<serde_json::Value>),
}

/// One compiled schema node. `types` is a bitmask of allowed kinds (0 = any).
#[derive(Clone, Default)]
pub struct FastNode {
    pub(crate) never: bool,
    pub(crate) types: u8,
    pub(crate) obj: Option<Arc<FastObject>>,
    pub(crate) arr: Option<Arc<FastArray>>,
    pub(crate) str: Option<Arc<FastString>>,
    pub(crate) num: Option<Arc<FastNumber>>,
    pub(crate) comb: Option<Arc<FastComb>>,
    pub(crate) value: Option<ValueConstraint>,
    /// JSON pointer to this subschema in the source document, for error
    /// reporting (e.g. `/properties/name`).
    pub(crate) schema_path: Option<String>,
}
