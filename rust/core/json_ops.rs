// rust/core/json_ops.rs — JSON operations: validation and id summation
// Pure Rust, no napi dependencies.

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

/// Validate JSON bytes using sonic-rs SIMD validation.
#[inline(always)]
pub fn json_valid_bytes(input: &[u8]) -> bool {
    sonic_rs::from_slice::<IgnoredAny>(input).is_ok()
}

/// Sum all `id` fields from a JSON array of objects using sonic-rs streaming.
#[inline]
pub fn json_sum_ids_bytes(input: &[u8]) -> Result<i64, String> {
    sonic_rs::from_slice::<IdSum>(input)
        .map(|s| s.0)
        .map_err(|e| e.to_string())
}