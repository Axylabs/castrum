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
