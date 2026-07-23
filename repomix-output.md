This file is a merged representation of the entire codebase, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
````
src/
  lib.rs
.gitignore
.repomixignore
bench-practical.ts
bench.ts
Cargo.toml
client.ts
data.ts
index.ts
native.ts
package.json
README.md
repomix.config.json
server.ts
shared-practical.ts
shared.ts
task-bench.ts
task-worker.ts
tsconfig.json
````

# Files

## File: src/lib.rs
````rust
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
````

## File: .gitignore
````
# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
*.log
report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store
/target
.DS_Store
````

## File: .repomixignore
````
# Add patterns to ignore here, one per line
# Example:
# *.log
# tmp/
````

## File: bench-practical.ts
````typescript
// bench-practical.ts
import { rust } from "./native";
import * as practical from "./shared-practical";
import { decoder, encoder } from "./shared";
import { jsonRowsBytes } from "./data";

type BenchResult = {
  name: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec: number;
  checksum: string;
};

function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000;
}

function bench(
  name: string,
  fn: () => unknown,
  iterations = 100,
  warmup = 10,
): BenchResult {
  let checksum = 0n;

  const consume = (v: unknown) => {
    if (typeof v === "bigint") checksum += v;
    else if (typeof v === "number") checksum += BigInt(Math.trunc(v));
    else if (typeof v === "boolean") checksum += v ? 1n : 0n;
    else if (typeof v === "string") checksum += BigInt(v.length);
    else if (v instanceof Uint8Array) {
      checksum += BigInt(v.byteLength);
      checksum += BigInt(v[0] ?? 0);
    } else if (v != null) checksum += 1n;
  };

  for (let i = 0; i < warmup; i++) consume(fn());

  const samples: number[] = new Array(iterations);

  for (let i = 0; i < iterations; i++) {
    const start = nowMs();
    consume(fn());
    samples[i] = nowMs() - start;
  }

  samples.sort((a, b) => a - b);

  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / iterations;

  return {
    name,
    iterations,
    avgMs: avg,
    p50Ms: samples[Math.floor(iterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(iterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${String(actual)}`);
    console.error(`  expected: ${String(expected)}`);
    process.exit(1);
  }
}

function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);

  const sorted: Record<string, any> = {};

  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }

  return sorted;
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${a}`);
    console.error(`  expected: ${b}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jsonPayload = jsonRowsBytes(5_000);

const httpRaw = encoder.encode(
  "GET /api/users?page=1&limit=20 HTTP/1.1\r\n" +
    "Host: example.com\r\n" +
    "Accept: application/json\r\n" +
    "Authorization: Bearer token\r\n" +
    "Cookie: sid=abc; theme=dark\r\n" +
    "\r\n",
);

const queryStr = encoder.encode(
  "name=John+Doe&age=30&tags[]=a&tags[]=b&empty=&enc=%20hi%20",
);

const cookieStr = encoder.encode("session=abc123; theme=dark; lang=en-US");

const hmacKey = encoder.encode("super-secret-key-2026");
const hmacData = encoder.encode("message to sign with HMAC-SHA256");
const hmacSig = practical.nativeHmacSha256V2(hmacKey, hmacData);

const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
const wsKeyBytes = encoder.encode(wsKey);

const jsonDoc = encoder.encode(JSON.stringify({ a: 1, b: { c: 2 } }));
const jsonPatch = encoder.encode(
  JSON.stringify([{ op: "replace", path: "/a", value: 42 }]),
);

const routePattern = encoder.encode("/users/:id/posts/:postId");
const routePath = encoder.encode("/users/42/posts/7");

const emailOk = encoder.encode("user@example.com");
const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
const ipv4Ok = encoder.encode("192.168.1.100");
const ipv6Ok = encoder.encode("2001:db8::1");
const luhnOk = encoder.encode("4532015112830366");

const crcInput = encoder.encode("Hello, practical CRC32 checksum test data!");
const mimeExt = encoder.encode("json");

const urlEncodeInput = encoder.encode("hello world & foo=bar");
const urlDecodeInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");

// ---------------------------------------------------------------------------
// Correctness checks
// ---------------------------------------------------------------------------

assertEqual(
  practical.nativeJsonValidV2(jsonPayload),
  rust.jsonValidV2(jsonPayload) === 1,
  "v2 json valid",
);

assertEqual(
  practical.nativeJsonSumV2(jsonPayload),
  rust.jsonSumIdsV2(jsonPayload),
  "v2 json sum",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeHttpParseRequestV2(httpRaw))),
  JSON.parse(decoder.decode(rust.httpParseRequestV2(httpRaw))),
  "v2 http parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeQueryParseV2(queryStr))),
  JSON.parse(decoder.decode(rust.queryParseV2(queryStr))),
  "v2 query parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeCookieParseV2(cookieStr))),
  JSON.parse(decoder.decode(rust.cookieParseV2(cookieStr))),
  "v2 cookie parse",
);

assertEqual(
  decoder.decode(practical.nativeWsAcceptKeyV2(wsKey)),
  decoder.decode(rust.wsAcceptKeyV2(wsKeyBytes)),
  "v2 ws accept key",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeJsonPatchV2(jsonDoc, jsonPatch))),
  JSON.parse(decoder.decode(rust.jsonPatchV2(jsonDoc, jsonPatch))),
  "v2 json patch",
);

assertEqual(
  practical.nativeHmacSha256VerifyV2(hmacKey, hmacData, hmacSig),
  rust.hmacSha256VerifyV2(hmacKey, hmacData, hmacSig) === 1,
  "v2 hmac verify",
);

assertDeepEqual(
  JSON.parse(
    decoder.decode(
      practical.nativeRouteMatchV2("/users/:id/posts/:postId", "/users/42/posts/7")!,
    ),
  ),
  JSON.parse(decoder.decode(rust.routeMatchV2(routePattern, routePath))),
  "v2 route match",
);

assertEqual(
  practical.nativeValidateEmailV2(emailOk),
  rust.validateEmailV2(emailOk) === 1,
  "v2 email valid",
);

assertEqual(
  practical.nativeValidateUuidV2(uuidOk),
  rust.validateUuidV2(uuidOk) === 1,
  "v2 uuid valid",
);

assertEqual(
  practical.nativeValidateIpv4V2(ipv4Ok),
  rust.validateIpv4V2(ipv4Ok) === 1,
  "v2 ipv4 valid",
);

assertEqual(
  practical.nativeValidateIpv6V2(ipv6Ok),
  rust.validateIpv6V2(ipv6Ok) === 1,
  "v2 ipv6 valid",
);

assertEqual(
  practical.nativeValidateLuhnV2(luhnOk),
  true,
  "v2 luhn valid",
);

assertEqual(
  practical.nativeCrc32V2(crcInput),
  rust.crc32V2(crcInput),
  "v2 crc32",
);

assertEqual(
  practical.nativeFnv1a64V2(crcInput),
  rust.fnv1a64V2(crcInput),
  "v2 fnv1a64",
);

assertEqual(
  practical.nativeMimeFromExtensionV2("json"),
  decoder.decode(rust.mimeFromExtensionV2(mimeExt)),
  "v2 mime",
);

assertEqual(
  practical.nativeUrlEncodeV2("hello world & foo=bar"),
  decoder.decode(rust.urlEncodeV2(urlEncodeInput)),
  "v2 url encode",
);

assertEqual(
  practical.nativeUrlDecodeV2("hello%20world%20%26%20foo%3Dbar"),
  decoder.decode(rust.urlDecodeV2(urlDecodeInput)),
  "v2 url decode",
);

console.log("Practical correctness checks passed. ✓");

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

const results: BenchResult[] = [];

function push(
  name: string,
  fn: () => unknown,
  iterations = 200,
  warmup = 20,
) {
  results.push(bench(name, fn, iterations, warmup));
}

push("native:v2:json_valid", () => practical.nativeJsonValidV2(jsonPayload), 100, 10);
push("rust:v2:json_valid", () => rust.jsonValidV2(jsonPayload), 100, 10);

push("native:v2:json_sum", () => practical.nativeJsonSumV2(jsonPayload), 100, 10);
push("rust:v2:json_sum", () => rust.jsonSumIdsV2(jsonPayload), 100, 10);

push("native:v2:http_parse", () => practical.nativeHttpParseRequestV2(httpRaw).byteLength, 500, 50);
push("rust:v2:http_parse", () => rust.httpParseRequestV2(httpRaw).byteLength, 500, 50);

push("native:v2:query_parse", () => practical.nativeQueryParseV2(queryStr).byteLength, 500, 50);
push("rust:v2:query_parse", () => rust.queryParseV2(queryStr).byteLength, 500, 50);

push("native:v2:cookie_parse", () => practical.nativeCookieParseV2(cookieStr).byteLength, 500, 50);
push("rust:v2:cookie_parse", () => rust.cookieParseV2(cookieStr).byteLength, 500, 50);

push("native:v2:random_token", () => practical.nativeRandomTokenV2(32).byteLength, 1000, 100);
push("rust:v2:random_token", () => rust.randomTokenV2(32).byteLength, 1000, 100);

push("native:v2:ws_accept_key", () => practical.nativeWsAcceptKeyV2(wsKey).byteLength, 1000, 100);
push("rust:v2:ws_accept_key", () => rust.wsAcceptKeyV2(wsKeyBytes).byteLength, 1000, 100);

push("native:v2:json_patch", () => practical.nativeJsonPatchV2(jsonDoc, jsonPatch).byteLength, 500, 50);
push("rust:v2:json_patch", () => rust.jsonPatchV2(jsonDoc, jsonPatch).byteLength, 500, 50);

push("native:v2:hmac_verify", () => practical.nativeHmacSha256VerifyV2(hmacKey, hmacData, hmacSig) ? 1 : 0, 500, 50);
push("rust:v2:hmac_verify", () => rust.hmacSha256VerifyV2(hmacKey, hmacData, hmacSig), 500, 50);

push("native:v2:route_match", () => practical.nativeRouteMatchV2("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:v2:route_match", () => rust.routeMatchV2(routePattern, routePath).byteLength, 500, 50);

push("native:v2:validate_email", () => practical.nativeValidateEmailV2(emailOk) ? 1 : 0, 1000, 100);
push("rust:v2:validate_email", () => rust.validateEmailV2(emailOk), 1000, 100);

push("native:v2:validate_uuid", () => practical.nativeValidateUuidV2(uuidOk) ? 1 : 0, 1000, 100);
push("rust:v2:validate_uuid", () => rust.validateUuidV2(uuidOk), 1000, 100);

push("native:v2:validate_ipv4", () => practical.nativeValidateIpv4V2(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:v2:validate_ipv4", () => rust.validateIpv4V2(ipv4Ok), 1000, 100);

push("native:v2:validate_ipv6", () => practical.nativeValidateIpv6V2(ipv6Ok) ? 1 : 0, 1000, 100);
push("rust:v2:validate_ipv6", () => rust.validateIpv6V2(ipv6Ok), 1000, 100);

push("native:v2:crc32", () => practical.nativeCrc32V2(crcInput), 1000, 100);
push("rust:v2:crc32", () => rust.crc32V2(crcInput), 1000, 100);

push("native:v2:fnv1a64", () => practical.nativeFnv1a64V2(crcInput), 1000, 100);
push("rust:v2:fnv1a64", () => rust.fnv1a64V2(crcInput), 1000, 100);

push("native:v2:mime", () => practical.nativeMimeFromExtensionV2("json").length, 1000, 100);
push("rust:v2:mime", () => rust.mimeFromExtensionV2(mimeExt).byteLength, 1000, 100);

push("native:v2:url_encode", () => practical.nativeUrlEncodeV2("hello world & foo=bar").length, 1000, 100);
push("rust:v2:url_encode", () => rust.urlEncodeV2(urlEncodeInput).byteLength, 1000, 100);

push("native:v2:url_decode", () => practical.nativeUrlDecodeV2("hello%20world%20%26%20foo%3Dbar").length, 1000, 100);
push("rust:v2:url_decode", () => rust.urlDecodeV2(urlDecodeInput).byteLength, 1000, 100);

console.table(
  results.map((r) => ({
    name: r.name,
    iters: r.iterations,
    "avg ms": r.avgMs.toFixed(4),
    "p50 ms": r.p50Ms.toFixed(4),
    "p95 ms": r.p95Ms.toFixed(4),
    "ops/s": r.opsPerSec.toFixed(1),
    checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
  })),
);

function report(label: string, nativeName: string, rustName: string): void {
  const n = results.find((x) => x.name === nativeName);
  const r = results.find((x) => x.name === rustName);

  if (!n || !r) return;

  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);

  if (ratio >= 1) {
    console.log(
      `${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    );
  } else {
    console.log(
      `${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    );
  }
}

console.log("\n═══ Practical Summary ═══");

report("JSON valid", "native:v2:json_valid", "rust:v2:json_valid");
report("JSON sum", "native:v2:json_sum", "rust:v2:json_sum");
report("HTTP parse", "native:v2:http_parse", "rust:v2:http_parse");
report("Query parse", "native:v2:query_parse", "rust:v2:query_parse");
report("Cookie parse", "native:v2:cookie_parse", "rust:v2:cookie_parse");
report("Random token", "native:v2:random_token", "rust:v2:random_token");
report("WebSocket accept", "native:v2:ws_accept_key", "rust:v2:ws_accept_key");
report("JSON Patch", "native:v2:json_patch", "rust:v2:json_patch");
report("HMAC verify", "native:v2:hmac_verify", "rust:v2:hmac_verify");
report("Route match", "native:v2:route_match", "rust:v2:route_match");
report("Email validation", "native:v2:validate_email", "rust:v2:validate_email");
report("UUID validation", "native:v2:validate_uuid", "rust:v2:validate_uuid");
report("IPv4 validation", "native:v2:validate_ipv4", "rust:v2:validate_ipv4");
report("IPv6 validation", "native:v2:validate_ipv6", "rust:v2:validate_ipv6");
report("CRC32", "native:v2:crc32", "rust:v2:crc32");
report("FNV-1a 64", "native:v2:fnv1a64", "rust:v2:fnv1a64");
report("MIME lookup", "native:v2:mime", "rust:v2:mime");
report("URL encode", "native:v2:url_encode", "rust:v2:url_encode");
report("URL decode", "native:v2:url_decode", "rust:v2:url_decode");
````

## File: bench.ts
````typescript
import { rust } from "./native";
import {
  batchBytes, hashBytes, jsonRowsBytes, productAddBytes, productIdBytes, taskBytes, urlBytes,
} from "./data";
import {
  decoder, encoder,
  nativeBatchBytes, nativeHashU64, nativeJsonSum, nativeJsonValid,
  nativePrimeCount, nativeProductsAddBytes, nativeProductsGetIdBytes,
  nativeSha256U64, nativeTaskProcess, nativeUrlSumHostLens,
  nativeHttpParseRequest, nativeQueryParse, nativeCookieParse,
  nativeRouteMatch,
  nativeValidateEmail, nativeValidateUuid, nativeValidateIpv4, nativeValidateLuhn,
  nativeHmacSha256, nativeBase64Encode, nativeBase64Decode,
  nativeGzipCompress, nativeGzipDecompress,
  nativeHtmlEscape, nativeSlugify, nativeTemplateRender,
  nativeJsonSortBy, nativeJsonPaginate, nativeJsonAggregate, nativeJsonGroupBy, nativeJsonDedup,
  nativeCrc32, nativeFnv1a64,
  nativeMimeFromExtension, nativePathNormalize, nativePathIsSafe,
  nativeHttpResponseBuild, nativeErrorResponse,
  nativeWsFrameParse, nativeWsFrameBuild,
  nativeLogFormat, nativeHistogramBucket,
  nativeContentNegotiate,
  nativeJsonExtract, nativeJsonFlatten, nativeJsonMerge,
  nativeTextSearchCount, nativeBinarySearch,
  nativeFormatBytes, nativeEtagGenerate,
  nativeUrlEncode, nativeUrlDecode,
  nativeCookieSerialize, nativeMultipartParse, nativeCorsHeaders, nativeRateLimitCheck

} from "./shared";

type BenchResult = {
  name: string; iterations: number; avgMs: number;
  p50Ms: number; p95Ms: number; opsPerSec: number; checksum: string;
};

function envInt(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
function nowMs(): number { return Bun.nanoseconds() / 1_000_000; }

function bench(name: string, fn: () => unknown, iterations = 50, warmup = 5): BenchResult {
  let checksum = 0n;
  const consume = (v: unknown) => {
    if (typeof v === "bigint") checksum += v;
    else if (typeof v === "number") checksum += BigInt(Math.trunc(v));
    else if (typeof v === "boolean") checksum += v ? 1n : 0n;
    else if (typeof v === "string") checksum += BigInt(v.length);
    else if (v instanceof Uint8Array) { checksum += BigInt(v.byteLength); checksum += BigInt(v[0] ?? 0); }
    else if (v != null) checksum += 1n;
  };
  for (let i = 0; i < warmup; i++) consume(fn());
  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const s = nowMs(); consume(fn()); samples[i] = nowMs() - s;
  }
  samples.sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / iterations;
  return {
    name, iterations, avgMs: avg,
    p50Ms: samples[Math.floor(iterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(iterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}\n  actual:   ${String(actual)}\n  expected: ${String(expected)}`);
    process.exit(1);
  }
}

function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));
  if (a !== b) {
    console.error(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${b}`);
    process.exit(1);
  }
}

// ── config ──
const JSON_ROWS = envInt("JSON_ROWS", 5_000);
const BATCH_OPS = envInt("BATCH_OPS", 200);
const URL_ROWS = envInt("URL_ROWS", 2_000);
const HASH_BYTES = envInt("HASH_BYTES", 100_000);
const PRIME_LIMIT = envInt("PRIME_LIMIT", 1_000_000);
const TASK_EVENTS = envInt("TASK_EVENTS", 5_000);

const jsonPayload = jsonRowsBytes(JSON_ROWS);
const addPayload = productAddBytes();
const idPayload = productIdBytes("123");
const batchPayload = batchBytes(BATCH_OPS);
const urlPayload = urlBytes(URL_ROWS);
const hashPayload = hashBytes(HASH_BYTES);
const taskPayload = taskBytes(TASK_EVENTS);

const outSmall = new Uint8Array(64 * 1024);
const outLarge = new Uint8Array(2 * 1024 * 1024);
const status = new Uint16Array(1);
// Multipart payload
const multipartBoundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
const multipartBody = encoder.encode(
  `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n` +
  `Content-Disposition: form-data; name="field1"\r\n\r\n` +
  `value1\r\n` +
  `------WebKitFormBoundary7MA4YWxkTrZu0gW\r\n` +
  `Content-Disposition: form-data; name="file"; filename="test.txt"\r\n` +
  `Content-Type: text/plain\r\n\r\n` +
  `Hello World\r\n` +
  `------WebKitFormBoundary7MA4YWxkTrZu0gW--\r\n`
);
const multipartBoundaryBytes = encoder.encode(multipartBoundary);

// Rate limit state buffer (16 bytes: 8 for f64 tokens, 8 for u64 last_refill_ms)
const rateLimitState = new Uint8Array(16);
const rateLimitView = new DataView(rateLimitState.buffer);
rateLimitView.setFloat64(0, 10.0, true); // tokens
rateLimitView.setBigUint64(8, BigInt(Date.now() - 1000), true); // last refill 1 sec ago

// ── extra test payloads ──
const httpRaw = encoder.encode("GET /api/users?page=1&limit=20 HTTP/1.1\r\nHost: example.com\r\nAccept: application/json\r\nAuthorization: Bearer tok\r\nCookie: sid=abc; theme=dark\r\n\r\n");
const queryStr = encoder.encode("name=John+Doe&age=30&tags[]=a&tags[]=b&empty=&enc=%20hi%20");
const cookieStr = encoder.encode("session=abc123; theme=dark; lang=en-US");
const emailOk = encoder.encode("user@example.com");
const emailBad = encoder.encode("invalid@@email");
const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
const uuidBad = encoder.encode("not-a-uuid-at-all-12345678901234567");
const ipv4Ok = encoder.encode("192.168.1.100");
const ipv4Bad = encoder.encode("999.999.999.999");
const luhnOk = encoder.encode("4532015112830366");
const luhnBad = encoder.encode("1234567890123456");
const htmlIn = encoder.encode('<script>alert("xss")</script> & <b>bold</b>');
const slugIn = encoder.encode("Hello World! This is a Test -- 2026");
const hmacKey = encoder.encode("super-secret-key-2026");
const hmacData = encoder.encode("message to sign with HMAC-SHA256");
const b64Input = encoder.encode("The quick brown fox jumps over the lazy dog");
const gzipInput = hashBytes(50_000);
const smallJsonArr = encoder.encode(JSON.stringify([
  { id: 1, name: "alice", active: true, score: 90 },
  { id: 2, name: "bob", active: false, score: 75 },
  { id: 3, name: "alice", active: true, score: 85 },
  { id: 1, name: "alice", active: true, score: 90 },
]));
const sortedArr = encoder.encode(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i * 3)));
const searchCorpus = encoder.encode("the quick brown fox jumps over the lazy dog the fox");
const searchTerm = encoder.encode("fox");
const crcInput = encoder.encode("Hello, CRC32 checksum test data!");
const pathIn = encoder.encode("/api/v1/../v2/./users/../../admin");
const mimeIn = encoder.encode("json");
const acceptHdr = encoder.encode("text/html, application/json;q=0.9, */*;q=0.1");
const availTypes = encoder.encode("application/json, text/html, text/plain");
const wsPayload = encoder.encode("Hello WebSocket!");
const nestedJson = encoder.encode(JSON.stringify({ user: { name: "Alice", address: { city: "NYC", zip: "10001" } }, scores: [95, 87] }));
const extractPath = encoder.encode("user.address.city");
const jsonDoc1 = encoder.encode(JSON.stringify({ a: 1, b: 2, c: 3 }));
const jsonDoc2 = encoder.encode(JSON.stringify({ b: 20, d: 4 }));
const etagBody = encoder.encode("some response body content for etag");
const respBody = encoder.encode(JSON.stringify({ ok: true }));
const respCT = encoder.encode("application/json");
const respExtra = encoder.encode("X-Request-Id: abc-123\r\n");
const errMsg = encoder.encode("Resource not found");
const errCode = encoder.encode("NOT_FOUND");
const logLevel = encoder.encode("INFO");
const logMsg = encoder.encode("Request completed");
const logCtx = encoder.encode(JSON.stringify({ method: "GET", path: "/api", status: 200 }));
const logReqId = encoder.encode("req-abc-123");
const routePattern = encoder.encode("/users/:id/posts/:postId");
const routePath = encoder.encode("/users/42/posts/7");
const urlEncInput = encoder.encode("hello world & foo=bar");
const urlDecInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");
const templateStr = "Hello {{name}}, welcome to {{place}}! You have {{count}} messages.";
const templateData = encoder.encode(JSON.stringify({ name: "Alice", place: "Wonderland", count: 42 }));
const pipelineData = encoder.encode(JSON.stringify({ name: "widget", price: 9.99, category: "tools" }));
const pipelineOps = encoder.encode(JSON.stringify([
  { op: "uppercase_field", field: "name" },
  { op: "add_field", field: "tax", value: 0.08 },
  { op: "rename_field", field: "category", new_name: "group" },
]));



// ── correctness checks ──
assertEqual(nativeJsonSum(jsonPayload), rust.jsonSumIds(jsonPayload), "json sum");
assertEqual(nativeJsonValid(jsonPayload), true, "native json valid");
assertEqual(rust.jsonValid(jsonPayload), 1, "rust json valid");
assertEqual(rust.jsonValid(encoder.encode("{bad")), 0, "rust json invalid");
assertEqual(nativeUrlSumHostLens(urlPayload), rust.urlSumHostLens(urlPayload), "url host sum");
assertEqual(nativePrimeCount(PRIME_LIMIT), rust.primeCount(PRIME_LIMIT), "prime count");
assertEqual(nativeSha256U64(hashPayload), rust.sha256(hashPayload), "sha256");

// HTTP parsing
assertDeepEqual(JSON.parse(decoder.decode(nativeHttpParseRequest(httpRaw))), JSON.parse(decoder.decode(rust.httpParseRequest(httpRaw))), "http parse");
assertDeepEqual(JSON.parse(decoder.decode(nativeQueryParse(queryStr))), JSON.parse(decoder.decode(rust.queryParse(queryStr))), "query parse");
assertDeepEqual(JSON.parse(decoder.decode(nativeCookieParse(cookieStr))), JSON.parse(decoder.decode(rust.cookieParse(cookieStr))), "cookie parse");

// Routing
assertDeepEqual(
  JSON.parse(decoder.decode(nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")!)),
  JSON.parse(decoder.decode(rust.routeMatch(routePattern, routePath))),
  "route match",
);

// Validation
assertEqual(nativeValidateEmail(emailOk), rust.validateEmail(emailOk) === 1, "email valid");
assertEqual(nativeValidateEmail(emailBad), rust.validateEmail(emailBad) === 1, "email invalid");
assertEqual(nativeValidateUuid(uuidOk), rust.validateUuid(uuidOk) === 1, "uuid valid");
assertEqual(nativeValidateUuid(uuidBad), rust.validateUuid(uuidBad) === 1, "uuid invalid");
assertEqual(nativeValidateIpv4(ipv4Ok), rust.validateIpv4(ipv4Ok) === 1, "ipv4 valid");
assertEqual(nativeValidateIpv4(ipv4Bad), rust.validateIpv4(ipv4Bad) === 1, "ipv4 invalid");
assertEqual(nativeValidateLuhn(luhnOk), rust.validateLuhn(luhnOk) === 1, "luhn valid");
assertEqual(nativeValidateLuhn(luhnBad), rust.validateLuhn(luhnBad) === 1, "luhn invalid");

// Crypto
assertEqual(decoder.decode(nativeHmacSha256(hmacKey, hmacData)), decoder.decode(rust.hmacSha256(hmacKey, hmacData)), "hmac sha256");
assertEqual(decoder.decode(nativeBase64Encode(b64Input)), decoder.decode(rust.base64Encode(b64Input)), "base64 encode");
const b64Enc = rust.base64Encode(b64Input);
assertEqual(decoder.decode(nativeBase64Decode(b64Enc)), decoder.decode(rust.base64Decode(b64Enc)), "base64 decode");

// Compression roundtrip
const gzCompressed = rust.gzipCompress(gzipInput);
const gzDecompressed = rust.gzipDecompress(gzCompressed);
assertEqual(decoder.decode(gzDecompressed), decoder.decode(gzipInput), "gzip roundtrip");

// String
assertEqual(decoder.decode(nativeHtmlEscape(htmlIn)), decoder.decode(rust.htmlEscape(htmlIn)), "html escape");
assertEqual(decoder.decode(nativeSlugify(slugIn)), decoder.decode(rust.slugify(slugIn)), "slugify");
assertEqual(
  decoder.decode(nativeTemplateRender(templateStr, { name: "Alice", place: "Wonderland", count: 42 })),
  decoder.decode(rust.templateRender(encoder.encode(templateStr), templateData)),
  "template render",
);

// Data processing
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonSortBy(smallJsonArr, "score", false))), JSON.parse(decoder.decode(rust.jsonSortBy(smallJsonArr, encoder.encode("score"), 0))), "json sort");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonPaginate(smallJsonArr, 1, 2))), JSON.parse(decoder.decode(rust.jsonPaginate(smallJsonArr, 1, 2))), "json paginate");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonAggregate(smallJsonArr, "score"))), JSON.parse(decoder.decode(rust.jsonAggregate(smallJsonArr, encoder.encode("score")))), "json aggregate");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonGroupBy(smallJsonArr, "name"))), JSON.parse(decoder.decode(rust.jsonGroupBy(smallJsonArr, encoder.encode("name")))), "json group by");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonDedup(smallJsonArr, "id"))), JSON.parse(decoder.decode(rust.jsonDedup(smallJsonArr, encoder.encode("id")))), "json dedup");

// Hashing
assertEqual(nativeCrc32(crcInput), rust.crc32(crcInput), "crc32");
assertEqual(nativeFnv1a64(crcInput), rust.fnv1a64(crcInput), "fnv1a64");

// MIME & Path
assertEqual(nativeMimeFromExtension("json"), decoder.decode(rust.mimeFromExtension(mimeIn)), "mime from ext");
assertEqual(nativePathNormalize("/api/v1/../v2/./users/../../admin"), decoder.decode(rust.pathNormalize(pathIn)), "path normalize");
assertEqual(nativePathIsSafe("/api/../../../etc/passwd"), rust.pathIsSafe(encoder.encode("/api/../../../etc/passwd")) === 1, "path unsafe");
assertEqual(nativePathIsSafe("/api/users/123"), rust.pathIsSafe(encoder.encode("/api/users/123")) === 1, "path safe");

// HTTP response
assertEqual(
  decoder.decode(nativeHttpResponseBuild(200, respBody, "application/json", "X-Request-Id: abc-123\r\n")),
  decoder.decode(rust.httpResponseBuild(200, respBody, respCT, respExtra)),
  "http response build",
);

// WebSocket
const wsFrame = nativeWsFrameBuild(1, wsPayload);
assertDeepEqual(JSON.parse(decoder.decode(nativeWsFrameParse(wsFrame)!)), JSON.parse(decoder.decode(rust.wsFrameParse(wsFrame))), "ws frame parse");
assertEqual(decoder.decode(nativeWsFrameBuild(1, wsPayload)), decoder.decode(rust.wsFrameBuild(1, wsPayload)), "ws frame build");

// Logging
assertEqual(nativeHistogramBucket(750), rust.histogramBucket(750), "histogram bucket");
assertEqual(nativeHistogramBucket(2_000_000), rust.histogramBucket(2_000_000), "histogram bucket 2");

// Content negotiation
assertEqual(
  nativeContentNegotiate("text/html, application/json;q=0.9, */*;q=0.1", ["application/json", "text/html", "text/plain"]),
  decoder.decode(rust.contentNegotiate(acceptHdr, availTypes)),
  "content negotiate",
);

// JSON utilities
assertEqual(decoder.decode(nativeJsonExtract(nestedJson, "user.address.city")!), decoder.decode(rust.jsonExtract(nestedJson, extractPath)), "json extract");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonFlatten(nestedJson))), JSON.parse(decoder.decode(rust.jsonFlatten(nestedJson))), "json flatten");
assertDeepEqual(JSON.parse(decoder.decode(nativeJsonMerge(jsonDoc1, jsonDoc2))), JSON.parse(decoder.decode(rust.jsonMerge(jsonDoc1, jsonDoc2))), "json merge");

// Search
assertEqual(nativeBinarySearch(sortedArr, 150), Number(rust.binarySearch(sortedArr, 150)), "binary search");
assertEqual(nativeTextSearchCount(searchCorpus, searchTerm), Number(rust.textSearchCount(searchCorpus, searchTerm)), "text search");

// Misc
assertEqual(nativeFormatBytes(1536), decoder.decode(rust.formatBytes(1536)), "format bytes");
assertEqual(nativeEtagGenerate(etagBody), decoder.decode(rust.etagGenerate(etagBody)), "etag generate");
assertEqual(nativeUrlEncode("hello world & foo=bar"), decoder.decode(rust.urlEncode(urlEncInput)), "url encode");
assertEqual(nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"), decoder.decode(rust.urlDecode(urlDecInput)), "url decode");

// Pipeline
assertDeepEqual(
  JSON.parse(decoder.decode((() => {
    let obj = JSON.parse(decoder.decode(pipelineData));
    const ops = JSON.parse(decoder.decode(pipelineOps));
    for (const op of ops) {
      if (op.op === "uppercase_field") obj[op.field] = obj[op.field].toUpperCase();
      else if (op.op === "add_field") obj[op.field] = op.value;
      else if (op.op === "rename_field") { obj[op.new_name] = obj[op.field]; delete obj[op.field]; }
    }
    return encoder.encode(JSON.stringify(obj));
  })())),
  JSON.parse(decoder.decode(rust.jsonPipeline(pipelineData, pipelineOps))),
  "json pipeline",
);

console.log("All correctness checks passed. ✓");
console.log("Config:", { JSON_ROWS, BATCH_OPS, URL_ROWS, HASH_BYTES, PRIME_LIMIT, TASK_EVENTS });

// ── benchmarks ──
const R: BenchResult[] = [];
const push = (n: string, fn: () => unknown, iters = 50, warm = 5) => R.push(bench(n, fn, iters, warm));



// Cookie Serialize (flux-core context.ts)
push("native:cookie_serialize", () => nativeCookieSerialize("session", "abc123xyz", 3600, true, true, 1).byteLength, 1000, 100);
push("rust:cookie_serialize", () => rust.cookieSerialize(encoder.encode("session"), encoder.encode("abc123xyz"), 3600, 1, 1, 1).byteLength, 1000, 100);

// Multipart Parse (flux-core body.ts)
push("native:multipart_parse", () => nativeMultipartParse(multipartBody, multipartBoundary).byteLength, 500, 50);
push("rust:multipart_parse", () => rust.multipartParse(multipartBody, multipartBoundaryBytes).byteLength, 500, 50);

// CORS Headers (flux-core plugins/cors.ts)
push("native:cors_headers", () => nativeCorsHeaders("https://example.com", "https://example.com, *", "GET, POST", 86400).byteLength, 1000, 100);
push("rust:cors_headers", () => rust.corsHeaders(encoder.encode("https://example.com"), encoder.encode("https://example.com, *"), encoder.encode("GET, POST"), 86400).byteLength, 1000, 100);

// Rate Limit (flux-core plugins/ratelimit.ts)
push("native:rate_limit", () => nativeRateLimitCheck({ tokens: 10, lastRefillMs: Date.now() - 1000 }, 10, 1, Date.now(), 1) ? 1 : 0, 1000, 100);
push("rust:rate_limit", () => rust.rateLimitCheck(rateLimitState, 16, 10.0, 1.0, Date.now(), 1.0), 1000, 100);

// 1-10: Original
push("native:json_parse_sum", () => nativeJsonSum(jsonPayload), envInt("JSON_ITERS", 50));
push("rust:json_parse_sum", () => rust.jsonSumIds(jsonPayload), envInt("JSON_ITERS", 50));
push("native:json_valid", () => nativeJsonValid(jsonPayload), envInt("JSON_VALID_ITERS", 50));
push("rust:json_valid", () => rust.jsonValid(jsonPayload), envInt("JSON_VALID_ITERS", 50));
push("native:products_add", () => nativeProductsAddBytes(addPayload).byteLength, 200, 20);
push("rust:products_add", () => { status[0] = 0; const w = rust.productsAdd(addPayload, outSmall, status); return Number(w) + status[0]; }, 200, 20);
push("native:products_get", () => nativeProductsGetIdBytes("123").byteLength, 300, 30);
push("rust:products_get", () => { status[0] = 0; const w = rust.productsGetId(idPayload, outSmall, status); return Number(w) + status[0]; }, 300, 30);
push("native:batch_execute", () => nativeBatchBytes(batchPayload).byteLength, 50);
push("rust:batch_execute", () => { status[0] = 0; const w = rust.batchExecute(batchPayload, outLarge, status); return Number(w) + status[0]; }, 50);
push("native:url_parse_batch", () => nativeUrlSumHostLens(urlPayload), 50);
push("rust:url_parse_batch", () => rust.urlSumHostLens(urlPayload), 50);
push("native:xxhash", () => nativeHashU64(hashPayload), 300, 30);
push("rust:xxhash", () => rust.xxh3(hashPayload), 300, 30);
push("native:sha256", () => nativeSha256U64(hashPayload), 200, 20);
push("rust:sha256", () => rust.sha256(hashPayload), 200, 20);
push("native:prime_count", () => nativePrimeCount(PRIME_LIMIT), 20, 3);
push("rust:prime_count", () => rust.primeCount(PRIME_LIMIT), 20, 3);
push("native:task_process", () => nativeTaskProcess(taskPayload).byteLength, 50);
push("rust:task_process", () => { const w = rust.taskProcess(taskPayload, outSmall); return Number(w); }, 50);

// 11-16: HTTP parsing
push("native:http_parse", () => nativeHttpParseRequest(httpRaw).byteLength, 500, 50);
push("rust:http_parse", () => rust.httpParseRequest(httpRaw).byteLength, 500, 50);
push("native:query_parse", () => nativeQueryParse(queryStr).byteLength, 500, 50);
push("rust:query_parse", () => rust.queryParse(queryStr).byteLength, 500, 50);
push("native:cookie_parse", () => nativeCookieParse(cookieStr).byteLength, 500, 50);
push("rust:cookie_parse", () => rust.cookieParse(cookieStr).byteLength, 500, 50);
push("native:url_encode", () => nativeUrlEncode("hello world & foo=bar").length, 500, 50);
push("rust:url_encode", () => rust.urlEncode(urlEncInput).byteLength, 500, 50);
push("native:url_decode", () => nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length, 500, 50);
push("rust:url_decode", () => rust.urlDecode(urlDecInput).byteLength, 500, 50);

// 17-18: Routing
push("native:route_match", () => nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:route_match", () => rust.routeMatch(routePattern, routePath).byteLength, 500, 50);

// 19-23: Validation
push("native:validate_email", () => nativeValidateEmail(emailOk) ? 1 : 0, 1000, 100);
push("rust:validate_email", () => rust.validateEmail(emailOk), 1000, 100);
push("native:validate_uuid", () => nativeValidateUuid(uuidOk) ? 1 : 0, 1000, 100);
push("rust:validate_uuid", () => rust.validateUuid(uuidOk), 1000, 100);
push("native:validate_ipv4", () => nativeValidateIpv4(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv4", () => rust.validateIpv4(ipv4Ok), 1000, 100);
push("native:validate_luhn", () => nativeValidateLuhn(luhnOk) ? 1 : 0, 1000, 100);
push("rust:validate_luhn", () => rust.validateLuhn(luhnOk), 1000, 100);

// 24-26: Crypto
push("native:hmac_sha256", () => nativeHmacSha256(hmacKey, hmacData).byteLength, 300, 30);
push("rust:hmac_sha256", () => rust.hmacSha256(hmacKey, hmacData).byteLength, 300, 30);
push("native:base64_encode", () => nativeBase64Encode(b64Input).byteLength, 500, 50);
push("rust:base64_encode", () => rust.base64Encode(b64Input).byteLength, 500, 50);
push("native:base64_decode", () => nativeBase64Decode(b64Enc).byteLength, 500, 50);
push("rust:base64_decode", () => rust.base64Decode(b64Enc).byteLength, 500, 50);

// 27-28: Compression
push("native:gzip_compress", () => nativeGzipCompress(gzipInput).byteLength, 100, 10);
push("rust:gzip_compress", () => rust.gzipCompress(gzipInput).byteLength, 100, 10);
push("native:gzip_decompress", () => nativeGzipDecompress(nativeGzipCompress(gzipInput)).byteLength, 100, 10);
push("rust:gzip_decompress", () => rust.gzipDecompress(gzCompressed).byteLength, 100, 10);

// 29-31: String
push("native:html_escape", () => nativeHtmlEscape(htmlIn).byteLength, 500, 50);
push("rust:html_escape", () => rust.htmlEscape(htmlIn).byteLength, 500, 50);
push("native:slugify", () => nativeSlugify(slugIn).byteLength, 500, 50);
push("rust:slugify", () => rust.slugify(slugIn).byteLength, 500, 50);
push("native:template_render", () => nativeTemplateRender(templateStr, { name: "Alice", place: "Wonderland", count: 42 }).byteLength, 500, 50);
push("rust:template_render", () => rust.templateRender(encoder.encode(templateStr), templateData).byteLength, 500, 50);

// 32-37: Data processing
push("native:json_sort", () => nativeJsonSortBy(smallJsonArr, "score", false).byteLength, 300, 30);
push("rust:json_sort", () => rust.jsonSortBy(smallJsonArr, encoder.encode("score"), 0).byteLength, 300, 30);
push("native:json_paginate", () => nativeJsonPaginate(smallJsonArr, 1, 2).byteLength, 300, 30);
push("rust:json_paginate", () => rust.jsonPaginate(smallJsonArr, 1, 2).byteLength, 300, 30);
push("native:json_aggregate", () => nativeJsonAggregate(smallJsonArr, "score").byteLength, 300, 30);
push("rust:json_aggregate", () => rust.jsonAggregate(smallJsonArr, encoder.encode("score")).byteLength, 300, 30);
push("native:json_group_by", () => nativeJsonGroupBy(smallJsonArr, "name").byteLength, 300, 30);
push("rust:json_group_by", () => rust.jsonGroupBy(smallJsonArr, encoder.encode("name")).byteLength, 300, 30);
push("native:json_dedup", () => nativeJsonDedup(smallJsonArr, "id").byteLength, 300, 30);
push("rust:json_dedup", () => rust.jsonDedup(smallJsonArr, encoder.encode("id")).byteLength, 300, 30);

// 38-39: Caching
push("native:etag_generate", () => nativeEtagGenerate(etagBody).length, 500, 50);
push("rust:etag_generate", () => rust.etagGenerate(etagBody).byteLength, 500, 50);

// 40-41: HTTP response
push("native:http_response", () => nativeHttpResponseBuild(200, respBody, "application/json", "X-Request-Id: abc\r\n").byteLength, 500, 50);
push("rust:http_response", () => rust.httpResponseBuild(200, respBody, respCT, respExtra).byteLength, 500, 50);
push("native:error_response", () => nativeErrorResponse(404, "Not found", "NOT_FOUND").byteLength, 500, 50);
push("rust:error_response", () => rust.errorResponse(404, errMsg, errCode).byteLength, 500, 50);

// 42-44: WebSocket
push("native:ws_frame_parse", () => nativeWsFrameParse(wsFrame)?.byteLength ?? 0, 500, 50);
push("rust:ws_frame_parse", () => rust.wsFrameParse(wsFrame).byteLength, 500, 50);
push("native:ws_frame_build", () => nativeWsFrameBuild(1, wsPayload).byteLength, 500, 50);
push("rust:ws_frame_build", () => rust.wsFrameBuild(1, wsPayload).byteLength, 500, 50);

// 45-46: MIME
push("native:mime_from_ext", () => nativeMimeFromExtension("json").length, 1000, 100);
push("rust:mime_from_ext", () => rust.mimeFromExtension(mimeIn).byteLength, 1000, 100);
push("native:content_negotiate", () => nativeContentNegotiate("text/html, application/json;q=0.9", ["application/json", "text/html"])?.length ?? 0, 500, 50);
push("rust:content_negotiate", () => rust.contentNegotiate(acceptHdr, availTypes).byteLength, 500, 50);

// 47-48: Logging
push("native:log_format", () => nativeLogFormat("INFO", "Request completed", { method: "GET" }, "req-123").byteLength, 500, 50);
push("rust:log_format", () => rust.logFormat(logLevel, logMsg, logCtx, logReqId).byteLength, 500, 50);
push("native:histogram_bucket", () => nativeHistogramBucket(750), 1000, 100);
push("rust:histogram_bucket", () => rust.histogramBucket(750), 1000, 100);

// 49-51: Path
push("native:path_normalize", () => nativePathNormalize("/api/v1/../v2/./users").length, 500, 50);
push("rust:path_normalize", () => rust.pathNormalize(pathIn).byteLength, 500, 50);
push("native:path_is_safe", () => nativePathIsSafe("/api/users/123") ? 1 : 0, 1000, 100);
push("rust:path_is_safe", () => rust.pathIsSafe(encoder.encode("/api/users/123")), 1000, 100);

// 52-53: Search
push("native:binary_search", () => nativeBinarySearch(sortedArr, 150), 500, 50);
push("rust:binary_search", () => Number(rust.binarySearch(sortedArr, 150)), 500, 50);
push("native:text_search", () => nativeTextSearchCount(searchCorpus, searchTerm), 500, 50);
push("rust:text_search", () => Number(rust.textSearchCount(searchCorpus, searchTerm)), 500, 50);

// 54-55: Math
push("native:crc32", () => nativeCrc32(crcInput), 500, 50);
push("rust:crc32", () => rust.crc32(crcInput), 500, 50);
push("native:fnv1a64", () => nativeFnv1a64(crcInput), 500, 50);
push("rust:fnv1a64", () => rust.fnv1a64(crcInput), 500, 50);

// 56: Misc
push("native:format_bytes", () => nativeFormatBytes(1536).length, 1000, 100);
push("rust:format_bytes", () => rust.formatBytes(1536).byteLength, 1000, 100);

// 57: JSON utilities
push("native:json_extract", () => nativeJsonExtract(nestedJson, "user.address.city")?.byteLength ?? 0, 500, 50);
push("rust:json_extract", () => rust.jsonExtract(nestedJson, extractPath).byteLength, 500, 50);
push("native:json_flatten", () => nativeJsonFlatten(nestedJson).byteLength, 300, 30);
push("rust:json_flatten", () => rust.jsonFlatten(nestedJson).byteLength, 300, 30);
push("native:json_merge", () => nativeJsonMerge(jsonDoc1, jsonDoc2).byteLength, 500, 50);
push("rust:json_merge", () => rust.jsonMerge(jsonDoc1, jsonDoc2).byteLength, 500, 50);

// 58: Pipeline
push("native:json_pipeline", () => {
  let obj = JSON.parse(decoder.decode(pipelineData));
  const ops = JSON.parse(decoder.decode(pipelineOps));
  for (const op of ops) {
    if (op.op === "uppercase_field") obj[op.field] = obj[op.field].toUpperCase();
    else if (op.op === "add_field") obj[op.field] = op.value;
    else if (op.op === "rename_field") { obj[op.new_name] = obj[op.field]; delete obj[op.field]; }
  }
  return encoder.encode(JSON.stringify(obj)).byteLength;
}, 300, 30);
push("rust:json_pipeline", () => rust.jsonPipeline(pipelineData, pipelineOps).byteLength, 300, 30);

// ── output ──
console.table(
  R.map((r) => ({
    name: r.name,
    iters: r.iterations,
    "avg ms": r.avgMs.toFixed(4),
    "p50 ms": r.p50Ms.toFixed(4),
    "p95 ms": r.p95Ms.toFixed(4),
    "ops/s": r.opsPerSec.toFixed(1),
    checksum: r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
  })),
);

function report(label: string, nativeName: string, rustName: string): void {
  const n = R.find((x) => x.name === nativeName);
  const r = R.find((x) => x.name === rustName);
  if (!n || !r) return;
  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);
  if (ratio >= 1) {
    console.log(`${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`);
  } else {
    console.log(`${label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`);
  }
}

console.log("\n═══ Summary ═══");
report("JSON parse + sum", "native:json_parse_sum", "rust:json_parse_sum");
report("JSON validation", "native:json_valid", "rust:json_valid");
report("POST /products/add", "native:products_add", "rust:products_add");
report("GET /products/:id", "native:products_get", "rust:products_get");
report("Batch execution", "native:batch_execute", "rust:batch_execute");
report("URL batch parsing", "native:url_parse_batch", "rust:url_parse_batch");
report("Non-crypto hash", "native:xxhash", "rust:xxhash");
report("SHA-256", "native:sha256", "rust:sha256");
report("CPU-bound prime sieve", "native:prime_count", "rust:prime_count");
report("Background task", "native:task_process", "rust:task_process");
report("HTTP request parse", "native:http_parse", "rust:http_parse");
report("Query string parse", "native:query_parse", "rust:query_parse");
report("Cookie parse", "native:cookie_parse", "rust:cookie_parse");
report("URL encode", "native:url_encode", "rust:url_encode");
report("URL decode", "native:url_decode", "rust:url_decode");
report("Route match", "native:route_match", "rust:route_match");
report("Email validation", "native:validate_email", "rust:validate_email");
report("UUID validation", "native:validate_uuid", "rust:validate_uuid");
report("IPv4 validation", "native:validate_ipv4", "rust:validate_ipv4");
report("Luhn validation", "native:validate_luhn", "rust:validate_luhn");
report("HMAC-SHA256", "native:hmac_sha256", "rust:hmac_sha256");
report("Base64 encode", "native:base64_encode", "rust:base64_encode");
report("Base64 decode", "native:base64_decode", "rust:base64_decode");
report("Gzip compress", "native:gzip_compress", "rust:gzip_compress");
report("Gzip decompress", "native:gzip_decompress", "rust:gzip_decompress");
report("HTML escape", "native:html_escape", "rust:html_escape");
report("Slugify", "native:slugify", "rust:slugify");
report("Template render", "native:template_render", "rust:template_render");
report("JSON sort", "native:json_sort", "rust:json_sort");
report("JSON paginate", "native:json_paginate", "rust:json_paginate");
report("JSON aggregate", "native:json_aggregate", "rust:json_aggregate");
report("JSON group by", "native:json_group_by", "rust:json_group_by");
report("JSON dedup", "native:json_dedup", "rust:json_dedup");
report("ETag generate", "native:etag_generate", "rust:etag_generate");
report("HTTP response build", "native:http_response", "rust:http_response");
report("Error response", "native:error_response", "rust:error_response");
report("WS frame parse", "native:ws_frame_parse", "rust:ws_frame_parse");
report("WS frame build", "native:ws_frame_build", "rust:ws_frame_build");
report("MIME from extension", "native:mime_from_ext", "rust:mime_from_ext");
report("Content negotiate", "native:content_negotiate", "rust:content_negotiate");
report("Log format", "native:log_format", "rust:log_format");
report("Histogram bucket", "native:histogram_bucket", "rust:histogram_bucket");
report("Path normalize", "native:path_normalize", "rust:path_normalize");
report("Path is safe", "native:path_is_safe", "rust:path_is_safe");
report("Binary search", "native:binary_search", "rust:binary_search");
report("Text search", "native:text_search", "rust:text_search");
report("CRC32", "native:crc32", "rust:crc32");
report("FNV-1a 64", "native:fnv1a64", "rust:fnv1a64");
report("Format bytes", "native:format_bytes", "rust:format_bytes");
report("JSON extract", "native:json_extract", "rust:json_extract");
report("JSON flatten", "native:json_flatten", "rust:json_flatten");
report("JSON merge", "native:json_merge", "rust:json_merge");
report("JSON pipeline", "native:json_pipeline", "rust:json_pipeline");
report("Cookie serialize",     "native:cookie_serialize",   "rust:cookie_serialize");
report("Multipart parse",      "native:multipart_parse",    "rust:multipart_parse");
report("CORS headers",         "native:cors_headers",       "rust:cors_headers");
report("Rate limit check",     "native:rate_limit",         "rust:rate_limit");
````

## File: Cargo.toml
````toml
[package]
name = "rust_bench"
version = "0.3.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# High-performance JSON parsing/serialization.
# If this causes issues on a target, fallback to serde_json.
sonic-rs = "0.5.8"

# Crypto / hashing
sha2 = "0.10"
sha1 = "0.11.0"
hmac = "0.12"
hex = "0.4"
xxhash-rust = { version = "0.8", features = ["xxh64"] }
base64 = "0.22"
crc32fast = "1"
fnv = "1"

# URLs / query / encoding
url = "2"
percent-encoding = "2"
form_urlencoded = "1"

# HTTP
httparse = "1"
http = "1"
cookie = "0.18"

# Routing
matchit = "0.9.2"

# Validation
email_address = "0.2"
ipnet = "2"
uuid = { version = "1", features = ["v4"] }

# JSON Patch
json-patch = "4"

# JWT
jsonwebtoken = "10.4.0"

# MIME
mime = "0.3"
mime_guess = "2"

# Random
rand = "0.10.2"
getrandom = "0.4.3"

# Compression
flate2 = { version = "1", features = ["zlib-ng"] }
zstd = "0.13"
brotli = "8.0.4"

# Search / text
aho-corasick = "1"
memchr = "2"
regex = "1"

# Time
chrono = "0.4"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true
panic = "abort"
````

## File: client.ts
````typescript
import { batchBytes, hashBytes, productAddBytes } from "./data";

const BASE = process.env.BASE ?? "http://localhost:3000";
const DURATION_MS = Number(process.env.DURATION_MS ?? 5_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);

const addBody = productAddBytes();
const batchBody = batchBytes(100);
const hashBody = hashBytes(100_000);

type HttpCase = {
  name: string;
  fn: () => Promise<Response>;
};

const cases: HttpCase[] = [
  {
    name: "native:POST /native/products/add",
    fn: () =>
      fetch(`${BASE}/native/products/add`, {
        method: "POST",
        body: addBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },
  {
    name: "rust:POST /rust/products/add",
    fn: () =>
      fetch(`${BASE}/rust/products/add`, {
        method: "POST",
        body: addBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },

  {
    name: "native:GET /native/products/123",
    fn: () => fetch(`${BASE}/native/products/123`),
  },
  {
    name: "rust:GET /rust/products/123",
    fn: () => fetch(`${BASE}/rust/products/123`),
  },

  {
    name: "native:POST /native/batch",
    fn: () =>
      fetch(`${BASE}/native/batch`, {
        method: "POST",
        body: batchBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },
  {
    name: "rust:POST /rust/batch",
    fn: () =>
      fetch(`${BASE}/rust/batch`, {
        method: "POST",
        body: batchBody,
        headers: {
          "content-type": "application/json",
        },
      }),
  },

  {
    name: "native:POST /native/hash",
    fn: () =>
      fetch(`${BASE}/native/hash`, {
        method: "POST",
        body: hashBody,
      }),
  },
  {
    name: "rust:POST /rust/hash",
    fn: () =>
      fetch(`${BASE}/rust/hash`, {
        method: "POST",
        body: hashBody,
      }),
  },

  {
    name: "native:POST /native/sha256",
    fn: () =>
      fetch(`${BASE}/native/sha256`, {
        method: "POST",
        body: hashBody,
      }),
  },
  {
    name: "rust:POST /rust/sha256",
    fn: () =>
      fetch(`${BASE}/rust/sha256`, {
        method: "POST",
        body: hashBody,
      }),
  },
];

type Stats = {
  count: number;
  errors: number;
  samples: number[];
};

async function worker(
  fn: () => Promise<Response>,
  endAt: number,
  stats: Stats,
): Promise<void> {
  while (Date.now() < endAt) {
    const start = performance.now();

    try {
      const res = await fn();
      await res.arrayBuffer();

      stats.count++;
      stats.samples.push(performance.now() - start);
    } catch {
      stats.errors++;
    }
  }
}

async function runWorkers(
  fn: () => Promise<Response>,
  durationMs: number,
  concurrency: number,
): Promise<Stats> {
  const stats: Stats = {
    count: 0,
    errors: 0,
    samples: [],
  };

  const endAt = Date.now() + durationMs;

  await Promise.all(
    Array.from({ length: concurrency }, () => worker(fn, endAt, stats)),
  );

  return stats;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const index = Math.floor(samples.length * p);
  return samples[Math.min(index, samples.length - 1)] ?? 0;
}

async function benchHttp(caseItem: HttpCase): Promise<void> {
  console.log(`\nBenchmarking ${caseItem.name}`);

  await runWorkers(caseItem.fn, 500, Math.min(10, CONCURRENCY));

  const stats = await runWorkers(caseItem.fn, DURATION_MS, CONCURRENCY);

  stats.samples.sort((a, b) => a - b);

  const totalMs = DURATION_MS;
  const avg =
    stats.samples.length > 0
      ? stats.samples.reduce((a, b) => a + b, 0) / stats.samples.length
      : 0;

  console.log({
    name: caseItem.name,
    requests: stats.count,
    errors: stats.errors,
    reqPerSec: (stats.count / (totalMs / 1000)).toFixed(2),
    avgMs: avg.toFixed(3),
    p50Ms: percentile(stats.samples, 0.5).toFixed(3),
    p95Ms: percentile(stats.samples, 0.95).toFixed(3),
    p99Ms: percentile(stats.samples, 0.99).toFixed(3),
  });
}

for (const caseItem of cases) {
  await benchHttp(caseItem);
}
````

## File: data.ts
````typescript
const encoder = new TextEncoder();

export function jsonRowsBytes(rows: number): Uint8Array {
  const data = Array.from({ length: rows }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    active: i % 2 === 0,
    score: i * 1.25,
    tags: ["alpha", "beta", "gamma"],
    nested: {
      version: i % 10,
      createdAt: "2026-01-01T00:00:00Z",
    },
  }));

  return encoder.encode(JSON.stringify(data));
}

export function productAddBytes(name = "widget"): Uint8Array {
  return encoder.encode(JSON.stringify({ name }));
}

export function productIdBytes(id = "123"): Uint8Array {
  return encoder.encode(id);
}

export function batchBytes(ops: number): Uint8Array {
  const data = Array.from({ length: ops }, (_, i) => {
    if (i % 2 === 0) {
      return {
        id: String(i),
        op: "products.add",
        body: {
          name: `item_${i}`,
        },
      };
    }

    return {
      id: String(i),
      op: "products.get",
      params: {
        id: `id_${i}`,
      },
    };
  });

  return encoder.encode(JSON.stringify(data));
}

export function urlBytes(count: number): Uint8Array {
  const urls = Array.from(
    { length: count },
    (_, i) =>
      `https://sub${i % 255}.example.com:8080/api/v1/items/${i}?q=${encodeURIComponent(
        `user ${i}`,
      )}&page=${i % 50}#section-${i}`,
  );

  return encoder.encode(urls.join("\n"));
}

export function hashBytes(size: number): Uint8Array {
  const base = "Bun Rust FFI runtime benchmark payload. ";
  const repeated = base.repeat(Math.ceil(size / base.length));
  return encoder.encode(repeated.slice(0, size));
}

export function taskBytes(events: number): Uint8Array {
  const data = {
    events: Array.from({ length: events }, (_, i) => ({
      id: i,
      kind: `event_${i % 25}`,
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        index: i,
        value: `value_${i}`,
      },
    })),
  };

  return encoder.encode(JSON.stringify(data));
}
````

## File: index.ts
````typescript
console.log("Hello via Bun!");
````

## File: native.ts
````typescript
import { dlopen, FFIType, suffix } from "bun:ffi";
import * as ffi from "bun:ffi";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ffiPtr = (ffi as any).ptr as
  | undefined
  | ((view: any, byteOffset?: number) => number);

function ptr(view: ArrayBufferView): any {
  if (typeof ffiPtr === "function") return ffiPtr(view);
  const legacyPtr = (view as any).ptr;
  if (typeof legacyPtr === "number") return legacyPtr;
  return view;
}

const candidates = [
  process.env.RUST_BENCH_LIB,
  fileURLToPath(new URL(`./target/release/librust_bench.${suffix}`, import.meta.url)),
  fileURLToPath(new URL(`./target/release/rust_bench.${suffix}`, import.meta.url)),
].filter((x): x is string => typeof x === "string" && x.length > 0);

const libPath = candidates.find((path) => existsSync(path));

if (!libPath) {
  console.error("Could not find Rust shared library.");
  console.error("Run: cargo build --release");
  console.error(`Looked for: ${candidates.join(", ")}`);
  process.exit(1);
}

console.log(`Loading Rust library: ${libPath}`);

const lib = dlopen(libPath, {

    // Practical v2
  rust_json_valid_v2:             { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_json_sum_ids_v2:           { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_http_parse_request_v2:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_query_parse_v2:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_parse_v2:           { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_random_token_v2:           { returns: FFIType.i64, args: [FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_ws_accept_key_v2:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_patch_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_hmac_sha256_verify_v2:     { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_route_match_v2:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_validate_email_v2:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_uuid_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv4_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv6_v2:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_crc32_v2:                  { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u64] },
  rust_fnv1a64_v2:                { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_mime_from_extension_v2:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_encode_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_decode_v2:             { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  // Section 20: Original
  rust_json_sum_ids:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_json_valid:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_products_add:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_products_get_id:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_batch_execute:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr] },
  rust_xxh3_u64:           { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_sha256_u64:         { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_url_sum_host_lens:  { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_prime_count:        { returns: FFIType.u32, args: [FFIType.u32] },
  rust_task_process:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 1: JSON utilities
  rust_json_extract:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_flatten:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_merge:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_patch:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 2: HTTP parsing
  rust_http_parse_request: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_query_parse:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_parse:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_cookie_serialize:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.i64, FFIType.u8, FFIType.u8, FFIType.u8, FFIType.ptr, FFIType.u64] },
  rust_multipart_parse:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_encode:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_decode:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 3: Routing
  rust_route_match:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_route_build:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 4: Validation
  rust_validate_email:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_uuid:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv4:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_ipv6:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_luhn:          { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_validate_jwt_structure: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },

  // Section 5: Crypto
  rust_hmac_sha256:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_hmac_sha256_verify: { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64_encode:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64_decode:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_base64url_encode:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_uuid_v4:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_random_token:       { returns: FFIType.i64, args: [FFIType.u32, FFIType.ptr, FFIType.u64] },

  // Section 6: Compression
  rust_gzip_compress:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_gzip_decompress:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_compression_ratio:  { returns: FFIType.f64, args: [FFIType.ptr, FFIType.u64] },

  // Section 7: String
  rust_html_escape:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_slugify:            { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_template_render:    { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_regex_match:        { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_regex_replace:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_trim:               { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_case_convert:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.ptr, FFIType.u64] },

  // Section 8: Data processing
  rust_json_sort_by:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.ptr, FFIType.u64] },
  rust_json_paginate:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_json_filter:        { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_aggregate:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_group_by:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_json_dedup:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 9: Caching
  rust_rate_limit_check:   { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.f64, FFIType.f64, FFIType.u64, FFIType.f64] },
  rust_etag_generate:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_etag_check:         { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 10: HTTP response
  rust_http_response_build: { returns: FFIType.i64, args: [FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_error_response:      { returns: FFIType.i64, args: [FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 11: CORS & security
  rust_cors_headers:       { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64] },
  rust_security_headers:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },

  // Section 12: WebSocket
  rust_ws_frame_parse:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_ws_frame_build:     { returns: FFIType.i64, args: [FFIType.u8, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_ws_accept_key:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 13: MIME
  rust_mime_from_extension: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_content_negotiate:   { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 14: Logging
  rust_log_format:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_histogram_bucket:   { returns: FFIType.u32, args: [FFIType.u64] },

  // Section 15: Path
  rust_path_normalize:     { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_path_is_safe:       { returns: FFIType.i32, args: [FFIType.ptr, FFIType.u64] },
  rust_path_join:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 16: Search
  rust_binary_search:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.f64] },
  rust_text_search_count:  { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_inverted_index_build: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 17: Math
  rust_crc32:              { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u64] },
  rust_fnv1a_64:           { returns: FFIType.u64, args: [FFIType.ptr, FFIType.u64] },
  rust_itoa:               { returns: FFIType.i64, args: [FFIType.i64, FFIType.ptr, FFIType.u64] },
  rust_atoi:               { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64] },
  rust_format_bytes:       { returns: FFIType.i64, args: [FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 18: Pipeline
  rust_json_pipeline:      { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },

  // Section 19: Connection
  rust_parse_host:         { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_url_build:          { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u16, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
  rust_content_type_parse: { returns: FFIType.i64, args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64] },
});

const symbols = lib.symbols as Record<string, any>;

function callOut(fn: (...a: any[]) => bigint, outSize: number, ...args: any[]): Uint8Array {
  let size = Math.max(1, outSize);
  const maxSize = 256 * 1024 * 1024;

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

    // Rust write_response() returns -2 when the output buffer is too small.
    if (w === -2n) {
      if (size >= maxSize) {
        throw new Error(`FFI call failed: output buffer too large (>${size} bytes)`);
      }

      size = Math.min(size * 2, maxSize);
      continue;
    }

    if (w < 0n) {
      throw new Error(`FFI call failed: ${written}`);
    }

    return out.slice(0, Number(w));
  }
}

export const rust = {
    // Practical v2
  jsonValidV2: (b: Uint8Array) =>
    symbols.rust_json_valid_v2(ptr(b), b.byteLength) as number,

  jsonSumIdsV2: (b: Uint8Array) =>
    symbols.rust_json_sum_ids_v2(ptr(b), b.byteLength) as bigint,

  httpParseRequestV2: (b: Uint8Array) =>
    callOut(symbols.rust_http_parse_request_v2, 64 * 1024, ptr(b), b.byteLength),

  queryParseV2: (b: Uint8Array) =>
    callOut(symbols.rust_query_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  cookieParseV2: (b: Uint8Array) =>
    callOut(symbols.rust_cookie_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  randomTokenV2: (n: number) =>
    callOut(symbols.rust_random_token_v2, n * 2 + 64, n),

  wsAcceptKeyV2: (k: Uint8Array) =>
    callOut(symbols.rust_ws_accept_key_v2, 128, ptr(k), k.byteLength),

  jsonPatchV2: (doc: Uint8Array, patch: Uint8Array) =>
    callOut(
      symbols.rust_json_patch_v2,
      doc.byteLength + patch.byteLength + 4096,
      ptr(doc),
      doc.byteLength,
      ptr(patch),
      patch.byteLength,
    ),

  hmacSha256VerifyV2: (k: Uint8Array, d: Uint8Array, s: Uint8Array) =>
    symbols.rust_hmac_sha256_verify_v2(
      ptr(k),
      k.byteLength,
      ptr(d),
      d.byteLength,
      ptr(s),
      s.byteLength,
    ) as number,

  routeMatchV2: (pattern: Uint8Array, path: Uint8Array) =>
    callOut(
      symbols.rust_route_match_v2,
      4096,
      ptr(pattern),
      pattern.byteLength,
      ptr(path),
      path.byteLength,
    ),

  validateEmailV2: (b: Uint8Array) =>
    symbols.rust_validate_email_v2(ptr(b), b.byteLength) as number,

  validateUuidV2: (b: Uint8Array) =>
    symbols.rust_validate_uuid_v2(ptr(b), b.byteLength) as number,

  validateIpv4V2: (b: Uint8Array) =>
    symbols.rust_validate_ipv4_v2(ptr(b), b.byteLength) as number,

  validateIpv6V2: (b: Uint8Array) =>
    symbols.rust_validate_ipv6_v2(ptr(b), b.byteLength) as number,

  crc32V2: (b: Uint8Array) =>
    symbols.rust_crc32_v2(ptr(b), b.byteLength) as number,

  fnv1a64V2: (b: Uint8Array) =>
    symbols.rust_fnv1a64_v2(ptr(b), b.byteLength) as bigint,

  mimeFromExtensionV2: (ext: Uint8Array) =>
    callOut(symbols.rust_mime_from_extension_v2, 256, ptr(ext), ext.byteLength),

  urlEncodeV2: (b: Uint8Array) =>
    callOut(symbols.rust_url_encode_v2, b.byteLength * 3 + 64, ptr(b), b.byteLength),

  urlDecodeV2: (b: Uint8Array) =>
    callOut(symbols.rust_url_decode_v2, b.byteLength + 64, ptr(b), b.byteLength),
  // Original
  jsonSumIds:     (b: Uint8Array) => symbols.rust_json_sum_ids(ptr(b), b.byteLength) as bigint,
  jsonValid:      (b: Uint8Array) => symbols.rust_json_valid(ptr(b), b.byteLength) as number,
  productsAdd:    (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_products_add(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  productsGetId:  (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_products_get_id(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  batchExecute:   (b: Uint8Array, o: Uint8Array, s: Uint16Array) => symbols.rust_batch_execute(ptr(b), b.byteLength, ptr(o), o.byteLength, ptr(s)) as bigint,
  xxh3:           (b: Uint8Array) => symbols.rust_xxh3_u64(ptr(b), b.byteLength) as bigint,
  sha256:         (b: Uint8Array) => symbols.rust_sha256_u64(ptr(b), b.byteLength) as bigint,
  urlSumHostLens: (b: Uint8Array) => symbols.rust_url_sum_host_lens(ptr(b), b.byteLength) as bigint,
  primeCount:     (n: number) => symbols.rust_prime_count(n) as number,
  taskProcess:    (b: Uint8Array, o: Uint8Array) => symbols.rust_task_process(ptr(b), b.byteLength, ptr(o), o.byteLength) as bigint,

  // JSON utilities
  jsonExtract:  (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_extract, 64 * 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonFlatten:  (b: Uint8Array) => callOut(symbols.rust_json_flatten, b.byteLength * 3 + 4096, ptr(b), b.byteLength),
  jsonMerge:    (a: Uint8Array, b: Uint8Array) => callOut(symbols.rust_json_merge, a.byteLength + b.byteLength + 4096, ptr(a), a.byteLength, ptr(b), b.byteLength),
  jsonPatch:    (d: Uint8Array, p: Uint8Array) => callOut(symbols.rust_json_patch, d.byteLength + p.byteLength + 4096, ptr(d), d.byteLength, ptr(p), p.byteLength),

  // HTTP parsing
  httpParseRequest: (b: Uint8Array) => callOut(symbols.rust_http_parse_request, 64 * 1024, ptr(b), b.byteLength),
  queryParse:       (b: Uint8Array) => callOut(symbols.rust_query_parse, 64 * 1024, ptr(b), b.byteLength),
  cookieParse:      (b: Uint8Array) => callOut(symbols.rust_cookie_parse, 64 * 1024, ptr(b), b.byteLength),
  cookieSerialize:  (n: Uint8Array, v: Uint8Array, ma: number, sec: number, ho: number, ss: number) => callOut(symbols.rust_cookie_serialize, 4096, ptr(n), n.byteLength, ptr(v), v.byteLength, ma, sec, ho, ss),
  multipartParse:   (b: Uint8Array, boundary: Uint8Array) => callOut(symbols.rust_multipart_parse, 256 * 1024, ptr(b), b.byteLength, ptr(boundary), boundary.byteLength),
  urlEncode:        (b: Uint8Array) => callOut(symbols.rust_url_encode, b.byteLength * 3 + 64, ptr(b), b.byteLength),
  urlDecode:        (b: Uint8Array) => callOut(symbols.rust_url_decode, b.byteLength + 64, ptr(b), b.byteLength),

  // Routing
  routeMatch: (p: Uint8Array, path: Uint8Array) => callOut(symbols.rust_route_match, 4096, ptr(p), p.byteLength, ptr(path), path.byteLength),
  routeBuild: (p: Uint8Array, params: Uint8Array) => callOut(symbols.rust_route_build, 4096, ptr(p), p.byteLength, ptr(params), params.byteLength),

  // Validation
  validateEmail:        (b: Uint8Array) => symbols.rust_validate_email(ptr(b), b.byteLength) as number,
  validateUuid:         (b: Uint8Array) => symbols.rust_validate_uuid(ptr(b), b.byteLength) as number,
  validateIpv4:         (b: Uint8Array) => symbols.rust_validate_ipv4(ptr(b), b.byteLength) as number,
  validateIpv6:         (b: Uint8Array) => symbols.rust_validate_ipv6(ptr(b), b.byteLength) as number,
  validateLuhn:         (b: Uint8Array) => symbols.rust_validate_luhn(ptr(b), b.byteLength) as number,
  validateJwtStructure: (b: Uint8Array) => symbols.rust_validate_jwt_structure(ptr(b), b.byteLength) as number,

  // Crypto
  hmacSha256:       (k: Uint8Array, d: Uint8Array) => callOut(symbols.rust_hmac_sha256, 4096, ptr(k), k.byteLength, ptr(d), d.byteLength),
  hmacSha256Verify: (k: Uint8Array, d: Uint8Array, s: Uint8Array) => symbols.rust_hmac_sha256_verify(ptr(k), k.byteLength, ptr(d), d.byteLength, ptr(s), s.byteLength) as number,
  base64Encode:     (b: Uint8Array) => callOut(symbols.rust_base64_encode, b.byteLength * 2 + 64, ptr(b), b.byteLength),
  base64Decode:     (b: Uint8Array) => callOut(symbols.rust_base64_decode, b.byteLength + 64, ptr(b), b.byteLength),
  base64UrlEncode:  (b: Uint8Array) => callOut(symbols.rust_base64url_encode, b.byteLength * 2 + 64, ptr(b), b.byteLength),
  uuidV4:           () => callOut(symbols.rust_uuid_v4, 64),
  randomToken:      (n: number) => callOut(symbols.rust_random_token, n * 2 + 64, n),

  // Compression
  gzipCompress:     (b: Uint8Array) => callOut(symbols.rust_gzip_compress, b.byteLength * 2 + 1024, ptr(b), b.byteLength),
gzipDecompress: (b: Uint8Array) => {
  // Default heuristic if we cannot read the gzip trailer.
  let outSize = b.byteLength * 10 + 1024;

  // Gzip files end with:
  //   CRC32 (4 bytes) + ISIZE (4 bytes, little-endian uncompressed size mod 2^32)
  if (b.byteLength >= 4) {
    const view = new DataView(
      b.buffer as ArrayBuffer,
      b.byteOffset + b.byteLength - 4,
      4,
    );
    const uncompressedHint = view.getUint32(0, true);
    outSize = Math.max(outSize, uncompressedHint + 1024);
  }

  return callOut(
    symbols.rust_gzip_decompress,
    outSize,
    ptr(b),
    b.byteLength,
  );
},  compressionRatio: (b: Uint8Array) => symbols.rust_compression_ratio(ptr(b), b.byteLength) as number,

  // String
  htmlEscape:     (b: Uint8Array) => callOut(symbols.rust_html_escape, b.byteLength * 6 + 64, ptr(b), b.byteLength),
  slugify:        (b: Uint8Array) => callOut(symbols.rust_slugify, b.byteLength + 64, ptr(b), b.byteLength),
  templateRender: (t: Uint8Array, d: Uint8Array) => callOut(symbols.rust_template_render, 256 * 1024, ptr(t), t.byteLength, ptr(d), d.byteLength),
  regexMatch:     (p: Uint8Array, t: Uint8Array) => symbols.rust_regex_match(ptr(p), p.byteLength, ptr(t), t.byteLength) as number,
  regexReplace:   (p: Uint8Array, r: Uint8Array, t: Uint8Array) => callOut(symbols.rust_regex_replace, 256 * 1024, ptr(p), p.byteLength, ptr(r), r.byteLength, ptr(t), t.byteLength),
  trim:           (b: Uint8Array) => callOut(symbols.rust_trim, b.byteLength + 64, ptr(b), b.byteLength),
  caseConvert:    (b: Uint8Array, m: number) => callOut(symbols.rust_case_convert, b.byteLength * 4 + 64, ptr(b), b.byteLength, m),

  // Data processing
  jsonSortBy:    (b: Uint8Array, k: Uint8Array, d: number) => callOut(symbols.rust_json_sort_by, b.byteLength * 2 + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength, d),
  jsonPaginate:  (b: Uint8Array, pg: number, pp: number) => callOut(symbols.rust_json_paginate, b.byteLength + 4096, ptr(b), b.byteLength, pg, pp),
  jsonFilter:    (b: Uint8Array, k: Uint8Array, v: Uint8Array) => callOut(symbols.rust_json_filter, b.byteLength + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength, ptr(v), v.byteLength),
  jsonAggregate: (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_aggregate, 4096, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonGroupBy:   (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_group_by, b.byteLength * 2 + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),
  jsonDedup:     (b: Uint8Array, k: Uint8Array) => callOut(symbols.rust_json_dedup, b.byteLength + 1024, ptr(b), b.byteLength, ptr(k), k.byteLength),

  // Caching
  rateLimitCheck: (sp: any, sl: number, cap: number, rr: number, now: number, cost: number) => symbols.rust_rate_limit_check(sp, sl, cap, rr, now, cost) as number,
  etagGenerate:   (b: Uint8Array) => callOut(symbols.rust_etag_generate, 64, ptr(b), b.byteLength),
  etagCheck:      (e: Uint8Array, h: Uint8Array) => symbols.rust_etag_check(ptr(e), e.byteLength, ptr(h), h.byteLength) as number,

  // HTTP response
  httpResponseBuild: (st: number, body: Uint8Array, ct: Uint8Array, eh: Uint8Array) => {
    const out = new Uint8Array(body.byteLength + 4096);
    const w = symbols.rust_http_response_build(st, ptr(body), body.byteLength, ptr(ct), ct.byteLength, ptr(eh), eh.byteLength, ptr(out), out.byteLength) as bigint;
    if (w < 0) throw new Error(`FFI failed: ${w}`);
    return out.slice(0, Number(w));
  },
  errorResponse: (st: number, msg: Uint8Array, code: Uint8Array) => callOut(symbols.rust_error_response, 4096, st, ptr(msg), msg.byteLength, ptr(code), code.byteLength),

  // CORS & security
  corsHeaders:     (o: Uint8Array, a: Uint8Array, m: Uint8Array, ma: number) => callOut(symbols.rust_cors_headers, 4096, ptr(o), o.byteLength, ptr(a), a.byteLength, ptr(m), m.byteLength, ma),
  securityHeaders: () => callOut(symbols.rust_security_headers, 4096),

  // WebSocket
  wsFrameParse: (b: Uint8Array) => callOut(symbols.rust_ws_frame_parse, 4096, ptr(b), b.byteLength),
  wsFrameBuild: (op: number, p: Uint8Array) => callOut(symbols.rust_ws_frame_build, p.byteLength + 16, op, ptr(p), p.byteLength),
  wsAcceptKey:  (k: Uint8Array) => callOut(symbols.rust_ws_accept_key, 128, ptr(k), k.byteLength),

  // MIME
  mimeFromExtension: (e: Uint8Array) => callOut(symbols.rust_mime_from_extension, 256, ptr(e), e.byteLength),
  contentNegotiate:  (a: Uint8Array, av: Uint8Array) => callOut(symbols.rust_content_negotiate, 256, ptr(a), a.byteLength, ptr(av), av.byteLength),

  // Logging
  logFormat:       (l: Uint8Array, m: Uint8Array, c: Uint8Array, r: Uint8Array) => callOut(symbols.rust_log_format, 64 * 1024, ptr(l), l.byteLength, ptr(m), m.byteLength, ptr(c), c.byteLength, ptr(r), r.byteLength),
  histogramBucket: (d: number) => symbols.rust_histogram_bucket(d) as number,

  // Path
  pathNormalize: (b: Uint8Array) => callOut(symbols.rust_path_normalize, 4096, ptr(b), b.byteLength),
  pathIsSafe:    (b: Uint8Array) => symbols.rust_path_is_safe(ptr(b), b.byteLength) as number,
  pathJoin:      (base: Uint8Array, seg: Uint8Array) => callOut(symbols.rust_path_join, 4096, ptr(base), base.byteLength, ptr(seg), seg.byteLength),

  // Search
  binarySearch:       (b: Uint8Array, t: number) => symbols.rust_binary_search(ptr(b), b.byteLength, t) as bigint,
  textSearchCount:    (t: Uint8Array, term: Uint8Array) => symbols.rust_text_search_count(ptr(t), t.byteLength, ptr(term), term.byteLength) as bigint,
  invertedIndexBuild: (b: Uint8Array) => callOut(symbols.rust_inverted_index_build, 2 * 1024 * 1024, ptr(b), b.byteLength),

  // Math
  crc32:       (b: Uint8Array) => symbols.rust_crc32(ptr(b), b.byteLength) as number,
  fnv1a64:     (b: Uint8Array) => symbols.rust_fnv1a_64(ptr(b), b.byteLength) as bigint,
  itoa:        (v: number) => callOut(symbols.rust_itoa, 64, v),
  atoi:        (b: Uint8Array) => symbols.rust_atoi(ptr(b), b.byteLength) as bigint,
  formatBytes: (n: number) => callOut(symbols.rust_format_bytes, 64, n),

  // Pipeline
  jsonPipeline: (d: Uint8Array, ops: Uint8Array) => callOut(symbols.rust_json_pipeline, d.byteLength * 2 + 4096, ptr(d), d.byteLength, ptr(ops), ops.byteLength),

  // Connection
  parseHost:        (b: Uint8Array) => callOut(symbols.rust_parse_host, 4096, ptr(b), b.byteLength),
  urlBuild:         (s: Uint8Array, h: Uint8Array, p: number, path: Uint8Array, q: Uint8Array) => callOut(symbols.rust_url_build, 8192, ptr(s), s.byteLength, ptr(h), h.byteLength, p, ptr(path), path.byteLength, ptr(q), q.byteLength),
  contentTypeParse: (b: Uint8Array) => callOut(symbols.rust_content_type_parse, 4096, ptr(b), b.byteLength),
};
````

## File: package.json
````json
{
  "name": "bun-rust-runtime-bench",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "cargo build --release",
    "bench": "bun run build && bun bench.ts",
    "serve": "bun run build && bun server.ts",
    "client": "bun client.ts",
    "task": "bun run build && bun task-bench.ts",
    "bench:practical": "bun run build && bun bench-practical.ts"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "@types/mime-types": "^3.0.1",
    "@types/validator": "^13.15.10"
  },
  "peerDependencies": {
    "typescript": "^6"
  },
  "dependencies": {
    "cookie-es": "^3.1.1",
    "crc-32": "^1.2.2",
    "fast-json-patch": "^3.1.1",
    "find-my-way": "^9.7.0",
    "jose": "^6.2.4",
    "mime-types": "^3.0.2",
    "validator": "^13.15.35",
    "zod": "^4.4.3"
  }
}
````

## File: README.md
````markdown
# bun-rust-runtime-bench

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
````

## File: repomix.config.json
````json
{
  "$schema": "https://repomix.com/schemas/latest/schema.json",
  "input": {
    "maxFileSize": 52428800
  },
  "output": {
    "filePath": "repomix-output.md",
    "style": "markdown",
    "filePathStyle": "target-relative",
    "parsableStyle": false,
    "fileSummary": true,
    "directoryStructure": true,
    "files": true,
    "removeComments": false,
    "removeEmptyLines": false,
    "compress": false,
    "topFilesLength": 5,
    "showLineNumbers": false,
    "truncateBase64": false,
    "copyToClipboard": false,
    "includeFullDirectoryStructure": false,
    "tokenCountTree": false,
    "git": {
      "sortByChanges": true,
      "sortByChangesMaxCommits": 100,
      "includeDiffs": false,
      "includeLogs": false,
      "includeLogsCount": 50
    }
  },
  "include": [],
  "ignore": {
    "useGitignore": true,
    "useDotIgnore": true,
    "useDefaultPatterns": true,
    "customPatterns": []
  },
  "security": {
    "enableSecurityCheck": true
  },
  "tokenCount": {
    "encoding": "o200k_base"
  }
}
````

## File: server.ts
````typescript
import { rust } from "./native";
import { encoder, nativeBatch, nativeSha256U64, xxhash3U64 } from "./shared";

const jsonHeaders = {
    "content-type": "application/json; charset=utf-8",
};

const productId123 = encoder.encode("123");

const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    routes: {
        "/native/products/add": {
            POST: async (req) => {
                const body = await req.json();

                return Response.json(
                    {
                        created: true,
                        body,
                    },
                    { status: 201 },
                );
            },
        },

        "/rust/products/add": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());
                const out = new Uint8Array(256 * 1024);
                const status = new Uint16Array(1);

                const written = rust.productsAdd(bytes, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust handler failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 201,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/products/123": {
            GET: () => {
                return Response.json({
                    product: {
                        id: "123",
                    },
                });
            },
        },

        "/rust/products/123": {
            GET: () => {
                const out = new Uint8Array(64 * 1024);
                const status = new Uint16Array(1);

                const written = rust.productsGetId(productId123, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust handler failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 200,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/batch": {
            POST: async (req) => {
                const ops: unknown = await req.json();

                if (!Array.isArray(ops)) {
                    return Response.json(
                        { error: "Invalid batch payload" },
                        { status: 400 },
                    );
                }

                return Response.json(nativeBatch(ops));
            },
        },

        "/rust/batch": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());
                const out = new Uint8Array(2 * 1024 * 1024);
                const status = new Uint16Array(1);

                const written = rust.batchExecute(bytes, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust batch failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 200,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/hash": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: String(xxhash3U64(bytes))
                });
            },
        },

        "/rust/hash": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: String(rust.xxh3(bytes)),
                });
            },
        },

        "/native/sha256": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: nativeSha256U64(bytes).toString(16),
                });
            },
        },

        "/rust/sha256": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: rust.sha256(bytes).toString(16),
                });
            },
        },
    },

    fetch() {
        return new Response("Not found", { status: 404 });
    },
});

console.log(`Benchmark server listening on http://localhost:${server.port}`);
````

## File: shared-practical.ts
````typescript
// shared-practical.ts
import { decoder, encoder } from "./shared";

import { parse as parseCookie } from "cookie-es";
import { applyPatch } from "fast-json-patch";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import mime from "mime-types";
import validator from "validator";
import createRouter from "find-my-way";
import * as CRC32 from "crc-32";

function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function nativeJsonValidV2(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSumV2(bytes: Uint8Array): bigint {
  const rows = JSON.parse(decoder.decode(bytes)) as Array<{ id: number }>;
  let sum = 0n;

  for (const row of rows) {
    if (typeof row.id === "number") {
      sum += BigInt(Math.trunc(row.id));
    }
  }

  return sum;
}

// ---------------------------------------------------------------------------
// HTTP parsing
// ---------------------------------------------------------------------------

export function nativeHttpParseRequestV2(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const lines = head.split("\r\n");

  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = ""] = requestLine.split(" ");

  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      headers.append(name, value);
    }
  }

  let path = target;

  try {
    const url = new URL(target, "http://internal");
    path = url.pathname + url.search;
  } catch {
    // keep raw target
  }

  return encoder.encode(
    JSON.stringify({
      method,
      path,
      version,
      headers: Object.fromEntries(headers.entries()),
    }),
  );
}

export function nativeQueryParseV2(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);

  const obj: Record<string, string | string[]> = {};

  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    obj[key] = values.length === 1 ? (values[0] ?? "") : values;
  }

  return encoder.encode(JSON.stringify(obj));
}

export function nativeCookieParseV2(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies = parseCookie(text);
  return encoder.encode(JSON.stringify(cookies));
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export function nativeRandomTokenV2(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return encoder.encode(Buffer.from(bytes).toString("hex"));
}

export function nativeWsAcceptKeyV2(key: string): Uint8Array {
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(key + magic);

  const hash = new Bun.CryptoHasher("sha1")
    .update(toPlainBuffer(combined))
    .digest();

  return encoder.encode(Buffer.from(hash).toString("base64"));
}

export function nativeHmacSha256V2(
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const hex = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest("hex");

  return encoder.encode(hex);
}

export function nativeHmacSha256VerifyV2(
  key: Uint8Array,
  data: Uint8Array,
  sig: Uint8Array,
): boolean {
  const expected = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest();

  const providedHex = decoder.decode(sig).trim();

  if (!/^[0-9a-fA-F]*$/.test(providedHex)) {
    return false;
  }

  const provided = Buffer.from(providedHex, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// JSON Patch
// ---------------------------------------------------------------------------

export function nativeJsonPatchV2(
  docBytes: Uint8Array,
  patchBytes: Uint8Array,
): Uint8Array {
  const doc = JSON.parse(decoder.decode(docBytes));
  const patch = JSON.parse(decoder.decode(patchBytes));

  const result = applyPatch(doc, patch, true, false).newDocument;

  return encoder.encode(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function nativeRouteMatchV2(
  pattern: string,
  path: string,
): Uint8Array | null {
  try {
    const router = createRouter({
      ignoreTrailingSlash: false,
      allowUnsafeRegex: false,
    });

    router.on("GET", pattern, () => {});

    const route = router.find("GET", path);

    if (!route) {
      return null;
    }

    return encoder.encode(JSON.stringify(route.params));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function nativeValidateEmailV2(bytes: Uint8Array): boolean {
  return validator.isEmail(decoder.decode(bytes));
}

export function nativeValidateUuidV2(bytes: Uint8Array): boolean {
  return validator.isUUID(decoder.decode(bytes), 4);
}

export function nativeValidateIpv4V2(bytes: Uint8Array): boolean {
  return validator.isIP(decoder.decode(bytes), 4);
}

export function nativeValidateIpv6V2(bytes: Uint8Array): boolean {
  return isIP(decoder.decode(bytes)) === 6;
}

export function nativeValidateLuhnV2(bytes: Uint8Array): boolean {
  return validator.isCreditCard(decoder.decode(bytes));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function nativeCrc32V2(bytes: Uint8Array): number {
  return CRC32.buf(bytes) >>> 0;
}

export function nativeFnv1a64V2(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash;
}

// ---------------------------------------------------------------------------
// MIME / URL
// ---------------------------------------------------------------------------

export function nativeMimeFromExtensionV2(ext: string): string {
  return mime.lookup(ext) || "application/octet-stream";
}

export function nativeUrlEncodeV2(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return encodeURIComponent(text);
}

export function nativeUrlDecodeV2(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return decodeURIComponent(text);
}
````

## File: shared.ts
````typescript
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/** Ensure a Uint8Array is backed by a plain ArrayBuffer (not SharedArrayBuffer). */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

// ===========================================================================
// EXISTING FUNCTIONS
// ===========================================================================

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const text = decoder.decode(bytes);
  const rows = JSON.parse(text) as Array<{ id: number }>;
  let sum = 0;
  for (const row of rows) {
    sum += row.id;
  }
  return BigInt(sum);
}

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeProductsAddBytes(bytes: Uint8Array): Uint8Array {
  const body = JSON.parse(decoder.decode(bytes));
  return encoder.encode(JSON.stringify({ created: true, body }));
}

export function nativeProductsGetIdBytes(id: string): Uint8Array {
  return encoder.encode(JSON.stringify({ product: { id } }));
}

export function nativeBatch(ops: any[]): any[] {
  return ops.map((op) => {
    switch (op?.op) {
      case "products.add":
        return { id: String(op?.id ?? ""), status: 201, body: { created: true, body: op?.body ?? {} } };
      case "products.get":
        return { id: String(op?.id ?? ""), status: 200, body: { product: { id: String(op?.params?.id ?? "") } } };
      default:
        return { id: String(op?.id ?? ""), status: 404, body: { error: "Unknown op" } };
    }
  });
}

export function nativeBatchBytes(bytes: Uint8Array): Uint8Array {
  const ops = JSON.parse(decoder.decode(bytes));
  return encoder.encode(JSON.stringify(nativeBatch(ops)));
}

export function nativeUrlSumHostLens(bytes: Uint8Array): bigint {
  const text = decoder.decode(bytes);
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      sum += new URL(line).hostname.length;
    } catch {
      // ignore
    }
  }
  return BigInt(sum);
}

export function nativePrimeCount(limit: number): number {
  if (limit < 2) return 0;
  const isPrime = new Uint8Array(limit + 1).fill(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let p = 2; p * p <= limit; p++) {
    if (isPrime[p]) {
      for (let m = p * p; m <= limit; m += p) isPrime[m] = 0;
    }
  }
  let count = 0;
  for (let i = 2; i <= limit; i++) if (isPrime[i]) count++;
  return count;
}

export function nativeHashU64(bytes: Uint8Array): bigint {
  return xxhash3U64(bytes);
}

export function nativeSha256U64(bytes: Uint8Array): bigint {
  const digest = new Bun.CryptoHasher("sha256").update(toBuffer(bytes)).digest();
  const digestBytes = new Uint8Array(
    (digest as Uint8Array).buffer as ArrayBuffer,
    (digest as Uint8Array).byteOffset,
    (digest as Uint8Array).byteLength,
  );
  return new DataView(
    digestBytes.buffer,
    digestBytes.byteOffset,
    digestBytes.byteLength,
  ).getBigUint64(0, false);
}

export function nativeTaskProcess(bytes: Uint8Array): Uint8Array {
  const input = JSON.parse(decoder.decode(bytes)) as { events: Array<{ id: number }> };
  let sum = 0;
  for (const event of input.events) sum += event.id;

  return encoder.encode(
    JSON.stringify({
      count: input.events.length,
      sum,
      hash: String(xxhash3U64(bytes)),
    }),
  );
}
// ===========================================================================
// HTTP PARSING
// ===========================================================================

export function nativeHttpParseRequest(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const lines = text.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  const method = parts[0] ?? "";
  const path = parts[1] ?? "";
  const version = parts[2] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) break;
    const colonIdx = line.indexOf(":");
    if (colonIdx >= 0) {
      headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
    }
  }
  return encoder.encode(JSON.stringify({ method, path, version, headers }));
}

export function nativeQueryParse(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const params: Record<string, any> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    const key = decodeURIComponent(eqIdx >= 0 ? pair.slice(0, eqIdx) : pair);
    const value = decodeURIComponent(eqIdx >= 0 ? pair.slice(eqIdx + 1) : "");
    if (key.endsWith("[]")) {
      const arrKey = key.slice(0, -2);
      if (!Array.isArray(params[arrKey])) params[arrKey] = [];
      params[arrKey].push(value);
    } else {
      params[key] = value;
    }
  }
  return encoder.encode(JSON.stringify(params));
}

export function nativeCookieParse(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies: Record<string, string> = {};
  for (const pair of text.split(";")) {
    const trimmed = pair.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx >= 0) {
      cookies[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return encoder.encode(JSON.stringify(cookies));
}

export function nativeCookieSerialize(
  name: string, value: string, maxAge: number,
  secure: boolean, httpOnly: boolean, sameSite: number,
): Uint8Array {
  let cookie = `${name}=${value}`;
  if (maxAge >= 0) cookie += `; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  if (httpOnly) cookie += "; HttpOnly";
  const ss = sameSite === 1 ? "Lax" : sameSite === 2 ? "Strict" : "None";
  cookie += `; SameSite=${ss}; Path=/`;
  return encoder.encode(cookie);
}

export function nativeUrlEncode(text: string): string {
  return encodeURIComponent(text);
}

export function nativeUrlDecode(text: string): string {
  return decodeURIComponent(text);
}

// ===========================================================================
// ROUTING
// ===========================================================================

export function nativeRouteMatch(pattern: string, path: string): Uint8Array | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  const lastPattern = patternSegments[patternSegments.length - 1];
  if (patternSegments.length !== pathSegments.length) {
    if (lastPattern !== "*") return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patSeg = patternSegments[i] ?? "";
    if (patSeg === "*") {
      params["*"] = pathSegments.slice(i).join("/");
      break;
    }
    if (i >= pathSegments.length) return null;
    const pathSeg = pathSegments[i] ?? "";
    if (patSeg.startsWith(":")) {
      params[patSeg.slice(1)] = pathSeg;
    } else if (patSeg !== pathSeg) {
      return null;
    }
  }
  return encoder.encode(JSON.stringify(params));
}

export function nativeRouteBuild(pattern: string, params: Record<string, string>): Uint8Array {
  let result = pattern;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, value);
  }
  return encoder.encode(result);
}

// ===========================================================================
// VALIDATION
// ===========================================================================

export function nativeValidateEmail(bytes: Uint8Array): boolean {
  const email = decoder.decode(bytes);
  if (email.length < 3 || email.length > 254) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (!local || local.length > 64 || !domain || domain.length > 253) return false;
  if (!domain.includes(".")) return false;
  return /^[a-zA-Z0-9._%+-]+$/.test(local) && /^[a-zA-Z0-9.-]+$/.test(domain);
}

export function nativeValidateUuid(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
}

export function nativeValidateIpv4(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const octets = text.split(".");
  if (octets.length !== 4) return false;
  return octets.every((o) => {
    if (!o || o.length > 3) return false;
    const n = Number(o);
    return Number.isInteger(n) && n >= 0 && n <= 255 && (o.length === 1 || o[0] !== "0");
  });
}

export function nativeValidateIpv6(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const parts = text.split("::");
  if (parts.length > 2) return false;
  let totalGroups = 0;
  for (const part of parts) {
    if (!part) continue;
    const groups = part.split(":");
    for (const group of groups) {
      if (!group || group.length > 4) return false;
      if (!/^[0-9a-fA-F]+$/.test(group)) return false;
      totalGroups++;
    }
  }
  if (parts.length === 2) return totalGroups <= 7;
  return totalGroups === 8;
}

export function nativeValidateLuhn(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const digits = text.replace(/\D/g, "").split("").map(Number);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i] ?? 0;
    if (alternate) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function nativeValidateJwtStructure(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const parts = text.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[a-zA-Z0-9\-_=]+$/.test(p));
}

// ===========================================================================
// CRYPTO & ENCODING
// ===========================================================================

export function nativeHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const hmac = new Bun.CryptoHasher("sha256", toBuffer(key));
  hmac.update(toBuffer(data));
  const hex = hmac.digest("hex");
  return encoder.encode(hex);
}

export function nativeHmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  const expected = decoder.decode(nativeHmacSha256(key, data));
  const provided = decoder.decode(sig);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export function nativeBase64Encode(bytes: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(bytes).toString("base64"));
}

export function nativeBase64Decode(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(decoder.decode(bytes), "base64"));
}

export function nativeBase64UrlEncode(bytes: Uint8Array): Uint8Array {
  const b64 = Buffer.from(bytes).toString("base64");
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return encoder.encode(urlSafe);
}

export function nativeUuidV4(): string {
  return crypto.randomUUID();
}

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return encoder.encode(hex);
}

// ===========================================================================
// COMPRESSION
// ===========================================================================

export function nativeGzipCompress(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.gzipSync(toBuffer(bytes)));
}

export function nativeGzipDecompress(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.gunzipSync(toBuffer(bytes)));
}

export function nativeCompressionRatio(bytes: Uint8Array): number {
  const compressed = nativeGzipCompress(bytes);
  return compressed.length / bytes.length;
}

// ===========================================================================
// STRING PROCESSING
// ===========================================================================

export function nativeHtmlEscape(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
  return encoder.encode(escaped);
}

export function nativeSlugify(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes).toLowerCase();
  const slug = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return encoder.encode(slug);
}

export function nativeTemplateRender(template: string, data: Record<string, any>): Uint8Array {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`{{${key}}}`, String(value));
  }
  return encoder.encode(result);
}

export function nativeRegexMatch(pattern: string, text: string): boolean {
  return new RegExp(pattern).test(text);
}

export function nativeRegexReplace(pattern: string, replacement: string, text: string): Uint8Array {
  const result = text.replace(new RegExp(pattern, "g"), replacement);
  return encoder.encode(result);
}

export function nativeTrim(bytes: Uint8Array): Uint8Array {
  return encoder.encode(decoder.decode(bytes).trim());
}

export function nativeCaseConvert(bytes: Uint8Array, mode: number): Uint8Array {
  const text = decoder.decode(bytes);
  let result: string;
  switch (mode) {
    case 0: result = text.toLowerCase(); break;
    case 1: result = text.toUpperCase(); break;
    case 2:
      result = text.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase());
      break;
    default: result = text;
  }
  return encoder.encode(result);
}

// ===========================================================================
// DATA PROCESSING
// ===========================================================================

export function nativeJsonSortBy(bytes: Uint8Array, key: string, descending: boolean): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  arr.sort((a: any, b: any) => {
    const diff = (a[key] ?? 0) - (b[key] ?? 0);
    return descending ? -diff : diff;
  });
  return encoder.encode(JSON.stringify(arr));
}

export function nativeJsonPaginate(bytes: Uint8Array, page: number, perPage: number): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const total = arr.length;
  const totalPages = Math.ceil(total / perPage);
  const start = (page - 1) * perPage;
  const data = arr.slice(start, start + perPage);
  return encoder.encode(JSON.stringify({ data, total, page, per_page: perPage, total_pages: totalPages }));
}

export function nativeJsonFilter(bytes: Uint8Array, key: string, value: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const filtered = arr.filter((item) => String(item[key] ?? "") === value);
  return encoder.encode(JSON.stringify(filtered));
}

export function nativeJsonAggregate(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const values: number[] = [];
  for (const item of arr) {
    const v = item[key];
    if (typeof v === "number") values.push(v);
  }
  if (values.length === 0) {
    return encoder.encode(JSON.stringify({ count: 0, sum: 0, avg: 0, min: 0, max: 0 }));
  }
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return encoder.encode(JSON.stringify({ count: values.length, sum, avg: sum / values.length, min, max }));
}

export function nativeJsonGroupBy(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const groups: Record<string, any[]> = {};
  for (const item of arr) {
    const groupKey = String(item[key] ?? "null");
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(item);
  }
  return encoder.encode(JSON.stringify(groups));
}

export function nativeJsonDedup(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of arr) {
    const k = JSON.stringify(item[key]);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return encoder.encode(JSON.stringify(result));
}

// ===========================================================================
// CACHING & RATE LIMITING
// ===========================================================================

export function nativeRateLimitCheck(
  state: { tokens: number; lastRefillMs: number },
  capacity: number, refillRate: number, nowMs: number, cost: number,
): boolean {
  const elapsedSecs = (nowMs - state.lastRefillMs) / 1000;
  const newTokens = Math.min(state.tokens + elapsedSecs * refillRate, capacity);
  if (newTokens >= cost) {
    state.tokens = newTokens - cost;
    state.lastRefillMs = nowMs;
    return true;
  }
  state.tokens = newTokens;
  state.lastRefillMs = nowMs;
  return false;
}

export function xxhash3U64(bytes: Uint8Array): bigint {
  return BigInt(Bun.hash.xxHash64(bytes));
}

export function nativeEtagGenerate(bytes: Uint8Array): string {
  return `"${xxhash3U64(bytes).toString(16).padStart(16, "0")}"`;
}

export function nativeEtagCheck(etag: string, header: string): boolean {
  for (const candidate of header.split(",")) {
    const trimmed = candidate.trim();
    if (trimmed === "*" || trimmed === etag.trim()) return true;
  }
  return false;
}

// ===========================================================================
// HTTP RESPONSE
// ===========================================================================

export function nativeHttpResponseBuild(
  status: number, body: Uint8Array, contentType: string, extraHeaders: string,
): Uint8Array {
  const statusTexts: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
    422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  };
  const statusText = statusTexts[status] ?? "Unknown";
  let header = `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n`;
  if (extraHeaders) {
    header += extraHeaders;
    if (!extraHeaders.endsWith("\r\n")) header += "\r\n";
  }
  header += "Connection: keep-alive\r\n\r\n";
  const headerBytes = encoder.encode(header);
  const result = new Uint8Array(headerBytes.length + body.length);
  result.set(headerBytes);
  result.set(body, headerBytes.length);
  return result;
}

export function nativeErrorResponse(status: number, message: string, code: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    error: { status, code, message, timestamp: new Date().toISOString() },
  }));
}

// ===========================================================================
// CORS & SECURITY
// ===========================================================================

export function nativeCorsHeaders(
  origin: string, allowed: string, methods: string, maxAge: number,
): Uint8Array {
  const allowedOrigins = allowed.split(",").map((s) => s.trim());
  const isAllowed = allowedOrigins.includes("*") || allowedOrigins.includes(origin);
  if (!isAllowed) return encoder.encode("");
  const headers =
    `Access-Control-Allow-Origin: ${allowedOrigins.includes("*") ? "*" : origin}\r\n` +
    `Access-Control-Allow-Methods: ${methods}\r\n` +
    `Access-Control-Allow-Headers: Content-Type, Authorization\r\n` +
    `Access-Control-Max-Age: ${maxAge}\r\n`;
  return encoder.encode(headers);
}

export function nativeSecurityHeaders(): Uint8Array {
  const headers =
    "Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n" +
    "X-Content-Type-Options: nosniff\r\n" +
    "X-Frame-Options: DENY\r\n" +
    "X-XSS-Protection: 1; mode=block\r\n" +
    "Referrer-Policy: strict-origin-when-cross-origin\r\n" +
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'\r\n";
  return encoder.encode(headers);
}

// ===========================================================================
// WEBSOCKET
// ===========================================================================

export function nativeWsFrameParse(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 2) return null;
  const byte0 = bytes[0] ?? 0;
  const byte1 = bytes[1] ?? 0;
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let headerSize = 2;
  if (payloadLen === 126) {
    if (bytes.length < 4) return null;
    payloadLen = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    headerSize = 4;
  } else if (payloadLen === 127) {
    if (bytes.length < 10) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + 2, 8);
    payloadLen = Number(view.getBigUint64(0));
    headerSize = 10;
  }
  if (masked) headerSize += 4;
  const opcodeNames: Record<number, string> = {
    0: "continuation", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong",
  };
  return encoder.encode(JSON.stringify({
    fin, opcode, opcode_name: opcodeNames[opcode] ?? "unknown",
    masked, payload_length: payloadLen, header_size: headerSize,
  }));
}

export function nativeWsFrameBuild(opcode: number, payload: Uint8Array): Uint8Array {
  const frame: number[] = [];
  frame.push(0x80 | (opcode & 0x0f));
  if (payload.length < 126) {
    frame.push(payload.length);
  } else if (payload.length < 65536) {
    frame.push(126);
    frame.push((payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    frame.push(127);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(payload.length));
    for (let i = 0; i < 8; i++) frame.push(view.getUint8(i));
  }
  const result = new Uint8Array(frame.length + payload.length);
  result.set(frame);
  result.set(payload, frame.length);
  return result;
}

export function nativeWsAcceptKey(key: string): string {
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(key + magic);
  // Use Bun's crypto for SHA-1
  const hash = new Bun.CryptoHasher("sha1").update(toBuffer(combined)).digest();
  return Buffer.from(hash).toString("base64");
}

// ===========================================================================
// MIME & CONTENT NEGOTIATION
// ===========================================================================

export function nativeMimeFromExtension(ext: string): string {
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
    txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", gzip: "application/gzip",
    mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
    wasm: "application/wasm", avif: "image/avif",
    yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
    md: "text/markdown; charset=utf-8",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

export function nativeContentNegotiate(accept: string, available: string[]): string | null {
  const acceptTypes = accept.split(",").map((part) => {
    const segments = part.trim().split(";");
    const type = segments[0]?.trim() ?? "*/*";
    const qParam = segments.find((p) => p.trim().startsWith("q="));
    const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1.0;
    return { type, q };
  });
  acceptTypes.sort((a, b) => b.q - a.q);
  for (const { type } of acceptTypes) {
    if (type === "*/*") return available[0] ?? null;
    for (const avail of available) {
      if (avail === type) return avail;
      if (type.endsWith("/*") && avail.startsWith(type.slice(0, -1))) return avail;
    }
  }
  return null;
}

// ===========================================================================
// LOGGING
// ===========================================================================

export function nativeLogFormat(
  level: string, message: string, context: Record<string, any>, requestId: string,
): Uint8Array {
  const log = {
    timestamp: new Date().toISOString(),
    level, message, request_id: requestId, context,
  };
  return encoder.encode(JSON.stringify(log) + "\n");
}

export function nativeHistogramBucket(durationUs: number): number {
  const buckets = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
  for (let i = 0; i < buckets.length; i++) {
    if (durationUs <= (buckets[i] ?? Infinity)) return i;
  }
  return 11;
}

// ===========================================================================
// PATH UTILITIES
// ===========================================================================

export function nativePathNormalize(path: string): string {
  const components: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") { components.pop(); } else { components.push(component); }
  }
  return "/" + components.join("/");
}

export function nativePathIsSafe(path: string): boolean {
  return !path.includes("..") && !path.includes("\0");
}

export function nativePathJoin(base: string, segment: string): string {
  const baseTrimmed = base.replace(/\/+$/, "");
  const segTrimmed = segment.replace(/^\/+/, "");
  return `${baseTrimmed}/${segTrimmed}`;
}

// ===========================================================================
// SEARCH
// ===========================================================================

export function nativeBinarySearch(bytes: Uint8Array, target: number): number {
  const arr = JSON.parse(decoder.decode(bytes)) as number[];
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid] ?? 0;
    if (midVal === target) return mid;
    if (midVal < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function nativeTextSearchCount(text: Uint8Array, term: Uint8Array): number {
  const textStr = decoder.decode(text);
  const termStr = decoder.decode(term);
  if (!termStr) return 0;
  let count = 0, pos = 0;
  while ((pos = textStr.indexOf(termStr, pos)) !== -1) { count++; pos++; }
  return count;
}

export function nativeInvertedIndexBuild(bytes: Uint8Array): Uint8Array {
  const docs = JSON.parse(decoder.decode(bytes)) as Array<{ id: string; text: string }>;
  const index: Record<string, string[]> = {};
  for (const doc of docs) {
    for (const word of doc.text.split(/\s+/)) {
      const cleaned = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned) {
        if (!index[cleaned]) index[cleaned] = [];
        index[cleaned].push(doc.id);
      }
    }
  }
  return encoder.encode(JSON.stringify(index));
}

// ===========================================================================
// MATH & ENCODING
// ===========================================================================

export function nativeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function nativeFnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i] ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash;
}

export function nativeItoa(value: number): string {
  return String(value);
}

export function nativeAtoi(text: string): number {
  return parseInt(text.trim(), 10) || 0;
}

export function nativeFormatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(2)} KB`;
  if (byteCount < 1024 * 1024 * 1024) return `${(byteCount / (1024 * 1024)).toFixed(2)} MB`;
  return `${(byteCount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ===========================================================================
// PIPELINE
// ===========================================================================

export function nativeJsonPipeline(data: Uint8Array, ops: Uint8Array): Uint8Array {
  let obj = JSON.parse(decoder.decode(data));
  const operations = JSON.parse(decoder.decode(ops)) as Array<{
    op: string; field: string; value?: any; new_name?: string;
  }>;
  for (const operation of operations) {
    if (typeof obj !== "object" || obj === null) break;
    switch (operation.op) {
      case "add_field":
      case "set_field":
        obj[operation.field] = operation.value;
        break;
      case "remove_field":
        delete obj[operation.field];
        break;
      case "rename_field":
        if (operation.new_name && operation.field in obj) {
          obj[operation.new_name] = obj[operation.field];
          delete obj[operation.field];
        }
        break;
      case "uppercase_field":
        if (typeof obj[operation.field] === "string") {
          obj[operation.field] = obj[operation.field].toUpperCase();
        }
        break;
    }
  }
  return encoder.encode(JSON.stringify(obj));
}

// ===========================================================================
// CONNECTION & PROTOCOL
// ===========================================================================

export function nativeParseHost(host: string): { hostname: string; port: number } {
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx >= 0 && !host.includes("[")) {
    const portStr = host.slice(colonIdx + 1);
    if (/^\d+$/.test(portStr)) {
      return { hostname: host.slice(0, colonIdx), port: parseInt(portStr, 10) };
    }
  }
  return { hostname: host, port: 80 };
}

export function nativeUrlBuild(
  scheme: string, host: string, port: number, path: string, query: string,
): string {
  let url = `${scheme}://${host}`;
  const defaultPort = scheme === "https" ? 443 : 80;
  if (port !== 0 && port !== defaultPort) url += `:${port}`;
  if (path) {
    if (!path.startsWith("/")) url += "/";
    url += path;
  }
  if (query) url += `?${query}`;
  return url;
}

export function nativeContentTypeParse(header: string): { mime_type: string; params: Record<string, string> } {
  const parts = header.split(";");
  const mimeType = (parts[0] ?? "").trim();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = (parts[i] ?? "").trim();
    const eqIdx = part.indexOf("=");
    if (eqIdx >= 0) {
      params[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return { mime_type: mimeType, params };
}

// ===========================================================================
// JSON UTILITIES
// ===========================================================================

export function nativeJsonExtract(bytes: Uint8Array, keyPath: string): Uint8Array | null {
  const obj = JSON.parse(decoder.decode(bytes));
  let current: any = obj;
  for (const segment of keyPath.split(".")) {
    if (current == null) return null;
    if (Array.isArray(current)) {
      const idx = parseInt(segment, 10);
      if (isNaN(idx) || idx >= current.length) return null;
      current = current[idx];
    } else if (typeof current === "object") {
      current = current[segment];
    } else {
      return null;
    }
  }
  return encoder.encode(JSON.stringify(current));
}

export function nativeJsonFlatten(bytes: Uint8Array): Uint8Array {
  const obj = JSON.parse(decoder.decode(bytes));
  const flat: Record<string, any> = {};
  function flatten(value: any, prefix: string): void {
    if (value === null || typeof value !== "object") {
      flat[prefix] = value;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) flatten(value[i], `${prefix}.${i}`);
    } else {
      for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k);
    }
  }
  flatten(obj, "");
  return encoder.encode(JSON.stringify(flat));
}

export function nativeJsonMerge(bytes1: Uint8Array, bytes2: Uint8Array): Uint8Array {
  const obj1 = JSON.parse(decoder.decode(bytes1));
  const obj2 = JSON.parse(decoder.decode(bytes2));
  return encoder.encode(JSON.stringify({ ...obj1, ...obj2 }));
}


export function nativeJsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
  const obj = JSON.parse(decoder.decode(doc));
  const ops = JSON.parse(decoder.decode(patch)) as Array<{ op: string; path: string; value?: any }>;
  for (const operation of ops) {
    const segments = operation.path.replace(/^\//, "").split("/");
    let current: any = obj;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] ?? "";
      if (Array.isArray(current)) current = current[parseInt(seg, 10)];
      else current = current[seg];
      if (current == null) break;
    }
    const lastSeg = segments[segments.length - 1] ?? "";
    if (current == null) continue;
    switch (operation.op) {
      case "replace":
      case "add":
        if (Array.isArray(current)) current[parseInt(lastSeg, 10)] = operation.value;
        else current[lastSeg] = operation.value;
        break;
      case "remove":
        if (Array.isArray(current)) current.splice(parseInt(lastSeg, 10), 1);
        else delete current[lastSeg];
        break;
    }
  }
  return encoder.encode(JSON.stringify(obj));
}

// Add to shared.ts
export function nativeMultipartParse(bytes: Uint8Array, boundary: string): Uint8Array {
  const text = decoder.decode(bytes);
  const delimiter = `--${boundary}`;
  const parts: any[] = [];
  let pos = 0;
  
  while (pos < text.length) {
    const start = text.indexOf(delimiter, pos);
    if (start === -1) break;
    
    const headerStart = start + delimiter.length;
    if (text.startsWith("--", headerStart)) break; // closing boundary
    
    let hStart = headerStart;
    if (text.startsWith("\r\n", hStart)) hStart += 2;
    
    const headerEnd = text.indexOf("\r\n\r\n", hStart);
    if (headerEnd === -1) break;
    
    const headersText = text.slice(hStart, headerEnd);
    const bodyStart = headerEnd + 4;
    const bodyEnd = text.indexOf(delimiter, bodyStart);
    const actualBodyEnd = bodyEnd === -1 ? text.length : bodyEnd - 2;
    
    const nameMatch = headersText.match(/name="([^"]+)"/);
    const filenameMatch = headersText.match(/filename="([^"]+)"/);
    const ctMatch = headersText.match(/Content-Type:\s*(.+)/i);
    
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : "",
      content_type: ctMatch ? ctMatch[1]?.trim() : "",
      size: Math.max(0, actualBodyEnd - bodyStart),
    });
    pos = bodyEnd === -1 ? text.length : bodyEnd;
  }
  return encoder.encode(JSON.stringify(parts));
}
````

## File: task-bench.ts
````typescript
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { taskBytes } from "./data";

const MODE = process.env.MODE ?? "both";
const JOBS = Number(process.env.JOBS ?? 200);
const WORKERS = Number(process.env.WORKERS ?? 4);
const EVENTS = Number(process.env.EVENTS ?? 20_000);

const payload = taskBytes(EVENTS);

type RunResult = {
  mode: string;
  jobs: number;
  workers: number;
  events: number;
  totalMs: number;
  jobsPerSec: number;
};

async function runMode(mode: "native" | "rust"): Promise<RunResult> {
  const workerFile = fileURLToPath(new URL("./task-worker.ts", import.meta.url));

  const workers = Array.from(
    { length: WORKERS },
    () => new Worker(workerFile),
  );

  let sent = 0;
  let done = 0;
  let finished = false;

  const start = performance.now();

  return new Promise<RunResult>((resolve, reject) => {
    const finish = () => {
      if (finished) return;
      finished = true;

      const totalMs = performance.now() - start;

      for (const worker of workers) {
        worker.terminate();
      }

      resolve({
        mode,
        jobs: JOBS,
        workers: WORKERS,
        events: EVENTS,
        totalMs,
        jobsPerSec: JOBS / (totalMs / 1000),
      });
    };

    const sendNext = (worker: Worker) => {
      if (sent >= JOBS) return;

      const id = sent++;
      const input = payload.slice(0).buffer;

      worker.postMessage(
        {
          id,
          mode,
          input,
        },
        [input],
      );
    };

    for (const worker of workers) {
      worker.on("message", () => {
        done++;

        if (done >= JOBS) {
          finish();
          return;
        }

        sendNext(worker);
      });

      worker.on("error", reject);

      sendNext(worker);
      sendNext(worker);
    }
  });
}

const results: RunResult[] = [];

if (MODE === "both" || MODE === "native") {
  results.push(await runMode("native"));
}

if (MODE === "both" || MODE === "rust") {
  results.push(await runMode("rust"));
}

console.table(
  results.map((r) => ({
    mode: r.mode,
    jobs: r.jobs,
    workers: r.workers,
    events: r.events,
    "total ms": r.totalMs.toFixed(2),
    "jobs/s": r.jobsPerSec.toFixed(2),
  })),
);

if (results.length === 2) {
  const native = results.find((x) => x.mode === "native");
  const rustResult = results.find((x) => x.mode === "rust");

  if (native && rustResult) {
    const ratio = native.totalMs / Math.max(rustResult.totalMs, 1e-9);

    if (ratio >= 1) {
      console.log(`Background task: Rust ${ratio.toFixed(2)}x faster than native`);
    } else {
      console.log(`Background task: Native ${(1 / ratio).toFixed(2)}x faster than Rust`);
    }
  }
}
````

## File: task-worker.ts
````typescript
import { parentPort } from "node:worker_threads";
import { rust } from "./native";
import { nativeTaskProcess } from "./shared";

if (!parentPort) {
  throw new Error("task-worker must be run as a worker thread");
}

parentPort.on("message", (msg) => {
  const input = new Uint8Array(msg.input);

  if (msg.mode === "rust") {
    const out = new Uint8Array(256 * 1024);

    const written = rust.taskProcess(input, out);

    parentPort!.postMessage({
      id: msg.id,
      ok: written >= 0,
      len: Number(written),
    });

    return;
  }

  const result = nativeTaskProcess(input);

  parentPort!.postMessage({
    id: msg.id,
    ok: true,
    len: result.byteLength,
  });
});
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "types": ["bun"],

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
````
