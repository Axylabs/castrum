// rust/src/bin/native-bench.rs — native-only timing of the pure-Rust cores.
//
// Diagnostic binary (NEVER shipped; not part of the addon). It times the same
// core functions `bun:ffi` wraps — but with NO JS / FFI boundary — so
// `bench/ffi-margin.ts` can compare them against the same ops called through
// `bun:ffi` and pinpoint exactly where the crossing cost is.
//
// Inputs: reads base64-NDJSON on stdin (`key\t<base64>`), byte-identical to
// what the JS runner feeds its FFI side, so both sides measure the same work.
// Missing keys fall back to the embedded defaults below (so
// `cargo run --release --bin native-bench` works standalone).
//
// Output: one `name\t<ns_per_op>` line per op (min-of-3 batches, after
// warmup). Build/run from the repo root:
//   cargo run --release --bin native-bench < inputs.ndjson

use std::collections::HashMap;
use std::hint::black_box;
use std::io::{self, BufRead};
use std::time::Instant;

use aws_lc_rs::aead::AES_256_GCM;
use aws_lc_rs::hmac;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

use castrum::crypto::base64::{
    base64_decode_into_slice, base64_encode_into_slice, hex_decode_into_slice,
    hex_encode_into_slice,
};
use castrum::crypto::hashing::{crc32_bytes, fast_hash_bytes, fnv1a64_bytes};
use castrum::http::cookie_parser::cookie_parse_packed_into_slice;
use castrum::http::etag::etag_from_crc32_into;
use castrum::http::http_date::http_date_into_slice;
use castrum::http::http_parser::http_parse_request_packed_into_slice;
use castrum::http::query_parser::query_parse_packed_into_slice;
use castrum::http::url_codec::{url_decode_into_slice, url_encode_into_slice};
use castrum::json::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use castrum::payload::compress::{
    brotli_compress_into, brotli_decompress_into, gzip_compress_into, gzip_decompress_into,
};
use castrum::payload::sse::encode_event_into_slice;
use castrum::payload::websocket::ws_accept_key_into;
use castrum::util::validation::{
    validate_email_bytes, validate_ipv4_bytes, validate_ipv6_bytes, validate_uuid_bytes,
};

// ── Embedded default inputs (used when stdin supplies no key) ──────────────
const DEFAULT_CRC: &[u8] = b"Hello, practical CRC32 checksum test data!";
const DEFAULT_ENCODE: &[u8] = b"the quick brown fox jumps over the lazy dog 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789";
const DEFAULT_HEX: &[u8] = b"74686520717569636b2062726f776e20666f78206a756d7073206f76657220746865206c617a7920646f6720303132333435363738392030313233343536373839203031323334353637383920303132333435363738392030313233343536373839203031323334353637383920303132333435363738392030313233343536373839";
const DEFAULT_URL_ENCODE: &[u8] = b"hello world & foo=bar";
const DEFAULT_URL_DECODE: &[u8] = b"hello%20world%20%26%20foo%3Dbar";
const DEFAULT_EMAIL: &[u8] = b"user@example.com";
const DEFAULT_UUID: &[u8] = b"550e8400-e29b-41d4-a716-446655440000";
const DEFAULT_IPV4: &[u8] = b"192.168.1.100";
const DEFAULT_IPV6: &[u8] = b"2001:db8::1";
const DEFAULT_JSON: &[u8] = b"[{\"id\":1,\"name\":\"a\"},{\"id\":2,\"name\":\"b\"}]";
const DEFAULT_ETAG: &[u8] = b"etag data payload for the margin bench";
const DEFAULT_WS_KEY: &[u8] = b"dGhlIHNhbXBsZSBub25jZQ==";
const DEFAULT_HTTP: &[u8] = b"GET /api/users?page=1&limit=20 HTTP/1.1\r\nHost: example.com\r\nAccept: application/json\r\n\r\n";
const DEFAULT_QUERY: &[u8] = b"name=John+Doe&age=30&tags[]=a&tags[]=b";
const DEFAULT_COOKIE: &[u8] = b"session=abc123; theme=dark; lang=en-US";
const DEFAULT_HMAC_KEY: &[u8] = b"super-secret-key-2026";
const DEFAULT_HMAC_DATA: &[u8] = b"message to sign with HMAC-SHA256";
const DEFAULT_COMPRESS: &[u8] = b"row 0: the quick brown fox jumps over the lazy dog 0\nrow 1: the quick brown fox jumps over the lazy dog 1\nrow 2: the quick brown fox jumps over the lazy dog 2";
const DEFAULT_COOKIE_VALUE: &[u8] = b"session-value";
const DEFAULT_COOKIE_SECRET: &[u8] = b"s3cr3t-secret";
const DEFAULT_CSRF_SECRET: &[u8] = b"csrf-secret-2026";
const DEFAULT_PASSWORD: &[u8] = b"correct horse battery staple";
const DEFAULT_PASSWORD_SALT: &[u8] = b"0123456789abcdef";
const DEFAULT_PBKDF2_PW: &[u8] = b"password";
const DEFAULT_PBKDF2_SALT: &[u8] = b"salt";
const DEFAULT_AEAD_KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
const DEFAULT_AEAD_NONCE: &[u8] = b"0123456789ab";
const DEFAULT_AEAD_PT: &[u8] = b"sensitive session payload for the margin bench";
const DEFAULT_WS_PAYLOAD: &[u8] = b"Hello WebSocket! x10";
const DEFAULT_JSON_DOC: &[u8] = b"{\"a\":\"b\",\"c\":1}";
const DEFAULT_JSON_PATCH: &[u8] = b"[{\"op\":\"replace\",\"path\":\"/a\",\"value\":42}]";
const DEFAULT_JWT_CLAIMS: &[u8] = b"{\"sub\":\"user-1\"}";
const DEFAULT_JWT_SECRET: &[u8] = b"my-secret";
const DEFAULT_MULTIPART_BODY: &[u8] = b"--FormBoundary1234\r\nContent-Disposition: form-data; name=\"field1\"\r\n\r\nhello world\r\n--FormBoundary1234--\r\n";
const DEFAULT_MULTIPART_BOUNDARY: &[u8] = b"FormBoundary1234";
const DEFAULT_HTTP_DATE_SECS: i64 = 1_750_000_000;

/// Min-of-3-batches timing: warm up, then take the fastest batch's ns/op.
fn bench<F: FnMut() -> u64>(name: &str, iters: u64, mut f: F) {
    for _ in 0..(iters / 20).max(1) {
        black_box(f());
    }
    let mut best = u64::MAX;
    for _ in 0..3 {
        let start = Instant::now();
        for _ in 0..iters {
            black_box(f());
        }
        let ns = start.elapsed().as_nanos() as u64;
        if ns < best {
            best = ns;
        }
    }
    println!("{}\t{:.1}", name, best as f64 / iters as f64);
}

fn packed_out_cap(input_len: usize) -> usize {
    input_len * 9 + 16
}

fn main() {
    let mut inputs: HashMap<String, Vec<u8>> = HashMap::new();
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Some((key, b64)) = line.split_once('\t') {
            if let Ok(bytes) = B64.decode(b64) {
                inputs.insert(key.to_string(), bytes);
            }
        }
    }
    let inp = |key: &str, fallback: &[u8]| -> Vec<u8> {
        inputs
            .get(key)
            .cloned()
            .unwrap_or_else(|| fallback.to_vec())
    };

    let crc = inp("crc_input", DEFAULT_CRC);
    let encode = inp("encode_data", DEFAULT_ENCODE);
    let hex_in = inp("hex_input", DEFAULT_HEX);
    let url_enc = inp("url_encode_input", DEFAULT_URL_ENCODE);
    let url_dec = inp("url_decode_input", DEFAULT_URL_DECODE);
    let email = inp("email_ok", DEFAULT_EMAIL);
    let uuid = inp("uuid_ok", DEFAULT_UUID);
    let ipv4 = inp("ipv4_ok", DEFAULT_IPV4);
    let ipv6 = inp("ipv6_ok", DEFAULT_IPV6);
    let json = inp("json_payload", DEFAULT_JSON);
    let etag_data = inp("etag_data", DEFAULT_ETAG);
    let ws_key = inp("ws_key", DEFAULT_WS_KEY);
    let http = inp("http_raw", DEFAULT_HTTP);
    let query = inp("query_str", DEFAULT_QUERY);
    let cookie = inp("cookie_str", DEFAULT_COOKIE);
    let hmac_key = inp("hmac_key", DEFAULT_HMAC_KEY);
    let hmac_data = inp("hmac_data", DEFAULT_HMAC_DATA);
    let compress = inp("compress_payload", DEFAULT_COMPRESS);
    let base64_input = inp("base64_input", B64.encode(&encode).as_bytes());
    let hmac_sig = inp("hmac_sig", &[0u8; 64]);
    let cookie_value = inp("cookie_value", DEFAULT_COOKIE_VALUE);
    let cookie_secret = inp("cookie_secret", DEFAULT_COOKIE_SECRET);
    let csrf_secret = inp("csrf_secret", DEFAULT_CSRF_SECRET);
    let password = inp("password_bytes", DEFAULT_PASSWORD);
    let password_salt = inp("password_salt", DEFAULT_PASSWORD_SALT);
    let pbkdf2_pw = inp("pbkdf2_password", DEFAULT_PBKDF2_PW);
    let pbkdf2_salt = inp("pbkdf2_salt", DEFAULT_PBKDF2_SALT);
    let aead_key = inp("aead_key", DEFAULT_AEAD_KEY);
    let aead_nonce = inp("aead_nonce", DEFAULT_AEAD_NONCE);
    let aead_pt = inp("aead_plaintext", DEFAULT_AEAD_PT);
    let ws_payload = inp("ws_payload", DEFAULT_WS_PAYLOAD);
    let json_doc = inp("json_doc", DEFAULT_JSON_DOC);
    let json_patch_data = inp("json_patch_data", DEFAULT_JSON_PATCH);
    let jwt_claims = inp("jwt_claims", DEFAULT_JWT_CLAIMS);
    let jwt_secret = inp("jwt_secret", DEFAULT_JWT_SECRET);
    let multipart_body = inp("multipart_body", DEFAULT_MULTIPART_BODY);
    let multipart_boundary = inp("multipart_boundary", DEFAULT_MULTIPART_BOUNDARY);
    let gzip_compressed = inp("gzip_compressed", &[]);
    let brotli_compressed = inp("brotli_compressed", &[]);
    let content_type = inp(
        "content_type_multipart",
        b"multipart/form-data; boundary=FormBoundary1234; charset=UTF-8".as_slice(),
    );

    // Reusable output buffers.
    let mut hex_out = vec![0u8; encode.len() * 2];
    let mut hex_dec_out = vec![0u8; hex_in.len() / 2 + 1];
    let mut b64_out = vec![0u8; encode.len() * 4 / 3 + 4];
    let mut b64_dec_out = vec![0u8; encode.len() + 8];
    let mut url_out = vec![0u8; url_enc.len() * 3];
    let mut urld_out = vec![0u8; url_dec.len()];
    let mut etag_out = vec![0u8; 32];
    let mut date_out = vec![0u8; 32];
    let mut ws_out = vec![0u8; 32];
    let mut http_out = vec![0u8; packed_out_cap(http.len())];
    let mut query_out = vec![0u8; packed_out_cap(query.len())];
    let mut cookie_out = vec![0u8; packed_out_cap(cookie.len())];
    let mut gz_out = vec![0u8; compress.len() * 2 + 64];
    let mut br_out = vec![0u8; compress.len() * 2 + 64];
    let mut gz_d_out = vec![0u8; compress.len() * 2 + 64];
    let mut br_d_out = vec![0u8; compress.len() * 2 + 64];
    let mut cookie_sig_out = vec![0u8; cookie_value.len() + 65];
    let mut cookie_val_out = vec![0u8; cookie_value.len() + 65];
    let mut csrf_out = [0u8; 129];
    let mut ws_frame_out = vec![0u8; ws_payload.len() + 14];
    let mut pbkdf2_out = vec![0u8; 32];
    let mut random_out = vec![0u8; 32];

    // Compiled once (matches the C-ABI per-thread key cache steady state).
    let hmac_key_compiled = hmac::Key::new(hmac::HMAC_SHA256, &hmac_key);
    let cookie_key = hmac::Key::new(hmac::HMAC_SHA256, &cookie_secret);
    let csrf_key = hmac::Key::new(hmac::HMAC_SHA256, &csrf_secret);
    let mut hmac_tag_out = [0u8; 64];
    let mut sig_bytes = [0u8; 32];

    // Derived inputs computed ONCE (matching the FFI side's setup).
    let ws_frame = castrum::payload::ws_frames::encode_frame_into(
        1,
        &ws_payload,
        false,
        true,
        &mut ws_frame_out,
    )
    .unwrap();
    let aead_ct =
        castrum::crypto::aead::encrypt(&AES_256_GCM, &aead_key, &aead_nonce, &aead_pt).unwrap();
    let argon_phc = castrum::crypto::argon2::hash_password(&password, &password_salt, 8, 1, 1, 16)
        .unwrap()
        .into_bytes();
    let bcrypt_phc = bcrypt::hash(&password, castrum::crypto::bcrypt::clamp_cost(4))
        .unwrap()
        .into_bytes();
    let signed_cookie_len = castrum::crypto::cookie_sign::sign_cookie_into(
        &cookie_value,
        &cookie_key,
        &mut cookie_sig_out,
    )
    .unwrap();
    let csrf_token_bytes: Vec<u8> = {
        let mut rnd = [0u8; 32];
        getrandom::fill(&mut rnd).unwrap();
        let mut rnd_hex = [0u8; 64];
        castrum::util::bytes::hex_encode(&rnd, &mut rnd_hex);
        let mut sig_hex = [0u8; 64];
        castrum::util::bytes::hex_encode(hmac::sign(&csrf_key, &rnd_hex).as_ref(), &mut sig_hex);
        let mut t = Vec::with_capacity(129);
        t.extend_from_slice(&rnd_hex);
        t.push(b'.');
        t.extend_from_slice(&sig_hex);
        t
    };

    // ── Hash / checksum ──
    bench("crc32", 1_000_000, || crc32_bytes(&crc) as u64);
    bench("fnv1a64", 1_000_000, || fnv1a64_bytes(&crc) as u64);
    bench("xxh3", 1_000_000, || fast_hash_bytes(&crc) as u64);

    // ── Encode / decode ──
    bench("hex_encode", 500_000, || {
        hex_encode_into_slice(&encode, &mut hex_out).unwrap() as u64
    });
    bench("hex_decode", 500_000, || {
        hex_decode_into_slice(&hex_in, &mut hex_dec_out).unwrap() as u64
    });
    bench("base64_encode", 500_000, || {
        base64_encode_into_slice(&encode, &mut b64_out, false, true).unwrap() as u64
    });
    bench("base64_decode", 500_000, || {
        base64_decode_into_slice(&base64_input, &mut b64_dec_out, false, true).unwrap() as u64
    });
    bench("url_encode", 500_000, || {
        url_encode_into_slice(&url_enc, &mut url_out).unwrap() as u64
    });
    bench("url_decode", 500_000, || {
        url_decode_into_slice(&url_dec, &mut urld_out).unwrap() as u64
    });

    // ── Validators ──
    bench("validate_email", 1_000_000, || {
        validate_email_bytes(&email) as u64
    });
    bench("validate_uuid", 1_000_000, || {
        validate_uuid_bytes(&uuid) as u64
    });
    bench("validate_ipv4", 1_000_000, || {
        validate_ipv4_bytes(&ipv4) as u64
    });
    bench("validate_ipv6", 1_000_000, || {
        validate_ipv6_bytes(&ipv6) as u64
    });

    // ── JSON (zero-DOM) ──
    bench("json_valid", 500_000, || json_valid_bytes(&json) as u64);
    bench("json_sum_ids", 500_000, || {
        json_sum_ids_bytes(&json).unwrap() as u64
    });
    // ── JSON DOM parse ALONE (no napi marshal) — the reference for the
    // structural json_parse split: proves the sonic-rs parse is cheap and the
    // ~5x CPU-bench loss is the napi DOM→JS marshal, not the parser. ──
    bench("json_parse_dom", 200_000, || {
        let v: serde_json::Value = sonic_rs::from_slice(&json).unwrap();
        v.as_array().map_or(0, |a| a.len()) as u64
    });

    // ── ETag / HTTP-date / WebSocket accept ──
    bench("etag", 500_000, || {
        let crc = crc32_bytes(&etag_data);
        etag_from_crc32_into(crc, false, &mut etag_out).unwrap() as u64
    });
    bench("http_date", 500_000, || {
        http_date_into_slice(DEFAULT_HTTP_DATE_SECS, &mut date_out).unwrap() as u64
    });
    bench("ws_accept_key", 500_000, || {
        ws_accept_key_into(&ws_key, &mut ws_out).unwrap() as u64
    });

    // ── SSE (write-into-buffer core) ──
    let mut sse_out = [0u8; 512];
    bench("sse_encode", 200_000, || {
        encode_event_into_slice(
            Some("update"),
            &ws_payload,
            Some("42"),
            Some(3000),
            &mut sse_out,
        )
        .unwrap() as u64
    });

    // ── Media type parse (allocating core — the reference for the napi-object
    // vs JS-baseline loss; shows the parse itself is not the bottleneck). ──
    bench("media_type_parse", 200_000, || {
        let parsed = castrum::http::media_type::parse_media_type_core(&content_type).unwrap();
        parsed.ty.len() as u64 + parsed.subtype.len() as u64
    });

    // ── HMAC (compiled key) ──
    bench("hmac_sha256", 200_000, || {
        let tag = hmac::sign(&hmac_key_compiled, &hmac_data);
        hex_encode_into_slice(tag.as_ref(), &mut hmac_tag_out).unwrap() as u64
    });
    bench("hmac_sha256_verify", 200_000, || {
        hex_decode_into_slice(&hmac_sig, &mut sig_bytes).unwrap();
        u64::from(hmac::verify(&hmac_key_compiled, &hmac_data, &sig_bytes).is_ok())
    });

    // ── Cookies / CSRF ──
    bench("sign_cookie", 300_000, || {
        castrum::crypto::cookie_sign::sign_cookie_into(
            &cookie_value,
            &cookie_key,
            &mut cookie_sig_out,
        )
        .unwrap_or(0) as u64
    });
    bench("verify_cookie", 300_000, || {
        castrum::crypto::cookie_sign::verify_cookie_into(
            &cookie_sig_out[..signed_cookie_len],
            &cookie_key,
            &mut cookie_val_out,
        )
        .unwrap_or(0) as u64
    });
    bench("csrf_token", 300_000, || {
        let mut rnd = [0u8; 32];
        getrandom::fill(&mut rnd).unwrap();
        let mut rnd_hex = [0u8; 64];
        castrum::util::bytes::hex_encode(&rnd, &mut rnd_hex);
        let mut sig_hex = [0u8; 64];
        castrum::util::bytes::hex_encode(hmac::sign(&csrf_key, &rnd_hex).as_ref(), &mut sig_hex);
        csrf_out[..64].copy_from_slice(&rnd_hex);
        csrf_out[64] = b'.';
        csrf_out[65..129].copy_from_slice(&sig_hex);
        129
    });
    bench("csrf_verify", 300_000, || {
        u64::from(castrum::crypto::csrf::csrf_verify_with_key(
            &csrf_token_bytes,
            &csrf_key,
        ))
    });

    // ── Password KDFs (work-bound; low iterations) ──
    bench("password_hash", 50, || {
        castrum::crypto::argon2::hash_password(&password, &password_salt, 8, 1, 1, 16)
            .unwrap()
            .len() as u64
    });
    bench("password_verify", 50, || {
        u64::from(castrum::crypto::argon2::verify_password(
            &password, &argon_phc,
        ))
    });
    bench("password_hash_bcrypt", 3, || {
        bcrypt::hash(&password, castrum::crypto::bcrypt::clamp_cost(4))
            .unwrap()
            .len() as u64
    });
    bench("password_verify_bcrypt", 3, || {
        u64::from(
            bcrypt::verify(&password, std::str::from_utf8(&bcrypt_phc).unwrap()).unwrap_or(false),
        )
    });

    // ── PBKDF2 ──
    bench("pbkdf2_sha256", 200, || {
        pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&pbkdf2_pw, &pbkdf2_salt, 1, &mut pbkdf2_out);
        pbkdf2_out.len() as u64
    });

    // ── AEAD ──
    bench("aead_encrypt", 200_000, || {
        castrum::crypto::aead::encrypt(&AES_256_GCM, &aead_key, &aead_nonce, &aead_pt)
            .unwrap()
            .len() as u64
    });
    bench("aead_decrypt", 200_000, || {
        castrum::crypto::aead::decrypt(&AES_256_GCM, &aead_key, &aead_nonce, &aead_ct)
            .unwrap()
            .len() as u64
    });

    // ── WebSocket frames ──
    bench("ws_frame_encode", 300_000, || {
        castrum::payload::ws_frames::encode_frame_into(
            1,
            &ws_payload,
            false,
            true,
            &mut ws_frame_out,
        )
        .unwrap() as u64
    });
    bench("ws_frame_decode", 300_000, || {
        let frame = castrum::payload::ws_frames::decode_frame(&ws_frame_out[..ws_frame]).unwrap();
        frame.payload.len() as u64
    });

    // ── JSON patch ──
    bench("json_patch", 200_000, || {
        castrum::json::patch::apply_json_patch_bytes(&json_doc, &json_patch_data)
            .unwrap()
            .len() as u64
    });

    // ── Random token (getrandom + hex) ──
    bench("random_token", 200_000, || {
        let mut rnd = vec![0u8; 16];
        getrandom::fill(&mut rnd).unwrap();
        castrum::util::bytes::hex_encode(&rnd, &mut random_out);
        32
    });

    // ── Packed parsers ──
    bench("http_parse_packed", 200_000, || {
        http_parse_request_packed_into_slice(&http, &mut http_out).unwrap() as u64
    });
    bench("query_parse_packed", 200_000, || {
        query_parse_packed_into_slice(&query, &mut query_out).unwrap() as u64
    });
    bench("cookie_parse_packed", 200_000, || {
        cookie_parse_packed_into_slice(&cookie, &mut cookie_out).unwrap() as u64
    });
    bench("form_parse_packed", 200_000, || {
        query_parse_packed_into_slice(&query, &mut query_out).unwrap() as u64
    });
    bench("multipart_parse_packed", 100_000, || {
        let parts = castrum::http::multipart::parse_multipart_limited(
            &multipart_body,
            &multipart_boundary,
            &Default::default(),
        );
        let mut buf = Vec::new();
        castrum::http::multipart::parts_to_packed(&parts, &mut buf);
        buf.len() as u64
    });

    // ── JWT sign (bytes) ──
    bench("jwt_sign_bytes", 200_000, || {
        let mut value: serde_json::Value = serde_json::from_slice(&jwt_claims).unwrap();
        let payload_b64 =
            castrum::crypto::jwt::inject_and_payload_b64(&mut value, None, 0).unwrap();
        castrum::crypto::jwt::build_token(
            castrum::crypto::jwt::jwt_header_b64(),
            &payload_b64,
            &jwt_secret,
        )
        .len() as u64
    });

    // ── Compression (write-into-buffer cores) ──
    bench("gzip_compress", 20_000, || {
        gzip_compress_into(&compress, 6, &mut gz_out).unwrap() as u64
    });
    bench("brotli_compress", 20_000, || {
        brotli_compress_into(&compress, 5, &mut br_out).unwrap() as u64
    });
    if !gzip_compressed.is_empty() && !brotli_compressed.is_empty() {
        bench("gzip_decompress", 20_000, || {
            gzip_decompress_into(&gzip_compressed, 1024 * 1024, &mut gz_d_out).unwrap() as u64
        });
        bench("brotli_decompress", 20_000, || {
            brotli_decompress_into(&brotli_compressed, 1024 * 1024, &mut br_d_out).unwrap() as u64
        });
    }
}
