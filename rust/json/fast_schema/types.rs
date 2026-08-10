// rust/json/fast_schema/types.rs — Compiled fast-path schema AST.
//
// `compile` (compile.rs) builds these nodes from a schema; `validate`
// (validate.rs) walks them against raw JSON bytes. Fields are `pub(crate)` so
// the sibling compile/validate modules can build and read them; the only
// public surface is `FastNode` (re-exported from mod.rs).

use std::collections::HashMap;
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
}

pub(crate) struct FastNumber {
    pub(crate) minimum: Option<f64>,
    pub(crate) maximum: Option<f64>,
    pub(crate) exclusive_min: Option<f64>,
    pub(crate) exclusive_max: Option<f64>,
}

pub(crate) struct FastArray {
    pub(crate) items: Option<Arc<FastNode>>,
    pub(crate) min_items: Option<usize>,
    pub(crate) max_items: Option<usize>,
}

pub(crate) enum Additional {
    Allow,
    Deny,
    Schema(Arc<FastNode>),
}

pub(crate) struct FastObject {
    pub(crate) props: HashMap<Box<[u8]>, Arc<FastNode>>,
    /// Maps required key -> bit index (0..=63); compile fails beyond 64.
    pub(crate) required: HashMap<Box<[u8]>, u32>,
    pub(crate) required_count: usize,
    pub(crate) additional: Additional,
    pub(crate) min_props: Option<usize>,
    pub(crate) max_props: Option<usize>,
}

/// One compiled schema node. `types` is a bitmask of allowed kinds (0 = any).
#[derive(Default)]
pub struct FastNode {
    pub(crate) never: bool,
    pub(crate) types: u8,
    pub(crate) obj: Option<Arc<FastObject>>,
    pub(crate) arr: Option<Arc<FastArray>>,
    pub(crate) str: Option<Arc<FastString>>,
    pub(crate) num: Option<Arc<FastNumber>>,
}
