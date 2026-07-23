#![allow(clippy::not_unsafe_ptr_arg_deref)]
use std::cell::RefCell;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use flate2::read::{GzDecoder, GzEncoder};
use flate2::Compression;
use hmac::{Hmac, Mac};
use memchr::memmem;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use url::Url;
use xxhash_rust::xxh64::xxh64;
use cookie::Cookie;
use crc32fast::Hasher as Crc32Hasher;
use email_address::EmailAddress;
use fnv::FnvHasher;
use httparse::{Request as HttpRequest, EMPTY_HEADER, Status as HttpStatus};
use matchit::Router;
use percent_encoding::{AsciiSet, CONTROLS};
use sha1::Sha1;
use std::hash::Hasher as _;
use std::str::FromStr;
// ---------------------------------------------------------------------------
// FFI helpers
// ---------------------------------------------------------------------------

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

fn set_status(status_ptr: *mut u16, status: u16) {
    if !status_ptr.is_null() {
        unsafe {
            *status_ptr = status;
        }
    }
}

// ===========================================================================
// SECTION 1: JSON / SERIALIZATION
// ===========================================================================

#[derive(Deserialize)]
struct IdRow {
    id: i64,
}

#[no_mangle]
pub extern "C" fn rust_json_sum_ids(ptr: *const u8, len: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        match serde_json::from_slice::<Vec<IdRow>>(input) {
            Ok(rows) => rows
                .into_iter()
                .fold(0i64, |acc, r| acc.saturating_add(r.id)),
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_json_valid(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        match serde_json::from_slice::<Value>(input) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    }))
    .unwrap_or(0)
}

/// Extract a single field from JSON by key path (dot-separated).
/// Returns the serialized value or empty.
#[no_mangle]
pub extern "C" fn rust_json_extract(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key_bytes = input_bytes(key_ptr, key_len);
        let out = output_bytes(out_ptr, out_cap);

        let key = String::from_utf8_lossy(key_bytes);
        let value: Value = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut current = &value;
        for segment in key.split('.') {
            match current {
                Value::Object(map) => match map.get(segment) {
                    Some(v) => current = v,
                    None => return -1,
                },
                Value::Array(arr) => match segment.parse::<usize>() {
                    Ok(idx) => match arr.get(idx) {
                        Some(v) => current = v,
                        None => return -1,
                    },
                    Err(_) => return -1,
                },
                _ => return -1,
            }
        }

        let serialized = serde_json::to_vec(current).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Flatten nested JSON into dot-notation key-value pairs.
#[no_mangle]
pub extern "C" fn rust_json_flatten(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let value: Value = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut flat = HashMap::new();
        flatten_value(&value, String::new(), &mut flat);

        let result = serde_json::to_vec(&flat).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

fn flatten_value(value: &Value, prefix: String, out: &mut HashMap<String, Value>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let new_key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                flatten_value(v, new_key, out);
            }
        }
        Value::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                let new_key = format!("{}.{}", prefix, i);
                flatten_value(v, new_key, out);
            }
        }
        _ => {
            out.insert(prefix, value.clone());
        }
    }
}

/// Merge two JSON objects (shallow merge, second overrides first).
#[no_mangle]
pub extern "C" fn rust_json_merge(
    ptr1: *const u8,
    len1: usize,
    ptr2: *const u8,
    len2: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input1 = input_bytes(ptr1, len1);
        let input2 = input_bytes(ptr2, len2);
        let out = output_bytes(out_ptr, out_cap);

        let mut v1: Value = match serde_json::from_slice(input1) {
            Ok(v) => v,
            Err(_) => return -1,
        };
        let v2: Value = match serde_json::from_slice(input2) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        if let (Value::Object(ref mut m1), Value::Object(m2)) = (&mut v1, &v2) {
            for (k, v) in m2 {
                m1.insert(k.clone(), v.clone());
            }
        }

        let result = serde_json::to_vec(&v1).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

/// JSON Patch (RFC 6902) - apply operations array.
#[no_mangle]
pub extern "C" fn rust_json_patch(
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

        let ops: Vec<Value> = match serde_json::from_slice(patch_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        for op in &ops {
            let op_type = op.get("op").and_then(|v| v.as_str()).unwrap_or("");
            let path = op.get("path").and_then(|v| v.as_str()).unwrap_or("");

            match op_type {
                "replace" | "add" => {
                    if let Some(value) = op.get("value") {
                        set_json_pointer(&mut doc, path, value.clone());
                    }
                }
                "remove" => {
                    remove_json_pointer(&mut doc, path);
                }
                _ => {}
            }
        }

        let result = serde_json::to_vec(&doc).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

fn set_json_pointer(doc: &mut Value, path: &str, value: Value) {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let mut current = doc;

    for (i, seg) in segments.iter().enumerate() {
        if i == segments.len() - 1 {
            match current {
                Value::Object(map) => {
                    map.insert(seg.to_string(), value);
                }
                Value::Array(arr) => {
                    if let Ok(idx) = seg.parse::<usize>() {
                        if idx < arr.len() {
                            arr[idx] = value;
                        }
                    }
                }
                _ => {}
            }
            return;
        }

        current = match current {
            Value::Object(map) => map.entry(seg.to_string()).or_insert(Value::Null),
            Value::Array(arr) => {
                if let Ok(idx) = seg.parse::<usize>() {
                    if idx < arr.len() {
                        &mut arr[idx]
                    } else {
                        return;
                    }
                } else {
                    return;
                }
            }
            _ => return,
        };
    }
}

fn remove_json_pointer(doc: &mut Value, path: &str) {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let mut current = doc;

    for (i, seg) in segments.iter().enumerate() {
        if i == segments.len() - 1 {
            match current {
                Value::Object(map) => {
                    map.remove(*seg);
                }
                Value::Array(arr) => {
                    if let Ok(idx) = seg.parse::<usize>() {
                        if idx < arr.len() {
                            arr.remove(idx);
                        }
                    }
                }
                _ => {}
            }
            return;
        }

        current = match current {
            Value::Object(map) => match map.get_mut(*seg) {
                Some(v) => v,
                None => return,
            },
            Value::Array(arr) => {
                if let Ok(idx) = seg.parse::<usize>() {
                    if idx < arr.len() {
                        &mut arr[idx]
                    } else {
                        return;
                    }
                } else {
                    return;
                }
            }
            _ => return,
        };
    }
}

// ===========================================================================
// SECTION 2: HTTP PARSING
// ===========================================================================

/// Parse raw HTTP/1.1 request line + headers. Returns JSON with method, path, version, headers.
#[no_mangle]
pub extern "C" fn rust_http_parse_request(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = match std::str::from_utf8(input) {
            Ok(t) => t,
            Err(_) => return -1,
        };

        let mut lines = text.split("\r\n");

        let request_line = lines.next().unwrap_or("");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        let version = parts.next().unwrap_or("");

        let mut headers = serde_json::Map::new();
        for line in lines {
            if line.is_empty() {
                break;
            }
            if let Some(colon_pos) = line.find(':') {
                let key = line[..colon_pos].trim().to_lowercase();
                let val = line[colon_pos + 1..].trim().to_string();
                headers.insert(key, Value::String(val));
            }
        }

        let result = json!({
            "method": method,
            "path": path,
            "version": version,
            "headers": headers,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Parse query string into JSON object.
#[no_mangle]
pub extern "C" fn rust_query_parse(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let query = String::from_utf8_lossy(input);
        let mut params = serde_json::Map::new();

        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (key, value) = match pair.find('=') {
                Some(pos) => (&pair[..pos], &pair[pos + 1..]),
                None => (pair, ""),
            };

            let decoded_key = percent_decode(key);
            let decoded_value = percent_decode(value);

            // Support array syntax: key[]=v1&key[]=v2
            if decoded_key.ends_with("[]") {
                let arr_key = decoded_key.trim_end_matches("[]").to_string();
                let entry = params.entry(arr_key).or_insert(Value::Array(vec![]));
                if let Value::Array(arr) = entry {
                    arr.push(Value::String(decoded_value));
                }
            } else {
                params.insert(decoded_key, Value::String(decoded_value));
            }
        }

        let result = Value::Object(params);
        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

fn percent_decode(input: &str) -> String {
    percent_encoding::percent_decode_str(input)
        .decode_utf8_lossy()
        .into_owned()
}

/// Parse cookies from a Cookie header value.
#[no_mangle]
pub extern "C" fn rust_cookie_parse(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let mut cookies = serde_json::Map::new();

        for pair in text.split(';') {
            let pair = pair.trim();
            if let Some(eq_pos) = pair.find('=') {
                let name = pair[..eq_pos].trim().to_string();
                let value = pair[eq_pos + 1..].trim().to_string();
                cookies.insert(name, Value::String(value));
            }
        }

        let result = Value::Object(cookies);
        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Serialize a Set-Cookie header from components.
#[no_mangle]
pub extern "C" fn rust_cookie_serialize(
    name_ptr: *const u8,
    name_len: usize,
    value_ptr: *const u8,
    value_len: usize,
    max_age: i64,
    secure: u8,
    http_only: u8,
    same_site: u8, // 0=None, 1=Lax, 2=Strict
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let name = String::from_utf8_lossy(input_bytes(name_ptr, name_len));
        let value = String::from_utf8_lossy(input_bytes(value_ptr, value_len));
        let out = output_bytes(out_ptr, out_cap);

        let mut cookie = format!("{}={}", name, value);

        if max_age >= 0 {
            cookie.push_str(&format!("; Max-Age={}", max_age));
        }
        if secure != 0 {
            cookie.push_str("; Secure");
        }
        if http_only != 0 {
            cookie.push_str("; HttpOnly");
        }
        let ss = match same_site {
            1 => "Lax",
            2 => "Strict",
            _ => "None",
        };
        cookie.push_str(&format!("; SameSite={}", ss));
        cookie.push_str("; Path=/");

        write_response(out, cookie.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Parse multipart/form-data body. Returns JSON array of {name, filename, content_type, size}.
#[no_mangle]
pub extern "C" fn rust_multipart_parse(
    ptr: *const u8,
    len: usize,
    boundary_ptr: *const u8,
    boundary_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let boundary = String::from_utf8_lossy(input_bytes(boundary_ptr, boundary_len));
        let out = output_bytes(out_ptr, out_cap);

        let delimiter = format!("--{}", boundary);
        let delimiter_bytes = delimiter.as_bytes();

        let mut parts = Vec::new();
        let mut pos = 0;

        while pos < input.len() {
            // Find next boundary
            let start = match memmem::find(&input[pos..], delimiter_bytes) {
                Some(offset) => pos + offset + delimiter_bytes.len(),
                None => break,
            };

            if start + 2 > input.len() {
                break;
            }

            // Check for closing --
            if input[start] == b'-' && input[start + 1] == b'-' {
                break;
            }

            // Skip \r\n after boundary
            let header_start =
                if start + 2 <= input.len() && input[start] == b'\r' && input[start + 1] == b'\n' {
                    start + 2
                } else {
                    start
                };

            // Find end of headers (\r\n\r\n)
            let header_end = match memmem::find(&input[header_start..], b"\r\n\r\n") {
                Some(offset) => header_start + offset,
                None => break,
            };

            let headers_text = String::from_utf8_lossy(&input[header_start..header_end]);
            let body_start = header_end + 4;

            // Find next boundary for body end
            let body_end = match memmem::find(&input[body_start..], delimiter_bytes) {
                Some(offset) => body_start + offset - 2, // subtract \r\n before boundary
                None => input.len(),
            };

            let body_size = body_end.saturating_sub(body_start);

            // Parse Content-Disposition
            let mut name = String::new();
            let mut filename = String::new();
            let mut content_type = String::new();

            for line in headers_text.split("\r\n") {
                let lower = line.to_lowercase();
                if lower.starts_with("content-disposition:") {
                    if let Some(n) = extract_quoted(line, "name") {
                        name = n;
                    }
                    if let Some(f) = extract_quoted(line, "filename") {
                        filename = f;
                    }
                } else if lower.starts_with("content-type:") {
                    content_type = line.split(':').nth(1).unwrap_or("").trim().to_string();
                }
            }

            parts.push(json!({
                "name": name,
                "filename": filename,
                "content_type": content_type,
                "size": body_size,
            }));

            pos = body_end + 2;
        }

        let result = serde_json::to_vec(&parts).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

fn extract_quoted(line: &str, key: &str) -> Option<String> {
    let pattern = format!("{}=\"", key);
    let start = line.find(&pattern)? + pattern.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// URL-encode a string.
#[no_mangle]
pub extern "C" fn rust_url_encode(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let encoded: String =
            percent_encoding::utf8_percent_encode(&text, percent_encoding::NON_ALPHANUMERIC)
                .to_string();

        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

/// URL-decode a string.
#[no_mangle]
pub extern "C" fn rust_url_decode(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let decoded = percent_decode(&text);

        write_response(out, decoded.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 3: ROUTING
// ===========================================================================

/// Match a path against a pattern with :params. Returns extracted params as JSON.
/// Pattern: "/users/:id/posts/:postId"
/// Path: "/users/42/posts/7"
/// Result: {"id": "42", "postId": "7"}
#[no_mangle]
pub extern "C" fn rust_route_match(
    pattern_ptr: *const u8,
    pattern_len: usize,
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let pattern = String::from_utf8_lossy(input_bytes(pattern_ptr, pattern_len));
        let path = String::from_utf8_lossy(input_bytes(path_ptr, path_len));
        let out = output_bytes(out_ptr, out_cap);

        let pattern_segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
        let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

        if pattern_segments.len() != path_segments.len() {
            // Check for wildcard
            if !pattern_segments.last().map(|s| *s == "*").unwrap_or(false) {
                return -1;
            }
        }

        let mut params = serde_json::Map::new();

        for (i, pat_seg) in pattern_segments.iter().enumerate() {
            if *pat_seg == "*" {
                // Wildcard captures rest
                let rest: Vec<&str> = path_segments[i..].to_vec();
                params.insert("*".to_string(), Value::String(rest.join("/")));
                break;
            }

            if i >= path_segments.len() {
                return -1;
            }

            if pat_seg.starts_with(':') {
                let param_name = &pat_seg[1..];
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
    }))
    .unwrap_or(-1)
}

/// Build a URL path from a pattern and params JSON.
#[no_mangle]
pub extern "C" fn rust_route_build(
    pattern_ptr: *const u8,
    pattern_len: usize,
    params_ptr: *const u8,
    params_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let pattern = String::from_utf8_lossy(input_bytes(pattern_ptr, pattern_len));
        let params_input = input_bytes(params_ptr, params_len);
        let out = output_bytes(out_ptr, out_cap);

        let params: Value = match serde_json::from_slice(params_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut result = pattern.to_string();

        if let Value::Object(map) = &params {
            for (key, value) in map {
                let placeholder = format!(":{}", key);
                let replacement = match value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                result = result.replace(&placeholder, &replacement);
            }
        }

        write_response(out, result.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 4: VALIDATION
// ===========================================================================

/// Validate an email address (RFC 5322 simplified).
#[no_mangle]
pub extern "C" fn rust_validate_email(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let email = String::from_utf8_lossy(input);

        if email.len() < 3 || email.len() > 254 {
            return 0;
        }

        let parts: Vec<&str> = email.split('@').collect();
        if parts.len() != 2 {
            return 0;
        }

        let local = parts[0];
        let domain = parts[1];

        if local.is_empty() || local.len() > 64 || domain.is_empty() || domain.len() > 253 {
            return 0;
        }

        if !domain.contains('.') {
            return 0;
        }

        // Basic character checks
        let valid_local = local
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '+');

        let valid_domain = domain
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-');

        if valid_local && valid_domain {
            1
        } else {
            0
        }
    }))
    .unwrap_or(0)
}

/// Validate a UUID v4 string.
#[no_mangle]
pub extern "C" fn rust_validate_uuid(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        if text.len() != 36 {
            return 0;
        }

        let bytes = text.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                if b != b'-' {
                    return 0;
                }
            } else if !b.is_ascii_hexdigit() {
                return 0;
            }
        }

        // Check version nibble (position 14 should be '4')
        if bytes[14] != b'4' {
            return 0;
        }

        // Check variant (position 19 should be 8, 9, a, or b)
        match bytes[19] {
            b'8' | b'9' | b'a' | b'b' | b'A' | b'B' => 1,
            _ => 0,
        }
    }))
    .unwrap_or(0)
}

/// Validate an IPv4 address.
#[no_mangle]
pub extern "C" fn rust_validate_ipv4(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        let octets: Vec<&str> = text.split('.').collect();
        if octets.len() != 4 {
            return 0;
        }

        for octet in &octets {
            if octet.is_empty() || octet.len() > 3 {
                return 0;
            }
            match octet.parse::<u16>() {
                Ok(n) => {
                    if n > 255 {
                        return 0;
                    }
                    // No leading zeros
                    if octet.len() > 1 && octet.starts_with('0') {
                        return 0;
                    }
                }
                Err(_) => return 0,
            }
        }

        1
    }))
    .unwrap_or(0)
}

/// Validate an IPv6 address (simplified).
#[no_mangle]
pub extern "C" fn rust_validate_ipv6(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        // Handle ::
        let parts: Vec<&str> = text.split("::").collect();
        if parts.len() > 2 {
            return 0;
        }

        let mut total_groups = 0;

        for part in &parts {
            if part.is_empty() {
                continue;
            }
            let groups: Vec<&str> = part.split(':').collect();
            for group in &groups {
                if group.is_empty() || group.len() > 4 {
                    return 0;
                }
                if !group.chars().all(|c| c.is_ascii_hexdigit()) {
                    return 0;
                }
                total_groups += 1;
            }
        }

        if parts.len() == 2 {
            if total_groups > 7 {
                0
            } else {
                1
            }
        } else {
            if total_groups == 8 {
                1
            } else {
                0
            }
        }
    }))
    .unwrap_or(0)
}

/// Luhn algorithm for credit card validation.
#[no_mangle]
pub extern "C" fn rust_validate_luhn(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        let digits: Vec<u32> = text
            .chars()
            .filter(|c| c.is_ascii_digit())
            .map(|c| c as u32 - '0' as u32)
            .collect();

        if digits.len() < 13 || digits.len() > 19 {
            return 0;
        }

        let mut sum = 0u32;
        let mut alternate = false;

        for &digit in digits.iter().rev() {
            let mut d = digit;
            if alternate {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            sum += d;
            alternate = !alternate;
        }

        if sum % 10 == 0 {
            1
        } else {
            0
        }
    }))
    .unwrap_or(0)
}

/// Validate a JWT structure (3 base64url parts separated by dots).
#[no_mangle]
pub extern "C" fn rust_validate_jwt_structure(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        let parts: Vec<&str> = text.split('.').collect();
        if parts.len() != 3 {
            return 0;
        }

        for part in &parts {
            if part.is_empty() {
                return 0;
            }
            if !part
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '=')
            {
                return 0;
            }
        }

        1
    }))
    .unwrap_or(0)
}

// ===========================================================================
// SECTION 5: CRYPTOGRAPHY & SECURITY
// ===========================================================================

/// HMAC-SHA256 signature.
#[no_mangle]
pub extern "C" fn rust_hmac_sha256(
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

        // Output as hex string
        let hex: String = result.iter().map(|b| format!("{:02x}", b)).collect();
        write_response(out, hex.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Verify HMAC-SHA256 signature (constant-time comparison).
#[no_mangle]
pub extern "C" fn rust_hmac_sha256_verify(
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

        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data);
        let result = mac.finalize().into_bytes();

        let expected_hex: String = result.iter().map(|b| format!("{:02x}", b)).collect();
        let provided = String::from_utf8_lossy(sig);

        // Constant-time comparison
        if expected_hex.len() != provided.len() {
            return 0;
        }

        let mut diff = 0u8;
        for (a, b) in expected_hex.bytes().zip(provided.bytes()) {
            diff |= a ^ b;
        }

        if diff == 0 {
            1
        } else {
            0
        }
    }))
    .unwrap_or(0)
}

/// Base64 encode.
#[no_mangle]
pub extern "C" fn rust_base64_encode(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let encoded = BASE64.encode(input);
        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Base64 decode.
#[no_mangle]
pub extern "C" fn rust_base64_decode(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        match BASE64.decode(text.as_bytes()) {
            Ok(decoded) => write_response(out, &decoded),
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

/// Base64url encode (URL-safe, no padding).
#[no_mangle]
pub extern "C" fn rust_base64url_encode(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input);
        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Generate a random UUID v4.
#[no_mangle]
pub extern "C" fn rust_uuid_v4(out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);
        let id = uuid::Uuid::new_v4().to_string();
        write_response(out, id.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Generate a random token of specified byte length (hex-encoded output).
#[no_mangle]
pub extern "C" fn rust_random_token(byte_len: u32, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);

        // Simple PRNG for benchmark purposes (not cryptographically secure)
        let mut state: u64 = 0x12345678_9ABCDEF0;
        let mut token = Vec::with_capacity(byte_len as usize);

        for _ in 0..byte_len {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            token.push((state >> 33) as u8);
        }

        let hex: String = token.iter().map(|b| format!("{:02x}", b)).collect();
        write_response(out, hex.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 6: COMPRESSION
// ===========================================================================

/// Gzip compress.
#[no_mangle]
pub extern "C" fn rust_gzip_compress(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let mut encoder = GzEncoder::new(input, Compression::fast());
        let mut compressed = Vec::new();

        if encoder.read_to_end(&mut compressed).is_err() {
            return -1;
        }

        write_response(out, &compressed)
    }))
    .unwrap_or(-1)
}

/// Gzip decompress.
#[no_mangle]
pub extern "C" fn rust_gzip_decompress(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let mut decoder = GzDecoder::new(input);
        let mut decompressed = Vec::new();

        if decoder.read_to_end(&mut decompressed).is_err() {
            return -1;
        }

        write_response(out, &decompressed)
    }))
    .unwrap_or(-1)
}

/// Compute compression ratio for a given input.
#[no_mangle]
pub extern "C" fn rust_compression_ratio(ptr: *const u8, len: usize) -> f64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);

        if input.is_empty() {
            return 0.0;
        }

        let mut encoder = GzEncoder::new(input, Compression::fast());
        let mut compressed = Vec::new();

        if encoder.read_to_end(&mut compressed).is_err() {
            return 0.0;
        }

        compressed.len() as f64 / input.len() as f64
    }))
    .unwrap_or(0.0)
}

// ===========================================================================
// SECTION 7: STRING PROCESSING
// ===========================================================================

/// HTML escape a string.
#[no_mangle]
pub extern "C" fn rust_html_escape(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let mut escaped = String::with_capacity(text.len() + 16);

        for ch in text.chars() {
            match ch {
                '&' => escaped.push_str("&amp;"),
                '<' => escaped.push_str("&lt;"),
                '>' => escaped.push_str("&gt;"),
                '"' => escaped.push_str("&quot;"),
                '\'' => escaped.push_str("&#x27;"),
                '/' => escaped.push_str("&#x2F;"),
                _ => escaped.push(ch),
            }
        }

        write_response(out, escaped.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Generate a URL-friendly slug from a string.
#[no_mangle]
pub extern "C" fn rust_slugify(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input).to_lowercase();
        let mut slug = String::with_capacity(text.len());
        let mut last_was_dash = false;

        for ch in text.chars() {
            if ch.is_alphanumeric() {
                slug.push(ch);
                last_was_dash = false;
            } else if !last_was_dash && !slug.is_empty() {
                slug.push('-');
                last_was_dash = true;
            }
        }

        // Trim trailing dash
        if slug.ends_with('-') {
            slug.pop();
        }

        write_response(out, slug.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Simple template rendering: replace {{key}} with values from JSON.
#[no_mangle]
pub extern "C" fn rust_template_render(
    template_ptr: *const u8,
    template_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let template = String::from_utf8_lossy(input_bytes(template_ptr, template_len));
        let data_input = input_bytes(data_ptr, data_len);
        let out = output_bytes(out_ptr, out_cap);

        let data: Value = match serde_json::from_slice(data_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut result = template.to_string();

        if let Value::Object(map) = &data {
            for (key, value) in map {
                let placeholder = format!("{{{{{}}}}}", key);
                let replacement = match value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                result = result.replace(&placeholder, &replacement);
            }
        }

        write_response(out, result.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Regex match - returns 1 if pattern matches, 0 otherwise.
#[no_mangle]
pub extern "C" fn rust_regex_match(
    pattern_ptr: *const u8,
    pattern_len: usize,
    text_ptr: *const u8,
    text_len: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let pattern = String::from_utf8_lossy(input_bytes(pattern_ptr, pattern_len));
        let text = String::from_utf8_lossy(input_bytes(text_ptr, text_len));

        match Regex::new(&pattern) {
            Ok(re) => {
                if re.is_match(&text) {
                    1
                } else {
                    0
                }
            }
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

/// Regex replace all occurrences.
#[no_mangle]
pub extern "C" fn rust_regex_replace(
    pattern_ptr: *const u8,
    pattern_len: usize,
    replacement_ptr: *const u8,
    replacement_len: usize,
    text_ptr: *const u8,
    text_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let pattern = String::from_utf8_lossy(input_bytes(pattern_ptr, pattern_len));
        let replacement = String::from_utf8_lossy(input_bytes(replacement_ptr, replacement_len));
        let text = String::from_utf8_lossy(input_bytes(text_ptr, text_len));
        let out = output_bytes(out_ptr, out_cap);

        match Regex::new(&pattern) {
            Ok(re) => {
                let result = re.replace_all(&text, replacement.as_ref());
                write_response(out, result.as_bytes())
            }
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

/// Trim whitespace from both ends.
#[no_mangle]
pub extern "C" fn rust_trim(ptr: *const u8, len: usize, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let trimmed = text.trim();
        write_response(out, trimmed.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Case conversion: 0=lower, 1=upper, 2=title
#[no_mangle]
pub extern "C" fn rust_case_convert(
    ptr: *const u8,
    len: usize,
    mode: u8,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);

        let result = match mode {
            0 => text.to_lowercase(),
            1 => text.to_uppercase(),
            2 => {
                // Title case
                let mut result = String::with_capacity(text.len());
                let mut capitalize_next = true;
                for ch in text.chars() {
                    if ch.is_whitespace() || ch == '-' || ch == '_' {
                        result.push(ch);
                        capitalize_next = true;
                    } else if capitalize_next {
                        result.extend(ch.to_uppercase());
                        capitalize_next = false;
                    } else {
                        result.extend(ch.to_lowercase());
                    }
                }
                result
            }
            _ => text.to_string(),
        };

        write_response(out, result.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 8: DATA PROCESSING / COLLECTIONS
// ===========================================================================

/// Sort a JSON array of objects by a numeric field.
#[no_mangle]
pub extern "C" fn rust_json_sort_by(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    descending: u8,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let mut arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        arr.sort_by(|a, b| {
            let a_val = a.get(&*key).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let b_val = b.get(&*key).and_then(|v| v.as_f64()).unwrap_or(0.0);

            let cmp = a_val
                .partial_cmp(&b_val)
                .unwrap_or(std::cmp::Ordering::Equal);
            if descending != 0 {
                cmp.reverse()
            } else {
                cmp
            }
        });

        let result = serde_json::to_vec(&arr).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

/// Paginate a JSON array: returns {data: [...], total, page, per_page, total_pages}.
#[no_mangle]
pub extern "C" fn rust_json_paginate(
    ptr: *const u8,
    len: usize,
    page: u32,
    per_page: u32,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let total = arr.len() as u32;
        let total_pages = (total + per_page - 1) / per_page;
        let start = ((page.saturating_sub(1)) * per_page) as usize;
        let end = std::cmp::min(start + per_page as usize, arr.len());

        let data: Vec<Value> = if start < arr.len() {
            arr[start..end].to_vec()
        } else {
            vec![]
        };

        let result = json!({
            "data": data,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_pages": total_pages,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Filter a JSON array by a field value.
#[no_mangle]
pub extern "C" fn rust_json_filter(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    value_ptr: *const u8,
    value_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let filter_value = String::from_utf8_lossy(input_bytes(value_ptr, value_len));
        let out = output_bytes(out_ptr, out_cap);

        let arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let filtered: Vec<&Value> = arr
            .iter()
            .filter(|item| {
                item.get(&*key)
                    .map(|v| match v {
                        Value::String(s) => s == &filter_value.to_string(),
                        Value::Number(n) => n.to_string() == filter_value.to_string(),
                        Value::Bool(b) => b.to_string() == filter_value.to_string(),
                        _ => false,
                    })
                    .unwrap_or(false)
            })
            .collect();

        let result = serde_json::to_vec(&filtered).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

/// Aggregate: compute sum, avg, min, max, count for a numeric field.
#[no_mangle]
pub extern "C" fn rust_json_aggregate(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let values: Vec<f64> = arr
            .iter()
            .filter_map(|item| item.get(&*key).and_then(|v| v.as_f64()))
            .collect();

        if values.is_empty() {
            let result = json!({"count": 0, "sum": 0, "avg": 0, "min": 0, "max": 0});
            let serialized = serde_json::to_vec(&result).unwrap_or_default();
            return write_response(out, &serialized);
        }

        let count = values.len();
        let sum: f64 = values.iter().sum();
        let avg = sum / count as f64;
        let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        let result = json!({
            "count": count,
            "sum": sum,
            "avg": avg,
            "min": min,
            "max": max,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Group by a field, returns {field_value: [items...]}.
#[no_mangle]
pub extern "C" fn rust_json_group_by(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut groups: HashMap<String, Vec<Value>> = HashMap::new();

        for item in arr {
            let group_key = item
                .get(&*key)
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_else(|| "null".to_string());

            groups.entry(group_key).or_default().push(item);
        }

        let result = serde_json::to_vec(&groups).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

/// Deduplicate a JSON array by a field.
#[no_mangle]
pub extern "C" fn rust_json_dedup(
    ptr: *const u8,
    len: usize,
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let arr: Vec<Value> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut seen = std::collections::HashSet::new();
        let mut result: Vec<Value> = Vec::new();

        for item in arr {
            let dedup_key = item.get(&*key).map(|v| v.to_string()).unwrap_or_default();

            if seen.insert(dedup_key) {
                result.push(item);
            }
        }

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 9: CACHING & RATE LIMITING
// ===========================================================================

/// Token bucket rate limiter check.
/// Returns 1 if allowed, 0 if rate limited.
/// State is passed as bytes: [tokens: f64][last_refill_ms: u64]
#[no_mangle]
pub extern "C" fn rust_rate_limit_check(
    state_ptr: *mut u8,
    state_len: usize,
    capacity: f64,
    refill_rate: f64, // tokens per second
    now_ms: u64,
    cost: f64,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        if state_len < 16 {
            return 0;
        }

        let state = output_bytes(state_ptr, state_len);

        let tokens = f64::from_le_bytes(state[0..8].try_into().unwrap_or([0u8; 8]));
        let last_refill = u64::from_le_bytes(state[8..16].try_into().unwrap_or([0u8; 8]));

        let elapsed_secs = (now_ms.saturating_sub(last_refill)) as f64 / 1000.0;
        let new_tokens = (tokens + elapsed_secs * refill_rate).min(capacity);

        if new_tokens >= cost {
            let remaining = new_tokens - cost;
            state[0..8].copy_from_slice(&remaining.to_le_bytes());
            state[8..16].copy_from_slice(&now_ms.to_le_bytes());
            1
        } else {
            state[0..8].copy_from_slice(&new_tokens.to_le_bytes());
            state[8..16].copy_from_slice(&now_ms.to_le_bytes());
            0
        }
    }))
    .unwrap_or(0)
}

/// Compute an ETag for a response body (xxh3-based).
#[no_mangle]
pub extern "C" fn rust_etag_generate(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let hash = xxh64(input, 0);
        let etag = format!("\"{:016x}\"", hash);

        write_response(out, etag.as_bytes())
    }))
    .unwrap_or(-1)
}
/// Check If-None-Match header against an ETag. Returns 1 if match (304), 0 otherwise.
#[no_mangle]
pub extern "C" fn rust_etag_check(
    etag_ptr: *const u8,
    etag_len: usize,
    header_ptr: *const u8,
    header_len: usize,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let etag = String::from_utf8_lossy(input_bytes(etag_ptr, etag_len));
        let header = String::from_utf8_lossy(input_bytes(header_ptr, header_len));

        // Handle multiple ETags in If-None-Match
        for candidate in header.split(',') {
            let candidate = candidate.trim();
            if candidate == "*" || candidate == etag.trim() {
                return 1;
            }
        }

        0
    }))
    .unwrap_or(0)
}

// ===========================================================================
// SECTION 10: HTTP RESPONSE BUILDING
// ===========================================================================

/// Build a complete HTTP/1.1 response with headers.
#[no_mangle]
pub extern "C" fn rust_http_response_build(
    status: u16,
    body_ptr: *const u8,
    body_len: usize,
    content_type_ptr: *const u8,
    content_type_len: usize,
    extra_headers_ptr: *const u8,
    extra_headers_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let body = input_bytes(body_ptr, body_len);
        let content_type = String::from_utf8_lossy(input_bytes(content_type_ptr, content_type_len));
        let extra_headers =
            String::from_utf8_lossy(input_bytes(extra_headers_ptr, extra_headers_len));
        let out = output_bytes(out_ptr, out_cap);

        let status_text = match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            301 => "Moved Permanently",
            302 => "Found",
            304 => "Not Modified",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            409 => "Conflict",
            422 => "Unprocessable Entity",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            502 => "Bad Gateway",
            503 => "Service Unavailable",
            _ => "Unknown",
        };

        let mut response = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n",
            status,
            status_text,
            content_type,
            body.len()
        );

        if !extra_headers.is_empty() {
            response.push_str(&extra_headers);
            if !extra_headers.ends_with("\r\n") {
                response.push_str("\r\n");
            }
        }

        response.push_str("Connection: keep-alive\r\n\r\n");

        let header_bytes = response.as_bytes();
        let total_len = header_bytes.len() + body.len();

        if total_len > out.len() {
            return -2;
        }

        out[..header_bytes.len()].copy_from_slice(header_bytes);
        out[header_bytes.len()..total_len].copy_from_slice(body);

        total_len as i64
    }))
    .unwrap_or(-1)
}

/// Build a JSON error response.
#[no_mangle]
pub extern "C" fn rust_error_response(
    status: u16,
    message_ptr: *const u8,
    message_len: usize,
    code_ptr: *const u8,
    code_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let message = String::from_utf8_lossy(input_bytes(message_ptr, message_len));
        let code = String::from_utf8_lossy(input_bytes(code_ptr, code_len));
        let out = output_bytes(out_ptr, out_cap);

        let result = json!({
            "error": {
                "status": status,
                "code": code.to_string(),
                "message": message.to_string(),
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 11: CORS & SECURITY HEADERS
// ===========================================================================

/// Build CORS headers based on origin and allowed origins.
#[no_mangle]
pub extern "C" fn rust_cors_headers(
    origin_ptr: *const u8,
    origin_len: usize,
    allowed_ptr: *const u8,
    allowed_len: usize,
    methods_ptr: *const u8,
    methods_len: usize,
    max_age: u32,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let origin = String::from_utf8_lossy(input_bytes(origin_ptr, origin_len));
        let allowed = String::from_utf8_lossy(input_bytes(allowed_ptr, allowed_len));
        let methods = String::from_utf8_lossy(input_bytes(methods_ptr, methods_len));
        let out = output_bytes(out_ptr, out_cap);

        // Explicit &str bindings — avoids unstable str::as_str()
        let origin_str: &str = &origin;
        let methods_str: &str = &methods;

        let allowed_origins: Vec<&str> = allowed.split(',').map(|s| s.trim()).collect();

        let is_allowed = allowed_origins.contains(&"*") || allowed_origins.contains(&origin_str);

        if !is_allowed {
            return write_response(out, b"");
        }

        let headers = format!(
            "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: {}\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Max-Age: {}\r\n",
            if allowed_origins.contains(&"*") { "*" } else { origin_str },
            methods_str,
            max_age
        );

        write_response(out, headers.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Generate security headers (CSP, HSTS, etc.).
#[no_mangle]
pub extern "C" fn rust_security_headers(out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);

        let headers = concat!(
            "Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n",
            "X-Content-Type-Options: nosniff\r\n",
            "X-Frame-Options: DENY\r\n",
            "X-XSS-Protection: 1; mode=block\r\n",
            "Referrer-Policy: strict-origin-when-cross-origin\r\n",
            "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'\r\n",
        );

        write_response(out, headers.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 12: WEBSOCKET
// ===========================================================================

/// Parse a WebSocket frame header. Returns opcode, payload_length, mask info as JSON.
#[no_mangle]
pub extern "C" fn rust_ws_frame_parse(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        if input.len() < 2 {
            return -1;
        }

        let fin = (input[0] & 0x80) != 0;
        let opcode = input[0] & 0x0F;
        let masked = (input[1] & 0x80) != 0;
        let mut payload_len = (input[1] & 0x7F) as u64;
        let mut header_size = 2usize;

        if payload_len == 126 {
            if input.len() < 4 {
                return -1;
            }
            payload_len = u16::from_be_bytes([input[2], input[3]]) as u64;
            header_size = 4;
        } else if payload_len == 127 {
            if input.len() < 10 {
                return -1;
            }
            payload_len = u64::from_be_bytes([
                input[2], input[3], input[4], input[5], input[6], input[7], input[8], input[9],
            ]);
            header_size = 10;
        }

        if masked {
            header_size += 4;
        }

        let opcode_name = match opcode {
            0x0 => "continuation",
            0x1 => "text",
            0x2 => "binary",
            0x8 => "close",
            0x9 => "ping",
            0xA => "pong",
            _ => "unknown",
        };

        let result = json!({
            "fin": fin,
            "opcode": opcode,
            "opcode_name": opcode_name,
            "masked": masked,
            "payload_length": payload_len,
            "header_size": header_size,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Build a WebSocket frame (server-to-client, unmasked).
#[no_mangle]
pub extern "C" fn rust_ws_frame_build(
    opcode: u8,
    payload_ptr: *const u8,
    payload_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let payload = input_bytes(payload_ptr, payload_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut frame = Vec::with_capacity(payload_len + 10);

        // FIN + opcode
        frame.push(0x80 | (opcode & 0x0F));

        // Payload length (no mask for server frames)
        if payload_len < 126 {
            frame.push(payload_len as u8);
        } else if payload_len < 65536 {
            frame.push(126);
            frame.extend_from_slice(&(payload_len as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(payload_len as u64).to_be_bytes());
        }

        frame.extend_from_slice(payload);
        write_response(out, &frame)
    }))
    .unwrap_or(-1)
}

/// Compute WebSocket accept key from client key (SHA-1 + base64).
#[no_mangle]
pub extern "C" fn rust_ws_accept_key(
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

        // SHA-1 (manual implementation for this specific use case)
        let hash = sha1_hash(combined.as_bytes());
        let encoded = BASE64.encode(hash);

        write_response(out, encoded.as_bytes())
    }))
    .unwrap_or(-1)
}

fn sha1_hash(data: &[u8]) -> [u8; 20] {
    // Minimal SHA-1 implementation
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let mut msg = data.to_vec();
    let ml = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);

        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };

            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut result = [0u8; 20];
    result[0..4].copy_from_slice(&h0.to_be_bytes());
    result[4..8].copy_from_slice(&h1.to_be_bytes());
    result[8..12].copy_from_slice(&h2.to_be_bytes());
    result[12..16].copy_from_slice(&h3.to_be_bytes());
    result[16..20].copy_from_slice(&h4.to_be_bytes());
    result
}

// ===========================================================================
// SECTION 13: MIME & CONTENT NEGOTIATION
// ===========================================================================

/// Detect MIME type from file extension.
#[no_mangle]
pub extern "C" fn rust_mime_from_extension(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let ext = String::from_utf8_lossy(input).to_lowercase();
        let out = output_bytes(out_ptr, out_cap);

        let mime = match ext.as_str() {
            "html" | "htm" => "text/html; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "js" | "mjs" => "application/javascript; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "xml" => "application/xml; charset=utf-8",
            "txt" => "text/plain; charset=utf-8",
            "csv" => "text/csv; charset=utf-8",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "pdf" => "application/pdf",
            "zip" => "application/zip",
            "gz" | "gzip" => "application/gzip",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "wasm" => "application/wasm",
            "avif" => "image/avif",
            "yaml" | "yml" => "application/yaml",
            "toml" => "application/toml",
            "md" => "text/markdown; charset=utf-8",
            _ => "application/octet-stream",
        };

        write_response(out, mime.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Parse Accept header and return best match from available types.
#[no_mangle]
pub extern "C" fn rust_content_negotiate(
    accept_ptr: *const u8,
    accept_len: usize,
    available_ptr: *const u8,
    available_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let accept = String::from_utf8_lossy(input_bytes(accept_ptr, accept_len));
        let available = String::from_utf8_lossy(input_bytes(available_ptr, available_len));
        let out = output_bytes(out_ptr, out_cap);

        let available_types: Vec<&str> = available.split(',').map(|s| s.trim()).collect();

        let mut accept_types: Vec<(&str, f32)> = Vec::new();
        for part in accept.split(',') {
            let part = part.trim();
            let (media_type, quality) = if let Some(q_pos) = part.find(";q=") {
                let q: f32 = part[q_pos + 3..].parse().unwrap_or(1.0);
                (&part[..q_pos], q)
            } else {
                (part, 1.0)
            };
            accept_types.push((media_type, quality));
        }

        accept_types.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut best: Option<&str> = None;
        for (accept_type, _) in &accept_types {
            if *accept_type == "*/*" {
                best = available_types.first().copied();
                break;
            }
            for avail in &available_types {
                if avail == accept_type {
                    best = Some(avail);
                    break;
                }
                if let Some(accept_prefix) = accept_type.strip_suffix("/*") {
                    if avail.starts_with(accept_prefix) {
                        best = Some(avail);
                        break;
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }

        match best {
            Some(mime) => write_response(out, mime.as_bytes()),
            None => write_response(out, b""),
        }
    }))
    .unwrap_or(-1)
}
// ===========================================================================
// SECTION 14: LOGGING & OBSERVABILITY
// ===========================================================================

/// Format a structured log line (JSON).
#[no_mangle]
pub extern "C" fn rust_log_format(
    level_ptr: *const u8,
    level_len: usize,
    message_ptr: *const u8,
    message_len: usize,
    context_ptr: *const u8,
    context_len: usize,
    request_id_ptr: *const u8,
    request_id_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let level = String::from_utf8_lossy(input_bytes(level_ptr, level_len));
        let message = String::from_utf8_lossy(input_bytes(message_ptr, message_len));
        let context_input = input_bytes(context_ptr, context_len);
        let request_id = String::from_utf8_lossy(input_bytes(request_id_ptr, request_id_len));
        let out = output_bytes(out_ptr, out_cap);

        let context: Value = if context_input.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(context_input).unwrap_or(json!({}))
        };

        let log = json!({
            "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": level.to_string(),
            "message": message.to_string(),
            "request_id": request_id.to_string(),
            "context": context,
        });

        let mut serialized = serde_json::to_vec(&log).unwrap_or_default();
        serialized.push(b'\n');
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}

/// Compute request duration histogram bucket.
/// Returns bucket index for common latency buckets.
#[no_mangle]
pub extern "C" fn rust_histogram_bucket(duration_us: u64) -> u32 {
    // Buckets: 100us, 500us, 1ms, 5ms, 10ms, 50ms, 100ms, 500ms, 1s, 5s, 10s, +inf
    const BUCKETS: [u64; 11] = [
        100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
    ];

    for (i, &bucket) in BUCKETS.iter().enumerate() {
        if duration_us <= bucket {
            return i as u32;
        }
    }

    11 // +inf
}

/// Increment an atomic counter (simulated via pointer).
#[no_mangle]
pub extern "C" fn rust_counter_increment(counter_ptr: *mut u64) -> u64 {
    if counter_ptr.is_null() {
        return 0;
    }
    unsafe {
        *counter_ptr += 1;
        *counter_ptr
    }
}

// ===========================================================================
// SECTION 15: PATH & FILE UTILITIES
// ===========================================================================

/// Normalize a file path (resolve . and ..).
#[no_mangle]
pub extern "C" fn rust_path_normalize(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let path = String::from_utf8_lossy(input);
        let out = output_bytes(out_ptr, out_cap);

        let mut components: Vec<&str> = Vec::new();

        for component in path.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    components.pop();
                }
                other => components.push(other),
            }
        }

        let normalized = format!("/{}", components.join("/"));
        write_response(out, normalized.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Check if a path is safe (no directory traversal).
#[no_mangle]
pub extern "C" fn rust_path_is_safe(ptr: *const u8, len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let path = String::from_utf8_lossy(input);

        if path.contains("..") || path.contains('\0') {
            return 0;
        }

        // Check for absolute path escaping
        if path.starts_with('/') && path.contains("/../") {
            return 0;
        }

        1
    }))
    .unwrap_or(0)
}

/// Join path segments safely.
#[no_mangle]
pub extern "C" fn rust_path_join(
    base_ptr: *const u8,
    base_len: usize,
    segment_ptr: *const u8,
    segment_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let base = String::from_utf8_lossy(input_bytes(base_ptr, base_len));
        let segment = String::from_utf8_lossy(input_bytes(segment_ptr, segment_len));
        let out = output_bytes(out_ptr, out_cap);

        let base_trimmed = base.trim_end_matches('/');
        let segment_trimmed = segment.trim_start_matches('/');

        let joined = format!("{}/{}", base_trimmed, segment_trimmed);
        write_response(out, joined.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 16: SEARCH & INDEXING
// ===========================================================================

/// Binary search in a sorted JSON array of numbers. Returns index or -1.
#[no_mangle]
pub extern "C" fn rust_binary_search(ptr: *const u8, len: usize, target: f64) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);

        let arr: Vec<f64> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        match arr.binary_search_by(|probe| {
            probe
                .partial_cmp(&target)
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
            Ok(idx) => idx as i64,
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}

/// Simple full-text search: count occurrences of a term in text.
#[no_mangle]
pub extern "C" fn rust_text_search_count(
    text_ptr: *const u8,
    text_len: usize,
    term_ptr: *const u8,
    term_len: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let text = input_bytes(text_ptr, text_len);
        let term = input_bytes(term_ptr, term_len);

        if term.is_empty() {
            return 0;
        }

        let mut count = 0i64;
        let mut pos = 0;

        while let Some(found) = memmem::find(&text[pos..], term) {
            count += 1;
            pos += found + 1;
        }

        count
    }))
    .unwrap_or(-1)
}

/// Build a simple inverted index from JSON array of {id, text} objects.
/// Returns JSON: {term: [id1, id2, ...]}.
#[no_mangle]
pub extern "C" fn rust_inverted_index_build(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        #[derive(Deserialize)]
        struct Doc {
            id: String,
            text: String,
        }

        let docs: Vec<Doc> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        let mut index: HashMap<String, Vec<String>> = HashMap::new();

        for doc in &docs {
            for word in doc.text.split_whitespace() {
                let word = word.to_lowercase();
                let word: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
                if !word.is_empty() {
                    index.entry(word).or_default().push(doc.id.clone());
                }
            }
        }

        let result = serde_json::to_vec(&index).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 17: MATH & ENCODING UTILITIES
// ===========================================================================

/// Compute CRC32 checksum.
#[no_mangle]
pub extern "C" fn rust_crc32(ptr: *const u8, len: usize) -> u32 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);

        let mut crc: u32 = 0xFFFFFFFF;

        for &byte in input {
            crc ^= byte as u32;
            for _ in 0..8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xEDB88320;
                } else {
                    crc >>= 1;
                }
            }
        }

        !crc
    }))
    .unwrap_or(0)
}

/// Compute FNV-1a 64-bit hash.
#[no_mangle]
pub extern "C" fn rust_fnv1a_64(ptr: *const u8, len: usize) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);

        let mut hash: u64 = 0xcbf29ce484222325;

        for &byte in input {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }

        hash
    }))
    .unwrap_or(0)
}

/// Integer to string (fast path for common cases).
#[no_mangle]
pub extern "C" fn rust_itoa(value: i64, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);
        let s = value.to_string();
        write_response(out, s.as_bytes())
    }))
    .unwrap_or(-1)
}

/// Parse integer from string (fast path).
#[no_mangle]
pub extern "C" fn rust_atoi(ptr: *const u8, len: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);
        text.trim().parse::<i64>().unwrap_or(0)
    }))
    .unwrap_or(0)
}

/// Format bytes as human-readable size (KB, MB, GB).
#[no_mangle]
pub extern "C" fn rust_format_bytes(bytes: u64, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let out = output_bytes(out_ptr, out_cap);

        let formatted = if bytes < 1024 {
            format!("{} B", bytes)
        } else if bytes < 1024 * 1024 {
            format!("{:.2} KB", bytes as f64 / 1024.0)
        } else if bytes < 1024 * 1024 * 1024 {
            format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
        } else {
            format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
        };

        write_response(out, formatted.as_bytes())
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 18: BATCH / PIPELINE OPERATIONS
// ===========================================================================

/// Execute a pipeline of transformations on JSON data.
/// Operations: "uppercase_field", "add_field", "remove_field", "rename_field"
#[no_mangle]
pub extern "C" fn rust_json_pipeline(
    data_ptr: *const u8,
    data_len: usize,
    ops_ptr: *const u8,
    ops_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let data_input = input_bytes(data_ptr, data_len);
        let ops_input = input_bytes(ops_ptr, ops_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut data: Value = match serde_json::from_slice(data_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        #[derive(Deserialize)]
        struct PipelineOp {
            op: String,
            #[serde(default)]
            field: String,
            #[serde(default)]
            value: Option<Value>,
            #[serde(default)]
            new_name: Option<String>,
        }

        let ops: Vec<PipelineOp> = match serde_json::from_slice(ops_input) {
            Ok(v) => v,
            Err(_) => return -1,
        };

        for op in &ops {
            if let Value::Object(ref mut map) = data {
                match op.op.as_str() {
                    "add_field" | "set_field" => {
                        if let Some(ref val) = op.value {
                            map.insert(op.field.clone(), val.clone());
                        }
                    }
                    "remove_field" => {
                        map.remove(&op.field);
                    }
                    "rename_field" => {
                        if let Some(ref new_name) = op.new_name {
                            if let Some(val) = map.remove(&op.field) {
                                map.insert(new_name.clone(), val);
                            }
                        }
                    }
                    "uppercase_field" => {
                        if let Some(Value::String(ref mut s)) = map.get_mut(&op.field) {
                            *s = s.to_uppercase();
                        }
                    }
                    _ => {}
                }
            }
        }

        let result = serde_json::to_vec(&data).unwrap_or_default();
        write_response(out, &result)
    }))
    .unwrap_or(-1)
}

// ===========================================================================
// SECTION 19: CONNECTION & PROTOCOL UTILITIES
// ===========================================================================

/// Parse a Host header into hostname and port.
#[no_mangle]
pub extern "C" fn rust_parse_host(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let host = String::from_utf8_lossy(input);
        let out = output_bytes(out_ptr, out_cap);

        let host_ref: &str = &host;

        let (hostname, port): (&str, u16) = if let Some(colon_pos) = host_ref.rfind(':') {
            if !host_ref.contains('[') {
                let port_str = &host_ref[colon_pos + 1..];
                if port_str.chars().all(|c| c.is_ascii_digit()) {
                    (
                        &host_ref[..colon_pos],
                        port_str.parse::<u16>().unwrap_or(80),
                    )
                } else {
                    (host_ref, 80u16)
                }
            } else {
                (host_ref, 80u16)
            }
        } else {
            (host_ref, 80u16)
        };

        let result = json!({
            "hostname": hostname,
            "port": port,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}
/// Build an absolute URL from components.
#[no_mangle]
pub extern "C" fn rust_url_build(
    scheme_ptr: *const u8,
    scheme_len: usize,
    host_ptr: *const u8,
    host_len: usize,
    port: u16,
    path_ptr: *const u8,
    path_len: usize,
    query_ptr: *const u8,
    query_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let scheme = String::from_utf8_lossy(input_bytes(scheme_ptr, scheme_len));
        let host = String::from_utf8_lossy(input_bytes(host_ptr, host_len));
        let path = String::from_utf8_lossy(input_bytes(path_ptr, path_len));
        let query = String::from_utf8_lossy(input_bytes(query_ptr, query_len));
        let out = output_bytes(out_ptr, out_cap);

        let scheme_ref: &str = &scheme;
        let host_ref: &str = &host;
        let path_ref: &str = &path;
        let query_ref: &str = &query;

        let mut url = format!("{}://{}", scheme_ref, host_ref);

        let default_port: u16 = if scheme_ref == "https" { 443 } else { 80 };
        if port != 0 && port != default_port {
            url.push_str(&format!(":{}", port));
        }

        if !path_ref.is_empty() {
            if !path_ref.starts_with('/') {
                url.push('/');
            }
            url.push_str(path_ref);
        }

        if !query_ref.is_empty() {
            url.push('?');
            url.push_str(query_ref);
        }

        write_response(out, url.as_bytes())
    }))
    .unwrap_or(-1)
}
/// Parse Content-Type header into mime type and parameters.
#[no_mangle]
pub extern "C" fn rust_content_type_parse(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);
        let out = output_bytes(out_ptr, out_cap);

        let parts: Vec<&str> = text.split(';').collect();
        let mime_type = parts.first().unwrap_or(&"").trim().to_string();

        let mut params = serde_json::Map::new();
        for part in &parts[1..] {
            let part = part.trim();
            if let Some(eq_pos) = part.find('=') {
                let key = part[..eq_pos].trim().to_string();
                let value = part[eq_pos + 1..].trim().trim_matches('"').to_string();
                params.insert(key, Value::String(value));
            }
        }

        let result = json!({
            "mime_type": mime_type,
            "params": params,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    }))
    .unwrap_or(-1)
}
// ===========================================================================
// SECTION 20: EXISTING FUNCTIONS (PRESERVED)
// ===========================================================================

#[derive(Deserialize, Serialize, Clone)]
struct ProductAddBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize)]
struct ProductAddResponse {
    created: bool,
    body: ProductAddBody,
}

#[no_mangle]
pub extern "C" fn rust_products_add(
    body_ptr: *const u8,
    body_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
    status_ptr: *mut u16,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(body_ptr, body_len);
        let out = output_bytes(out_ptr, out_cap);

        let parsed: ProductAddBody = match serde_json::from_slice(input) {
            Ok(value) => value,
            Err(_) => {
                set_status(status_ptr, 400);
                let err = br#"{"error":"Invalid JSON body"}"#;
                return write_response(out, err);
            }
        };

        let response = ProductAddResponse {
            created: true,
            body: parsed,
        };

        match serde_json::to_vec(&response) {
            Ok(json_bytes) => {
                set_status(status_ptr, 201);
                write_response(out, &json_bytes)
            }
            Err(_) => {
                set_status(status_ptr, 500);
                -1
            }
        }
    }))
    .unwrap_or(-1)
}

#[derive(Serialize)]
struct Product {
    id: String,
}

#[derive(Serialize)]
struct ProductResponse {
    product: Product,
}

#[no_mangle]
pub extern "C" fn rust_products_get_id(
    id_ptr: *const u8,
    id_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
    status_ptr: *mut u16,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let id_bytes = input_bytes(id_ptr, id_len);
        let out = output_bytes(out_ptr, out_cap);
        let id = String::from_utf8_lossy(id_bytes).into_owned();

        let response = ProductResponse {
            product: Product { id },
        };

        match serde_json::to_vec(&response) {
            Ok(json_bytes) => {
                set_status(status_ptr, 200);
                write_response(out, &json_bytes)
            }
            Err(_) => {
                set_status(status_ptr, 500);
                -1
            }
        }
    }))
    .unwrap_or(-1)
}

#[derive(Deserialize)]
struct BatchOp {
    #[serde(default)]
    id: String,
    op: String,
    body: Option<Value>,
    params: Option<Value>,
}

#[derive(Serialize)]
struct BatchResult {
    id: String,
    status: u16,
    body: Value,
}

#[no_mangle]
pub extern "C" fn rust_batch_execute(
    input_ptr: *const u8,
    input_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
    status_ptr: *mut u16,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(input_ptr, input_len);
        let out = output_bytes(out_ptr, out_cap);

        let ops: Vec<BatchOp> = match serde_json::from_slice(input) {
            Ok(value) => value,
            Err(_) => {
                set_status(status_ptr, 400);
                let err = br#"{"error":"Invalid batch payload"}"#;
                return write_response(out, err);
            }
        };

        let results: Vec<BatchResult> = ops
            .into_iter()
            .map(|op| match op.op.as_str() {
                "products.add" => {
                    let body: ProductAddBody = op
                        .body
                        .map(|value| {
                            serde_json::from_value::<ProductAddBody>(value)
                                .unwrap_or(ProductAddBody { name: None })
                        })
                        .unwrap_or(ProductAddBody { name: None });

                    BatchResult {
                        id: op.id,
                        status: 201,
                        body: json!({"created": true, "body": body}),
                    }
                }
                "products.get" => {
                    let id = op
                        .params
                        .as_ref()
                        .and_then(|params| params.get("id"))
                        .and_then(|id| id.as_str())
                        .unwrap_or("")
                        .to_string();

                    BatchResult {
                        id: op.id,
                        status: 200,
                        body: json!({"product": {"id": id}}),
                    }
                }
                _ => BatchResult {
                    id: op.id,
                    status: 404,
                    body: json!({"error": "Unknown op"}),
                },
            })
            .collect();

        match serde_json::to_vec(&results) {
            Ok(json_bytes) => {
                set_status(status_ptr, 200);
                write_response(out, &json_bytes)
            }
            Err(_) => {
                set_status(status_ptr, 500);
                -1
            }
        }
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_xxh3_u64(ptr: *const u8, len: usize) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);

        // The TypeScript side uses Bun.hash.xxHash64, which is XXH64.
        // Keep the exported symbol name for compatibility, but use XXH64.
        xxh64(input, 0)
    }))
    .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn rust_sha256_u64(ptr: *const u8, len: usize) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let mut hasher = Sha256::new();
        hasher.update(input);
        let digest = hasher.finalize();
        u64::from_be_bytes(digest[0..8].try_into().expect("SHA-256 digest is 32 bytes"))
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rust_url_sum_host_lens(ptr: *const u8, len: usize) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(ptr, len);
        let text = match std::str::from_utf8(input) {
            Ok(value) => value,
            Err(_) => return -1,
        };

        text.lines().fold(0i64, |acc, line| {
            let line = line.trim();
            if line.is_empty() {
                return acc;
            }
            match Url::parse(line) {
                Ok(url) => acc.saturating_add(url.host_str().map(|h| h.len() as i64).unwrap_or(0)),
                Err(_) => acc,
            }
        })
    }))
    .unwrap_or(-1)
}

#[no_mangle]
pub extern "C" fn rust_prime_count(limit: u32) -> u32 {
    catch_unwind(AssertUnwindSafe(|| {
        if limit < 2 {
            return 0;
        }

        let mut is_prime = vec![true; (limit + 1) as usize];
        is_prime[0] = false;
        is_prime[1] = false;

        let mut p = 2u32;
        while (p as u64) * (p as u64) <= limit as u64 {
            if is_prime[p as usize] {
                let mut multiple = (p as u64) * (p as u64);
                while multiple <= limit as u64 {
                    is_prime[multiple as usize] = false;
                    multiple += p as u64;
                }
            }
            p += 1;
        }

        is_prime.iter().filter(|&&x| x).count() as u32
    }))
    .unwrap_or(0)
}

#[derive(Deserialize)]
struct TaskEvent {
    #[serde(default)]
    id: i64,
}

#[derive(Deserialize)]
struct TaskInput {
    #[serde(default)]
    events: Vec<TaskEvent>,
}

#[derive(Serialize)]
struct TaskOutput {
    count: usize,
    sum: i64,
    hash: String,
}

#[no_mangle]
pub extern "C" fn rust_task_process(
    input_ptr: *const u8,
    input_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_unwind(AssertUnwindSafe(|| {
        let input = input_bytes(input_ptr, input_len);
        let out = output_bytes(out_ptr, out_cap);

        let parsed: TaskInput = match serde_json::from_slice(input) {
            Ok(value) => value,
            Err(_) => return -1,
        };

        let sum = parsed
            .events
            .iter()
            .fold(0i64, |acc, event| acc.saturating_add(event.id));

        let hash = xxh64(input, 0);
        let response = TaskOutput {
            count: parsed.events.len(),
            sum,
            hash: hash.to_string(),
        };

        match serde_json::to_vec(&response) {
            Ok(json_bytes) => write_response(out, &json_bytes),
            Err(_) => -1,
        }
    }))
    .unwrap_or(-1)
}


// ===========================================================================
// PRACTICAL V2 FUNCTIONS
// ===========================================================================

/// encodeURIComponent-compatible ASCII set.
/// encodeURIComponent does not escape:
/// A-Z a-z 0-9 - _ . ! ~ * ' ( )
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
                let mut header_map = serde_json::Map::new();

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

        let mut params = serde_json::Map::new();

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

        let mut cookies = serde_json::Map::new();

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

        use sha1::Digest as _;
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

        // Convert simple wildcard syntax to matchit wildcard syntax.
        //
        // Examples:
        //   "*"        -> "/*wildcard"
        //   "/files/*" -> "/files/*wildcard"
        let mut insert_pattern = pattern.clone();

        if insert_pattern == "*" {
            insert_pattern = "/*wildcard".to_string();
        } else if insert_pattern.ends_with("/*") {
            insert_pattern.push_str("wildcard");
        } else if insert_pattern.ends_with('*') && !insert_pattern.ends_with("/*") {
            insert_pattern.pop();
            insert_pattern.push_str("*wildcard");
        }

        let matchit_result: Result<serde_json::Map<String, Value>, ()> =
            ROUTER_CACHE_V2.with(|cache| {
                let mut cache = cache.borrow_mut();

                if !cache.contains_key(&insert_pattern) {
                    let mut router: Router<u8> = Router::new();

                    // Some matchit versions/APIs prefer or require 'static route strings.
                    // Leak once per unique pattern. This is bounded by the number of
                    // unique route patterns used in the benchmark.
                    let route: &'static str =
                        Box::leak(insert_pattern.clone().into_boxed_str());

                    if router.insert(route, 0u8).is_err() {
                        return Err(());
                    }

                    cache.insert(insert_pattern.clone(), router);
                }

                let router = cache.get(&insert_pattern).unwrap();

                match router.at(&path) {
                    Ok(matched) => {
                        let mut params = serde_json::Map::new();

                        for (key, value) in matched.params.iter() {
                            let out_key = if key == "wildcard" { "*" } else { key };

                            params.insert(
                                out_key.to_string(),
                                Value::String(value.to_string()),
                            );
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

            // Fallback so the practical benchmark does not hard-fail if matchit
            // rejects a pattern syntax or a route does not match.
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

    let mut params = serde_json::Map::new();

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

        match uuid::Uuid::parse_str(&text) {
            Ok(u) => {
                if u.get_version_num() == 4
                    && matches!(u.get_variant(), uuid::Variant::RFC4122)
                {
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