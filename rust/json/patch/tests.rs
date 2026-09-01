// rust/json/patch/tests.rs — unit tests for the RFC 6902 JSON Patch engine.
//
// Covers the op semantics in `ops.rs`, the size guards + batch orchestration
// in `engine.rs`, and the napi surface in `api.rs`.

use super::engine::apply_json_patch_bytes_limited;
use super::{
    apply_json_patch_bytes, json_patch, json_patch_batch_packed, run_json_patch_batch,
    JsonPatchError,
};
use crate::util::unpack;
use napi::bindgen_prelude::*;
use serde_json::Value;

fn apply(doc: &[u8], patch: &[u8]) -> std::result::Result<Vec<u8>, JsonPatchError> {
    apply_json_patch_bytes(doc, patch)
}

fn as_value(bytes: &[u8]) -> Value {
    sonic_rs::from_slice(bytes).expect("test bytes must be valid JSON")
}

// ── Scalar: RFC 6902 operations ─────────────────────────────

#[test]
fn replace_field() {
    let out = apply(
        br#"{"name":"alice","age":30}"#,
        br#"[{"op":"replace","path":"/age","value":31}]"#,
    )
    .unwrap();
    let result = as_value(&out);
    assert_eq!(result["age"], 31);
    assert_eq!(result["name"], "alice");
}

#[test]
fn add_and_remove() {
    let out = apply(
        br#"{"items":["a","b"]}"#,
        br#"[{"op":"add","path":"/items/-","value":"c"},{"op":"remove","path":"/items/0"}]"#,
    )
    .unwrap();
    let result = as_value(&out);
    let expected: Value = sonic_rs::from_slice(br#"["b","c"]"#).unwrap();
    assert_eq!(result["items"], expected);
}

#[test]
fn remove_field_and_array_index() {
    let out = apply(
        br#"{"a":1,"b":2,"arr":[10,20,30]}"#,
        br#"[{"op":"remove","path":"/b"},{"op":"remove","path":"/arr/1"}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"a":1,"arr":[10,30]}"#));
}

#[test]
fn add_to_root_replaces_document() {
    // RFC 6902: the empty-string path targets the document root; `/` would
    // add a member named `""` to the root object instead.
    let out = apply(
        br#"{"a":1}"#,
        br#"[{"op":"add","path":"","value":{"b":2}}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"b":2}"#));
}

#[test]
fn add_to_array_index() {
    let out = apply(
        br#"{"items":["a","c"]}"#,
        br#"[{"op":"add","path":"/items/1","value":"b"}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"items":["a","b","c"]}"#));
}

#[test]
fn move_op_between_containers() {
    let out = apply(
        br#"{"from":{"v":1},"to":{}}"#,
        br#"[{"op":"move","from":"/from/v","path":"/to/v"}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"from":{},"to":{"v":1}}"#));
}

#[test]
fn copy_op_duplicates_subtree() {
    let out = apply(
        br#"{"a":{"x":1,"y":[2,3]},"b":null}"#,
        br#"[{"op":"copy","from":"/a","path":"/b"}]"#,
    )
    .unwrap();
    let result = as_value(&out);
    assert_eq!(result["b"], result["a"]);
    assert_eq!(result["a"], as_value(br#"{"x":1,"y":[2,3]}"#));
}

#[test]
fn test_op_success_is_identity() {
    let doc = br#"{"v":42,"s":"x"}"#;
    let out = apply(doc, br#"[{"op":"test","path":"/v","value":42}]"#).unwrap();
    assert_eq!(as_value(&out), as_value(doc));
}

#[test]
fn test_op_mismatch_fails() {
    let err = apply(br#"{"v":42}"#, br#"[{"op":"test","path":"/v","value":43}]"#).unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn path_token_escapes_tilde_and_slash() {
    // RFC 6901: `~1` decodes to `/`, `~0` decodes to `~`.
    let out = apply(
        br#"{"a/b":0,"m~n":0}"#,
        br#"[{"op":"replace","path":"/a~1b","value":1},{"op":"replace","path":"/m~0n","value":2}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"a/b":1,"m~n":2}"#));
}

#[test]
fn test_op_on_array_and_nested() {
    let doc = br#"{"arr":[1,2,3],"obj":{"x":10}}"#;
    // Array element + nested object tests succeed.
    apply(doc, br#"[{"op":"test","path":"/arr/1","value":2}]"#).unwrap();
    apply(doc, br#"[{"op":"test","path":"/obj/x","value":10}]"#).unwrap();
    // Mismatch on a nested/array value fails.
    let err = apply(doc, br#"[{"op":"test","path":"/arr/2","value":99}]"#).unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn move_from_missing_path_fails() {
    let err = apply(
        br#"{"a":1}"#,
        br#"[{"op":"move","from":"/nope","path":"/b"}]"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn copy_from_missing_path_fails() {
    let err = apply(
        br#"{"a":1}"#,
        br#"[{"op":"copy","from":"/nope","path":"/b"}]"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn move_array_element_reorders() {
    // RFC 6902: remove `/items/0` then add at `/items/2` (post-removal index).
    let out = apply(
        br#"{"items":["a","b","c"]}"#,
        br#"[{"op":"move","from":"/items/0","path":"/items/2"}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"items":["b","c","a"]}"#));
}

#[test]
fn move_array_element_into_object() {
    let out = apply(
        br#"{"arr":[1,2],"obj":{}}"#,
        br#"[{"op":"move","from":"/arr/0","path":"/obj/first"}]"#,
    )
    .unwrap();
    assert_eq!(
        as_value(&out),
        as_value(br#"{"arr":[2],"obj":{"first":1}}"#)
    );
}

#[test]
fn move_into_own_descendant_fails() {
    // RFC 6902: a node cannot be moved into one of its own children.
    let err = apply(
        br#"{"a":{"b":1},"c":{}}"#,
        br#"[{"op":"move","from":"/a","path":"/a/b"}]"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn add_dash_on_non_array_fails() {
    // RFC 6902: `-` in a path is only valid for arrays.
    let err = apply(br#"{"a":1}"#, br#"[{"op":"add","path":"/a/-","value":2}]"#).unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn remove_out_of_range_array_index_fails() {
    let err = apply(br#"{"arr":[1,2]}"#, br#"[{"op":"remove","path":"/arr/5"}]"#).unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn invalid_escape_tilde_2_rejected() {
    // RFC 6901: only `~0` and `~1` are valid escapes; `~2` is rejected at
    // patch deserialization (json-patch validates the pointer eagerly).
    let err = apply(
        br#"{"a/b":1}"#,
        br#"[{"op":"replace","path":"/a~2b","value":2}]"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("invalid patch"), "{err}");
}

#[test]
fn tilde_at_end_of_token_rejected() {
    // A trailing `~` is an incomplete escape (RFC 6901) and is rejected at
    // patch deserialization.
    let err = apply(
        br#"{"a":1}"#,
        br#"[{"op":"replace","path":"/a~","value":2}]"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("invalid patch"), "{err}");
}

#[test]
fn sequential_ops_on_same_path_apply_in_order() {
    let out = apply(
        br#"{"v":0}"#,
        br#"[{"op":"replace","path":"/v","value":1},{"op":"replace","path":"/v","value":2}]"#,
    )
    .unwrap();
    assert_eq!(as_value(&out), as_value(br#"{"v":2}"#));
}

#[test]
fn unicode_content_roundtrip() {
    // Byte-string literals must stay ASCII; build the UTF-8 bytes from a
    // regular string literal instead.
    let doc = "{\"名前\":\"アリス\",\"emoji\":\"👍\",\"nested\":{\"café\":\"☕\"}}";
    let patch = "[{\"op\":\"replace\",\"path\":\"/emoji\",\"value\":\"🚀\"}]";
    let out = apply(doc.as_bytes(), patch.as_bytes()).unwrap();
    let result = as_value(&out);
    assert_eq!(result["名前"], "アリス");
    assert_eq!(result["emoji"], "🚀");
    assert_eq!(result["nested"]["café"], "☕");
}

#[test]
fn empty_patch_is_byte_identity() {
    let doc = br#"{"a":[1,2,3],"b":{"c":true}}"#;
    let out = apply(doc, b"[]").unwrap();
    assert_eq!(out.as_slice(), doc);
}

#[test]
fn empty_doc_and_scalar_roots_roundtrip() {
    assert_eq!(apply(b"{}", b"[]").unwrap().as_slice(), b"{}");
    assert_eq!(apply(b"42", b"[]").unwrap().as_slice(), b"42");
    assert_eq!(apply(b"null", b"[]").unwrap().as_slice(), b"null");
}

#[test]
fn deeply_nested_paths() {
    let out = apply(
        br#"{"l1":{"l2":{"l3":{"l4":{"l5":[0,1,2]}}}}}"#,
        br#"[{"op":"replace","path":"/l1/l2/l3/l4/l5/2","value":99}]"#,
    )
    .unwrap();
    let result = as_value(&out);
    assert_eq!(result["l1"]["l2"]["l3"]["l4"]["l5"][2], 99);
}

#[test]
fn real_world_profile_patch() {
    let doc = br#"{
        "id": "usr_01H2X9K7",
        "profile": {
            "displayName": "Alice",
            "email": "alice@example.com",
            "preferences": { "theme": "dark", "notifications": true, "digest": "weekly" }
        },
        "roles": ["admin", "editor"],
        "meta": { "createdAt": "2026-01-15T10:00:00Z", "updatedAt": "2026-08-01T08:30:00Z" }
    }"#;
    let patch = br#"[
        {"op":"replace","path":"/profile/preferences/theme","value":"light"},
        {"op":"add","path":"/roles/-","value":"reviewer"},
        {"op":"replace","path":"/meta/updatedAt","value":"2026-08-10T12:00:00Z"},
        {"op":"add","path":"/profile/preferences/locale","value":"en-US"}
    ]"#;
    let result = as_value(&apply(doc, patch).unwrap());
    assert_eq!(result["profile"]["preferences"]["theme"], "light");
    assert_eq!(result["profile"]["preferences"]["locale"], "en-US");
    assert_eq!(
        result["roles"],
        as_value(br#"["admin","editor","reviewer"]"#)
    );
    assert_eq!(result["meta"]["updatedAt"], "2026-08-10T12:00:00Z");
    assert_eq!(result["profile"]["displayName"], "Alice");
}

#[test]
fn numeric_precision_preserved() {
    let doc = br#"{"big":9007199254740993,"frac":3.141592653589793,"neg":-42}"#;
    let out = apply(doc, br#"[{"op":"add","path":"/extra","value":-0.5}]"#).unwrap();
    let result = as_value(&out);
    assert_eq!(result["big"], 9_007_199_254_740_993i64);
    assert_eq!(result["frac"], std::f64::consts::PI);
    assert_eq!(result["neg"], -42);
    assert_eq!(result["extra"], -0.5);
}

// ── Error handling ──────────────────────────────────────────

#[test]
fn error_context_is_specific() {
    let err = apply(b"not-json", b"[]").unwrap_err();
    assert!(err.to_string().contains("invalid document"), "{err}");
    let err = apply(br#"{}"#, b"not-json").unwrap_err();
    assert!(err.to_string().contains("invalid patch"), "{err}");
    let err = apply(br#"{}"#, br#"[{"op":"remove","path":"/nope"}]"#).unwrap_err();
    assert!(err.to_string().contains("apply failed"), "{err}");
}

#[test]
fn non_array_patch_is_invalid() {
    let err = apply(br#"{}"#, br#"{"op":"replace","path":"/a","value":1}"#).unwrap_err();
    assert!(err.to_string().contains("invalid patch"), "{err}");
}

#[test]
fn invalid_patch_operations_error() {
    assert!(apply(br#"{"a":1}"#, br#"[{"op":"nonsense","path":"/a"}]"#).is_err());
    assert!(apply(
        br#"{"a":1}"#,
        br#"[{"op":"replace","path":"/nope","value":2}]"#
    )
    .is_err());
}

// ── Size guards ─────────────────────────────────────────────

#[test]
fn input_size_guard_rejects_oversized() {
    let big = vec![b' '; 1024];
    let err = apply_json_patch_bytes_limited(&big, b"[]", 512, 4096).unwrap_err();
    assert!(matches!(err, JsonPatchError::TooLarge("document", n) if n == 1024));
    let err = apply_json_patch_bytes_limited(br#"{}"#, &big, 512, 4096).unwrap_err();
    assert!(matches!(err, JsonPatchError::TooLarge("patch", n) if n == 1024));
}

#[test]
fn output_size_guard_rejects_copy_amplification() {
    // A `copy` that duplicates a subtree doubles the output; with a tight
    // cap the bounded writer must refuse to materialize it.
    let doc = br#"{"a":{"x":[1,2,3,4,5],"y":"padding-for-size"}}"#;
    let patch = br#"[{"op":"copy","from":"/a","path":"/b"}]"#;
    let err = apply_json_patch_bytes_limited(doc, patch, 1024 * 1024, doc.len()).unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "{err}");
}

#[test]
fn output_size_guard_allows_at_limit_and_rejects_above() {
    // `{"a":1}` serializes to exactly 7 bytes.
    let ok = apply_json_patch_bytes_limited(br#"{"a":1}"#, b"[]", 1024, 7).unwrap();
    assert_eq!(ok.as_slice(), b"{\"a\":1}");
    let err = apply_json_patch_bytes_limited(br#"{"a":1}"#, b"[]", 1024, 6).unwrap_err();
    assert!(err.to_string().contains("exceeds maximum"), "{err}");
}

// ── Batch ───────────────────────────────────────────────────

#[test]
fn batch_matches_scalar_parity() {
    let docs: Vec<&[u8]> = vec![
        br#"{"a":1}"#,
        br#"{"items":["x","y"]}"#,
        br#"{"name":"alice"}"#,
    ];
    let patches: Vec<&[u8]> = vec![
        br#"[{"op":"replace","path":"/a","value":2}]"#,
        br#"[{"op":"add","path":"/items/-","value":"z"}]"#,
        br#"[]"#,
    ];
    let results = run_json_patch_batch(&docs, &patches).unwrap();
    assert_eq!(results.len(), 3);
    for ((doc, patch), result) in docs.iter().zip(patches.iter()).zip(results.iter()) {
        assert_eq!(result, &apply(doc, patch).unwrap(), "batch item mismatch");
    }
}

#[test]
fn batch_fails_fast_with_index() {
    let docs: Vec<&[u8]> = vec![br#"{"a":1}"#, b"not-json", br#"{"c":3}"#];
    let patches: Vec<&[u8]> = vec![br#"[]"#, br#"[]"#, br#"[]"#];
    let err = run_json_patch_batch(&docs, &patches).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("item 1"), "{msg}");
}

#[test]
fn batch_empty_inputs() {
    let results = run_json_patch_batch(&[], &[]).unwrap();
    assert!(results.is_empty());
}

/// Number of items that reliably crosses `should_parallelize`'s item
/// threshold regardless of the ambient rayon pool size, forcing the
/// rayon-parallel branch of `run_json_patch_batch`.
fn parallel_batch_len() -> usize {
    rayon::current_num_threads().max(1).saturating_mul(2048) + 128
}

#[test]
fn batch_parallel_path_order_preserving() {
    // All-success batch above the parallel threshold: results must be
    // order-preserving and byte-identical to the scalar application.
    let n = parallel_batch_len();
    let mut docs = Vec::with_capacity(n);
    let mut patches = Vec::with_capacity(n);
    for i in 0..n {
        docs.push(format!("{{\"i\":{i}}}").into_bytes());
        patches.push(format!("[{{\"op\":\"add\",\"path\":\"/k\",\"value\":{i}}}]").into_bytes());
    }
    let doc_refs: Vec<&[u8]> = docs.iter().map(|d| d.as_slice()).collect();
    let patch_refs: Vec<&[u8]> = patches.iter().map(|p| p.as_slice()).collect();

    let results = run_json_patch_batch(&doc_refs, &patch_refs).unwrap();
    assert_eq!(results.len(), n);
    for (i, result) in results.iter().enumerate() {
        let v: Value = sonic_rs::from_slice(result).unwrap();
        assert_eq!(v["i"], i as i64, "item {i} content");
        assert_eq!(v["k"], i as i64, "item {i} patched value");
    }
}

#[test]
fn batch_parallel_path_fail_index_deterministic() {
    // Exactly ONE item is corrupt, at a known index in the middle of a
    // parallel-sized batch. Because only that item fails, the index-bearing
    // error must deterministically report it (rayon short-circuits, but the
    // sole Err can only carry that item's index).
    let n = parallel_batch_len();
    let mut docs = Vec::with_capacity(n);
    let mut patches = Vec::with_capacity(n);
    for i in 0..n {
        docs.push(format!("{{\"i\":{i}}}").into_bytes());
        patches.push(format!("[{{\"op\":\"add\",\"path\":\"/k\",\"value\":{i}}}]").into_bytes());
    }
    let bad_index = n / 2;
    docs[bad_index] = b"not-json".to_vec();

    let doc_refs: Vec<&[u8]> = docs.iter().map(|d| d.as_slice()).collect();
    let patch_refs: Vec<&[u8]> = patches.iter().map(|p| p.as_slice()).collect();

    let err = run_json_patch_batch(&doc_refs, &patch_refs).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains(&format!("item {bad_index}")), "{msg}");
    assert!(msg.contains("invalid document"), "{msg}");
}

// ── napi surface ────────────────────────────────────────────

#[test]
fn napi_surface_roundtrip() {
    let out = json_patch(
        Uint8Array::new(br#"{"name":"alice","age":30}"#.to_vec()),
        Uint8Array::new(br#"[{"op":"replace","path":"/age","value":31}]"#.to_vec()),
    )
    .unwrap();
    let result: Value = sonic_rs::from_slice(out.as_ref()).unwrap();
    assert_eq!(result["age"], 31);
}

#[test]
fn napi_batch_surface_packs_results() {
    fn packed(items: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(items.len() as u32).to_le_bytes());
        for item in items {
            out.extend_from_slice(&(item.len() as u32).to_le_bytes());
            out.extend_from_slice(item);
        }
        out
    }

    let docs = packed(&[br#"{"a":1}"#, br#"{"b":2}"#]);
    let patches = packed(&[br#"[{"op":"replace","path":"/a","value":10}]"#, br#"[]"#]);
    let out = json_patch_batch_packed(Uint8Array::new(docs), Uint8Array::new(patches)).unwrap();
    let items = unpack(out.as_ref()).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0], &b"{\"a\":10}"[..]);
    assert_eq!(items[1], &b"{\"b\":2}"[..]);
}
