// rust/ffi/ingress.rs — ingress pipeline C-ABI exports.
//
// The opaque-handle fast path (`castrum_ingress_handle_packed` /
// `castrum_ingress_handle_components`) runs the ENTIRE ingress pipeline in one
// call, plus the binary-layout constants projection (`castrum_ingress_layout`).
// All three follow the aliasing-insurance + `panic_guard` conventions of the
// napi entry points.

use std::slice;

use super::util::panic_guard;

/// Run the ingress pipeline on a packed request frame. `inner` is the opaque
/// pointer (as an integer) from `Ingress.ingressInnerPtr()` — valid ONLY while
/// the `Ingress` instance is alive (see the method's safety note). This is the
/// hot path: it runs the ENTIRE pipeline (parsing, trust/proxy, schema, CORS,
/// rate limit, response) in one C-ABI call, cutting the N-API crossing +
/// marshaling that a per-request `handleRequestPacked` call would pay.
///
/// Returns bytes written into `out` (0 = error / too-small buffer).
///
/// # Safety
/// `inner` must be the live `IngressInner` pointer from a live `Ingress`
/// instance; `input` valid for `input_len` reads; `body` valid for `body_len`
/// reads (null/0 = no body); `out` valid for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_handle_packed(
    inner: usize,
    input: *const u8,
    input_len: usize,
    body: *const u8,
    body_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let inner = inner as *const crate::ingress::IngressInner;
    if inner.is_null() || input.is_null() || out.is_null() {
        return 0;
    }
    let inp = slice::from_raw_parts(input, input_len);
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    let body_slice: &[u8] = if body.is_null() || body_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(body, body_len)
    };
    // Mirror the napi entry (`util::run_packed_into`): when the input OR the
    // body aliases `out`, copy it first so the shared `&[u8]` and the `&mut
    // [u8]` output borrow never alias (aliased &/&mut is instant UB).
    let owned_input;
    let input_ref: &[u8] = if crate::util::slices_overlap(inp, out_slice) {
        owned_input = inp.to_vec();
        &owned_input
    } else {
        inp
    };
    let owned_body;
    let body_ref: &[u8] = if crate::util::slices_overlap(body_slice, out_slice) {
        owned_body = body_slice.to_vec();
        &owned_body
    } else {
        body_slice
    };
    // A panic must not unwind through the C ABI (that would kill the whole Bun
    // process — the `11-concurrent-burst` crash). Catch it and report 0 (error)
    // so the JS wrapper turns it into a 500, matching the napi path's
    // catch_unwind. `handle_packed` borrows `&self` with no interior mutability
    // on the hot path, so the instance stays consistent after an unwind.
    panic_guard(
        || {
            (&*inner)
                .handle_packed(input_ref, body_ref, out_slice)
                .unwrap_or(0)
        },
        0,
    )
}

/// Run the ingress pipeline from raw request components — the `bun:ffi`
/// cstring sibling of `castrum_ingress_handle_packed`.
///
/// `url` / `ip` are NUL-terminated UTF-8 cstrings (`bun:ffi` `cstring` ARGs —
/// the engine transcodes the JS strings to call-scoped buffers in-engine), so
/// the JS side skips the frame assembly + `Buffer.write` UTF-8 encode for the
/// URL/IP. `rid` / `headers` / `body` are `(ptr,len)` byte slices (headers =
/// the packed `[u16 count] {pairs}` block); `out` receives the packed decision.
/// Same wire format + semantics as the packed entry — the shared core is
/// `IngressInner::handle_components`.
///
/// Returns bytes written into `out` (0 = error / too-small buffer).
///
/// # Safety
/// `inner` must be the live `IngressInner` pointer from a live `Ingress`
/// instance; `url`/`ip` must be valid NUL-terminated buffers (the engine
/// guarantees this for `cstring` args); `rid`/`headers`/`body` valid for their
/// declared lengths (null/0 = no body); `out` valid for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_handle_components(
    inner: usize,
    method_kind: u8,
    url: *const std::os::raw::c_char,
    ip: *const std::os::raw::c_char,
    rid: *const u8,
    rid_len: usize,
    headers: *const u8,
    headers_len: usize,
    body: *const u8,
    body_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    let inner = inner as *const crate::ingress::IngressInner;
    if inner.is_null()
        || url.is_null()
        || ip.is_null()
        || rid.is_null()
        || headers.is_null()
        || out.is_null()
    {
        return 0;
    }
    if out_cap < crate::ingress::output::OUT_DATA_START {
        return 0;
    }
    let url_bytes = std::ffi::CStr::from_ptr(url).to_bytes();
    let ip_bytes = std::ffi::CStr::from_ptr(ip).to_bytes();
    let rid_slice = slice::from_raw_parts(rid, rid_len);
    let headers_slice = slice::from_raw_parts(headers, headers_len);
    let body_slice: &[u8] = if body.is_null() || body_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(body, body_len)
    };
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    // Aliasing insurance (mirrors the packed entry): if any input aliases the
    // output, copy it first so the shared `&[u8]` and the `&mut [u8]` output
    // borrow never alias (aliased &/&mut is instant UB). The `url`/`ip`
    // cstrings are engine-scoped buffers and can never alias `out`.
    let owned_rid;
    let rid_ref: &[u8] = if crate::util::slices_overlap(rid_slice, out_slice) {
        owned_rid = rid_slice.to_vec();
        &owned_rid
    } else {
        rid_slice
    };
    let owned_headers;
    let headers_ref: &[u8] = if crate::util::slices_overlap(headers_slice, out_slice) {
        owned_headers = headers_slice.to_vec();
        &owned_headers
    } else {
        headers_slice
    };
    let owned_body;
    let body_ref: &[u8] = if crate::util::slices_overlap(body_slice, out_slice) {
        owned_body = body_slice.to_vec();
        &owned_body
    } else {
        body_slice
    };
    let mk = crate::http::method::MethodKind::from_u8(method_kind);
    // A panic must not unwind through the C ABI — catch it and report 0 (the
    // JS wrapper turns it into a 500), matching the packed entry.
    panic_guard(
        || {
            (&*inner)
                .handle_components(
                    mk,
                    url_bytes,
                    ip_bytes,
                    rid_ref,
                    headers_ref,
                    body_ref,
                    out_slice,
                )
                .unwrap_or(0)
        },
        0,
    )
}

// ── Ingress binary-layout constants (C ABI) ──────────────────────
// The napi projection (`ingress_constants.rs`) exposes these to JS by name;
// this C-ABI variant lets Bun read the SAME values via `bun:ffi` WITHOUT
// loading the napi addon, so `import castrum` is FFI-only under Bun. Values
// are read directly from `output.rs` (the single numeric source). Field ORDER
// is the wire contract — pinned by `ingress_layout_c_abi_matches_output_source`
// below and by the bun:ffi bind-time self-test (which falls back to napi if the
// pinned values don't line up).

/// `#[repr(C)]` projection of the ingress layout constants for the FFI path.
/// `castrum_ingress_layout` memcpys this struct into the caller's buffer; the
/// JS side reads it as 38 × u32 little-endian at the same slot order.
#[repr(C)]
pub struct IngressLayout {
    // Output buffer layout (u32)
    pub out_verdict: u32,
    pub out_error_code: u32,
    pub out_status: u32,
    pub out_flags: u32,
    pub out_rate_limit: u32,
    pub out_rate_remaining: u32,
    pub out_rate_reset: u32,
    pub out_retry_after: u32,
    pub out_cookies_json_len: u32,
    pub out_query_json_len: u32,
    pub out_header_variant: u32,
    pub out_body_json_len: u32,
    pub out_data_start: u32,
    // Flags
    pub flag_has_cookies: u32,
    pub flag_has_query: u32,
    pub flag_body_valid_json: u32,
    pub flag_schema_valid: u32,
    pub flag_cors_allowed: u32,
    pub flag_is_preflight: u32,
    pub flag_rate_limited: u32,
    pub flag_https: u32,
    pub flag_trusted_proxy: u32,
    pub flag_body_truncated: u32,
    // Header variant bits
    pub hv_json: u32,
    pub hv_cors_simple: u32,
    pub hv_cors_preflight: u32,
    pub hv_rate_active: u32,
    pub hv_rate_limited: u32,
    pub hv_count: u32,
    // Error codes
    pub err_none: u32,
    pub err_cors_preflight: u32,
    pub err_rate_limited: u32,
    pub err_body_too_large: u32,
    pub err_invalid_json: u32,
    pub err_schema_validation: u32,
    pub err_bad_request: u32,
    pub err_request_too_large: u32,
    pub err_internal: u32,
}

impl IngressLayout {
    /// Build the layout from `output.rs` (the single numeric source).
    const fn from_output() -> Self {
        use crate::ingress::output as o;
        Self {
            out_verdict: o::OUT_VERDICT as u32,
            out_error_code: o::OUT_ERROR_CODE as u32,
            out_status: o::OUT_STATUS as u32,
            out_flags: o::OUT_FLAGS as u32,
            out_rate_limit: o::OUT_RATE_LIMIT as u32,
            out_rate_remaining: o::OUT_RATE_REMAINING as u32,
            out_rate_reset: o::OUT_RATE_RESET as u32,
            out_retry_after: o::OUT_RETRY_AFTER as u32,
            out_cookies_json_len: o::OUT_COOKIES_JSON_LEN as u32,
            out_query_json_len: o::OUT_QUERY_JSON_LEN as u32,
            out_header_variant: o::OUT_HEADER_VARIANT as u32,
            out_body_json_len: o::OUT_BODY_JSON_LEN as u32,
            out_data_start: o::OUT_DATA_START as u32,
            flag_has_cookies: o::FLAG_HAS_COOKIES,
            flag_has_query: o::FLAG_HAS_QUERY,
            flag_body_valid_json: o::FLAG_BODY_VALID_JSON,
            flag_schema_valid: o::FLAG_SCHEMA_VALID,
            flag_cors_allowed: o::FLAG_CORS_ALLOWED,
            flag_is_preflight: o::FLAG_IS_PREFLIGHT,
            flag_rate_limited: o::FLAG_RATE_LIMITED,
            flag_https: o::FLAG_HTTPS,
            flag_trusted_proxy: o::FLAG_TRUSTED_PROXY,
            flag_body_truncated: o::FLAG_BODY_TRUNCATED,
            hv_json: o::HV_JSON as u32,
            hv_cors_simple: o::HV_CORS_SIMPLE as u32,
            hv_cors_preflight: o::HV_CORS_PREFLIGHT as u32,
            hv_rate_active: o::HV_RATE_ACTIVE as u32,
            hv_rate_limited: o::HV_RATE_LIMITED as u32,
            hv_count: o::HV_COUNT as u32,
            err_none: o::ERR_CODE_NONE as u32,
            err_cors_preflight: o::ERR_CODE_CORS_PREFLIGHT as u32,
            err_rate_limited: o::ERR_CODE_RATE_LIMITED as u32,
            err_body_too_large: o::ERR_CODE_BODY_TOO_LARGE as u32,
            err_invalid_json: o::ERR_CODE_INVALID_JSON as u32,
            err_schema_validation: o::ERR_CODE_SCHEMA_VALIDATION as u32,
            err_bad_request: o::ERR_CODE_BAD_REQUEST as u32,
            err_request_too_large: o::ERR_CODE_REQUEST_TOO_LARGE as u32,
            err_internal: o::ERR_CODE_INTERNAL as u32,
        }
    }
}

/// Write the `IngressLayout` blob (38 × u32 LE) into `out`; returns bytes
/// written (0 when `out` is too small or null).
///
/// # Safety
/// `out` must be valid for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ingress_layout(out: *mut u8, out_cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    const LAYOUT: IngressLayout = IngressLayout::from_output();
    let n = core::mem::size_of::<IngressLayout>();
    if out_cap < n {
        return 0;
    }
    core::ptr::copy_nonoverlapping(&LAYOUT as *const IngressLayout as *const u8, out, n);
    n
}
