// rust/json/fast_schema/compile.rs — Schema → AST compiler.
//
// Compiles a `serde_json::Value` schema into the zero-DOM `FastNode`
// representation. Returns `Err(())` for any keyword outside the supported
// subset so the caller can fall back to the jsonschema crate DOM path.
//
// Supported surface (draft-07 validation keywords): type, enum, const,
// multipleOf, minimum/maximum, exclusiveMinimum/exclusiveMaximum (numeric),
// minLength/maxLength, pattern, items (single + draft-07 tuple), additionalItems,
// minItems/maxItems, uniqueItems, contains, minProperties/maxProperties,
// required, properties, patternProperties, additionalProperties, dependencies
// (array-of-required-strings form), if/then/else, allOf, anyOf, oneOf, not,
// $ref (in-document JSON pointers: `#`, `#/definitions/*`, `#/$defs/*`, and any
// object/bool subschema), format: "email".
//
// Falls back (Err) for: propertyNames, dependencies with a schema value,
// draft-04/06 boolean exclusive bounds, formats != email, remote/dynamic/
// recursive/anchor `$ref`, non-draft-07 `$schema`, enum+const together, and any
// keyword we cannot honor under draft-07 semantics.

use rustc_hash::FxHashMap;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::types::{
    Additional, FastArray, FastComb, FastNode, FastNumber, FastObject, FastString, ValueConstraint,
    T_ARR, T_BOOL, T_INT, T_NULL, T_NUM, T_OBJ, T_STR,
};

/// Compile a schema into the zero-DOM fast representation, or `Err(())` if the
/// schema uses a keyword outside the supported subset (caller falls back).
///
/// `Err(())` is a deliberate, internal-only signal (no user-facing error
/// payload); the caller maps it to the DOM fallback path.
#[allow(clippy::result_unit_err)]
pub fn compile(schema: &Value) -> Result<FastNode, ()> {
    // `$schema` guard: the fast path implements draft-07 semantics. A schema
    // declaring a different draft diverges (boolean exclusive bounds,
    // prefixItems/unevaluated*, `$ref` siblings, …) — fall back. Without a
    // `$schema` the reference defaults to draft-07, matching us.
    if let Some(Value::String(ss)) = schema.as_object().and_then(|m| m.get("$schema")) {
        if !ss.contains("draft-07") {
            return Err(());
        }
    }
    // Index every object/bool subschema by JSON pointer for `$ref` resolution.
    let mut refs: HashMap<String, &Value> = HashMap::new();
    refs.insert(String::new(), schema);
    collect_refs(schema, "", &mut refs);
    let mut ctx = CompileCtx {
        refs,
        cache: HashMap::new(),
        in_progress: Vec::new(),
    };
    compile_node(schema, "", &mut ctx)
}

/// `$ref` resolution state: subschema index, compiled-target cache, and a
/// cycle-detection stack (cyclic `$ref` graphs fall back to the DOM path).
struct CompileCtx<'a> {
    refs: HashMap<String, &'a Value>,
    cache: HashMap<String, Arc<FastNode>>,
    in_progress: Vec<String>,
}

/// Register every object/bool value in the document at its JSON pointer.
fn collect_refs<'a>(v: &'a Value, ptr: &str, out: &mut HashMap<String, &'a Value>) {
    match v {
        Value::Object(map) => {
            if !ptr.is_empty() {
                out.insert(ptr.to_string(), v);
            }
            for (k, val) in map {
                let child = if ptr.is_empty() {
                    format!("/{}", escape_pointer(k))
                } else {
                    format!("{}/{}", ptr, escape_pointer(k))
                };
                collect_refs(val, &child, out);
            }
        }
        Value::Bool(_) => {
            if !ptr.is_empty() {
                out.insert(ptr.to_string(), v);
            }
        }
        Value::Array(arr) => {
            for (i, val) in arr.iter().enumerate() {
                collect_refs(val, &format!("{}/{}", ptr, i), out);
            }
        }
        _ => {}
    }
}

/// RFC 6901 pointer escaping for schema-path keys.
fn escape_pointer(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

fn compile_node(schema: &Value, path: &str, ctx: &mut CompileCtx<'_>) -> Result<FastNode, ()> {
    match schema {
        Value::Bool(true) => Ok(FastNode::any()),
        Value::Bool(false) => Ok(FastNode::never()),
        Value::Object(map) => {
            // `$ref`: under draft-07 sibling keywords are ignored, so resolve
            // and return the referenced node directly.
            if let Some(Value::String(r)) = map.get("$ref") {
                return compile_ref(r, ctx).map(|n| n.as_ref().clone());
            }
            // Keywords this fast path cannot honor under draft-07.
            if map.contains_key("propertyNames") {
                return Err(());
            }
            // `dependencies` schema form is unsupported; only array-of-strings.
            if let Some(Value::Object(deps)) = map.get("dependencies") {
                if deps.values().any(|v| !v.is_array()) {
                    return Err(());
                }
            }
            // `format`: only "email" is byte-parity on the fast path.
            if let Some(Value::String(f)) = map.get("format") {
                if f != "email" {
                    return Err(());
                }
            }
            // Draft-07 exclusive bounds are numeric; boolean form is draft-04/06.
            for k in ["exclusiveMinimum", "exclusiveMaximum"] {
                if let Some(v) = map.get(k) {
                    if !v.is_number() {
                        return Err(());
                    }
                }
            }
            // enum + const together: unusual combination, keep on the DOM path.
            if map.contains_key("enum") && map.contains_key("const") {
                return Err(());
            }

            let mut node = FastNode {
                schema_path: Some(path.to_string()),
                ..FastNode::default()
            };

            if let Some(t) = map.get("type") {
                node.types = compile_type(t)?;
            }

            if [
                "required",
                "properties",
                "patternProperties",
                "additionalProperties",
                "minProperties",
                "maxProperties",
                "dependencies",
            ]
            .iter()
            .any(|k| map.contains_key(*k))
            {
                node.obj = Some(Arc::new(compile_object_constraints(map, path, ctx)?));
            }
            if [
                "items",
                "additionalItems",
                "minItems",
                "maxItems",
                "uniqueItems",
                "contains",
            ]
            .iter()
            .any(|k| map.contains_key(*k))
            {
                node.arr = Some(Arc::new(compile_array_constraints(map, path, ctx)?));
            }
            if map.contains_key("minLength")
                || map.contains_key("maxLength")
                || map.contains_key("pattern")
                || map.contains_key("format")
            {
                node.str = Some(Arc::new(compile_string_constraints(map)?));
            }
            if [
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
            ]
            .iter()
            .any(|k| map.contains_key(*k))
            {
                node.num = Some(Arc::new(compile_number_constraints(map)?));
            }
            if ["allOf", "anyOf", "oneOf", "not", "if", "then", "else"]
                .iter()
                .any(|k| map.contains_key(*k))
            {
                node.comb = Some(Arc::new(compile_combinators(map, path, ctx)?));
            }
            if let Some(v) = map.get("enum") {
                node.value = Some(compile_enum(v)?);
            } else if let Some(v) = map.get("const") {
                node.value = Some(ValueConstraint::Const(Arc::new(serde_to_sonic(v))));
            }

            Ok(node)
        }
        _ => Err(()),
    }
}

/// Resolve an in-document `$ref`. Returns `Err` for external URIs, anchors, and
/// cyclic references (all handled by the DOM fallback).
fn compile_ref(r: &str, ctx: &mut CompileCtx<'_>) -> Result<Arc<FastNode>, ()> {
    if !r.starts_with('#') || (r.len() > 1 && !r.starts_with("#/")) {
        return Err(());
    }
    let pointer = &r[1..]; // strip '#'
    if let Some(node) = ctx.cache.get(pointer) {
        return Ok(node.clone());
    }
    if ctx.in_progress.iter().any(|p| p == pointer) {
        return Err(());
    }
    let target = *ctx.refs.get(pointer).ok_or(())?;
    ctx.in_progress.push(pointer.to_string());
    let node = Arc::new(compile_node(target, pointer, ctx)?);
    ctx.in_progress.pop();
    ctx.cache.insert(pointer.to_string(), node.clone());
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

fn compile_object_constraints(
    map: &serde_json::Map<String, Value>,
    path: &str,
    ctx: &mut CompileCtx<'_>,
) -> Result<FastObject, ()> {
    let mut o = FastObject {
        props: FxHashMap::default(),
        patterns: Vec::new(),
        required: FxHashMap::default(),
        required_count: 0,
        additional: Additional::Allow,
        min_props: None,
        max_props: None,
        dependent_required: Vec::new(),
    };

    if let Some(Value::Object(props)) = map.get("properties") {
        for (name, sub) in props {
            let sub_path = format!("{}/properties/{}", path, escape_pointer(name));
            let n = compile_node(sub, &sub_path, ctx)?;
            o.props
                .insert(name.as_bytes().to_vec().into_boxed_slice(), Arc::new(n));
        }
    }

    if let Some(Value::Object(pats)) = map.get("patternProperties") {
        for (re_str, sub) in pats {
            let re = fancy_regex::Regex::new(re_str).map_err(|_| ())?;
            let sub_path = format!("{}/patternProperties/{}", path, escape_pointer(re_str));
            let n = compile_node(sub, &sub_path, ctx)?;
            o.patterns.push((re, Arc::new(n)));
        }
    }

    if let Some(v) = map.get("required") {
        let arr = v.as_array().ok_or(())?;
        let mut idx = 0u32;
        for item in arr {
            let s = item.as_str().ok_or(())?;
            let key: Box<[u8]> = s.as_bytes().to_vec().into_boxed_slice();
            if let std::collections::hash_map::Entry::Vacant(e) = o.required.entry(key) {
                e.insert(idx);
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
            Value::Object(_) => {
                o.additional = Additional::Schema(Arc::new(compile_node(
                    v,
                    &format!("{}/additionalProperties", path),
                    ctx,
                )?))
            }
            _ => return Err(()),
        }
    }

    if let Some(v) = map.get("minProperties") {
        o.min_props = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxProperties") {
        o.max_props = Some(nonneg_usize(v)?);
    }

    if let Some(Value::Object(deps)) = map.get("dependencies") {
        for (prop, reqs) in deps {
            let arr = reqs.as_array().ok_or(())?;
            let mut req_keys = Vec::with_capacity(arr.len());
            for item in arr {
                let s = item.as_str().ok_or(())?;
                req_keys.push(s.as_bytes().to_vec().into_boxed_slice());
            }
            o.dependent_required
                .push((prop.as_bytes().to_vec().into_boxed_slice(), req_keys));
        }
    }

    Ok(o)
}

fn compile_array_constraints(
    map: &serde_json::Map<String, Value>,
    path: &str,
    ctx: &mut CompileCtx<'_>,
) -> Result<FastArray, ()> {
    let mut a = FastArray {
        items: None,
        tuple_items: None,
        additional_items: None,
        min_items: None,
        max_items: None,
        unique: false,
        contains: None,
    };
    if let Some(v) = map.get("items") {
        if let Value::Array(tuple) = v {
            // draft-07 tuple form: each element schema at `items/<i>`.
            let mut nodes = Vec::with_capacity(tuple.len());
            for (i, sub) in tuple.iter().enumerate() {
                nodes.push(Arc::new(compile_node(
                    sub,
                    &format!("{}/items/{}", path, i),
                    ctx,
                )?));
            }
            a.tuple_items = Some(nodes);
        } else {
            a.items = Some(Arc::new(compile_node(v, &format!("{}/items", path), ctx)?));
        }
    }
    // `additionalItems` only applies alongside tuple `items` (draft-07).
    if let Some(v) = map.get("additionalItems") {
        if a.tuple_items.is_some() {
            a.additional_items = Some(match v {
                Value::Bool(true) => Additional::Allow,
                Value::Bool(false) => Additional::Deny,
                Value::Object(_) => Additional::Schema(Arc::new(compile_node(
                    v,
                    &format!("{}/additionalItems", path),
                    ctx,
                )?)),
                _ => return Err(()),
            });
        }
    }
    if let Some(v) = map.get("minItems") {
        a.min_items = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxItems") {
        a.max_items = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("uniqueItems") {
        a.unique = match v {
            Value::Bool(b) => *b,
            _ => return Err(()),
        };
    }
    if let Some(v) = map.get("contains") {
        a.contains = Some(Arc::new(compile_node(
            v,
            &format!("{}/contains", path),
            ctx,
        )?));
    }
    Ok(a)
}

fn compile_string_constraints(map: &serde_json::Map<String, Value>) -> Result<FastString, ()> {
    let mut s = FastString {
        min_len: None,
        max_len: None,
        pattern: None,
        format_email: false,
    };
    if let Some(v) = map.get("minLength") {
        s.min_len = Some(nonneg_usize(v)?);
    }
    if let Some(v) = map.get("maxLength") {
        s.max_len = Some(nonneg_usize(v)?);
    }
    if let Some(Value::String(re_str)) = map.get("pattern") {
        // fancy-regex = the jsonschema engine (ECMA-262 semantics, unanchored).
        let re = fancy_regex::Regex::new(re_str).map_err(|_| ())?;
        s.pattern = Some(Arc::new(re));
    }
    if let Some(Value::String(f)) = map.get("format") {
        // Only `format: "email"` is supported on the zero-DOM path (see
        // `email.rs`); every other format value falls back to the DOM path so
        // byte-parity is preserved by construction.
        if f == "email" {
            s.format_email = true;
        }
    }
    Ok(s)
}

fn compile_number_constraints(map: &serde_json::Map<String, Value>) -> Result<FastNumber, ()> {
    let mut n = FastNumber {
        minimum: None,
        maximum: None,
        exclusive_min: None,
        exclusive_max: None,
        multiple_of: None,
    };
    if let Some(v) = map.get("minimum") {
        n.minimum = Some(number_f64(v)?);
    }
    if let Some(v) = map.get("maximum") {
        n.maximum = Some(number_f64(v)?);
    }
    // Only the numeric form of exclusive bounds is unambiguous across drafts;
    // the boolean form (draft-04/06) triggers a fallback to the reference crate.
    if let Some(v) = map.get("exclusiveMinimum") {
        n.exclusive_min = Some(number_f64(v)?);
    }
    if let Some(v) = map.get("exclusiveMaximum") {
        n.exclusive_max = Some(number_f64(v)?);
    }
    if let Some(v) = map.get("multipleOf") {
        n.multiple_of = Some(number_f64(v)?);
    }
    Ok(n)
}

fn compile_combinators(
    map: &serde_json::Map<String, Value>,
    path: &str,
    ctx: &mut CompileCtx<'_>,
) -> Result<FastComb, ()> {
    let mut c = FastComb {
        all_of: Vec::new(),
        any_of: Vec::new(),
        one_of: Vec::new(),
        not: None,
        if_then_else: None,
    };
    if let Some(Value::Array(arr)) = map.get("allOf") {
        for (i, sub) in arr.iter().enumerate() {
            c.all_of.push(Arc::new(compile_node(
                sub,
                &format!("{}/allOf/{}", path, i),
                ctx,
            )?));
        }
    }
    if let Some(Value::Array(arr)) = map.get("anyOf") {
        for (i, sub) in arr.iter().enumerate() {
            c.any_of.push(Arc::new(compile_node(
                sub,
                &format!("{}/anyOf/{}", path, i),
                ctx,
            )?));
        }
    }
    if let Some(Value::Array(arr)) = map.get("oneOf") {
        for (i, sub) in arr.iter().enumerate() {
            c.one_of.push(Arc::new(compile_node(
                sub,
                &format!("{}/oneOf/{}", path, i),
                ctx,
            )?));
        }
    }
    if let Some(v) = map.get("not") {
        c.not = Some(Arc::new(compile_node(v, &format!("{}/not", path), ctx)?));
    }
    if let Some(ifv) = map.get("if") {
        let if_node = Arc::new(compile_node(ifv, &format!("{}/if", path), ctx)?);
        let then_node = map
            .get("then")
            .map(|v| compile_node(v, &format!("{}/then", path), ctx))
            .transpose()?
            .map(Arc::new);
        let else_node = map
            .get("else")
            .map(|v| compile_node(v, &format!("{}/else", path), ctx))
            .transpose()?
            .map(Arc::new);
        c.if_then_else = Some((if_node, then_node, else_node));
    }
    Ok(c)
}

/// Convert a `serde_json::Value` schema literal into a `sonic_rs::Value`.
/// Compile-time only: the enum/const literals are stored as compact sonic
/// values and compared against runtime doc values with the zero-DOM
/// `sonic_values_equal` (no per-document serde_json DOM on the fast path).
fn serde_to_sonic(v: &serde_json::Value) -> sonic_rs::Value {
    sonic_rs::from_slice::<sonic_rs::Value>(&serde_json::to_vec(v).unwrap()).unwrap()
}

fn compile_enum(v: &Value) -> Result<ValueConstraint, ()> {
    let arr = v.as_array().ok_or(())?;
    let members = arr.iter().map(|m| Arc::new(serde_to_sonic(m))).collect();
    Ok(ValueConstraint::Enum(members))
}
