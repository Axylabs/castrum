// rust/json/patch/ops.rs — RFC 6902 operations over `sonic_rs::Value`.
//
// Parses a patch document into `PatchOp`s and applies them with RFC 6902
// semantics. DOM navigation helpers (`resolve`/`child` + mutable twins) live
// here next to the operations that use them. The bounded apply + batch
// orchestration is in `engine.rs`; the napi boundary is in `api.rs`.

use sonic_rs::{JsonContainerTrait, JsonType, JsonValueMutTrait, JsonValueTrait};

use super::engine::JsonPatchError;
use super::pointer::Pointer;

/// A parsed RFC 6902 patch operation.
#[derive(Debug)]
pub(crate) enum PatchOp {
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

/// Parse a patch document into a list of operations (eager RFC 6901 pointer
/// validation). `Err` → `InvalidPatch`.
pub(crate) fn parse_patch(patch: &[u8]) -> std::result::Result<Vec<PatchOp>, JsonPatchError> {
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

// ── DOM navigation ──────────────────────────────────────────────

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

// ── Operations ──────────────────────────────────────────────────

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
pub(crate) fn apply_patch(
    doc: &mut sonic_rs::Value,
    ops: &[PatchOp],
) -> std::result::Result<(), String> {
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
