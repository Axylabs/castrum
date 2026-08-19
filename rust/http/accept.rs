// rust/http/accept.rs — Accept-Encoding parsing + content-coding negotiation.
//
// RFC 7231 §5.3.4: q-value parsing (0–1, up to 3 decimals), wildcard `*`,
// order preservation, and the `AcceptNegotiator` higher-order instance that
// precompiles the server's supported list once and answers "which encoding
// should I use for this Accept-Encoding header?"

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::bytes::trim_ascii_whitespace;

/// One parsed Accept-Encoding entry (pure-Rust core type).
#[derive(Debug, Clone)]
pub struct EncodingPref {
    pub encoding: String,
    pub q: f32,
    pub order: u32,
}

/// Parse a q-value like `0.8`, `1`, `0.123`.
fn parse_q(input: &[u8]) -> Option<f32> {
    let s = std::str::from_utf8(input).ok()?.trim();
    if s.is_empty() {
        return None;
    }
    s.parse::<f32>().ok().map(|v| v.clamp(0.0, 1.0))
}

/// Parse an Accept-Encoding header into ordered preferences (lowercased).
pub fn parse_accept_encoding_core(header: &[u8]) -> Vec<EncodingPref> {
    let mut out = Vec::new();
    let mut order = 0u32;
    for part in header.split(|&b| b == b',') {
        let part = trim_ascii_whitespace(part);
        if part.is_empty() {
            continue;
        }
        let (name, q) = match part.iter().position(|&b| b == b';') {
            Some(i) => {
                let qpart = trim_ascii_whitespace(&part[i + 1..]);
                let q = if let Some(eq) = qpart.iter().position(|&b| b == b'=') {
                    parse_q(&qpart[eq + 1..])
                } else {
                    None
                };
                (trim_ascii_whitespace(&part[..i]), q.unwrap_or(1.0))
            }
            None => (part, 1.0),
        };
        if name.is_empty() {
            continue;
        }
        out.push(EncodingPref {
            encoding: String::from_utf8_lossy(name).to_ascii_lowercase(),
            q,
            order,
        });
        order += 1;
    }
    out
}

/// Borrowed form of `EncodingPref` — no per-entry String allocation.
#[derive(Clone, Copy)]
struct EncodingPrefRef<'a> {
    name: &'a [u8],
    q: f32,
    order: u32,
}

/// Maximum encoding entries handled on the stack (covers every real-world
/// Accept-Encoding header). Headers with more entries fall back to the exact
/// heap path.
const MAX_STACK_PREFS: usize = 32;

/// Parse an Accept-Encoding header into borrowed prefs (no heap allocation).
/// Returns `usize::MAX` when the header has more than `out.len()` entries —
/// callers must fall back to the exact heap path in that case.
fn parse_accept_encoding_refs<'a>(header: &'a [u8], out: &mut [EncodingPrefRef<'a>]) -> usize {
    let mut count = 0usize;
    let mut order = 0u32;
    for part in header.split(|&b| b == b',') {
        let part = trim_ascii_whitespace(part);
        if part.is_empty() {
            continue;
        }
        let (name, q) = match part.iter().position(|&b| b == b';') {
            Some(i) => {
                let qpart = trim_ascii_whitespace(&part[i + 1..]);
                let q = if let Some(eq) = qpart.iter().position(|&b| b == b'=') {
                    parse_q(&qpart[eq + 1..])
                } else {
                    None
                };
                (trim_ascii_whitespace(&part[..i]), q.unwrap_or(1.0))
            }
            None => (part, 1.0),
        };
        if name.is_empty() {
            continue;
        }
        if count >= out.len() {
            return usize::MAX;
        }
        out[count] = EncodingPrefRef { name, q, order };
        count += 1;
        order += 1;
    }
    count
}

/// Equivalent to `pref_name.to_ascii_lowercase() == supported` WITHOUT
/// allocating — exactly mirrors the heap path, where the pref is lowercased
/// and the supported string is compared as-is (case-sensitive). For the usual
/// pre-lowercased supported lists this is a plain case-insensitive compare.
#[inline]
fn name_eq_supported(pref_name: &[u8], supported: &[u8]) -> bool {
    if pref_name.len() != supported.len() {
        return false;
    }
    for (a, b) in pref_name.iter().zip(supported) {
        if a.to_ascii_lowercase() != *b {
            return false;
        }
    }
    true
}

/// Pick the best supported encoding for a header, or `None` for identity.
/// Priority: most specific match, then highest q, then earliest client order.
///
/// The common path parses the header into a stack buffer (no heap allocations
/// per call); a header with more than `MAX_STACK_PREFS` entries falls back to
/// the exact heap path.
pub fn negotiate_encoding(supported: &[String], header: &[u8]) -> Option<String> {
    let mut stack = [EncodingPrefRef {
        name: &[],
        q: 0.0,
        order: 0,
    }; MAX_STACK_PREFS];
    let count = parse_accept_encoding_refs(header, &mut stack);
    if count == usize::MAX {
        return negotiate_encoding_heap(supported, header);
    }
    if count == 0 {
        return supported.first().cloned();
    }
    negotiate_refs(supported, &stack[..count])
}

/// Heap fallback with identical semantics to `negotiate_refs`, used only for
/// headers too large for the stack buffer.
fn negotiate_encoding_heap(supported: &[String], header: &[u8]) -> Option<String> {
    let prefs = parse_accept_encoding_core(header);
    if prefs.is_empty() {
        return supported.first().cloned();
    }

    let mut best: Option<(&String, f32, u32, u32)> = None; // (enc, q, spec, order)
    for sup in supported {
        let mut matched: Option<(f32, u32, u32)> = None; // (q, spec, order)
        for pref in &prefs {
            let spec = if pref.encoding == sup.as_str() {
                2
            } else if pref.encoding == "*" {
                1
            } else {
                continue;
            };
            let replace = match matched {
                None => true,
                Some((_, s, o)) => spec > s || (spec == s && pref.order < o),
            };
            if replace {
                matched = Some((pref.q, spec, pref.order));
            }
        }
        let Some((q, spec, order)) = matched else {
            continue;
        };
        if q <= 0.0 {
            continue;
        }
        let cand = (sup, q, spec, order);
        let better = match best {
            None => true,
            Some((_, bq, bspec, border)) => {
                spec > bspec
                    || (spec == bspec && (q - bq).abs() > 1e-4 && q > bq)
                    || (spec == bspec && (q - bq).abs() <= 1e-4 && order < border)
            }
        };
        if better {
            best = Some(cand);
        }
    }
    best.map(|(e, _, _, _)| (*e).clone())
}

/// Negotiation core over borrowed prefs (stack path).
fn negotiate_refs(supported: &[String], prefs: &[EncodingPrefRef<'_>]) -> Option<String> {
    let mut best: Option<(&String, f32, u32, u32)> = None; // (enc, q, spec, order)
    for sup in supported {
        let mut matched: Option<(f32, u32, u32)> = None; // (q, spec, order)
        for pref in prefs {
            let spec = if name_eq_supported(pref.name, sup.as_bytes()) {
                2
            } else if pref.name == b"*" {
                1
            } else {
                continue;
            };
            let replace = match matched {
                None => true,
                Some((_, s, o)) => spec > s || (spec == s && pref.order < o),
            };
            if replace {
                matched = Some((pref.q, spec, pref.order));
            }
        }
        let Some((q, spec, order)) = matched else {
            continue;
        };
        if q <= 0.0 {
            continue;
        }
        let cand = (sup, q, spec, order);
        let better = match best {
            None => true,
            Some((_, bq, bspec, border)) => {
                spec > bspec
                    || (spec == bspec && (q - bq).abs() > 1e-4 && q > bq)
                    || (spec == bspec && (q - bq).abs() <= 1e-4 && order < border)
            }
        };
        if better {
            best = Some(cand);
        }
    }
    best.map(|(e, _, _, _)| (*e).clone())
}

/// ignex-compatible SERVER-preference negotiation (q-only, server order breaks
/// ties). This is the semantic of ignex's `negotiateEncoding` (compression
/// plugin): parse the header, apply explicit q-values with a wildcard
/// fallback for unlisted encodings, exclude `q <= 0`, and on a tie keep the
/// EARLIER supported entry (server preference) — NOT the client's order and
/// NOT the RFC-specificity rule. Empty/absent header → `None` (identity),
/// unlike the specificity negotiator which returns the first supported.
pub fn negotiate_encoding_server_preference(supported: &[String], header: &[u8]) -> Option<String> {
    let mut stack = [EncodingPrefRef {
        name: &[],
        q: 0.0,
        order: 0,
    }; MAX_STACK_PREFS];
    let count = parse_accept_encoding_refs(header, &mut stack);
    if count == usize::MAX {
        return negotiate_server_preference_heap(supported, header);
    }
    if count == 0 {
        return None; // empty header → identity (no encoding preferred)
    }
    negotiate_server_preference_refs(supported, &stack[..count])
}

/// Server-preference negotiation core over borrowed prefs (stack path).
fn negotiate_server_preference_refs(
    supported: &[String],
    prefs: &[EncodingPrefRef<'_>],
) -> Option<String> {
    // Wildcard q applies to every encoding not listed explicitly.
    let mut wildcard_q = -1.0f32;
    for p in prefs {
        if p.name == b"*" {
            wildcard_q = wildcard_q.max(p.q);
        }
    }
    let mut best: Option<(&String, f32)> = None; // (enc, q); ties keep the FIRST
    for sup in supported {
        // Explicit q for `sup` (first occurrence wins — RFC 7231 §5.3.4
        // duplicates are undefined; ignex keeps the first).
        let mut q = if wildcard_q >= 0.0 { wildcard_q } else { -1.0 };
        for p in prefs {
            if name_eq_supported(p.name, sup.as_bytes()) {
                q = p.q;
                break;
            }
        }
        if q <= 0.0 {
            continue;
        }
        if best.is_none() || q > best.unwrap().1 {
            best = Some((sup, q));
        }
        // Tie (q == best q) → keep the earlier supported entry (server pref).
    }
    best.map(|(e, _)| (*e).clone())
}

/// Heap fallback for the server-preference negotiator (identical semantics).
fn negotiate_server_preference_heap(supported: &[String], header: &[u8]) -> Option<String> {
    let prefs = parse_accept_encoding_core(header);
    if prefs.is_empty() {
        return None;
    }
    let mut wildcard_q = -1.0f32;
    for p in &prefs {
        if p.encoding == "*" {
            wildcard_q = wildcard_q.max(p.q);
        }
    }
    let mut best: Option<(&String, f32)> = None;
    for sup in supported {
        let mut q = if wildcard_q >= 0.0 { wildcard_q } else { -1.0 };
        for p in &prefs {
            if p.encoding == sup.as_str() {
                q = p.q;
                break;
            }
        }
        if q <= 0.0 {
            continue;
        }
        if best.is_none() || q > best.unwrap().1 {
            best = Some((sup, q));
        }
    }
    best.map(|(e, _)| (*e).clone())
}

/// napi-projected parse result.
#[napi(object)]
pub struct EncodingPrefResult {
    pub encoding: String,
    pub q: f64,
    pub order: u32,
}

#[napi]
pub fn parse_accept_encoding(input: Uint8Array) -> Vec<EncodingPrefResult> {
    parse_accept_encoding_core(input.as_ref())
        .into_iter()
        .map(|p| EncodingPrefResult {
            encoding: p.encoding,
            q: f64::from(p.q),
            order: p.order,
        })
        .collect()
}

/// Higher-order instance: precompiles the supported encodings once and
/// negotiates any number of headers against that list.
#[napi]
pub struct AcceptNegotiator {
    supported: Vec<String>,
}

#[napi]
impl AcceptNegotiator {
    #[napi(constructor)]
    pub fn new(supported: Vec<String>) -> Self {
        let supported = supported
            .into_iter()
            .map(|s| s.to_ascii_lowercase())
            .collect();
        Self { supported }
    }

    /// Best supported encoding for `header`, or null for identity.
    #[napi]
    pub fn negotiate(&self, header: Uint8Array) -> Option<String> {
        negotiate_encoding(&self.supported, header.as_ref())
    }

    /// Best supported encoding for `header` with SERVER-preference
    /// tie-breaking (q-only; the supported list's order decides ties). Matches
    /// ignex's `negotiateEncoding` semantics; empty header → None (identity).
    #[napi]
    pub fn negotiate_server_preference(&self, header: Uint8Array) -> Option<String> {
        negotiate_encoding_server_preference(&self.supported, header.as_ref())
    }

    /// Opaque handle to the precompiled supported list, for the `bun:ffi`
    /// C-ABI fast path (`castrum_accept_negotiator_negotiate` in rust/ffi.rs).
    /// Only valid while THIS instance is alive; the JS wrapper holds it.
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        self as *const AcceptNegotiator as u64
    }
}

/// C-ABI support: best supported encoding for `header`, or None = identity.
///
/// # Safety
/// `p` must be a valid `*const AcceptNegotiator` from `inner_ptr`, alive for
/// the call (the JS wrapper holds the napi instance).
pub(crate) unsafe fn accept_negotiator_negotiate_core(
    p: *const AcceptNegotiator,
    header: &[u8],
) -> Option<Vec<u8>> {
    let this = &*p;
    negotiate_encoding(&this.supported, header).map(String::into_bytes)
}

/// C-ABI support: server-preference negotiation (ignex `negotiateEncoding`
/// semantics). `None` = identity (no supported encoding acceptable / empty).
///
/// # Safety
/// `p` must be a valid `*const AcceptNegotiator` from `inner_ptr`, alive for
/// the call.
pub(crate) unsafe fn accept_negotiator_negotiate_server_core(
    p: *const AcceptNegotiator,
    header: &[u8],
) -> Option<Vec<u8>> {
    let this = &*p;
    negotiate_encoding_server_preference(&this.supported, header).map(String::into_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn negotiate(supported: &[&str], header: &str) -> Option<String> {
        let sup: Vec<String> = supported.iter().map(|s| s.to_string()).collect();
        negotiate_encoding(&sup, header.as_bytes())
    }

    #[test]
    fn parses_q_and_order() {
        let prefs = parse_accept_encoding_core(b"gzip;q=0.8, br, *;q=0.1");
        assert_eq!(prefs.len(), 3);
        assert_eq!(prefs[0].encoding, "gzip");
        assert!((prefs[0].q - 0.8).abs() < 1e-4);
        assert_eq!(prefs[0].order, 0);
        assert_eq!(prefs[1].encoding, "br");
        assert!((prefs[1].q - 1.0).abs() < 1e-4);
        assert_eq!(prefs[2].encoding, "*");
        assert!((prefs[2].q - 0.1).abs() < 1e-4);
    }

    #[test]
    fn lowercases_encoding() {
        let prefs = parse_accept_encoding_core(b"GZip");
        assert_eq!(prefs[0].encoding, "gzip");
    }

    #[test]
    fn empty_header_returns_first_supported() {
        assert_eq!(negotiate(&["gzip", "br"], ""), Some("gzip".to_string()));
    }

    #[test]
    fn picks_highest_q_among_explicit() {
        assert_eq!(
            negotiate(&["gzip", "br"], "gzip;q=0.8, br;q=1.0"),
            Some("br".to_string())
        );
    }

    #[test]
    fn specific_beats_wildcard_even_at_lower_q() {
        assert_eq!(
            negotiate(&["gzip", "br"], "gzip;q=0.5, *;q=1"),
            Some("gzip".to_string())
        );
    }

    #[test]
    fn q_zero_disables_even_with_wildcard() {
        assert_eq!(negotiate(&["gzip"], "gzip;q=0, *;q=1"), None);
    }

    #[test]
    fn unlisted_without_wildcard_not_acceptable() {
        assert_eq!(negotiate(&["gzip", "br"], "br;q=1"), Some("br".to_string()));
        assert_eq!(negotiate(&["gzip"], "br;q=1"), None);
    }

    #[test]
    fn wildcard_matches_unlisted() {
        assert_eq!(
            negotiate(&["gzip"], "br;q=0.1, *;q=0.9"),
            Some("gzip".to_string())
        );
    }

    #[test]
    fn negotiator_instance_lowercases_supported() {
        let n = AcceptNegotiator::new(vec!["GZip".to_string(), "Br".to_string()]);
        assert_eq!(
            n.negotiate(Uint8Array::new(b"br".to_vec())),
            Some("br".to_string())
        );
        assert_eq!(
            n.negotiate(Uint8Array::new(b"gzip".to_vec())),
            Some("gzip".to_string())
        );
    }

    #[test]
    fn negotiate_stack_heap_parity() {
        // The allocation-free stack path must produce IDENTICAL results to the
        // exact heap path for every input, including case/whitespace/q-edge
        // cases where the two implementations could drift.
        let supported: Vec<String> = ["gzip", "br", "deflate"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cases = [
            "gzip, br, deflate",
            "GZip;q=0.8, br;q=1.0",
            "*;q=0.5",
            "gzip;q=0, br;q=1",
            "",
            "zstd;q=1, *;q=0.1",
            "gzip;q=0.2, gzip;q=0.9",
            " br ;q = 0.5 ",
            "gzip;q=0.9999, br;q=0.9998",
        ];
        for c in cases {
            assert_eq!(
                negotiate_encoding(&supported, c.as_bytes()),
                negotiate_encoding_heap(&supported, c.as_bytes()),
                "stack vs heap parity for {c:?}"
            );
        }
    }

    #[test]
    fn negotiate_large_header_falls_back_to_heap() {
        // A header with more than MAX_STACK_PREFS entries must exercise the
        // heap fallback and still produce a correct result.
        let mut header = String::new();
        for i in 0..40 {
            if i > 0 {
                header.push(',');
            }
            header.push_str(&format!("enc{i};q=0.1"));
        }
        header.push_str(", gzip;q=1.0");
        assert_eq!(
            negotiate(&["gzip", "br"], &header),
            Some("gzip".to_string())
        );
    }

    #[test]
    fn server_preference_matches_ignex_negotiate_encoding() {
        let sup: Vec<String> = ["br", "gzip", "deflate"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let neg = |h: &str| negotiate_encoding_server_preference(&sup, h.as_bytes());
        // The exact vectors from ignex content-encoding.ts `negotiateEncoding`.
        assert_eq!(neg("gzip, br"), Some("br".to_string())); // tie → server pref (br first)
        assert_eq!(neg("br;q=0.8, gzip;q=0.9"), Some("gzip".to_string()));
        assert_eq!(neg("*"), Some("br".to_string()));
        assert_eq!(neg("gzip;q=0, deflate"), Some("deflate".to_string()));
        assert_eq!(neg("identity"), None);
        assert_eq!(neg(""), None); // empty → identity
        assert_eq!(
            neg("deflate, gzip;q=0.5, br;q=0.3"),
            Some("deflate".to_string())
        );
    }

    #[test]
    fn server_preference_wildcard_vs_explicit() {
        let sup: Vec<String> = ["gzip", "br"].iter().map(|s| s.to_string()).collect();
        let neg = |h: &str| negotiate_encoding_server_preference(&sup, h.as_bytes());
        // Explicit q=0.5 < wildcard q=1 → br (unlisted) wins (q-only, no specificity).
        assert_eq!(neg("gzip;q=0.5, *;q=1"), Some("br".to_string()));
        // Explicit q=1 beats wildcard q=0.5.
        assert_eq!(neg("gzip;q=1, *;q=0.5"), Some("gzip".to_string()));
        // Tie (both q=1) → FIRST supported entry wins (server preference):
        // supported is ["gzip", "br"], so gzip wins regardless of client order.
        assert_eq!(neg("br;q=1, gzip;q=1"), Some("gzip".to_string()));
    }

    #[test]
    fn server_preference_stack_heap_parity() {
        let sup: Vec<String> = ["br", "gzip", "deflate"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cases = [
            "gzip, br, deflate",
            "GZip;q=0.8, br;q=1.0",
            "*;q=0.5",
            "gzip;q=0, br;q=1",
            "",
            "zstd;q=1, *;q=0.1",
            "gzip;q=0.2, gzip;q=0.9",
            " br ;q = 0.5 ",
            "gzip;q=0.9999, br;q=0.9998",
        ];
        for c in cases {
            assert_eq!(
                negotiate_encoding_server_preference(&sup, c.as_bytes()),
                negotiate_server_preference_heap(&sup, c.as_bytes()),
                "server-pref stack vs heap parity for {c:?}"
            );
        }
    }
}
