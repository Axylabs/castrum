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

/// Parse JSON into a JS value (sonic-rs → serde_json::Value → napi).
///
/// This is the "parse to a usable JS object" path — directly comparable to
/// `JSON.parse`. Throws on invalid JSON. Note: napi marshaling of the DOM has
/// real cost, so this is intentionally NOT a zero-copy / validation-only path.
#[napi]
pub fn json_parse(input: Uint8Array) -> Result<serde_json::Value> {
    sonic_rs::from_slice(input.as_ref())
        .map_err(|e| Error::from_reason(format!("JSON parse error: {e}")))
}

#[napi]
pub fn json_sum_ids(input: Uint8Array) -> Result<i64> {
    json_sum_ids_bytes(input.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_parse_roundtrip() {
        let v = sonic_rs::from_slice::<serde_json::Value>(br#"{"a":1,"b":[true,null,"x"]}"#)
            .unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"][0], true);
        assert_eq!(v["b"][2], "x");
    }

    #[test]
    fn json_parse_rejects_invalid() {
        assert!(sonic_rs::from_slice::<serde_json::Value>(b"{not json").is_err());
        assert!(sonic_rs::from_slice::<serde_json::Value>(b"").is_err());
    }

    #[test]
    fn json_valid_matches_parse() {
        let good = br#"{"id":1,"name":"x"}"#;
        assert!(json_valid_bytes(good));
        assert!(sonic_rs::from_slice::<serde_json::Value>(good).is_ok());
        let bad = b"nope";
        assert!(!json_valid_bytes(bad));
        assert!(sonic_rs::from_slice::<serde_json::Value>(bad).is_err());
    }
}