// rust/json_ops.rs — v2: tighter inlining
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::de::{Deserializer, IgnoredAny, SeqAccess, Visitor};
use serde::Deserialize;
use std::fmt;

#[derive(Deserialize)]
struct IdRow {
    #[serde(default)]
    id: Option<i64>,
}

struct IdSumVisitor;

impl<'de> Visitor<'de> for IdSumVisitor {
    type Value = i64;

    #[inline]
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of objects with numeric ids")
    }

    #[inline]
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error> {
        let mut sum = 0i64;
        while let Some(row) = seq.next_element::<Option<IdRow>>()? {
            if let Some(IdRow { id: Some(id) }) = row {
                sum = sum.saturating_add(id);
            }
        }
        Ok(sum)
    }
}

struct IdSum(i64);

impl<'de> Deserialize<'de> for IdSum {
    #[inline]
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        d.deserialize_seq(IdSumVisitor).map(IdSum)
    }
}

#[inline(always)]
pub fn json_valid_bytes(input: &[u8]) -> bool {
    // sonic-rs uses SIMD validation internally — already optimal.
    sonic_rs::from_slice::<IgnoredAny>(input).is_ok()
}

#[inline]
pub fn json_sum_ids_bytes(input: &[u8]) -> Result<i64> {
    sonic_rs::from_slice::<IdSum>(input)
        .map(|s| s.0)
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn json_valid(input: Uint8Array) -> bool {
    json_valid_bytes(input.as_ref())
}

#[napi]
pub fn json_sum_ids(input: Uint8Array) -> Result<i64> {
    json_sum_ids_bytes(input.as_ref())
}