// rust/json/patch/engine.rs — bounded RFC 6902 apply + parallel packed batch.
//
// The napi-free, unit-testable core: `apply_json_patch_bytes` (bounded scalar
// apply) and `run_json_patch_batch` (serial/rayon batch). The op semantics
// live in `ops.rs`; the napi boundary is in `api.rs`.

use crate::util::{should_parallelize, total_bytes};

use super::ops::{apply_patch, parse_patch};

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

pub(crate) fn apply_json_patch_bytes_limited(
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
