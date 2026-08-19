// rust/json/patch/api.rs — napi boundary for RFC 6902 JSON Patch.
//
// Thin `#[napi]` wrappers over the pure core in `engine.rs` that map
// `JsonPatchError` → napi `Error` with stable context.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::unpack;

use super::engine::{apply_json_patch_bytes, run_json_patch_batch};

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
