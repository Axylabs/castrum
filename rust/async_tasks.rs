use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::tokio_join_error;

// ------------------------------------------------------------------
// JSON valid
// ------------------------------------------------------------------

#[napi]
pub async fn json_valid_async(input: Uint8Array) -> Result<u32> {
    let input = input.as_ref().to_vec();

    let valid = tokio::task::spawn_blocking(move || json_valid_bytes(&input))
        .await
        .map_err(tokio_join_error)?;

    Ok(valid as u32)
}

// ------------------------------------------------------------------
// JSON sum ids
// ------------------------------------------------------------------

#[napi]
pub async fn json_sum_ids_async(input: Uint8Array) -> Result<i64> {
    let input = input.as_ref().to_vec();

    tokio::task::spawn_blocking(move || json_sum_ids_bytes(&input))
        .await
        .map_err(tokio_join_error)?
}
