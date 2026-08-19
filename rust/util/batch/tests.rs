// rust/util/batch/tests.rs — parity tests for the packed batch core + napi API.
//
// Verifies serial/parallel byte parity (both routing paths must produce
// identical output) and the reusable-output (`_into`) writers against the
// allocating variants.

use super::core::{bitset_serial, query_parse_packed_vec, sum_batch_serial};
use super::*;
use crate::util::unpack;
use napi::bindgen_prelude::*;

/// Build packed input: `[u32 count] repeated { [u32 len][bytes] }`.
fn pack_items(items: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for item in items {
        out.extend_from_slice(&(item.len() as u32).to_le_bytes());
        out.extend_from_slice(item);
    }
    out
}

/// Decode packed byte results: `[u32 count] repeated { [u32 len][bytes] }`.
fn unpack_results(packed: &[u8]) -> Vec<Vec<u8>> {
    assert!(packed.len() >= 4);
    let n = u32::from_le_bytes(packed[0..4].try_into().unwrap()) as usize;
    let mut pos = 4usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = u32::from_le_bytes(packed[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        out.push(packed[pos..pos + len].to_vec());
        pos += len;
    }
    out
}

#[test]
fn hex_encode_batch_matches_scalar() {
    let data = pack_items(&[b"hi\0\xff", b"AB"]);
    let out = hex_encode_batch_bytes(&data).unwrap();
    let results = unpack_results(&out);
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0],
        crate::crypto::base64::hex_encode_bytes(b"hi\0\xff").into_bytes()
    );
    assert_eq!(results[1], b"4142");
}

#[test]
fn hex_decode_batch_roundtrips() {
    let data = pack_items(&[b"686900ff", b"4142"]);
    let out = hex_decode_batch_bytes(&data).unwrap();
    let results = unpack_results(&out);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0], b"hi\0\xff");
    assert_eq!(results[1], b"AB");
}

#[test]
fn base64_encode_batch_matches_scalar() {
    let data = pack_items(&[b"hello world!", b"\xfb"]);
    let out = base64_encode_batch_packed(Uint8Array::new(data), None, None).unwrap();
    let results = unpack_results(out.as_ref());
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[0],
        crate::crypto::base64::base64_encode_bytes(b"hello world!", false, true)
    );
    assert_eq!(
        results[1],
        crate::crypto::base64::base64_encode_bytes(b"\xfb", false, true)
    );
}

#[test]
fn base64_decode_batch_roundtrips() {
    let a = crate::crypto::base64::base64_encode_bytes(b"hello world!", false, true);
    let b = crate::crypto::base64::base64_encode_bytes(b"\xfb", false, true);
    let data = pack_items(&[&a, &b]);
    let out = base64_decode_batch_packed(Uint8Array::new(data), None, None).unwrap();
    let results = unpack_results(out.as_ref());
    assert_eq!(results.len(), 2);
    assert_eq!(results[0], b"hello world!");
    assert_eq!(results[1], [0xfb]);
}

#[test]
fn base64_encode_batch_urlsafe_no_pad() {
    let data = pack_items(&[b"\xfb"]);
    let out =
        base64_encode_batch_packed(Uint8Array::new(data), Some(true), Some(false)).unwrap();
    let results = unpack_results(out.as_ref());
    assert_eq!(results[0], b"-w");
}

/// Item count that reliably crosses `should_parallelize`'s item threshold,
/// forcing the rayon branch of the routing helpers.
fn parallel_item_count() -> usize {
    rayon::current_num_threads().max(1).saturating_mul(2048) + 64
}

#[test]
fn bitset_serial_matches_parallel() {
    let n = parallel_item_count();
    let items: Vec<Vec<u8>> = (0..n).map(|i| vec![b'x'; 1 + (i % 3)]).collect();
    let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
    let packed = pack_items(&refs);

    let serial = bitset_serial(&packed, |x| x.len() == 1).unwrap();
    let routed = run_bitset_batch(&packed, |x| x.len() == 1, 64).unwrap();
    assert_eq!(serial, routed);
}

#[test]
fn sum_serial_matches_parallel() {
    let n = parallel_item_count();
    let items: Vec<Vec<u8>> = (0..n).map(|i| i.to_string().into_bytes()).collect();
    let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
    let packed = pack_items(&refs);

    let serial = sum_batch_serial(&packed, |x| x.len() as i64).unwrap();
    let routed = run_sum_batch(&packed, |x| x.len() as i64).unwrap();
    assert_eq!(serial, routed);
}

#[test]
fn bytes_map_serial_matches_direct() {
    let items: Vec<Vec<u8>> = (0..32)
        .map(|i| format!("a={}&b={}", i, i).into_bytes())
        .collect();
    let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
    let packed = pack_items(&refs);

    let serial =
        bytes_map_serial(&packed, |v| query_parse_packed_vec(v).unwrap_or_default()).unwrap();

    // Reconstruct the previous unpack + per-item write behavior for parity.
    let unpacked = unpack(&packed).unwrap();
    let mut expected = Vec::new();
    expected.extend_from_slice(&(unpacked.len() as u32).to_le_bytes());
    for item in &unpacked {
        let r = query_parse_packed_vec(item).unwrap_or_default();
        expected.extend_from_slice(&(r.len() as u32).to_le_bytes());
        expected.extend_from_slice(&r);
    }
    assert_eq!(serial, expected);
}

#[test]
fn hmac_batch_matches_scalar() {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret");
    let data = pack_items(&[b"hello", b"world"]);
    let out = hmac_sha256_batch_bytes(&data, &key).unwrap();
    let results = unpack_results(&out);
    assert_eq!(results.len(), 2);
    for (input, result) in [b"hello".as_slice(), b"world".as_slice()]
        .iter()
        .zip(&results)
    {
        let tag = aws_lc_rs::hmac::sign(&key, input);
        let mut sig = [0u8; 64];
        crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig);
        assert_eq!(result.as_slice(), &sig[..]);
    }
}

#[test]
fn hmac_verify_batch_matches_scalar() {
    let key = aws_lc_rs::hmac::Key::new(aws_lc_rs::hmac::HMAC_SHA256, b"secret");
    let mut sig_ok = [0u8; 64];
    let tag = aws_lc_rs::hmac::sign(&key, b"hello");
    crate::util::bytes::hex_encode_32(tag.as_ref(), &mut sig_ok);
    let sig_bad = [b'0'; 64];

    let data = pack_items(&[b"hello", b"tampered"]);
    let sigs = pack_items(&[&sig_ok, &sig_bad]);
    let out = hmac_sha256_verify_batch_packed(
        Uint8Array::new(data),
        Uint8Array::new(sigs),
        Uint8Array::new(b"secret".to_vec()),
    )
    .unwrap();
    let bits = out.as_ref();
    assert_eq!(&bits[..4], &2u32.to_le_bytes());
    assert_eq!(bits[4], 0b0000_0001); // item 0 valid, item 1 invalid
}

// ── reusable-output (_into) variants ──

#[test]
fn bitset_into_matches_allocating() {
    // Force the rayon branch (large count) so serial/parallel parity holds.
    let n = parallel_item_count();
    let items: Vec<Vec<u8>> = (0..n).map(|i| vec![b'x'; 1 + (i % 3)]).collect();
    let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
    let packed = pack_items(&refs);

    let allocating = run_bitset_batch(&packed, |x| x.len() == 1, 64).unwrap();
    let mut out = vec![0u8; allocating.len()];
    let written = crate::util::write_bitset_batch_into(&packed, &mut out, |x| x.len() == 1).unwrap();
    assert_eq!(written, allocating.len());
    assert_eq!(&out[..written], &allocating[..]);
}

#[test]
fn bitset_into_zeroes_stale_bytes() {
    let packed = pack_items(&[b"a", b"bb", b"ccc"]);
    let mut out = vec![0xFFu8; 4 + 1]; // stale bytes must be zeroed by writer
    let written = crate::util::write_bitset_batch_into(&packed, &mut out, |_| false).unwrap();
    assert_eq!(written, 5);
    assert_eq!(&out[..written], &[3, 0, 0, 0, 0]); // count=3, all bits clear
}

#[test]
fn bitset_into_errors_on_small_buffer() {
    let packed = pack_items(&[b"a", b"bb", b"ccc"]);
    let mut out = vec![0u8; 4]; // needs 4 + ceil(3/8) = 5
    assert!(crate::util::write_bitset_batch_into(&packed, &mut out, |_| true).is_err());
}

#[test]
fn sum_into_matches_allocating() {
    let n = parallel_item_count();
    let items: Vec<Vec<u8>> = (0..n).map(|i| i.to_string().into_bytes()).collect();
    let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
    let packed = pack_items(&refs);

    let allocating = run_sum_batch(&packed, |x| x.len() as i64).unwrap();
    let mut out = vec![0u8; allocating.len()];
    let written = crate::util::write_sum_batch_into(&packed, &mut out, |x| x.len() as i64).unwrap();
    assert_eq!(written, allocating.len());
    assert_eq!(&out[..written], &allocating[..]);
}

#[test]
fn u32_into_matches_expected_layout() {
    let packed = pack_items(&[b"a", b"bb", b"ccc"]);
    let mut out = vec![0u8; 4 + 3 * 4];
    let written =
        crate::util::write_u32_batch_into(&packed, &mut out, |x| x.len() as u32).unwrap();
    assert_eq!(written, 4 + 3 * 4);
    assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 3);
    for (i, x) in [&b"a"[..], b"bb", b"ccc"].iter().enumerate() {
        let v = u32::from_le_bytes(out[4 + i * 4..4 + (i + 1) * 4].try_into().unwrap());
        assert_eq!(v as usize, x.len());
    }
}

#[test]
fn validate_email_into_reports_length_and_errors() {
    let data = pack_items(&[b"a@b.com", b"not-an-email"]);
    let out = Uint8Array::new(vec![0u8; 16]);
    let n = validate_email_batch_packed_into(Uint8Array::new(data), out).unwrap();
    assert_eq!(n as usize, 4 + 1); // count + 1-byte bitset for 2 items

    let out2 = Uint8Array::new(vec![0u8; 4]);
    assert!(validate_email_batch_packed_into(
        Uint8Array::new(pack_items(&[b"a@b.com", b"x"])),
        out2,
    )
    .is_err());
}

#[test]
fn fnv1a64_into_matches_allocating() {
    let data = pack_items(&[b"hello", b"world", b""]);
    let allocating = fnv1a64_batch_packed(Uint8Array::new(data.clone())).unwrap();
    let out = Uint8Array::new(vec![0u8; allocating.len()]);
    let n = fnv1a64_batch_packed_into(Uint8Array::new(data), out).unwrap();
    assert_eq!(n as usize, allocating.len());
}

// ── Packed-batch parity (moved from unit_tests.rs) ───────────────
// These exercise the packed `[u32 count]{[u32 len][bytes]}` wire format across
// the batch entry points (util::batch + the per-domain batch fns).

/// Build the `[u32 count]{[u32 len][bytes]}` packed batch input for tests.
fn pack_slices(items: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());
    for it in items {
        out.extend_from_slice(&(it.len() as u32).to_le_bytes());
        out.extend_from_slice(it);
    }
    out
}

fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn read_i64(buf: &[u8], off: usize) -> i64 {
    i64::from_le_bytes([
        buf[off], buf[off + 1], buf[off + 2], buf[off + 3],
        buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7],
    ])
}

#[test]
fn fnv1a64_batch_matches_scalar() {
    let out = fnv1a64_batch_packed(Uint8Array::new(pack_slices(&[b"foobar", b"", b"castrum"])))
        .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 3);
    assert_eq!(read_i64(out, 4), 0x8594_4171_f739_67e8u64 as i64);
    assert_eq!(read_i64(out, 12), 0xcbf2_9ce4_8422_2325u64 as i64);
    assert_eq!(
        read_i64(out, 20),
        crate::crypto::hashing::fnv1a64_bytes(b"castrum") as i64
    );
}

#[test]
fn etag_batch_matches_scalar() {
    let out = crate::http::etag::etag_batch_packed(
        Uint8Array::new(pack_slices(&[b"123456789", b"hello"])),
        None,
    )
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"\"cbf43926\"");
    // Weak variant is 12 bytes with the W/ prefix.
    let weak = crate::http::etag::etag_batch_packed(
        Uint8Array::new(pack_slices(&[b"123456789"])),
        Some(true),
    )
    .unwrap();
    let weak = weak.as_ref();
    let wlen = read_u32(weak, 4) as usize;
    assert_eq!(wlen, 12);
    assert_eq!(&weak[8..8 + wlen], b"W/\"cbf43926\"");
}

#[test]
fn url_encode_batch_matches_scalar() {
    let out = crate::http::url_codec::url_encode_batch_packed(Uint8Array::new(pack_slices(&[
        b"a b&c", b"plain",
    ])))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"a%20b%26c");
}

#[test]
fn url_decode_batch_matches_scalar() {
    let out = crate::http::url_codec::url_decode_batch_packed(Uint8Array::new(pack_slices(&[
        b"a%20b", b"plain",
    ])))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"a b");

    // Strict bytes decode (no UTF-8 validation): %C3%A9 → the two raw bytes.
    let out = crate::http::url_codec::url_decode_bytes_batch_packed(Uint8Array::new(pack_slices(&[
        b"%C3%A9",
    ])))
    .unwrap();
    let out = out.as_ref();
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], &[0xc3, 0xa9]);
}

#[test]
fn mime_from_extension_batch_matches_scalar() {
    let out = crate::http::mime_lookup::mime_from_extension_batch_packed(Uint8Array::new(
        pack_slices(&[b".js", b"PNG", b"nope"]),
    ))
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 3);
    let mut off = 4usize;
    let expected = [
        b"text/javascript".as_slice(),
        b"image/png".as_slice(),
        b"application/octet-stream".as_slice(),
    ];
    for exp in expected {
        let len = read_u32(out, off) as usize;
        off += 4;
        assert_eq!(&out[off..off + len], exp);
        off += len;
    }
}

#[test]
fn ws_accept_key_batch_matches_rfc6455() {
    // Expected vector mirrors the repo's existing scalar test in
    // rust/payload/websocket.rs (rfc6455_accept_key_vector).
    let out = crate::payload::websocket::ws_accept_key_batch_packed(Uint8Array::new(pack_slices(&[
        b"dGhlIHNhbXBsZSBub25jZQ==",
    ])))
    .unwrap();
    let out = out.as_ref();
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

#[test]
fn password_verify_batch_matches_scalar() {
    use crate::crypto::argon2::hash_password;
    // Low-cost argon2id so the test stays fast; salt must be >= 8 bytes.
    let phc = hash_password(b"hunter2", b"0123456789abcdef", 8, 1, 1, 16).unwrap();
    let good = crate::crypto::argon2::password_verify_batch_packed(
        Uint8Array::new(pack_slices(&[b"hunter2", b"wrong"])),
        Uint8Array::new(pack_slices(&[phc.as_bytes(), phc.as_bytes()])),
    )
    .unwrap();
    let good = good.as_ref();
    // bitset: bit0 = true (correct password), bit1 = false.
    assert_eq!(read_u32(good, 0), 2);
    assert_eq!(good[4] & 0b01, 0b01);
    assert_eq!(good[4] & 0b10, 0);
}

#[test]
fn url_resolve_batch_matches_rfc3986() {
    let base = b"http://a/b/c/d;p?q";
    let out = crate::http::url_join::url_resolve_batch_packed(
        Uint8Array::new(pack_slices(&[base.as_slice(), base.as_slice()])),
        Uint8Array::new(pack_slices(&[b"g", b"../g"])),
    )
    .unwrap();
    let out = out.as_ref();
    assert_eq!(read_u32(out, 0), 2);
    let len0 = read_u32(out, 4) as usize;
    assert_eq!(&out[8..8 + len0], b"http://a/b/c/g");
    let off = 8 + len0;
    let len1 = read_u32(out, off) as usize;
    assert_eq!(&out[off + 4..off + 4 + len1], b"http://a/b/g");
}
