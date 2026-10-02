// rust/panic_safety.rs — cross-module "never panic on malformed input" tests.
//
// These span several parsers (headers, query, cookie, JSON serialization), so
// they have no single owning module — kept as a dedicated test-only module
// (declared `#[cfg(test)]` in lib.rs). Every reachable parser must return
// Ok/Err on arbitrary bytes, never panic (a panic in the napi path becomes a
// JS 500; in the C-ABI path it is contained by `panic_guard`).

use crate::http::headers::HeaderRefs;
use crate::test_support::Rng;

#[test]
fn parsers_do_not_panic_on_malformed_input() {
    let mut rng = Rng(0xdeadbeef);

    for _ in 0..2000 {
        let len = (rng.next() % 64) as usize;
        let data = rng.bytes(len);

        // Every reachable parser must return Ok/Err, never panic.
        let _ = crate::http::query_parser::query_parse_packed_vec(&data);
        let _ = crate::http::cookie_parser::cookie_parse_packed_vec(&data);
        let _ = HeaderRefs::parse(&data, (rng.next() & 1) == 1, 100);
        let _ = crate::json::json_ser::cookie_json_into_slice(&data, &mut [0u8; 64], 100);
        let _ = crate::json::json_ser::json_escaped_len(&data);
    }
}

#[test]
fn header_parser_do_not_panic_on_adversarial_packed_headers() {
    let mut rng = Rng(0xc0ffee);

    for _ in 0..2000 {
        // Length fields are arbitrary bytes -> must not cause OOB reads/panics.
        let len = (rng.next() % 48) as usize;
        let data = rng.bytes(len);
        let _ = HeaderRefs::parse(&data, true, 200);
        let _ = HeaderRefs::parse(&data, false, 200);
    }
}

// ── Hand-rolled writers: arbitrary input × undersized output buffers ──
//
// Every writer that takes a caller-provided output slice MUST report an error
// (Err / None) instead of panicking or writing past the end when the buffer is
// too small, and MUST NOT read out of bounds when the input is arbitrary bytes.
// A panic here means a hostile request becomes a 500 (napi) or is merely
// contained by `panic_guard` (C-ABI) — neither is acceptable.

#[test]
fn hand_rolled_writers_never_panic_on_undersized_buffers() {
    let mut rng = Rng(0x5eed_5eed);
    for _ in 0..3000 {
        let len = (rng.next() % 40) as usize;
        let data = rng.bytes(len);
        for cap in [0usize, 1, 2, 3, 7, 15, 31, data.len(), data.len() * 2 + 1] {
            let mut out = vec![0u8; cap];
            let _ = crate::crypto::base64::hex_encode_into_slice(&data, &mut out);
            let _ = crate::crypto::base64::hex_decode_into_slice(&data, &mut out);
            let _ = crate::http::url_codec::url_encode_into_slice(&data, &mut out);
            let _ = crate::http::url_codec::url_decode_into_slice(&data, &mut out);
            let _ = crate::http::query_parser::query_parse_packed_into_slice(&data, &mut out);
            let _ = crate::http::cookie_parser::cookie_parse_packed_into_slice(&data, &mut out);
            let _ = crate::http::http_parser::http_parse_request_packed_into_slice(&data, &mut out);
            let _ = crate::http::etag::etag_from_crc32_into(rng.next() as u32, true, &mut out);
            let _ = crate::payload::ws_frames::encode_frame_into(
                (rng.next() & 0x0f) as u8,
                &data,
                rng.next() & 1 == 0,
                rng.next() & 1 == 0,
                &mut out,
            );
            let _ = crate::payload::sse::encode_event_into_slice(
                Some("e"),
                &data,
                Some("i"),
                Some(rng.next()),
                &mut out,
            );
            let _ =
                crate::util::packed::write_bitset_batch_into(&data, &mut out, |b| b.len() % 2 == 0);
            let _ = crate::util::packed::write_sum_batch_into(&data, &mut out, |b| b.len() as i64);
            let _ = crate::util::packed::write_u32_batch_into(&data, &mut out, |b| b.len() as u32);
        }
    }
}

// ── Broad parser sweep: arbitrary bytes must never panic ──

#[test]
fn hand_rolled_parsers_never_panic_on_hostile_input() {
    let mut rng = Rng(0xfeed_face);
    let supported = vec!["gzip".to_string(), "br".to_string(), "*".to_string()];
    for _ in 0..3000 {
        let len = (rng.next() % 96) as usize;
        let data = rng.bytes(len);

        // Decoders / validators over untrusted bytes.
        let _ = crate::crypto::base64::hex_decode_bytes(&data);
        let _ = crate::util::bytes::decode_form_component_len(&data);
        let mut form_out = vec![0u8; data.len()];
        let _ = crate::util::bytes::decode_form_component_into(&data, &mut form_out);
        let mut scratch = Vec::new();
        let _ = crate::util::bytes::decode_form_component_scratch(&data, &mut scratch);
        let _ = crate::util::bytes::hex_decode_32(&data);
        let _: Vec<_> = crate::util::bytes::cookie_pairs(&data).collect();
        let mut verdicts = Vec::new();
        let _ = crate::util::validation::hex_batch_valid_into(
            &data,
            (rng.next() % 40) as usize,
            &mut verdicts,
        );

        // HTTP-surface parsers.
        let _ = crate::http::method::MethodKind::from_bytes_ignore_case(&data);
        let _ = crate::http::mime_lookup::mime_from_extension_bytes(&data);
        let _ = crate::http::http_date::parse_http_date_secs(&data);
        let _ = crate::http::accept::parse_accept_encoding_core(&data);
        let _ = crate::http::accept::negotiate_encoding_server_preference(&supported, &data);
        let _ = crate::payload::ws_frames::decode_frame(&data);
    }
}

// ── multipart: hostile body/boundary + packed-writer size contract ──

#[test]
fn multipart_parser_never_panics_on_hostile_input() {
    let mut rng = Rng(0xb0_0b0b);
    for _ in 0..1500 {
        let body_len = (rng.next() % 300) as usize;
        let body = rng.bytes(body_len);
        let boundary_len = (rng.next() % 20) as usize;
        let boundary = rng.bytes(boundary_len);
        let limits = crate::http::multipart::Limits {
            max_parts: 16,
            max_field_count: 16,
            max_part_bytes: 128,
            max_total_bytes: 256,
        };
        let parts = crate::http::multipart::parse_multipart_limited(&body, &boundary, &limits);
        let all = crate::http::multipart::parse_multipart(&body, &boundary);
        for p in &all {
            let _ = (
                p.name.len(),
                p.filename.is_some(),
                p.content_type.is_some(),
                p.data.len(),
            );
        }

        let mut packed = Vec::new();
        crate::http::multipart::parts_to_packed(&parts, &mut packed);
        assert_eq!(
            packed.len(),
            crate::http::multipart::parts_packed_len(&parts),
            "parts_packed_len must match the Vec writer"
        );
        // Undersized packed output must return None (no partial write) …
        if !packed.is_empty() {
            let mut small = vec![0u8; packed.len() - 1];
            assert!(crate::http::multipart::parts_to_packed_into(&parts, &mut small).is_none());
        }
        // … and an exact-size buffer must reproduce the Vec bytes byte-for-byte.
        let mut exact = vec![0u8; packed.len()];
        let n = crate::http::multipart::parts_to_packed_into(&parts, &mut exact)
            .expect("exact-size buffer must succeed");
        assert_eq!(n, packed.len());
        assert_eq!(exact, packed);
    }
}

// ── Exact length accounting for the hand-rolled escape writers ──
//
// `json_escaped_len` / `regex_escape_len` are used by the C-ABI "needed size"
// convention to allocate EXACTLY once. If the reported length ever disagreed
// with the written length the caller's grow-and-retry loop could spin forever
// (under-report) or the writer could run off the end (over-report). These are
// the strongest invariants for those writers.

#[test]
fn json_escaped_len_is_exact_for_hostile_bytes() {
    let mut rng = Rng(0x150_15015);
    // Alphabet biased toward the escape-triggering classes: NUL, controls,
    // the memchr3 specials, high bytes (invalid UTF-8) and valid multi-byte
    // lead/continuation pairs.
    let alphabet = [
        0u8, 1, 8, 9, 10, 12, 13, 0x1f, b'"', b'\\', b'/', b'a', 0x7f, 0x80, 0xc3, 0xa9, 0xff,
        0xf0, 0x9f,
    ];
    for _ in 0..5000 {
        let len = (rng.next() % 48) as usize;
        let data: Vec<u8> = (0..len)
            .map(|_| alphabet[(rng.next() % alphabet.len() as u64) as usize])
            .collect();

        let need = crate::json::json_ser::json_escaped_len(&data);
        let mut out = vec![0u8; need];
        let mut pos = 0usize;
        let written = crate::json::json_ser::write_json_escaped(&mut out, &mut pos, &data);
        assert_eq!(
            written, need,
            "json escaped length mismatch for {data:02x?}"
        );
        assert_eq!(pos, need);
        // Escaped output of a JSON string must itself be valid UTF-8.
        assert!(std::str::from_utf8(&out).is_ok(), "non-UTF-8 escape output");
    }
}

#[test]
fn regex_escape_write_matches_len_and_reference() {
    let mut rng = Rng(0x2e_9333);
    let metas = b".*+?^${}()|[]\\";
    for _ in 0..5000 {
        let len = (rng.next() % 48) as usize;
        let data = rng.bytes(len);
        let need = crate::util::text::regex_escape_len(&data);
        let mut out = vec![0u8; need];
        let written = crate::util::text::regex_escape_write(&data, &mut out);
        assert_eq!(written, need, "regex escape length mismatch");
        // Independent reference: backslash before each metachar.
        let mut expected = Vec::with_capacity(need);
        for &b in &data {
            if metas.contains(&b) {
                expected.push(b'\\');
            }
            expected.push(b);
        }
        assert_eq!(out, expected, "regex escape output mismatch");
    }
}
