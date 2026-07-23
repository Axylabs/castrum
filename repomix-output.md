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
rust/
  cookie_parser.rs
  ffi.rs
  hashing.rs
  hmac_sha256.rs
  http_parser.rs
  json_ops.rs
  json_patch_ops.rs
  lib.rs
  mime_lookup.rs
  query_parser.rs
  random_token.rs
  routing.rs
  url_codec.rs
  validation.rs
  websocket.rs
src/
  baseline/
    tasks/
      cookie.ts
      hashing.ts
      hmac.ts
      http.ts
      json-patch.ts
      json.ts
      mime.ts
      query.ts
      token.ts
      url.ts
      validation.ts
      websocket.ts
    index.ts
  bench/
    tasks/
      cookie.ts
      hashing.ts
      hmac.ts
      http.ts
      index.ts
      json-patch.ts
      json.ts
      mime.ts
      query.ts
      routing.ts
      token.ts
      url.ts
      validation.ts
      websocket.ts
    assert.ts
    checks.ts
    checksum.ts
    comparisons.ts
    fixtures.ts
    index.ts
    measure.ts
    now.ts
    report.ts
    router-http.bench.ts
    run.ts
    types.ts
  data/
    json-rows.ts
  rust-ffi/
    apis/
      cookie.ts
      hashing.ts
      hmac.ts
      http.ts
      json-patch.ts
      json.ts
      mime.ts
      query.ts
      routing.ts
      token.ts
      url.ts
      validation.ts
      websocket.ts
    call.ts
    client.ts
    index.ts
    loader.ts
    pointer.ts
    runtime.ts
    symbols.ts
  shared/
    bytes.ts
    json.ts
.gitignore
.repomixignore
bench.ts
Cargo.toml
data.ts
index.ts
native.ts
package.json
README.md
repomix.config.json
shared-practical.ts
tsconfig.json
````

# Files

## File: rust/cookie_parser.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use cookie::Cookie;
use serde_json::{Map, Value};

#[no_mangle]
pub extern "C" fn rust_cookie_parse_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
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
    })
}
````

## File: rust/ffi.rs
````rust
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

pub fn catch_or<F, T>(fallback: T, f: F) -> T
where
    F: FnOnce() -> T,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(fallback)
}

pub fn input_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(ptr, len) }
    }
}

pub fn output_bytes<'a>(ptr: *mut u8, cap: usize) -> &'a mut [u8] {
    if ptr.is_null() || cap == 0 {
        &mut []
    } else {
        unsafe { slice::from_raw_parts_mut(ptr, cap) }
    }
}

pub fn write_response(out: &mut [u8], data: &[u8]) -> i64 {
    if data.len() > out.len() {
        return -2;
    }

    out[..data.len()].copy_from_slice(data);
    data.len() as i64
}
````

## File: rust/hashing.rs
````rust
use crate::ffi::{catch_or, input_bytes};
use crc32fast::Hasher as Crc32Hasher;
use fnv::FnvHasher;
use std::hash::Hasher as _;

#[no_mangle]
pub extern "C" fn rust_crc32_v2(ptr: *const u8, len: usize) -> u32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);

        let mut hasher = Crc32Hasher::new();
        hasher.update(input);
        hasher.finalize()
    })
}

#[no_mangle]
pub extern "C" fn rust_fnv1a64_v2(ptr: *const u8, len: usize) -> u64 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);

        let mut hasher = FnvHasher::default();
        hasher.write(input);
        hasher.finish()
    })
}
````

## File: rust/hmac_sha256.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use hmac::{Hmac, Mac};
use sha2::Sha256;

#[no_mangle]
pub extern "C" fn rust_hmac_sha256_v2(
    key_ptr: *const u8,
    key_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let key = input_bytes(key_ptr, key_len);
        let data = input_bytes(data_ptr, data_len);
        let out = output_bytes(out_ptr, out_cap);

        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data);

        let result = mac.finalize().into_bytes();
        let hex = hex::encode(result);

        write_response(out, hex.as_bytes())
    })
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
    catch_or(0, || {
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
    })
}
````

## File: rust/http_parser.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use httparse::{Request as HttpRequest, EMPTY_HEADER, Status as HttpStatus};
use serde_json::{json, Map, Value};

#[no_mangle]
pub extern "C" fn rust_http_parse_request_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
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
    })
}
````

## File: rust/json_ops.rs
````rust
use crate::ffi::{catch_or, input_bytes};
use serde::Deserialize;

#[derive(Deserialize)]
struct IdRow {
    id: i64,
}

#[no_mangle]
pub extern "C" fn rust_json_valid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<sonic_rs::Value>(input) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_json_sum_ids_v2(ptr: *const u8, len: usize) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        match sonic_rs::from_slice::<Vec<IdRow>>(input) {
            Ok(rows) => rows
                .into_iter()
                .fold(0i64, |acc, row| acc.saturating_add(row.id)),
            Err(_) => -1,
        }
    })
}
````

## File: rust/json_patch_ops.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use serde_json::Value;

#[no_mangle]
pub extern "C" fn rust_json_patch_v2(
    doc_ptr: *const u8,
    doc_len: usize,
    patch_ptr: *const u8,
    patch_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
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
    })
}
````

## File: rust/lib.rs
````rust
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod cookie_parser;
mod ffi;
mod hashing;
mod hmac_sha256;
mod http_parser;
mod json_ops;
mod json_patch_ops;
mod mime_lookup;
mod query_parser;
mod random_token;
mod routing;
mod url_codec;
mod validation;
mod websocket;
````

## File: rust/mime_lookup.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};

#[no_mangle]
pub extern "C" fn rust_mime_from_extension_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let ext = String::from_utf8_lossy(input).to_lowercase();
        let ext = ext.trim_start_matches('.').to_string();

        let mime = mime_guess::from_ext(&ext).first_or_octet_stream();
        let result = mime.essence_str().to_string();

        write_response(out, result.as_bytes())
    })
}
````

## File: rust/query_parser.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use serde_json::{Map, Value};

#[no_mangle]
pub extern "C" fn rust_query_parse_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
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
    })
}
````

## File: rust/random_token.rs
````rust
use crate::ffi::{catch_or, output_bytes, write_response};

#[no_mangle]
pub extern "C" fn rust_random_token_v2(byte_len: u32, out_ptr: *mut u8, out_cap: usize) -> i64 {
    catch_or(-1, || {
        let out = output_bytes(out_ptr, out_cap);

        let mut token = vec![0u8; byte_len as usize];
        if getrandom::fill(&mut token).is_err() {
            return -1;
        }

        let hex = hex::encode(token);
        write_response(out, hex.as_bytes())
    })
}
````

## File: rust/routing.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes};
use matchit::Router;

/// Precompiled matchit router.
///
/// Route value is the route index.
/// The JS framework maps this route index to a handler.
struct RouterHandle {
    router: Router<u32>,
    param_names: Vec<Vec<String>>,
}

/// Extract param names from native matchit patterns.
///
/// Examples:
/// "/users/{id}" -> ["id"]
/// "/users/{id}/posts/{postId}" -> ["id", "postId"]
/// "/files/{*wildcard}" -> ["wildcard"]
fn extract_param_names(pattern: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut chars = pattern.chars();

    while let Some(c) = chars.next() {
        if c == '{' {
            let mut name = String::new();
            let mut is_first = true;

            for ch in chars.by_ref() {
                if ch == '}' {
                    break;
                }

                // {*name} -> name
                if is_first && ch == '*' {
                    is_first = false;
                    continue;
                }

                is_first = false;
                name.push(ch);
            }

            if !name.is_empty() {
                names.push(name);
            }
        }
    }

    names
}

/// Create a precompiled matchit router from a JSON array of native matchit patterns.
///
/// Input example:
///
/// [
///   "/ping",
///   "/users/{id}",
///   "/users/{id}/posts/{postId}",
///   "/files/{*wildcard}"
/// ]
///
/// The route ID is the pattern index.
///
/// Returns:
/// - non-zero router handle on success
/// - 0 on failure
#[no_mangle]
pub extern "C" fn rust_router_create(patterns_ptr: *const u8, patterns_len: usize) -> u64 {
    catch_or(0, || {
        let input = input_bytes(patterns_ptr, patterns_len);

        let patterns: Vec<String> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return 0,
        };

        if patterns.len() > u32::MAX as usize {
            return 0;
        }

        let mut router: Router<u32> = Router::new();
        let mut param_names: Vec<Vec<String>> = Vec::with_capacity(patterns.len());

        for (i, pattern) in patterns.into_iter().enumerate() {
            let names = extract_param_names(&pattern);

            // matchit requires 'static route strings.
            // Routes are compiled once at framework startup, so leaking is acceptable.
            let route: &'static str = Box::leak(pattern.into_boxed_str());

            if router.insert(route, i as u32).is_err() {
                return 0;
            }

            param_names.push(names);
        }

        let handle = Box::new(RouterHandle {
            router,
            param_names,
        });

        Box::into_raw(handle) as usize as u64
    })
}

/// Fastest matcher.
///
/// Returns only the route ID.
/// Does not extract params.
///
/// Returns:
/// - route_id + 1 on match
/// - 0 on no match
/// - negative on error
#[no_mangle]
pub extern "C" fn rust_router_match_id(
    router_id: u64,
    path_ptr: *const u8,
    path_len: usize,
) -> i64 {
    catch_or(-1, || {
        if router_id == 0 {
            return -1;
        }

        let path_bytes = input_bytes(path_ptr, path_len);

        let path = match std::str::from_utf8(path_bytes) {
            Ok(path) => path,
            Err(_) => return -1,
        };

        let handle = unsafe { &*(router_id as usize as *const RouterHandle) };

        match handle.router.at(path) {
            Ok(matched) => (*matched.value as i64) + 1,
            Err(_) => 0,
        }
    })
}

/// Match route and return compact binary param spans.
///
/// Output format:
///
/// bytes 0..4:
///   route_id u32 little-endian
///
/// byte 4:
///   param_count u8
///
/// then for each param:
///   param_index u8
///   value_start u32 little-endian
///   value_end   u32 little-endian
///
/// value_start/value_end are byte offsets into the input path.
///
/// Returns:
/// - positive length: match result written
/// - 0: no match
/// - -1: error
/// - -2: output buffer too small
#[no_mangle]
pub extern "C" fn rust_router_match(
    router_id: u64,
    path_ptr: *const u8,
    path_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        if router_id == 0 {
            return -1;
        }

        let path_bytes = input_bytes(path_ptr, path_len);

        let path = match std::str::from_utf8(path_bytes) {
            Ok(path) => path,
            Err(_) => return -1,
        };

        let out = output_bytes(out_ptr, out_cap);

        let handle = unsafe { &*(router_id as usize as *const RouterHandle) };

        match handle.router.at(path) {
            Ok(matched) => {
                let route_id = *matched.value;
                let param_count = matched.params.len();

                if param_count > u8::MAX as usize {
                    return -1;
                }

                // 4 bytes route_id + 1 byte param_count + 9 bytes per param.
                let required = 5 + param_count * 9;

                if out.len() < required {
                    return -2;
                }

                out[0..4].copy_from_slice(&route_id.to_le_bytes());
                out[4] = param_count as u8;

                let mut pos = 5usize;

                let names = handle.param_names.get(route_id as usize);
                let path_base = path.as_ptr() as usize;

                for (key, value) in matched.params.iter() {
                    let idx = match names.and_then(|names| {
                        names.iter().position(|n| n.as_str() == key)
                    }) {
                        Some(i) => i as u8,
                        None => 255,
                    };

                    let value_start = (value.as_ptr() as usize - path_base) as u32;
                    let value_end = value_start + value.len() as u32;

                    out[pos] = idx;
                    pos += 1;

                    out[pos..pos + 4].copy_from_slice(&value_start.to_le_bytes());
                    pos += 4;

                    out[pos..pos + 4].copy_from_slice(&value_end.to_le_bytes());
                    pos += 4;
                }

                required as i64
            }
            Err(_) => 0,
        }
    })
}

/// Destroy a precompiled router handle.
#[no_mangle]
pub extern "C" fn rust_router_destroy(router_id: u64) -> i32 {
    catch_or(0, || {
        if router_id == 0 {
            return 0;
        }

        unsafe {
            drop(Box::from_raw(router_id as usize as *mut RouterHandle));
        }

        1
    })
}
````

## File: rust/url_codec.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use percent_encoding::{percent_decode, utf8_percent_encode, AsciiSet, CONTROLS};

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
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let text = String::from_utf8_lossy(input);
        let encoded = utf8_percent_encode(&text, ENCODE_URI_COMPONENT_SET).to_string();

        write_response(out, encoded.as_bytes())
    })
}

#[no_mangle]
pub extern "C" fn rust_url_decode_v2(
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        match percent_decode(input).decode_utf8() {
            Ok(decoded) => write_response(out, decoded.as_bytes()),
            Err(_) => -1,
        }
    })
}
````

## File: rust/validation.rs
````rust
use crate::ffi::{catch_or, input_bytes};
use email_address::EmailAddress;
use std::str::FromStr;
use uuid::Uuid;

#[no_mangle]
pub extern "C" fn rust_validate_email_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let email = String::from_utf8_lossy(input);

        if EmailAddress::is_valid(&email) {
            1
        } else {
            0
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_uuid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
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
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv4_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv4Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv6_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv6Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}
````

## File: rust/websocket.rs
````rust
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha1::{Digest as _, Sha1};

#[no_mangle]
pub extern "C" fn rust_ws_accept_key_v2(
    key_ptr: *const u8,
    key_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        let key = String::from_utf8_lossy(input_bytes(key_ptr, key_len));
        let out = output_bytes(out_ptr, out_cap);

        let magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
        let combined = format!("{}{}", key, magic);

        let mut hasher = Sha1::new();
        hasher.update(combined.as_bytes());

        let hash = hasher.finalize();
        let encoded = BASE64.encode(hash);

        write_response(out, encoded.as_bytes())
    })
}
````

## File: src/baseline/tasks/cookie.ts
````typescript
import { parse as parseCookie } from "cookie-es";
import { decoder, encoder } from "../../shared/bytes";

export function nativeCookieParse(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies = parseCookie(text);
  return encoder.encode(JSON.stringify(cookies));
}
````

## File: src/baseline/tasks/hashing.ts
````typescript
import * as CRC32 from "crc-32";

export function nativeCrc32(bytes: Uint8Array): number {
  return CRC32.buf(bytes) >>> 0;
}

export function nativeFnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash;
}
````

## File: src/baseline/tasks/hmac.ts
````typescript
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { decoder, encoder } from "../../shared/bytes";

export function nativeHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const hex = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest("hex");

  return encoder.encode(hex);
}

export function nativeHmacSha256Verify(
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
````

## File: src/baseline/tasks/http.ts
````typescript
import { decoder, encoder } from "../../shared/bytes";

export function nativeHttpParseRequest(bytes: Uint8Array): Uint8Array {
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
    // Keep raw target when it is not a parseable URL.
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
````

## File: src/baseline/tasks/json-patch.ts
````typescript
import { applyPatch, type Operation } from "fast-json-patch";
import { decoder, encoder } from "../../shared/bytes";

export function nativeJsonPatch(
  docBytes: Uint8Array,
  patchBytes: Uint8Array,
): Uint8Array {
  const doc = JSON.parse(decoder.decode(docBytes));
  const patch = JSON.parse(decoder.decode(patchBytes)) as Operation[];
  const result = applyPatch(doc, patch, true, false).newDocument;
  return encoder.encode(JSON.stringify(result));
}
````

## File: src/baseline/tasks/json.ts
````typescript
import { decoder } from "../../shared/bytes";

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const parsed = JSON.parse(decoder.decode(bytes));

  if (!Array.isArray(parsed)) {
    return 0n;
  }

  let sum = 0n;

  for (const row of parsed as Array<{ id?: unknown }>) {
    if (typeof row.id === "number" && Number.isFinite(row.id)) {
      sum += BigInt(Math.trunc(row.id));
    }
  }

  return sum;
}
````

## File: src/baseline/tasks/mime.ts
````typescript
import mime from "mime-types";

export function nativeMimeFromExtension(ext: string): string {
  return mime.lookup(ext) || "application/octet-stream";
}
````

## File: src/baseline/tasks/query.ts
````typescript
import { decoder, encoder } from "../../shared/bytes";

export function nativeQueryParse(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);
  const obj: Record<string, string | string[]> = {};

  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    obj[key] = values.length === 1 ? (values[0] ?? "") : values;
  }

  return encoder.encode(JSON.stringify(obj));
}
````

## File: src/baseline/tasks/token.ts
````typescript
import { Buffer } from "node:buffer";
import { encoder } from "../../shared/bytes";

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return encoder.encode(Buffer.from(bytes).toString("hex"));
}
````

## File: src/baseline/tasks/url.ts
````typescript
import { decoder } from "../../shared/bytes";

export function nativeUrlEncode(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return encodeURIComponent(text);
}

export function nativeUrlDecode(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return decodeURIComponent(text);
}
````

## File: src/baseline/tasks/validation.ts
````typescript
import { isIP } from "node:net";
import validator from "validator";
import { decoder } from "../../shared/bytes";

export function nativeValidateEmail(bytes: Uint8Array): boolean {
  return validator.isEmail(decoder.decode(bytes));
}

export function nativeValidateUuid(bytes: Uint8Array): boolean {
  return validator.isUUID(decoder.decode(bytes), 4);
}

export function nativeValidateIpv4(bytes: Uint8Array): boolean {
  return validator.isIP(decoder.decode(bytes), 4);
}

export function nativeValidateIpv6(bytes: Uint8Array): boolean {
  return isIP(decoder.decode(bytes)) === 6;
}
````

## File: src/baseline/tasks/websocket.ts
````typescript
import { Buffer } from "node:buffer";
import { decoder, encoder, toPlainBuffer } from "../../shared/bytes";

export function nativeWsAcceptKey(key: string | Uint8Array): Uint8Array {
  const keyText = typeof key === "string" ? key : decoder.decode(key);
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(keyText + magic);

  const hash = new Bun.CryptoHasher("sha1")
    .update(toPlainBuffer(combined))
    .digest();

  return encoder.encode(Buffer.from(hash).toString("base64"));
}
````

## File: src/baseline/index.ts
````typescript
export * from "./tasks/json";
export * from "./tasks/http";
export * from "./tasks/query";
export * from "./tasks/cookie";
export * from "./tasks/token";
export * from "./tasks/websocket";
export * from "./tasks/json-patch";
export * from "./tasks/hmac";
export * from "./tasks/validation";
export * from "./tasks/hashing";
export * from "./tasks/mime";
export * from "./tasks/url";
````

## File: src/bench/tasks/cookie.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function cookieTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:cookie_parse",
      run: () => native.nativeCookieParse(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:cookie_parse",
      run: () => rust.cookieParse(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
````

## File: src/bench/tasks/hashing.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function hashingTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:crc32",
      run: () => native.nativeCrc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:crc32",
      run: () => rust.crc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:fnv1a64",
      run: () => native.nativeFnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:fnv1a64",
      run: () => rust.fnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/tasks/hmac.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function hmacTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:hmac_sha256",
      run: () => native.nativeHmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:hmac_sha256",
      run: () => rust.hmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:hmac_verify",
      run: () =>
        native.nativeHmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig)
          ? 1
          : 0,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:hmac_verify",
      run: () => rust.hmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig),
      iterations: 500,
      warmup: 50,
    },
  ];
}
````

## File: src/bench/tasks/http.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function httpTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:http_parse",
      run: () => native.nativeHttpParseRequest(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:http_parse",
      run: () => rust.httpParseRequest(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
````

## File: src/bench/tasks/index.ts
````typescript
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";
import { cookieTasks } from "./cookie";
import { hashingTasks } from "./hashing";
import { hmacTasks } from "./hmac";
import { httpTasks } from "./http";
import { jsonTasks } from "./json";
import { jsonPatchTasks } from "./json-patch";
import { mimeTasks } from "./mime";
import { queryTasks } from "./query";
import { routingTasks } from "./routing";
import { tokenTasks } from "./token";
import { urlTasks } from "./url";
import { validationTasks } from "./validation";
import { websocketTasks } from "./websocket";

export function createAllTasks(fixtures: BenchFixtures): BenchTask[] {
  return [
    ...jsonTasks(fixtures),
    ...httpTasks(fixtures),
    ...queryTasks(fixtures),
    ...cookieTasks(fixtures),
    ...tokenTasks(),
    ...websocketTasks(fixtures),
    ...jsonPatchTasks(fixtures),
    ...hmacTasks(fixtures),
    ...routingTasks(),
    ...validationTasks(fixtures),
    ...hashingTasks(fixtures),
    ...mimeTasks(fixtures),
    ...urlTasks(fixtures),
  ];
}
````

## File: src/bench/tasks/json-patch.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function jsonPatchTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:json_patch",
      run: () => native.nativeJsonPatch(f.jsonDoc, f.jsonPatch).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:json_patch",
      run: () => rust.jsonPatch(f.jsonDoc, f.jsonPatch).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
````

## File: src/bench/tasks/json.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function jsonTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:json_valid",
      run: () => native.nativeJsonValid(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_valid",
      run: () => rust.jsonValid(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:json_sum",
      run: () => native.nativeJsonSum(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_sum",
      run: () => rust.jsonSumIds(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
  ];
}
````

## File: src/bench/tasks/mime.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function mimeTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:mime",
      run: () => native.nativeMimeFromExtension("json").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:mime",
      run: () => rust.mimeFromExtension(f.mimeExt).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/tasks/query.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function queryTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:query_parse",
      run: () => native.nativeQueryParse(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:query_parse",
      run: () => rust.queryParse(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
````

## File: src/bench/tasks/routing.ts
````typescript
import { rust } from "../../rust-ffi";
import type { BenchTask } from "../types";

export function routingTasks(): BenchTask[] {
  const router = rust.createRouter([
    "/ping",
    "/api/v1/health",
    "/users/{id}",
    "/users/{id}/posts/{postId}",
    "/files/{*wildcard}",
  ]);

  const staticPath = "/api/v1/health";
  const paramPath = "/users/42/posts/7";
  const wildcardPath = "/files/docs/2026/readme.md";

  return [
    {
      name: "rust:router_match_id_static",
      run: () => router.matchId(staticPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_id_param",
      run: () => router.matchId(paramPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_id_wildcard",
      run: () => router.matchId(wildcardPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_params",
      run: () => router.match(paramPath)?.routeId ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_wildcard_params",
      run: () => router.match(wildcardPath)?.routeId ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
  ];
}
````

## File: src/bench/tasks/token.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchTask } from "../types";

export function tokenTasks(): BenchTask[] {
  return [
    {
      name: "native:random_token",
      run: () => native.nativeRandomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:random_token",
      run: () => rust.randomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/tasks/url.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function urlTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:url_encode",
      run: () => native.nativeUrlEncode("hello world & foo=bar").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:url_encode",
      run: () => rust.urlEncode(f.urlEncodeInput).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:url_decode",
      run: () =>
        native.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:url_decode",
      run: () => rust.urlDecode(f.urlDecodeInput).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/tasks/validation.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function validationTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:validate_email",
      run: () => (native.nativeValidateEmail(f.emailOk) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:validate_email",
      run: () => rust.validateEmail(f.emailOk),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:validate_uuid",
      run: () => (native.nativeValidateUuid(f.uuidOk) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:validate_uuid",
      run: () => rust.validateUuid(f.uuidOk),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:validate_ipv4",
      run: () => (native.nativeValidateIpv4(f.ipv4Ok) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:validate_ipv4",
      run: () => rust.validateIpv4(f.ipv4Ok),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:validate_ipv6",
      run: () => (native.nativeValidateIpv6(f.ipv6Ok) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:validate_ipv6",
      run: () => rust.validateIpv6(f.ipv6Ok),
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/tasks/websocket.ts
````typescript
import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function websocketTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:ws_accept_key",
      run: () => native.nativeWsAcceptKey(f.wsKey).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:ws_accept_key",
      run: () => rust.wsAcceptKey(f.wsKeyBytes).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
````

## File: src/bench/assert.ts
````typescript
import { decoder } from "../shared/bytes";
import { sortKeys } from "../shared/json";

export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${String(actual)}`);
    console.error(`  expected: ${String(expected)}`);
    process.exit(1);
    throw new Error(`Assertion failed: ${label}`);
  }
}

export function assertDeepEqual(
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
    throw new Error(`Assertion failed: ${label}`);
  }
}
````

## File: src/bench/checks.ts
````typescript
import * as native from "../baseline";
import { rust } from "../rust-ffi";
import { decoder } from "../shared/bytes";
import { assertDeepEqual, assertEqual, parseJsonBytes } from "./assert";
import type { BenchFixtures } from "./fixtures";

export function runCorrectnessChecks(f: BenchFixtures): void {
  assertEqual(
    native.nativeJsonValid(f.jsonPayload),
    rust.jsonValid(f.jsonPayload) === 1,
    "json valid",
  );

  assertEqual(
    native.nativeJsonSum(f.jsonPayload),
    rust.jsonSumIds(f.jsonPayload),
    "json sum",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeHttpParseRequest(f.httpRaw)),
    parseJsonBytes(rust.httpParseRequest(f.httpRaw)),
    "http parse",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeQueryParse(f.queryStr)),
    parseJsonBytes(rust.queryParse(f.queryStr)),
    "query parse",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeCookieParse(f.cookieStr)),
    parseJsonBytes(rust.cookieParse(f.cookieStr)),
    "cookie parse",
  );

  assertEqual(
    decoder.decode(native.nativeWsAcceptKey(f.wsKey)),
    decoder.decode(rust.wsAcceptKey(f.wsKeyBytes)),
    "ws accept key",
  );

  assertDeepEqual(
    parseJsonBytes(native.nativeJsonPatch(f.jsonDoc, f.jsonPatch)),
    parseJsonBytes(rust.jsonPatch(f.jsonDoc, f.jsonPatch)),
    "json patch",
  );

  assertEqual(
    decoder.decode(f.hmacSig),
    decoder.decode(rust.hmacSha256(f.hmacKey, f.hmacData)),
    "hmac sha256",
  );

  assertEqual(
    native.nativeHmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig),
    rust.hmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig) === 1,
    "hmac verify",
  );

  assertEqual(
    native.nativeValidateEmail(f.emailOk),
    rust.validateEmail(f.emailOk) === 1,
    "email valid",
  );

  assertEqual(
    native.nativeValidateUuid(f.uuidOk),
    rust.validateUuid(f.uuidOk) === 1,
    "uuid valid",
  );

  assertEqual(
    native.nativeValidateIpv4(f.ipv4Ok),
    rust.validateIpv4(f.ipv4Ok) === 1,
    "ipv4 valid",
  );

  assertEqual(
    native.nativeValidateIpv6(f.ipv6Ok),
    rust.validateIpv6(f.ipv6Ok) === 1,
    "ipv6 valid",
  );

  assertEqual(
    native.nativeCrc32(f.crcInput),
    rust.crc32(f.crcInput),
    "crc32",
  );

  assertEqual(
    native.nativeFnv1a64(f.crcInput),
    rust.fnv1a64(f.crcInput),
    "fnv1a64",
  );

  assertEqual(
    native.nativeMimeFromExtension("json"),
    decoder.decode(rust.mimeFromExtension(f.mimeExt)),
    "mime",
  );

  assertEqual(
    native.nativeUrlEncode("hello world & foo=bar"),
    decoder.decode(rust.urlEncode(f.urlEncodeInput)),
    "url encode",
  );

  assertEqual(
    native.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"),
    decoder.decode(rust.urlDecode(f.urlDecodeInput)),
    "url decode",
  );

  console.log("Practical correctness checks passed. ✓");
}
````

## File: src/bench/checksum.ts
````typescript
export function checksumValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }

  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }

  if (typeof value === "string") {
    return BigInt(value.length);
  }

  if (value instanceof Uint8Array) {
    return BigInt(value.byteLength) + BigInt(value[0] ?? 0);
  }

  if (value != null) {
    return 1n;
  }

  return 0n;
}
````

## File: src/bench/comparisons.ts
````typescript
import type { ComparisonReport } from "./types";

export const comparisonReports: ComparisonReport[] = [
  { label: "JSON valid", nativeName: "native:json_valid", rustName: "rust:json_valid" },
  { label: "JSON sum", nativeName: "native:json_sum", rustName: "rust:json_sum" },
  { label: "HTTP parse", nativeName: "native:http_parse", rustName: "rust:http_parse" },
  { label: "Query parse", nativeName: "native:query_parse", rustName: "rust:query_parse" },
  { label: "Cookie parse", nativeName: "native:cookie_parse", rustName: "rust:cookie_parse" },
  { label: "Random token", nativeName: "native:random_token", rustName: "rust:random_token" },
  { label: "WebSocket accept", nativeName: "native:ws_accept_key", rustName: "rust:ws_accept_key" },
  { label: "JSON Patch", nativeName: "native:json_patch", rustName: "rust:json_patch" },
  { label: "HMAC sign", nativeName: "native:hmac_sha256", rustName: "rust:hmac_sha256" },
  { label: "HMAC verify", nativeName: "native:hmac_verify", rustName: "rust:hmac_verify" },
  { label: "Email validation", nativeName: "native:validate_email", rustName: "rust:validate_email" },
  { label: "UUID validation", nativeName: "native:validate_uuid", rustName: "rust:validate_uuid" },
  { label: "IPv4 validation", nativeName: "native:validate_ipv4", rustName: "rust:validate_ipv4" },
  { label: "IPv6 validation", nativeName: "native:validate_ipv6", rustName: "rust:validate_ipv6" },
  { label: "CRC32", nativeName: "native:crc32", rustName: "rust:crc32" },
  { label: "FNV-1a 64", nativeName: "native:fnv1a64", rustName: "rust:fnv1a64" },
  { label: "MIME lookup", nativeName: "native:mime", rustName: "rust:mime" },
  { label: "URL encode", nativeName: "native:url_encode", rustName: "rust:url_encode" },
  { label: "URL decode", nativeName: "native:url_decode", rustName: "rust:url_decode" },
];
````

## File: src/bench/fixtures.ts
````typescript
import { nativeHmacSha256 } from "../baseline/tasks/hmac";
import { jsonRowsBytes } from "../data/json-rows";
import { encoder } from "../shared/bytes";

export interface BenchFixtures {
  jsonPayload: Uint8Array;
  httpRaw: Uint8Array;
  queryStr: Uint8Array;
  cookieStr: Uint8Array;
  hmacKey: Uint8Array;
  hmacData: Uint8Array;
  hmacSig: Uint8Array;
  wsKey: string;
  wsKeyBytes: Uint8Array;
  jsonDoc: Uint8Array;
  jsonPatch: Uint8Array;
  emailOk: Uint8Array;
  uuidOk: Uint8Array;
  ipv4Ok: Uint8Array;
  ipv6Ok: Uint8Array;
  crcInput: Uint8Array;
  mimeExt: Uint8Array;
  urlEncodeInput: Uint8Array;
  urlDecodeInput: Uint8Array;
}

export function createFixtures(): BenchFixtures {
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
  const hmacSig = nativeHmacSha256(hmacKey, hmacData);

  const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
  const wsKeyBytes = encoder.encode(wsKey);

  const jsonDoc = encoder.encode(JSON.stringify({ a: 1, b: { c: 2 } }));
  const jsonPatch = encoder.encode(
    JSON.stringify([{ op: "replace", path: "/a", value: 42 }]),
  );

  const emailOk = encoder.encode("user@example.com");
  const uuidOk = encoder.encode("550e8400-e29b-41d4-a716-446655440000");
  const ipv4Ok = encoder.encode("192.168.1.100");
  const ipv6Ok = encoder.encode("2001:db8::1");

  const crcInput = encoder.encode(
    "Hello, practical CRC32 checksum test data!",
  );

  const mimeExt = encoder.encode("json");

  const urlEncodeInput = encoder.encode("hello world & foo=bar");
  const urlDecodeInput = encoder.encode(
    "hello%20world%20%26%20foo%3Dbar",
  );

  return {
    jsonPayload,
    httpRaw,
    queryStr,
    cookieStr,
    hmacKey,
    hmacData,
    hmacSig,
    wsKey,
    wsKeyBytes,
    jsonDoc,
    jsonPatch,
    emailOk,
    uuidOk,
    ipv4Ok,
    ipv6Ok,
    crcInput,
    mimeExt,
    urlEncodeInput,
    urlDecodeInput,
  };
}
````

## File: src/bench/index.ts
````typescript
export { runBenchmark } from "./run";
export * from "./types";
````

## File: src/bench/measure.ts
````typescript
import { checksumValue } from "./checksum";
import { nowMs } from "./now";
import type { BenchResult } from "./types";

export function bench(
  name: string,
  fn: () => unknown,
  iterations = 100,
  warmup = 10,
): BenchResult {
  const safeIterations = Math.max(1, iterations);
  const safeWarmup = Math.max(0, warmup);

  let checksum = 0n;

  for (let i = 0; i < safeWarmup; i++) {
    checksum += checksumValue(fn());
  }

  const samples: number[] = new Array(safeIterations);

  for (let i = 0; i < safeIterations; i++) {
    const start = nowMs();
    checksum += checksumValue(fn());
    samples[i] = nowMs() - start;
  }

  samples.sort((a, b) => a - b);

  const total = samples.reduce((a, b) => a + b, 0);
  const avg = total / safeIterations;

  return {
    name,
    iterations: safeIterations,
    avgMs: avg,
    p50Ms: samples[Math.floor(safeIterations * 0.5)] ?? 0,
    p95Ms: samples[Math.floor(safeIterations * 0.95)] ?? 0,
    opsPerSec: 1000 / Math.max(avg, 1e-9),
    checksum: checksum.toString(),
  };
}
````

## File: src/bench/now.ts
````typescript
export function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000;
}
````

## File: src/bench/report.ts
````typescript
import type { BenchResult, ComparisonReport } from "./types";

export function printResults(results: BenchResult[]): void {
  console.table(
    results.map((r) => ({
      name: r.name,
      iters: r.iterations,
      "avg ms": r.avgMs.toFixed(4),
      "p50 ms": r.p50Ms.toFixed(4),
      "p95 ms": r.p95Ms.toFixed(4),
      "ops/s": r.opsPerSec.toFixed(1),
      checksum:
        r.checksum.length > 16 ? `${r.checksum.slice(0, 16)}…` : r.checksum,
    })),
  );
}

function printComparison(
  results: BenchResult[],
  report: ComparisonReport,
): void {
  const n = results.find((x) => x.name === report.nativeName);
  const r = results.find((x) => x.name === report.rustName);

  if (!n || !r) {
    return;
  }

  const ratio = n.avgMs / Math.max(r.avgMs, 1e-9);

  if (ratio >= 1) {
    console.log(
      `${report.label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Rust ${ratio.toFixed(2)}x faster`,
    );
  } else {
    console.log(
      `${report.label}: Rust ${r.avgMs.toFixed(4)}ms vs Native ${n.avgMs.toFixed(4)}ms → Native ${(1 / ratio).toFixed(2)}x faster`,
    );
  }
}

export function printSummary(
  results: BenchResult[],
  reports: ComparisonReport[],
): void {
  for (const report of reports) {
    printComparison(results, report);
  }
}
````

## File: src/bench/router-http.bench.ts
````typescript
import { rust } from "../rust-ffi";
import { sortKeys } from "../shared/json";

type MatchitRouter = ReturnType<typeof rust.createRouter>;

type ResponseMode = "params" | "status";

interface RouterCase {
  name: string;
  bunPatterns: string[];
  matchitPatterns: string[];
  requestPath: string;
  method?: string;
  expectedStatus?: number;
  responseMode?: ResponseMode;
}

interface HttpProfile {
  name: string;
  requests: number;
  concurrency: number;
  warmup: number;
}

interface HttpMetrics {
  totalMs: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

interface HttpResultRow extends HttpMetrics {
  case: string;
  profile: string;
  router: "bun-native" | "matchit";
}

type SimpleServer = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
};

const REQUESTS = Math.max(100, Number(process.env.HTTP_REQUESTS ?? 2000));
const WARMUP = Math.max(10, Number(process.env.HTTP_WARMUP ?? 200));

const STATIC_MATCHED_JSON = JSON.stringify({ matched: true });
const NOT_FOUND_BODY = "Not Found";

const profiles: HttpProfile[] = [
  {
    name: "sequential",
    requests: REQUESTS,
    concurrency: 1,
    warmup: WARMUP,
  },
  {
    name: "concurrency-10",
    requests: REQUESTS,
    concurrency: 10,
    warmup: WARMUP,
  },
  {
    name: "concurrency-50",
    requests: REQUESTS,
    concurrency: 50,
    warmup: WARMUP,
  },
];

function manyRoutesCase(count: number): RouterCase {
  const bunPatterns: string[] = [];
  const matchitPatterns: string[] = [];

  for (let i = 0; i < count; i++) {
    bunPatterns.push(`/api/${i}/items/:id`);
    matchitPatterns.push(`/api/${i}/items/{id}`);
  }

  bunPatterns.push(`/api/${count}/items/:id`);
  matchitPatterns.push(`/api/${count}/items/{id}`);

  return {
    name: `many-routes-${count + 1}`,
    bunPatterns,
    matchitPatterns,
    requestPath: `/api/${count}/items/42`,
    expectedStatus: 200,
    responseMode: "params",
  };
}

const cases: RouterCase[] = [
  {
    name: "static",
    bunPatterns: ["/ping"],
    matchitPatterns: ["/ping"],
    requestPath: "/ping",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "static-deep",
    bunPatterns: ["/api/v1/health"],
    matchitPatterns: ["/api/v1/health"],
    requestPath: "/api/v1/health",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "param",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/users/42",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "param-with-query",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/users/42?expand=posts&limit=20",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "two-params",
    bunPatterns: ["/users/:id/posts/:postId"],
    matchitPatterns: ["/users/{id}/posts/{postId}"],
    requestPath: "/users/42/posts/7",
    expectedStatus: 200,
    responseMode: "params",
  },

  // Bun currently does not reliably expose wildcard params via req.params.
  // So wildcard cases are benchmarked as match/no-match status cases.
  {
    name: "wildcard-status",
    bunPatterns: ["/files/*"],
    matchitPatterns: ["/files/{*wildcard}"],
    requestPath: "/files/docs/2026/readme.md",
    expectedStatus: 200,
    responseMode: "status",
  },
  {
    name: "mixed-param-wildcard-status",
    bunPatterns: ["/orgs/:orgId/files/*"],
    matchitPatterns: ["/orgs/{orgId}/files/{*wildcard}"],
    requestPath: "/orgs/9/files/a/b/c.txt",
    expectedStatus: 200,
    responseMode: "status",
  },
  {
    name: "no-match",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/posts/42",
    expectedStatus: 404,
    responseMode: "status",
  },

  manyRoutesCase(100),
  manyRoutesCase(1000),
];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function staticMatchedResponse(): Response {
  return new Response(STATIC_MATCHED_JSON, {
    headers: {
      "content-type": "application/json",
    },
  });
}

function notFoundResponse(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "content-type": "text/plain",
    },
  });
}

function normalizeBunParams(
  params: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;

    // Bun may expose wildcard as "*" in some versions.
    // matchit pattern uses {*wildcard}, so normalize Bun output to match.
    const normalizedKey = key === "*" ? "wildcard" : key;
    out[normalizedKey] = value;
  }

  return sortKeys(out) as Record<string, string>;
}

function pathnameFromRequestUrl(url: string): string {
  if (url.startsWith("/")) {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
  }

  const schemeEnd = url.indexOf("//");
  const pathStart =
    schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 2);

  if (pathStart === -1) {
    return "/";
  }

  const q = url.indexOf("?", pathStart);
  return q === -1 ? url.slice(pathStart) : url.slice(pathStart, q);
}

function startBunNativeServer(c: RouterCase): SimpleServer {
  const responseMode: ResponseMode = c.responseMode ?? "params";

  const handler =
    responseMode === "status"
      ? () => staticMatchedResponse()
      : (req: any) => jsonResponse(normalizeBunParams(req.params ?? {}));

  const routes: Record<string, any> = {};

  for (const pattern of c.bunPatterns) {
    routes[pattern] = handler;
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes,
    fetch() {
      return notFoundResponse();
    },
  } as any) as unknown as SimpleServer;
}

function startMatchitServer(c: RouterCase): {
  server: SimpleServer;
  router: MatchitRouter;
} {
  const router = rust.createRouter(c.matchitPatterns);
  const responseMode: ResponseMode = c.responseMode ?? "params";

  const server =
    responseMode === "status"
      ? Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            const path = pathnameFromRequestUrl(req.url);
            const routeId = router.matchId(path);

            if (routeId === null) {
              return notFoundResponse();
            }

            return staticMatchedResponse();
          },
        })
      : Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            const path = pathnameFromRequestUrl(req.url);
            const match = router.match(path);

            if (!match) {
              return notFoundResponse();
            }

            return jsonResponse(match.params ?? {});
          },
        });

  return {
    server: server as unknown as SimpleServer,
    router,
  };
}

function makeUrl(server: SimpleServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function sortedJsonString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

async function assertSameResponse(
  urlA: string,
  urlB: string,
  method: string,
  expectedStatus: number,
): Promise<void> {
  const [a, b] = await Promise.all([
    fetch(urlA, { method }),
    fetch(urlB, { method }),
  ]);

  const [textA, textB] = await Promise.all([a.text(), b.text()]);

  if (a.status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus} from Bun native server, got ${a.status}`,
    );
  }

  if (b.status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus} from matchit server, got ${b.status}`,
    );
  }

  if (a.status !== b.status) {
    throw new Error(
      `Status mismatch: ${a.status} vs ${b.status}\nA: ${textA}\nB: ${textB}`,
    );
  }

  if (expectedStatus === 200) {
    const jsonA = sortedJsonString(JSON.parse(textA || "null"));
    const jsonB = sortedJsonString(JSON.parse(textB || "null"));

    if (jsonA !== jsonB) {
      throw new Error(`JSON mismatch:\nA: ${jsonA}\nB: ${jsonB}`);
    }
  } else if (textA !== textB) {
    throw new Error(`Body mismatch:\nA: ${textA}\nB: ${textB}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function benchHttp(
  url: string,
  profile: HttpProfile,
  expectedStatus: number,
  method: string,
): Promise<HttpMetrics> {
  const requests = Math.max(1, profile.requests);
  const concurrency = Math.max(1, profile.concurrency);
  const warmup = Math.max(0, profile.warmup);

  for (let i = 0; i < warmup; i++) {
    const res = await fetch(url, { method });
    await res.text();

    if (res.status !== expectedStatus) {
      throw new Error(
        `Warmup failed: expected ${expectedStatus}, got ${res.status}`,
      );
    }
  }

  const latencies = new Float64Array(requests);
  let next = 0;

  const start = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= requests) break;

      const reqStart = performance.now();

      const res = await fetch(url, { method });
      await res.text();

      if (res.status !== expectedStatus) {
        throw new Error(
          `Benchmark request failed: expected ${expectedStatus}, got ${res.status}`,
        );
      }

      latencies[i] = performance.now() - reqStart;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totalMs = performance.now() - start;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const avgMs = sorted.reduce((a, b) => a + b, 0) / requests;

  return {
    totalMs,
    rps: requests / (totalMs / 1000),
    avgMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

async function runCaseProfile(
  c: RouterCase,
  profile: HttpProfile,
): Promise<HttpResultRow[]> {
  const method = c.method ?? "GET";
  const expectedStatus = c.expectedStatus ?? 200;

  const nativeServer = startBunNativeServer(c);
  const matchit = startMatchitServer(c);

  try {
    const nativeUrl = makeUrl(nativeServer, c.requestPath);
    const matchitUrl = makeUrl(matchit.server, c.requestPath);

    await assertSameResponse(nativeUrl, matchitUrl, method, expectedStatus);

    const nativeMetrics = await benchHttp(
      nativeUrl,
      profile,
      expectedStatus,
      method,
    );

    const matchitMetrics = await benchHttp(
      matchitUrl,
      profile,
      expectedStatus,
      method,
    );

    return [
      {
        case: c.name,
        profile: profile.name,
        router: "bun-native",
        ...nativeMetrics,
      },
      {
        case: c.name,
        profile: profile.name,
        router: "matchit",
        ...matchitMetrics,
      },
    ];
  } finally {
    nativeServer.stop(true);
    matchit.server.stop(true);
    matchit.router.destroy();
  }
}

async function main(): Promise<void> {
  const rows: HttpResultRow[] = [];

  console.log("Bun native router vs Rust matchit over HTTP");
  console.log("============================================");
  console.log(`Requests per profile: ${REQUESTS}`);
  console.log(`Warmup per profile:   ${WARMUP}`);
  console.log("");

  for (const c of cases) {
    for (const profile of profiles) {
      const results = await runCaseProfile(c, profile);

      rows.push(...results);

      const native = results.find((x) => x.router === "bun-native");
      const matchit = results.find((x) => x.router === "matchit");

      if (!native || !matchit) {
        throw new Error("Missing benchmark result pair");
      }

      const rpsRatio = matchit.rps / Math.max(native.rps, 1e-9);
      const latencyRatio = native.avgMs / Math.max(matchit.avgMs, 1e-9);

      console.log(
        `${c.name} / ${profile.name}: ` +
          `bun-native ${native.rps.toFixed(1)} req/s, ` +
          `matchit ${matchit.rps.toFixed(1)} req/s, ` +
          `matchit ${rpsRatio.toFixed(2)}x throughput, ` +
          `latency ${latencyRatio.toFixed(2)}x`,
      );
    }
  }

  console.log("");
  console.table(
    rows.map((row) => ({
      case: row.case,
      profile: row.profile,
      router: row.router,
      "req/s": row.rps.toFixed(1),
      "avg ms": row.avgMs.toFixed(4),
      "p50 ms": row.p50Ms.toFixed(4),
      "p95 ms": row.p95Ms.toFixed(4),
      "total ms": row.totalMs.toFixed(1),
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
````

## File: src/bench/run.ts
````typescript
import { runCorrectnessChecks } from "./checks";
import { comparisonReports } from "./comparisons";
import { createFixtures } from "./fixtures";
import { bench } from "./measure";
import { printResults, printSummary } from "./report";
import { createAllTasks } from "./tasks";

export function runBenchmark(): void {
  const fixtures = createFixtures();

  runCorrectnessChecks(fixtures);

  const tasks = createAllTasks(fixtures);
  const results = tasks.map((task) =>
    bench(task.name, task.run, task.iterations, task.warmup),
  );

  printResults(results);

  console.log("\n═══ Practical Summary ═══");
  printSummary(results, comparisonReports);
}
````

## File: src/bench/types.ts
````typescript
export interface BenchResult {
  name: string;
  iterations: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec: number;
  checksum: string;
}

export interface BenchTask {
  name: string;
  run: () => unknown;
  iterations: number;
  warmup: number;
}

export interface ComparisonReport {
  label: string;
  nativeName: string;
  rustName: string;
}
````

## File: src/data/json-rows.ts
````typescript
import { encoder } from "../shared/bytes";

export interface JsonRowNested {
  version: number;
  createdAt: string;
}

export interface JsonRow {
  id: number;
  name: string;
  active: boolean;
  score: number;
  tags: string[];
  nested: JsonRowNested;
}

export function createJsonRows(rows: number): JsonRow[] {
  return Array.from({ length: rows }, (_, i) => ({
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
}

export function jsonRowsBytes(rows: number): Uint8Array {
  return encoder.encode(JSON.stringify(createJsonRows(rows)));
}
````

## File: src/rust-ffi/apis/cookie.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createCookieApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    cookieParse(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_cookie_parse_v2,
        64 * 1024,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type CookieApi = ReturnType<typeof createCookieApi>;
````

## File: src/rust-ffi/apis/hashing.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createHashingApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    crc32(bytes: Uint8Array): number {
      return symbols.rust_crc32_v2(ptr(bytes), bytes.byteLength) as number;
    },

    fnv1a64(bytes: Uint8Array): bigint {
      return symbols.rust_fnv1a64_v2(ptr(bytes), bytes.byteLength) as bigint;
    },
  };
}

export type HashingApi = ReturnType<typeof createHashingApi>;
````

## File: src/rust-ffi/apis/hmac.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createHmacApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_hmac_sha256_v2,
        128,
        ptr(key),
        key.byteLength,
        ptr(data),
        data.byteLength,
      );
    },

    hmacSha256Verify(
      key: Uint8Array,
      data: Uint8Array,
      sig: Uint8Array,
    ): number {
      return symbols.rust_hmac_sha256_verify_v2(
        ptr(key),
        key.byteLength,
        ptr(data),
        data.byteLength,
        ptr(sig),
        sig.byteLength,
      ) as number;
    },
  };
}

export type HmacApi = ReturnType<typeof createHmacApi>;
````

## File: src/rust-ffi/apis/http.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createHttpApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    httpParseRequest(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_http_parse_request_v2,
        64 * 1024,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type HttpApi = ReturnType<typeof createHttpApi>;
````

## File: src/rust-ffi/apis/json-patch.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createJsonPatchApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_json_patch_v2,
        doc.byteLength + patch.byteLength + 4096,
        ptr(doc),
        doc.byteLength,
        ptr(patch),
        patch.byteLength,
      );
    },
  };
}

export type JsonPatchApi = ReturnType<typeof createJsonPatchApi>;
````

## File: src/rust-ffi/apis/json.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createJsonApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    jsonValid(bytes: Uint8Array): number {
      return symbols.rust_json_valid_v2(ptr(bytes), bytes.byteLength) as number;
    },

    jsonSumIds(bytes: Uint8Array): bigint {
      return symbols.rust_json_sum_ids_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as bigint;
    },
  };
}

export type JsonApi = ReturnType<typeof createJsonApi>;
````

## File: src/rust-ffi/apis/mime.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createMimeApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_mime_from_extension_v2,
        256,
        ptr(ext),
        ext.byteLength,
      );
    },
  };
}

export type MimeApi = ReturnType<typeof createMimeApi>;
````

## File: src/rust-ffi/apis/query.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createQueryApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    queryParse(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_query_parse_v2,
        64 * 1024,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type QueryApi = ReturnType<typeof createQueryApi>;
````

## File: src/rust-ffi/apis/routing.ts
````typescript
import type { FfiRuntime } from "../runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RouteMatch {
  routeId: number;
  params: Record<string, string> | null;
}

export type MethodRoutes = Record<string, string[]>;

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function extractParamNames(pattern: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;

  let match: RegExpExecArray | null;

  while ((match = re.exec(pattern)) !== null) {
    let name = match[1] ?? "";

    if (name.startsWith("*")) {
      name = name.slice(1);
    }

    if (name.length > 0) {
      names.push(name);
    }
  }

  return names;
}

interface RawMatchResult {
  out: Uint8Array;
  written: number;
}

/**
 * Single precompiled matchit router.
 *
 * Use one router per HTTP method for framework routing.
 */
export class MatchitRouter {
  private runtime: FfiRuntime;
  private handle: bigint;
  private paramNames: string[][];
  private destroyed = false;

  private pathBuffer: Uint8Array;
  private outBuffer: Uint8Array;

  constructor(runtime: FfiRuntime, patterns: string[]) {
    this.runtime = runtime;

    const bytes = encoder.encode(JSON.stringify(patterns));

    const handle = runtime.symbols.rust_router_create(
      runtime.ptr(bytes),
      bytes.byteLength,
    ) as bigint;

    if (handle === 0n) {
      throw new Error("Failed to create Rust matchit router");
    }

    this.handle = handle;
    this.paramNames = patterns.map((pattern) => extractParamNames(pattern));

    this.pathBuffer = new Uint8Array(8192);
    this.outBuffer = new Uint8Array(4096);
  }

  /**
   * Fastest match.
   *
   * Returns only route ID.
   * Does not extract params.
   */
  matchId(path: string): number | null {
    if (this.destroyed) {
      return null;
    }

    const encoded = encoder.encodeInto(path, this.pathBuffer);

    if (encoded.read === path.length) {
      return this.callMatchId(this.pathBuffer, encoded.written);
    }

    const bytes = encoder.encode(path);
    return this.callMatchId(bytes, bytes.byteLength);
  }

  /**
   * Match route and extract params.
   */
  match(path: string): RouteMatch | null {
    if (this.destroyed) {
      return null;
    }

    const encoded = encoder.encodeInto(path, this.pathBuffer);

    if (encoded.read === path.length) {
      const asciiFastPath = encoded.written === path.length;

      const raw = this.runMatch(this.pathBuffer, encoded.written);

      if (!raw) {
        return null;
      }

      return this.parse(
        raw.out,
        raw.written,
        path,
        this.pathBuffer,
        asciiFastPath,
      );
    }

    const bytes = encoder.encode(path);
    const asciiFastPath = bytes.byteLength === path.length;

    const raw = this.runMatch(bytes, bytes.byteLength);

    if (!raw) {
      return null;
    }

    return this.parse(raw.out, raw.written, path, bytes, asciiFastPath);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.runtime.symbols.rust_router_destroy(this.handle);
    this.destroyed = true;
  }

  private callMatchId(pathBytes: Uint8Array, pathLen: number): number | null {
    const result = toNumber(
      this.runtime.symbols.rust_router_match_id(
        this.handle,
        this.runtime.ptr(pathBytes),
        pathLen,
      ),
    );

    if (result === 0) {
      return null;
    }

    if (result < 0) {
      throw new Error(`Rust rust_router_match_id failed: ${result}`);
    }

    return result - 1;
  }

  private runMatch(
    pathBytes: Uint8Array,
    pathLen: number,
  ): RawMatchResult | null {
    let out = this.outBuffer;

    // Normally runs once.
    // Only retries if the output buffer is too small.
    for (let attempt = 0; attempt < 8; attempt++) {
      const written = toNumber(
        this.runtime.symbols.rust_router_match(
          this.handle,
          this.runtime.ptr(pathBytes),
          pathLen,
          this.runtime.ptr(out),
          out.byteLength,
        ),
      );

      if (written === 0) {
        return null;
      }

      if (written === -2) {
        out = new Uint8Array(out.byteLength * 2);
        continue;
      }

      if (written < 0) {
        throw new Error(`Rust rust_router_match failed: ${written}`);
      }

      if (out !== this.outBuffer) {
        this.outBuffer = out;
      }

      return { out, written };
    }

    throw new Error("Rust rust_router_match output buffer grew too large");
  }

  private parse(
    out: Uint8Array,
    written: number,
    path: string,
    pathBytes: Uint8Array,
    asciiFastPath: boolean,
  ): RouteMatch {
    const view = new DataView(out.buffer, out.byteOffset, written);

    const routeId = view.getUint32(0, true);
    const paramCount = view.getUint8(4);

    if (paramCount === 0) {
      return {
        routeId,
        params: null,
      };
    }

    const names = this.paramNames[routeId] ?? [];
    const params: Record<string, string> = {};

    let pos = 5;

    for (let i = 0; i < paramCount; i++) {
      const paramIndex = view.getUint8(pos);
      pos += 1;

      const start = view.getUint32(pos, true);
      pos += 4;

      const end = view.getUint32(pos, true);
      pos += 4;

      const key = names[paramIndex] ?? `param${paramIndex}`;

      // Fast path for ASCII/percent-encoded URL paths.
      // UTF-8 byte offsets match JS string indices.
      const value = asciiFastPath
        ? path.substring(start, end)
        : decoder.decode(pathBytes.subarray(start, end));

      params[key] = value;
    }

    return {
      routeId,
      params,
    };
  }
}

/**
 * Convenience router for frameworks.
 *
 * Creates one precompiled matchit router per HTTP method.
 */
export class MethodRouter {
  private routers = new Map<string, MatchitRouter>();

  constructor(runtime: FfiRuntime, routes: MethodRoutes) {
    for (const [method, patterns] of Object.entries(routes)) {
      this.routers.set(
        method.toUpperCase(),
        new MatchitRouter(runtime, patterns),
      );
    }
  }

  matchId(method: string, path: string): number | null {
    const router = this.routers.get(method.toUpperCase());
    return router ? router.matchId(path) : null;
  }

  match(method: string, path: string): RouteMatch | null {
    const router = this.routers.get(method.toUpperCase());
    return router ? router.match(path) : null;
  }

  destroy(): void {
    for (const router of this.routers.values()) {
      router.destroy();
    }

    this.routers.clear();
  }
}

export function createRoutingApi(runtime: FfiRuntime) {
  return {
    createRouter(patterns: string[]): MatchitRouter {
      return new MatchitRouter(runtime, patterns);
    },

    createMethodRouter(routes: MethodRoutes): MethodRouter {
      return new MethodRouter(runtime, routes);
    },
  };
}

export type RoutingApi = ReturnType<typeof createRoutingApi>;
````

## File: src/rust-ffi/apis/token.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createTokenApi(runtime: FfiRuntime) {
  const { symbols, callOut } = runtime;

  return {
    randomToken(byteLen: number): Uint8Array {
      return callOut(
        symbols.rust_random_token_v2,
        byteLen * 2 + 64,
        byteLen,
      );
    },
  };
}

export type TokenApi = ReturnType<typeof createTokenApi>;
````

## File: src/rust-ffi/apis/url.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createUrlApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    urlEncode(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_url_encode_v2,
        bytes.byteLength * 3 + 64,
        ptr(bytes),
        bytes.byteLength,
      );
    },

    urlDecode(bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_url_decode_v2,
        bytes.byteLength + 64,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type UrlApi = ReturnType<typeof createUrlApi>;
````

## File: src/rust-ffi/apis/validation.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createValidationApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    validateEmail(bytes: Uint8Array): number {
      return symbols.rust_validate_email_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateUuid(bytes: Uint8Array): number {
      return symbols.rust_validate_uuid_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateIpv4(bytes: Uint8Array): number {
      return symbols.rust_validate_ipv4_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateIpv6(bytes: Uint8Array): number {
      return symbols.rust_validate_ipv6_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },
  };
}

export type ValidationApi = ReturnType<typeof createValidationApi>;
````

## File: src/rust-ffi/apis/websocket.ts
````typescript
import type { FfiRuntime } from "../runtime";

export function createWebSocketApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    wsAcceptKey(key: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_ws_accept_key_v2,
        128,
        ptr(key),
        key.byteLength,
      );
    },
  };
}

export type WebSocketApi = ReturnType<typeof createWebSocketApi>;
````

## File: src/rust-ffi/call.ts
````typescript
import { ptr } from "./pointer";

export type FfiFunction = (...args: any[]) => bigint | number;

const MAX_OUTPUT_SIZE = 256 * 1024 * 1024;

export function callOut(
  fn: FfiFunction,
  outSize: number,
  ...args: any[]
): Uint8Array {
  let size = Math.max(1, outSize);

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

    if (w === -2n) {
      if (size >= MAX_OUTPUT_SIZE) {
        throw new Error(
          `FFI call failed: output buffer too large (>${size} bytes)`,
        );
      }

      size = Math.min(size * 2, MAX_OUTPUT_SIZE);
      continue;
    }

    if (w < 0n) {
      throw new Error(`FFI call failed: ${written}`);
    }

return out.subarray(0, Number(w));
  }
}
````

## File: src/rust-ffi/client.ts
````typescript
import { createCookieApi } from "./apis/cookie";
import { createHashingApi } from "./apis/hashing";
import { createHmacApi } from "./apis/hmac";
import { createHttpApi } from "./apis/http";
import { createJsonApi } from "./apis/json";
import { createJsonPatchApi } from "./apis/json-patch";
import { createMimeApi } from "./apis/mime";
import { createQueryApi } from "./apis/query";
import { createRoutingApi } from "./apis/routing";
import { createTokenApi } from "./apis/token";
import { createUrlApi } from "./apis/url";
import { createValidationApi } from "./apis/validation";
import { createWebSocketApi } from "./apis/websocket";
import { createFfiRuntime, type FfiRuntime } from "./runtime";

export function createRustClient(runtime: FfiRuntime = createFfiRuntime()) {
  return {
    ...createJsonApi(runtime),
    ...createHttpApi(runtime),
    ...createQueryApi(runtime),
    ...createCookieApi(runtime),
    ...createTokenApi(runtime),
    ...createWebSocketApi(runtime),
    ...createJsonPatchApi(runtime),
    ...createHmacApi(runtime),
    ...createRoutingApi(runtime),
    ...createValidationApi(runtime),
    ...createHashingApi(runtime),
    ...createMimeApi(runtime),
    ...createUrlApi(runtime),
  };
}

export type RustClient = ReturnType<typeof createRustClient>;

export const rust = createRustClient();
````

## File: src/rust-ffi/index.ts
````typescript
export { createRustClient, rust } from "./client";
export type { RustClient } from "./client";

export { createFfiRuntime } from "./runtime";
export type { FfiRuntime } from "./runtime";
````

## File: src/rust-ffi/loader.ts
````typescript
import { dlopen, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rustSymbols } from "./symbols";

export function resolveLibraryPath(): string {
  const candidates = [
    process.env.RUST_BENCH_LIB,
    fileURLToPath(
      new URL(`../../target/release/librust_bench.${suffix}`, import.meta.url),
    ),
    fileURLToPath(
      new URL(`../../target/release/rust_bench.${suffix}`, import.meta.url),
    ),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const libPath = candidates.find((path) => existsSync(path));

  if (!libPath) {
    console.error("Could not find Rust shared library.");
    console.error("Run: cargo build --release");
    console.error(`Looked for: ${candidates.join(", ")}`);
    process.exit(1);
    throw new Error("Rust shared library not found");
  }

  return libPath;
}

export function loadRustLibrary() {
  const libPath = resolveLibraryPath();
  console.log(`Loading Rust library: ${libPath}`);
  return dlopen(libPath, rustSymbols);
}
````

## File: src/rust-ffi/pointer.ts
````typescript
import * as ffi from "bun:ffi";

const ffiPtr = (ffi as any).ptr as
  | undefined
  | ((view: any, byteOffset?: number) => number);

export function ptr(view: ArrayBufferView): any {
  if (typeof ffiPtr === "function") {
    return ffiPtr(view);
  }

  const legacyPtr = (view as any).ptr;
  if (typeof legacyPtr === "number") {
    return legacyPtr;
  }

  return view;
}
````

## File: src/rust-ffi/runtime.ts
````typescript
import { callOut, type FfiFunction } from "./call";
import { loadRustLibrary } from "./loader";
import { ptr } from "./pointer";

export interface FfiRuntime {
  ptr: typeof ptr;
  callOut: typeof callOut;
  symbols: Record<string, FfiFunction>;
}

export function createFfiRuntime(): FfiRuntime {
  const lib = loadRustLibrary();
  const symbols = lib.symbols as Record<string, FfiFunction>;

  return {
    ptr,
    callOut,
    symbols,
  };
}
````

## File: src/rust-ffi/symbols.ts
````typescript
import { FFIType } from "bun:ffi";

export const rustSymbols = {
  rust_json_valid_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_json_sum_ids_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_http_parse_request_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_query_parse_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_cookie_parse_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_random_token_v2: {
    returns: FFIType.i64,
    args: [FFIType.u32, FFIType.ptr, FFIType.u64],
  },

  rust_ws_accept_key_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_json_patch_v2: {
    returns: FFIType.i64,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },

  rust_hmac_sha256_v2: {
    returns: FFIType.i64,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },

  rust_hmac_sha256_verify_v2: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },


  rust_validate_email_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_validate_uuid_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_validate_ipv4_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_validate_ipv6_v2: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_crc32_v2: {
    returns: FFIType.u32,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_fnv1a64_v2: {
    returns: FFIType.u64,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_mime_from_extension_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_router_create: {
    returns: FFIType.u64,
    args: [FFIType.ptr, FFIType.u64],
  },

  rust_router_match_id: {
    returns: FFIType.i64,
    args: [FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_router_match: {
    returns: FFIType.i64,
    args: [
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
      FFIType.ptr,
      FFIType.u64,
    ],
  },

  rust_router_destroy: {
    returns: FFIType.i32,
    args: [FFIType.u64],
  },
  rust_url_encode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },

  rust_url_decode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  }
} as const;

export type RustSymbolName = keyof typeof rustSymbols;
````

## File: src/shared/bytes.ts
````typescript
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
````

## File: src/shared/json.ts
````typescript
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};

  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key]);
  }

  return sorted;
}
````

## File: .repomixignore
````
# Add patterns to ignore here, one per line
# Example:
# *.log
# tmp/
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

## File: tsconfig.json
````json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "types": ["bun"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  },
  "include": [
    "index.ts",
    "bench.ts",
    "native.ts",
    "shared-practical.ts",
    "data.ts",
    "src"
  ]
}
````

## File: .gitignore
````
node_modules
target
.DS_Store
*.log
.env
.cleanup-backup
````

## File: bench.ts
````typescript
import { runBenchmark } from "./src/bench";

runBenchmark();
````

## File: Cargo.toml
````toml
[package]
name = "rust_bench"
version = "0.5.0"
edition = "2021"

[lib]
name = "rust_bench"
crate-type = ["cdylib"]
path = "rust/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sonic-rs = "0.5.8"
sha2 = "0.10"
sha1 = "0.11"
hmac = "0.12"
hex = "0.4"
base64 = "0.22"
crc32fast = "1"
fnv = "1"
percent-encoding = "2"
form_urlencoded = "1"
httparse = "1"
cookie = "0.18"
matchit = "0.9.2"
email_address = "0.2"
uuid = { version = "1", features = ["v4"] }
json-patch = "4"
mime_guess = "2"
getrandom = "0.4.3"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
strip = true
````

## File: data.ts
````typescript
export { jsonRowsBytes, createJsonRows } from "./src/data/json-rows";
export type { JsonRow } from "./src/data/json-rows";
````

## File: index.ts
````typescript
export { rust, createRustClient } from "./src/rust-ffi";
export type { RustClient } from "./src/rust-ffi";

export * as native from "./src/baseline";

export { encoder, decoder } from "./src/shared/bytes";
export { jsonRowsBytes, createJsonRows } from "./src/data/json-rows";
export type { JsonRow } from "./src/data/json-rows";
````

## File: native.ts
````typescript
export { rust, createRustClient } from "./src/rust-ffi";
export type { RustClient } from "./src/rust-ffi";
````

## File: package.json
````json
{
  "name": "bun-rust-practical",
  "version": "0.5.0",
  "private": false,
  "type": "module",
  "main": "index.ts",
  "module": "index.ts",
  "types": "index.ts",
  "exports": {
    ".": "./index.ts"
  },
  "files": [
    "index.ts",
    "bench.ts",
    "native.ts",
    "shared-practical.ts",
    "data.ts",
    "src",
    "rust",
    "Cargo.toml",
    "README.md"
  ],
  "scripts": {
    "build": "cargo build --release",
    "bench": "bun run build && bun bench.ts",
    "check": "bun bench.ts",
    "bench:router-http": "bun run build && bun src/bench/router-http.bench.ts"
  },
  "dependencies": {
    "cookie-es": "^3.1.1",
    "crc-32": "^1.2.2",
    "fast-json-patch": "^3.1.1",
    "mime-types": "^3.0.2",
    "validator": "^13.15.35"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "@types/mime-types": "^3.0.1",
    "@types/validator": "^13.15.10"
  },
  "engines": {
    "bun": ">=1.1.0"
  }
}
````

## File: README.md
````markdown
# bun-rust-practical

Practical Bun + Rust FFI benchmark package.

This package keeps only the practical Rust-accelerated functions and their native Bun/JavaScript benchmark equivalents.

## Build

```bash
bun install
cargo build --release
```

## Benchmark

```bash
bun bench.ts
```

Or:

```bash
bun run bench
```

## Exported API

```ts
import { rust, native } from "bun-rust-practical";
```

`rust` contains Rust FFI implementations.

`native` contains JavaScript/Bun baseline implementations used for benchmarking.
````

## File: shared-practical.ts
````typescript
export * from "./src/baseline";
export { encoder, decoder } from "./src/shared/bytes";
````
