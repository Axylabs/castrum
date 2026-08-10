// rust/json/fast_schema/compile.rs — Schema → AST compiler.
//
// Compiles a `serde_json::Value` schema into the zero-DOM `FastNode`
// representation. Returns `Err(())` for any keyword outside the supported
// subset so the caller can fall back to the jsonschema crate DOM path.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::types::{
    Additional, FastArray, FastNode, FastNumber, FastObject, FastString, T_ARR, T_BOOL, T_INT,
    T_NULL, T_NUM, T_OBJ, T_STR,
};

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
