// rust/json/fast_schema/tests.rs — Fast-path vs jsonschema-crate parity tests.
//
// Every supported construct is checked for exact agreement with the reference
// `jsonschema` crate (the authoritative DOM path); unsupported keywords must
// fail to compile so the caller falls back.

use super::*;
use serde_json::{json, Value};

fn assert_parity(schema: Value, docs: &[&str]) {
    let fast = compile(&schema).expect("schema must compile on the fast path");
    // The fast path implements draft-07; pin the reference so parity is
    // meaningful (jsonschema 0.48's default draft is 2020-12, whose `items`/
    // `$ref`-sibling/boolean-exclusive semantics differ from draft-07).
    let v = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .should_validate_formats(true)
        .build(&schema)
        .expect("schema must compile on reference");
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
        "{}",
        "[]",
        "\"x\"",
        "42",
        "42.5",
        "1e2",
        "true",
        "false",
        "null",
        "{\"a\":1}",
        "[1,2]",
        "\"\"",
        "-0",
        "0.1",
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
        r#""ab""#,
        r#""a""#,
        r#""abcd""#,
        r#""abcde""#,
        r#""""#,
        // escapes count as decoded length
        r#""\u0041""#,       // "A" -> len 1
        r#""a\u0041b""#,     // "aAb" -> len 3
        r#""\n\t""#,         // 2 chars
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
        "0",
        "5",
        "10",
        "11",
        "-1",
        "0.5",
        "0.5000001",
        "1e1",
        "1.5",
        "2.0",
        "-0",
        "0.1",
        "100",
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
        "[]",
        "[\"a\"]",
        "[\"a\",\"b\",\"c\"]",
        "[\"a\",1]",
        "[1]",
        "[1,2,3]",
        "[1,2]",
        "[1.5]",
        "[\"a\",\"b\",\"c\",\"d\"]",
        "{}",
        "null",
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
        "{}",
        "{\"a\":1}",
        "{\"a\":\"x\"}",
        "{\"b\":1}",
        "{\"a\":1,\"b\":2}",
        "{\"a\":1,\"c\":true}",
        "{\"c\":true}",
        "{\"a\":\"x\",\"c\":\"s\"}",
        "{\"a\":\"x\",\"c\":1}",
        "{\"a\":\"x\",\"b\":\"y\"}",
        "\"str\"",
        "[]",
        // duplicate keys (reference dedups, last wins)
        "{\"a\":1,\"a\":2}",
        "{\"x\":1,\"x\":2}",
        // escaped keys
        "{\"\\u0061\":\"x\"}", // key "a"
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn min_max_properties_distinct_parity() {
    let schemas = [
        json!({"type":"object","minProperties":1}),
        json!({"type":"object","maxProperties":2}),
        json!({"type":"object","minProperties":1,"maxProperties":2}),
        // These force the inline → heap distinct-key migration (>16 keys or a
        // >48-byte key) — the heap path must stay byte-parity with the crate.
        json!({"type":"object","minProperties":16,"maxProperties":17}),
        json!({"type":"object","minProperties":1,"maxProperties":1}),
    ];
    let docs = [
        "{}",
        "{\"a\":1}",
        "{\"a\":1,\"b\":2}",
        "{\"a\":1,\"b\":2,\"c\":3}",
        // Duplicate keys: the distinct count differs from the member count.
        "{\"a\":1,\"a\":2}",
        // 17 distinct keys → exceeds the 16-slot inline tracker.
        "{\"k0\":0,\"k1\":1,\"k2\":2,\"k3\":3,\"k4\":4,\"k5\":5,\"k6\":6,\"k7\":7,\"k8\":8,\"k9\":9,\"k10\":10,\"k11\":11,\"k12\":12,\"k13\":13,\"k14\":14,\"k15\":15,\"k16\":16}",
        // Key longer than the 48-byte inline key buffer.
        "{\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\":1}",
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn nested_composite_parity() {
    let schemas = [json!({
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
    })];
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
        json!({"propertyNames":{"type":"string"}}),
        json!({"format":"uri"}), // only format:email is fast-path
        json!({"format":"date-time"}),
        json!({"exclusiveMinimum":true}), // draft-04/06 boolean form
        json!({"$ref":"other.json#/definitions/x"}), // external ref
        json!({"$ref":"#anchor"}),        // anchor ref (unsupported)
        json!({"$schema":"http://json-schema.org/draft-04/schema#"}),
        json!({"dependencies":{"a":{"type":"string"}}}), // schema form
        json!({"enum":[1,2],"const":1}),                 // enum + const together
    ];
    for s in &unsupported {
        assert!(compile(s).is_err(), "should fall back: {s}");
    }
    // Sanity: the supported bench schema DOES compile.
    assert!(compile(&bench_schema()).is_ok());
}

// ── extended draft-07 keyword parity (fast vs jsonschema crate) ──────────

#[test]
fn pattern_parity() {
    let schemas = [
        json!({"type":"string","pattern":"^a"}),
        json!({"type":"string","pattern":"\\d{3}-\\d{4}"}),
        json!({"type":"string","pattern":"a.c"}),
        // ECMA-262 lookahead (fancy-regex only; the regex crate would reject it)
        json!({"type":"string","pattern":"foo(?=bar)"}),
        json!({"type":"string","pattern":"^(a|b)+$"}),
    ];
    let docs = [
        r#""abc""#,
        r#""a""#,
        r#""xabc""#,
        r#""123-4567""#,
        r#""12-34""#,
        r#""foobar""#,
        r#""foo""#,
        r#""foobaz""#,
        r#""ab""#,
        r#""baba""#,
        r#""ccc""#,
        "42",
        "null",
        r#""\u0061bc""#, // "abc"
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn pattern_properties_parity() {
    let schemas = [
        json!({"type":"object","patternProperties":{"^x":{"type":"integer"}}}),
        json!({
            "type":"object",
            "properties":{"foo":{"type":"string"}},
            "patternProperties":{"^[a-z]+$":{"type":"number"}},
            "additionalProperties":false
        }),
        json!({
            "type":"object",
            "patternProperties":{"S_":{"type":"string"}},
            "additionalProperties":{"type":"number"}
        }),
    ];
    let docs = [
        r#"{"x1":1,"x2":2}"#,
        r#"{"x1":"str"}"#,
        r#"{"y1":1}"#,
        r#"{"foo":"a","bar":1}"#,
        r#"{"foo":"a","bar":"s"}"#,
        r#"{"FOO":1}"#,
        r#"{"S_a":"ok","other":1}"#,
        r#"{"S_a":1}"#,
        r#"{"other":"str"}"#,
        r#"{}"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn enum_const_parity() {
    let schemas = [
        json!({"enum":[1,2,3]}),
        json!({"enum":["a","b","c"]}),
        json!({"enum":[1,1.0,"1",true,null]}), // 1 and 1.0 are equal per JSON Schema
        json!({"const":5}),
        json!({"const":{"a":1,"b":2}}),
        json!({"type":"integer","enum":[1,2]}),
        json!({"enum":[{"x":[1,2]},{"x":[2,1]}]}),
    ];
    let docs = [
        "1",
        "2",
        "3",
        "4",
        "1.0",
        "1e0",
        r#""a""#,
        r#""b""#,
        r#""d""#,
        r#""""#,
        "true",
        "false",
        "null",
        r#"{"a":1,"b":2}"#,
        r#"{"b":2,"a":1}"#,
        r#"{"a":2,"b":2}"#,
        r#"{"x":[1,2]}"#,
        r#"{"x":[2,1]}"#,
        r#"[1,2]"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn multiple_of_parity() {
    let schemas = [
        json!({"type":"number","multipleOf":2}),
        json!({"type":"number","multipleOf":0.01}),
        json!({"type":"number","multipleOf":0.1}),
        json!({"type":"integer","multipleOf":3}),
        json!({"multipleOf":1.5}),
    ];
    let docs = [
        "0", "2", "4", "3", "-2", "2.5", "1", "0.5", "0.01", "0.02", "0.03", "0.1", "1.23", "100",
        "1.5", "3.0", "3.1", "4.5", "1e1", "1.25", "2.25", r#""x""#, "null", "{}",
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn multiple_of_non_finite_no_panic() {
    // `1e999` parses to f64::INFINITY in `Cursor::number`. `is_multiple_of`
    // must not panic (a panic through the raw C ABI crashes the host process)
    // and must agree with the DOM validator, whose serde parse of `1e999`
    // fails → invalid.
    let schemas = [
        json!({"type":"number","multipleOf":2}),
        json!({"type":"number","multipleOf":0.1}),
        json!({"type":"integer","multipleOf":3}),
    ];
    let docs = ["1e999", "-1e999", "1e308", "1.7976931348623157e308", "2"];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn combinators_parity() {
    let schemas = [
        json!({"allOf":[{"type":"number"},{"minimum":0}]}),
        json!({"anyOf":[{"type":"string"},{"type":"integer"}]}),
        json!({"oneOf":[{"type":"number"},{"minimum":0}]}),
        json!({"not":{"type":"string"}}),
        json!({"anyOf":[{"type":"null"},{"type":"array"}]}),
        json!({"oneOf":[{"enum":[1,2]},{"minimum":1}]}),
        json!({"allOf":[{"properties":{"a":{"type":"integer"}}},{"required":["a"]}]}),
    ];
    let docs = [
        "5", "-5", r#""5""#, "0", "0.5", "null", r#""s""#, "1", "1.5", "[]", "{}", "2", "3", "-1",
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn if_then_else_parity() {
    let schemas = [
        json!({"type":"number","if":{"minimum":0},"then":{"multipleOf":2}}),
        json!({
            "if":{"properties":{"type":{"const":"a"}}},
            "then":{"required":["a"]},
            "else":{"required":["b"]}
        }),
        json!({"if":{"type":"string"},"else":{"type":"integer"}}),
        json!({"if":false,"then":{"type":"string"}}),
    ];
    let docs = [
        "2",
        "3",
        "-2",
        "-3",
        "0",
        r#"{"type":"a","a":1}"#,
        r#"{"type":"a"}"#,
        r#"{"type":"b","b":1}"#,
        r#"{"type":"b"}"#,
        r#""hi""#,
        "1",
        "1.5",
        "true",
        "null",
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn unique_items_parity() {
    let schemas = [
        json!({"type":"array","uniqueItems":true}),
        json!({"type":"array","uniqueItems":true,"items":{"type":"integer"}}),
        json!({"type":"array","uniqueItems":true,"items":{"type":"object"}}),
    ];
    let docs = [
        r#"[1,2,3]"#,
        r#"[1,1]"#,
        r#"[1,1.0]"#,
        r#"[1,2,2.0]"#,
        r#"["a","b"]"#,
        r#"["a","a"]"#,
        r#"[{"a":1},{"a":1}]"#,
        r#"[{"a":1},{"b":1}]"#,
        r#"[{"a":1,"b":2},{"b":2,"a":1}]"#,
        r#"[true,false,true]"#,
        r#"[[1],[1]]"#,
        r#"[[1],[2]]"#,
        r#"[]"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn unique_items_bignum_parity() {
    // Exercises the exact cross-type number comparison (num_cmp) — serde_json's
    // Value PartialEq would wrongly treat these as equal via f64 casting.
    let schema = json!({"type":"array","uniqueItems":true});
    let docs = [
        r#"[9007199254740993,9007199254740992]"#, // distinct large ints
        r#"[9007199254740993,9007199254740993]"#, // duplicate
        r#"[9007199254740993,9007199254740992.0]"#, // exact: NOT equal
        r#"[1.0,1]"#,
        r#"[18446744073709551615,18446744073709551615]"#, // u64 max duplicate
    ];
    assert_parity(schema, &docs);
}

#[test]
fn tuple_items_parity() {
    let schemas = [
        json!({"type":"array","items":[{"type":"string"},{"type":"integer"}]}),
        json!({"type":"array","items":[{"type":"string"}],"additionalItems":false}),
        json!({
            "type":"array",
            "items":[{"type":"string"},{"type":"integer"}],
            "additionalItems":{"type":"boolean"}
        }),
        json!({"type":"array","items":[{"type":"string"}],"minItems":1}),
    ];
    let docs = [
        r#"["a",1]"#,
        r#"["a"]"#,
        r#"[1,"a"]"#,
        r#"["a","b"]"#,
        r#"["a","b","c"]"#,
        r#"["a",1,true]"#,
        r#"["a",1,2]"#,
        r#"[]"#,
        r#"["a","b",1]"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn contains_parity() {
    let schemas = [
        json!({"type":"array","contains":{"type":"integer"}}),
        json!({"type":"array","contains":{"const":5}}),
        json!({"type":"array","contains":{"type":"string"},"minItems":1}),
    ];
    let docs = [
        r#"[1]"#,
        r#"[1.5]"#,
        r#"["a",1]"#,
        r#"["a","b"]"#,
        r#"[5]"#,
        r#"[4,6]"#,
        r#"[]"#,
        r#"[{}]"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn dependencies_parity() {
    let schemas = [
        json!({"type":"object","dependencies":{"a":["b"]}}),
        json!({"type":"object","dependencies":{"a":["b","c"]}}),
        json!({"type":"object","dependencies":{"a":[],"b":["a"]}}),
    ];
    let docs = [
        r#"{"a":1,"b":2}"#,
        r#"{"a":1}"#,
        r#"{"b":2}"#,
        r#"{}"#,
        r#"{"a":1,"b":2,"c":3}"#,
        r#"{"a":1,"c":3}"#,
        r#"{"b":1,"a":2}"#,
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn ref_parity() {
    let schemas = [
        json!({
            "definitions": {"positive": {"type":"number","minimum":0}},
            "$ref":"#/definitions/positive"
        }),
        json!({
            "$defs": {
                "user": {
                    "type":"object",
                    "required":["id"],
                    "properties":{"id":{"type":"integer"}}
                }
            },
            "type":"object",
            "properties":{
                "owner":{"$ref":"#/$defs/user"},
                "admin":{"$ref":"#/$defs/user"}
            }
        }),
        json!({
            "definitions": {
                "a": {"type":"string"},
                "b": {"allOf":[{"$ref":"#/definitions/a"},{"minLength":2}]}
            },
            "$ref":"#/definitions/b"
        }),
        json!({
            "type":"object",
            "properties":{"x":{"type":"object","properties":{"y":{"type":"string"}}}},
            "$ref":"#/properties/x/properties/y"
        }),
    ];
    let docs = [
        "1",
        "-1",
        "0",
        "5.5",
        r#""s""#,
        r#"{"id":1}"#,
        r#"{"id":"x"}"#,
        r#"{"owner":{"id":1},"admin":{"id":2}}"#,
        r#"{"owner":{"id":1},"admin":{}}"#,
        r#""abc""#,
        r#""a""#,
        r#""""#,
        r#""x""#,
        "123",
    ];
    for s in &schemas {
        assert_parity(s.clone(), &docs);
    }
}

#[test]
fn dollar_schema_guard() {
    // Non-draft-07 `$schema` declarations fall back (semantics diverge).
    for ss in [
        "http://json-schema.org/draft-04/schema#",
        "http://json-schema.org/draft-06/schema#",
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2019-09/schema",
    ] {
        let schema = json!({"$schema": ss, "type": "object"});
        assert!(compile(&schema).is_err(), "$schema={ss} must fall back");
    }
    // draft-07 (with or without the URL form) compiles.
    for ss in [
        "http://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft-07/schema",
    ] {
        let schema = json!({"$schema": ss, "type": "object"});
        assert!(compile(&schema).is_ok(), "$schema={ss} must compile");
    }
}

#[test]
fn draft07_unknown_keywords_ignored() {
    // 2020-12-only keywords are UNKNOWN to draft-07, so the reference ignores
    // them; the fast path must too (compile + behave identically).
    for schema in [
        json!({"type":"object","prefixItems":[{"type":"string"}]}),
        json!({"type":"array","unevaluatedItems":false}),
        json!({"type":"object","unevaluatedProperties":false}),
        json!({"type":"object","dependentRequired":{"a":["b"]}}),
        json!({"type":"array","minContains":1}),
    ] {
        assert!(
            compile(&schema).is_ok(),
            "should compile (ignored keyword): {schema}"
        );
        assert_parity(schema, &[r#"{}"#, r#"[]"#, r#"[1,2]"#, r#"{"a":1}"#]);
    }
}

// ── detailed error reporting (fast path) ────────────────────────────────

#[test]
fn error_reporting_paths_and_keywords() {
    let schema = json!({
        "type":"object",
        "required":["id","name"],
        "properties":{
            "id":{"type":"integer"},
            "name":{"type":"string","minLength":2,"pattern":"^[a-z]+$"},
            "tags":{"type":"array","items":{"type":"string"},"uniqueItems":true}
        },
        "additionalProperties":false
    });
    let fast = compile(&schema).unwrap();

    // valid -> no errors
    assert!(fast
        .validate_errors(br#"{"id":1,"name":"ab","tags":["x","y"]}"#, usize::MAX)
        .is_empty());

    // missing required -> keyword required, root pointer
    let errs = fast.validate_errors(br#"{"id":1}"#, usize::MAX);
    let req = errs.iter().find(|e| e.keyword == "required").unwrap();
    assert_eq!(req.instance_path, "");
    assert!(req.message.contains("name"));

    // wrong type at /id
    let errs = fast.validate_errors(br#"{"id":"x","name":"ab"}"#, usize::MAX);
    let t = errs.iter().find(|e| e.keyword == "type").unwrap();
    assert_eq!(t.instance_path, "/id");

    // pattern at /name
    let errs = fast.validate_errors(br#"{"id":1,"name":"AB"}"#, usize::MAX);
    let p = errs.iter().find(|e| e.keyword == "pattern").unwrap();
    assert_eq!(p.instance_path, "/name");
    assert!(p.schema_path.ends_with("/properties/name/pattern"));

    // additionalProperties at the offending key
    let errs = fast.validate_errors(br#"{"id":1,"name":"ab","extra":true}"#, usize::MAX);
    let ap = errs
        .iter()
        .find(|e| e.keyword == "additionalProperties")
        .unwrap();
    assert_eq!(ap.instance_path, "/extra");

    // uniqueItems at /tags
    let errs = fast.validate_errors(br#"{"id":1,"name":"ab","tags":["x","x"]}"#, usize::MAX);
    let u = errs.iter().find(|e| e.keyword == "uniqueItems").unwrap();
    assert_eq!(u.instance_path, "/tags");

    // multi-error collection: every failing property is reported
    let errs = fast.validate_errors(br#"{"id":"x","name":"AB","extra":1}"#, usize::MAX);
    let kw: Vec<&str> = errs.iter().map(|e| e.keyword.as_str()).collect();
    assert!(
        kw.contains(&"type") && kw.contains(&"pattern") && kw.contains(&"additionalProperties"),
        "expected type+pattern+additionalProperties errors, got {kw:?}"
    );

    // max_errors=1 returns exactly the first error
    let first = fast.validate_errors(br#"{"id":"x","name":""}"#, 1);
    assert_eq!(first.len(), 1);

    // RFC 6901 escaping: a key with a slash / tilde in the pointer
    let schema2 = json!({
        "type":"object",
        "properties":{"a/b":{"type":"integer"},"c~d":{"type":"integer"}}
    });
    let fast2 = compile(&schema2).unwrap();
    let errs = fast2.validate_errors(br#"{"a/b":"x"}"#, usize::MAX);
    assert!(errs.iter().any(|e| e.instance_path == "/a~1b"));
    let errs = fast2.validate_errors(br#"{"c~d":"x"}"#, usize::MAX);
    assert!(errs.iter().any(|e| e.instance_path == "/c~0d"));
}

#[test]
fn error_reporting_matches_validation_bool() {
    // validate_errors(empty) must agree exactly with is_valid_bytes.
    let schemas = [
        json!({
            "type":"object",
            "required":["a"],
            "properties":{"a":{"type":"number","multipleOf":2}},
            "additionalProperties":false
        }),
        json!({"anyOf":[{"type":"string"},{"type":"integer"}]}),
        json!({"type":"array","items":{"type":"string"},"minItems":1}),
    ];
    let docs = [
        r#"{"a":4}"#,
        r#"{"a":3}"#,
        r#"{"a":"x"}"#,
        r#"{"b":1}"#,
        r#""s""#,
        "1",
        r#"["a"]"#,
        "[]",
        r#"["a",1]"#,
        "not json",
    ];
    for s in &schemas {
        let fast = compile(s).unwrap();
        for doc in &docs {
            let ok = fast.is_valid_bytes(doc.as_bytes());
            let errs = fast.validate_errors(doc.as_bytes(), usize::MAX);
            assert_eq!(ok, errs.is_empty(), "schema={s} doc={doc}");
        }
    }
}

#[test]
fn invalid_utf8_and_malformed_bytes_return_false() {
    // The fast path is byte-oriented; it must reject structurally invalid or
    // non-UTF-8-leading documents without panicking (matching the DOM path's
    // parse failure → false).
    let fast = compile(&bench_schema()).unwrap();

    // Non-UTF-8 leading bytes cannot start any JSON value.
    assert!(!fast.is_valid_bytes(&[0xFF, 0xFE]));
    assert!(!fast.is_valid_bytes(&[0x80]));
    assert!(!fast.is_valid_bytes(&[0xC0, 0xAF]));

    // Truncated structural input.
    assert!(!fast.is_valid_bytes(b"{\"id\":1"));
    assert!(!fast.is_valid_bytes(b"{\"id\":"));
    assert!(!fast.is_valid_bytes(b"[1,2"));

    // Trailing garbage after a valid document (must consume ALL bytes).
    assert!(!fast.is_valid_bytes(b"{\"id\":1}\x00"));
    assert!(!fast.is_valid_bytes(
        b"{\"id\":1,\"name\":\"a\",\"active\":true,\"score\":1,\"tags\":[],\"nested\":{\"version\":1,\"createdAt\":\"c\"}} garbage"
    ));
}

#[test]
fn rfc8259_strictness_matches_sonic_gate() {
    // The fast path now serves as the RFC-8259 well-formedness gate for
    // fast-path schemas in the ingress pipeline (pipeline.rs stage 6): a pass
    // means BOTH well-formed JSON AND schema-conforming, so the separate sonic
    // `json_valid_bytes` pass is skipped on the happy path. The safety
    // property this pins: the fast path must NEVER accept a body the strict
    // sonic gate rejects (`!sonic ⇒ !fast`). The one gap the walk closes is
    // raw control bytes (< 0x20) in strings; sonic is lenient on exactly what
    // the walk is lenient on (bad `\uXXXX` hex, lone surrogates, invalid
    // UTF-8, numeric overflow) — so this corpus must not diverge.
    let fast = compile(&bench_schema()).unwrap();

    let corpus: &[&[u8]] = &[
        // Raw control bytes in string VALUES (sonic rejects → fast must too).
        b"{\"id\":1,\"name\":\"a\x01b\"}",
        b"{\"id\":1,\"name\":\"a\x00\"}",
        b"{\"id\":1,\"name\":\"\x1f\"}",
        b"{\"id\":1,\"name\":\"a\tb\"}", // raw tab inside a string
        // Raw control bytes in KEYS (both route through raw_string).
        b"{\"id\x09\":1}",
        b"{\"\x00\":1}",
        // Other malformed-JSON classes sonic rejects.
        b"{\"id\":1,}",
        b"[1,]",
        b"{\"id\":1",
        b"{\"id\":}",
        b"-01",
        b"1.",
        b"01",
        b"",
        b"{\"id\":1} {\"id\":2}",
        b"{\"id\":1}\x00",
        // Sonic-lenient inputs the walk must ALSO accept (parity, not strict).
        b"{\"id\":1,\"name\":\"\\uZZZZ\"}", // bad \u hex
        b"{\"id\":1,\"name\":\"\\uD800\"}", // lone surrogate
        b"{\"id\":1,\"name\":\"a\xFFb\"}",  // invalid UTF-8 in a string
        b"1e999",                           // numeric overflow
        // Valid AND schema-conforming positive control (bench_schema requires
        // id/name/active/score/tags/nested — the other two- and three-field
        // docs above are well-formed but non-conforming, which the pipeline
        // splits as 422 via the sonic re-check).
        b"{\"id\":1,\"name\":\"user_1\",\"active\":true,\"score\":1.25,\"tags\":[\"alpha\",\"beta\"],\"nested\":{\"version\":1,\"createdAt\":\"2026-01-01T00:00:00Z\"}}",
        b"\t\r\n {}", // whitespace control OUTSIDE strings is valid
    ];

    for &doc in corpus {
        let sonic = crate::json::json_ops::json_valid_bytes(doc);
        let got = fast.is_valid_bytes(doc);
        if !sonic {
            assert!(
                !got,
                "fast path accepted a body the sonic gate rejects: {:?}",
                String::from_utf8_lossy(doc)
            );
        }
    }
    // Positive control: well-formed + conforming must pass the fast path.
    assert!(fast.is_valid_bytes(
        b"{\"id\":1,\"name\":\"user_1\",\"active\":true,\"score\":1.25,\"tags\":[\"alpha\",\"beta\"],\"nested\":{\"version\":1,\"createdAt\":\"2026-01-01T00:00:00Z\"}}"
    ));
    // Well-formed but non-conforming (missing required field) may reject —
    // the pipeline splits that as 422 via the sonic re-check.
    assert!(!fast.is_valid_bytes(b"{\"id\":1}"));
}

// ── format: "email" (zero-DOM fast path) ─────────────────────────

#[test]
fn email_format_matches_reference_corpus() {
    let schema = json!({
        "type": "object",
        "required": ["email"],
        "properties": {
            "email": { "type": "string", "format": "email" }
        },
        "additionalProperties": false
    });
    let docs = [
        // ── valid ──
        r#"{"email":"a@b.com"}"#,
        r#"{"email":"john.doe+tag@example.co.uk"}"#,
        r#"{"email":"user@sub.example.com"}"#,
        r#"{"email":"user@[IPv6:2001:db8::1]"}"#,
        r#"{"email":"user@[192.168.0.1]"}"#,
        r#"{"email":"user@[IPv6:2001:0db8:85a3:0000:0000:8a2e:0370:7334]"}"#,
        r#"{"email":"user@xn--bcher-kva.com"}"#, // valid punycode domain
        r#"{"email":"a.b.c.d.e.f@example.com"}"#,
        r#"{"email":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com"}"#, // 64-char local
        r#"{"email":"user@xn--11b2ezcw70k"}"#, // ZWJ after virama (valid punycode)
        r#"{"email":"user@xn--ll-0ea"}"#,      // punycode with valid middle dot context
        // ── invalid: domain shape ──
        r#"{"email":"not-an-email"}"#,
        r#"{"email":"a@"}"#,
        r#"{"email":"@b.com"}"#,
        r#"{"email":"a b@c.com"}"#,
        r#"{"email":"a@b c.com"}"#,
        r#"{"email":"a@-b.com"}"#,
        r#"{"email":"a@b-.com"}"#,
        r#"{"email":"a@b..com"}"#,
        r#"{"email":"a@b.com."}"#,
        r#"{"email":"a@ex--ample.com"}"#, // hyphens 3rd+4th, not punycode
        r#"{"email":"a@xn--example.com"}"#, // invalid punycode
        r#"{"email":"a@xn--x"}"#,         // too-short punycode
        r#"{"email":"a@[IPv6:zzzz::1]"}"#,
        r#"{"email":"a@[999.999.999.999]"}"#,
        r#"{"email":"a@[not-a-literal]"}"#,
        r#"{"email":"a@xn--hello-zed"}"#, // punycode beginning with nonspacing mark
        r#"{"email":"a@XN--aa---o47jg78q"}"#, // uppercase punycode prefix rejected
        r#"{"email":"a@example-.com"}"#,
        // ── invalid: local part / escapes ──
        r#"{"email":"a\u0040b.com"}"#, // JSON escape decodes to a@b.com (valid) — decode path
        r#"{"email":"a\\@b.com"}"#,    // backslash in local part
        r#"{"email":"héllo@example.com"}"#, // non-ASCII local part rejected (format:email)
        // wrong root type
        r#"42"#,
    ];
    assert_parity(schema, &docs);
}

#[test]
fn email_only_schema_compiles_and_validates() {
    // A schema with ONLY format:email (no minLength/maxLength) must still
    // engage the fast path's string node.
    let schema = json!({ "type": "string", "format": "email" });
    let fast = compile(&schema).expect("format:email must compile on the fast path");
    let v = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    for doc in [r#""a@b.com""#, r#""not-an-email""#, r#"42"#] {
        let expected = serde_json::from_str::<Value>(doc)
            .map(|x| v.is_valid(&x))
            .unwrap_or(false);
        assert_eq!(fast.is_valid_bytes(doc.as_bytes()), expected, "doc={doc}");
    }
}

#[test]
fn other_formats_and_unknown_formats_fall_back() {
    for f in [
        "idn-email",
        "date-time",
        "uri",
        "uuid",
        "ipv4",
        "regex",
        "unknown",
    ] {
        let schema = json!({ "type": "string", "format": f });
        assert!(
            compile(&schema).is_err(),
            "format {f:?} must fall back to the DOM path"
        );
    }
}

#[test]
fn email_format_property_parity_with_reference() {
    // Deterministic pseudo-random emails: cross-check the fast path against the
    // authoritative jsonschema DOM validator. ANY divergence fails — this is
    // the byte-parity gate that justifies engaging the fast path for the
    // ingress schema (which uses format:email).
    let schema = json!({ "type": "string", "format": "email" });
    let fast = compile(&schema).unwrap();
    let v = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();

    // Simple LCG (no rand dep needed in tests).
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 32) as u32
    };

    let alphabet_local: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789._%+-";
    let alphabet_domain: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789-.";
    let alphabet_bad: &[u8] = b" @!?*\\/()";

    let mut checked = 0u32;
    for _ in 0..3000 {
        // Local part: 0..=24 chars, mostly valid + occasional bad char.
        let mut local = String::new();
        let llen = (next() % 26) as usize;
        for _ in 0..llen {
            let pick = next() % 100;
            let b = if pick < 88 {
                alphabet_local[(next() % alphabet_local.len() as u32) as usize]
            } else {
                alphabet_bad[(next() % alphabet_bad.len() as u32) as usize]
            };
            local.push(b as char);
        }
        // Domain: 0..=40 chars, occasionally a space or trailing dot.
        let mut domain = String::new();
        let dlen = (next() % 42) as usize;
        for _ in 0..dlen {
            let pick = next() % 100;
            let b = if pick < 92 {
                alphabet_domain[(next() % alphabet_domain.len() as u32) as usize]
            } else {
                b' '
            };
            domain.push(b as char);
        }
        let mut email = local;
        email.push('@');
        email.push_str(&domain);

        let doc = serde_json::to_string(&email).unwrap();
        let expected = serde_json::from_str::<Value>(&doc)
            .map(|x| v.is_valid(&x))
            .unwrap_or(false);
        let got = fast.is_valid_bytes(doc.as_bytes());
        assert_eq!(got, expected, "email={email:?}");
        checked += 1;
    }
    assert!(checked >= 3000);
}

// ── hostile nesting depth (stack-overflow guard) ─────────────────

#[test]
// The repeated `push` of the same structural literal is deliberate — it
// builds a deeply-nested document to exercise the stack-overflow guard.
#[allow(clippy::same_item_push)]
fn deeply_nested_documents_are_bounded_not_crashing() {
    // A ~10K-deep document must be REJECTED, not recursed into a stack overflow
    // (a stack overflow aborts the whole process — panic=unwind + napi
    // catch_unwind do NOT catch it). The any-schema walks every nested value
    // via Cursor::skip_value, which is exactly the recursion path a hostile
    // body would drive.
    let any = FastNode::any();

    let mut deep_arr = Vec::with_capacity(20_000);
    for _ in 0..10_000 {
        deep_arr.push(b'[');
    }
    deep_arr.push(b'0');
    for _ in 0..10_000 {
        deep_arr.push(b']');
    }
    assert!(!any.is_valid_bytes(&deep_arr));

    let mut deep_obj = Vec::with_capacity(60_000);
    for _ in 0..10_000 {
        deep_obj.extend_from_slice(b"{\"a\":");
    }
    deep_obj.push(b'0');
    for _ in 0..10_000 {
        deep_obj.push(b'}');
    }
    assert!(!any.is_valid_bytes(&deep_obj));

    // Sanity: an ordinary payload is still valid — the cap must not reject
    // normal documents.
    assert!(any.is_valid_bytes(b"{\"a\":[1,{\"b\":2}]}"));
}

#[test]
fn deep_nesting_parity_with_reference() {
    // The fast path caps at MAX_DEPTH (128), matching sonic-rs (the ingress
    // gate) and serde_json (the DOM reference): deeper documents parse-fail in
    // the reference too, so validity must agree.
    let schema = json!({ "type": "object", "additionalProperties": true });
    let fast = compile(&schema).unwrap();
    let v = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .build(&schema)
        .unwrap();

    // 100-deep (below the cap) and 200-deep (above it) — both must agree with
    // the reference.
    for depth in [100usize, 200] {
        let mut doc = String::new();
        for _ in 0..depth {
            doc.push_str("{\"a\":");
        }
        doc.push('0');
        for _ in 0..depth {
            doc.push('}');
        }
        let expected = serde_json::from_str::<Value>(&doc)
            .map(|x| v.is_valid(&x))
            .unwrap_or(false);
        let got = fast.is_valid_bytes(doc.as_bytes());
        assert_eq!(got, expected, "depth={depth}");
    }
}
