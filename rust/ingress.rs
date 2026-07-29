#![allow(clippy::too_many_arguments)]

use napi::bindgen_prelude::*;
use napi::Status;
use napi_derive::napi;

use std::ptr;
use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::ip_trust::{resolve_client_ip, ProxyTrustMode};
use crate::rate_limit::KeyedRateLimiter;
use crate::util::trim_ascii_whitespace;

// ── Output buffer binary layout ───────────────────────────────────
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

// ── Flags ─────────────────────────────────────────────────────────
const FLAG_HAS_COOKIES: u32 = 1 << 0;
const FLAG_HAS_QUERY: u32 = 1 << 1;
const FLAG_BODY_VALID_JSON: u32 = 1 << 2;
const FLAG_SCHEMA_VALID: u32 = 1 << 3;
const FLAG_CORS_ALLOWED: u32 = 1 << 4;
const FLAG_IS_PREFLIGHT: u32 = 1 << 5;
const FLAG_RATE_LIMITED: u32 = 1 << 6;
const FLAG_HTTPS: u32 = 1 << 7;
const FLAG_TRUSTED_PROXY: u32 = 1 << 8;
const FLAG_BODY_TRUNCATED: u32 = 1 << 9;

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
const ERR_CODE_BAD_REQUEST: u8 = 6;
const ERR_CODE_REQUEST_TOO_LARGE: u8 = 7;

const HAS_ORIGIN: u8 = 1 << 0;
const HAS_COOKIE: u8 = 1 << 1;
const HAS_XFF: u8 = 1 << 2;
const HAS_X_REAL_IP: u8 = 1 << 3;
const HAS_XFP: u8 = 1 << 4;
const HAS_ACRM: u8 = 1 << 5;
const HAS_ACRH: u8 = 1 << 6;

// ── Unsafe output helpers ─────────────────────────────────────────
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

// ── Time helpers ──────────────────────────────────────────────────
static START: OnceLock<Instant> = OnceLock::new();
static WALL_OFFSET_MS: OnceLock<i128> = OnceLock::new();

#[inline(always)]
fn monotonic_ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
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
    if v < 0 {
        0
    } else {
        v as u64
    }
}

// ── Method classification ─────────────────────────────────────────
#[derive(Clone, Copy, PartialEq)]
enum MethodKind {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Other,
}

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
    matches!(
        kind,
        MethodKind::Post | MethodKind::Put | MethodKind::Patch | MethodKind::Delete
    )
}

// ── Header refs ───────────────────────────────────────────────────
struct HeaderRefs<'a> {
    origin: Option<&'a [u8]>,
    cookie: Option<&'a [u8]>,
    xff: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
    x_forwarded_proto: Option<&'a [u8]>,
    acrm: Option<&'a [u8]>,
    acrh: Option<&'a [u8]>,
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
            acrh: None,
            flags: 0,
        }
    }

    #[inline]
    fn parse(packed: &'a [u8], is_options: bool, max_headers: usize) -> Result<Self> {
        let mut h = Self::empty();

        if packed.len() < 2 {
            return Ok(h);
        }

        let count = u16::from_le_bytes([packed[0], packed[1]]) as usize;
        if count > max_headers {
            return Err(Error::from_reason("too many headers"));
        }

        let mut pos = 2usize;

        for _ in 0..count {
            if pos + 2 > packed.len() {
                return Err(Error::from_reason("malformed packed headers"));
            }

            let name_len = u16::from_le_bytes([packed[pos], packed[pos + 1]]) as usize;
            pos += 2;

            if pos + name_len > packed.len() {
                return Err(Error::from_reason("malformed packed header name"));
            }

            let name = &packed[pos..pos + name_len];
            pos += name_len;

            if pos + 4 > packed.len() {
                return Err(Error::from_reason("malformed packed header value length"));
            }

            let value_len = u32::from_le_bytes([
                packed[pos],
                packed[pos + 1],
                packed[pos + 2],
                packed[pos + 3],
            ]) as usize;
            pos += 4;

            if pos + value_len > packed.len() {
                return Err(Error::from_reason("malformed packed header value"));
            }

            let value = &packed[pos..pos + value_len];
            pos += value_len;

            if name.is_empty() {
                continue;
            }

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
            } else if first == b'a' && is_options {
                if name.eq_ignore_ascii_case(b"access-control-request-method") {
                    h.flags |= HAS_ACRM;
                    h.acrm = Some(value);
                } else if name.eq_ignore_ascii_case(b"access-control-request-headers") {
                    h.flags |= HAS_ACRH;
                    h.acrh = Some(value);
                }
            }
        }

        Ok(h)
    }

    #[inline(always)]
    fn has_origin(&self) -> bool {
        (self.flags & HAS_ORIGIN) != 0
    }

    #[inline(always)]
    fn has_cookie(&self) -> bool {
        (self.flags & HAS_COOKIE) != 0
    }

    #[inline(always)]
    fn has_xfp(&self) -> bool {
        (self.flags & HAS_XFP) != 0
    }

    #[inline(always)]
    fn has_acrm(&self) -> bool {
        (self.flags & HAS_ACRM) != 0
    }
}

// ── CORS engine ───────────────────────────────────────────────────
#[derive(Clone)]
enum CorsMode {
    Disabled,
    Wildcard,
    Allowlist(Vec<Box<[u8]>>),
}

#[derive(Clone)]
struct CorsEngine {
    mode: CorsMode,
    credentials: bool,
    methods_wildcard: bool,
    methods: Vec<MethodKind>,
    headers_wildcard: bool,
    headers: Vec<Box<[u8]>>,
}

impl CorsEngine {
    fn disabled() -> Self {
        Self {
            mode: CorsMode::Disabled,
            credentials: false,
            methods_wildcard: false,
            methods: Vec::new(),
            headers_wildcard: false,
            headers: Vec::new(),
        }
    }

    fn from_options(opts: Option<CorsOptions>) -> Result<Self> {
        let Some(opts) = opts else {
            return Ok(Self::disabled());
        };

        let credentials = opts.allow_credentials.unwrap_or(false);

        let mode = match opts.allow_origin {
            Some(list) if !list.is_empty() => {
                if list.iter().any(|o| o == "*") {
                    if credentials {
                        return Err(Error::new(
                            Status::InvalidArg,
                            "CORS allowCredentials cannot be used with allowOrigin ['*']",
                        ));
                    }
                    CorsMode::Wildcard
                } else {
                    CorsMode::Allowlist(
                        list.iter()
                            .map(|s| s.as_bytes().to_vec().into_boxed_slice())
                            .collect(),
                    )
                }
            }
            _ => {
                if credentials {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "CORS allowCredentials requires an explicit allowOrigin list",
                    ));
                }
                CorsMode::Wildcard
            }
        };

        let (methods_wildcard, methods) = parse_allowed_methods(opts.allow_methods);
        let (headers_wildcard, headers) = parse_allowed_headers(opts.allow_headers);

        Ok(Self {
            mode,
            credentials,
            methods_wildcard,
            methods,
            headers_wildcard,
            headers,
        })
    }

    #[inline]
    fn evaluate(&self, method: MethodKind, headers: &HeaderRefs) -> CorsEvaluation {
        let origin = match headers.origin {
            Some(o) => o,
            None => {
                return CorsEvaluation {
                    allowed: false,
                    preflight: false,
                }
            }
        };

        let preflight = method == MethodKind::Options && headers.has_acrm();

        let mut allowed = match &self.mode {
            CorsMode::Disabled => false,
            CorsMode::Wildcard => !self.credentials,
            CorsMode::Allowlist(list) => {
                let origin_trim = trim_ascii_whitespace(origin);
                list.iter().any(|allowed| &**allowed == origin_trim)
            }
        };

        if allowed {
            if preflight {
                allowed =
                    self.preflight_method_allowed(headers.acrm) && self.headers_allowed(headers.acrh);
            } else {
                allowed = self.method_allowed_kind(method);
            }
        }

        CorsEvaluation { allowed, preflight }
    }

    fn method_allowed_kind(&self, kind: MethodKind) -> bool {
        if self.methods_wildcard {
            return true;
        }

        if self.methods.is_empty() {
            return matches!(
                kind,
                MethodKind::Get | MethodKind::Head | MethodKind::Post
            );
        }

        self.methods.contains(&kind)
    }

    fn preflight_method_allowed(&self, acrm: Option<&[u8]>) -> bool {
        let Some(acrm) = acrm else {
            return false;
        };

        let trimmed = trim_ascii_whitespace(acrm);
        if trimmed.is_empty() {
            return false;
        }

        let upper = trimmed.to_ascii_uppercase();
        let kind = classify_method(std::str::from_utf8(upper.as_slice()).unwrap_or(""));
        self.method_allowed_kind(kind)
    }

    fn headers_allowed(&self, acrh: Option<&[u8]>) -> bool {
        let Some(acrh) = acrh else {
            return true;
        };

        if self.headers_wildcard {
            return true;
        }

        for requested in acrh.split(|&b| b == b',') {
            let name = trim_ascii_whitespace(requested);
            if name.is_empty() {
                continue;
            }

            let lower = name.to_ascii_lowercase();

            if self.headers.is_empty() {
                if !is_cors_safelisted_request_header(lower.as_slice()) {
                    return false;
                }
            } else if !self
                .headers
                .iter()
                .any(|allowed| allowed.as_ref() == lower.as_slice())
            {
                return false;
            }
        }

        true
    }
}

struct CorsEvaluation {
    allowed: bool,
    preflight: bool,
}

fn parse_allowed_methods(list: Option<Vec<String>>) -> (bool, Vec<MethodKind>) {
    let Some(list) = list else {
        return (false, Vec::new());
    };

    let mut methods = Vec::new();

    for raw in list {
        let trimmed = raw.trim();

        if trimmed == "*" {
            return (true, Vec::new());
        }

        if trimmed.is_empty() {
            continue;
        }

        let upper = trimmed.to_ascii_uppercase();
        let kind = classify_method(&upper);

        if kind != MethodKind::Other {
            methods.push(kind);
        }
    }

    (false, methods)
}

fn parse_allowed_headers(list: Option<Vec<String>>) -> (bool, Vec<Box<[u8]>>) {
    let Some(list) = list else {
        return (false, Vec::new());
    };

    let mut headers = Vec::new();

    for raw in list {
        let trimmed = raw.trim();

        if trimmed == "*" {
            return (true, Vec::new());
        }

        if trimmed.is_empty() {
            continue;
        }

        headers.push(trimmed.to_ascii_lowercase().into_bytes().into_boxed_slice());
    }

    (false, headers)
}

fn is_cors_safelisted_request_header(name: &[u8]) -> bool {
    matches!(
        name,
        b"accept" | b"accept-language" | b"content-language" | b"content-type"
    )
}

// ── NAPI option structs ───────────────────────────────────────────
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
    pub max_entries: Option<u32>,
}

#[napi(object)]
pub struct TrustedProxyOptions {
    pub enabled: Option<bool>,
    pub networks: Option<Vec<String>>,
}

#[napi(object)]
pub struct IngressLimitsOptions {
    pub max_url_bytes: Option<u32>,
    pub max_query_bytes: Option<u32>,
    pub max_cookie_bytes: Option<u32>,
    pub max_headers_bytes: Option<u32>,
    pub max_headers: Option<u32>,
    pub max_pairs: Option<u32>,
}

#[napi(object)]
pub struct IngressOptions {
    pub trust_proxy: Option<bool>,
    pub trusted_proxies: Option<TrustedProxyOptions>,
    pub parse_cookies: Option<bool>,
    pub parse_query: Option<bool>,
    pub require_json_body: Option<bool>,
    pub schema: Option<Uint8Array>,
    pub cors: Option<CorsOptions>,
    pub rate_limit: Option<RateLimitOptions>,
    pub https: Option<bool>,
    pub max_body_bytes: Option<u32>,
    pub enable_body_size_guard: Option<bool>,
    pub emit_metadata_json: Option<bool>,
    pub limits: Option<IngressLimitsOptions>,
}

// ── Limits ────────────────────────────────────────────────────────
#[derive(Clone)]
struct Limits {
    max_url_bytes: usize,
    max_query_bytes: usize,
    max_cookie_bytes: usize,
    max_headers_bytes: usize,
    max_headers: usize,
    max_pairs: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_url_bytes: 65536,
            max_query_bytes: 16384,
            max_cookie_bytes: 8192,
            max_headers_bytes: 65536,
            max_headers: 100,
            max_pairs: 1024,
        }
    }
}

impl Limits {
    fn from_options(opts: Option<IngressLimitsOptions>) -> Self {
        let d = Self::default();

        let Some(o) = opts else {
            return d;
        };

        Self {
            max_url_bytes: o.max_url_bytes.map(|v| v as usize).unwrap_or(d.max_url_bytes),
            max_query_bytes: o
                .max_query_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_query_bytes),
            max_cookie_bytes: o
                .max_cookie_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_cookie_bytes),
            max_headers_bytes: o
                .max_headers_bytes
                .map(|v| v as usize)
                .unwrap_or(d.max_headers_bytes),
            max_headers: o.max_headers.map(|v| v as usize).unwrap_or(d.max_headers),
            max_pairs: o.max_pairs.map(|v| v as usize).unwrap_or(d.max_pairs),
        }
    }
}

// ── Ingress state ─────────────────────────────────────────────────
#[derive(Clone)]
struct IngressInner {
    https_fixed: Option<bool>,
    max_body_bytes: usize,
    proxy_trust: ProxyTrustMode,
    parse_cookies: bool,
    parse_query: bool,
    require_json_body: bool,
    guard_enabled: bool,
    emit_metadata_json: bool,
    cors_enabled: bool,
    cors: CorsEngine,
    rate_enabled: bool,
    rate_limiter: Option<Arc<KeyedRateLimiter>>,
    schema: Option<Arc<jsonschema::Validator>>,
    limits: Limits,
}

#[napi]
pub struct Ingress {
    inner: Arc<IngressInner>,
}

#[napi]
impl Ingress {
    #[napi(constructor)]
    pub fn new(options: IngressOptions) -> Result<Self> {
        let parse_cookies = options.parse_cookies.unwrap_or(false);
        let parse_query = options.parse_query.unwrap_or(false);
        let require_json_body = options.require_json_body.unwrap_or(false);
        let max_body_bytes = options.max_body_bytes.unwrap_or(1_048_576) as usize;
        let guard_enabled = options.enable_body_size_guard.unwrap_or(true);
        let emit_metadata_json = options.emit_metadata_json.unwrap_or(false);

        let proxy_trust = if let Some(tp) = options.trusted_proxies {
            ProxyTrustMode::from_config(tp.enabled.unwrap_or(false), tp.networks)?
        } else if options.trust_proxy.unwrap_or(false) {
            ProxyTrustMode::All
        } else {
            ProxyTrustMode::None
        };

        let schema = if let Some(schema_bytes) = options.schema {
            let schema_str = std::str::from_utf8(&schema_bytes)
                .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in schema"))?;

            let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;

            let compiled = jsonschema::validator_for(&schema_value)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema compile error: {}", e)))?;

            Some(Arc::new(compiled))
        } else {
            None
        };

        let cors_enabled = options.cors.is_some();
        let cors = CorsEngine::from_options(options.cors)?;

        let (rate_enabled, rate_limiter) = if let Some(rl_opts) = options.rate_limit {
            let limit = rl_opts.limit.unwrap_or(0);
            let window_ms = rl_opts.window_ms.unwrap_or(1000);

            if limit == 0 || limit == u32::MAX {
                (false, None)
            } else {
                let max_entries = rl_opts.max_entries.map(|v| v as usize);
                let limiter = KeyedRateLimiter::new(limit, window_ms, max_entries);
                (true, Some(Arc::new(limiter)))
            }
        } else {
            (false, None)
        };

        let limits = Limits::from_options(options.limits);

        let inner = IngressInner {
            https_fixed: options.https,
            max_body_bytes,
            proxy_trust,
            parse_cookies,
            parse_query,
            require_json_body,
            guard_enabled,
            emit_metadata_json,
            cors_enabled,
            cors,
            rate_enabled,
            rate_limiter,
            schema,
            limits,
        };

        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Production API:
    ///   input = packed metadata frame
    ///   body = separate zero-copy body
    ///   output = response decision buffer
    #[napi(ts_args_type = "input: Uint8Array, body: Uint8Array | null, output: Uint8Array")]
    pub fn handle_request_packed(
        &self,
        input: Uint8Array,
        body: Option<Uint8Array>,
        mut output: Uint8Array,
    ) -> Result<u32> {
        let inner: &IngressInner = self.inner.as_ref();

        crate::util::run_packed_into(&input, &mut output, move |inp, out| {
            match body {
                Some(b) => {
                    let b_bytes = b.as_ref();

                    if crate::util::slices_overlap(b_bytes, out) {
                        let owned = b_bytes.to_vec();
                        inner.handle_packed(inp, &owned, out)
                    } else {
                        inner.handle_packed(inp, b_bytes, out)
                    }
                }
                None => inner.handle_packed(inp, &[], out),
            }
        })
    }




}

impl IngressInner {
    fn handle_packed(&self, input: &[u8], body_bytes: &[u8], out: &mut [u8]) -> Result<usize> {
        if out.len() < OUT_DATA_START {
            return Err(Error::new(Status::InvalidArg, "output buffer too small"));
        }

        if input.is_empty() {
            return Err(Error::new(Status::InvalidArg, "input buffer too small"));
        }

        let mut pos = 1usize;
        let mk = method_kind_from_u8(input[0]);
        let is_options = mk == MethodKind::Options;

        let url_bytes = match read_section(input, &mut pos, self.limits.max_url_bytes) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, ERR_CODE_BAD_REQUEST, 414),
        };

        let ip_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, ERR_CODE_BAD_REQUEST, 400),
        };

        let rid_bytes = match read_section(input, &mut pos, 128) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, ERR_CODE_BAD_REQUEST, 400),
        };

        let headers_packed = match read_section(input, &mut pos, self.limits.max_headers_bytes) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, ERR_CODE_REQUEST_TOO_LARGE, 431),
        };

        let headers = match HeaderRefs::parse(headers_packed, is_options, self.limits.max_headers) {
            Ok(v) => v,
            Err(_) => return terminal_simple(out, 1, ERR_CODE_REQUEST_TOO_LARGE, 431),
        };

        let mut flags: u32 = 0;
        let rate_active = self.rate_enabled && self.rate_limiter.is_some();

        let (resolved_ip, peer_trusted) =
            resolve_client_ip(&self.proxy_trust, ip_bytes, headers.xff, headers.x_real_ip);

        if peer_trusted {
            flags |= FLAG_TRUSTED_PROXY;
        }

        if detect_https_bytes(self, url_bytes, &headers, peer_trusted) {
            flags |= FLAG_HTTPS;
        }

        if self.cors_enabled && headers.has_origin() {
            let eval = self.cors.evaluate(mk, &headers);

            if eval.preflight {
                flags |= FLAG_IS_PREFLIGHT;
            }

            if eval.allowed {
                flags |= FLAG_CORS_ALLOWED;
            }

            if eval.preflight {
                return if eval.allowed {
                    let hv = compute_header_variant(true, true, rate_active, false, false);
                    terminal_preflight_ok(flags, hv, out)
                } else {
                    let hv = compute_header_variant(false, false, rate_active, false, true);
                    terminal_preflight_forbidden(flags, hv, out)
                };
            }
        }

        let mut rate_limit: u32 = 0;
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;

        if rate_active {
            let limiter = self.rate_limiter.as_ref().unwrap();
            let now = rate_now_ms();
            let key = resolved_ip.rate_key(limiter.seed());
            let outcome = limiter.check_key(key, now);

            rate_limit = limiter.limit();
            rate_remaining = outcome.remaining;
            rate_reset_ms = outcome.reset_ms;

            if !outcome.allowed {
                flags |= FLAG_RATE_LIMITED;

                let retry_after_ms = outcome.reset_ms.saturating_sub(now);
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, true, true, true);

                return terminal_rate_limited(
                    flags,
                    hv,
                    rate_limit,
                    rate_remaining,
                    rate_reset_ms,
                    retry_after_ms,
                    out,
                );
            }
        }

        if self.guard_enabled && body_bytes.len() > self.max_body_bytes {
            let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
            let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
            return terminal_body_too_large(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
        }

        let has_body = !body_bytes.is_empty();

        let enforce_json = if self.schema.is_some() {
            method_may_have_body(mk) || has_body
        } else {
            self.require_json_body && (method_may_have_body(mk) || has_body)
        };

        if enforce_json {
            if body_bytes.is_empty() {
                let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
            }

            let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                Ok(d) => d,
                Err(_) => {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_invalid_json(flags, hv, rate_limit, rate_remaining, rate_reset_ms, out);
                }
            };

            flags |= FLAG_BODY_VALID_JSON;

            if let Some(validator) = self.schema.as_ref() {
                if validator.is_valid(&doc) {
                    flags |= FLAG_SCHEMA_VALID;
                } else {
                    let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
                    let hv = compute_header_variant(cors_ok, false, rate_active, false, true);
                    return terminal_schema_validation(
                        flags,
                        hv,
                        rate_limit,
                        rate_remaining,
                        rate_reset_ms,
                        out,
                    );
                }
            }
        }

        let mut data_pos = OUT_DATA_START;

        let cookies_json_len: u32 = if self.parse_cookies && headers.has_cookie() {
            if let Some(cookie_val) = headers.cookie {
                if cookie_val.len() <= self.limits.max_cookie_bytes {
                    match cookie_json_into_slice_limited(
                        cookie_val,
                        &mut out[data_pos..],
                        self.limits.max_pairs,
                    ) {
                        Ok(written) => {
                            if written > 2 {
                                flags |= FLAG_HAS_COOKIES;
                            }
                            written as u32
                        }
                        Err(_) => 0,
                    }
                } else {
                    0
                }
            } else {
                0
            }
        } else {
            0
        };

        let cookies_start = data_pos;
        data_pos += cookies_json_len as usize;

        let query_json_len: u32 = if self.parse_query {
            let raw_query = extract_query_from_url_bytes(url_bytes);

            if raw_query.len() > self.limits.max_query_bytes {
                return terminal_simple(out, 1, ERR_CODE_BAD_REQUEST, 414);
            }

            if !raw_query.is_empty() && data_pos < out.len() {
                match crate::query_parser::query_parse_packed_vec(raw_query) {
                    Ok(packed) => {
                        match packed_pairs_to_json_into_slice_limited(
                            &packed,
                            &mut out[data_pos..],
                            self.limits.max_pairs,
                        ) {
                            Ok(written) => {
                                if written > 2 {
                                    flags |= FLAG_HAS_QUERY;
                                }
                                written as u32
                            }
                            Err(_) => 0,
                        }
                    }
                    Err(_) => return terminal_simple(out, 1, ERR_CODE_BAD_REQUEST, 400),
                }
            } else {
                0
            }
        } else {
            0
        };

        let query_start = data_pos;
        data_pos += query_json_len as usize;

        let body_json_len = if self.emit_metadata_json {
            let path = extract_path_from_url_bytes(url_bytes);

            write_full_body_json_bytes(
                out,
                data_pos,
                rid_bytes,
                path,
                cookies_start,
                cookies_json_len as usize,
                query_start,
                query_json_len as usize,
            )
        } else {
            0
        };

        if self.emit_metadata_json && body_json_len == 0 {
            flags |= FLAG_BODY_TRUNCATED;
        }

        let cors_ok = (flags & FLAG_CORS_ALLOWED) != 0;
        let hv = compute_header_variant(cors_ok, false, rate_active, false, true);

        Ok(write_output_header(
            out,
            0,
            ERR_CODE_NONE,
            200,
            flags,
            rate_limit,
            rate_remaining,
            rate_reset_ms,
            0,
            cookies_json_len,
            query_json_len,
            hv,
            body_json_len as u32,
        ))
    }
}

// ── Packed input helpers ──────────────────────────────────────────
#[inline]
fn read_u32_at(input: &[u8], pos: &mut usize) -> Result<usize> {
    if *pos + 4 > input.len() {
        return Err(Error::from_reason("packed input: truncated u32"));
    }

    let v = u32::from_le_bytes([
        input[*pos],
        input[*pos + 1],
        input[*pos + 2],
        input[*pos + 3],
    ]) as usize;

    *pos += 4;
    Ok(v)
}

#[inline]
fn read_section<'a>(input: &'a [u8], pos: &mut usize, max: usize) -> Result<&'a [u8]> {
    let len = read_u32_at(input, pos)?;

    if len > max {
        return Err(Error::from_reason("packed input: section too large"));
    }

    let end = pos
        .checked_add(len)
        .ok_or_else(|| Error::from_reason("packed input: length overflow"))?;

    if end > input.len() {
        return Err(Error::from_reason("packed input: truncated section"));
    }

    let slice = &input[*pos..end];
    *pos = end;
    Ok(slice)
}

// ── Terminal helpers ──────────────────────────────────────────────
#[cold]
fn terminal_simple(out: &mut [u8], verdict: u8, error_code: u8, status: u16) -> Result<usize> {
    Ok(write_output_header(
        out,
        verdict,
        error_code,
        status,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        HV_JSON,
        0,
    ))
}

#[cold]
fn terminal_preflight_ok(flags: u32, hv: u8, out: &mut [u8]) -> Result<usize> {
    Ok(write_output_header(
        out, 2, ERR_CODE_NONE, 204, flags, 0, 0, 0, 0, 0, 0, hv, 0,
    ))
}

#[cold]
fn terminal_preflight_forbidden(flags: u32, hv: u8, out: &mut [u8]) -> Result<usize> {
    Ok(write_output_header(
        out,
        2,
        ERR_CODE_CORS_PREFLIGHT,
        403,
        flags,
        0,
        0,
        0,
        0,
        0,
        0,
        hv,
        0,
    ))
}

#[cold]
fn terminal_rate_limited(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    retry: u64,
    out: &mut [u8],
) -> Result<usize> {
    Ok(write_output_header(
        out,
        1,
        ERR_CODE_RATE_LIMITED,
        429,
        flags,
        rl,
        rr,
        reset,
        retry,
        0,
        0,
        hv,
        0,
    ))
}

#[cold]
fn terminal_body_too_large(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> Result<usize> {
    Ok(write_output_header(
        out,
        1,
        ERR_CODE_BODY_TOO_LARGE,
        413,
        flags,
        rl,
        rr,
        reset,
        0,
        0,
        0,
        hv,
        0,
    ))
}

#[cold]
fn terminal_invalid_json(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> Result<usize> {
    Ok(write_output_header(
        out,
        1,
        ERR_CODE_INVALID_JSON,
        400,
        flags,
        rl,
        rr,
        reset,
        0,
        0,
        0,
        hv,
        0,
    ))
}

#[cold]
fn terminal_schema_validation(
    flags: u32,
    hv: u8,
    rl: u32,
    rr: u32,
    reset: u64,
    out: &mut [u8],
) -> Result<usize> {
    Ok(write_output_header(
        out,
        1,
        ERR_CODE_SCHEMA_VALIDATION,
        422,
        flags,
        rl,
        rr,
        reset,
        0,
        0,
        0,
        hv,
        0,
    ))
}

#[inline(always)]
fn write_output_header(
    out: &mut [u8],
    verdict: u8,
    error_code: u8,
    status: u16,
    flags: u32,
    rate_limit: u32,
    rate_remaining: u32,
    rate_reset_ms: u64,
    retry_after_ms: u64,
    cookies_json_len: u32,
    query_json_len: u32,
    header_variant: u8,
    body_json_len: u32,
) -> usize {
    let status = if status == 101 || (200u16..=599u16).contains(&status) {
        status
    } else {
        500
    };

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

    OUT_DATA_START
        + cookies_json_len as usize
        + query_json_len as usize
        + body_json_len as usize
}
#[inline(always)]
fn compute_header_variant(
    cors_ok: bool,
    is_preflight: bool,
    rate_active: bool,
    rate_limited: bool,
    wants_json: bool,
) -> u8 {
    let mut hv: u8 = 0;

    if wants_json {
        hv |= HV_JSON;
    }

    if cors_ok && !is_preflight {
        hv |= HV_CORS_SIMPLE;
    }

    if is_preflight {
        hv |= HV_CORS_PREFLIGHT;
    }

    if rate_active {
        hv |= HV_RATE_ACTIVE;
    }

    if rate_limited {
        hv |= HV_RATE_LIMITED;
    }

    hv
}

// ── Cookie/query JSON serialization ───────────────────────────────
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
fn cookie_json_into_slice_limited(input: &[u8], out: &mut [u8], max_pairs: usize) -> Result<usize> {
    if out.len() < 2 {
        return Err(Error::from_reason("output buffer too small for cookie JSON"));
    }

    out[0] = b'{';
    let mut pos = 1usize;
    let mut count = 0usize;

    for pair in input.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() {
            continue;
        }

        let (name, value) = match pair.iter().position(|&b| b == b'=') {
            Some(eq) => (&pair[..eq], &pair[eq + 1..]),
            None => (pair, &[][..]),
        };

        let name = trim_ascii_whitespace(name);
        let value = trim_ascii_whitespace(value);

        if name.is_empty() {
            continue;
        }

        if count >= max_pairs {
            break;
        }

        let needed = (if count == 0 { 0 } else { 1 })
            + 5
            + json_escaped_len(name)
            + json_escaped_len(value);

        if needed > out.len().saturating_sub(pos) {
            return Err(Error::from_reason("output buffer too small for cookie JSON"));
        }

        if count != 0 {
            out[pos] = b',';
            pos += 1;
        }

        out[pos] = b'"';
        pos += 1;

        write_json_escaped(out, &mut pos, name);

        out[pos] = b'"';
        pos += 1;

        out[pos] = b':';
        pos += 1;

        out[pos] = b'"';
        pos += 1;

        write_json_escaped(out, &mut pos, value);

        out[pos] = b'"';
        pos += 1;

        count += 1;
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason("output buffer too small for cookie JSON"));
    }

    out[pos] = b'}';
    pos += 1;

    Ok(pos)
}

#[inline]
fn packed_pairs_to_json_into_slice_limited(
    packed: &[u8],
    out: &mut [u8],
    max_pairs: usize,
) -> Result<usize> {
    if out.len() < 2 {
        return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
    }

    if packed.len() < 4 {
        out[0..2].copy_from_slice(b"{}");
        return Ok(2);
    }

    let count = crate::util::read_u32_le(packed, 0)? as usize;

    out[0] = b'{';
    let mut pos = 1usize;
    let mut src = 4usize;
    let mut written_pairs = 0usize;

    for _ in 0..count {
        if written_pairs >= max_pairs {
            break;
        }

        let key_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        if src + key_len > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated key"));
        }

        let key = &packed[src..src + key_len];
        src += key_len;

        let val_len = crate::util::read_u32_le(packed, src)? as usize;
        src += 4;

        if src + val_len > packed.len() {
            return Err(Error::from_reason("packed pairs: truncated value"));
        }

        let val = &packed[src..src + val_len];
        src += val_len;

        let needed = (if written_pairs == 0 { 0 } else { 1 })
            + 5
            + json_escaped_len(key)
            + json_escaped_len(val);

        if needed > out.len().saturating_sub(pos) {
            return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
        }

        if written_pairs != 0 {
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

        written_pairs += 1;
    }

    if pos + 1 > out.len() {
        return Err(Error::from_reason("output buffer too small for packed pairs JSON"));
    }

    out[pos] = b'}';
    pos += 1;

    Ok(pos)
}

// ── URL helpers ───────────────────────────────────────────────────
#[inline]
fn extract_path_from_url_bytes(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") {
        8
    } else if url.starts_with(b"http://") {
        7
    } else {
        0
    };

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
fn extract_query_from_url_bytes(url: &[u8]) -> &[u8] {
    let search_start = if url.starts_with(b"https://") {
        8
    } else if url.starts_with(b"http://") {
        7
    } else {
        0
    };

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

// ── Proxy helpers ─────────────────────────────────────────────────
#[inline]
fn detect_https_bytes(
    inner: &IngressInner,
    url: &[u8],
    headers: &HeaderRefs<'_>,
    peer_trusted: bool,
) -> bool {
    if let Some(v) = inner.https_fixed {
        return v;
    }

    if url.starts_with(b"https://") || url.starts_with(b"wss://") {
        return true;
    }

    if !inner.proxy_trust.is_none() && peer_trusted && headers.has_xfp() {
        if let Some(xfp) = headers.x_forwarded_proto {
            return trim_ascii_whitespace(xfp) == b"https";
        }
    }

    false
}

// ── Metadata envelope ─────────────────────────────────────────────
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
        + 1;

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
        out.copy_within(cookies_start..cookies_start + cookies_len, wp);
        wp += cookies_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp..wp + P4.len()].copy_from_slice(P4);
    wp += P4.len();

    if query_len > 0 {
        out.copy_within(query_start..query_start + query_len, wp);
        wp += query_len;
    } else {
        out[wp..wp + 2].copy_from_slice(b"{}");
        wp += 2;
    }

    out[wp] = b'}';
    wp += 1;

    wp - pos
}