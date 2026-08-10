// rust/json/fast_schema/tests.rs — Fast-path vs jsonschema-crate parity tests.
//
// Every supported construct is checked for exact agreement with the reference
// `jsonschema` crate (the authoritative DOM path); unsupported keywords must
// fail to compile so the caller falls back.

use super::*;
use serde_json::{json, Value};

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
