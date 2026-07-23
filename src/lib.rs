#![allow(clippy::not_unsafe_ptr_arg_deref)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::Hasher as _;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::str::FromStr;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cookie::Cookie;
use crc32fast::Hasher as Crc32Hasher;
use email_address::EmailAddress;
use fnv::FnvHasher;
use hmac::{Hmac, Mac};
use httparse::{Request as HttpRequest, EMPTY_HEADER, Status as HttpStatus};
use matchit::Router;
use percent_encoding::{AsciiSet, CONTROLS};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use uuid::Uuid;

fn input_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len) }
    }
}

fn output_bytes<'a>(ptr: *mut u8, cap: usize) -> &'a mut [u8] {
    if ptr.is_null() || cap == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(ptr, cap) }
    }
}

fn write_response(out: &mut [u8], data: &[u8]) -> i64 {
    if data.len() > out.len() {
        return -2;
    }
    out[..data.len()].copy_from_slice(data);
    data.len() as i64
}

#[derive(Deserialize)]
struct IdRow {
    id: i64,
}

#[no_mangle]
pub extern "C" fn rust_json_valid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<sonic_rs::Value>(input) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_json_sum_ids_v2(ptr: *const u8, len: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<Vec<IdRow>>(input) {
            Ok(rows) => rows
                .into_iter()
                .fold(0i64, |acc, row| acc.saturating_add(row.id)),
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_http_parse_request_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let mut headers = [EMPTY_HEADER; 100];
        let mut req = HttpRequest::new(&mut headers);

        match req.parse(input) {
            Ok(HttpStatus::Complete(_)) => {
                let mut header_map = Map::new();

                for header in req.headers.iter() {
                    let name = header.name.to_lowercase();
                    let value = String::from_utf8_lossy(header.value).into_owned();

                    match header_map.get_mut(&name) {
                        Some(Value::Array(arr)) => arr.push(Value::String(value)),
                        Some(existing) => {
                            let first = existing.clone();
                            *existing = Value::Array(vec![first, Value::String(value)]);
                        }
                        None => {
                            header_map.insert(name, Value::String(value));
                        }
                    }
                }

                let version = match req.version {
                    Some(1) => "HTTP/1.1",
                    Some(0) => "HTTP/1.0",
                    Some(2) => "HTTP/2.0",
                    _ => "",
                };

                let result = json!({
                    "method": req.method.unwrap_or(""),
                    "path": req.path.unwrap_or(""),
                    "version": version,
                    "headers": header_map,
                });

                let serialized = serde_json::to_vec(&result).unwrap_or_default();
                write_response(out, &serialized)
            }
            _ => -1,
        }
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_query_parse_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let mut params = Map::new();

        for (key, value) in form_urlencoded::parse(input) {
            let key = key.into_owned();
            let value = Value::String(value.into_owned());

            match params.get_mut(&key) {
                Some(Value::Array(arr)) => arr.push(value),
                Some(existing) => {
                    let first = existing.clone();
                    *existing = Value::Array(vec![first, value]);
                }
                None => {
                    params.insert(key, value);
                }
            }
        }

        let result = Value::Object(params);
        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_cookie_parse_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let mut cookies = Map::new();

        for pair in text.split(';') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }

            if let Ok(cookie) = Cookie::parse(pair) {
                cookies.insert(
                    cookie.name().to_string(),
                    Value::String(cookie.value().to_string()),
                );
            }
        }

        let result = Value::Object(cookies);
        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_random_token_v2(byte_len: u32, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);
        let mut token = vec![0u8; byte_len as usize];

        if getrandom::fill(&mut token).is_err() {
            return -1;
        }

        let hex = hex::encode(token);
        write_response(out, hex.as_bytes())
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_ws_accept_key_v2(
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
        let combined = format!("{}{}", key, magic);

        let mut hasher = Sha1::new();
        hasher.update(combined.as_bytes());
        let hash = hasher.finalize();

        let encoded = BASE64.encode(hash);
        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_json_patch_v2(
    doc_ptr: *const u8,
    doc_len: usize,
    patch_ptr: *const u8,
    patch_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let doc_input = input_bytes(doc_ptr, doc_len);
        let patch_input = input_bytes(patch_ptr, patch_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut doc: Value = match serde_json::from_slice(doc_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let patch: json_patch::Patch = match serde_json::from_slice(patch_input) {
            Ok(p) => p,
            Err(_) => return -1,
        };

        if json_patch::patch(&mut doc, &patch).is_err() {
            return -1;
        }

        let result = serde_json::to_vec(&doc).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_hmac_sha256_v2(
    key_ptr: *const u8,
    key_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let key = input_bytes(key_ptr, key_len);
        let data = input_bytes(data_ptr, data_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data);
        let result = mac.finalize().into_bytes();

        let hex = hex::encode(result);
        write_response(out, hex.as_bytes())
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_hmac_sha256_verify_v2(
    key_ptr: *const u8,
    key_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    sig_ptr: *const u8,
    sig_len: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let key = input_bytes(key_ptr, key_len);
        let data = input_bytes(data_ptr, data_len);
        let sig = input_bytes(sig_ptr, sig_len);

        let sig_bytes = match hex::decode(sig) {
            Ok(v) => v,
            Err(_) => return 0,
        };

        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data);

        if mac.verify_slice(&sig_bytes).is_ok() {
            1
        } else {
            0
        }
    }))
    .unwrap_or(0)
}

thread_local! {
    static ROUTER_CACHE_V2: RefCell<HashMap<String, Router<u8>>> =
        RefCell::new(HashMap::new());
}

#[no_mangle]
pub extern "C" fn rust_route_match_v2(
    pattern_ptr: *const u8,
    pattern_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let pattern = String::from_utf8_lossy(input_bytes(pattern_ptr, pattern_len)).into_owned();
        let path = String::from_utf8_lossy(input_bytes(path_ptr, path_len)).into_owned();
        let out = output_bytes(out_ptr, out_cap);

        let mut insert_pattern = pattern.clone();

        if insert_pattern == "*" {
            insert_pattern = "/*wildcard".to_string();
        } else if insert_pattern.ends_with("/*") {
            insert_pattern.push_str("wildcard");
        } else if insert_pattern.ends_with('*') && !insert_pattern.ends_with("/*") {
            insert_pattern.pop();
            insert_pattern.push_str("*wildcard");
        }

        let matchit_result: Result<Map<String, Value>, ()> = ROUTER_CACHE_V2.with(|cache| {
            let mut cache = cache.borrow_mut();

            if !cache.contains_key(&insert_pattern) {
                let mut router: Router<u8> = Router::new();

                let route: &'static str = Box::leak(insert_pattern.clone().into_boxed_str());

                if router.insert(route, 0u8).is_err() {
                    return Err(());
                }

                cache.insert(insert_pattern.clone(), router);
            }

            let router = cache.get(&insert_pattern).unwrap();

            match router.at(&path) {
                Ok(matched) => {
                    let mut params = Map::new();

                    for (key, value) in matched.params.iter() {
                        let out_key = if key == "wildcard" { "*" } else { key };
                        params.insert(out_key.to_string(), Value::String(value.to_string()));
                    }

                    Ok(params)
                }
                Err(_) => Err(()),
            }
        });

        match matchit_result {
            Ok(params) => {
                let result = Value::Object(params);
                let serialized = serde_json::to_vec(&result).unwrap_or_default();
                write_response(out, &serialized)
            }
            Err(_) => manual_route_match_v2(&pattern, &path, out),
        }
    }))
    .unwrap_or(-1)
}

fn manual_route_match_v2(pattern: &str, path: &str, out: &mut [u8]) -> i64 {
    let pattern_segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    if pattern_segments.len() != path_segments.len() {
        if !pattern_segments.last().map(|s| *s == "*").unwrap_or(false) {
            return -1;
        }
    }

    let mut params = Map::new();

    for (i, pat_seg) in pattern_segments.iter().enumerate() {
        if *pat_seg == "*" {
            let rest: Vec<&str> = path_segments[i..].to_vec();
            params.insert("*".to_string(), Value::String(rest.join("/")));
            break;
        }

        if i >= path_segments.len() {
            return -1;
        }

        if let Some(param_name) = pat_seg.strip_prefix(':') {
            params.insert(
                param_name.to_string(),
                Value::String(path_segments[i].to_string()),
            );
        } else if pat_seg != &path_segments[i] {
            return -1;
        }
    }

    let result = Value::Object(params);
    let serialized = serde_json::to_vec(&result).unwrap_or_default();
    write_response(out, &serialized)
}

#[no_mangle]
pub extern "C" fn rust_validate_email_v2(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let email = String::from_utf8_lossy(input);

        if EmailAddress::is_valid(&email) {
            1
        } else {
            0
        }
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_validate_uuid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match Uuid::parse_str(&text) {
            Ok(u) => {
                if u.get_version_num() == 4 && matches!(u.get_variant(), uuid::Variant::RFC4122) {
                    1
                } else {
                    0
                }
            }
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv4_v2(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv4Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv6_v2(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv6Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_crc32_v2(ptr: *const u8, len: usize) -> u32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let mut hasher = Crc32Hasher::new();
        hasher.update(input);
        hasher.finalize()
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_fnv1a64_v2(ptr: *const u8, len: usize) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let mut hasher = FnvHasher::default();
        hasher.write(input);
        hasher.finish()
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_mime_from_extension_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let ext = String::from_utf8_lossy(input).to_lowercase();
        let ext = ext.trim_start_matches('.').to_string();

        let mime = mime_guess::from_ext(&ext).first_or_octet_stream();
        let result = mime.essence_str().to_string();

        write_response(out, result.as_bytes())
    }))
    .unwrap_or(-1)
}

const ENCODE_URI_COMPONENT_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[no_mangle]
pub extern "C" fn rust_url_encode_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let encoded =
            percent_encoding::utf8_percent_encode(&text, ENCODE_URI_COMPONENT_SET).to_string();

        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_url_decode_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        match percent_encoding::percent_decode(input).decode_utf8() {
            Ok(decoded) => write_response(out, decoded.as_bytes()),
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}
