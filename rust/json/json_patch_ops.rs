//! RFC 6902 JSON Patch — bounded scalar apply + parallel packed batch.
//!
//! Pure-Rust core (`apply_json_patch_bytes`, `run_json_patch_batch`) is
//! napi-free and unit-testable; the `#[napi]` entry points (`json_patch`,
//! `json_patch_batch_packed`) are thin boundaries that map `JsonPatchError` →
//! napi `Error` with stable context.
//!
//! **Sonic engine**: the `json-patch` crate is hardwired to `serde_json::Value`
//! (a per-key heap `String` DOM). This module implements RFC 6902 directly over
//! `sonic_rs::Value` (compact tagged nodes, no per-key heap `String`), so the
//! patch path no longer builds a `serde_json` DOM. RFC 6901 pointer escapes
//! (`~0`→`~`, `~1`→`/`) are validated eagerly at patch parse (bad escapes →
//! `InvalidPatch`, matching the crate's eager deserialization). The `test` op
//! uses sonic's `Value ==`, which has serde_json-identical number semantics
//! (`1 != 1.0`), preserving the crate's behavior.
//!
//! Hardening / efficiency notes:
//! - **Bounded sizes** — inputs are capped (`MAX_JSON_PATCH_INPUT`) and the
//!   result is capped (`MAX_JSON_PATCH_OUTPUT`). A malicious chain of
//!   RFC 6902 `copy` ops duplicates subtrees and can grow the output
//!   exponentially relative to the input; the cap refuses to hand such output
//!   back to the caller.
//! - **Capacity** — the common in-place field/array edit keeps the result ≈ the
//!   document size, so serialization starts at `doc.len()` and grows only when
//!   a patch genuinely expands the document (no 2× over-allocation for
//!   `test`/`remove`-heavy patches).
//! - **Scalability** — `json_patch_batch_packed` zips two packed buffers and
//!   applies patches in parallel via rayon when the workload justifies it
//!   (`should_parallelize`), staying serial and deterministic otherwise.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};

// ── Custom sonic RFC 6902 engine ────────────────────────────────

use sonic_rs::{JsonContainerTrait, JsonType, JsonValueMutTrait, JsonValueTrait};

/// A parsed RFC 6901 JSON Pointer (segments already `~0`/`~1`-unescaped).
#[derive(Debug, Clone, PartialEq)]
struct Pointer {
    segments: Vec<String>,
}

impl Pointer {
    fn root() -> Self {
        Pointer {
            segments: Vec::new(),
        }
    }

    /// Parse an RFC 6901 pointer string. `""` = root; any non-empty pointer
    /// must start with `/`. `~0`→`~`, `~1`→`/`; any other `~x` (including a
    /// trailing `~`) is an invalid escape → `Err` (the caller maps to
    /// `InvalidPatch`, matching the json-patch crate's eager validation).
    fn parse(s: &str) -> std::result::Result<Self, ()> {
        if s.is_empty() {
            return Ok(Self::root());
        }
        if !s.starts_with('/') {
            return Err(());
        }
        let mut segments = Vec::new();
        let mut cur = String::new();
        let mut chars = s[1..].chars();
        while let Some(c) = chars.next() {
            match c {
                '/' => segments.push(std::mem::take(&mut cur)),
                '~' => match chars.next() {
                    Some('0') => cur.push('~'),
                    Some('1') => cur.push('/'),
                    _ => return Err(()),
                },
                other => cur.push(other),
            }
        }
        segments.push(cur);
        Ok(Pointer { segments })
    }
}

/// A parsed RFC 6902 patch operation.
#[derive(Debug)]
enum PatchOp {
    Add {
        path: Pointer,
        value: sonic_rs::Value,
    },
    Remove {
        path: Pointer,
    },
    Replace {
        path: Pointer,
        value: sonic_rs::Value,
    },
    Move {
        from: Pointer,
        path: Pointer,
    },
    Copy {
        from: Pointer,
        path: Pointer,
    },
    Test {
        path: Pointer,
        value: sonic_rs::Value,
    },
}

/// Parse one patch operation object. `Err(())` → `InvalidPatch`.
fn parse_op(obj: &sonic_rs::Value) -> std::result::Result<PatchOp, ()> {
    let op_str = obj.get("op").and_then(|v| v.as_str()).ok_or(())?;
    let path = obj
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or(())
        .and_then(Pointer::parse)?;
    match op_str {
        "add" | "replace" | "test" => {
            let value = obj.get("value").cloned().ok_or(())?;
            Ok(match op_str {
                "add" => PatchOp::Add { path, value },
                "replace" => PatchOp::Replace { path, value },
                _ => PatchOp::Test { path, value },
            })
        }
        "remove" => Ok(PatchOp::Remove { path }),
        "move" | "copy" => {
            let from = obj
                .get("from")
                .and_then(|v| v.as_str())
                .ok_or(())
                .and_then(Pointer::parse)?;
            Ok(if op_str == "move" {
                PatchOp::Move { from, path }
            } else {
                PatchOp::Copy { from, path }
            })
        }
        _ => Err(()),
    }
}

/// Immutably resolve a value by path segments.
fn resolve<'a>(node: &'a sonic_rs::Value, segs: &[String]) -> Option<&'a sonic_rs::Value> {
    let mut cur = node;
    for seg in segs {
        cur = child(cur, seg)?;
    }
    Some(cur)
}

fn child<'a>(node: &'a sonic_rs::Value, seg: &str) -> Option<&'a sonic_rs::Value> {
    match node.get_type() {
        JsonType::Object => node.get(seg),
        JsonType::Array => {
            if seg == "-" {
                return None;
            }
            let idx: usize = seg.parse().ok()?;
            node.get(idx)
        }
        _ => None,
    }
}

/// Mutably resolve a value by path segments.
fn resolve_mut<'a>(
    node: &'a mut sonic_rs::Value,
    segs: &[String],
) -> Option<&'a mut sonic_rs::Value> {
    let mut cur = node;
    for seg in segs {
        cur = child_mut(cur, seg)?;
    }
    Some(cur)
}

fn child_mut<'a>(node: &'a mut sonic_rs::Value, seg: &str) -> Option<&'a mut sonic_rs::Value> {
    match node.get_type() {
        JsonType::Object => node.get_mut(seg),
        JsonType::Array => {
            if seg == "-" {
                return None;
            }
            let idx: usize = seg.parse().ok()?;
            node.get_mut(idx)
        }
        _ => None,
    }
}

/// RFC 6902 `add` (also the write half of `move`/`copy`). Root replaces the
/// document; an object member is inserted/replaced; an array element is
/// inserted at `idx` (`0..=len`, `-` appends).
fn apply_add(
    doc: &mut sonic_rs::Value,
    path: &Pointer,
    value: sonic_rs::Value,
) -> std::result::Result<(), String> {
    if path.segments.is_empty() {
        *doc = value;
        return Ok(());
    }
    let last = path.segments.last().unwrap();
    let parent = resolve_mut(doc, &path.segments[..path.segments.len() - 1])
        .ok_or("add: target parent does not exist")?;
    match parent.get_type() {
        JsonType::Object => {
            let obj = parent.as_object_mut().unwrap();
            obj.insert(last.as_str(), value);
            Ok(())
        }
        JsonType::Array => {
            let arr = parent.as_array_mut().unwrap();
            if last == "-" {
                arr.push(value);
            } else {
                let idx: usize = last.parse().map_err(|_| "add: invalid array index")?;
                if idx > arr.len() {
                    return Err("add: array index out of range".into());
                }
                arr.insert(idx, value);
            }
            Ok(())
        }
        _ => Err("add: target parent is not an object or array".into()),
    }
}

/// RFC 6902 `remove`.
fn apply_remove(doc: &mut sonic_rs::Value, path: &Pointer) -> std::result::Result<(), String> {
    if path.segments.is_empty() {
        return Err("remove: cannot remove the document root".into());
    }
    let last = path.segments.last().unwrap();
    let parent = resolve_mut(doc, &path.segments[..path.segments.len() - 1])
        .ok_or("remove: target parent does not exist")?;
    match parent.get_type() {
        JsonType::Object => {
            let obj = parent.as_object_mut().unwrap();
            obj.remove(last).ok_or("remove: member does not exist")?;
            Ok(())
        }
        JsonType::Array => {
            let idx: usize = last.parse().map_err(|_| "remove: invalid array index")?;
            let arr = parent.as_array_mut().unwrap();
            if idx >= arr.len() {
                return Err("remove: array index out of range".into());
            }
            arr.remove(idx);
            Ok(())
        }
        _ => Err("remove: target parent is not an object or array".into()),
    }
}

/// RFC 6902 `replace` (target must exist).
fn apply_replace(
    doc: &mut sonic_rs::Value,
    path: &Pointer,
    value: sonic_rs::Value,
) -> std::result::Result<(), String> {
    if path.segments.is_empty() {
        *doc = value;
        return Ok(());
    }
    let target =
        resolve_mut(doc, &path.segments).ok_or("replace: target location does not exist")?;
    *target = value;
    Ok(())
}

/// RFC 6902 `move` — remove at `from`, then add at `path`. `from` MUST NOT be
/// a proper prefix of `path` (cannot move a node into one of its children).
fn apply_move(
    doc: &mut sonic_rs::Value,
    from: &Pointer,
    path: &Pointer,
) -> std::result::Result<(), String> {
    if from.segments.len() < path.segments.len() && path.segments.starts_with(&from.segments) {
        return Err("move: 'from' is a prefix of 'path'".into());
    }
    let value = resolve(doc, &from.segments)
        .cloned()
        .ok_or("move: 'from' location does not exist")?;
    apply_remove(doc, from)?;
    apply_add(doc, path, value)
}

/// Apply a parsed patch to a document (RFC 6902 semantics over sonic Value).
fn apply_patch(doc: &mut sonic_rs::Value, ops: &[PatchOp]) -> std::result::Result<(), String> {
    for op in ops {
        match op {
            PatchOp::Add { path, value } => apply_add(doc, path, value.clone())?,
            PatchOp::Remove { path } => apply_remove(doc, path)?,
            PatchOp::Replace { path, value } => apply_replace(doc, path, value.clone())?,
            PatchOp::Move { from, path } => apply_move(doc, from, path)?,
            PatchOp::Copy { from, path } => {
                let value = resolve(doc, &from.segments)
                    .cloned()
                    .ok_or("copy: 'from' location does not exist")?;
                apply_add(doc, path, value)?;
            }
            PatchOp::Test { path, value } => {
                let actual =
                    resolve(doc, &path.segments).ok_or("test: target location does not exist")?;
                if actual != value {
                    return Err("test: value does not match target".into());
                }
            }
        }
    }
    Ok(())
}

/// Parse a patch document into a list of operations (eager RFC 6901 pointer
/// validation). `Err` → `InvalidPatch`.
fn parse_patch(patch: &[u8]) -> std::result::Result<Vec<PatchOp>, JsonPatchError> {
    let patch_val: sonic_rs::Value =
        sonic_rs::from_slice(patch).map_err(|e| JsonPatchError::InvalidPatch(e.to_string()))?;
    let arr = patch_val
        .as_array()
        .ok_or_else(|| JsonPatchError::InvalidPatch("patch must be an array".into()))?;
    let mut ops = Vec::with_capacity(arr.len());
    for op in arr {
        let op = parse_op(op)
            .map_err(|_| JsonPatchError::InvalidPatch("invalid patch operation".into()))?;
        ops.push(op);
    }
    Ok(ops)
}

/// Maximum accepted size of a single JSON document or patch (defense in depth
/// before parsing). Generous; only adversarial inputs trip it.
const MAX_JSON_PATCH_INPUT: usize = 64 * 1024 * 1024;

/// Maximum serialized output size. A result guard: an oversized (e.g.
/// `copy`-amplified) result is rejected rather than returned to the caller.
const MAX_JSON_PATCH_OUTPUT: usize = 128 * 1024 * 1024;

/// JSON Patch errors, rendered with stable, human-readable context.
#[derive(Debug)]
pub enum JsonPatchError {
    /// The document bytes are not valid JSON.
    InvalidDoc(String),
    /// The patch bytes are not a valid RFC 6902 patch document.
    InvalidPatch(String),
    /// The patch could not be applied (test mismatch, missing path, type clash).
    ApplyFailed(String),
    /// An input or the serialized output exceeded the bounded-size guard.
    TooLarge(&'static str, usize),
    /// Output serialization failed (cannot happen for a valid `Value`).
    Serialize(String),
    /// Batch item `index` failed to apply.
    BatchItem {
        index: usize,
        source: Box<JsonPatchError>,
    },
}

impl std::fmt::Display for JsonPatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDoc(e) => write!(f, "json patch: invalid document: {e}"),
            Self::InvalidPatch(e) => write!(f, "json patch: invalid patch: {e}"),
            Self::ApplyFailed(e) => write!(f, "json patch: apply failed: {e}"),
            Self::TooLarge(kind, n) => {
                write!(f, "json patch: {kind} size {n} exceeds maximum")
            }
            Self::Serialize(e) => write!(f, "json patch: serialize failed: {e}"),
            Self::BatchItem { index, source } => {
                write!(f, "json patch batch: item {index} failed: {source}")
            }
        }
    }
}

/// Apply `patch` to `doc` (RFC 6902) and return the serialized result.
///
/// Pure-Rust core — no napi types, fully unit-testable. Tests exercise the size
/// guards via [`apply_json_patch_bytes_limited`] with small limits.
pub fn apply_json_patch_bytes(
    doc: &[u8],
    patch: &[u8],
) -> std::result::Result<Vec<u8>, JsonPatchError> {
    apply_json_patch_bytes_limited(doc, patch, MAX_JSON_PATCH_INPUT, MAX_JSON_PATCH_OUTPUT)
}

fn apply_json_patch_bytes_limited(
    doc: &[u8],
    patch: &[u8],
    max_input: usize,
    max_output: usize,
) -> std::result::Result<Vec<u8>, JsonPatchError> {
    if doc.len() > max_input {
        return Err(JsonPatchError::TooLarge("document", doc.len()));
    }
    if patch.len() > max_input {
        return Err(JsonPatchError::TooLarge("patch", patch.len()));
    }

    let mut doc_val: sonic_rs::Value =
        sonic_rs::from_slice(doc).map_err(|e| JsonPatchError::InvalidDoc(e.to_string()))?;

    let ops = parse_patch(patch)?;
    apply_patch(&mut doc_val, &ops).map_err(JsonPatchError::ApplyFailed)?;

    // The overwhelmingly common case is an in-place field/array edit, which
    // keeps the result ≈ the document size; grow only if the patch expands it.
    // The output is then bounded as a *result guard*: the sonic DOM has
    // already been (potentially `copy`-amplified), so refusing oversized
    // output prevents handing a giant buffer back to the caller.
    let mut out = Vec::with_capacity(doc.len().min(max_output));
    sonic_rs::to_writer(&mut out, &doc_val)
        .map_err(|e| JsonPatchError::Serialize(e.to_string()))?;

    if out.len() > max_output {
        return Err(JsonPatchError::TooLarge("output", out.len()));
    }
    Ok(out)
}

/// The first failure encountered while processing a batch.
struct BatchFailure {
    index: usize,
    source: JsonPatchError,
}

/// Pure-Rust batch core: zip `docs` with `patches` and apply each pair.
///
/// Parallel via rayon when the workload justifies it; otherwise serial and
/// deterministic (first error wins). Errors are index-bearing
/// ([`JsonPatchError::BatchItem`]). Successful results are order-preserving.
pub fn run_json_patch_batch(
    docs: &[&[u8]],
    patches: &[&[u8]],
) -> std::result::Result<Vec<Vec<u8>>, JsonPatchError> {
    debug_assert_eq!(docs.len(), patches.len());

    if should_parallelize(docs.len(), total_bytes(docs)) {
        use rayon::prelude::*;
        let results: std::result::Result<Vec<Vec<u8>>, BatchFailure> = docs
            .par_iter()
            .zip(patches.par_iter())
            .enumerate()
            .map(
                |(index, (doc, patch))| match apply_json_patch_bytes(doc, patch) {
                    Ok(result) => Ok(result),
                    Err(source) => Err(BatchFailure { index, source }),
                },
            )
            .collect();
        match results {
            Ok(results) => Ok(results),
            Err(BatchFailure { index, source }) => Err(JsonPatchError::BatchItem {
                index,
                source: Box::new(source),
            }),
        }
    } else {
        let mut results = Vec::with_capacity(docs.len());
        for (index, (doc, patch)) in docs.iter().zip(patches.iter()).enumerate() {
            match apply_json_patch_bytes(doc, patch) {
                Ok(result) => results.push(result),
                Err(source) => {
                    return Err(JsonPatchError::BatchItem {
                        index,
                        source: Box::new(source),
                    })
                }
            }
        }
        Ok(results)
    }
}

// ── napi boundary ────────────────────────────────────────────────

/// Apply an RFC 6902 JSON Patch to a JSON document.
///
/// `doc` and `patch` are raw JSON byte buffers; the patched document is
/// returned as JSON bytes. Throws on invalid JSON or an inapplicable patch.
#[napi]
pub fn json_patch(doc: Uint8Array, patch: Uint8Array) -> Result<Buffer> {
    apply_json_patch_bytes(doc.as_ref(), patch.as_ref())
        .map(Buffer::from)
        .map_err(|e| Error::from_reason(e.to_string()))
}

/// Apply a batch of RFC 6902 patches (packed in → packed out).
///
/// `docs` and `patches` are packed buffers (`[u32 count] { [u32 len] [bytes] }`)
/// of equal length, zipped per index. Returns packed results
/// (`[u32 count] { [u32 len] [bytes] }`). **Fail-fast**: an invalid item aborts
/// the whole batch with an index-bearing error — unlike the bitset-style batch
/// helpers, silently dropping a patch would risk silent data loss.
#[napi]
pub fn json_patch_batch_packed(docs: Uint8Array, patches: Uint8Array) -> Result<Buffer> {
    let doc_items = unpack(docs.as_ref()).map_err(|e| Error::from_reason(e.to_string()))?;
    let patch_items = unpack(patches.as_ref()).map_err(|e| Error::from_reason(e.to_string()))?;

    if doc_items.len() != patch_items.len() {
        return Err(Error::from_reason(format!(
            "json patch batch: docs count {} != patches count {}",
            doc_items.len(),
            patch_items.len()
        )));
    }

    if doc_items.is_empty() {
        // Packed empty result: `[u32 count = 0]`.
        return Ok(Buffer::from(vec![0u8; 4]));
    }

    let results = run_json_patch_batch(&doc_items, &patch_items)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    let body: usize = results.iter().map(|result| result.len() + 4).sum();
    let mut out = Vec::with_capacity(4 + body);
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for result in &results {
        out.extend_from_slice(&(result.len() as u32).to_le_bytes());
        out.extend_from_slice(result);
    }
    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;
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
            patches
                .push(format!("[{{\"op\":\"add\",\"path\":\"/k\",\"value\":{i}}}]").into_bytes());
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
            patches
                .push(format!("[{{\"op\":\"add\",\"path\":\"/k\",\"value\":{i}}}]").into_bytes());
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
}
