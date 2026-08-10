// rust/json/fast_schema/validate.rs — AST + raw bytes → boolean validation.
//
// Walks a compiled `FastNode` over raw JSON bytes with a `Cursor`, allocating
// only for the rare escaped-key path (and a distinct-key set only when
// min/maxProperties are present).

use super::cursor::{count_chars, decode_string, Cursor};
use super::types::{
    Additional, FastArray, FastNode, FastObject, Kind, T_ARR, T_BOOL, T_INT, T_NULL, T_NUM,
    T_OBJ, T_STR, kind_of,
};

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

pub(crate) fn validate_object(o: &FastObject, c: &mut Cursor) -> bool {
    if !c.eat(b'{') {
        return false;
    }
    c.skip_ws();
    let need_distinct = o.min_props.is_some() || o.max_props.is_some();
    let mut count: usize = 0;
    let mut seen_required: u64 = 0;
    // Distinct-key tracking for min/maxProperties: an inline Vec + linear scan
    // (object key counts are typically small) instead of a per-document
    // HashSet, which keeps this otherwise allocation-free path heap-light.
    let mut distinct: Option<Vec<Box<[u8]>>> = if need_distinct {
        Some(Vec::new())
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
            if !d.iter().any(|k| k.as_ref() == key) {
                d.push(key.to_vec().into_boxed_slice());
            }
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

pub(crate) fn finish_object(
    o: &FastObject,
    count: usize,
    seen_required: u64,
    distinct: &Option<Vec<Box<[u8]>>>,
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

pub(crate) fn validate_array(a: &FastArray, c: &mut Cursor) -> bool {
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

pub(crate) fn check_array_counts(a: &FastArray, count: usize) -> bool {
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
