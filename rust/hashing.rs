use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn crc32(input: Uint8Array) -> u32 {
    crc32fast::hash(input.as_ref())
}

#[napi(js_name = "fnv1a64")]
pub fn fnv1a64(input: Uint8Array) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    input
        .as_ref()
        .iter()
        .fold(OFFSET_BASIS, |hash, &b| {
            (hash ^ u64::from(b)).wrapping_mul(PRIME)
        })
}