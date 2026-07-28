// rust/async_tasks.rs — v2: spawn_blocking with owned bytes
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::util::tokio_join_error;

#[napi]
pub async fn json_valid_async(input: Uint8Array) -> Result<u32> {
    // Must copy: Uint8Array is a JS-owned reference and not Send.
    let input = input.as_ref().to_vec();
    let valid = tokio::task::spawn_blocking(move || json_valid_bytes(&input))
        .await
        .map_err(tokio_join_error)?;
    Ok(valid as u32)
}

#[napi]
pub async fn json_sum_ids_async(input: Uint8Array) -> Result<i64> {
    let input = input.as_ref().to_vec();
    tokio::task::spawn_blocking(move || json_sum_ids_bytes(&input))
        .await
        .map_err(tokio_join_error)?
}