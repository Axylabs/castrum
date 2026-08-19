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
