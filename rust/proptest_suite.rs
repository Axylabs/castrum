//! Property-based tests (proptest) — adversarial inputs for the wire parsers.
//!
//! Complements the deterministic xorshift corpus in `test_support.rs` with
//! randomized, auto-shrinking inputs. The core property for a security-sensitive
//! native parser is: **given arbitrary (possibly hostile) bytes, it returns a
//! Result/answer WITHOUT panicking and never reads out of bounds.** Run with
//! `cargo test`. proptest is a dev-dependency only — it never ships.

#![cfg(test)]

use proptest::prelude::*;

use crate::http::headers::HeaderRefs;
use crate::http::query_parser::query_parse_packed_vec;
use crate::json::fast_schema::compile;
use crate::util::bytes::decode_percent_at;

proptest! {
    /// HeaderRefs::parse must never panic on arbitrary (possibly truncated,
    /// forged length-field) packed header bytes.
    #[test]
    fn header_refs_parse_never_panics(
        packed in prop::collection::vec(any::<u8>(), 0..1024),
        is_options in any::<bool>(),
        max_headers in 0usize..256usize,
    ) {
        let _ = HeaderRefs::parse(&packed, is_options, max_headers);
    }

    /// query_parse_packed_vec must never panic on arbitrary bytes.
    #[test]
    fn query_parse_never_panics(input in prop::collection::vec(any::<u8>(), 0..1024)) {
        let _ = query_parse_packed_vec(&input);
    }

    /// decode_percent_at must never panic for any index, and must never
    /// "succeed" past the end of the input.
    #[test]
    fn decode_percent_at_never_panics(
        src in prop::collection::vec(any::<u8>(), 0..512),
        i in 0usize..600usize,
    ) {
        if i >= src.len() {
            prop_assert!(decode_percent_at(&src, i).is_none());
        } else {
            let _ = decode_percent_at(&src, i);
        }
    }

    /// The zero-DOM fast-schema validator must never panic on arbitrary bytes
    /// (the schema shape mirrors the hot ingress schema).
    #[test]
    fn fast_schema_never_panics(input in prop::collection::vec(any::<u8>(), 0..2048)) {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "id": { "type": "number" },
                "name": { "type": "string", "minLength": 1 },
                "tags": { "type": "array", "items": { "type": "string" } },
            },
            "required": ["id"],
            "additionalProperties": false
        });
        let fast = compile(&schema).expect("schema must compile on the fast path");
        let _ = fast.is_valid_bytes(&input);
    }
}

/// decode_percent_at round-trips a manually percent-encoded byte (`%HH`).
#[test]
fn decode_percent_at_roundtrip_encoded_byte() {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in 0u16..256u16 {
        let byte = b as u8;
        let enc = [b'%', HEX[(byte >> 4) as usize], HEX[(byte & 0xf) as usize]];
        assert_eq!(decode_percent_at(&enc, 0), Some((byte, 3)));
    }
}
