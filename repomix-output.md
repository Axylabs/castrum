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

## File: src/lib.rs
````rust
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
````

## File: .gitignore
````
node_modules
target
.DS_Store
*.log
.env
````

## File: .repomixignore
````
# Add patterns to ignore here, one per line
# Example:
# *.log
# tmp/
````

## File: bench.ts
````typescript
import { rust } from "./native";
import * as practical from "./shared-practical";
import { decoder, encoder } from "./shared-practical";
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

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${a}`);
    console.error(`  expected: ${b}`);
    process.exit(1);
  }
}

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
const hmacSig = practical.nativeHmacSha256(hmacKey, hmacData);

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

const crcInput = encoder.encode("Hello, practical CRC32 checksum test data!");

const mimeExt = encoder.encode("json");

const urlEncodeInput = encoder.encode("hello world & foo=bar");
const urlDecodeInput = encoder.encode("hello%20world%20%26%20foo%3Dbar");

assertEqual(
  practical.nativeJsonValid(jsonPayload),
  rust.jsonValid(jsonPayload) === 1,
  "json valid",
);

assertEqual(
  practical.nativeJsonSum(jsonPayload),
  rust.jsonSumIds(jsonPayload),
  "json sum",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeHttpParseRequest(httpRaw))),
  JSON.parse(decoder.decode(rust.httpParseRequest(httpRaw))),
  "http parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeQueryParse(queryStr))),
  JSON.parse(decoder.decode(rust.queryParse(queryStr))),
  "query parse",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeCookieParse(cookieStr))),
  JSON.parse(decoder.decode(rust.cookieParse(cookieStr))),
  "cookie parse",
);

assertEqual(
  decoder.decode(practical.nativeWsAcceptKey(wsKey)),
  decoder.decode(rust.wsAcceptKey(wsKeyBytes)),
  "ws accept key",
);

assertDeepEqual(
  JSON.parse(decoder.decode(practical.nativeJsonPatch(jsonDoc, jsonPatch))),
  JSON.parse(decoder.decode(rust.jsonPatch(jsonDoc, jsonPatch))),
  "json patch",
);

assertEqual(
  decoder.decode(hmacSig),
  decoder.decode(rust.hmacSha256(hmacKey, hmacData)),
  "hmac sha256",
);

assertEqual(
  practical.nativeHmacSha256Verify(hmacKey, hmacData, hmacSig),
  rust.hmacSha256Verify(hmacKey, hmacData, hmacSig) === 1,
  "hmac verify",
);

assertDeepEqual(
  JSON.parse(
    decoder.decode(
      practical.nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")!,
    ),
  ),
  JSON.parse(decoder.decode(rust.routeMatch(routePattern, routePath))),
  "route match",
);

assertEqual(
  practical.nativeValidateEmail(emailOk),
  rust.validateEmail(emailOk) === 1,
  "email valid",
);

assertEqual(
  practical.nativeValidateUuid(uuidOk),
  rust.validateUuid(uuidOk) === 1,
  "uuid valid",
);

assertEqual(
  practical.nativeValidateIpv4(ipv4Ok),
  rust.validateIpv4(ipv4Ok) === 1,
  "ipv4 valid",
);

assertEqual(
  practical.nativeValidateIpv6(ipv6Ok),
  rust.validateIpv6(ipv6Ok) === 1,
  "ipv6 valid",
);

assertEqual(
  practical.nativeCrc32(crcInput),
  rust.crc32(crcInput),
  "crc32",
);

assertEqual(
  practical.nativeFnv1a64(crcInput),
  rust.fnv1a64(crcInput),
  "fnv1a64",
);

assertEqual(
  practical.nativeMimeFromExtension("json"),
  decoder.decode(rust.mimeFromExtension(mimeExt)),
  "mime",
);

assertEqual(
  practical.nativeUrlEncode("hello world & foo=bar"),
  decoder.decode(rust.urlEncode(urlEncodeInput)),
  "url encode",
);

assertEqual(
  practical.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar"),
  decoder.decode(rust.urlDecode(urlDecodeInput)),
  "url decode",
);

console.log("Practical correctness checks passed. ✓");

const results: BenchResult[] = [];

function push(
  name: string,
  fn: () => unknown,
  iterations = 200,
  warmup = 20,
) {
  results.push(bench(name, fn, iterations, warmup));
}

push("native:json_valid", () => practical.nativeJsonValid(jsonPayload), 100, 10);
push("rust:json_valid", () => rust.jsonValid(jsonPayload), 100, 10);

push("native:json_sum", () => practical.nativeJsonSum(jsonPayload), 100, 10);
push("rust:json_sum", () => rust.jsonSumIds(jsonPayload), 100, 10);

push("native:http_parse", () => practical.nativeHttpParseRequest(httpRaw).byteLength, 500, 50);
push("rust:http_parse", () => rust.httpParseRequest(httpRaw).byteLength, 500, 50);

push("native:query_parse", () => practical.nativeQueryParse(queryStr).byteLength, 500, 50);
push("rust:query_parse", () => rust.queryParse(queryStr).byteLength, 500, 50);

push("native:cookie_parse", () => practical.nativeCookieParse(cookieStr).byteLength, 500, 50);
push("rust:cookie_parse", () => rust.cookieParse(cookieStr).byteLength, 500, 50);

push("native:random_token", () => practical.nativeRandomToken(32).byteLength, 1000, 100);
push("rust:random_token", () => rust.randomToken(32).byteLength, 1000, 100);

push("native:ws_accept_key", () => practical.nativeWsAcceptKey(wsKey).byteLength, 1000, 100);
push("rust:ws_accept_key", () => rust.wsAcceptKey(wsKeyBytes).byteLength, 1000, 100);

push("native:json_patch", () => practical.nativeJsonPatch(jsonDoc, jsonPatch).byteLength, 500, 50);
push("rust:json_patch", () => rust.jsonPatch(jsonDoc, jsonPatch).byteLength, 500, 50);

push("native:hmac_sha256", () => practical.nativeHmacSha256(hmacKey, hmacData).byteLength, 500, 50);
push("rust:hmac_sha256", () => rust.hmacSha256(hmacKey, hmacData).byteLength, 500, 50);

push("native:hmac_verify", () => practical.nativeHmacSha256Verify(hmacKey, hmacData, hmacSig) ? 1 : 0, 500, 50);
push("rust:hmac_verify", () => rust.hmacSha256Verify(hmacKey, hmacData, hmacSig), 500, 50);

push("native:route_match", () => practical.nativeRouteMatch("/users/:id/posts/:postId", "/users/42/posts/7")?.byteLength ?? 0, 500, 50);
push("rust:route_match", () => rust.routeMatch(routePattern, routePath).byteLength, 500, 50);

push("native:validate_email", () => practical.nativeValidateEmail(emailOk) ? 1 : 0, 1000, 100);
push("rust:validate_email", () => rust.validateEmail(emailOk), 1000, 100);

push("native:validate_uuid", () => practical.nativeValidateUuid(uuidOk) ? 1 : 0, 1000, 100);
push("rust:validate_uuid", () => rust.validateUuid(uuidOk), 1000, 100);

push("native:validate_ipv4", () => practical.nativeValidateIpv4(ipv4Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv4", () => rust.validateIpv4(ipv4Ok), 1000, 100);

push("native:validate_ipv6", () => practical.nativeValidateIpv6(ipv6Ok) ? 1 : 0, 1000, 100);
push("rust:validate_ipv6", () => rust.validateIpv6(ipv6Ok), 1000, 100);

push("native:crc32", () => practical.nativeCrc32(crcInput), 1000, 100);
push("rust:crc32", () => rust.crc32(crcInput), 1000, 100);

push("native:fnv1a64", () => practical.nativeFnv1a64(crcInput), 1000, 100);
push("rust:fnv1a64", () => rust.fnv1a64(crcInput), 1000, 100);

push("native:mime", () => practical.nativeMimeFromExtension("json").length, 1000, 100);
push("rust:mime", () => rust.mimeFromExtension(mimeExt).byteLength, 1000, 100);

push("native:url_encode", () => practical.nativeUrlEncode("hello world & foo=bar").length, 1000, 100);
push("rust:url_encode", () => rust.urlEncode(urlEncodeInput).byteLength, 1000, 100);

push("native:url_decode", () => practical.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length, 1000, 100);
push("rust:url_decode", () => rust.urlDecode(urlDecodeInput).byteLength, 1000, 100);

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

report("JSON valid", "native:json_valid", "rust:json_valid");
report("JSON sum", "native:json_sum", "rust:json_sum");
report("HTTP parse", "native:http_parse", "rust:http_parse");
report("Query parse", "native:query_parse", "rust:query_parse");
report("Cookie parse", "native:cookie_parse", "rust:cookie_parse");
report("Random token", "native:random_token", "rust:random_token");
report("WebSocket accept", "native:ws_accept_key", "rust:ws_accept_key");
report("JSON Patch", "native:json_patch", "rust:json_patch");
report("HMAC sign", "native:hmac_sha256", "rust:hmac_sha256");
report("HMAC verify", "native:hmac_verify", "rust:hmac_verify");
report("Route match", "native:route_match", "rust:route_match");
report("Email validation", "native:validate_email", "rust:validate_email");
report("UUID validation", "native:validate_uuid", "rust:validate_uuid");
report("IPv4 validation", "native:validate_ipv4", "rust:validate_ipv4");
report("IPv6 validation", "native:validate_ipv6", "rust:validate_ipv6");
report("CRC32", "native:crc32", "rust:crc32");
report("FNV-1a 64", "native:fnv1a64", "rust:fnv1a64");
report("MIME lookup", "native:mime", "rust:mime");
report("URL encode", "native:url_encode", "rust:url_encode");
report("URL decode", "native:url_decode", "rust:url_decode");
````

## File: Cargo.toml
````toml
[package]
name = "rust_bench"
version = "0.4.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

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
````

## File: index.ts
````typescript
export { rust } from "./native";
export * as native from "./shared-practical";
export { encoder, decoder } from "./shared-practical";
export { jsonRowsBytes } from "./data";
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
  rust_route_match_v2: {
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
  rust_url_encode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
  rust_url_decode_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
});

const symbols = lib.symbols as Record<string, any>;

function callOut(fn: (...a: any[]) => bigint, outSize: number, ...args: any[]): Uint8Array {
  let size = Math.max(1, outSize);
  const maxSize = 256 * 1024 * 1024;

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

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
  jsonValid: (b: Uint8Array) =>
    symbols.rust_json_valid_v2(ptr(b), b.byteLength) as number,

  jsonSumIds: (b: Uint8Array) =>
    symbols.rust_json_sum_ids_v2(ptr(b), b.byteLength) as bigint,

  httpParseRequest: (b: Uint8Array) =>
    callOut(symbols.rust_http_parse_request_v2, 64 * 1024, ptr(b), b.byteLength),

  queryParse: (b: Uint8Array) =>
    callOut(symbols.rust_query_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  cookieParse: (b: Uint8Array) =>
    callOut(symbols.rust_cookie_parse_v2, 64 * 1024, ptr(b), b.byteLength),

  randomToken: (byteLen: number) =>
    callOut(symbols.rust_random_token_v2, byteLen * 2 + 64, byteLen),

  wsAcceptKey: (key: Uint8Array) =>
    callOut(symbols.rust_ws_accept_key_v2, 128, ptr(key), key.byteLength),

  jsonPatch: (doc: Uint8Array, patch: Uint8Array) =>
    callOut(
      symbols.rust_json_patch_v2,
      doc.byteLength + patch.byteLength + 4096,
      ptr(doc),
      doc.byteLength,
      ptr(patch),
      patch.byteLength,
    ),

  hmacSha256: (key: Uint8Array, data: Uint8Array) =>
    callOut(
      symbols.rust_hmac_sha256_v2,
      128,
      ptr(key),
      key.byteLength,
      ptr(data),
      data.byteLength,
    ),

  hmacSha256Verify: (key: Uint8Array, data: Uint8Array, sig: Uint8Array) =>
    symbols.rust_hmac_sha256_verify_v2(
      ptr(key),
      key.byteLength,
      ptr(data),
      data.byteLength,
      ptr(sig),
      sig.byteLength,
    ) as number,

  routeMatch: (pattern: Uint8Array, path: Uint8Array) =>
    callOut(
      symbols.rust_route_match_v2,
      4096,
      ptr(pattern),
      pattern.byteLength,
      ptr(path),
      path.byteLength,
    ),

  validateEmail: (b: Uint8Array) =>
    symbols.rust_validate_email_v2(ptr(b), b.byteLength) as number,

  validateUuid: (b: Uint8Array) =>
    symbols.rust_validate_uuid_v2(ptr(b), b.byteLength) as number,

  validateIpv4: (b: Uint8Array) =>
    symbols.rust_validate_ipv4_v2(ptr(b), b.byteLength) as number,

  validateIpv6: (b: Uint8Array) =>
    symbols.rust_validate_ipv6_v2(ptr(b), b.byteLength) as number,

  crc32: (b: Uint8Array) =>
    symbols.rust_crc32_v2(ptr(b), b.byteLength) as number,

  fnv1a64: (b: Uint8Array) =>
    symbols.rust_fnv1a64_v2(ptr(b), b.byteLength) as bigint,

  mimeFromExtension: (ext: Uint8Array) =>
    callOut(symbols.rust_mime_from_extension_v2, 256, ptr(ext), ext.byteLength),

  urlEncode: (b: Uint8Array) =>
    callOut(symbols.rust_url_encode_v2, b.byteLength * 3 + 64, ptr(b), b.byteLength),

  urlDecode: (b: Uint8Array) =>
    callOut(symbols.rust_url_decode_v2, b.byteLength + 64, ptr(b), b.byteLength),
};
````

## File: package.json
````json
{
  "name": "bun-rust-practical",
  "version": "0.4.0",
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
    "native.ts",
    "shared-practical.ts",
    "data.ts",
    "bench.ts",
    "src",
    "Cargo.toml",
    "README.md"
  ],
  "scripts": {
    "build": "cargo build --release",
    "bench": "bun run build && bun bench.ts",
    "cleanup": "bash cleanup.sh"
  },
  "dependencies": {
    "cookie-es": "^3.1.1",
    "crc-32": "^1.2.2",
    "fast-json-patch": "^3.1.1",
    "find-my-way": "^9.7.0",
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

## File: shared-practical.ts
````typescript
import { parse as parseCookie } from "cookie-es";
import { applyPatch } from "fast-json-patch";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import mime from "mime-types";
import validator from "validator";
import createRouter from "find-my-way";
import * as CRC32 from "crc-32";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const rows = JSON.parse(decoder.decode(bytes)) as Array<{ id?: unknown }>;
  let sum = 0n;

  for (const row of rows) {
    if (typeof row.id === "number") {
      sum += BigInt(Math.trunc(row.id));
    }
  }

  return sum;
}

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

export function nativeCookieParse(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies = parseCookie(text);
  return encoder.encode(JSON.stringify(cookies));
}

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return encoder.encode(Buffer.from(bytes).toString("hex"));
}

export function nativeWsAcceptKey(key: string | Uint8Array): Uint8Array {
  const keyText = typeof key === "string" ? key : decoder.decode(key);
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(keyText + magic);

  const hash = new Bun.CryptoHasher("sha1")
    .update(toPlainBuffer(combined))
    .digest();

  return encoder.encode(Buffer.from(hash).toString("base64"));
}

export function nativeHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
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

export function nativeJsonPatch(docBytes: Uint8Array, patchBytes: Uint8Array): Uint8Array {
  const doc = JSON.parse(decoder.decode(docBytes));
  const patch = JSON.parse(decoder.decode(patchBytes));
  const result = applyPatch(doc, patch, true, false).newDocument;
  return encoder.encode(JSON.stringify(result));
}

export function nativeRouteMatch(pattern: string, path: string): Uint8Array | null {
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

export function nativeMimeFromExtension(ext: string): string {
  return mime.lookup(ext) || "application/octet-stream";
}

export function nativeUrlEncode(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return encodeURIComponent(text);
}

export function nativeUrlDecode(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return decodeURIComponent(text);
}
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
