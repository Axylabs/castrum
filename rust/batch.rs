use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;

use crate::cookie_parser::cookie_parse_packed_into_slice;
use crate::http_parser::http_parse_request_packed_into_slice;
use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::query_parser::query_parse_packed_into_slice;
use crate::util::{pack_byte_results, unpack, validation_bitset};
use crate::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

fn json_sum_batch(items: &[&[u8]]) -> Vec<u8> {
    let sums: Vec<i64> =
        if crate::util::should_parallelize(items.len(), crate::util::total_bytes(items)) {
            use rayon::prelude::*;
            items
                .par_iter()
                .map(|item| json_sum_ids_bytes(item).unwrap_or(0))
                .collect()
        } else {
            items
                .iter()
                .map(|item| json_sum_ids_bytes(item).unwrap_or(0))
                .collect()
        };

    let mut out = Vec::with_capacity(4 + sums.len() * 8);
    out.extend_from_slice(&(sums.len() as u32).to_le_bytes());
    for sum in sums {
        out.extend_from_slice(&sum.to_le_bytes());
    }
    out
}
fn parse_batch(items: &[&[u8]], f: impl Fn(&[u8]) -> Result<Vec<u8>> + Sync) -> Vec<u8> {
    let results: Vec<Vec<u8>> =
        if crate::util::should_parallelize(items.len(), crate::util::total_bytes(items)) {
            use rayon::prelude::*;
            items
                .par_iter()
                .map(|item| f(item).unwrap_or_default())
                .collect()
        } else {
            items
                .iter()
                .map(|item| f(item).unwrap_or_default())
                .collect()
        };

    pack_byte_results(&results)
}




fn query_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![0u8; input.len().saturating_mul(5).saturating_add(4)];
    let written = query_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

fn cookie_parse_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![0u8; input.len().saturating_mul(5).saturating_add(4)];
    let written = cookie_parse_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}

fn http_parse_request_packed_vec(input: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![0u8; input.len().saturating_add(1024)];
    let written = http_parse_request_packed_into_slice(input, &mut out)?;
    out.truncate(written);
    Ok(out)
}
// ------------------------------------------------------------------
// Packed input -> packed output internal functions
// ------------------------------------------------------------------

fn json_valid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, json_valid_bytes))
}

fn validate_email_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_email_bytes))
}

fn validate_uuid_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_uuid_bytes))
}

fn validate_ipv4_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_ipv4_bytes))
}

fn validate_ipv6_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(validation_bitset(&items, validate_ipv6_bytes))
}

fn json_sum_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(json_sum_batch(&items))
}

fn query_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, query_parse_packed_vec))
}

fn cookie_parse_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, cookie_parse_packed_vec))
}

fn http_parse_request_batch_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let items = unpack(data)?;
    Ok(parse_batch(&items, http_parse_request_packed_vec))
}

// ------------------------------------------------------------------
// Sync packed batch APIs
// ------------------------------------------------------------------

#[napi]
pub fn json_valid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_valid_batch_bytes(input.as_ref())?))
}

#[napi]
pub fn validate_email_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_email_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_uuid_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_uuid_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_ipv4_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv4_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn validate_ipv6_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(validate_ipv6_batch_bytes(
        input.as_ref(),
    )?))
}

#[napi]
pub fn json_sum_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(json_sum_batch_bytes(input.as_ref())?))
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
pub fn http_parse_request_batch_packed(input: Uint8Array) -> Result<Buffer> {
    Ok(Buffer::from(http_parse_request_batch_bytes(
        input.as_ref(),
    )?))
}

// ------------------------------------------------------------------
// Async packed batch APIs
// ------------------------------------------------------------------

macro_rules! packed_task {
    ($name:ident, $func:path) => {
        pub struct $name {
            packed: Vec<u8>,
        }

        impl Task for $name {
            type Output = Vec<u8>;
            type JsValue = Buffer;

            fn compute(&mut self) -> Result<Self::Output> {
                $func(&self.packed)
            }

            fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
                Ok(Buffer::from(output))
            }
        }
    };
}

packed_task!(JsonValidBatchTask, json_valid_batch_bytes);
packed_task!(ValidateEmailBatchTask, validate_email_batch_bytes);
packed_task!(ValidateUuidBatchTask, validate_uuid_batch_bytes);
packed_task!(ValidateIpv4BatchTask, validate_ipv4_batch_bytes);
packed_task!(ValidateIpv6BatchTask, validate_ipv6_batch_bytes);
packed_task!(JsonSumBatchTask, json_sum_batch_bytes);
packed_task!(QueryParseBatchTask, query_parse_batch_bytes);
packed_task!(CookieParseBatchTask, cookie_parse_batch_bytes);
packed_task!(HttpParseRequestBatchTask, http_parse_request_batch_bytes);

#[napi]
pub fn json_valid_batch_packed_async(input: Buffer) -> AsyncTask<JsonValidBatchTask> {
    AsyncTask::new(JsonValidBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn validate_email_batch_packed_async(input: Buffer) -> AsyncTask<ValidateEmailBatchTask> {
    AsyncTask::new(ValidateEmailBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn validate_uuid_batch_packed_async(input: Buffer) -> AsyncTask<ValidateUuidBatchTask> {
    AsyncTask::new(ValidateUuidBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn validate_ipv4_batch_packed_async(input: Buffer) -> AsyncTask<ValidateIpv4BatchTask> {
    AsyncTask::new(ValidateIpv4BatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn validate_ipv6_batch_packed_async(input: Uint8Array) -> AsyncTask<ValidateIpv6BatchTask> {
    AsyncTask::new(ValidateIpv6BatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn json_sum_batch_packed_async(input: Uint8Array) -> AsyncTask<JsonSumBatchTask> {
    AsyncTask::new(JsonSumBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn query_parse_batch_packed_async(input: Uint8Array) -> AsyncTask<QueryParseBatchTask> {
    AsyncTask::new(QueryParseBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn cookie_parse_batch_packed_async(input: Uint8Array) -> AsyncTask<CookieParseBatchTask> {
    AsyncTask::new(CookieParseBatchTask {
        packed: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn http_parse_request_batch_packed_async(
    input: Uint8Array,
) -> AsyncTask<HttpParseRequestBatchTask> {
    AsyncTask::new(HttpParseRequestBatchTask {
        packed: input.as_ref().to_vec(),
    })
}