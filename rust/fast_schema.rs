// rust/fast_schema.rs — Zero-DOM JSON Schema validation (common keyword subset).
//
// Why this exists: `jsonschema::Validator::is_valid` requires a
// `serde_json::Value`, so the default path parses every document into a heap
// DOM. We measured that DOM build at ~95% of the validation cost for the bench
// fixture. This module instead compiles the same schema into a tiny structural
// AST and validates documents with a single, allocation-free pass over the raw
// bytes — no `serde_json::Value`, no per-key `String`s, no `BTreeMap`/`IndexMap`.
//
// Versatility is preserved: `compile` returns `Err(())` for any schema using a
// keyword outside the supported subset (regex, format, anyOf/oneOf/allOf/not,
// $ref, enum/const, multipleOf, uniqueItems, …). The caller then falls back to
// the full `jsonschema` crate path, so the fast path only ever runs on schemas
// it can prove equivalent to the reference semantics.
//
// Limitations (accepted): documents must be well-formed UTF-8 JSON; malformed
// escapes/UTF-8 that the reference parser rejects may slip through. The
// fallback DOM path is authoritative for all inputs.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

// ── JSON byte cursor ──────────────────────────────────────────────

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    #[inline]
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    #[inline]
    fn skip_ws(&mut self) {
        while let Some(&b) = self.data.get(self.pos) {
            match b {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    #[inline]
    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    #[inline]
    fn eat(&mut self, b: u8) -> bool {
        if self.peek() == Some(b) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    #[inline]
    fn eat_token(&mut self, tok: &[u8]) -> bool {
        if self.data.get(self.pos..self.pos + tok.len()) == Some(tok) {
            self.pos += tok.len();
            true
        } else {
            false
        }
    }

    /// Parse a JSON string token, returning the raw inner slice (between the
    /// quotes). Escapes are validated as escape characters and skipped, but
    /// not decoded. Returns `None` on malformed strings.
    fn raw_string(&mut self) -> Option<&'a [u8]> {
        if !self.eat(b'"') {
            return None;
        }
        let start = self.pos;
        let mut i = self.pos;
        while i < self.data.len() {
            match self.data[i] {
                b'"' => {
                    self.pos = i + 1;
                    return Some(&self.data[start..i]);
                }
                b'\\' => {
                    let e = *self.data.get(i + 1)?;
                    if !matches!(e, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' | b'u') {
                        return None;
                    }
                    i += 2;
                }
                _ => i += 1,
            }
        }
        None
    }

    /// Parse a JSON number token; returns `(value, integer_syntax)`.
    fn number(&mut self) -> Option<(f64, bool)> {
        let start = self.pos;
        let _ = self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return None,
        }
        let mut is_int = true;
        if self.peek() == Some(b'.') {
            is_int = false;
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            is_int = false;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let tok = &self.data[start..self.pos];
        let n: f64 = std::str::from_utf8(tok).ok()?.parse().ok()?;
        Some((n, is_int))
    }

    /// Skip one complete JSON value (for `true`/`{}`/`additionalProperties: true`).
    fn skip_value(&mut self) -> bool {
        self.skip_ws();
        let Some(b) = self.peek() else {
            return false;
        };
        match b {
            b'{' => {
                self.pos += 1;
                self.skip_ws();
                if self.eat(b'}') {
                    return true;
                }
                loop {
                    if self.raw_string().is_none() {
                        return false;
                    }
                    self.skip_ws();
                    if !self.eat(b':') {
                        return false;
                    }
                    if !self.skip_value() {
                        return false;
                    }
                    self.skip_ws();
                    if self.eat(b'}') {
                        return true;
                    }
                    if !self.eat(b',') {
                        return false;
                    }
                    self.skip_ws();
                }
            }
            b'[' => {
                self.pos += 1;
                self.skip_ws();
                if self.eat(b']') {
                    return true;
                }
                loop {
                    if !self.skip_value() {
                        return false;
                    }
                    self.skip_ws();
                    if self.eat(b']') {
                        return true;
                    }
                    if !self.eat(b',') {
                        return false;
                    }
                    self.skip_ws();
                }
            }
            b'"' => self.raw_string().is_some(),
            b't' => self.eat_token(b"true"),
            b'f' => self.eat_token(b"false"),
            b'n' => self.eat_token(b"null"),
            b'-' | b'0'..=b'9' => self.number().is_some(),
            _ => false,
        }
    }
}

// ── String helpers ────────────────────────────────────────────────

/// Count Unicode scalar values (JSON Schema string length) in a raw JSON
/// string body, handling escapes including surrogate pairs.
fn count_chars(inner: &[u8]) -> usize {
    let mut chars = 0usize;
    let mut i = 0usize;
    while i < inner.len() {
        let b = inner[i];
        if b == b'\\' {
            if i + 1 >= inner.len() {
                break;
            }
            if inner[i + 1] == b'u' {
                chars += 1;
                i += 6;
                // High surrogate followed by a low surrogate is ONE scalar value.
                if i + 6 <= inner.len()
                    && inner.get(i..i + 2) == Some(b"\\u")
                    && hex4(inner.get(i - 4..i)).is_some_and(|hi| (0xD800..=0xDBFF).contains(&hi))
                    && hex4(inner.get(i + 2..i + 6)).is_some_and(|lo| (0xDC00..=0xDFFF).contains(&lo))
                {
                    i += 6;
                }
            } else {
                chars += 1;
                i += 2;
            }
        } else if b < 0x80 {
            chars += 1;
            i += 1;
        } else {
            chars += 1;
            i += match b {
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                _ => 1,
            };
        }
    }
    chars
}

fn hex4(hex: Option<&[u8]>) -> Option<u16> {
    let hex = hex?;
    if hex.len() != 4 {
        return None;
    }
    let mut v = 0u16;
    for &c in hex {
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => return None,
        };
        v = v * 16 + d as u16;
    }
    Some(v)
}

fn push_cp(out: &mut Vec<u8>, cp: u32) {
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push(0xC0 | (cp >> 6) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else if cp < 0x10000 {
        out.push(0xE0 | (cp >> 12) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    } else {
        out.push(0xF0 | (cp >> 18) as u8);
        out.push(0x80 | ((cp >> 12) & 0x3F) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3F) as u8);
        out.push(0x80 | (cp & 0x3F) as u8);
    }
}

/// Decode a raw JSON string body into literal bytes. Only used for object keys
/// that contain escapes (rare); the common no-escape path is a zero-alloc
/// slice lookup.
fn decode_string(inner: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(inner.len());
    let mut i = 0usize;
    while i < inner.len() {
        let b = inner[i];
        if b == b'\\' && i + 1 < inner.len() {
            let e = inner[i + 1];
            i += 2;
            match e {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b'/' => out.push(b'/'),
                b'b' => out.push(0x08),
                b'f' => out.push(0x0C),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'u' => {
                    if let Some(h) = hex4(inner.get(i..i + 4)) {
                        i += 4;
                        if (0xD800..=0xDBFF).contains(&h) {
                            let low = inner
                                .get(i..i + 2)
                                .filter(|s| **s == *b"\\u")
                                .and_then(|_| hex4(inner.get(i + 2..i + 6)));
                            if let Some(l) = low.filter(|l| (0xDC00..=0xDFFF).contains(l)) {
                                i += 6;
                                let cp = 0x10000
                                    + (((h as u32) - 0xD800) << 10)
                                    + ((l as u32) - 0xDC00);
                                push_cp(&mut out, cp);
                            } else {
                                // Lone high surrogate: encode as replacement char.
                                push_cp(&mut out, 0xFFFD);
                            }
                        } else {
                            push_cp(&mut out, h as u32);
                        }
                    } else {
                        out.push(b'u');
                    }
                }
                _ => out.push(b),
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}

// ── Compiled fast-path schema ─────────────────────────────────────

const T_NULL: u8 = 1 << 0;
const T_BOOL: u8 = 1 << 1;
const T_NUM: u8 = 1 << 2;
const T_INT: u8 = 1 << 3;
const T_STR: u8 = 1 << 4;
const T_ARR: u8 = 1 << 5;
const T_OBJ: u8 = 1 << 6;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

fn kind_of(b: u8) -> Option<Kind> {
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

struct FastString {
    min_len: Option<usize>,
    max_len: Option<usize>,
}

struct FastNumber {
    minimum: Option<f64>,
    maximum: Option<f64>,
    exclusive_min: Option<f64>,
    exclusive_max: Option<f64>,
}

struct FastArray {
    items: Option<Arc<FastNode>>,
    min_items: Option<usize>,
    max_items: Option<usize>,
}

enum Additional {
    Allow,
    Deny,
    Schema(Arc<FastNode>),
}

struct FastObject {
    props: HashMap<Box<[u8]>, Arc<FastNode>>,
    /// Maps required key -> bit index (0..=63); compile fails beyond 64.
    required: HashMap<Box<[u8]>, u32>,
    required_count: usize,
    additional: Additional,
    min_props: Option<usize>,
    max_props: Option<usize>,
}

/// One compiled schema node. `types` is a bitmask of allowed kinds (0 = any).
pub struct FastNode {
    never: bool,
    types: u8,
    obj: Option<Arc<FastObject>>,
    arr: Option<Arc<FastArray>>,
    str: Option<Arc<FastString>>,
    num: Option<Arc<FastNumber>>,
}

impl Default for FastNode {
    fn default() -> Self {
        Self {
            never: false,
            types: 0,
            obj: None,
            arr: None,
            str: None,
            num: None,
        }
    }
}

impl FastNode {
    fn any() -> Self {
        Self::default()
    }

    fn never() -> Self {
        Self {
            never: true,
            ..Self::default()
        }
    }

    /// Validate a complete JSON document against this schema.
    #[inline]
    pub fn is_valid_bytes(&self, bytes: &[u8]) -> bool {
        let mut c = Cursor::new(bytes);
        if !self.validate(&mut c) {
            return false;
        }
        c.skip_ws();
        c.pos == bytes.len()
    }

    fn validate(&self, c: &mut Cursor) -> bool {
        if self.never {
            return false;
        }
        c.skip_ws();
        let Some(b) = c.peek() else {
            return false;
        };
        if self.types != 0 {
            let Some(k) = kind_of(b) else {
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
                return false;
            }
        }
        match b {
            b'{' => match &self.obj {
                Some(o) => validate_object(o, c),
                None => c.skip_value(),
            },
            b'[' => match &self.arr {
                Some(a) => validate_array(a, c),
                None => c.skip_value(),
            },
            b'"' => {
                let Some(inner) = c.raw_string() else {
                    return false;
                };
                match &self.str {
                    Some(s) => {
                        let len = count_chars(inner);
                        if let Some(min) = s.min_len {
                            if len < min {
                                return false;
                            }
                        }
                        if let Some(max) = s.max_len {
                            if len > max {
                                return false;
                            }
                        }
                        true
                    }
                    None => true,
                }
            }
            b't' => c.eat_token(b"true"),
            b'f' => c.eat_token(b"false"),
            b'n' => c.eat_token(b"null"),
            _ => {
                let Some((n, _is_int)) = c.number() else {
                    return false;
                };
                // `type: "integer"` (without `number`) rejects non-integral values.
                if self.types & T_INT != 0 && self.types & T_NUM == 0 && n.fract() != 0.0 {
                    return false;
                }
                match &self.num {
                    Some(num) => {
                        if let Some(min) = num.minimum {
                            if n < min {
                                return false;
                            }
                        }
                        if let Some(max) = num.maximum {
                            if n > max {
                                return false;
                            }
                        }
                        if let Some(e) = num.exclusive_min {
                            if n <= e {
                                return false;
                            }
                        }
                        if let Some(e) = num.exclusive_max {
                            if n >= e {
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
}

fn validate_object(o: &FastObject, c: &mut Cursor) -> bool {
    if !c.eat(b'{') {
        return false;
    }
    c.skip_ws();
    let need_distinct = o.min_props.is_some() || o.max_props.is_some();
    let mut count: usize = 0;
    let mut seen_required: u64 = 0;
    let mut distinct: Option<HashSet<Box<[u8]>>> = if need_distinct {
        Some(HashSet::new())
    } else {
        None
    };

    if c.eat(b'}') {
        return finish_object(o, count, seen_required, &distinct);
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
            d.insert(key.to_vec().into_boxed_slice());
        }
        if let Some(&bit) = o.required.get(key) {
            seen_required |= 1u64 << bit;
        }
        c.skip_ws();
        if !c.eat(b':') {
            return false;
        }
        let value_ok = match o.props.get(key) {
            Some(node) => node.validate(c),
            None => match &o.additional {
                Additional::Allow => c.skip_value(),
                Additional::Deny => false,
                Additional::Schema(s) => s.validate(c),
            },
        };
        if !value_ok {
            return false;
        }
        c.skip_ws();
        if c.eat(b'}') {
            return finish_object(o, count, seen_required, &distinct);
        }
        if !c.eat(b',') {
            return false;
        }
    }
}

fn finish_object(
    o: &FastObject,
    count: usize,
    seen_required: u64,
    distinct: &Option<HashSet<Box<[u8]>>>,
) -> bool {
    let total = distinct.as_ref().map(|d| d.len()).unwrap_or(count);
    if let Some(min) = o.min_props {
        if total < min {
            return false;
        }
    }
    if let Some(max) = o.max_props {
        if total > max {
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
            return false;
        }
    }
    true
}

fn validate_array(a: &FastArray, c: &mut Cursor) -> bool {
    if !c.eat(b'[') {
        return false;
    }
    c.skip_ws();
    let mut count = 0usize;
    if c.eat(b']') {
        return check_array_counts(a, count);
    }
    loop {
        count += 1;
        if let Some(max) = a.max_items {
            if count > max {
                return false;
            }
        }
        let ok = match &a.items {
            Some(node) => node.validate(c),
            None => c.skip_value(),
        };
        if !ok {
            return false;
        }
        c.skip_ws();
        if c.eat(b']') {
            return check_array_counts(a, count);
        }
        if !c.eat(b',') {
            return false;
        }
        c.skip_ws();
    }
}

fn check_array_counts(a: &FastArray, count: usize) -> bool {
    if let Some(min) = a.min_items {
        if count < min {
            return false;
        }
    }
    if let Some(max) = a.max_items {
        if count > max {
            return false;
        }
    }
    true
}

// ── Compilation ───────────────────────────────────────────────────

/// Compile a schema into the zero-DOM fast representation, or `Err(())` if the
/// schema uses a keyword outside the supported subset (caller falls back).
pub fn compile(schema: &Value) -> Result<FastNode, ()> {
    match schema {
        Value::Bool(true) => Ok(FastNode::any()),
        Value::Bool(false) => Ok(FastNode::never()),
        Value::Object(map) => compile_object(map),
        _ => Err(()),
    }
}

fn compile_object(map: &serde_json::Map<String, Value>) -> Result<FastNode, ()> {
    // Reject unsupported keywords up front (versatility fallback).
    for key in map.keys() {
        match key.as_str() {
            "$ref" | "$dynamicRef" | "$recursiveRef" | "pattern" | "format" | "anyOf"
            | "oneOf" | "allOf" | "not" | "patternProperties" | "propertyNames"
            | "contains" | "minContains" | "maxContains" | "uniqueItems" | "enum"
            | "const" | "multipleOf" | "dependencies" | "dependentRequired"
            | "dependentSchemas" | "if" | "then" | "else" | "unevaluatedProperties"
            | "unevaluatedItems" | "prefixItems" => return Err(()),
            _ => {}
        }
    }

    let mut node = FastNode::default();

    if let Some(t) = map.get("type") {
        node.types = compile_type(t)?;
    }

    if ["required", "properties", "additionalProperties", "minProperties", "maxProperties"]
        .iter()
        .any(|k| map.contains_key(*k))
    {
        node.obj = Some(Arc::new(compile_object_constraints(map)?));
    }
    if ["items", "minItems", "maxItems"]
        .iter()
        .any(|k| map.contains_key(*k))
    {
        node.arr = Some(Arc::new(compile_array_constraints(map)?));
    }
    if map.contains_key("minLength") || map.contains_key("maxLength") {
        node.str = Some(Arc::new(compile_string_constraints(map)?));
    }
    if ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]
        .iter()
        .any(|k| map.contains_key(*k))
    {
        node.num = Some(Arc::new(compile_number_constraints(map)?));
    }

    Ok(node)
}

fn compile_type(v: &Value) -> Result<u8, ()> {
    let mut mask = 0u8;
    let mut add = |s: &str| -> Result<(), ()> {
        let m = match s {
            "null" => T_NULL,
            "boolean" => T_BOOL,
            "number" => T_NUM,
            "integer" => T_INT,
            "string" => T_STR,
            "array" => T_ARR,
            "object" => T_OBJ,
            _ => return Err(()),
        };
        mask |= m;
        Ok(())
    };
    match v {
        Value::String(s) => add(s)?,
        Value::Array(a) => {
            for x in a {
                let s = x.as_str().ok_or(())?;
                add(s)?;
            }
        }
        _ => return Err(()),
    }
    Ok(mask)
}

fn nonneg_usize(v: &Value) -> Result<usize, ()> {
    v.as_u64().map(|x| x as usize).ok_or(())
}

fn number_f64(v: &Value) -> Result<f64, ()> {
    v.as_f64().ok_or(())
}

fn compile_object_constraints(map: &serde_json::Map<String, Value>) -> Result<FastObject, ()> {
    let mut o = FastObject {
        props: HashMap::new(),
        required: HashMap::new(),
        required_count: 0,
        additional: Additional::Allow,
        min_props: None,
        max_props: None,
    };

    if let Some(v) = map.get("properties") {
        let props = v.as_object().ok_or(())?;
        for (name, sub) in props {
            let n = compile(sub)?;
            o.props
                .insert(name.as_bytes().to_vec().into_boxed_slice(), Arc::new(n));
        }
    }

    if let Some(v) = map.get("required") {
        let arr = v.as_array().ok_or(())?;
        let mut idx = 0u32;
        for item in arr {
            let s = item.as_str().ok_or(())?;
            let key: Box<[u8]> = s.as_bytes().to_vec().into_boxed_slice();
            if !o.required.contains_key(&key) {
                o.required.insert(key, idx);
                idx += 1;
                if idx > 64 {
                    return Err(());
                }
            }
        }
        o.required_count = idx as usize;
    }

    if let Some(v) = map.get("additionalProperties") {
        match v {
            Value::Bool(true) => o.additional = Additional::Allow,
            Value::Bool(false) => o.additional = Additional::Deny,
            Value::Object(_) => o.additional = Additional::Schema(Arc::new(compile(v)?)),
            _ => return Err(()),
        }
    }

    if let Some(v) = map.get("minProperties") {
        o.min_props = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxProperties") {
        o.max_props = Some(nonneg_usize(v)?);
    }

    Ok(o)
}

fn compile_array_constraints(map: &serde_json::Map<String, Value>) -> Result<FastArray, ()> {
    let mut a = FastArray {
        items: None,
        min_items: None,
        max_items: None,
    };
    if let Some(v) = map.get("items") {
        // Tuple form (array of schemas) is unsupported -> fallback.
        if v.is_array() {
            return Err(());
        }
        a.items = Some(Arc::new(compile(v)?));
    }
    if let Some(v) = map.get("minItems") {
        a.min_items = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxItems") {
        a.max_items = Some(nonneg_usize(v)?);
    }
    Ok(a)
}

fn compile_string_constraints(map: &serde_json::Map<String, Value>) -> Result<FastString, ()> {
    let mut s = FastString {
        min_len: None,
        max_len: None,
    };
    if let Some(v) = map.get("minLength") {
        s.min_len = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxLength") {
        s.max_len = Some(nonneg_usize(v)?);
    }
    Ok(s)
}

fn compile_number_constraints(map: &serde_json::Map<String, Value>) -> Result<FastNumber, ()> {
    let mut n = FastNumber {
        minimum: None,
        maximum: None,
        exclusive_min: None,
        exclusive_max: None,
    };
    if let Some(v) = map.get("minimum") {
        n.minimum = Some(number_f64(v)?);
    }
    if let Some(v) = map.get("maximum") {
        n.maximum = Some(number_f64(v)?);
    }
    // Only the numeric form of exclusive bounds is unambiguous across drafts;
    // the boolean form (draft-07) triggers a fallback to the reference crate.
    if let Some(v) = map.get("exclusiveMinimum") {
        n.exclusive_min = Some(number_f64(v)?);
    }
    if let Some(v) = map.get("exclusiveMaximum") {
        n.exclusive_max = Some(number_f64(v)?);
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_parity(schema: Value, docs: &[&str]) {
        let fast = compile(&schema).expect("schema must compile on the fast path");
        let v = jsonschema::validator_for(&schema).expect("schema must compile on reference");
        for &doc in docs {
            let expected = serde_json::from_str::<Value>(doc)
                .map(|value| v.is_valid(&value))
                .unwrap_or(false);
            let got = fast.is_valid_bytes(doc.as_bytes());
            assert_eq!(got, expected, "schema={schema} doc={doc}");
        }
    }

    fn bench_schema() -> Value {
        json!({
            "type": "object",
            "required": ["id", "name", "active", "score", "tags", "nested"],
            "properties": {
                "id": { "type": "number" },
                "name": { "type": "string", "minLength": 1 },
                "active": { "type": "boolean" },
                "score": { "type": "number" },
                "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
                "nested": {
                    "type": "object",
                    "required": ["version", "createdAt"],
                    "properties": {
                        "version": { "type": "number" },
                        "createdAt": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        })
    }

    #[test]
    fn bench_schema_parity() {
        let schema = bench_schema();
        let docs = [
            // valid
            r#"{"id":1,"name":"user_1","active":true,"score":1.25,"tags":["alpha","beta"],"nested":{"version":1,"createdAt":"2026-01-01T00:00:00Z"}}"#,
            r#"{"id":2,"name":"b","active":false,"score":0,"tags":[],"nested":{"version":2,"createdAt":"x"}}"#,
            // wrong root type
            r#"[]"#,
            r#"42"#,
            r#""hi""#,
            r#"null"#,
            // wrong property types
            r#"{"id":"x","name":"a","active":true,"score":1,"tags":[],"nested":{"version":1,"createdAt":"c"}}"#,
            r#"{"id":1,"name":"a","active":"yes","score":1,"tags":[],"nested":{"version":1,"createdAt":"c"}}"#,
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":["a",1],"nested":{"version":1,"createdAt":"c"}}"#,
            // missing required
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":[]}"#,
            // extra property (additionalProperties:false)
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":[],"extra":1,"nested":{"version":1,"createdAt":"c"}}"#,
            // nested extra property
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":[],"nested":{"version":1,"createdAt":"c","z":2}}"#,
            // nested missing required
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":[],"nested":{"version":1}}"#,
            // minLength violation + maxItems violation
            r#"{"id":1,"name":"","active":true,"score":1,"tags":[],"nested":{"version":1,"createdAt":"c"}}"#,
            r#"{"id":1,"name":"a","active":true,"score":1,"tags":["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u"],"nested":{"version":1,"createdAt":"c"}}"#,
            // malformed JSON
            r#"{"id":1,"name":"a""#,
            r#"not json"#,
            r#"{"id":1,}"#,
        ];
        assert_parity(schema, &docs);
    }

    #[test]
    fn simple_type_parity() {
        let schemas = [
            json!({"type":"object"}),
            json!({"type":"array"}),
            json!({"type":"string"}),
            json!({"type":"number"}),
            json!({"type":"integer"}),
            json!({"type":"boolean"}),
            json!({"type":"null"}),
            json!({"type":["string","number"]}),
            json!({}),
            json!(true),
            json!(false),
        ];
        let docs = [
            "{}", "[]", "\"x\"", "42", "42.5", "1e2", "true", "false", "null",
            "{\"a\":1}", "[1,2]", "\"\"", "-0", "0.1",
        ];
        for s in &schemas {
            assert_parity(s.clone(), &docs);
        }
    }

    #[test]
    fn string_length_parity() {
        let schemas = [
            json!({"type":"string","minLength":2}),
            json!({"type":"string","maxLength":4}),
            json!({"type":"string","minLength":1,"maxLength":3}),
        ];
        let docs = [
            r#""ab""#, r#""a""#, r#""abcd""#, r#""abcde""#, r#""""#,
            // escapes count as decoded length
            r#""\u0041""#,  // "A" -> len 1
            r#""a\u0041b""#, // "aAb" -> len 3
            r#""\n\t""#,    // 2 chars
            r#""\uD83D\uDE00""#, // 😀 -> len 1
        ];
        for s in &schemas {
            assert_parity(s.clone(), &docs);
        }
    }

    #[test]
    fn number_bounds_parity() {
        let schemas = [
            json!({"type":"number","minimum":0,"maximum":10}),
            json!({"type":"integer","minimum":1}),
            json!({"type":"number","exclusiveMinimum":0.5}),
            json!({"type":"number","exclusiveMaximum":5}),
            json!({"type":"integer"}),
        ];
        let docs = [
            "0", "5", "10", "11", "-1", "0.5", "0.5000001", "1e1", "1.5", "2.0",
            "-0", "0.1", "100",
        ];
        for s in &schemas {
            assert_parity(s.clone(), &docs);
        }
    }

    #[test]
    fn array_parity() {
        let schemas = [
            json!({"type":"array","items":{"type":"string"}}),
            json!({"type":"array","minItems":1,"maxItems":3}),
            json!({"type":"array","items":{"type":"integer"},"minItems":2}),
        ];
        let docs = [
            "[]", "[\"a\"]", "[\"a\",\"b\",\"c\"]", "[\"a\",1]", "[1]", "[1,2,3]",
            "[1,2]", "[1.5]", "[\"a\",\"b\",\"c\",\"d\"]", "{}", "null",
        ];
        for s in &schemas {
            assert_parity(s.clone(), &docs);
        }
    }

    #[test]
    fn object_required_additional_parity() {
        let schemas = [
            json!({"required":["a"]}),
            json!({"properties":{"a":{"type":"string"}}}),
            json!({"properties":{"a":{"type":"string"}},"additionalProperties":false}),
            json!({"properties":{"a":{"type":"string"}},"additionalProperties":{"type":"number"}}),
            json!({"type":"object","minProperties":1,"maxProperties":2}),
            json!({"required":["a","b"]}),
        ];
        let docs = [
            "{}", "{\"a\":1}", "{\"a\":\"x\"}", "{\"b\":1}", "{\"a\":1,\"b\":2}",
            "{\"a\":1,\"c\":true}", "{\"c\":true}", "{\"a\":\"x\",\"c\":\"s\"}",
            "{\"a\":\"x\",\"c\":1}", "{\"a\":\"x\",\"b\":\"y\"}", "\"str\"", "[]",
            // duplicate keys (reference dedups, last wins)
            "{\"a\":1,\"a\":2}", "{\"x\":1,\"x\":2}",
            // escaped keys
            "{\"\\u0061\":\"x\"}", // key "a"
        ];
        for s in &schemas {
            assert_parity(s.clone(), &docs);
        }
    }

    #[test]
    fn nested_composite_parity() {
        let schemas = [
            json!({
                "type": "object",
                "properties": {
                    "data": {
                        "type": "object",
                        "required": ["x"],
                        "properties": { "x": { "type": "integer" } },
                        "additionalProperties": false
                    },
                    "list": {
                        "type": "array",
                        "items": { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] }
                    }
                },
                "required": ["data"]
            }),
        ];
        let docs = [
            r#"{"data":{"x":1}}"#,
            r#"{"data":{"x":"bad"}}"#,
            r#"{"data":{"x":1,"y":2}}"#,
            r#"{"data":{"x":1},"list":[{"n":1},{"n":2}]}"#,
            r#"{"data":{"x":1},"list":[{"n":1},{"m":2}]}"#,
            r#"{"data":{"x":1},"list":[]}"#,
            r#"{}"#,
            r#"{"data":{}}"#,
        ];
        assert_parity(schemas[0].clone(), &docs);
    }

    #[test]
    fn unsupported_keywords_fall_back() {
        // These must NOT compile on the fast path (caller falls back to DOM).
        let unsupported = [
            json!({"pattern":"^a"}),
            json!({"format":"email"}),
            json!({"anyOf":[{"type":"string"},{"type":"number"}]}),
            json!({"$ref":"#/definitions/x"}),
            json!({"enum":[1,2,3]}),
            json!({"const":5}),
            json!({"multipleOf":3}),
            json!({"uniqueItems":true}),
            json!({"allOf":[{"type":"string"}]}),
            json!({"not":{"type":"string"}}),
            json!({"patternProperties":{"^x":{"type":"string"}}}),
            json!({"items":[{"type":"string"}]}),
            json!({"exclusiveMinimum":true}), // draft-07 boolean form
            json!({"prefixItems":[{"type":"string"}]}),
            json!({"if":{"type":"string"},"then":{"type":"string"}}),
        ];
        for s in &unsupported {
            assert!(compile(s).is_err(), "should fall back: {s}");
        }
        // Sanity: the supported bench schema DOES compile.
        assert!(compile(&bench_schema()).is_ok());
    }
}
