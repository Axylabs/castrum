// rust/ingress/native_route.rs — Per-route native stack (`castrum_route_*`).
//
// The wire contract consumed by `@ignex/native` (the "ignex" framework): a
// route plan is compiled ONCE into a pre-baked `NativeRoute` (parse flags,
// size limits, and the draft-07 body schema compiled as `IngressSchema`), then
// each request packs a tiny frame (query substring + Cookie header + body
// bytes) and gets a packed verdict result in ONE native call.
//
// This is the live external contract that supersedes the deleted `rust/route.rs`
// (dead external-project wire). The wire is pinned on the JS side by
// `@ignex/native/src/route-wire.ts` (magic `ROUT`, version 3) and the lenient
// parse parity by `scripts/verify-native-route.ts`; stage tags MUST match
// `ROUTE_STAGE_TAG` there:
//   parseQuery=0, parseCookies=1, validateQuery=2, validateCookies=3,
//   validateBody=4, requireJsonBody=5.
//
// Semantics (first-failure-wins, in stage order — matching the compiled JS
// prelude): a non-JSON body under `requireJsonBody` → errorCode 400; a body
// failing its schema under `validateBody` → errorCode 422. Parse stages are
// LENIENT (byte-parity with ignex's `decodePairList`): malformed `%ZZ` and
// invalid-UTF-8 `%FF` pass through raw, `+` → space, `%2B` → literal `+`;
// cookies are trimmed + DQUOTE-unwrapped but NOT URL-decoded.
//
// Result wire (needed-size convention — `0` = real error, `> out.len` = exact
// required size): `[flags u32][errorCode u32]` + a query pair section iff
// `parseQuery` + a cookie pair section iff `parseCookies`. Pair sections are
// `[count u32] { [nameLen u32][name][valueLen u32][value] }`.

use std::borrow::Cow;
use std::sync::Arc;

use super::packed::{read_section, read_u32_at};
use super::IngressSchema;
use crate::util::bytes::cookie_pairs;

// ── Wire constants (MUST match @ignex/native route-wire.ts) ──────
/// Magic that identifies a route descriptor (`"ROUT"` LE).
pub(crate) const ROUTE_DESC_MAGIC: u32 = 0x524f5554;
/// Wire version — bump on ANY layout change (descriptor, frame, or result).
pub(crate) const ROUTE_DESC_VERSION: u32 = 3;

/// Frame flag: the body section is present (bit 0 of the frame flags word).
pub(crate) const ROUTE_FRAME_FLAG_HAS_BODY: u32 = 1 << 0;

/// Result flag: the route stack succeeded (else `errorCode` is meaningful).
pub(crate) const ROUTE_RESULT_FLAG_OK: u32 = 1 << 0;
/// Result flag: the body parsed as well-formed JSON.
pub(crate) const ROUTE_RESULT_FLAG_BODY_VALID_JSON: u32 = 1 << 1;
/// Result flag: the parsed query satisfied its schema / limits.
pub(crate) const ROUTE_RESULT_FLAG_QUERY_VALID: u32 = 1 << 2;
/// Result flag: the parsed cookies satisfied their schema / limits.
pub(crate) const ROUTE_RESULT_FLAG_COOKIE_VALID: u32 = 1 << 3;
/// Result flag: the body satisfied its schema (when one exists).
pub(crate) const ROUTE_RESULT_FLAG_BODY_VALID: u32 = 1 << 4;
// Wire-contract bits for params/headers validation. This stack never sets them
// (the compiler only emits parse/body stages), but they MUST stay defined so
// the result layout matches @ignex/native route-wire.ts.
#[allow(dead_code)]
pub(crate) const ROUTE_RESULT_FLAG_PARAMS_VALID: u32 = 1 << 5;
#[allow(dead_code)]
pub(crate) const ROUTE_RESULT_FLAG_HEADERS_VALID: u32 = 1 << 6;

/// Descriptor stage tags (the ordered pipeline a route instance runs).
pub(crate) const STAGE_PARSE_QUERY: u8 = 0;
pub(crate) const STAGE_PARSE_COOKIES: u8 = 1;
pub(crate) const STAGE_VALIDATE_QUERY: u8 = 2;
pub(crate) const STAGE_VALIDATE_COOKIES: u8 = 3;
pub(crate) const STAGE_VALIDATE_BODY: u8 = 4;
pub(crate) const STAGE_REQUIRE_JSON_BODY: u8 = 5;

/// Descriptor part tags (`RoutePartKind`): the schema-bearing request parts.
const PART_BODY: u8 = 3;

/// Body-rejected error codes reported in the result header (0 = ok).
const ERR_BODY_NOT_JSON: u32 = 400;
const ERR_BODY_SCHEMA: u32 = 422;

/// A compiled, pre-baked per-route native stack.
pub(crate) struct NativeRoute {
    parse_query: bool,
    parse_cookies: bool,
    require_json_body: bool,
    validate_body: bool,
    max_body_bytes: usize,
    max_query_bytes: usize,
    max_cookie_bytes: usize,
    max_pairs: usize,
    /// Compiled draft-07 body schema (fast_schema + jsonschema dual).
    body_schema: Option<Arc<IngressSchema>>,
}

impl NativeRoute {
    /// Compile a route plan from its descriptor wire. Returns a human-readable
    /// error string on a malformed/unsupported descriptor (bad magic/version,
    /// unknown stage/part tag, a query/cookie/params/headers schema — the
    /// current stack validates the BODY only, so a non-body schema is an
    /// unsupported feature → the caller falls back to JS, byte-parity
    /// preserved by design).
    pub(crate) fn compile(desc: &[u8]) -> std::result::Result<Self, String> {
        let mut pos = 0usize;
        let magic = read_u32_at(desc, &mut pos)?;
        if (magic as u32) != ROUTE_DESC_MAGIC {
            return Err(format!("route descriptor: bad magic 0x{magic:08x}"));
        }
        let version = read_u32_at(desc, &mut pos)?;
        if (version as u32) != ROUTE_DESC_VERSION {
            return Err(format!(
                "route descriptor: unsupported version {version} (this build supports {ROUTE_DESC_VERSION})"
            ));
        }
        let max_body_bytes = read_u32_at(desc, &mut pos)?;
        let max_query_bytes = read_u32_at(desc, &mut pos)?;
        let max_cookie_bytes = read_u32_at(desc, &mut pos)?;
        let max_pairs = read_u32_at(desc, &mut pos)?;

        let mut parse_query = false;
        let mut parse_cookies = false;
        let mut require_json_body = false;
        let mut validate_body = false;

        let stage_count = read_u32_at(desc, &mut pos)?;
        for _ in 0..stage_count {
            let tag = *desc
                .get(pos)
                .ok_or_else(|| "route descriptor: truncated stage list".to_string())?;
            pos += 1;
            match tag {
                STAGE_PARSE_QUERY => parse_query = true,
                STAGE_PARSE_COOKIES => parse_cookies = true,
                // validateQuery/validateCookies are no-ops in this stack (the
                // parse VALID bit is the verdict); a schema for them would have
                // been rejected below.
                STAGE_VALIDATE_QUERY => {}
                STAGE_VALIDATE_COOKIES => {}
                STAGE_VALIDATE_BODY => validate_body = true,
                STAGE_REQUIRE_JSON_BODY => require_json_body = true,
                other => {
                    return Err(format!("route descriptor: unknown stage tag {other}"));
                }
            }
        }

        let schema_count = read_u32_at(desc, &mut pos)?;
        let mut body_schema_bytes: Option<Vec<u8>> = None;
        for _ in 0..schema_count {
            let part = *desc
                .get(pos)
                .ok_or_else(|| "route descriptor: truncated schema list".to_string())?;
            pos += 1;
            let len = read_u32_at(desc, &mut pos)?;
            let end = pos
                .checked_add(len)
                .ok_or_else(|| "route descriptor: schema length overflow".to_string())?;
            if end > desc.len() {
                return Err("route descriptor: truncated schema".to_string());
            }
            let bytes = &desc[pos..end];
            pos = end;
            match part {
                PART_BODY => body_schema_bytes = Some(bytes.to_vec()),
                other => {
                    // This stack validates the BODY only. A schema for any other
                    // part (params/query/cookie/headers/response) is unsupported
                    // → fail compilation so the caller falls back to JS
                    // (byte-parity preserved by design). validateQuery /
                    // validateCookies WITHOUT a schema are a no-op (the parse
                    // VALID bit is the verdict), so they never reach this check.
                    return Err(format!(
                        "route descriptor: unsupported schema part tag {other} (this stack validates the body only)"
                    ));
                }
            }
        }

        let body_schema = match body_schema_bytes {
            Some(bytes) => {
                let schema_str = std::str::from_utf8(&bytes)
                    .map_err(|_| "route descriptor: body schema is not valid UTF-8".to_string())?;
                let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
                    .map_err(|e| format!("route descriptor: body schema JSON error: {e}"))?;
                let compiled = IngressSchema::compile(&schema_value)
                    .map_err(|e| format!("route descriptor: body schema compile error: {e}"))?;
                Some(Arc::new(compiled))
            }
            None => None,
        };

        Ok(Self {
            parse_query,
            parse_cookies,
            require_json_body,
            validate_body,
            max_body_bytes,
            max_query_bytes,
            max_cookie_bytes,
            max_pairs,
            body_schema,
        })
    }

    /// Run the pre-baked stack for one request frame, writing the packed
    /// result into `out`. Returns `Ok(n)` where `n` is the number of bytes
    /// written when `out` is large enough, OR the exact required size when it
    /// is too small (the needed-size convention: `0` = real error, `> out.len`
    /// = exact required). `Err` = malformed frame (→ 0 on the C ABI).
    ///
    /// Pure: `&self`, no interior mutability — safe for concurrent use.
    pub(crate) fn run(&self, frame: &[u8], out: &mut [u8]) -> std::result::Result<usize, String> {
        // ── Parse the request frame ─────────────────────────────────
        let mut pos = 0usize;
        let flags = read_u32_at(frame, &mut pos)?;
        let has_body = (flags as u32) & ROUTE_FRAME_FLAG_HAS_BODY != 0;
        let query = read_section(frame, &mut pos, usize::MAX)?;
        let cookie = read_section(frame, &mut pos, usize::MAX)?;
        let body: &[u8] = if has_body {
            read_section(frame, &mut pos, usize::MAX)?
        } else {
            &[]
        };

        // ── Body verdicts (first-failure-wins, in stage order) ──────
        let mut error_code: u32 = 0;
        let mut body_valid_json = false;
        let mut body_valid = false;
        if self.require_json_body || self.validate_body {
            if !has_body || body.len() > self.max_body_bytes {
                body_valid_json = false;
                if self.require_json_body {
                    error_code = ERR_BODY_NOT_JSON;
                }
            } else {
                body_valid_json = crate::json::json_ops::json_valid_bytes(body);
                if self.require_json_body && !body_valid_json {
                    error_code = ERR_BODY_NOT_JSON;
                } else if self.validate_body {
                    if !body_valid_json {
                        // Defensive: the compiler always emits `requireJsonBody`
                        // before `validateBody`, so this is an unsupported combo.
                        error_code = ERR_BODY_NOT_JSON;
                    } else if let Some(schema) = &self.body_schema {
                        if schema.validate(body) {
                            body_valid = true;
                        } else {
                            error_code = ERR_BODY_SCHEMA;
                        }
                    } else {
                        // No schema compiled → no validation constraint.
                        body_valid = true;
                    }
                } else {
                    // requireJsonBody passed (a well-formed JSON body is valid).
                    body_valid = true;
                }
            }
        }

        // ── Parse + size the pair sections ──────────────────────────
        let mut query_size = 0usize;
        let mut cookie_size = 0usize;
        let mut query_valid = false;
        let mut cookie_valid = false;
        if self.parse_query {
            let over = query.len() > self.max_query_bytes;
            let (size, capped) = query_section_size(query, self.max_pairs);
            query_size = size;
            query_valid = !over && !capped;
        }
        if self.parse_cookies {
            let over = cookie.len() > self.max_cookie_bytes;
            let (size, capped) = cookie_section_size(cookie, self.max_pairs);
            cookie_size = size;
            cookie_valid = !over && !capped;
        }
        // validateQuery/validateCookies without a schema are no-ops (the parse
        // VALID bit above is the verdict); with a schema, compile would have
        // rejected the descriptor → the caller fell back to JS.

        // ── Assemble the result ─────────────────────────────────────
        let mut result_flags: u32 = 0;
        if error_code == 0 {
            result_flags |= ROUTE_RESULT_FLAG_OK;
        }
        if body_valid_json {
            result_flags |= ROUTE_RESULT_FLAG_BODY_VALID_JSON;
        }
        if query_valid {
            result_flags |= ROUTE_RESULT_FLAG_QUERY_VALID;
        }
        if cookie_valid {
            result_flags |= ROUTE_RESULT_FLAG_COOKIE_VALID;
        }
        if body_valid {
            result_flags |= ROUTE_RESULT_FLAG_BODY_VALID;
        }

        let required = 8 + query_size + cookie_size;
        if out.len() < required {
            return Ok(required); // needed-size: report the exact size, write nothing
        }

        let mut w = 0usize;
        // NOTE: pass the FULL `out` slice (not `&mut out[w..]`) — `w` is the
        // absolute write position, so re-slicing would double-apply the offset
        // and scatter the header across the buffer.
        write_u32(out, &mut w, result_flags);
        write_u32(out, &mut w, error_code);
        if self.parse_query {
            write_query_section(out, &mut w, query, self.max_pairs);
        }
        if self.parse_cookies {
            write_cookie_section(out, &mut w, cookie, self.max_pairs);
        }
        Ok(w)
    }
}

// ── Lenient query parsing (byte-parity with ignex `decodePairList`) ──

/// A `name=value` pair (name is the whole segment when there is no `=`).
struct Pair<'a> {
    name: &'a [u8],
    value: &'a [u8],
}

/// Split `a=1&b=2`-style bytes into `[name, value]` pairs, skipping empty
/// segments (matches JS `decodePairList`).
fn query_pairs(query: &[u8]) -> impl Iterator<Item = Pair<'_>> + '_ {
    query
        .split(|&b| b == b'&')
        .filter(|p| !p.is_empty())
        .map(|pair| match pair.iter().position(|&b| b == b'=') {
            Some(eq) => Pair {
                name: &pair[..eq],
                value: &pair[eq + 1..],
            },
            None => Pair {
                name: pair,
                value: &[],
            },
        })
}

// `cookie_pairs` (crate::util::bytes) yields raw (trimmed, DQUOTE-unwrapped,
// NOT URL-decoded) `name=value` slices — byte-identical to ignex's
// `cookiePairs` fallback.

/// LENIENT segment decode (matches JS `decodeSegment`): `+` → space, `%XX` →
/// byte, result must be valid UTF-8; on ANY failure the WHOLE original segment
/// is returned unchanged (with `+` AND `%` intact — the JS catch returns `s`).
fn decode_segment_lenient(seg: &[u8]) -> Cow<'_, [u8]> {
    if memchr::memchr2(b'+', b'%', seg).is_none() {
        return Cow::Borrowed(seg);
    }
    let mut replaced = Vec::with_capacity(seg.len());
    for &b in seg {
        replaced.push(if b == b'+' { b' ' } else { b });
    }
    match decode_percent_utf8(&replaced) {
        Some(decoded) => Cow::Owned(decoded),
        None => Cow::Borrowed(seg),
    }
}

/// The decoded byte length of `seg` under the lenient rules (the original
/// length when decoding fails — the segment is passed through raw).
#[inline]
fn decode_segment_len(seg: &[u8]) -> usize {
    decode_segment_lenient(seg).len()
}

/// Percent-decode `input` (which has already had `+`→space applied) and
/// validate the result is well-formed UTF-8. Returns `None` on a malformed
/// `%XX` OR invalid UTF-8 (both throw in `decodeURIComponent`).
fn decode_percent_utf8(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0usize;
    while i < input.len() {
        match input[i] {
            b'%' => {
                if i + 2 >= input.len() {
                    return None;
                }
                let hi = hex_val(input[i + 1])?;
                let lo = hex_val(input[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    std::str::from_utf8(&out).ok()?;
    Some(out)
}

/// Hex digit → nibble (None for non-hex).
#[inline]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ── Pair-section size + write (two passes, zero alloc) ────────────

/// Size pass over decoded query pairs (name/value both lenient-decoded).
fn query_section_size(query: &[u8], max_pairs: usize) -> (usize, bool) {
    let mut size = 4usize;
    let mut capped = false;
    for (count, pair) in query_pairs(query).enumerate() {
        if max_pairs > 0 && count >= max_pairs {
            capped = true;
            break;
        }
        size += 4 + decode_segment_len(pair.name) + 4 + decode_segment_len(pair.value);
    }
    (size, capped)
}

/// Size pass over raw cookie pairs (no URL-decoding).
fn cookie_section_size(cookie: &[u8], max_pairs: usize) -> (usize, bool) {
    let mut size = 4usize;
    let mut capped = false;
    for (count, (name, value)) in cookie_pairs(cookie).enumerate() {
        if max_pairs > 0 && count >= max_pairs {
            capped = true;
            break;
        }
        size += 4 + name.len() + 4 + value.len();
    }
    (size, capped)
}

/// Write a decoded segment as `[u32 len][bytes]` into `out` at `pos`.
#[inline]
fn write_segment(out: &mut [u8], pos: &mut usize, seg: &[u8]) {
    let len = seg.len();
    out[*pos..*pos + 4].copy_from_slice(&(len as u32).to_le_bytes());
    *pos += 4;
    out[*pos..*pos + len].copy_from_slice(seg);
    *pos += len;
}

/// Write the query pair section (lenient-decoded names/values).
fn write_query_section(out: &mut [u8], pos: &mut usize, query: &[u8], max_pairs: usize) {
    let count_pos = *pos;
    write_u32(out, pos, 0); // count placeholder
    let mut count = 0usize;
    for pair in query_pairs(query) {
        if max_pairs > 0 && count >= max_pairs {
            break;
        }
        write_segment(out, pos, &decode_segment_lenient(pair.name));
        write_segment(out, pos, &decode_segment_lenient(pair.value));
        count += 1;
    }
    out[count_pos..count_pos + 4].copy_from_slice(&(count as u32).to_le_bytes());
}

/// Write the cookie pair section (raw trimmed/unquoted names/values).
fn write_cookie_section(out: &mut [u8], pos: &mut usize, cookie: &[u8], max_pairs: usize) {
    let count_pos = *pos;
    write_u32(out, pos, 0); // count placeholder
    let mut count = 0usize;
    for (name, value) in cookie_pairs(cookie) {
        if max_pairs > 0 && count >= max_pairs {
            break;
        }
        write_segment(out, pos, name);
        write_segment(out, pos, value);
        count += 1;
    }
    out[count_pos..count_pos + 4].copy_from_slice(&(count as u32).to_le_bytes());
}

/// Write a u32 LE into `out` at `pos`, advancing `pos`. Caller guarantees
/// capacity (sizes are pre-computed).
#[inline]
fn write_u32(out: &mut [u8], pos: &mut usize, value: u32) {
    out[*pos..*pos + 4].copy_from_slice(&value.to_le_bytes());
    *pos += 4;
}

// ── napi boundary: the `Route` class (Node/fallback transport) ─────
use napi::bindgen_prelude::*;
use napi::{Error, Status};
use napi_derive::napi;

/// A compiled per-route native stack (napi surface). Compile the descriptor
/// once at construction; `run` processes one request frame and returns the
/// packed verdict result bytes written (`0` = error / too-small, `> out.len` =
/// exact required size — the growExact convention).
#[napi]
pub struct Route {
    inner: Arc<NativeRoute>,
}

#[napi]
impl Route {
    #[napi(constructor)]
    pub fn new(descriptor: Uint8Array) -> Result<Self> {
        let inner = NativeRoute::compile(descriptor.as_ref())
            .map_err(|e| Error::new(Status::InvalidArg, format!("route compile error: {e}")))?;
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Run one request frame; returns bytes written (`0` = error / too-small,
    /// `> output.length` = exact required size for a single retry).
    #[napi]
    pub fn run(&self, frame: Uint8Array, mut output: Uint8Array) -> Result<u32> {
        // SAFETY: `output.as_mut()` borrows the caller-provided JS buffer only
        // for this call; the frame is a separate buffer (aliasing is the
        // caller's contract, matching every other napi writer in this crate).
        let out: &mut [u8] = unsafe { output.as_mut() };
        let written = self
            .inner
            .run(frame.as_ref(), out)
            .map_err(|e| Error::from_reason(format!("route run error: {e}")))?;
        Ok(written as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode a plan into a descriptor wire (mirror of encodeRouteDescriptor).
    pub(super) fn descriptor(pipeline: &[u8], schemas: &[(u8, &[u8])]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&ROUTE_DESC_MAGIC.to_le_bytes());
        d.extend_from_slice(&ROUTE_DESC_VERSION.to_le_bytes());
        d.extend_from_slice(&(2 * 1024 * 1024u32).to_le_bytes()); // maxBodyBytes
        d.extend_from_slice(&8192u32.to_le_bytes()); // maxQueryBytes
        d.extend_from_slice(&8192u32.to_le_bytes()); // maxCookieBytes
        d.extend_from_slice(&0u32.to_le_bytes()); // maxPairs
        d.extend_from_slice(&(pipeline.len() as u32).to_le_bytes());
        d.extend_from_slice(pipeline);
        d.extend_from_slice(&(schemas.len() as u32).to_le_bytes());
        for (part, bytes) in schemas {
            d.push(*part);
            d.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            d.extend_from_slice(bytes);
        }
        d
    }

    /// Encode a request frame (mirror of packRouteFrameInto).
    pub(super) fn frame(query: &[u8], cookie: &[u8], body: Option<&[u8]>) -> Vec<u8> {
        let mut f = Vec::new();
        let has_body = body.is_some() && body.map(|b| !b.is_empty()).unwrap_or(false);
        f.extend_from_slice(&(has_body as u32).to_le_bytes());
        f.extend_from_slice(&(query.len() as u32).to_le_bytes());
        f.extend_from_slice(query);
        f.extend_from_slice(&(cookie.len() as u32).to_le_bytes());
        f.extend_from_slice(cookie);
        if has_body {
            let b = body.unwrap_or(&[]);
            f.extend_from_slice(&(b.len() as u32).to_le_bytes());
            f.extend_from_slice(b);
        }
        f
    }

    fn decode_pairs(wire: &[u8], pos: &mut usize) -> Vec<(Vec<u8>, Vec<u8>)> {
        let count = u32::from_le_bytes(wire[*pos..*pos + 4].try_into().unwrap()) as usize;
        *pos += 4;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let nl = u32::from_le_bytes(wire[*pos..*pos + 4].try_into().unwrap()) as usize;
            *pos += 4;
            let name = wire[*pos..*pos + nl].to_vec();
            *pos += nl;
            let vl = u32::from_le_bytes(wire[*pos..*pos + 4].try_into().unwrap()) as usize;
            *pos += 4;
            let value = wire[*pos..*pos + vl].to_vec();
            *pos += vl;
            out.push((name, value));
        }
        out
    }

    #[test]
    fn compile_rejects_bad_magic_and_version() {
        let d = descriptor(&[0], &[]);
        let mut bad = d.clone();
        bad[0] = 0;
        assert!(NativeRoute::compile(&bad).is_err());

        let mut bad_version = d.clone();
        bad_version[4..8].copy_from_slice(&99u32.to_le_bytes());
        assert!(NativeRoute::compile(&bad_version).is_err());
    }

    #[test]
    fn compile_rejects_unknown_stage_and_non_body_schema() {
        let d = descriptor(&[99], &[]);
        assert!(NativeRoute::compile(&d).is_err());
        let d = descriptor(&[STAGE_PARSE_QUERY], &[(1, b"{}")]); // part tag 1 = query
        assert!(NativeRoute::compile(&d).is_err());
    }

    #[test]
    fn parse_query_lenient_matches_js_vectors() {
        // The vectors from scripts/verify-native-route.ts (vs JS queryPairs).
        let r = NativeRoute::compile(&descriptor(&[STAGE_PARSE_QUERY], &[])).unwrap();
        let cases: &[(&[u8], &[&[u8]])] = &[
            (b"a=1&b=hello%20world&c=2", &[b"a", b"b", b"c"]),
            (b"m=%ZZ&n=abc%", &[b"m", b"n"]), // malformed → lenient raw
            (b"u=%E2%9C%93", &[b"u"]),        // UTF-8 ✓
            (b"p=a+b", &[b"p"]),              // + → space
            (b"k=%2B", &[b"k"]),              // %2B → literal +
            (b"k&k2=", &[b"k", b"k2"]),       // empty value
            (b"q=%FF", &[b"q"]),              // invalid UTF-8 → raw
        ];
        for (qs, expected_names) in cases {
            let mut out = vec![0u8; 256];
            let w = r.run(&frame(qs, b"", None), &mut out).unwrap();
            let mut pos = 8;
            let pairs = decode_pairs(&out[..w], &mut pos);
            let names: Vec<Vec<u8>> = pairs.iter().map(|(n, _)| n.clone()).collect();
            assert_eq!(
                names,
                expected_names
                    .iter()
                    .map(|n| n.to_vec())
                    .collect::<Vec<_>>()
            );
            // Spot-check the tricky decodes.
            let vals: Vec<Vec<u8>> = pairs.iter().map(|(_, v)| v.clone()).collect();
            match *qs {
                b"m=%ZZ&n=abc%" => {
                    assert_eq!(vals[0], b"%ZZ");
                    assert_eq!(vals[1], b"abc%");
                }
                b"u=%E2%9C%93" => assert_eq!(vals[0], "✓".as_bytes()),
                b"p=a+b" => assert_eq!(vals[0], b"a b"),
                b"k=%2B" => assert_eq!(vals[0], b"+"),
                b"q=%FF" => assert_eq!(vals[0], b"%FF"),
                _ => {}
            }
        }
    }

    #[test]
    fn parse_cookies_matches_js_vectors() {
        let r = NativeRoute::compile(&descriptor(&[STAGE_PARSE_COOKIES], &[])).unwrap();
        let cases: &[(&[u8], usize)] = &[
            (b"sid=abc; theme=dark", 2),
            (b"a=1; \"quoted\"=val;  spaced = x ", 3),
            (b"empty=; bare", 2),
        ];
        for (cs, expected) in cases {
            let mut out = vec![0u8; 256];
            let w = r.run(&frame(b"", cs, None), &mut out).unwrap();
            let mut pos = 8;
            let pairs = decode_pairs(&out[..w], &mut pos);
            assert_eq!(pairs.len(), *expected);
            // DQUOTE-unwrapped value for the quoted cookie. NOTE: only the VALUE
            // is unquoted (JS `cookiePairsFallback` unquotes `value` but trims
            // `name` as-is — so the NAME keeps its quotes, matching castrum's
            // `cookie_pairs`).
            if cs == b"a=1; \"quoted\"=val;  spaced = x " {
                assert_eq!(pairs[1], (b"\"quoted\"".to_vec(), b"val".to_vec()));
                assert_eq!(pairs[2], (b"spaced".to_vec(), b"x".to_vec()));
            }
        }
    }

    #[test]
    fn mixed_frame_ok_and_flags() {
        let r = NativeRoute::compile(&descriptor(&[STAGE_PARSE_QUERY, STAGE_PARSE_COOKIES], &[]))
            .unwrap();
        let mut out = vec![0u8; 512];
        let w = r.run(&frame(b"a=1&b=2", b"s=v", None), &mut out).unwrap();
        assert!(w <= 512);
        let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
        assert_ne!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_QUERY_VALID, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_COOKIE_VALID, 0);
        let mut pos = 8;
        let q = decode_pairs(&out[..w], &mut pos);
        let c = decode_pairs(&out[..w], &mut pos);
        assert_eq!(
            q,
            vec![
                (b"a".to_vec(), b"1".to_vec()),
                (b"b".to_vec(), b"2".to_vec())
            ]
        );
        assert_eq!(c, vec![(b"s".to_vec(), b"v".to_vec())]);
    }

    #[test]
    fn body_validation_verdicts() {
        let schema = br#"{"type":"object","required":["x"],"properties":{"x":{"type":"number"}}}"#;
        let d = descriptor(
            &[STAGE_REQUIRE_JSON_BODY, STAGE_VALIDATE_BODY],
            &[(PART_BODY, schema)],
        );
        let r = NativeRoute::compile(&d).unwrap();

        let read = |f: Vec<u8>| {
            let mut out = vec![0u8; 512];
            let w = r.run(&f, &mut out).unwrap();
            let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
            let code = u32::from_le_bytes(out[4..8].try_into().unwrap());
            (w, flags, code)
        };

        // valid body → ok + both flags
        let (_, flags, code) = read(frame(b"", b"", Some(br#"{"x":1}"#)));
        assert_eq!(code, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_BODY_VALID_JSON, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_BODY_VALID, 0);

        // non-JSON → 400, ok cleared, no valid flags
        let (_, flags, code) = read(frame(b"", b"", Some(b"not json")));
        assert_eq!(code, 400);
        assert_eq!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_eq!(flags & ROUTE_RESULT_FLAG_BODY_VALID_JSON, 0);
        assert_eq!(flags & ROUTE_RESULT_FLAG_BODY_VALID, 0);

        // JSON but schema-invalid → 422, json valid but body not
        let (_, flags, code) = read(frame(b"", b"", Some(br#"{"x":"str"}"#)));
        assert_eq!(code, 422);
        assert_eq!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_BODY_VALID_JSON, 0);
        assert_eq!(flags & ROUTE_RESULT_FLAG_BODY_VALID, 0);

        // absent body on requireJsonBody → 400
        let (_, flags, code) = read(frame(b"", b"", None));
        assert_eq!(code, 400);
        assert_eq!(flags & ROUTE_RESULT_FLAG_OK, 0);
    }

    #[test]
    fn body_only_route_is_bare_header() {
        let d = descriptor(&[STAGE_REQUIRE_JSON_BODY], &[]);
        let r = NativeRoute::compile(&d).unwrap();
        let mut out = vec![0u8; 64];
        let w = r.run(&frame(b"", b"", Some(b"{}")), &mut out).unwrap();
        assert_eq!(w, 8); // header only — no pair sections
    }

    #[test]
    fn needed_size_convention() {
        let r = NativeRoute::compile(&descriptor(&[STAGE_PARSE_QUERY], &[])).unwrap();
        let f = frame(b"a=1&bb=22&ccc=333", b"", None);
        // A tiny buffer reports the exact required size without writing.
        let mut small = [0u8; 8];
        let required = r.run(&f, &mut small).unwrap();
        assert!(required > 8);
        let mut big = vec![0u8; required];
        let w = r.run(&f, &mut big).unwrap();
        assert_eq!(w, required);
        // The first 8 bytes of the small buffer were untouched (nothing written).
        assert_eq!(&small[..], &[0u8; 8]);
    }

    #[test]
    fn malformed_frame_is_an_error() {
        let r = NativeRoute::compile(&descriptor(&[STAGE_PARSE_QUERY], &[])).unwrap();
        // Frame too short to hold the flags word.
        let mut out = [0u8; 64];
        assert!(r.run(&[1, 2, 3], &mut out).is_err());
        // Truncated query section.
        let mut bad = frame(b"a=1", b"", None);
        bad.truncate(bad.len() - 1);
        assert!(r.run(&bad, &mut out).is_err());
    }
}
