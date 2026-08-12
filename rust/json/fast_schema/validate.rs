// rust/json/fast_schema/validate.rs — AST + raw bytes → validation (bool or
// detailed errors via an optional `Ctx` error sink).
//
// Walks a compiled `FastNode` over raw JSON bytes with a `Cursor`. In bool mode
// (`Ctx::bool_mode`) the walk is allocation-free for the core subset (matching
// the original `is_valid_bytes` hot path used by the ingress); in detailed mode
// it additionally collects `SchemaError`s (instance pointer + keyword + message).

use super::cursor::{count_chars, decode_string, Cursor};
use super::errors::Ctx;
use super::types::{
    kind_of, Additional, FastArray, FastNode, FastObject, Kind, T_ARR, T_BOOL, T_INT, T_NULL,
    T_NUM, T_OBJ, T_STR,
};
use fraction::One;
use std::sync::Arc;

impl FastNode {
    pub(crate) fn any() -> Self {
        Self::default()
    }

    pub(crate) fn never() -> Self {
        Self {
            never: true,
            ..Self::default()
        }
    }

    /// Validate a complete JSON document against this schema (bool mode).
    #[inline]
    pub fn is_valid_bytes(&self, bytes: &[u8]) -> bool {
        let mut c = Cursor::new(bytes);
        let mut ctx = Ctx::bool_mode();
        if !self.validate(&mut c, &mut ctx) {
            return false;
        }
        c.skip_ws();
        c.pos == bytes.len()
    }

    /// Validate and return detailed errors (empty = valid). `max_errors` caps
    /// the number of errors collected (1 = first error only).
    pub fn validate_errors(
        &self,
        bytes: &[u8],
        max_errors: usize,
    ) -> Vec<super::errors::SchemaError> {
        let mut c = Cursor::new(bytes);
        let mut ctx = Ctx::detailed(max_errors);
        if self.validate(&mut c, &mut ctx) {
            c.skip_ws();
            if c.pos == bytes.len() {
                return Vec::new();
            }
            ctx.record("", "parse", "trailing data after the JSON value".to_string());
        }
        ctx.into_errors()
    }

    /// Validate `c` against this schema (bool or detailed mode). Every
    /// recursion of the schema walk (members, tuple items, combinator
    /// sub-schemas) routes through this method, so it is the single choke point
    /// for the nesting-depth cap: `MAX_DEPTH` bounds how deep the walk can
    /// recurse, preventing hostile deeply-nested JSON from exhausting the
    /// native stack (an uncatchable abort — see `Ctx::enter_depth`).
    fn validate(&self, c: &mut Cursor, ctx: &mut Ctx) -> bool {
        if !ctx.enter_depth() {
            ctx.record(
                "",
                "maxDepth",
                "maximum JSON nesting depth exceeded".to_string(),
            );
            return false;
        }
        let ok = self.validate_inner(c, ctx);
        ctx.leave_depth();
        ok
    }

    fn validate_inner(&self, c: &mut Cursor, ctx: &mut Ctx) -> bool {
        let base = self.schema_path.as_deref().unwrap_or("");
        if self.never {
            ctx.record(
                base,
                "false schema",
                "the schema is false and rejects every value".to_string(),
            );
            return false;
        }
        c.skip_ws();
        let vstart = c.pos;
        let Some(b) = c.peek() else {
            ctx.record(
                base,
                "type",
                "expected a JSON value but found end of input".to_string(),
            );
            return false;
        };
        // 1. `type`
        if self.types != 0 {
            let Some(k) = kind_of(b) else {
                ctx.record(base, "type", "unexpected JSON token".to_string());
                return false;
            };
            let ok = match k {
                Kind::Number => self.types & (T_NUM | T_INT) != 0,
                Kind::Null => self.types & T_NULL != 0,
                Kind::Boolean => self.types & T_BOOL != 0,
                Kind::String => self.types & T_STR != 0,
                Kind::Array => self.types & T_ARR != 0,
                Kind::Object => self.types & T_OBJ != 0,
            };
            if !ok {
                ctx.record(
                    base,
                    "type",
                    format!("expected {} but found {}", type_names(self.types), kind_name(k)),
                );
                return false;
            }
        }
        // 2. `enum` / `const` — compare parsed values, matching the reference
        //    (exact number equality; object keys compared in insertion order,
        //    replicating jsonschema's cmp::equal).
        if let Some(value) = &self.value {
            let data = c.data;
            if !c.skip_value(ctx.depth) {
                ctx.record(base, "parse", "malformed JSON value".to_string());
                return false;
            }
            let raw = &data[vstart..c.pos];
            let val: serde_json::Value = match serde_json::from_slice(raw) {
                Ok(v) => v,
                Err(_) => {
                    ctx.record(base, "parse", "malformed JSON value".to_string());
                    return false;
                }
            };
            let (keyword, ok, message) = match value {
                super::types::ValueConstraint::Enum(members) => (
                    "enum",
                    members.iter().any(|m| values_equal(m, &val)),
                    "value is not one of the allowed enum values".to_string(),
                ),
                super::types::ValueConstraint::Const(x) => (
                    "const",
                    values_equal(x, &val),
                    "value is not equal to the required constant".to_string(),
                ),
            };
            if !ok {
                ctx.record(base, keyword, message);
                return false;
            }
            // Run the structural + combinator constraints over the same value.
            let mut c2 = Cursor::new(raw);
            return self.validate_kind(&mut c2, ctx) && self.validate_comb_raw(raw, ctx);
        }
        // 3. kind-specific structural constraints
        if !self.validate_kind(c, ctx) {
            return false;
        }
        // 4. combinators over the same value (re-scanned from vstart)
        let data = c.data;
        let raw = &data[vstart..c.pos];
        self.validate_comb_raw(raw, ctx)
    }

    fn validate_kind(&self, c: &mut Cursor, ctx: &mut Ctx) -> bool {
        let base = self.schema_path.as_deref().unwrap_or("");
        let Some(b) = c.peek() else {
            ctx.record(base, "type", "expected a JSON value".to_string());
            return false;
        };
        match b {
            b'{' => match &self.obj {
                Some(o) => validate_object(o, c, ctx, base),
                None => c.skip_value(ctx.depth),
            },
            b'[' => match &self.arr {
                Some(a) => validate_array(a, c, ctx, base),
                None => c.skip_value(ctx.depth),
            },
            b'"' => {
                let Some(inner) = c.raw_string() else {
                    ctx.record(base, "parse", "malformed string".to_string());
                    return false;
                };
                match &self.str {
                    Some(_) => self.validate_string(inner, base, ctx),
                    None => true,
                }
            }
            b't' => {
                if !c.eat_token(b"true") {
                    ctx.record(base, "parse", "malformed literal".to_string());
                    return false;
                }
                true
            }
            b'f' => {
                if !c.eat_token(b"false") {
                    ctx.record(base, "parse", "malformed literal".to_string());
                    return false;
                }
                true
            }
            b'n' => {
                if !c.eat_token(b"null") {
                    ctx.record(base, "parse", "malformed literal".to_string());
                    return false;
                }
                true
            }
            _ => {
                let Some((n, _is_int)) = c.number() else {
                    ctx.record(base, "parse", "malformed number".to_string());
                    return false;
                };
                // `type: "integer"` (without `number`) rejects non-integral values.
                if self.types & T_INT != 0 && self.types & T_NUM == 0 && n.fract() != 0.0 {
                    ctx.record(base, "type", "expected an integer".to_string());
                    return false;
                }
                match &self.num {
                    Some(num) => {
                        if let Some(min) = num.minimum {
                            if n < min {
                                ctx.record(base, "minimum", format!("number must be >= {min}"));
                                return false;
                            }
                        }
                        if let Some(max) = num.maximum {
                            if n > max {
                                ctx.record(base, "maximum", format!("number must be <= {max}"));
                                return false;
                            }
                        }
                        if let Some(e) = num.exclusive_min {
                            if n <= e {
                                ctx.record(base, "exclusiveMinimum", format!("number must be > {e}"));
                                return false;
                            }
                        }
                        if let Some(e) = num.exclusive_max {
                            if n >= e {
                                ctx.record(base, "exclusiveMaximum", format!("number must be < {e}"));
                                return false;
                            }
                        }
                        if let Some(m) = num.multiple_of {
                            if !is_multiple_of(n, m) {
                                ctx.record(
                                    base,
                                    "multipleOf",
                                    format!("number must be a multiple of {m}"),
                                );
                                return false;
                            }
                        }
                        true
                    }
                    None => true,
                }
            }
        }
    }

    fn validate_string(&self, inner: &[u8], base: &str, ctx: &mut Ctx) -> bool {
        let Some(s) = &self.str else { return true; };
        let len = count_chars(inner);
        if let Some(min) = s.min_len {
            if len < min {
                ctx.record(base, "minLength", format!("string is shorter than {min} characters"));
                return false;
            }
        }
        if let Some(max) = s.max_len {
            if len > max {
                ctx.record(base, "maxLength", format!("string is longer than {max} characters"));
                return false;
            }
        }
        if let Some(re) = &s.pattern {
            // Pattern matches the DECODED string value (like the reference).
            let owned;
            let content: &[u8] = if inner.contains(&b'\\') {
                owned = decode_string(inner);
                &owned
            } else {
                inner
            };
            let text = match std::str::from_utf8(content) {
                Ok(t) => t,
                Err(_) => {
                    ctx.record(base, "pattern", "string is not valid UTF-8".to_string());
                    return false;
                }
            };
            if !re.is_match(text).unwrap_or(false) {
                ctx.record(
                    base,
                    "pattern",
                    "string does not match the required pattern".to_string(),
                );
                return false;
            }
        }
        if s.format_email {
            let owned;
            let content: &[u8] = if inner.contains(&b'\\') {
                owned = decode_string(inner);
                &owned
            } else {
                inner
            };
            if !super::email::is_valid_email_format(content) {
                ctx.record(base, "format", "string is not a valid email address".to_string());
                return false;
            }
        }
        true
    }

    /// Run allOf / anyOf / oneOf / not / if-then-else over the value's raw bytes.
    fn validate_comb_raw(&self, raw: &[u8], ctx: &mut Ctx) -> bool {
        let Some(comb) = &self.comb else { return true; };
        let base = self.schema_path.as_deref().unwrap_or("");
        // allOf: a failing branch IS the cause — run with the real ctx.
        for sub in &comb.all_of {
            let mut c = Cursor::new(raw);
            if !sub.validate(&mut c, ctx) {
                return false;
            }
        }
        // anyOf / oneOf / not / if-guard: a branch's internal outcome is not
        // itself the cause, so suppress its error recording.
        if !comb.any_of.is_empty() {
            let mut any_ok = false;
            for sub in &comb.any_of {
                let mut c = Cursor::new(raw);
                if ctx.with_suppressed(|ctx| sub.validate(&mut c, ctx)) {
                    any_ok = true;
                    break;
                }
            }
            if !any_ok {
                ctx.record(
                    base,
                    "anyOf",
                    "value does not match any of the allowed schemas".to_string(),
                );
                return false;
            }
        }
        if !comb.one_of.is_empty() {
            let mut count = 0usize;
            for sub in &comb.one_of {
                let mut c = Cursor::new(raw);
                if ctx.with_suppressed(|ctx| sub.validate(&mut c, ctx)) {
                    count += 1;
                }
            }
            if count != 1 {
                let msg = if count == 0 {
                    "value matches none of the required schemas".to_string()
                } else {
                    "value matches more than one of the required schemas".to_string()
                };
                ctx.record(base, "oneOf", msg);
                return false;
            }
        }
        if let Some(sub) = &comb.not {
            let mut c = Cursor::new(raw);
            if ctx.with_suppressed(|ctx| sub.validate(&mut c, ctx)) {
                ctx.record(base, "not", "value matches the forbidden schema".to_string());
                return false;
            }
        }
        if let Some((if_node, then_node, else_node)) = &comb.if_then_else {
            let mut c = Cursor::new(raw);
            let if_ok = ctx.with_suppressed(|ctx| if_node.validate(&mut c, ctx));
            if if_ok {
                if let Some(t) = then_node {
                    let mut c = Cursor::new(raw);
                    if !t.validate(&mut c, ctx) {
                        return false;
                    }
                }
            } else if let Some(e) = else_node {
                let mut c = Cursor::new(raw);
                if !e.validate(&mut c, ctx) {
                    return false;
                }
            }
        }
        true
    }
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Object => "object",
        Kind::Array => "array",
        Kind::String => "string",
        Kind::Number => "number",
        Kind::Boolean => "boolean",
        Kind::Null => "null",
    }
}

fn type_names(mask: u8) -> String {
    let mut names = Vec::new();
    for (bit, name) in [
        (T_NULL, "null"),
        (T_BOOL, "boolean"),
        (T_NUM, "number"),
        (T_INT, "integer"),
        (T_STR, "string"),
        (T_ARR, "array"),
        (T_OBJ, "object"),
    ] {
        if mask & bit != 0 {
            names.push(name);
        }
    }
    if names.is_empty() {
        "any value".to_string()
    } else {
        names.join(" or ")
    }
}

/// `multipleOf` exactness, replicating jsonschema's `is_multiple_of_float`:
/// exact rational division via fraction::BigFraction, denominator must be 1.
fn is_multiple_of(value: f64, multiple: f64) -> bool {
    // `fraction::BigFraction::from(f64)` cannot represent non-finite values
    // (`1e999` parses to `f64::INFINITY` in `Cursor::number`) and PANICS on
    // them. Via the raw C-ABI (bun:ffi) path a panic is a whole-process crash
    // (no catch_unwind equivalent), so guard up front and report "not a
    // multiple" — consistent with the DOM validator, which also yields
    // schema-invalid for such a body (its serde parse of `1e999` fails).
    if !value.is_finite() || !multiple.is_finite() {
        return false;
    }
    if value == 0.0 {
        return true;
    }
    if value.abs() < multiple {
        return false;
    }
    let r = fraction::BigFraction::from(value) / fraction::BigFraction::from(multiple);
    r.denom().is_none_or(One::is_one)
}

/// JSON value equality replicating jsonschema's `cmp::equal` (exact across
/// u64/i64/f64 via num_cmp, order-insensitive object keys). Used for enum,
/// const, and uniqueItems so the fast path stays byte-parity with the crate.
fn values_equal(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Null, serde_json::Value::Null) => true,
        (serde_json::Value::Bool(x), serde_json::Value::Bool(y)) => x == y,
        (serde_json::Value::Number(x), serde_json::Value::Number(y)) => numbers_equal(x, y),
        (serde_json::Value::String(x), serde_json::Value::String(y)) => x == y,
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| values_equal(a, b))
        }
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
            // Insertion-order comparison, replicating jsonschema's cmp::equal
            // (key order is SIGNIFICANT in the crate's object equality).
            x.len() == y.len()
                && x.iter().zip(y.iter()).all(|((ka, va), (kb, vb))| {
                    ka == kb && values_equal(va, vb)
                })
        }
        _ => false,
    }
}

/// Exact cross-representation number equality (num_cmp semantics, matching
/// jsonschema's `equal_numbers` without arbitrary-precision).
fn numbers_equal(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    use num_cmp::NumCmp;
    if let Some(x) = a.as_u64() {
        if let Some(y) = b.as_u64() {
            return x == y;
        }
        if let Some(y) = b.as_i64() {
            return y >= 0 && x == y as u64;
        }
        return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
    }
    if let Some(x) = a.as_i64() {
        if let Some(y) = b.as_i64() {
            return x == y;
        }
        if let Some(y) = b.as_u64() {
            return x >= 0 && y == x as u64;
        }
        return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
    }
    if let Some(x) = a.as_f64() {
        if let Some(y) = b.as_f64() {
            return x == y;
        }
        if let Some(y) = b.as_u64() {
            return x.num_eq(y);
        }
        if let Some(y) = b.as_i64() {
            return x.num_eq(y);
        }
    }
    false
}

/// Exact distinct-key tracking for `minProperties`/`maxProperties`, WITHOUT a
/// per-document heap allocation in the common case.
///
/// The common case (objects with a modest number of short keys) is tracked in
/// a fixed stack array; only pathological objects (many distinct keys or long
/// keys) migrate to a heap `Vec`. Keeps the otherwise zero-alloc schema fast
/// path heap-light even when the schema uses these keywords.
const INLINE_DISTINCT: usize = 16;
const INLINE_KEY_BYTES: usize = 48;

// The Inline variant is intentionally much larger than Heap (a stack-resident
// array for the common case); the enum lives on the stack, so this is fine.
#[allow(clippy::large_enum_variant)]
pub(crate) enum DistinctKeys {
    Inline {
        keys: [([u8; INLINE_KEY_BYTES], usize); INLINE_DISTINCT],
        len: usize,
    },
    Heap(Vec<Box<[u8]>>),
}

impl DistinctKeys {
    fn new() -> Self {
        DistinctKeys::Inline {
            keys: [([0u8; INLINE_KEY_BYTES], 0); INLINE_DISTINCT],
            len: 0,
        }
    }

    /// Record `key` as seen (exact byte comparison); returns whether it was new.
    fn insert(&mut self, key: &[u8]) -> bool {
        match self {
            DistinctKeys::Inline { keys, len } => {
                for (k, klen) in keys[..*len].iter() {
                    if *klen == key.len() && &k[..*klen] == key {
                        return false;
                    }
                }
                if *len < INLINE_DISTINCT && key.len() <= INLINE_KEY_BYTES {
                    let (k, klen) = &mut keys[*len];
                    k[..key.len()].copy_from_slice(key);
                    *klen = key.len();
                    *len += 1;
                    return true;
                }
                // Inline capacity exhausted: migrate to the heap tracker.
                let mut v = Vec::with_capacity(*len + 1);
                for (k, klen) in keys[..*len].iter() {
                    v.push(k[..*klen].to_vec().into_boxed_slice());
                }
                v.push(key.to_vec().into_boxed_slice());
                *self = DistinctKeys::Heap(v);
                true
            }
            DistinctKeys::Heap(v) => {
                if v.iter().any(|k| k.as_ref() == key) {
                    return false;
                }
                v.push(key.to_vec().into_boxed_slice());
                true
            }
        }
    }

    fn len(&self) -> usize {
        match self {
            DistinctKeys::Inline { len, .. } => *len,
            DistinctKeys::Heap(v) => v.len(),
        }
    }
}

pub(crate) fn validate_object(o: &FastObject, c: &mut Cursor, ctx: &mut Ctx, base: &str) -> bool {
    if !c.eat(b'{') {
        return false;
    }
    c.skip_ws();
    let need_distinct = o.min_props.is_some() || o.max_props.is_some();
    let need_present = !o.dependent_required.is_empty();
    let mut count: usize = 0;
    let mut seen_required: u64 = 0;
    let mut obj_ok = true;
    let mut distinct: Option<DistinctKeys> = if need_distinct {
        Some(DistinctKeys::new())
    } else {
        None
    };
    let mut present: Option<Vec<Box<[u8]>>> = if need_present {
        Some(Vec::new())
    } else {
        None
    };

    if c.eat(b'}') {
        return finish_object(o, count, seen_required, &distinct, &present, ctx, base) && obj_ok;
    }
    loop {
        c.skip_ws();
        let Some(raw) = c.raw_string() else {
            return false;
        };
        let owned;
        let key: &[u8] = if raw.contains(&b'\\') {
            owned = decode_string(raw);
            &owned
        } else {
            raw
        };
        count += 1;
        if let Some(d) = &mut distinct {
            d.insert(key);
        }
        if let Some(p) = &mut present {
            p.push(key.to_vec().into_boxed_slice());
        }
        if let Some(&bit) = o.required.get(key) {
            seen_required |= 1u64 << bit;
        }
        c.skip_ws();
        if !c.eat(b':') {
            return false;
        }
        // Schemas applying to this key: the `properties` schema (if any) plus
        // every matching `patternProperties` schema — ALL apply conjunctively
        // (a key covered by either is not an "additional" property).
        let prop_node = o.props.get(key).cloned();
        let mut pat_nodes: Vec<Arc<FastNode>> = Vec::new();
        for (re, n) in &o.patterns {
            if std::str::from_utf8(key).is_ok_and(|k| re.is_match(k).unwrap_or(false)) {
                pat_nodes.push(n.clone());
            }
        }
        let vstart = c.pos;
        ctx.push_key(key);
        let ok = if pat_nodes.is_empty() {
            match prop_node {
                Some(node) => node.validate(c, ctx),
                None => match &o.additional {
                    Additional::Allow => c.skip_value(ctx.depth),
                    Additional::Deny => {
                        ctx.record(
                            base,
                            "additionalProperties",
                            "additional properties are not allowed".to_string(),
                        );
                        false
                    }
                    Additional::Schema(s) => s.validate(c, ctx),
                },
            }
        } else {
            // property schema + every matching pattern schema (conjunctively)
            let mut nodes: Vec<Arc<FastNode>> = Vec::with_capacity(1 + pat_nodes.len());
            if let Some(p) = prop_node {
                nodes.push(p);
            }
            nodes.extend(pat_nodes);
            validate_all(&nodes, c, ctx)
        };
        ctx.pop();
        if !ok {
            if ctx.is_detailed() {
                // Collect every failing property: realign past this value and
                // continue validating the remaining members.
                obj_ok = false;
                realign(c, vstart, ctx.depth);
            } else {
                return false;
            }
        }
        c.skip_ws();
        if c.eat(b'}') {
            let fin = finish_object(o, count, seen_required, &distinct, &present, ctx, base);
            return obj_ok && fin;
        }
        if !c.eat(b',') {
            return false;
        }
    }
}

pub(crate) fn finish_object(
    o: &FastObject,
    count: usize,
    seen_required: u64,
    distinct: &Option<DistinctKeys>,
    present: &Option<Vec<Box<[u8]>>>,
    ctx: &mut Ctx,
    base: &str,
) -> bool {
    let total = distinct.as_ref().map(DistinctKeys::len).unwrap_or(count);
    if let Some(min) = o.min_props {
        if total < min {
            ctx.record(base, "minProperties", format!("object must have at least {min} properties"));
            return false;
        }
    }
    if let Some(max) = o.max_props {
        if total > max {
            ctx.record(base, "maxProperties", format!("object must have at most {max} properties"));
            return false;
        }
    }
    if o.required_count > 0 {
        let full = if o.required_count == 64 {
            u64::MAX
        } else {
            (1u64 << o.required_count) - 1
        };
        if seen_required != full {
            let missing: Vec<String> = o
                .required
                .iter()
                .filter(|(_, &bit)| seen_required & (1u64 << bit) == 0)
                .map(|(k, _)| String::from_utf8_lossy(k).into_owned())
                .collect();
            ctx.record(
                base,
                "required",
                format!("missing required properties: {}", missing.join(", ")),
            );
            return false;
        }
    }
    if let Some(present) = present {
        for (prop, reqs) in &o.dependent_required {
            if present.iter().any(|k| k.as_ref() == prop.as_ref()) {
                for r in reqs {
                    if !present.iter().any(|k| k.as_ref() == r.as_ref()) {
                        ctx.record(
                            base,
                            "dependencies",
                            format!(
                                "property \"{}\" requires property \"{}\"",
                                String::from_utf8_lossy(prop),
                                String::from_utf8_lossy(r)
                            ),
                        );
                        return false;
                    }
                }
            }
        }
    }
    true
}

pub(crate) fn validate_array(a: &FastArray, c: &mut Cursor, ctx: &mut Ctx, base: &str) -> bool {
    if !c.eat(b'[') {
        return false;
    }
    c.skip_ws();
    let mut count = 0usize;
    let mut arr_ok = true;
    let mut unique_seen: Option<Vec<serde_json::Value>> = if a.unique {
        Some(Vec::new())
    } else {
        None
    };
    let mut contains_found = a.contains.is_none();
    if c.eat(b']') {
        return check_array_counts(a, count, ctx, base)
            && contains_ok(a, contains_found, base, ctx)
            && arr_ok;
    }
    loop {
        count += 1;
        if let Some(max) = a.max_items {
            if count > max {
                ctx.record(base, "maxItems", format!("array has more than {max} items"));
                return false;
            }
        }
        let idx = count - 1;
        let elem_start = c.pos;
        let ok = match &a.tuple_items {
            Some(tuple) if idx < tuple.len() => validate_element(&tuple[idx], c, ctx, idx),
            Some(_) => match &a.additional_items {
                Some(Additional::Allow) | None => c.skip_value(ctx.depth),
                Some(Additional::Deny) => {
                    ctx.push_idx(idx);
                    ctx.record(
                        base,
                        "additionalItems",
                        "additional array items are not allowed".to_string(),
                    );
                    ctx.pop();
                    false
                }
                Some(Additional::Schema(s)) => validate_element(s, c, ctx, idx),
            },
            None => match &a.items {
                Some(node) => validate_element(node, c, ctx, idx),
                None => c.skip_value(ctx.depth),
            },
        };
        if !ok {
            if ctx.is_detailed() {
                arr_ok = false;
                realign(c, elem_start, ctx.depth);
            } else {
                return false;
            }
        }
        // uniqueItems: compare parsed element values (matches the reference's
        // `is_unique`, incl. `1 == 1.0` and insertion-order object comparison).
        if let Some(seen) = &mut unique_seen {
            let data = c.data;
            let raw = &data[elem_start..c.pos];
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(raw) {
                if seen.iter().any(|v| values_equal(v, &val)) {
                    ctx.record(base, "uniqueItems", "array items must be unique".to_string());
                    arr_ok = false;
                } else {
                    seen.push(val);
                }
            }
        }
        // contains: does this element validate the contains schema?
        if !contains_found {
            if let Some(con) = &a.contains {
                let data = c.data;
                let raw = &data[elem_start..c.pos];
                let mut cc = Cursor::new(raw);
                if ctx.with_suppressed(|ctx| con.validate(&mut cc, ctx)) {
                    contains_found = true;
                }
            }
        }
        c.skip_ws();
        if c.eat(b']') {
            let fin = check_array_counts(a, count, ctx, base)
                && contains_ok(a, contains_found, base, ctx);
            return arr_ok && fin;
        }
        if !c.eat(b',') {
            return false;
        }
        c.skip_ws();
    }
}

/// In detailed mode, skip the remainder of a failed value so validation can
/// continue to the next property/element (collecting every error). No-op if the
/// value is malformed (can't safely resync).
fn realign(c: &mut Cursor, vstart: usize, depth: u32) {
    let data = c.data;
    let mut sc = Cursor::new(&data[vstart..]);
    if sc.skip_value(depth) {
        c.pos = vstart + sc.pos;
    }
}

fn validate_element(node: &FastNode, c: &mut Cursor, ctx: &mut Ctx, idx: usize) -> bool {
    ctx.push_idx(idx);
    let ok = node.validate(c, ctx);
    ctx.pop();
    ok
}

/// Validate a value against several schemas conjunctively (properties +
/// patternProperties). A single schema validates in place; multiple schemas
/// capture the value's raw bytes and re-scan each on a fresh cursor.
fn validate_all(nodes: &[Arc<FastNode>], c: &mut Cursor, ctx: &mut Ctx) -> bool {
    match nodes {
        [] => c.skip_value(ctx.depth),
        [node] => node.validate(c, ctx),
        _ => {
            let vstart = c.pos;
            let data = c.data;
            if !c.skip_value(ctx.depth) {
                return false;
            }
            let raw = &data[vstart..c.pos];
            for node in nodes {
                let mut cc = Cursor::new(raw);
                if !node.validate(&mut cc, ctx) {
                    return false;
                }
            }
            true
        }
    }
}

fn contains_ok(a: &FastArray, contains_found: bool, base: &str, ctx: &mut Ctx) -> bool {
    if a.contains.is_some() && !contains_found {
        ctx.record(base, "contains", "array does not contain a matching item".to_string());
        return false;
    }
    true
}

pub(crate) fn check_array_counts(a: &FastArray, count: usize, ctx: &mut Ctx, base: &str) -> bool {
    if let Some(min) = a.min_items {
        if count < min {
            ctx.record(base, "minItems", format!("array must have at least {min} items"));
            return false;
        }
    }
    if let Some(max) = a.max_items {
        if count > max {
            ctx.record(base, "maxItems", format!("array must have at most {max} items"));
            return false;
        }
    }
    true
}
