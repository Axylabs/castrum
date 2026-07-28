// rust/ingress.rs — v7: ARRAYVEC HEADERS + QUANTA TIME + COLD ERROR PATHS
#![allow(clippy::too_many_arguments)]

use napi::bindgen_prelude::*;
use napi::{Env, Status};
use napi_derive::napi;
use std::ptr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use quanta::Instant as QuantaInstant;

use crate::hashing::{fast_hash_bytes, fast_hash_seeded};
use crate::util::trim_ascii_whitespace;

// ── Output buffer binary layout v5/v6 ─────────────────────────────
const OUT_VERDICT: usize = 0;
const OUT_ERROR_CODE: usize = 1;
const OUT_STATUS: usize = 2;
const OUT_FLAGS: usize = 4;
const OUT_RATE_LIMIT: usize = 8;
const OUT_RATE_REMAINING: usize = 12;
const OUT_RATE_RESET: usize = 16;
const OUT_RETRY_AFTER: usize = 24;
const OUT_COOKIES_JSON_LEN: usize = 32;
const OUT_QUERY_JSON_LEN: usize = 36;
const OUT_HEADER_VARIANT: usize = 40;
const OUT_BODY_JSON_LEN: usize = 44;
const OUT_DATA_START: usize = 48;

// ── Flags ──
const FLAG_HAS_COOKIES: u32 = 1 << 0;
const FLAG_HAS_QUERY: u32 = 1 << 1;
const FLAG_BODY_VALID_JSON: u32 = 1 << 2;
const FLAG_SCHEMA_VALID: u32 = 1 << 3;
const FLAG_CORS_ALLOWED: u32 = 1 << 4;
const FLAG_IS_PREFLIGHT: u32 = 1 << 5;
const FLAG_RATE_LIMITED: u32 = 1 << 6;
const FLAG_HTTPS: u32 = 1 << 7;
const FLAG_TRUSTED_PROXY: u32 = 1 << 8;
const FLAG_BODY_TRUNCATED: u32 = 1 << 9; // ⭐ New escape hatch

const HV_JSON: u8 = 1 << 0;
const HV_CORS_SIMPLE: u8 = 1 << 1;
const HV_CORS_PREFLIGHT: u8 = 1 << 2;
const HV_RATE_ACTIVE: u8 = 1 << 3;
const HV_RATE_LIMITED: u8 = 1 << 4;

const ERR_CODE_NONE: u8 = 0;
const ERR_CODE_CORS_PREFLIGHT: u8 = 1;
const ERR_CODE_RATE_LIMITED: u8 = 2;
const ERR_CODE_BODY_TOO_LARGE: u8 = 3;
const ERR_CODE_INVALID_JSON: u8 = 4;
const ERR_CODE_SCHEMA_VALIDATION: u8 = 5;

const HAS_ORIGIN: u8 = 1 << 0;
const HAS_COOKIE: u8 = 1 << 1;
const HAS_XFF: u8 = 1 << 2;
const HAS_X_REAL_IP: u8 = 1 << 3;
const HAS_XFP: u8 = 1 << 4;
const HAS_ACRM: u8 = 1 << 5;

// ── Unsafe output helpers ──

#[inline(always)]
unsafe fn write_u16_le_unchecked(out: &mut [u8], pos: usize, value: u16) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 2);
}

#[inline(always)]
unsafe fn write_u32_le_unchecked(out: &mut [u8], pos: usize, value: u32) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 4);
}

#[inline(always)]
unsafe fn write_u64_le_unchecked(out: &mut [u8], pos: usize, value: u64) {
    ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), out.as_mut_ptr().add(pos), 8);
}

#[inline(always)]
fn ranges_overlap(a: &[u8], b: &[u8]) -> bool {
    if a.is_empty() || b.is_empty() { return false; }
    let a_start = a.as_ptr() as usize;
    let b_start = b.as_ptr() as usize;
    let a_end = a_start.saturating_add(a.len());
    let b_end = b_start.saturating_add(b.len());
    a_start < b_end && b_start < a_end
}

// ── Time helpers — using quanta for TSC-based fast monotonic time ──

static START: OnceLock<QuantaInstant> = OnceLock::new();
static WALL_OFFSET_MS: OnceLock<i128> = OnceLock::new();

#[inline(always)]
fn monotonic_ms() -> u128 {
    START.get_or_init(QuantaInstant::now).elapsed().as_millis()
}

#[inline(always)]
fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[inline(always)]
fn wall_offset_ms() -> i128 {
    *WALL_OFFSET_MS.get_or_init(|| wall_now_ms() as i128 - monotonic_ms() as i128)
}

#[inline(always)]
fn rate_now_ms() -> u64 {
    let v = monotonic_ms() as i128 + wall_offset_ms();
    if v < 0 { 0 } else { v as u64 }
}

// ── Lock-free striped rate limiter ──

const RATE_STRIPE_COUNT: usize = 4096;
const RATE_STRIPE_MASK: usize = RATE_STRIPE_COUNT - 1;

#[repr(align(64))]
struct RateStripe {
    prev: AtomicU32,
    curr: AtomicU32,
    window_start: AtomicU64,
}

impl RateStripe {
    #[inline(always)]
    fn new() -> Self {
        Self {
            prev: AtomicU32::new(0),
            curr: AtomicU32::new(0),
            window_start: AtomicU64::new(0),
        }
    }
}

struct RateLimiterState {
    stripes: Box<[RateStripe]>,
}

static RATE_STATE: OnceLock<RateLimiterState> = OnceLock::new();
static LIMITER_ID: AtomicU64 = AtomicU64::new(0);
static RATE_FAIL_OPEN: AtomicU64 = AtomicU64::new(0);

fn rate_state() -> &'static RateLimiterState {
    RATE_STATE.get_or_init(|| RateLimiterState {
        stripes: (0..RATE_STRIPE_COUNT)
            .map(|_| RateStripe::new())
            .collect::<Box<[RateStripe]>>(),
    })
}

#[derive(Clone)]
struct RateLimitPolicy {
    limit: u32,
    window_ms: u64,
    key_base: u64,
    disabled: bool,
}

impl Default for RateLimitPolicy {
    fn default() -> Self {
        Self { limit: 0, window_ms: 1, key_base: 0, disabled: true }
    }
}

impl RateLimitPolicy {
    fn new(limit: u32, window_ms: u32) -> Self {
        let id = LIMITER_ID.fetch_add(1, Ordering::Relaxed);
        let key_base = fast_hash_bytes(&id.to_le_bytes());
        Self {
            limit,
            window_ms: window_ms.max(1) as u64,
            key_base,
            disabled: limit == u32::MAX,
        }
    }
}

#[inline(always)]
fn rate_limit_check_lockfree(key: u64, limit: u32, window_ms: u64, now_ms: u64) -> (bool, u32, u64) {
    if limit == 0 {
        return (false, 0, now_ms.saturating_add(window_ms.max(1)));
    }

    let state = rate_state();
    let stripe_idx = (key as usize) & RATE_STRIPE_MASK;
    let stripe = &state.stripes[stripe_idx];
    let window = window_ms.max(1);

    let ws = stripe.window_start.load(Ordering::Acquire);
    let elapsed = now_ms.saturating_sub(ws);

    if elapsed >= window {
        if elapsed >= window * 2 {
            stripe.prev.store(0, Ordering::Relaxed);
            stripe.curr.store(0, Ordering::Relaxed);
        } else {
            let old_curr = stripe.curr.swap(0, Ordering::Relaxed);
            stripe.prev.store(old_curr, Ordering::Relaxed);
        }
        let new_ws = if elapsed >= window * 2 { now_ms } else { ws.saturating_add(window) };
        let _ = stripe.window_start.compare_exchange(ws, new_ws, Ordering::AcqRel, Ordering::Relaxed);
    }

    let ws = stripe.window_start.load(Ordering::Relaxed);
    let elapsed = now_ms.saturating_sub(ws);
    let overlap = window.saturating_sub(elapsed.min(window));
    let prev = stripe.prev.load(Ordering::Relaxed) as u64;
    let curr = stripe.curr.load(Ordering::Relaxed) as u64;
    let weighted = (prev * overlap / window) + curr;
    let reset = ws.saturating_add(window);

    if weighted < limit as u64 {
        stripe.curr.fetch_add(1, Ordering::Relaxed);
        let remaining = (limit as u64).saturating_sub(weighted.saturating_add(1)) as u32;
        (true, remaining, reset)
    } else {
        (false, 0, reset)
    }
}

#[napi]
pub fn rate_fail_open_count() -> u32 {
    RATE_FAIL_OPEN.load(Ordering::Relaxed) as u32
}

// ── Method classification ──

#[derive(Clone, Copy, PartialEq)]
enum MethodKind { Get, Head, Post, Put, Patch, Delete, Options, Other }

#[inline(always)]
fn load_u64_padded(bytes: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let len = bytes.len().min(8);
    buf[..len].copy_from_slice(&bytes[..len]);
    u64::from_le_bytes(buf)
}

const METHOD_GET: u64 = u64::from_le_bytes(*b"GET\0\0\0\0\0");
const METHOD_HEAD: u64 = u64::from_le_bytes(*b"HEAD\0\0\0\0");
const METHOD_POST: u64 = u64::from_le_bytes(*b"POST\0\0\0\0");
const METHOD_PUT: u64 = u64::from_le_bytes(*b"PUT\0\0\0\0\0");
const METHOD_PATCH: u64 = u64::from_le_bytes(*b"PATCH\0\0\0");
const METHOD_DELETE: u64 = u64::from_le_bytes(*b"DELETE\0\0");
const METHOD_OPTIONS: u64 = u64::from_le_bytes(*b"OPTIONS\0");

#[inline(always)]
fn classify_method(method: &str) -> MethodKind {
    let bytes = method.as_bytes();
    let loaded = load_u64_padded(bytes);
    match bytes.len() {
        3 if loaded == METHOD_GET => MethodKind::Get,
        3 if loaded == METHOD_PUT => MethodKind::Put,
        4 if loaded == METHOD_POST => MethodKind::Post,
        4 if loaded == METHOD_HEAD => MethodKind::Head,
        5 if loaded == METHOD_PATCH => MethodKind::Patch,
        6 if loaded == METHOD_DELETE => MethodKind::Delete,
        7 if loaded == METHOD_OPTIONS => MethodKind::Options,
        _ => MethodKind::Other,
    }
}

#[inline(always)]
fn method_kind_from_u8(v: u8) -> MethodKind {
    match v {
        0 => MethodKind::Get,
        1 => MethodKind::Head,
        2 => MethodKind::Post,
        3 => MethodKind::Put,
        4 => MethodKind::Patch,
        5 => MethodKind::Delete,
        6 => MethodKind::Options,
        _ => MethodKind::Other,
    }
}

#[inline(always)]
fn method_may_have_body(kind: MethodKind) -> bool {
    matches!(kind, MethodKind::Post | MethodKind::Put | MethodKind::Patch | MethodKind::Delete)
}

// ── Named fields HeaderRefs (Restored O(1) direct field access) ──

struct HeaderRefs<'a> {
    origin: Option<&'a [u8]>,
    cookie: Option<&'a [u8]>,
    xff: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
    x_forwarded_proto: Option<&'a [u8]>,
    acrm: Option<&'a [u8]>,
    flags: u8,
}

impl<'a> HeaderRefs<'a> {
    #[inline(always)]
    fn empty() -> Self {
        Self {
            origin: None,
            cookie: None,
            xff: None,
            x_real_ip: None,
            x_forwarded_proto: None,
            acrm: None,
            flags: 0,
        }
    }

    #[inline]
    fn parse(packed: &'a [u8], is_options: bool) -> Self {
        let mut h = Self::empty();

        if packed.len() < 2 {
            return h;
        }

        let count = u16::from_le_bytes([packed[0], packed[1]]) as usize;
        let mut pos = 2usize;

        for _ in 0..count {
            if pos + 2 > packed.len() { break; }
            let name_len = u16::from_le_bytes([packed[pos], packed[pos + 1]]) as usize;
            pos += 2;
            if pos + name_len > packed.len() { break; }
            let name = &packed[pos..pos + name_len];
            pos += name_len;

            if pos + 4 > packed.len() { break; }
            let value_len = u32::from_le_bytes([
                packed[pos], packed[pos + 1], packed[pos + 2], packed[pos + 3],
            ]) as usize;
            pos += 4;
            if pos + value_len > packed.len() { break; }
            let value = &packed[pos..pos + value_len];
            pos += value_len;

            if name.is_empty() { continue; }
            let first = name[0] | 0x20;
            if first == b'o' && name.eq_ignore_ascii_case(b"origin") {
                h.flags |= HAS_ORIGIN;
                h.origin = Some(value);
            } else if first == b'c' && name.eq_ignore_ascii_case(b"cookie") {
                h.flags |= HAS_COOKIE;
                h.cookie = Some(value);
            } else if first == b'x' {
                if name.eq_ignore_ascii_case(b"x-forwarded-for") {
                    h.flags |= HAS_XFF;
                    h.xff = Some(value);
                } else if name.eq_ignore_ascii_case(b"x-real-ip") {
                    h.flags |= HAS_X_REAL_IP;
                    h.x_real_ip = Some(value);
                } else if name.eq_ignore_ascii_case(b"x-forwarded-proto") {
                    h.flags |= HAS_XFP;
                    h.x_forwarded_proto = Some(value);
                }
            } else if first == b'a' && is_options && name.eq_ignore_ascii_case(b"access-control-request-method") {
                h.flags |= HAS_ACRM;
                h.acrm = Some(value);
            }
        }

        h
    }

    #[inline(always)]
    fn has_origin(&self) -> bool { (self.flags & HAS_ORIGIN) != 0 }
    #[inline(always)]
    fn has_cookie(&self) -> bool { (self.flags & HAS_COOKIE) != 0 }
    #[inline(always)]
    fn has_xff(&self) -> bool { (self.flags & HAS_XFF) != 0 }
    #[inline(always)]
    fn has_x_real_ip(&self) -> bool { (self.flags & HAS_X_REAL_IP) != 0 }
    #[inline(always)]
    fn has_xfp(&self) -> bool { (self.flags & HAS_XFP) != 0 }
    #[inline(always)]
    fn has_acrm(&self) -> bool { (self.flags & HAS_ACRM) != 0 }
}

// ── CORS engine ──

#[derive(Clone)]
enum CorsMode { Disabled, Wildcard, Allowlist(Vec<Box<[u8]>>) }

#[derive(Clone)]
struct CorsEngine {
    mode: CorsMode,
    credentials: bool,
}

impl CorsEngine {
    fn disabled() -> Self {
        Self { mode: CorsMode::Disabled, credentials: false }
    }

    fn from_options(opts: Option<CorsOptions>) -> Self {
        if let Some(opts) = opts {
            let credentials = opts.allow_credentials.unwrap_or(false);
            if let Some(allow_list) = opts.allow_origin {
                if allow_list.iter().any(|o| o == "*") {
                    Self { mode: CorsMode::Wildcard, credentials }
                } else {
                    let list = allow_list.iter().map(|s| s.as_bytes().to_vec().into_boxed_slice()).collect();
                    Self { mode: CorsMode::Allowlist(list), credentials }
                }
            } else {
                // v4/v5 behavior: missing allow_origin implies Wildcard
                Self { mode: CorsMode::Wildcard, credentials }
            }
        } else {
            Self::disabled()
        }
    }

    #[inline]
    fn evaluate(&self, method: MethodKind, headers: &HeaderRefs) -> CorsEvaluation {
        let origin = match headers.origin {
            Some(o) => o,
            None => return CorsEvaluation { allowed: false, preflight: false },
        };

        let preflight = method == MethodKind::Options && headers.has_acrm();
        let allowed = match &self.mode {
            CorsMode::Disabled => false,
            CorsMode::Wildcard => !self.credentials, // ⭐ Fixed security regression
            CorsMode::Allowlist(list) => {
                let origin_trim = trim_ascii_whitespace(origin);
                list.iter().any(|allowed| &**allowed == origin_trim)
            }
        };

        CorsEvaluation { allowed, preflight }
    }
}

struct CorsEvaluation { allowed: bool, preflight: bool }

// ── NAPI Option Structs ──

#[napi(object)]
pub struct CorsOptions {
    pub allow_origin: Option<Vec<String>>,
    pub allow_methods: Option<Vec<String>>,
    pub allow_headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub allow_credentials: Option<bool>,
    pub max_age: Option<u32>,
}

#[napi(object)]
pub struct RateLimitOptions {
    pub limit: Option<u32>,
    pub window_ms: Option<u32>,
}

#[napi(object)]
pub struct SecurityHeadersOptions {
    pub content_security_policy: Option<String>,
    pub hsts: Option<bool>,
    pub hsts_max_age: Option<u32>,
    pub hsts_include_subdomains: Option<bool>,
    pub hsts_preload: Option<bool>,
    pub frame_options: Option<String>,
    pub nosniff: Option<bool>,
    pub referrer_policy: Option<String>,
    pub coep: Option<String>,
    pub coop: Option<String>,
    pub corp: Option<String>,
    pub xss_protection: Option<String>,
}

#[napi(object)]
pub struct IngressOptions {
    pub trust_proxy: Option<bool>,
    pub parse_cookies: Option<bool>,
    pub parse_query: Option<bool>,
    pub require_json_body: Option<bool>,
    pub schema: Option<Uint8Array>,
    pub cors: Option<CorsOptions>,
    pub rate_limit: Option<RateLimitOptions>,
    pub security: Option<SecurityHeadersOptions>,
    pub https: Option<bool>,
    pub max_body_bytes: Option<u32>,
    pub enable_security_headers: Option<bool>,
    pub enable_request_ids: Option<bool>,
    pub enable_cache_key: Option<bool>,
    pub enable_path_query: Option<bool>,
    pub enable_body_size_guard: Option<bool>,
    pub read_body: Option<bool>,
}

// ── Ingress inner state ──

#[derive(Clone)]
struct IngressInner {
    https_fixed: Option<bool>,
    max_body_bytes: usize,
    trust_proxy: bool,
    parse_cookies: bool,
    parse_query: bool,
    guard_enabled: bool,
    cors_enabled: bool,
    cors: CorsEngine,
    rate_enabled: bool,
    rate: RateLimitPolicy,
    schema: Option<Arc<jsonschema::Validator>>,
}

#[napi]
pub struct Ingress {
    inner: Arc<IngressInner>,
}

#[napi]
impl Ingress {
    #[napi(constructor)]
    pub fn new(options: IngressOptions) -> Result<Self> {
        let trust_proxy = options.trust_proxy.unwrap_or(false);
        let parse_cookies = options.parse_cookies.unwrap_or(false);
        let parse_query = options.parse_query.unwrap_or(false);
        let max_body_bytes = options.max_body_bytes.unwrap_or(u32::MAX) as usize;
        let enable_body_size_guard = options.enable_body_size_guard.unwrap_or(false);

        let schema = if let Some(schema_bytes) = options.schema {
            let schema_str = std::str::from_utf8(&schema_bytes)
                .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in schema"))?;
            let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;
            let compiled = jsonschema::validator_for(&schema_value).map_err(|e| {
                Error::new(Status::InvalidArg, format!("Schema compile error: {}", e))
            })?;
            Some(Arc::new(compiled))
        } else {
            None
        };

        let cors_enabled = options.cors.is_some();
        let cors = CorsEngine::from_options(options.cors);

        let rate_enabled = options.rate_limit.is_some();
        let rate = if let Some(rl_opts) = options.rate_limit {
            let limit = rl_opts.limit.unwrap_or(0);
            let window_ms = rl_opts.window_ms.unwrap_or(1000);
            RateLimitPolicy::new(limit, window_ms)
        } else {
            RateLimitPolicy::default()
        };

        let inner = IngressInner {
            https_fixed: options.https,
            max_body_bytes,
            trust_proxy,
            parse_cookies,
            parse_query,
            guard_enabled: enable_body_size_guard,
            cors_enabled,
            cors,
            rate_enabled,
            rate,
            schema,
        };

        Ok(Self { inner: Arc::new(inner) })
    }

    // ── v5 hot path preserved as fallback ──
    #[napi(ts_args_type = "method: string, url: string, ip: string, request_id: string, headers: Uint8Array, body: Uint8Array | null, output: Uint8Array")]
    pub fn handle_request(
        &self, _env: Env, method: String, url: String, ip: String,
        request_id: String, headers_packed: Uint8Array, body: Option<Uint8Array>,
        mut output: Uint8Array,
    ) -> Result<u32> {
        let inner = &self.inner;
        let out: &mut [u8] = unsafe { output.as_mut() };
        if out.len() < OUT_DATA_START {
            return Err(Error::new(Status::InvalidArg, "output buffer too small"));
        }

        let method_kind = classify_method(&method);
        let is_options = method_kind == MethodKind::Options;
        let headers = HeaderRefs::parse(headers_packed.as_ref(), is_options);

        let mut flags: u32 = 0;
        let rate_active = inner.rate_enabled && !inner.rate.disabled;

        if detect_https(inner, &url, &headers) {
            flags |= FLAG_HTTPS;
        }
        if inner.trust_proxy {
            flags |= FLAG_TRUSTED_PROXY;
        }

        if inner.cors_enabled && headers.has_origin() {
            let eval = inner.cors.evaluate(method_kind, &headers);
            if eval.preflight { flags |= FLAG_IS_PREFLIGHT; }
            if eval.allowed { flags |= FLAG_CORS_ALLOWED; }
            if eval.preflight {
                let hv = compute_header_variant(eval.allowed, true, rate_active, false, !eval.allowed);
                return if eval.allowed {
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    terminal_preflight_forbidden(flags, hv, out)
                };
            }
        }

        let mut rate_limit: u32 = 0;
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;

        if rate_active {
            let policy = &inner.rate;
            rate_limit = policy.limit;
            let resolved_ip = extract_ip(inner, &headers, &ip);
            let now = rate_now_ms();
            let key = fast_hash_seeded(resolved_ip.as_bytes(), policy.key_base);
            let (allowed, remaining, reset_ms) =
                rate_limit_check_lockfree(key, policy.limit, policy.window_ms, now);
            rate_remaining = remaining;
            rate_reset_ms = reset_ms;

            if !allowed {
                flags |= FLAG_RATE_LIMITED;
                let retry_after_ms = reset_ms.saturating_sub(now);
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, true, true, true);
                return terminal_rate_limited(flags, hv, rate_limit, rate_remaining, rate_reset_ms, retry_after_ms, out);
            }
        }

        let body_bytes: &[u8] = body.as_ref().map(|b| b.as_ref()).unwrap_or(&[]);
        if inner.guard_enabled && body_bytes.len() > inner.max_body_bytes {
            let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
            let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
            return terminal_body_too_large(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
        }

        if inner.schema.is_some() {
            let enforce = method_may_have_body(method_kind) || !body_bytes.is_empty();
            if enforce {
                let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                    Ok(d) => d,
                    Err(_) => {
                        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                        return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                    }
                };
                flags |= FLAG_BODY_VALID_JSON;
                let validator = unsafe { inner.schema.as_ref().unwrap_unchecked() };
                if validator.is_valid(&doc) {
                    flags |= FLAG_SCHEMA_VALID;
                } else {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_schema_validation(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                }
            }
        }

        let mut data_pos = OUT_DATA_START;
        let cookies_json_len: u32 = if inner.parse_cookies && headers.has_cookie() {
            if let Some(cookie_val) = headers.cookie {
                match cookie_json_into_slice(cookie_val, &mut out[data_pos..]) {
                    Ok(written) => {
                        if written > 2 { flags |= FLAG_HAS_COOKIES; }
                        written as u32
                    }
                    Err(_) => 0,
                }
            } else { 0 }
        } else { 0 };
        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        let query_json_len: u32 = if inner.parse_query {
            let raw_query = extract_query_from_url(&url);
            if !raw_query.is_empty() && data_pos < out.len() {
                match query_json_into_slice(raw_query.as_bytes(), &mut out[data_pos..]) {
                    Ok(written) => {
                        if written > 2 { flags |= FLAG_HAS_QUERY; }
                        written as u32
                    }
                    Err(_) => 0,
                }
            } else { 0 }
        } else { 0 };
        let query_start = data_pos;
        data_pos += query_json_len as usize;

        let path = extract_path_from_url(&url);
        let body_json_len = write_full_body_json(
            out, data_pos, request_id.as_bytes(), path.as_bytes(),
            cookies_start, cookies_json_len as usize,
            query_start, query_json_len as usize,
        );
        if body_json_len == 0 {
            flags |= FLAG_BODY_TRUNCATED;
        }

        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        Ok(write_output_header(
            out, 0, ERR_CODE_NONE, 200, flags,
            rate_limit, rate_remaining, rate_reset_ms, 0,
            cookies_json_len, query_json_len, hv, body_json_len as u32,
        ))
    }

    // ── v6 hot path with ArrayVec + quanta time ──
    #[napi(ts_args_type = "method_kind: number, url: Uint8Array, ip: Uint8Array, request_id: Uint8Array, headers: Uint8Array, body: Uint8Array | null, output: Uint8Array")]
    pub fn handle_request_v6(
        &self, _env: Env, method_kind: u8, url: Uint8Array, ip: Uint8Array,
        request_id: Uint8Array, headers_packed: Uint8Array, body: Option<Uint8Array>,
        mut output: Uint8Array,
    ) -> Result<u32> {
        let inner = &self.inner;
        let out: &mut [u8] = unsafe { output.as_mut() };
        if out.len() < OUT_DATA_START {
            return Err(Error::new(Status::InvalidArg, "output buffer too small"));
        }

        let url_bytes: &[u8] = url.as_ref();
        let ip_bytes: &[u8] = ip.as_ref();
        let rid_bytes: &[u8] = request_id.as_ref();

        let mk = method_kind_from_u8(method_kind);
        let is_options = mk == MethodKind::Options;
        let headers = HeaderRefs::parse(headers_packed.as_ref(), is_options);

        let mut flags: u32 = 0;
        let rate_active = inner.rate_enabled && !inner.rate.disabled;

        if detect_https_bytes(inner, url_bytes, &headers) {
            flags |= FLAG_HTTPS;
        }
        if inner.trust_proxy { flags |= FLAG_TRUSTED_PROXY; }

        if inner.cors_enabled && headers.has_origin() {
            let eval = inner.cors.evaluate(mk, &headers);
            if eval.preflight { flags |= FLAG_IS_PREFLIGHT; }
            if eval.allowed { flags |= FLAG_CORS_ALLOWED; }
            if eval.preflight {
                let hv = compute_header_variant(eval.allowed, true, rate_active, false, !eval.allowed);
                return if eval.allowed {
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    terminal_preflight_forbidden(flags, hv, out)
                };
            }
        }

        let mut rate_limit: u32 = 0;
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;

        if rate_active {
            let policy = &inner.rate;
            rate_limit = policy.limit;
            let resolved_ip = extract_ip_bytes(inner, &headers, ip_bytes);
            let now = rate_now_ms();
            let key = fast_hash_seeded(resolved_ip, policy.key_base);
            let (allowed, remaining, reset_ms) =
                rate_limit_check_lockfree(key, policy.limit, policy.window_ms, now);
            rate_remaining = remaining;
            rate_reset_ms = reset_ms;

            if !allowed {
                flags |= FLAG_RATE_LIMITED;
                let retry_after_ms = reset_ms.saturating_sub(now);
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, true, true, true);
                return terminal_rate_limited(flags, hv, rate_limit, rate_remaining, rate_reset_ms, retry_after_ms, out);
            }
        }

        let body_bytes: &[u8] = body.as_ref().map(|b| b.as_ref()).unwrap_or(&[]);
        if inner.guard_enabled && body_bytes.len() > inner.max_body_bytes {
            let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
            let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
            return terminal_body_too_large(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
        }

        if inner.schema.is_some() {
            let enforce = method_may_have_body(mk) || !body_bytes.is_empty();
            if enforce {
                let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                    Ok(d) => d,
                    Err(_) => {
                        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                        return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                    }
                };
                flags |= FLAG_BODY_VALID_JSON;
                let validator = unsafe { inner.schema.as_ref().unwrap_unchecked() };
                if validator.is_valid(&doc) {
                    flags |= FLAG_SCHEMA_VALID;
                } else {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_schema_validation(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                }
            }
        }

        let mut data_pos = OUT_DATA_START;
        let cookies_json_len: u32 = if inner.parse_cookies && headers.has_cookie() {
            if let Some(cookie_val) = headers.cookie {
                match cookie_json_into_slice(cookie_val, &mut out[data_pos..]) {
                    Ok(written) => {
                        if written > 2 { flags |= FLAG_HAS_COOKIES; }
                        written as u32
                    }
                    Err(_) => 0,
                }
            } else { 0 }
        } else { 0 };
        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        let query_json_len: u32 = if inner.parse_query {
            let raw_query = extract_query_from_url_bytes(url_bytes);
            if !raw_query.is_empty() && data_pos < out.len() {
                match query_json_into_slice(raw_query, &mut out[data_pos..]) {
                    Ok(written) => {
                        if written > 2 { flags |= FLAG_HAS_QUERY; }
                        written as u32
                    }
                    Err(_) => 0,
                }
            } else { 0 }
        } else { 0 };
        let query_start = data_pos;
        data_pos += query_json_len as usize;

        let path = extract_path_from_url_bytes(url_bytes);
        let body_json_len = write_full_body_json_bytes(
            out, data_pos, rid_bytes, path,
            cookies_start, cookies_json_len as usize,
            query_start, query_json_len as usize,
        );
        if body_json_len == 0 {
            flags |= FLAG_BODY_TRUNCATED;
        }

        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        Ok(write_output_header(
            out, 0, ERR_CODE_NONE, 200, flags,
            rate_limit, rate_remaining, rate_reset_ms, 0,
            cookies_json_len, query_json_len, hv, body_json_len as u32,
        ))
    }
}

// ── terminal helpers ──
#[cold]
fn terminal_preflight_ok(flags: u32, hv: u8, out: &mut [u8]) -> Result<u32> {
    // ⭐ Fixed error code
    Ok(write_output_header(out, 2, ERR_CODE_NONE, 204, flags, 0, 0, 0, 0, 0, 0, hv, 0))
}

#[cold]
fn terminal_preflight_forbidden(flags: u32, hv: u8, out: &mut [u8]) -> Result<u32> {
    Ok(write_output_header(out, 2, ERR_CODE_CORS_PREFLIGHT, 403, flags, 0, 0, 0, 0, 0, 0, hv, 0))
}

#[cold]
fn terminal_rate_limited(flags: u32, hv: u8, rl: u32, rr: u32, reset: u64, retry: u64, out: &mut [u8]) -> Result<u32> {
    Ok(write_output_header(out, 1, ERR_CODE_RATE_LIMITED, 429, flags, rl, rr, reset, retry, 0, 0, hv, 0))
}

#[cold]
fn terminal_body_too_large(flags: u32, hv: u8, rl: u32, rr: u32, reset: u64, out: &mut [u8]) -> Result<u32> {
    Ok(write_output_header(out, 1, ERR_CODE_BODY_TOO_LARGE, 413, flags, rl, rr, reset, 0, 0, 0, hv, 0))
}

#[cold]
fn terminal_invalid_json(flags: u32, hv: u8, rl: u32, rr: u32, reset: u64, out: &mut [u8]) -> Result<u32> {
    Ok(write_output_header(out, 1, ERR_CODE_INVALID_JSON, 400, flags, rl, rr, reset, 0, 0, 0, hv, 0))
}

#[cold]
fn terminal_schema_validation(flags: u32, hv: u8, rl: u32, rr: u32, reset: u64, out: &mut [u8]) -> Result<u32> {
    Ok(write_output_header(out, 1, ERR_CODE_SCHEMA_VALIDATION, 422, flags, rl, rr, reset, 0, 0, 0, hv, 0))
}

#[inline(always)]
fn write_output_header(
    out: &mut [u8], verdict: u8, error_code: u8, status: u16, flags: u32,
    rate_limit: u32, rate_remaining: u32, rate_reset_ms: u64, retry_after_ms: u64,
    cookies_json_len: u32, query_json_len: u32, header_variant: u8, body_json_len: u32,
) -> u32 {
    unsafe {
        out[OUT_VERDICT] = verdict;
        out[OUT_ERROR_CODE] = error_code;
        write_u16_le_unchecked(out, OUT_STATUS, status);
        write_u32_le_unchecked(out, OUT_FLAGS, flags);
        write_u32_le_unchecked(out, OUT_RATE_LIMIT, rate_limit);
        write_u32_le_unchecked(out, OUT_RATE_REMAINING, rate_remaining);
        write_u64_le_unchecked(out, OUT_RATE_RESET, rate_reset_ms);
        write_u64_le_unchecked(out, OUT_RETRY_AFTER, retry_after_ms);
        write_u32_le_unchecked(out, OUT_COOKIES_JSON_LEN, cookies_json_len);
        write_u32_le_unchecked(out, OUT_QUERY_JSON_LEN, query_json_len);
        out[OUT_HEADER_VARIANT] = header_variant;
        out[OUT_HEADER_VARIANT + 1] = 0;
        out[OUT_HEADER_VARIANT + 2] = 0;
        out[OUT_HEADER_VARIANT + 3] = 0;
        write_u32_le_unchecked(out, OUT_BODY_JSON_LEN, body_json_len);
    }
    // ⭐ Fixed regression: must return total length written
    OUT_DATA_START as u32 + cookies_json_len + query_json_len + body_json_len
}

#[inline(always)]
fn compute_header_variant(cors_ok: bool, is_preflight: bool, rate_active: bool, rate_limited: bool, wants_json: bool) -> u8 {
    let mut hv: u8 = 0;
    if wants_json { hv |= HV_JSON; }
    if cors_ok && !is_preflight { hv |= HV_CORS_SIMPLE; }
    if is_preflight { hv |= HV_CORS_PREFLIGHT; }
    if rate_active { hv |= HV_RATE_ACTIVE; }
    if rate_limited { hv |= HV_RATE_LIMITED; }
    hv
}

#[inline]
fn cookie_json_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let packed = crate::cookie_parser::cookie_parse_packed_vec(input);
    packed_pairs_to_json_into_slice(&packed, out)
}

#[inline]
fn query_json_into_slice(input: &[u8], out: &mut [u8]) -> Result<usize> {
    let packed = crate::query_parser::query_parse_packed_vec(input)?;
    packed_pairs_to_json_into_slice(&packed, out)
}

const JSON_HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

#[inline(always)]
fn json_escaped_len(bytes: &[u8]) -> usize {
    if std::str::from_utf8(bytes).is_ok() {
        bytes.iter().fold(0usize, |acc, &b| {
            acc.saturating_add(match b {
                b'"' | b'\\' | b'\n' | b'\r' | b'\t' | b'\x08' | b'\x0c' => 2,
                b if b < 0x20 => 6,
                _ => 1,
            })
        })
    } else {
        bytes.len().saturating_mul(6)
    }
}

#[inline(always)]
fn write_json_escaped(out: &mut [u8], pos: &mut usize, bytes: &[u8]) {
    if std::str::from_utf8(bytes).is_ok() {
        for &b in bytes {
            match b {
                b'"' | b'\\' | b'\n' | b'\r' | b'\t' | b'\x08' | b'\x0c' => {
                    let esc = match b {
                        b'"' => b'"',
                        b'\\' => b'\\',
                        b'\n' => b'n',
                        b'\r' => b'r',
                        b'\t' => b't',
                        b'\x08' => b'b',
                        b'\x0c' => b'f',
                        _ => unreachable!(),
                    };
                    out[*pos] = b'\\';
                    out[*pos + 1] = esc;
                    *pos += 2;
                }
                b if b < 0x20 => {
                    out[*pos] = b'\\';
                    out[*pos + 1] = b'u';
                    out[*pos + 2] = b'0';
                    out[*pos + 3] = b'0';
                    out[*pos + 4] = JSON_HEX_LOWER[(b >> 4) as usize];
                    out[*pos + 5] = JSON_HEX_LOWER[(b & 0x0f) as usize];
                    *pos += 6;
                }
                b => {
                    out[*pos] = b;
                    *pos += 1;
                }
            }
        }
    } else {
        for &b in bytes {
            out[*pos] = b'\\';
            out[*pos + 1] = b'u';
            out[*pos + 2] = b'0';
            out[*pos + 3] = b'0';
            out[*pos + 4] = JSON_HEX_LOWER[(b >> 4) as usize];
            out[*pos + 5] = JSON_HEX_LOWER[(b & 0x0f) as usize];
            *pos += 6;
        }
    }
}

#[inline]
fn packed_pairs_to_json_len(packed: &[u8]) -> Result<usize> {
    if packed.len() < 4 {
        return Ok(2);
    }

    let count = crate::util::read_u32_le(packed, 0)? as usize;
    let mut pos = 4usize;
    let mut len = 1usize; // '{'

    for i in 0..count {
        let key_len = crate::util::read_u32_le(packed, pos)? as usize;
        pos += 4;

        let key_end = pos
            .checked_add(key_len)
            .ok_or_else(|| Error::from_reason("packed pairs: key length overflow"))?;
        if key_end > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated key"));
        }

        let key = &packed[pos..key_end];
        pos = key_end;

        let val_len = crate::util::read_u32_le(packed, pos)? as usize;
        pos += 4;

        let val_end = pos
            .checked_add(val_len)
            .ok_or_else(|| Error::from_reason("packed pairs: value length overflow"))?;
        if val_end > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated value"));
        }

        let val = &packed[pos..val_end];
        pos = val_end;

        let add = (if i == 0 { 0 } else { 1 })
            + json_escaped_len(key)
            + json_escaped_len(val)
            + 5; // "key":"value"

        len = len
            .checked_add(add)
            .ok_or_else(|| Error::from_reason("packed pairs: JSON length overflow"))?;
    }

    len.checked_add(1) // '}'
        .ok_or_else(|| Error::from_reason("packed pairs: JSON length overflow"))
}

#[inline]
fn packed_pairs_to_json_into_slice(packed: &[u8], out: &mut [u8]) -> Result<usize> {
    let needed = packed_pairs_to_json_len(packed)?;
    if out.len() < needed {
        return Err(Error::from_reason(
            "output buffer too small for packed pairs JSON",
        ));
    }

    if packed.len() < 4 {
        out[0..2].copy_from_slice(b"{}");
        return Ok(2);
    }

    let count = crate::util::read_u32_le(packed, 0)? as usize;
    let mut pos = 0usize;

    out[pos] = b'{';
    pos += 1;

    let mut src = 4usize;

    for i in 0..count {
        let key_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        let key = &packed[src..src + key_len];
        src += key_len;

        let val_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        let val = &packed[src..src + val_len];
        src += val_len;

        if i != 0 {
            out[pos] = b',';
            pos += 1;
        }

        out[pos] = b'"';
        pos += 1;

        write_json_escaped(out, &mut pos, key);

        out[pos] = b'"';
        pos += 1;

        out[pos] = b':';
        pos += 1;

        out[pos] = b'"';
        pos += 1;

        write_json_escaped(out, &mut pos, val);

        out[pos] = b'"';
        pos += 1;
    }

    out[pos] = b'}';
    pos += 1;

    Ok(pos)
}

#[inline]
fn extract_path_from_url(url: &str) -> &str {
    let bytes = url.as_bytes();
    let path_start = if let Some(scheme_end) = memchr::memchr(b':', bytes) {
        if scheme_end + 3 < bytes.len()
            && bytes[scheme_end + 1] == b'/'
            && bytes[scheme_end + 2] == b'/'
        {
            scheme_end + 3
        } else { 0 }
    } else { 0 };

    let after_scheme = &bytes[path_start..];
    let end = memchr::memchr3(b'?', b'#', b'/', after_scheme)
        .map(|i| i + path_start)
        .unwrap_or(bytes.len());

    let path_end = if end < path_start { bytes.len() } else { end };
    std::str::from_utf8(&bytes[path_start..path_end]).unwrap_or("/")
}

#[inline]
fn extract_path_from_url_bytes(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") { 8 } else if url.starts_with(b"http://") { 7 } else { 0 };
    let search_space = &url[search_start..];
    
    let path_start = match memchr::memchr(b'/', search_space) {
        Some(i) => search_start + i,
        None => return b"/",
    };
    
    let after_path = &url[path_start..];
    let end = memchr::memchr2(b'?', b'#', after_path).unwrap_or(after_path.len());
    
    &url[path_start..path_start + end]
}

#[inline]
fn extract_query_from_url(url: &str) -> &str {
    let bytes = url.as_bytes();
    let q_pos = if let Some(scheme_end) = memchr::memchr(b':', bytes) {
        if scheme_end + 3 < bytes.len()
            && bytes[scheme_end + 1] == b'/'
            && bytes[scheme_end + 2] == b'/'
        {
            scheme_end + 3
        } else { 0 }
    } else { 0 };

    let after_scheme = &bytes[q_pos..];
    match memchr::memchr2(b'?', b'#', after_scheme) {
        Some(i) if after_scheme[i] == b'?' => {
            let after_q = &after_scheme[i + 1..];
            let frag = memchr::memchr(b'#', after_q).unwrap_or(after_q.len());
            std::str::from_utf8(&after_q[..frag]).unwrap_or("")
        }
        _ => "",
    }
}

#[inline]
fn extract_query_from_url_bytes(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") { 8 } else if url.starts_with(b"http://") { 7 } else { 0 };
    let search_space = &url[search_start..];
    
    if let Some(i) = memchr::memchr2(b'?', b'#', search_space) {
        if search_space[i] == b'?' {
            let after_q = &search_space[i + 1..];
            let frag = memchr::memchr(b'#', after_q).unwrap_or(after_q.len());
            &after_q[..frag]
        } else {
            &[]
        }
    } else {
        &[]
    }
}

#[inline]
fn detect_https(inner: &IngressInner, url: &str, headers: &HeaderRefs<'_>) -> bool {
    detect_https_bytes(inner, url.as_bytes(), headers)
}

#[inline]
fn detect_https_bytes(inner: &IngressInner, url: &[u8], headers: &HeaderRefs<'_>) -> bool {
    if let Some(v) = inner.https_fixed { return v; }
    if url.starts_with(b"https://") || url.starts_with(b"wss://") { return true; }
    if inner.trust_proxy && headers.has_xfp() {
        if let Some(xfp) = headers.x_forwarded_proto {
            return trim_ascii_whitespace(xfp) == b"https";
        }
    }
    false
}

#[inline]
fn extract_ip(inner: &IngressInner, headers: &HeaderRefs<'_>, socket_ip: &str) -> String {
    if !inner.trust_proxy { return socket_ip.to_string(); }
    if let Some(xff) = headers.xff {
        let xff = trim_ascii_whitespace(xff);
        if let Some(idx) = memchr::memchr(b',', xff) {
            return std::str::from_utf8(trim_ascii_whitespace(&xff[..idx])).unwrap_or("").to_string();
        }
        return std::str::from_utf8(xff).unwrap_or("").to_string();
    }
    if let Some(xri) = headers.x_real_ip {
        return std::str::from_utf8(xri).unwrap_or("").to_string();
    }
    socket_ip.to_string()
}

#[inline]
fn extract_ip_bytes<'a>(inner: &IngressInner, headers: &'a HeaderRefs<'a>, socket_ip: &'a [u8]) -> &'a [u8] {
    if !inner.trust_proxy { return socket_ip; }
    if let Some(xff) = headers.xff {
        let xff = trim_ascii_whitespace(xff);
        if let Some(idx) = memchr::memchr(b',', xff) {
            return trim_ascii_whitespace(&xff[..idx]);
        }
        return xff;
    }
    if let Some(xri) = headers.x_real_ip {
        return xri;
    }
    socket_ip
}

#[inline]
fn write_full_body_json(
    out: &mut [u8],
    pos: usize,
    request_id: &[u8],
    path: &[u8],
    cookies_start: usize,
    cookies_len: usize,
    query_start: usize,
    query_len: usize,
) -> usize {
    write_full_body_json_bytes(out, pos, request_id, path, cookies_start, cookies_len, query_start, query_len)
}

#[inline]
fn write_full_body_json_bytes(
    out: &mut [u8],
    pos: usize,
    request_id: &[u8],
    path: &[u8],
    cookies_start: usize,
    cookies_len: usize,
    query_start: usize,
    query_len: usize,
) -> usize {
    const P1: &[u8] = b"{\"ok\":true,\"requestId\":\"";
    const P2: &[u8] = b"\",\"path\":\"";
    const P3: &[u8] = b"\",\"cookies\":";
    const P4: &[u8] = b",\"query\":";

    let cookies_eff_len = if cookies_len > 0 { cookies_len } else { 2 };
    let query_eff_len = if query_len > 0 { query_len } else { 2 };

    let required = P1.len()
        + json_escaped_len(request_id)
        + P2.len()
        + json_escaped_len(path)
        + P3.len()
        + cookies_eff_len
        + P4.len()
        + query_eff_len
        + 1; // final '}'

    let end = match pos.checked_add(required) {
        Some(v) => v,
        None => return 0,
    };

    if end > out.len() {
        return 0;
    }

    let mut wp = pos;

    out[wp..wp + P1.len()].copy_from_slice(P1);
    wp += P1.len();

    write_json_escaped(out, &mut wp, request_id);

    out[wp..wp + P2.len()].copy_from_slice(P2);
    wp += P2.len();

    write_json_escaped(out, &mut wp, path);

    out[wp..wp + P3.len()].copy_from_slice(P3);
    wp += P3.len();

    if cookies_len > 0 {
        unsafe {
            std::ptr::copy(
                out.as_ptr().add(cookies_start),
                out.as_mut_ptr().add(wp),
                cookies_len,
            );
        }
        wp += cookies_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp..wp + P4.len()].copy_from_slice(P4);
    wp += P4.len();

    if query_len > 0 {
        unsafe {
            std::ptr::copy(
                out.as_ptr().add(query_start),
                out.as_mut_ptr().add(wp),
                query_len,
            );
        }
        wp += query_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp] = b'}';
    wp += 1;

    wp - pos
}