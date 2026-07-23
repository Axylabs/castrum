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