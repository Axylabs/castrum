use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

#[napi]
pub fn json_patch(doc: Uint8Array, patch: Uint8Array) -> Result<Buffer> {
    let mut doc_val: Value =
        sonic_rs::from_slice(doc.as_ref()).map_err(|e| Error::from_reason(e.to_string()))?;

    let patch_val: json_patch::Patch =
        sonic_rs::from_slice(patch.as_ref()).map_err(|e| Error::from_reason(e.to_string()))?;

    json_patch::patch(&mut doc_val, &patch_val).map_err(|e| Error::from_reason(e.to_string()))?;

    let mut out = Vec::with_capacity(
        doc.as_ref()
            .len()
            .saturating_add(patch.as_ref().len())
            .saturating_add(32),
    );

    sonic_rs::to_writer(&mut out, &doc_val).map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(Buffer::from(out))
}