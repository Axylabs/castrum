// rust/core/cors.rs — CORS engine
// Pure Rust, no napi dependencies.

use crate::core::headers::HeaderRefs;
use crate::core::method::MethodKind;
use crate::core::util::trim_ascii_whitespace;

// ── CORS options ───────────────────────────────────────────────────

/// CORS configuration options.
#[derive(Clone, Debug)]
pub struct CorsOptions {
    pub allow_origin: Option<Vec<String>>,
    pub allow_methods: Option<Vec<String>>,
    pub allow_headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub allow_credentials: Option<bool>,
    pub max_age: Option<u32>,
}

impl Default for CorsOptions {
    fn default() -> Self {
        Self {
            allow_origin: None,
            allow_methods: None,
            allow_headers: None,
            expose_headers: None,
            allow_credentials: None,
            max_age: None,
        }
    }
}

// ── CORS mode ──────────────────────────────────────────────────────

#[derive(Clone)]
enum CorsMode {
    Disabled,
    Wildcard,
    Allowlist(Vec<Box<[u8]>>),
}

// ── CORS engine ───────────────────────────────────────────────────

/// The CORS evaluation engine.
///
/// Pre-computes method bitmasks for O(1) method matching.
#[derive(Clone)]
pub struct CorsEngine {
    mode: CorsMode,
    credentials: bool,
    methods_wildcard: bool,
    /// Bitmask of allowed methods for O(1) lookup.
    method_bits: u16,
    headers_wildcard: bool,
    headers: Vec<Box<[u8]>>,
    max_age: u32,
}

/// Result of a CORS evaluation.
pub struct CorsEvaluation {
    pub allowed: bool,
    pub preflight: bool,
}

impl CorsEngine {
    /// Create a disabled CORS engine.
    pub fn disabled() -> Self {
        Self {
            mode: CorsMode::Disabled,
            credentials: false,
            methods_wildcard: false,
            method_bits: 0,
            headers_wildcard: false,
            headers: Vec::new(),
            max_age: 0,
        }
    }

    /// Create a CORS engine from options.
    pub fn from_options(opts: Option<CorsOptions>) -> Self {
        let Some(opts) = opts else {
            return Self::disabled();
        };

        let credentials = opts.allow_credentials.unwrap_or(false);

        let mode = match opts.allow_origin {
            Some(list) if !list.is_empty() => {
                if list.iter().any(|o| o == "*") {
                    CorsMode::Wildcard
                } else {
                    CorsMode::Allowlist(
                        list.iter()
                            .map(|s| s.as_bytes().to_vec().into_boxed_slice())
                            .collect(),
                    )
                }
            }
            _ => CorsMode::Wildcard,
        };

        let (methods_wildcard, method_bits) = parse_allowed_methods_bitset(opts.allow_methods);
        let (headers_wildcard, headers) = parse_allowed_headers(opts.allow_headers);

        Self {
            mode,
            credentials,
            methods_wildcard,
            method_bits,
            headers_wildcard,
            headers,
            max_age: opts.max_age.unwrap_or(0),
        }
    }

    /// Evaluate CORS for the given method and headers.
    #[inline]
    pub fn evaluate(&self, method: MethodKind, headers: &HeaderRefs) -> CorsEvaluation {
        let origin = match headers.origin() {
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
                allowed = self.preflight_method_allowed(headers.acrm())
                    && self.headers_allowed(headers.acrh());
            } else {
                allowed = self.method_allowed_kind(method);
            }
        }

        CorsEvaluation { allowed, preflight }
    }

    /// Returns the configured max_age.
    #[inline(always)]
    pub fn max_age(&self) -> u32 {
        self.max_age
    }

    #[inline(always)]
    fn method_allowed_kind(&self, kind: MethodKind) -> bool {
        if self.methods_wildcard {
            return true;
        }

        if self.method_bits == 0 {
            return matches!(kind, MethodKind::Get | MethodKind::Head | MethodKind::Post);
        }

        (self.method_bits & kind.bit()) != 0
    }

    #[inline]
    fn preflight_method_allowed(&self, acrm: Option<&[u8]>) -> bool {
        let Some(acrm) = acrm else {
            return false;
        };

        let trimmed = trim_ascii_whitespace(acrm);
        if trimmed.is_empty() {
            return false;
        }

        let kind = MethodKind::from_bytes_ignore_case(trimmed);
        self.method_allowed_kind(kind)
    }

    #[inline]
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

    /// Returns `true` if credentials mode is enabled.
    #[inline(always)]
    pub fn credentials(&self) -> bool {
        self.credentials
    }

    /// Returns `true` if wildcard origin is allowed.
    #[inline(always)]
    pub fn is_wildcard(&self) -> bool {
        matches!(self.mode, CorsMode::Wildcard)
    }
}

fn is_cors_safelisted_request_header(name: &[u8]) -> bool {
    matches!(
        name,
        b"accept" | b"accept-language" | b"content-language" | b"content-type"
    )
}

fn parse_allowed_methods_bitset(list: Option<Vec<String>>) -> (bool, u16) {
    let Some(list) = list else {
        return (false, 0);
    };

    let mut bits = 0u16;

    for raw in list {
        let trimmed = raw.trim();

        if trimmed == "*" {
            return (true, 0);
        }

        if trimmed.is_empty() {
            continue;
        }

        let upper = trimmed.to_ascii_uppercase();
        let kind = MethodKind::from_str(&upper);

        if kind != MethodKind::Other {
            bits |= kind.bit();
        }
    }

    (false, bits)
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
