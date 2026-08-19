// rust/util/batch/api.rs — napi boundary for the packed aggregate batch APIs.
//
// Thin `#[napi]` wrappers over the routing core in `core.rs`. Grouped into the
// three JS-facing families: sync packed→packed, aggregate (count/total), and
// reusable-output (`_into`) variants.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::crypto::hashing::fnv1a64_bytes;
use crate::json::json_ops::json_sum_ids_bytes;
use crate::util::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};

use super::core::{
    bytes_map_serial, cookie_parse_batch_bytes, count_batch_data, form_parse_batch_bytes,
    hex_decode_batch_bytes, hex_encode_batch_bytes, hmac_sha256_batch_bytes,
    hmac_sha256_verify_batch_bytes, http_parse_request_batch_bytes, json_sum_batch_bytes,
    json_valid_batch_bytes, query_parse_batch_bytes, run_bitset_batch, run_sum_batch,
    sign_cookie_batch_bytes, sum_ids_batch_data, total_len_batch_data, validate_email_batch_bytes,
    validate_ipv4_batch_bytes, validate_ipv6_batch_bytes, validate_uuid_batch_bytes,
};

// ── Sync packed batch APIs ──

#[napi]
pub fn json_valid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_valid_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_email_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_email_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_uuid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_uuid_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_ipv4_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv4_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn validate_ipv6_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv6_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn json_sum_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_sum_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn fnv1a64_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(run_sum_batch(input.as_ref(), |item| {
        fnv1a64_bytes(item) as i64
    })?))
}
#[napi]
pub fn query_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(query_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn cookie_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(cookie_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn form_parse_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(form_parse_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn sign_cookie_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(sign_cookie_batch_bytes(
        data.as_ref(),
        secret.as_ref(),
    )?))
}
#[napi]
pub fn verify_cookie_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    run_bitset_batch(
        data.as_ref(),
        |s| crate::crypto::cookie_sign::verify_cookie_bytes_bool(s, &key),
        4096,
    )
    .map(Buffer::from)
}
#[napi]
pub fn csrf_verify_batch_packed(data: Uint8Array, secret: Uint8Array) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, secret.as_ref());
    run_bitset_batch(
        data.as_ref(),
        |t| crate::crypto::csrf::csrf_verify_with_key(t, &key),
        4096,
    )
    .map(Buffer::from)
}

// ── HMAC-SHA256 batch (packed) ──

#[napi]
pub fn hmac_sha256_batch_packed(input: Uint8Array, key: Uint8Array) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key.as_ref());
    Ok(Buffer::from(hmac_sha256_batch_bytes(input.as_ref(), &key)?))
}

#[napi]
pub fn hmac_sha256_verify_batch_packed(
    input: Uint8Array,
    sigs: Uint8Array,
    key: Uint8Array,
) -> Result<Buffer> {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, key.as_ref());
    Ok(Buffer::from(hmac_sha256_verify_batch_bytes(
        input.as_ref(),
        sigs.as_ref(),
        &key,
    )?))
}
#[napi]
pub fn http_parse_request_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_batch_bytes(
        input.as_ref(),
    )?))
}
#[napi]
pub fn hex_encode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(hex_encode_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn hex_decode_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(hex_decode_batch_bytes(input.as_ref())?))
}
#[napi]
pub fn base64_encode_batch_packed(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<Buffer> {
    let us = url_safe.unwrap_or(false);
    let pad = padding.unwrap_or(true);
    let out = bytes_map_serial(input.as_ref(), move |v| {
        crate::crypto::base64::base64_encode_bytes(v, us, pad)
    })?;
    Ok(Buffer::from(out))
}
#[napi]
pub fn base64_decode_batch_packed(
    input: Uint8Array,
    url_safe: Option<bool>,
    padding: Option<bool>,
) -> Result<Buffer> {
    let us = url_safe.unwrap_or(false);
    let pad = padding.unwrap_or(true);
    let out = bytes_map_serial(input.as_ref(), move |v| {
        crate::crypto::base64::base64_decode_bytes(v, us, pad)
            .map_err(|e| Error::from_reason(e.to_string()))
            .unwrap_or_default()
    })?;
    Ok(Buffer::from(out))
}

// ── Aggregate sync packed batch APIs ──

#[napi]
pub fn json_valid_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), crate::json::json_ops::json_valid_bytes, 512)
}
#[napi]
pub fn validate_email_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_email_bytes, 4096)
}
#[napi]
pub fn validate_uuid_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_uuid_bytes, 4096)
}
#[napi]
pub fn validate_ipv4_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_ipv4_bytes, 4096)
}
#[napi]
pub fn validate_ipv6_batch_count_packed(input: Uint8Array) -> Result<u32> {
    count_batch_data(input.as_ref(), validate_ipv6_bytes, 4096)
}
#[napi]
pub fn json_sum_batch_total_packed(input: Uint8Array) -> Result<i64> {
    sum_ids_batch_data(input.as_ref(), 512)
}
#[napi]
pub fn query_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(
        input.as_ref(),
        crate::http::query_parser::query_parse_packed_vec,
        256,
    )
}
#[napi]
pub fn cookie_parse_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(
        input.as_ref(),
        crate::http::cookie_parser::cookie_parse_packed_vec,
        256,
    )
}
#[napi]
pub fn http_parse_request_batch_total_len_packed(input: Uint8Array) -> Result<u32> {
    total_len_batch_data(
        input.as_ref(),
        crate::http::http_parser::http_parse_request_packed_vec,
        256,
    )
}

// ── Reusable-output (`_into`) packed batch variants ──
// Write the packed result into a caller-provided buffer and return bytes
// written. Wire format is byte-identical to the allocating variants; the JS
// loader uses these with a pooled output buffer to avoid per-call allocation.
// `run_packed_into` guards against input/output aliasing (copies input when
// they overlap) and every write is capacity-checked.

#[napi]
pub fn json_valid_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_bitset_batch_into(data, out, crate::json::json_ops::json_valid_bytes)
    })
}

#[napi]
pub fn validate_email_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_bitset_batch_into(data, out, validate_email_bytes)
    })
}

#[napi]
pub fn validate_uuid_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_bitset_batch_into(data, out, validate_uuid_bytes)
    })
}

#[napi]
pub fn validate_ipv4_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_bitset_batch_into(data, out, validate_ipv4_bytes)
    })
}

#[napi]
pub fn validate_ipv6_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_bitset_batch_into(data, out, validate_ipv6_bytes)
    })
}

#[napi]
pub fn json_sum_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_sum_batch_into(data, out, |item| json_sum_ids_bytes(item).unwrap_or(0))
    })
}

#[napi]
pub fn fnv1a64_batch_packed_into(input: Uint8Array, mut output: Uint8Array) -> Result<u32> {
    crate::util::run_packed_into(&input, &mut output, |data, out| {
        crate::util::write_sum_batch_into(data, out, |item| fnv1a64_bytes(item) as i64)
    })
}
