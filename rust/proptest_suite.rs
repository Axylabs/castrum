//! Property-based tests (proptest) — adversarial inputs for the wire parsers.
//!
//! Complements the deterministic xorshift corpus in `test_support.rs` with
//! randomized, auto-shrinking inputs. The core property for a security-sensitive
//! native parser is: **given arbitrary (possibly hostile) bytes, it returns a
//! Result/answer WITHOUT panicking and never reads out of bounds.** Run with
//! `cargo test`. proptest is a dev-dependency only — it never ships.

#![cfg(test)]

use proptest::prelude::*;

use crate::http::cookie_parser::cookie_parse_packed_vec;
use crate::http::form::form_parse_packed_vec;
use crate::http::headers::HeaderRefs;
use crate::http::media_type::parse_media_type_core;
use crate::http::query_parser::query_parse_packed_vec;
use crate::json::fast_schema::compile;
use crate::util::bytes::{
    decode_form_component_into, decode_form_component_len, decode_percent_at,
};

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

    /// cookie_parse_packed_vec must never panic on arbitrary bytes (forged
    /// length prefixes, raw NULs, truncated pairs).
    #[test]
    fn cookie_parse_never_panics(input in prop::collection::vec(any::<u8>(), 0..1024)) {
        let _ = cookie_parse_packed_vec(&input);
    }

    /// form_parse_packed_vec must never panic on arbitrary bytes (raw %, +/-
    /// handling, control chars).
    #[test]
    fn form_parse_never_panics(input in prop::collection::vec(any::<u8>(), 0..1024)) {
        let _ = form_parse_packed_vec(&input);
    }

    /// parse_media_type_core must never panic on arbitrary bytes.
    #[test]
    fn media_type_parse_never_panics(input in prop::collection::vec(any::<u8>(), 0..512)) {
        let _ = parse_media_type_core(&input);
    }

    /// RFC 3986 percent-encode → decode must be the identity for EVERY byte
    /// (the encode set here mirrors url_codec.rs's unreserved set).
    #[test]
    fn percent_encode_decode_roundtrip(input in prop::collection::vec(any::<u8>(), 0..256)) {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut encoded = Vec::with_capacity(input.len() * 3);
        for &b in &input {
            let unreserved = matches!(b,
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
                | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | 0x27 | b'(' | b')'
            );
            if unreserved {
                encoded.push(b);
            } else {
                encoded.push(b'%');
                encoded.push(HEX[(b >> 4) as usize]);
                encoded.push(HEX[(b & 0x0f) as usize]);
            }
        }
        let mut decoded = Vec::with_capacity(input.len());
        let mut i = 0usize;
        while i < encoded.len() {
            if encoded[i] == b'%' {
                prop_assert!(i + 2 < encoded.len(), "%XX truncated at {i}");
                // decode_percent_at returns the ABSOLUTE next index (i + 3).
                let (byte, next) = decode_percent_at(&encoded, i).unwrap_or_else(|| {
                    panic!("decode_percent_at failed at {i} in {:?}", &encoded[i..])
                });
                decoded.push(byte);
                i = next;
            } else {
                decoded.push(encoded[i]);
                i += 1;
            }
        }
        prop_assert_eq!(decoded, input);
    }

    // ── Exact size contracts for the hand-rolled decoders/writers ──

    /// The C-ABI "needed size" pass must never under-report the written length
    /// (an under-report would make the caller's grow-and-retry loop spin
    /// forever); an exact-size buffer must always succeed and agree.
    #[test]
    fn decode_form_component_size_contract(input in prop::collection::vec(any::<u8>(), 0..256)) {
        let reported = decode_form_component_len(&input);
        let mut out = vec![0u8; input.len() + 8];
        let written = decode_form_component_into(&input, &mut out)
            .expect("an input-sized buffer always suffices");
        prop_assert!(written <= reported, "reported {} < written {}", reported, written);
        let mut exact = vec![0u8; reported];
        let w2 = decode_form_component_into(&input, &mut exact)
            .expect("exact reported size must suffice");
        prop_assert_eq!(w2, written);
    }

    /// `json_escaped_len` must be an EXACT accounting of `write_json_escaped`
    /// for arbitrary bytes, and the escaped output must be valid UTF-8.
    #[test]
    fn json_escaped_len_exact_accounting(input in prop::collection::vec(any::<u8>(), 0..256)) {
        let need = crate::json::json_ser::json_escaped_len(&input);
        let mut out = vec![0u8; need];
        let mut pos = 0usize;
        let written = crate::json::json_ser::write_json_escaped(&mut out, &mut pos, &input);
        prop_assert_eq!(written, need);
        prop_assert_eq!(pos, need);
        prop_assert!(std::str::from_utf8(&out).is_ok());
    }

    /// `PackedIter`'s three accessors (`next()`/`collect_vec`/
    /// `count_and_total_bytes`) must agree on validity and totals for arbitrary
    /// (forged-length) packed buffers.
    #[test]
    fn packed_iter_self_consistent(input in prop::collection::vec(any::<u8>(), 0..512)) {
        match crate::util::packed::PackedIter::new(&input) {
            Ok(it) => {
                let collected = it.collect_vec();
                let stats = it.count_and_total_bytes();
                prop_assert_eq!(collected.is_ok(), stats.is_ok());
                if let (Ok(items), Ok((count, total))) = (collected, stats) {
                    prop_assert_eq!(items.len(), count);
                    prop_assert_eq!(items.iter().map(|i| i.len()).sum::<usize>(), total);
                    prop_assert_eq!(items.len(), it.len());
                }
                // The Iterator impl must never panic and never yield more items
                // than the header claims.
                prop_assert!(it.take(10_000).count() <= it.len());
            }
            Err(_) => {
                prop_assert!(crate::util::packed::unpack(&input).is_err());
            }
        }
    }

    /// RFC 3986 encode → decode is the identity over arbitrary bytes, and the
    /// encoder's own output is always accepted by the strict decoder.
    #[test]
    fn url_codec_roundtrip(input in prop::collection::vec(any::<u8>(), 0..256)) {
        let mut enc = vec![0u8; input.len() * 3];
        let n = crate::http::url_codec::url_encode_into_slice(&input, &mut enc)
            .expect("3x buffer always suffices");
        enc.truncate(n);
        let mut dec = vec![0u8; enc.len()];
        let m = crate::http::url_codec::url_decode_into_slice(&enc, &mut dec)
            .expect("the encoder output is always well-formed");
        prop_assert_eq!(&dec[..m], &input[..]);
    }

    /// SIMD hex encode → decode is the identity for arbitrary bytes and the
    /// `_into` variants agree byte-for-byte with the allocating ones.
    #[test]
    fn hex_simd_roundtrip_arbitrary(input in prop::collection::vec(any::<u8>(), 0..256)) {
        let enc = crate::crypto::base64::hex_encode_bytes(&input);
        prop_assert_eq!(enc.len(), input.len() * 2);
        let mut into_enc = vec![0u8; input.len() * 2];
        let n = crate::crypto::base64::hex_encode_into_slice(&input, &mut into_enc).unwrap();
        prop_assert_eq!(&into_enc[..n], enc.as_bytes());
        let dec = crate::crypto::base64::hex_decode_bytes(enc.as_bytes())
            .expect("own encoder output always decodes");
        prop_assert_eq!(&dec[..], &input[..]);
        let mut into_dec = vec![0u8; input.len()];
        let m = crate::crypto::base64::hex_decode_into_slice(enc.as_bytes(), &mut into_dec).unwrap();
        prop_assert_eq!(&into_dec[..m], &input[..]);
    }

    /// RFC 6455 encode → decode round-trips for any payload/opcode/flags, and
    /// the zero-alloc writer matches the allocating one byte-for-byte.
    #[test]
    fn ws_frame_roundtrip(
        payload in prop::collection::vec(any::<u8>(), 0..300),
        opcode in 0u8..16,
        mask in any::<bool>(),
        fin in any::<bool>(),
    ) {
        let frame = crate::payload::ws_frames::encode_frame(opcode, &payload, mask, fin);
        let decoded = crate::payload::ws_frames::decode_frame(&frame)
            .expect("a self-produced frame always decodes");
        prop_assert_eq!(decoded.opcode, opcode & 0x0f);
        prop_assert_eq!(decoded.fin, fin);
        prop_assert_eq!(&decoded.payload[..], &payload[..]);
        let mut out = vec![0u8; frame.len()];
        let n = crate::payload::ws_frames::encode_frame_into(opcode, &payload, mask, fin, &mut out)
            .unwrap();
        prop_assert_eq!(&out[..n], &frame[..]);
    }

    /// SSE `encode_event_size` must be exact and one byte short must error
    /// (never panic / write out of bounds).
    #[test]
    fn sse_encode_size_contract(data in prop::collection::vec(any::<u8>(), 0..256)) {
        let need = crate::payload::sse::encode_event_size(Some("evt"), &data, Some("id"), Some(42));
        let mut out = vec![0u8; need];
        let w = crate::payload::sse::encode_event_into_slice(
            Some("evt"), &data, Some("id"), Some(42), &mut out,
        )
        .unwrap();
        prop_assert_eq!(w, need);
        if need > 0 {
            let mut small = vec![0u8; need - 1];
            prop_assert!(crate::payload::sse::encode_event_into_slice(
                Some("evt"), &data, Some("id"), Some(42), &mut small,
            )
            .is_err());
        }
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
