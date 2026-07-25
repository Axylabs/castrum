use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::cookie_parser::cookie_parse_vec;
use crate::http_parser::http_parse_request_vec;
use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::query_parser::query_parse_vec;
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

// ------------------------------------------------------------------
// Generic byte-output async tasks
// ------------------------------------------------------------------

macro_rules! bytes_output_async_fn {
    ($fn_name:ident, $func:path) => {
        #[napi]
        pub async fn $fn_name(input: Uint8Array) -> Result<Buffer> {
            let input = input.as_ref().to_vec();

            let output = tokio::task::spawn_blocking(move || $func(&input))
                .await
                .map_err(tokio_join_error)?;

            Ok(Buffer::from(output?))
        }
    };
}

bytes_output_async_fn!(http_parse_request_async, http_parse_request_vec);
bytes_output_async_fn!(query_parse_async, query_parse_vec);
bytes_output_async_fn!(cookie_parse_async, cookie_parse_vec);