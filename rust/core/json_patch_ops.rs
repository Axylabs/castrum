// rust/core/json_patch_ops.rs — JSON Patch operations
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;

/// Apply a JSON patch to a document and return the result.
#[inline]
pub fn json_patch(doc: &[u8], patch: &[u8]) -> CoreResult<Vec<u8>> {
    let doc_val: serde_json::Value =
        sonic_rs::from_slice(doc).map_err(|_| invalid_input("invalid JSON document"))?;

    let patch_val: json_patch::Patch =
        sonic_rs::from_slice(patch).map_err(|_| invalid_input("invalid JSON patch"))?;

    let mut doc_val = doc_val;
    json_patch::patch(&mut doc_val, &patch_val)
        .map_err(|_| invalid_input("JSON patch application failed"))?;

    let mut out = Vec::with_capacity(
        doc.len()
            .saturating_add(patch.len())
            .saturating_add(32),
    );

    sonic_rs::to_writer(&mut out, &doc_val)
        .map_err(|_| internal_error("JSON serialization failed"))?;

    Ok(out)
}
