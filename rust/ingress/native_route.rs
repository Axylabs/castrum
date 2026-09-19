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
// `@ignex/native/src/route-wire.ts` (magic `ROUT`, version 4) and the lenient
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
//
// v4 added the optional `response` projection part (tag 5); v5 added the op
// program (tag 7). v6 (this version) changes what a response result IS: the
// native side NO LONGER assembles the framed response. The descriptor still
// carries the status + static headers + body template, but those live for the
// JS-owned compile-time template; Rust reduces each class to the set of dynamic
// substitution SLOTS it references. When a terminal class is selected, the
// result payload after the verdict header is a compact substitution section
// `[subCount u16]{[slot u16][len u32][bytes]}…` INSTEAD of the pair sections,
// and the `ROUTE_RESULT_FLAG_HAS_RESPONSE` bit is set. The selected class tag
// is packed into the flags' high byte (`ROUTE_RESULT_CLASS_SHIFT`). JS splices
// the substitution bytes into its prebuilt `Headers` + pre-encoded body
// segments — nothing else crosses the boundary on the hot path.
//
// Frame: the request-id section (frame flag `HAS_REQUEST_ID`, appended after
// the optional body as `[ridLen u32][rid]`) is the source of the request-id
// slot; the v5 method/ip/packed-headers sections drive the program ops.
//
// v4 → v5 (op PROGRAM): a descriptor may also carry a `program` part (part tag
// 7) that REPLACES the ad-hoc pre-effect parts with an open **op program**: an
// ordered, fixed-width op stream interpreted by a tight loop. An op is
// `(tag, operands, out-slot)` addressed by a stable tag in a versioned registry
// (`PROGRAM_REGISTRY_VERSION`); ops compose in any order/number. Each op's
// result drives the next step through the outcome model `NEXT | JUMP(target) |
// HALT(terminal)` (callouts are rejected at compile — see below), so control
// flow is data, not a fixed stage list. The program's constants (`const` table)
// carry pre-baked response class sets, CORS config, security header lists,
// body schemas, etc.
//
// The op implementations REUSE the ingress cores (`CorsEngine`,
// `KeyedRateLimiter`, `ProxyTrustMode`, `HeaderRefs`, `IngressSchema`,
// `json_valid_bytes`) and the SAME TS header/body builders the JS path uses,
// with `{placeholder}` substitution. Rust makes the DECISION and substitutes;
// it does NOT re-implement header/CORS/security assembly.
//
// `PART_PRE` (tag 6) is GONE — a v5 descriptor carrying it is a hard reject
// (the pre-effect WIP is resolved into THIS one v5 layout; one v5, not two).
// `OP_CALLOUT` (tag 16) is a hard reject at compile: the compiler must fall
// back to JS for routes that need a JS callout rather than run a broken frame.
//
// Frame v5 adds optional method/ip/packed-headers sections (flag-gated,
// appended after the request-id section) so the ops can read HTTP method,
// socket IP, and Origin/ACRM/ACRH/XFF/XFP.

use std::sync::Arc;

use super::packed::{read_section, read_u32_at};
use super::IngressSchema;
use crate::http::headers::HeaderRefs;
use crate::http::method::MethodKind;
use crate::ingress::cors::{CorsEngine, CorsOptions};
use crate::ingress::ip_trust::{resolve_client_ip, ProxyTrustMode};
use crate::ingress::rate_limit::{shared_limiter, KeyedRateLimiter};
use crate::ingress::time::rate_now_ms;
use crate::util::bytes::cookie_pairs;
use crate::util::trim_ascii_whitespace;

// ── Wire constants (MUST match @ignex/native route-wire.ts) ──────
/// Magic that identifies a route descriptor (`"ROUT"` LE).
pub(crate) const ROUTE_DESC_MAGIC: u32 = 0x524f5554;
/// Wire version — bump on ANY layout change (descriptor, frame, or result).
///
/// v6 (native response lane): the native side no longer assembles the response
/// frame. A compiled response template (status + static headers + a body with
/// explicit substitution slots) is owned by JS; the run result carries the
/// verdict + selected class + a compact substitution section only. See the
/// module header.
pub(crate) const ROUTE_DESC_VERSION: u32 = 6;

/// Frame flag: the body section is present (bit 0 of the frame flags word).
pub(crate) const ROUTE_FRAME_FLAG_HAS_BODY: u32 = 1 << 0;
/// Frame flag: the request-id section is present (bit 1). The section is
/// appended after the optional body section: `[ridLen u32][rid]`.
pub(crate) const ROUTE_FRAME_FLAG_HAS_REQUEST_ID: u32 = 1 << 1;
/// Frame flag (v5): a one-byte HTTP method section is present.
pub(crate) const ROUTE_FRAME_FLAG_HAS_METHOD: u32 = 1 << 2;
/// Frame flag (v5): a `[ipLen u32][ip]` section is present (socket peer IP).
pub(crate) const ROUTE_FRAME_FLAG_HAS_IP: u32 = 1 << 3;
/// Frame flag (v5): a `[headersLen u32][packed headers]` section is present
/// (`HeaderRefs` packed layout: `[u16 count] { [u16 nameLen][name][u32 valLen][value] }`).
pub(crate) const ROUTE_FRAME_FLAG_HAS_HEADERS: u32 = 1 << 4;
/// Frame flag (v5): the connection is HTTPS (drives dynamic HSTS).
pub(crate) const ROUTE_FRAME_FLAG_HTTPS: u32 = 1 << 5;

/// Upper bound on the packed request-header count the route stack parses.
const MAX_ROUTE_HEADERS: usize = 128;

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
/// Result flag: the payload is a native response SUBSTITUTION section
/// (`[subCount u16]{[slot u16][len u32][bytes]}…`) rather than query/cookie
/// pair sections. Set only when the descriptor carries a `response`/`program`
/// response AND the pipeline reached a terminal class.
pub(crate) const ROUTE_RESULT_FLAG_HAS_RESPONSE: u32 = 1 << 7;

/// The result flags' high byte carries the selected response class tag
/// (`0..=15`, see `CLASS_*`). The low byte is the verdict flags above.
pub(crate) const ROUTE_RESULT_CLASS_SHIFT: u32 = 8;

// ── Substitution slots (route-wire v6) ──────────────────────────────
// A response template references dynamic values through slot ids. The native
// side emits only the slots the selected class references (plus the frame's
// values), and JS splices them into its compile-time template.
/// Slot: the frame's request id.
const SLOT_REQUEST_ID: u16 = 0;
/// Slot: the allowed CORS origin (echoed into `access-control-allow-origin`).
const SLOT_ORIGIN: u16 = 1;
/// Slot: rate-limit remaining count (decimal).
const SLOT_REMAINING: u16 = 2;
/// Slot: rate-limit reset seconds (decimal).
const SLOT_RESET_SECS: u16 = 3;
/// Slot: retry-after seconds (decimal, rate-limited only).
const SLOT_RETRY_SECS: u16 = 4;
/// Slot: retry-after milliseconds (decimal, rate-limited only).
const SLOT_RETRY_MS: u16 = 5;
/// Number of substitution slots (0..SLOT_COUNT).
const SLOT_COUNT: usize = 6;

/// Bit for a slot id (`1 << slot`), used as a per-class slot mask.
const fn slot_bit(slot: u16) -> u16 {
    1u16 << slot
}

/// Descriptor stage tags (the ordered pipeline a route instance runs).
pub(crate) const STAGE_PARSE_QUERY: u8 = 0;
pub(crate) const STAGE_PARSE_COOKIES: u8 = 1;
pub(crate) const STAGE_VALIDATE_QUERY: u8 = 2;
pub(crate) const STAGE_VALIDATE_COOKIES: u8 = 3;
pub(crate) const STAGE_VALIDATE_BODY: u8 = 4;
pub(crate) const STAGE_REQUIRE_JSON_BODY: u8 = 5;

/// Descriptor part tags (`RoutePartKind`): the schema-bearing request parts.
const PART_BODY: u8 = 3;
/// The native response projection (`[status][headers][body]`). Only the BODY
/// schema and this part are supported; any other part tag fails compilation.
const PART_RESPONSE: u8 = 5;
/// Legacy v5 native PRE-effects plan — REMOVED. A descriptor carrying it is a
/// hard reject (the WIP's v5 was resolved into the op-program layout below).
const PART_PRE_LEGACY: u8 = 6;
/// v5 op PROGRAM (replaces the pre-effect parts). See the module header.
const PART_PROGRAM: u8 = 7;

/// Program IR sub-version (`programVersion`). Bump on any op-encoding change.
pub(crate) const PROGRAM_REGISTRY_VERSION: u8 = 1;

// ── Open op registry (stable tags; NEVER renumber a shipped tag) ────
/// Registry tags. The tag identifies the op's semantics; operands are op-specific
/// small integers (const index, out-slot, literal). The set is EXTENSIBLE: a new
/// native capability adds a tag (and bumps `PROGRAM_REGISTRY_VERSION` only if the
/// fixed-width operand encoding changes).
pub(crate) const OP_PARSE_QUERY: u8 = 1;
pub(crate) const OP_PARSE_COOKIES: u8 = 2;
pub(crate) const OP_LIMITS: u8 = 3;
pub(crate) const OP_IP_TRUST: u8 = 4;
pub(crate) const OP_CORS: u8 = 5;
pub(crate) const OP_RATE_LIMIT: u8 = 6;
pub(crate) const OP_SECURITY_HEADERS: u8 = 7;
pub(crate) const OP_SET_HEADER: u8 = 8;
pub(crate) const OP_JSON_VALID: u8 = 9;
pub(crate) const OP_SCHEMA_VALIDATE: u8 = 10;
pub(crate) const OP_RESPONSE_PROJECTION: u8 = 11;
pub(crate) const OP_HALT: u8 = 12;
pub(crate) const OP_JUMP: u8 = 13;
pub(crate) const OP_BRANCH: u8 = 14;
/// Callout is part of the registry (so the wire is documented) but this executor
/// does NOT implement the resume protocol: a program containing it is a HARD
/// REJECT at compile so the compiler falls back to JS. Never silently skip it.
pub(crate) const OP_CALLOUT: u8 = 15;

/// `OP_SET_HEADER` value source: the value is a constant in the const table.
const SET_VALUE_CONST: u32 = 0;
/// `OP_SET_HEADER` value source: the frame's request id.
const SET_VALUE_REQUEST_ID: u32 = 1;

/// Sentinel `const`-index operand meaning "no constant" (ip trust = none).
const NO_CONST: u32 = u32::MAX;

/// Response class tags (the pre-effect outcomes a `pre` plan can select).
const CLASS_OK_NO_ORIGIN: u8 = 0;
const CLASS_OK_WITH_ORIGIN: u8 = 1;
const CLASS_PREFLIGHT_OK: u8 = 2;
const CLASS_PREFLIGHT_FORBIDDEN: u8 = 3;
const CLASS_RATE_LIMITED: u8 = 4;
const CLASS_INVALID_JSON: u8 = 5;
const CLASS_SCHEMA_FAILED: u8 = 6;
const CLASS_BODY_TOO_LARGE: u8 = 7;
/// Terminal classes 8..15 are the `+ WITH_ORIGIN` variants of classes 0..7
/// (selected when a simple CORS request was allowed, so the error response
/// still carries the CORS headers — matching the baked path).
const CLASS_WITH_ORIGIN_OFFSET: u8 = 8;
/// Number of distinct class slots (0..=15).
const CLASS_SLOTS: usize = 16;

/// Placeholder tokens substituted in class templates. JSON braces that do not
/// start one of these are left literal (so constant JSON bodies are safe).
const PH_REQUEST_ID: &[u8] = b"{requestId}";
const PH_ORIGIN: &[u8] = b"{origin}";
const PH_REMAINING: &[u8] = b"{remaining}";
const PH_RESET_SECS: &[u8] = b"{resetSecs}";
const PH_RETRY_SECS: &[u8] = b"{retryAfterSecs}";
const PH_RETRY_MS: &[u8] = b"{retryAfterMs}";

/// Body-rejected error codes reported in the result header (0 = ok).
const ERR_BODY_NOT_JSON: u32 = 400;
const ERR_BODY_SCHEMA: u32 = 422;

/// A compiled standalone 2xx response template (route-wire v4 `response` part).
/// The native side no longer assembles the response: it records which dynamic
/// substitution slots the template references (so it can emit exactly those)
/// and the run result carries substitutions only. JS owns the template bytes.
#[derive(Debug)]
struct ResponseProjection {
    /// Bitmask of `SLOT_*` ids referenced by the template's headers/body.
    slot_mask: u16,
}

/// A precomputed response class template (program response set): the class'
/// dynamic substitution slots + whether it references the request id. The
/// static headers/body live in the JS-owned compile-time template; Rust only
/// needs to know which slots to emit for the selected class.
struct ClassTemplate {
    /// Bitmask of `SLOT_*` ids referenced by this class' headers/body.
    slot_mask: u16,
    /// Whether any header value or the body references `{requestId}`.
    needs_request_id: bool,
}

/// A pre-parsed response class set (`ResponseSet` const): class templates
/// indexed by tag (0..=15). Built by the SAME TS header/body builders the JS
/// path uses, so the JS-assembled bytes are byte-parity by construction — Rust
/// only decides and substitutes.
struct ResponseSet {
    classes: [Option<ClassTemplate>; CLASS_SLOTS],
}

/// A runtime halt reason. Drives which class template a terminal op emits.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HaltReason {
    Ok,
    PreflightOk,
    PreflightForbidden,
    RateLimited,
    InvalidJson,
    SchemaFailed,
    BodyTooLarge,
}

/// One registered, pre-parsed op. Operands are resolved at COMPILE time into
/// typed data so the interpreter loop never parses config or allocates.
enum Op {
    /// Lenient query parse + cap/size verdict → `out` slot + `query_valid`.
    ParseQuery { out: u32 },
    /// Lenient cookie parse + cap/size verdict → `out` slot + `cookie_valid`.
    ParseCookies { out: u32 },
    /// Body size + parse-size limits verdict → `out` slot; 413 halt on overflow.
    Limits { out: u32, set: usize },
    /// Resolve the client IP (reuses `ip_trust`) → `out` slot.
    IpTrust { out: u32, mode: ProxyTrustMode },
    /// CORS evaluate (reuses `CorsEngine`); halts 204/403 on preflight.
    Cors {
        out: u32,
        engine: CorsEngine,
        set: usize,
    },
    /// Rate limit check (reuses the shared `KeyedRateLimiter`); may halt 429.
    RateLimit {
        out: u32,
        limiter: Arc<KeyedRateLimiter>,
        set: usize,
    },
    /// Accepted + const-validated for wire compatibility. v6 bakes static
    /// security headers into the JS-owned class templates, so this op emits
    /// nothing — kept so a program containing it still compiles.
    SecurityHeaders,
    /// Accepted + const-validated for wire compatibility (v6 emits nothing).
    SetHeader,
    /// Body well-formed-JSON verdict; `require` halts 400 when invalid.
    JsonValid {
        out: u32,
        require: bool,
        set: Option<usize>,
    },
    /// Schema validate (`IngressSchema`) → `out` slot; halts 422/400 on failure.
    SchemaValidate {
        out: u32,
        schema: Option<Arc<IngressSchema>>,
        halt: bool,
        set: Option<usize>,
    },
    /// Emit the OK response from a `ResponseSet` (selects the with-origin
    /// variant when a simple CORS request was allowed) and finish.
    ResponseProjection { set: usize },
    /// Emit a terminal class (`reason`) from a `ResponseSet` and finish.
    Halt { set: usize, reason: HaltReason },
    /// Unconditional forward jump.
    Jump { target: usize },
    /// Conditional forward jump: if `state.slots[slot] != 0`.
    Branch { slot: u32, target: usize },
}

/// A compiled op program (the `program` part). Immutable `&self` at run time.
struct CompiledProgram {
    ops: Vec<Op>,
    /// `ResponseSet` consts, indexed by const index (`None` = other const kind).
    sets: Vec<Option<ResponseSet>>,
    /// True when any op has an external side effect (rate limiting). Gates the
    /// pre-execution output-bound check so a needed-size retry cannot consume a
    /// rate-limit token twice (a bypass).
    has_side_effects: bool,
}

impl CompiledProgram {
    /// An UPPER BOUND on the result size for this request, computed in O(1)
    /// from the frame (no per-request template scan). Returned when the output
    /// buffer is too small, so the needed-size retry never runs a stateful op
    /// (the rate limiter) twice.
    fn output_bound(&self, frame: &RouteFrame<'_>) -> usize {
        let origin_len = frame.headers.origin().map(|o| o.len()).unwrap_or(0);
        let rid_len = if frame.has_request_id {
            frame.request_id.len()
        } else {
            0
        };
        // substitution section: count(2) + up to SLOT_COUNT entries of
        // (slot u16 + len u32 + value). 20 = max decimal width of a u64.
        let response =
            RESULT_HEADER_LEN + 2 + SLOT_COUNT * (2 + 4) + rid_len + origin_len + 4 * 20 + 64; // slack
                                                                                               // A side-effecting program that falls through without a response op
                                                                                               // emits pair sections; bound those conservatively too.
        let pairs =
            RESULT_HEADER_LEN + 4 + 8 * (frame.query.len() + 1) + 8 * (frame.cookie.len() + 1) + 64;
        response.max(pairs)
    }
}

/// Per-request interpreter state ("slab"). Fixed-size: no allocation in the
/// loop. Values that reference frame bytes carry the frame lifetime.
struct ProgState<'a> {
    slots: [u64; 8],
    origin: Option<&'a [u8]>,
    origin_allowed: bool,
    reason: HaltReason,
    remaining: u32,
    reset_secs: u64,
    retry_secs: u64,
    retry_ms: u64,
    resolved_ip: Option<crate::ingress::ip_trust::ResolvedIp<'a>>,
    peer_trusted: bool,
    /// A `rate_limit` op ran, so `remaining`/`reset_secs` (and, on a halt,
    /// `retry_secs`/`retry_ms`) are meaningful substitution values.
    rate_ran: bool,
    error_code: u32,
    body_valid_json: bool,
    body_valid: bool,
    query_valid: bool,
    cookie_valid: bool,
    emit_query: bool,
    emit_cookie: bool,
    /// The `ResponseSet` const selected by the terminal op.
    response_set: Option<usize>,
}

impl ProgState<'_> {
    fn new() -> Self {
        Self {
            slots: [0; 8],
            origin: None,
            origin_allowed: false,
            reason: HaltReason::Ok,
            remaining: 0,
            reset_secs: 0,
            retry_secs: 0,
            retry_ms: 0,
            resolved_ip: None,
            peer_trusted: false,
            rate_ran: false,
            error_code: 0,
            body_valid_json: false,
            body_valid: false,
            query_valid: false,
            cookie_valid: false,
            emit_query: false,
            emit_cookie: false,
            response_set: None,
        }
    }
}

/// Whether `haystack` contains `needle` (small fixed needles only).
#[inline]
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// An immutable view of one request frame, borrowed for the whole program run.
struct RouteFrame<'a> {
    mk: MethodKind,
    query: &'a [u8],
    cookie: &'a [u8],
    body: &'a [u8],
    request_id: &'a [u8],
    has_request_id: bool,
    ip: &'a [u8],
    headers: &'a HeaderRefs<'a>,
    #[allow(dead_code)]
    https: bool,
}

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
    /// Optional native response projection (route-wire v4). When present and the
    /// pipeline is OK, `run` emits the framed response instead of pair sections.
    response: Option<ResponseProjection>,
    /// Optional native op program (route-wire v5). When present, `run` executes
    /// the program (which owns order + control flow) instead of the pair path.
    program: Option<CompiledProgram>,
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
        let mut response: Option<ResponseProjection> = None;
        let mut program: Option<CompiledProgram> = None;
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
                PART_BODY => {
                    if body_schema_bytes.is_some() {
                        return Err("route descriptor: duplicate body schema part".to_string());
                    }
                    body_schema_bytes = Some(bytes.to_vec());
                }
                PART_RESPONSE => {
                    if response.is_some() {
                        return Err("route descriptor: duplicate response part".to_string());
                    }
                    response = Some(parse_response(bytes)?);
                }
                PART_PRE_LEGACY => {
                    // The ad-hoc pre-effect part was resolved into the op
                    // program. A stale v5 descriptor carrying it must be a hard
                    // reject (never a silent misparse).
                    return Err(
                        "route descriptor: legacy `pre` part (tag 6) is gone — use the op program (tag 7)"
                            .to_string(),
                    );
                }
                PART_PROGRAM => {
                    if program.is_some() {
                        return Err("route descriptor: duplicate program part".to_string());
                    }
                    program = Some(parse_program(bytes)?);
                }
                other => {
                    // This stack validates the BODY only and builds a RESPONSE
                    // projection. A schema for any other part (params/query/
                    // cookie/headers) is unsupported → fail compilation so the
                    // caller falls back to JS (byte-parity preserved by design).
                    // validateQuery / validateCookies WITHOUT a schema are a
                    // no-op (the parse VALID bit is the verdict), so they never
                    // reach this check.
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
                // Shared process-wide: identical schema bytes compile once even
                // across routes/instances (see ingress/schema_cache.rs).
                let compiled = super::schema_cache::get_or_compile(&schema_value)
                    .map_err(|e| format!("route descriptor: body schema compile error: {e}"))?;
                Some(compiled)
            }
            None => None,
        };

        // A `program` part owns validation/order entirely; compile-time
        // validation lives in `parse_program` (unknown tag / bad version /
        // callout / non-forward jump are all hard rejects).
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
            response,
            program,
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
        let has_request_id = (flags as u32) & ROUTE_FRAME_FLAG_HAS_REQUEST_ID != 0;
        let has_method = (flags as u32) & ROUTE_FRAME_FLAG_HAS_METHOD != 0;
        let has_ip = (flags as u32) & ROUTE_FRAME_FLAG_HAS_IP != 0;
        let has_headers = (flags as u32) & ROUTE_FRAME_FLAG_HAS_HEADERS != 0;
        let frame_https = (flags as u32) & ROUTE_FRAME_FLAG_HTTPS != 0;
        let query = read_section(frame, &mut pos, usize::MAX)?;
        let cookie = read_section(frame, &mut pos, usize::MAX)?;
        let body: &[u8] = if has_body {
            read_section(frame, &mut pos, usize::MAX)?
        } else {
            &[]
        };
        // The request-id section is appended AFTER the optional body section
        // (it is only read when the frame advertises it).
        let request_id: &[u8] = if has_request_id {
            read_section(frame, &mut pos, usize::MAX)?
        } else {
            &[]
        };
        // v5 optional pre-effect inputs, in a FIXED order after the request-id:
        // `[method u8]?[ip]?[packed headers]?`.
        let mk = if has_method {
            let byte = *frame
                .get(pos)
                .ok_or_else(|| "route frame: truncated method byte".to_string())?;
            pos += 1;
            MethodKind::from_u8(byte)
        } else {
            MethodKind::Get
        };
        let ip: &[u8] = if has_ip {
            read_section(frame, &mut pos, usize::MAX)?
        } else {
            &[]
        };
        let headers_packed: &[u8] = if has_headers {
            read_section(frame, &mut pos, usize::MAX)?
        } else {
            &[]
        };
        let headers =
            HeaderRefs::parse(headers_packed, mk == MethodKind::Options, MAX_ROUTE_HEADERS)
                .map_err(|e| format!("route frame: malformed packed headers: {e}"))?;

        // ── v5 op PROGRAM ───────────────────────────────────────────
        // When the descriptor carries a program, it owns order, validation and
        // control flow (the stage list is vestigial). Build the frame view and
        // execute it in ONE native call.
        if let Some(program) = self.program.as_ref() {
            let rf = RouteFrame {
                mk,
                query,
                cookie,
                body,
                request_id,
                has_request_id,
                ip,
                headers: &headers,
                https: frame_https,
            };
            return self.run_program(program, &rf, out);
        }

        // ── Body verdicts (first-failure-wins, in stage order) ──────
        let mut error_code: u32 = 0;
        let mut body_valid_json = false;
        let mut body_valid = false;
        if self.require_json_body || self.validate_body {
            if !has_body || body.len() > self.max_body_bytes {
                body_valid_json = false;
                // Inside `require_json_body || validate_body`: an absent or
                // oversized body can never satisfy either constraint, so fail
                // closed. (Pre-fix a validateBody-only route returned OK with
                // error_code 0 and skipped schema validation entirely.)
                error_code = ERR_BODY_NOT_JSON;
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

        // ── Assemble the result in ONE streaming pass ───────────────
        // Pair sections are decoded + written as they are walked. The old
        // shape sized them first and walked again, which decoded every escaped
        // segment TWICE and allocated twice per segment in BOTH passes.
        // The reused `scratch` holds the decoded bytes of one segment at a time.
        //
        // v4 response mode: when the descriptor carries a response projection
        // and the pipeline is OK, the payload is the framed HTTP response
        // INSTEAD of the pair sections. Any non-OK verdict keeps the v3 result
        // shape (verdict header + pair sections) so the caller can reject.
        let response_mode = self.response.is_some() && error_code == 0;
        let mut scratch: Vec<u8> = Vec::new();
        let mut w = ResultWriter::new(out, RESULT_HEADER_LEN);
        let mut query_capped = false;
        let mut cookie_capped = false;
        let mut result_flags: u32 = 0;

        if response_mode {
            let proj = self
                .response
                .as_ref()
                .expect("response_mode implies a projection");
            // A template placeholder needs the caller-supplied request id. Fail
            // BEFORE writing anything so `out` stays untouched on error.
            let needs_rid = proj.slot_mask & slot_bit(SLOT_REQUEST_ID) != 0;
            if needs_rid && !has_request_id {
                return Err("route frame: response template needs a request-id section".to_string());
            }
            // v6: substitutions only — the standalone projection has no
            // CORS/rate ops, so the request id is the only available slot.
            let emit_rid = needs_rid && has_request_id;
            w.u16(emit_rid as u16);
            if emit_rid {
                w.u16(SLOT_REQUEST_ID);
                w.u32(request_id.len() as u32);
                w.bytes(request_id);
            }
            result_flags |= ROUTE_RESULT_FLAG_HAS_RESPONSE;
        } else {
            if self.parse_query {
                query_capped = write_query_section(&mut w, &mut scratch, query, self.max_pairs);
            }
            if self.parse_cookies {
                cookie_capped = write_cookie_section(&mut w, cookie, self.max_pairs);
            }
        }

        // validateQuery/validateCookies without a schema are no-ops (the parse
        // VALID bit is the verdict); with a schema, compile would have rejected
        // the descriptor → the caller fell back to JS. A section that is not
        // parsed never reports VALID. In response mode the pair sections are not
        // emitted, so the counts come from a cheap walk (same cap semantics).
        if response_mode {
            query_capped = self.parse_query && query_pairs_capped(query, self.max_pairs);
            cookie_capped = self.parse_cookies && cookie_pairs_capped(cookie, self.max_pairs);
        }
        let query_valid = self.parse_query && !query_capped && query.len() <= self.max_query_bytes;
        let cookie_valid =
            self.parse_cookies && !cookie_capped && cookie.len() <= self.max_cookie_bytes;

        // ── Verdict flags + header (committed LAST) ─────────────────
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
        let mut header = [0u8; RESULT_HEADER_LEN];
        header[..4].copy_from_slice(&result_flags.to_le_bytes());
        header[4..].copy_from_slice(&error_code.to_le_bytes());
        Ok(w.commit(header))
    }

    /// Execute the compiled op program for one request frame.
    ///
    /// The program owns order + control flow: ops run sequentially, a decision
    /// op may `HALT` (selecting a terminal class from its `ResponseSet`), and
    /// `JUMP`/`BRANCH` are forward-only so execution terminates in at most
    /// `ops.len()` steps. Nothing is allocated in the loop: operands/config are
    /// pre-parsed at compile time and the per-request state is a fixed slab.
    fn run_program(
        &self,
        prog: &CompiledProgram,
        frame: &RouteFrame<'_>,
        out: &mut [u8],
    ) -> std::result::Result<usize, String> {
        // Side-effect-free sizing: a program containing a rate-limit op must
        // report a conservative bound BEFORE the limiter runs, so a needed-size
        // retry cannot consume a token twice (a rate-limit bypass). The bound is
        // an upper bound; the writer still reports the exact size on success.
        if prog.has_side_effects {
            let bound = prog.output_bound(frame);
            if out.len() < bound {
                return Ok(bound);
            }
        }

        let mut st = ProgState::new();
        let mut pc = 0usize;
        while pc < prog.ops.len() {
            match &prog.ops[pc] {
                Op::ParseQuery { out: slot } => {
                    let capped = query_pairs_capped(frame.query, self.max_pairs);
                    st.query_valid = !capped && frame.query.len() <= self.max_query_bytes;
                    st.emit_query = true;
                    st.slots[slot_index(*slot, st.slots.len())] = st.query_valid as u64;
                    pc += 1;
                }
                Op::ParseCookies { out: slot } => {
                    let capped = cookie_pairs_capped(frame.cookie, self.max_pairs);
                    st.cookie_valid = !capped && frame.cookie.len() <= self.max_cookie_bytes;
                    st.emit_cookie = true;
                    st.slots[slot_index(*slot, st.slots.len())] = st.cookie_valid as u64;
                    pc += 1;
                }
                Op::Limits { out: slot, set } => {
                    if frame.body.len() > self.max_body_bytes {
                        st.reason = HaltReason::BodyTooLarge;
                        st.response_set = Some(*set);
                        break;
                    }
                    if frame.query.len() > self.max_query_bytes {
                        st.query_valid = false;
                    }
                    if frame.cookie.len() > self.max_cookie_bytes {
                        st.cookie_valid = false;
                    }
                    st.slots[slot_index(*slot, st.slots.len())] = 1;
                    pc += 1;
                }
                Op::IpTrust { out: slot, mode } => {
                    let (resolved, trusted) = resolve_client_ip(
                        mode,
                        frame.ip,
                        frame.headers.xff(),
                        frame.headers.x_real_ip(),
                    );
                    st.resolved_ip = Some(resolved);
                    st.peer_trusted = trusted;
                    st.slots[slot_index(*slot, st.slots.len())] = 1;
                    pc += 1;
                }
                Op::Cors {
                    out: slot,
                    engine,
                    set,
                } => {
                    if let Some(origin) = frame.headers.origin() {
                        let eval = engine.evaluate(frame.mk, frame.headers);
                        if eval.preflight {
                            // A preflight terminates 204 / 403 (it never
                            // reaches the response projection).
                            st.reason = if eval.allowed {
                                HaltReason::PreflightOk
                            } else {
                                HaltReason::PreflightForbidden
                            };
                            st.response_set = Some(*set);
                            break;
                        } else if eval.allowed {
                            st.origin = Some(origin);
                            st.origin_allowed = true;
                        }
                    }
                    st.slots[slot_index(*slot, st.slots.len())] = st.origin_allowed as u64;
                    pc += 1;
                }
                Op::RateLimit {
                    out: slot,
                    limiter,
                    set,
                } => {
                    let now = rate_now_ms();
                    let key = match st.resolved_ip.as_ref() {
                        Some(ip) => ip.rate_key(limiter.seed()),
                        None => crate::ingress::ip_trust::ResolvedIp::Raw(trim_ascii_whitespace(
                            frame.ip,
                        ))
                        .rate_key(limiter.seed()),
                    };
                    let outcome = limiter.check_key(key, now);
                    st.rate_ran = true;
                    st.remaining = outcome.remaining;
                    st.reset_secs = rate_secs(outcome.reset_ms);
                    if !outcome.allowed {
                        st.retry_ms = outcome.reset_ms.saturating_sub(now);
                        st.retry_secs = rate_secs(st.retry_ms);
                        st.reason = HaltReason::RateLimited;
                        st.response_set = Some(*set);
                        break;
                    }
                    st.slots[slot_index(*slot, st.slots.len())] = 1;
                    pc += 1;
                }
                // v6: security headers are baked into the JS-owned class
                // templates by the program builder, and `set_header` is not
                // emitted by it. Both ops stay accepted by the executor (they
                // are validated + const-checked at compile) but no longer
                // contribute to the output — the native side returns
                // substitutions only.
                Op::SecurityHeaders | Op::SetHeader => {
                    pc += 1;
                }
                Op::JsonValid {
                    out: slot,
                    require,
                    set,
                } => {
                    let valid = !frame.body.is_empty()
                        && frame.body.len() <= self.max_body_bytes
                        && crate::json::json_ops::json_valid_bytes(frame.body);
                    st.body_valid_json = valid;
                    st.slots[slot_index(*slot, st.slots.len())] = valid as u64;
                    if *require && !valid {
                        st.reason = HaltReason::InvalidJson;
                        if let Some(s) = set {
                            st.response_set = Some(*s);
                            break;
                        }
                    }
                    pc += 1;
                }
                Op::SchemaValidate {
                    out: slot,
                    schema,
                    halt,
                    set,
                } => {
                    let valid = if !st.body_valid_json {
                        false
                    } else {
                        match schema {
                            Some(s) => s.validate(frame.body),
                            None => true,
                        }
                    };
                    st.body_valid = valid;
                    st.slots[slot_index(*slot, st.slots.len())] = valid as u64;
                    if *halt && !valid {
                        // A well-formed body failing its schema is 422; a
                        // non-JSON body (defensive) is 400.
                        st.reason = if st.body_valid_json {
                            HaltReason::SchemaFailed
                        } else {
                            HaltReason::InvalidJson
                        };
                        if let Some(s) = set {
                            st.response_set = Some(*s);
                            break;
                        }
                    }
                    pc += 1;
                }
                Op::ResponseProjection { set } => {
                    st.reason = HaltReason::Ok;
                    st.response_set = Some(*set);
                    break;
                }
                Op::Halt { set, reason } => {
                    st.reason = *reason;
                    st.response_set = Some(*set);
                    break;
                }
                Op::Jump { target } => {
                    pc = *target;
                }
                Op::Branch { slot, target } => {
                    pc = if st.slots[slot_index(*slot, st.slots.len())] != 0 {
                        *target
                    } else {
                        pc + 1
                    };
                }
            }
        }

        match st.response_set {
            Some(set_idx) => self.emit_program_response(set_idx, &st, frame, out),
            None => self.emit_program_verdict(&st, frame, out),
        }
    }

    /// Emit the v6 substitution result selected by the program state: the
    /// verdict header (with the class tag packed into the flags' high byte)
    /// followed by `[subCount u16]{[slot u16][len u32][bytes]}…`. The static
    /// headers/body live in the JS-owned compile-time template — the native
    /// side emits only the dynamic values the selected class references.
    fn emit_program_response(
        &self,
        set_idx: usize,
        st: &ProgState<'_>,
        frame: &RouteFrame<'_>,
        out: &mut [u8],
    ) -> std::result::Result<usize, String> {
        let set = self
            .program
            .as_ref()
            .and_then(|prog| prog.sets.get(set_idx))
            .and_then(|s| s.as_ref())
            .ok_or_else(|| format!("route program: response set {set_idx} is not compiled"))?;
        let tag = select_class_tag(st.reason, st.origin_allowed, set);
        let tmpl = set.classes[tag as usize]
            .as_ref()
            .ok_or_else(|| format!("route program: class {tag} is not compiled"))?;
        if tmpl.needs_request_id && !frame.has_request_id {
            return Err(
                "route frame: program response template needs a request-id section".to_string(),
            );
        }

        let mask = tmpl.slot_mask;
        // The count must precede the entries; slots are a fixed 0..SLOT_COUNT
        // set, so this is a cheap bounded walk (no allocation).
        let mut count = 0u16;
        for slot in 0..SLOT_COUNT as u16 {
            if mask & slot_bit(slot) != 0 && slot_value(slot, st, frame).is_some() {
                count += 1;
            }
        }

        let mut w = ResultWriter::new(out, RESULT_HEADER_LEN);
        w.u16(count);
        if count > 0 {
            for slot in 0..SLOT_COUNT as u16 {
                if mask & slot_bit(slot) == 0 {
                    continue;
                }
                match slot_value(slot, st, frame) {
                    Some(SlotVal::Bytes(bytes)) => {
                        w.u16(slot);
                        w.u32(bytes.len() as u32);
                        w.bytes(bytes);
                    }
                    Some(SlotVal::Num(value)) => {
                        w.u16(slot);
                        w.u32(dec_len(value) as u32);
                        w.num(value);
                    }
                    None => {}
                }
            }
        }

        let code = reason_code(st.reason);
        let mut flags = ROUTE_RESULT_FLAG_HAS_RESPONSE | ((tag as u32) << ROUTE_RESULT_CLASS_SHIFT);
        if code == 0 {
            flags |= ROUTE_RESULT_FLAG_OK;
        }
        if st.body_valid_json {
            flags |= ROUTE_RESULT_FLAG_BODY_VALID_JSON;
        }
        if st.body_valid {
            flags |= ROUTE_RESULT_FLAG_BODY_VALID;
        }
        if st.query_valid {
            flags |= ROUTE_RESULT_FLAG_QUERY_VALID;
        }
        if st.cookie_valid {
            flags |= ROUTE_RESULT_FLAG_COOKIE_VALID;
        }
        let mut header = [0u8; RESULT_HEADER_LEN];
        header[..4].copy_from_slice(&flags.to_le_bytes());
        header[4..].copy_from_slice(&code.to_le_bytes());
        Ok(w.commit(header))
    }

    /// Emit a pair-section verdict result (a program that fell through without a
    /// terminal response op). Mirrors the non-program pair path.
    fn emit_program_verdict(
        &self,
        st: &ProgState<'_>,
        frame: &RouteFrame<'_>,
        out: &mut [u8],
    ) -> std::result::Result<usize, String> {
        let mut w = ResultWriter::new(out, RESULT_HEADER_LEN);
        let mut scratch: Vec<u8> = Vec::new();
        let mut query_capped = false;
        let mut cookie_capped = false;
        if st.emit_query {
            query_capped = write_query_section(&mut w, &mut scratch, frame.query, self.max_pairs);
        }
        if st.emit_cookie {
            cookie_capped = write_cookie_section(&mut w, frame.cookie, self.max_pairs);
        }
        let query_valid =
            st.emit_query && !query_capped && frame.query.len() <= self.max_query_bytes;
        let cookie_valid =
            st.emit_cookie && !cookie_capped && frame.cookie.len() <= self.max_cookie_bytes;
        let mut flags = 0u32;
        if st.error_code == 0 {
            flags |= ROUTE_RESULT_FLAG_OK;
        }
        if st.body_valid_json {
            flags |= ROUTE_RESULT_FLAG_BODY_VALID_JSON;
        }
        if st.body_valid {
            flags |= ROUTE_RESULT_FLAG_BODY_VALID;
        }
        if query_valid {
            flags |= ROUTE_RESULT_FLAG_QUERY_VALID;
        }
        if cookie_valid {
            flags |= ROUTE_RESULT_FLAG_COOKIE_VALID;
        }
        let mut header = [0u8; RESULT_HEADER_LEN];
        header[..4].copy_from_slice(&flags.to_le_bytes());
        header[4..].copy_from_slice(&st.error_code.to_le_bytes());
        Ok(w.commit(header))
    }
}

// ── Response substitution slots (route-wire v6) ─────────────────────

/// A known placeholder token.
enum Ph {
    Rid,
    Origin,
    Remaining,
    ResetSecs,
    RetrySecs,
    RetryMs,
}

/// A runtime substitution value for one slot.
enum SlotVal<'a> {
    /// Borrowed bytes (request id / origin).
    Bytes(&'a [u8]),
    /// A decimal numeric value (rate counters).
    Num(u64),
}

/// Ceil milliseconds → whole seconds (matches the TS `secondsFromMs`).
#[inline]
fn rate_secs(ms: u64) -> u64 {
    ms.saturating_add(999) / 1000
}

/// Decimal digit count (for the substitution length prefix).
#[inline]
fn dec_len(mut v: u64) -> usize {
    if v == 0 {
        return 1;
    }
    let mut n = 0;
    while v > 0 {
        v /= 10;
        n += 1;
    }
    n
}

/// Match a known placeholder at `at` (which must point at `{`). Returns the
/// placeholder and its consumed token length. Unknown `{…}` sequences return
/// `None` (treated as literal bytes by the JS-owned template).
#[inline]
fn match_placeholder(bytes: &[u8], at: usize) -> Option<(Ph, usize)> {
    let rest = bytes.get(at..)?;
    let table: [(&[u8], Ph); 6] = [
        (PH_REQUEST_ID, Ph::Rid),
        (PH_ORIGIN, Ph::Origin),
        (PH_REMAINING, Ph::Remaining),
        (PH_RESET_SECS, Ph::ResetSecs),
        (PH_RETRY_SECS, Ph::RetrySecs),
        (PH_RETRY_MS, Ph::RetryMs),
    ];
    for (token, ph) in table {
        if rest.starts_with(token) {
            return Some((ph, token.len()));
        }
    }
    None
}

/// The slot bit for a placeholder kind.
#[inline]
fn ph_slot_bit(ph: &Ph) -> u16 {
    match ph {
        Ph::Rid => slot_bit(SLOT_REQUEST_ID),
        Ph::Origin => slot_bit(SLOT_ORIGIN),
        Ph::Remaining => slot_bit(SLOT_REMAINING),
        Ph::ResetSecs => slot_bit(SLOT_RESET_SECS),
        Ph::RetrySecs => slot_bit(SLOT_RETRY_SECS),
        Ph::RetryMs => slot_bit(SLOT_RETRY_MS),
    }
}

/// OR the slot bit for every known placeholder in `bytes` into `mask`.
fn collect_slots(bytes: &[u8], mask: &mut u16) {
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some((ph, token_len)) = match_placeholder(bytes, i) {
                *mask |= ph_slot_bit(&ph);
                i += token_len;
                continue;
            }
        }
        i += 1;
    }
}

/// Whether `bytes` references the request id placeholder.
#[inline]
fn references_request_id(bytes: &[u8]) -> bool {
    contains(bytes, PH_REQUEST_ID)
}

/// The runtime value for a substitution slot, or `None` when it is not
/// available for this request (so the emitted slot count is exact).
#[inline]
fn slot_value<'a>(slot: u16, st: &ProgState<'a>, frame: &RouteFrame<'a>) -> Option<SlotVal<'a>> {
    match slot {
        SLOT_REQUEST_ID => {
            if frame.has_request_id {
                Some(SlotVal::Bytes(frame.request_id))
            } else {
                None
            }
        }
        SLOT_ORIGIN => st.origin.map(SlotVal::Bytes),
        SLOT_REMAINING if st.rate_ran => Some(SlotVal::Num(st.remaining as u64)),
        SLOT_RESET_SECS if st.rate_ran => Some(SlotVal::Num(st.reset_secs)),
        SLOT_RETRY_SECS if st.rate_ran && matches!(st.reason, HaltReason::RateLimited) => {
            Some(SlotVal::Num(st.retry_secs))
        }
        SLOT_RETRY_MS if st.rate_ran && matches!(st.reason, HaltReason::RateLimited) => {
            Some(SlotVal::Num(st.retry_ms))
        }
        _ => None,
    }
}

/// Read a u8le, advancing `pos` (bounds-checked).
#[inline]
fn read_u8_at(input: &[u8], pos: &mut usize) -> std::result::Result<u8, String> {
    let b = *input
        .get(*pos)
        .ok_or_else(|| "route descriptor: truncated u8".to_string())?;
    *pos += 1;
    Ok(b)
}

/// Read a `[count u32]{[len u32][utf8]}` string list (bounds + allocation
/// guarded).
fn read_string_list(input: &[u8], pos: &mut usize) -> std::result::Result<Vec<String>, String> {
    let count = read_u32_at(input, pos)?;
    // Each entry needs at least a 4-byte length prefix.
    if count > input.len() / 4 + 1 {
        return Err("route descriptor: string list count exceeds descriptor size".to_string());
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let s = read_section(input, pos, usize::MAX)?;
        let s = std::str::from_utf8(s)
            .map_err(|_| "route descriptor: config string is not valid UTF-8".to_string())?;
        out.push(s.to_string());
    }
    Ok(out)
}

/// Parse one class template payload (`[status][headers][body]`) and reduce it
/// to the dynamic substitution slots it references. The static headers/body
/// stay in the JS-owned compile-time template; Rust only needs the slot mask.
fn parse_class_template(bytes: &[u8]) -> std::result::Result<ClassTemplate, String> {
    let mut pos = 0usize;
    let status = read_u16_at(bytes, &mut pos)?;
    if !(100..=599).contains(&status) {
        return Err(format!(
            "route descriptor: class status {status} out of range"
        ));
    }
    let header_count = read_u32_at(bytes, &mut pos)?;
    if header_count > bytes.len() / 8 + 1 {
        return Err("route descriptor: class header count exceeds descriptor size".to_string());
    }
    let mut slot_mask = 0u16;
    let mut needs_request_id = false;
    for _ in 0..header_count {
        // Names are never substituted; values may reference slots.
        let _name = read_section(bytes, &mut pos, usize::MAX)?;
        let value = read_section(bytes, &mut pos, usize::MAX)?;
        collect_slots(value, &mut slot_mask);
        needs_request_id |= references_request_id(value);
    }
    let body = read_section(bytes, &mut pos, usize::MAX)?;
    collect_slots(body, &mut slot_mask);
    needs_request_id |= references_request_id(body);
    Ok(ClassTemplate {
        slot_mask,
        needs_request_id,
    })
}

/// Parse the v5 `pre` part: `[flags u32][classCount u32]{[tag u8][len u32]
/// [class payload]}…` followed by the CORS / rate / IP-trust evaluation config
/// (each gated by its flag). Reuses the ingress cores for evaluation.
/// The stable registry name for an op tag (`None` = unknown → hard reject).
/// Kept public(crate) so tests can pin the registry surface.
#[allow(dead_code)]
pub(crate) fn op_name(tag: u8) -> Option<&'static str> {
    Some(match tag {
        OP_PARSE_QUERY => "parse_query",
        OP_PARSE_COOKIES => "parse_cookies",
        OP_LIMITS => "limits",
        OP_IP_TRUST => "ip_trust",
        OP_CORS => "cors",
        OP_RATE_LIMIT => "rate_limit",
        OP_SECURITY_HEADERS => "security_headers",
        OP_SET_HEADER => "set_header",
        OP_JSON_VALID => "json_valid",
        OP_SCHEMA_VALIDATE => "schema_validate",
        OP_RESPONSE_PROJECTION => "response_projection",
        OP_HALT => "halt",
        OP_JUMP => "jump",
        OP_BRANCH => "branch",
        OP_CALLOUT => "callout",
        _ => return None,
    })
}

/// Clamp a slot operand into the fixed state slab (a malformed slot cannot
/// index out of bounds; it aliases slot 0).
#[inline]
fn slot_index(slot: u32, len: usize) -> usize {
    (slot as usize).min(len - 1)
}

/// Map a `HALT` reason operand to its `HaltReason`.
fn reason_from_u32(value: u32) -> std::result::Result<HaltReason, String> {
    Ok(match value {
        0 => HaltReason::Ok,
        1 => HaltReason::PreflightOk,
        2 => HaltReason::PreflightForbidden,
        3 => HaltReason::RateLimited,
        4 => HaltReason::InvalidJson,
        5 => HaltReason::SchemaFailed,
        6 => HaltReason::BodyTooLarge,
        other => return Err(format!("route program: unknown halt reason {other}")),
    })
}

/// The HTTP/verdict code for a halt reason (`0` = OK/preflight-ok).
#[inline]
fn reason_code(reason: HaltReason) -> u32 {
    match reason {
        HaltReason::Ok | HaltReason::PreflightOk => 0,
        HaltReason::PreflightForbidden => 403,
        HaltReason::RateLimited => 429,
        HaltReason::InvalidJson => 400,
        HaltReason::SchemaFailed => 422,
        HaltReason::BodyTooLarge => 413,
    }
}

/// Pick the class tag a terminal op emits: the base class for `reason`, with
/// the `+ WITH_ORIGIN` error variant preferred when a simple CORS request was
/// allowed and that variant is compiled (matching the baked JS path).
fn select_class_tag(reason: HaltReason, origin_allowed: bool, set: &ResponseSet) -> u8 {
    let base = match reason {
        HaltReason::Ok => {
            if origin_allowed {
                CLASS_OK_WITH_ORIGIN
            } else {
                CLASS_OK_NO_ORIGIN
            }
        }
        HaltReason::PreflightOk => CLASS_PREFLIGHT_OK,
        HaltReason::PreflightForbidden => CLASS_PREFLIGHT_FORBIDDEN,
        HaltReason::RateLimited => CLASS_RATE_LIMITED,
        HaltReason::InvalidJson => CLASS_INVALID_JSON,
        HaltReason::SchemaFailed => CLASS_SCHEMA_FAILED,
        HaltReason::BodyTooLarge => CLASS_BODY_TOO_LARGE,
    };
    if origin_allowed
        && matches!(
            reason,
            HaltReason::RateLimited
                | HaltReason::InvalidJson
                | HaltReason::SchemaFailed
                | HaltReason::BodyTooLarge
        )
    {
        let alt = base.saturating_add(CLASS_WITH_ORIGIN_OFFSET);
        if set.classes[alt as usize].is_some() {
            return alt;
        }
    }
    base
}

/// Resolve a const-table index (`what` names the op for error messages).
fn const_at<'a>(
    consts: &[&'a [u8]],
    idx: u32,
    what: &str,
) -> std::result::Result<&'a [u8], String> {
    consts
        .get(idx as usize)
        .copied()
        .ok_or_else(|| format!("route program: {what} const index {idx} out of range"))
}

/// Parse a `[credentials u8][list][list][list]` CORS config const.
fn parse_cors_config(bytes: &[u8]) -> std::result::Result<CorsEngine, String> {
    let mut pos = 0usize;
    let credentials = read_u8_at(bytes, &mut pos)? != 0;
    let origins = read_string_list(bytes, &mut pos)?;
    let methods = read_string_list(bytes, &mut pos)?;
    let headers = read_string_list(bytes, &mut pos)?;
    let opts = CorsOptions {
        allow_origin: Some(origins),
        allow_methods: Some(methods),
        allow_headers: Some(headers),
        allow_credentials: Some(credentials),
    };
    CorsEngine::from_options(Some(opts)).map_err(|e| format!("route program: cors config: {e}"))
}

/// Parse a `[limit u32][windowMs u32][maxEntries u32]` rate-limit config const.
fn parse_rate_config(bytes: &[u8]) -> std::result::Result<(u32, u32, u32), String> {
    let mut pos = 0usize;
    let limit = read_u32_at(bytes, &mut pos)? as u32;
    let window = read_u32_at(bytes, &mut pos)? as u32;
    let max = read_u32_at(bytes, &mut pos)? as u32;
    Ok((limit, window, max))
}

/// Parse a `[mode u8]([networks list])` IP-trust config const.
/// mode: 0 = trust nothing, 1 = trust every hop, 2 = network list.
fn parse_ip_trust_config(bytes: &[u8]) -> std::result::Result<ProxyTrustMode, String> {
    let mut pos = 0usize;
    let mode = read_u8_at(bytes, &mut pos)?;
    match mode {
        0 => Ok(ProxyTrustMode::None),
        1 => Ok(ProxyTrustMode::All),
        2 => {
            let nets = read_string_list(bytes, &mut pos)?;
            ProxyTrustMode::from_config(true, Some(nets))
                .map_err(|e| format!("route program: ip trust config: {e}"))
        }
        other => Err(format!("route program: unknown ip trust mode {other}")),
    }
}

/// Parse a `[count u32]{[nameLen][name][valueLen][value]}` header-list const.
#[allow(clippy::type_complexity)]
fn parse_header_list(bytes: &[u8]) -> std::result::Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
    let mut pos = 0usize;
    let count = read_u32_at(bytes, &mut pos)?;
    if count > bytes.len() / 8 + 1 {
        return Err("route program: header list count exceeds const size".to_string());
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let name = read_section(bytes, &mut pos, usize::MAX)?.to_vec();
        let value = read_section(bytes, &mut pos, usize::MAX)?.to_vec();
        out.push((name, value));
    }
    Ok(out)
}

/// Parse a `ResponseSet` const: `[classCount u32]{[tag u8][len u32][class
/// payload]}…`. Reuses the v4 class-template layout.
fn build_response_set(bytes: &[u8]) -> std::result::Result<ResponseSet, String> {
    let mut pos = 0usize;
    let class_count = read_u32_at(bytes, &mut pos)?;
    if class_count > CLASS_SLOTS {
        return Err(format!(
            "route program: response set class count exceeds {CLASS_SLOTS}"
        ));
    }
    let mut classes: [Option<ClassTemplate>; CLASS_SLOTS] = std::array::from_fn(|_| None);
    for _ in 0..class_count {
        let tag = read_u8_at(bytes, &mut pos)?;
        let len = read_u32_at(bytes, &mut pos)?;
        let end = pos
            .checked_add(len)
            .ok_or_else(|| "route program: class length overflow".to_string())?;
        if end > bytes.len() {
            return Err("route program: truncated class payload".to_string());
        }
        let payload = &bytes[pos..end];
        pos = end;
        let slot = classes
            .get_mut(tag as usize)
            .ok_or_else(|| format!("route program: unknown class tag {tag}"))?;
        if slot.is_some() {
            return Err(format!("route program: duplicate class tag {tag}"));
        }
        *slot = Some(parse_class_template(payload)?);
    }

    Ok(ResponseSet { classes })
}

/// Require a class tag to be compiled in a referenced response set (a decision
/// op whose terminal class is absent must fail compilation, never at run time).
fn require_class(set: &ResponseSet, tag: u8, what: &str) -> std::result::Result<(), String> {
    if set.classes[tag as usize].is_none() {
        return Err(format!(
            "route program: {what} requires class {tag}, which the response set does not compile"
        ));
    }
    Ok(())
}

/// Compile the v5 `program` part into a `CompiledProgram`. Every unknown/bad
/// operand is a hard reject → the caller falls back to JS.
fn parse_program(bytes: &[u8]) -> std::result::Result<CompiledProgram, String> {
    let mut pos = 0usize;
    let version = read_u8_at(bytes, &mut pos)?;
    if version != PROGRAM_REGISTRY_VERSION {
        return Err(format!(
            "route program: unsupported program version {version} (this build supports {PROGRAM_REGISTRY_VERSION})"
        ));
    }
    let const_count = read_u32_at(bytes, &mut pos)?;
    if const_count > bytes.len() / 4 + 1 {
        return Err("route program: const count exceeds descriptor size".to_string());
    }
    let mut consts: Vec<&[u8]> = Vec::with_capacity(const_count);
    for _ in 0..const_count {
        consts.push(read_section(bytes, &mut pos, usize::MAX)?);
    }
    let op_count = read_u32_at(bytes, &mut pos)?;
    // Each op is 1 + 12 fixed bytes; a larger count can only be malformed.
    if op_count > bytes.len() / 13 + 1 {
        return Err("route program: op count exceeds descriptor size".to_string());
    }

    let mut ops: Vec<Op> = Vec::with_capacity(op_count);
    let mut sets: Vec<Option<ResponseSet>> = (0..const_count).map(|_| None).collect();
    let mut has_side_effects = false;

    for i in 0..op_count {
        let tag = read_u8_at(bytes, &mut pos)?;
        let a = read_u32_at(bytes, &mut pos)? as u32;
        let b = read_u32_at(bytes, &mut pos)? as u32;
        let c = read_u32_at(bytes, &mut pos)? as u32;
        let op = match tag {
            OP_PARSE_QUERY => Op::ParseQuery { out: a },
            OP_PARSE_COOKIES => Op::ParseCookies { out: a },
            OP_LIMITS => {
                let set = const_index(consts.len(), b, "limits")?;
                let raw = const_at(&consts, b, "limits")?;
                let parsed = build_response_set(raw)?;
                require_class(&parsed, CLASS_BODY_TOO_LARGE, "limits")?;
                sets[b as usize] = Some(parsed);
                Op::Limits { out: a, set }
            }
            OP_IP_TRUST => {
                let mode = parse_ip_trust_config(const_at(&consts, a, "ip_trust")?)?;
                Op::IpTrust { out: b, mode }
            }
            OP_CORS => {
                let engine = parse_cors_config(const_at(&consts, a, "cors")?)?;
                let set = const_index(consts.len(), b, "cors")?;
                let parsed = build_response_set(const_at(&consts, b, "cors")?)?;
                require_class(&parsed, CLASS_PREFLIGHT_OK, "cors")?;
                require_class(&parsed, CLASS_PREFLIGHT_FORBIDDEN, "cors")?;
                sets[b as usize] = Some(parsed);
                Op::Cors {
                    out: c,
                    engine,
                    set,
                }
            }
            OP_RATE_LIMIT => {
                let (limit, window, max) = parse_rate_config(const_at(&consts, a, "rate_limit")?)?;
                let set = const_index(consts.len(), b, "rate_limit")?;
                let parsed = build_response_set(const_at(&consts, b, "rate_limit")?)?;
                require_class(&parsed, CLASS_RATE_LIMITED, "rate_limit")?;
                sets[b as usize] = Some(parsed);
                let limiter = shared_limiter(limit, window, Some(max as usize))
                    .map_err(|e| format!("route program: rate config: {e}"))?;
                has_side_effects = true;
                Op::RateLimit {
                    out: c,
                    limiter,
                    set,
                }
            }
            OP_SECURITY_HEADERS => {
                // Validate the const list, then discard: v6 bakes static
                // security headers into the JS-owned class templates.
                let _ = parse_header_list(const_at(&consts, a, "security_headers")?)?;
                Op::SecurityHeaders
            }
            OP_SET_HEADER => {
                let _ = const_at(&consts, a, "set_header")?;
                match c {
                    SET_VALUE_CONST => {
                        let _ = const_at(&consts, b, "set_header")?;
                    }
                    SET_VALUE_REQUEST_ID => {}
                    other => {
                        return Err(format!(
                            "route program: set_header unknown value source {other}"
                        ));
                    }
                }
                Op::SetHeader
            }
            OP_JSON_VALID => {
                let require = c != 0;
                let set = if require {
                    let set = const_index(consts.len(), b, "json_valid")?;
                    let parsed = build_response_set(const_at(&consts, b, "json_valid")?)?;
                    require_class(&parsed, CLASS_INVALID_JSON, "json_valid")?;
                    sets[b as usize] = Some(parsed);
                    Some(set)
                } else {
                    None
                };
                Op::JsonValid {
                    out: a,
                    require,
                    set,
                }
            }
            OP_SCHEMA_VALIDATE => {
                let schema = if a == NO_CONST {
                    None
                } else {
                    let raw = const_at(&consts, a, "schema_validate")?;
                    Some(parse_schema_const(raw)?)
                };
                let set = const_index(consts.len(), b, "schema_validate")?;
                let parsed = build_response_set(const_at(&consts, b, "schema_validate")?)?;
                require_class(&parsed, CLASS_SCHEMA_FAILED, "schema_validate")?;
                require_class(&parsed, CLASS_INVALID_JSON, "schema_validate")?;
                sets[b as usize] = Some(parsed);
                Op::SchemaValidate {
                    out: c,
                    schema,
                    halt: true,
                    set: Some(set),
                }
            }
            OP_RESPONSE_PROJECTION => {
                let parsed = build_response_set(const_at(&consts, a, "response_projection")?)?;
                require_class(&parsed, CLASS_OK_NO_ORIGIN, "response_projection")?;
                sets[a as usize] = Some(parsed);
                Op::ResponseProjection { set: a as usize }
            }
            OP_HALT => {
                let reason = reason_from_u32(b)?;
                let parsed = build_response_set(const_at(&consts, a, "halt")?)?;
                let base = match reason {
                    HaltReason::Ok => CLASS_OK_NO_ORIGIN,
                    HaltReason::PreflightOk => CLASS_PREFLIGHT_OK,
                    HaltReason::PreflightForbidden => CLASS_PREFLIGHT_FORBIDDEN,
                    HaltReason::RateLimited => CLASS_RATE_LIMITED,
                    HaltReason::InvalidJson => CLASS_INVALID_JSON,
                    HaltReason::SchemaFailed => CLASS_SCHEMA_FAILED,
                    HaltReason::BodyTooLarge => CLASS_BODY_TOO_LARGE,
                };
                require_class(&parsed, base, "halt")?;
                sets[a as usize] = Some(parsed);
                Op::Halt {
                    set: a as usize,
                    reason,
                }
            }
            OP_JUMP => {
                if a as usize <= i || (a as usize) >= op_count {
                    return Err(format!(
                        "route program: forward-only jump target {a} out of range at op {i}"
                    ));
                }
                Op::Jump { target: a as usize }
            }
            OP_BRANCH => {
                if b as usize <= i || (b as usize) >= op_count {
                    return Err(format!(
                        "route program: forward-only branch target {b} out of range at op {i}"
                    ));
                }
                Op::Branch {
                    slot: a,
                    target: b as usize,
                }
            }
            OP_CALLOUT => {
                return Err(
                    "route program: callout op is not supported by this executor (hard reject → JS fallback)"
                        .to_string(),
                );
            }
            other => {
                return Err(format!(
                    "route program: unknown op tag {other} (registry v{PROGRAM_REGISTRY_VERSION})"
                ));
            }
        };
        ops.push(op);
    }

    Ok(CompiledProgram {
        ops,
        sets,
        has_side_effects,
    })
}

/// Validate a `ResponseSet` const index.
fn const_index(const_count: usize, idx: u32, what: &str) -> std::result::Result<usize, String> {
    if (idx as usize) >= const_count {
        return Err(format!(
            "route program: {what} const index {idx} out of range"
        ));
    }
    Ok(idx as usize)
}

/// Compile a draft-07 schema const (shared process-wide cache).
fn parse_schema_const(bytes: &[u8]) -> std::result::Result<Arc<IngressSchema>, String> {
    let schema_str = std::str::from_utf8(bytes)
        .map_err(|_| "route program: schema is not valid UTF-8".to_string())?;
    let schema_value: serde_json::Value = sonic_rs::from_str(schema_str)
        .map_err(|e| format!("route program: schema JSON error: {e}"))?;
    super::schema_cache::get_or_compile(&schema_value)
        .map_err(|e| format!("route program: schema compile error: {e}"))
}

// ── Response projection (route-wire v4) ─────────────────────────────

/// Read a u16le, advancing `pos` on success (bounds-checked).
#[inline]
fn read_u16_at(input: &[u8], pos: &mut usize) -> std::result::Result<u16, String> {
    if *pos + 2 > input.len() {
        return Err("route descriptor: truncated u16".to_string());
    }
    let v = u16::from_le_bytes([input[*pos], input[*pos + 1]]);
    *pos += 2;
    Ok(v)
}

/// Parse the `response` projection template bytes:
/// `[status u16][hdrCount u32]{[nameLen u32][name][valueLen u32][value]}…`
/// `[bodyLen u32][body]` and reduce it to the dynamic substitution slot mask.
/// All reads are bounds-checked; the header-count guard caps allocation.
fn parse_response(bytes: &[u8]) -> std::result::Result<ResponseProjection, String> {
    let mut pos = 0usize;
    let _status = read_u16_at(bytes, &mut pos)?;
    let header_count = read_u32_at(bytes, &mut pos)?;
    // Each header costs at least 8 bytes (two u32 length prefixes), so a count
    // larger than the remaining descriptor can only be malformed.
    if header_count > bytes.len() / 8 + 1 {
        return Err("route descriptor: response header count exceeds descriptor size".to_string());
    }
    let mut slot_mask = 0u16;
    for _ in 0..header_count {
        let _name = read_section(bytes, &mut pos, usize::MAX)?;
        let value = read_section(bytes, &mut pos, usize::MAX)?;
        collect_slots(value, &mut slot_mask);
    }
    let body = read_section(bytes, &mut pos, usize::MAX)?;
    collect_slots(body, &mut slot_mask);
    Ok(ResponseProjection { slot_mask })
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

/// Whether `max_pairs` caps the query pair section — the same `count >=
/// max_pairs` semantics `write_query_section` implements, without writing.
#[inline]
fn query_pairs_capped(query: &[u8], max_pairs: usize) -> bool {
    max_pairs > 0 && query_pairs(query).take(max_pairs + 1).count() > max_pairs
}

/// Whether `max_pairs` caps the cookie pair section — same semantics as
/// `write_cookie_section`, without writing.
#[inline]
fn cookie_pairs_capped(cookie: &[u8], max_pairs: usize) -> bool {
    max_pairs > 0 && cookie_pairs(cookie).take(max_pairs + 1).count() > max_pairs
}

// `cookie_pairs` (crate::util::bytes) yields raw (trimmed, DQUOTE-unwrapped,
// NOT URL-decoded) `name=value` slices — byte-identical to ignex's
// `cookiePairs` fallback.

/// LENIENT segment decode (matches JS `decodeSegment`): `+` → space, `%XX` →
/// byte, result must be valid UTF-8; on ANY failure the WHOLE original segment
/// is returned unchanged (with `+` AND `%` intact — the JS catch returns `s`).
///
/// Decodes into a caller-provided `scratch` (reused across every segment and
/// pair of the call) so the hot path NEVER allocates per segment — the old
/// implementation built `Vec::with_capacity` for the `+` replacement AND
/// another for the percent decode, i.e. two allocations per escaped segment,
/// twice per call (size pass + write pass).
///
/// The slice returned borrows either `seg` (fast path / lenient fallback) or
/// `scratch`; it is valid only until the next call with the same scratch.
#[inline]
fn decode_segment_scratch<'a>(seg: &'a [u8], scratch: &'a mut Vec<u8>) -> &'a [u8] {
    // Semantics live in ONE place (`util::bytes`) so the route stack and the
    // packed pair parsers can never disagree: `+` → space, `%XX` → byte, and a
    // malformed escape or an invalid-UTF-8 result falls back to the WHOLE
    // original segment (JS `try { decodeURIComponent(...) } catch { return s }`).
    crate::util::bytes::decode_form_component_scratch(seg, scratch)
}

// ── Streaming result writer (ONE pass, zero per-segment alloc) ─────

/// Bytes reserved at the head of the result for the `[flags u32][error u32]`
/// verdict header.
const RESULT_HEADER_LEN: usize = 8;

/// Streaming result writer: appends bytes while tracking the EXACT required
/// size, so a single pass produces both the packed result AND the needed-size
/// answer. The previous shape walked every pair section TWICE (a sizing pass
/// and a write pass), decoding every escaped segment in both.
///
/// Once the caller's buffer proves too small the writer stops copying (and
/// stops patching) but KEEPS counting `needed`, so the needed-size convention
/// still reports the exact size from the same pass. The verdict header is
/// committed LAST, so a too-small buffer is left untouched — the contract
/// `run()`'s callers rely on.
struct ResultWriter<'a> {
    out: &'a mut [u8],
    pos: usize,
    needed: usize,
    full: bool,
}

impl<'a> ResultWriter<'a> {
    #[inline]
    fn new(out: &'a mut [u8], header_len: usize) -> Self {
        Self {
            full: out.len() < header_len,
            out,
            pos: header_len,
            needed: header_len,
        }
    }

    /// Append `bytes`, tracking the required size even after the buffer is full.
    #[inline]
    fn bytes(&mut self, bytes: &[u8]) {
        self.needed += bytes.len();
        if !self.full {
            let end = self.pos + bytes.len();
            if end <= self.out.len() {
                self.out[self.pos..end].copy_from_slice(bytes);
                self.pos = end;
            } else {
                self.full = true;
            }
        }
    }

    #[inline]
    fn u16(&mut self, value: u16) {
        self.bytes(&value.to_le_bytes());
    }

    #[inline]
    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    /// Append the decimal ASCII form of `value` (no allocation).
    #[inline]
    fn num(&mut self, mut value: u64) {
        if value == 0 {
            self.bytes(b"0");
            return;
        }
        let mut buf = [0u8; 20];
        let mut i = buf.len();
        while value > 0 {
            i -= 1;
            buf[i] = b'0' + (value % 10) as u8;
            value /= 10;
        }
        self.bytes(&buf[i..]);
    }

    /// Append `[u32 len][bytes]` — the pair-section element layout.
    #[inline]
    fn len_prefixed(&mut self, bytes: &[u8]) {
        self.u32(bytes.len() as u32);
        self.bytes(bytes);
    }

    /// Patch a previously reserved u32 (the section pair count) in place.
    #[inline]
    fn patch_u32(&mut self, at: usize, value: u32) {
        if !self.full && at + 4 <= self.out.len() {
            self.out[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
    }

    /// Commit the verdict header and return the bytes written — or, when the
    /// buffer was too small, the EXACT required size (nothing committed).
    #[inline]
    fn commit(self, header: [u8; RESULT_HEADER_LEN]) -> usize {
        if self.full || self.needed > self.out.len() {
            return self.needed;
        }
        self.out[..RESULT_HEADER_LEN].copy_from_slice(&header);
        self.pos
    }
}

/// Write the query pair section (lenient-decoded names/values) in ONE pass.
/// Returns `true` when `max_pairs` capped the section (→ not valid).
fn write_query_section(
    w: &mut ResultWriter<'_>,
    scratch: &mut Vec<u8>,
    query: &[u8],
    max_pairs: usize,
) -> bool {
    let count_pos = w.pos;
    w.u32(0); // count placeholder, patched below
    let mut count = 0usize;
    let mut capped = false;
    for pair in query_pairs(query) {
        if max_pairs > 0 && count >= max_pairs {
            capped = true;
            break;
        }
        w.len_prefixed(decode_segment_scratch(pair.name, scratch));
        w.len_prefixed(decode_segment_scratch(pair.value, scratch));
        count += 1;
    }
    w.patch_u32(count_pos, count as u32);
    capped
}

/// Write the cookie pair section (raw trimmed/unquoted names/values) in ONE pass.
/// Returns `true` when `max_pairs` capped the section (→ not valid).
fn write_cookie_section(w: &mut ResultWriter<'_>, cookie: &[u8], max_pairs: usize) -> bool {
    let count_pos = w.pos;
    w.u32(0); // count placeholder, patched below
    let mut count = 0usize;
    let mut capped = false;
    for (name, value) in cookie_pairs(cookie) {
        if max_pairs > 0 && count >= max_pairs {
            capped = true;
            break;
        }
        w.len_prefixed(name);
        w.len_prefixed(value);
        count += 1;
    }
    w.patch_u32(count_pos, count as u32);
    capped
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

    /// Encode a request frame WITH a request-id section (v4 frame flag).
    fn frame_with_rid(query: &[u8], cookie: &[u8], body: Option<&[u8]>, rid: &[u8]) -> Vec<u8> {
        let mut f = frame(query, cookie, body);
        let flags =
            u32::from_le_bytes(f[0..4].try_into().unwrap()) | ROUTE_FRAME_FLAG_HAS_REQUEST_ID;
        f[0..4].copy_from_slice(&flags.to_le_bytes());
        f.extend_from_slice(&(rid.len() as u32).to_le_bytes());
        f.extend_from_slice(rid);
        f
    }

    /// Encode a response projection part body.
    fn response_payload(status: u16, headers: &[(&[u8], &[u8])], body: &[u8]) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend_from_slice(&status.to_le_bytes());
        r.extend_from_slice(&(headers.len() as u32).to_le_bytes());
        for (name, value) in headers {
            r.extend_from_slice(&(name.len() as u32).to_le_bytes());
            r.extend_from_slice(name);
            r.extend_from_slice(&(value.len() as u32).to_le_bytes());
            r.extend_from_slice(value);
        }
        r.extend_from_slice(&(body.len() as u32).to_le_bytes());
        r.extend_from_slice(body);
        r
    }

    /// The verdict error code (bytes 4..8 of the result header).
    fn result_code(wire: &[u8]) -> u32 {
        u32::from_le_bytes(wire[4..8].try_into().unwrap())
    }

    /// Decode the v6 substitution section: (class tag, [(slot, bytes)]).
    fn decode_subs(wire: &[u8]) -> (u8, Vec<(u16, Vec<u8>)>) {
        let flags = u32::from_le_bytes(wire[0..4].try_into().unwrap());
        let class = ((flags >> ROUTE_RESULT_CLASS_SHIFT) & 0xff) as u8;
        let mut pos = RESULT_HEADER_LEN;
        let count = u16::from_le_bytes(wire[pos..pos + 2].try_into().unwrap()) as usize;
        pos += 2;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let slot = u16::from_le_bytes(wire[pos..pos + 2].try_into().unwrap());
            pos += 2;
            let len = u32::from_le_bytes(wire[pos..pos + 4].try_into().unwrap()) as usize;
            pos += 4;
            out.push((slot, wire[pos..pos + len].to_vec()));
            pos += len;
        }
        (class, out)
    }

    /// The bytes emitted for one substitution slot (`None` = absent).
    fn slot_of(subs: &[(u16, Vec<u8>)], slot: u16) -> Option<&[u8]> {
        subs.iter()
            .find(|(s, _)| *s == slot)
            .map(|(_, b)| b.as_slice())
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
    fn validate_body_without_require_json_fails_closed_on_absent_body() {
        let schema = br#"{"type":"object","required":["x"],"properties":{"x":{"type":"number"}}}"#;
        // Deliberately NO requireJsonBody stage: a route that only declares
        // validateBody must still reject a missing body. Pre-fix this returned
        // OK with error_code 0 and skipped schema validation entirely.
        let d = descriptor(&[STAGE_VALIDATE_BODY], &[(PART_BODY, schema)]);
        let r = NativeRoute::compile(&d).unwrap();
        let mut out = vec![0u8; 64];
        r.run(&frame(b"", b"", None), &mut out).unwrap();
        let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
        let code = u32::from_le_bytes(out[4..8].try_into().unwrap());
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

    // ── v6 response projection (substitutions only) ─────────────

    #[test]
    fn response_projection_constant_body_round_trips() {
        let payload = response_payload(
            200,
            &[(b"content-type", b"application/json")],
            b"{\"ok\":true}",
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &payload)])).unwrap();
        let mut out = vec![0u8; 256];
        let w = r.run(&frame(b"", b"", None), &mut out).unwrap();
        let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
        assert_ne!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_HAS_RESPONSE, 0);
        // No dynamic slots → class 0 + an empty substitution section only.
        let (class, subs) = decode_subs(&out[..w]);
        assert_eq!(class, CLASS_OK_NO_ORIGIN);
        assert!(subs.is_empty());
        assert_eq!(w, RESULT_HEADER_LEN + 2);
    }

    #[test]
    fn response_projection_substitutes_request_id() {
        let payload = response_payload(201, &[], b"{\"ok\":true,\"requestId\":\"{requestId}\"}");
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &payload)])).unwrap();
        let f = frame_with_rid(b"", b"", None, b"rid-abc-123");
        let mut out = vec![0u8; 256];
        let w = r.run(&f, &mut out).unwrap();
        let (class, subs) = decode_subs(&out[..w]);
        assert_eq!(class, CLASS_OK_NO_ORIGIN);
        assert_eq!(slot_of(&subs, SLOT_REQUEST_ID), Some(&b"rid-abc-123"[..]));
    }

    #[test]
    fn response_projection_requires_request_id_when_template_has_placeholder() {
        let payload = response_payload(200, &[], b"{\"requestId\":\"{requestId}\"}");
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &payload)])).unwrap();
        let mut out = vec![0u8; 256];
        // No request-id flag/section → the frame cannot satisfy the template.
        assert!(r.run(&frame(b"", b"", None), &mut out).is_err());
        assert_eq!(out, vec![0u8; 256], "nothing written on the error path");
    }

    #[test]
    fn response_projection_needed_size_convention() {
        let payload = response_payload(
            200,
            &[(b"content-type", b"application/json; charset=utf-8")],
            b"{\"ok\":true,\"requestId\":\"{requestId}\",\"path\":\"/api/users\"}",
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &payload)])).unwrap();
        let f = frame_with_rid(b"", b"", None, b"0193f2c4-0000-7000-8000-000000000000");
        let mut small = [0u8; 8];
        let needed = r.run(&f, &mut small).unwrap();
        assert!(needed > 8);
        assert_eq!(small, [0u8; 8], "nothing written to a too-small buffer");
        let mut big = vec![0u8; needed];
        assert_eq!(r.run(&f, &mut big).unwrap(), needed);
    }

    #[test]
    fn response_projection_error_keeps_verdict_shape() {
        // requireJsonBody + a response projection: a bad body must NOT emit the
        // response frame — the caller needs the 400 verdict to reject.
        let payload = response_payload(200, &[], b"{}");
        let r = NativeRoute::compile(&descriptor(
            &[STAGE_REQUIRE_JSON_BODY],
            &[(PART_RESPONSE, &payload)],
        ))
        .unwrap();
        let mut out = vec![0u8; 64];
        let w = r
            .run(&frame(b"", b"", Some(b"not json")), &mut out)
            .unwrap();
        let flags = u32::from_le_bytes(out[0..4].try_into().unwrap());
        let code = u32::from_le_bytes(out[4..8].try_into().unwrap());
        assert_eq!(code, 400);
        assert_eq!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_eq!(flags & ROUTE_RESULT_FLAG_HAS_RESPONSE, 0);
        assert_eq!(w, RESULT_HEADER_LEN); // verdict only — no pair sections
    }

    #[test]
    fn response_projection_malformed_is_rejected() {
        // Two request-id placeholders are fine in v6 (one slot value fills
        // both) — only the wire structure is validated.
        let two = response_payload(200, &[], b"{requestId}{requestId}");
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &two)])).unwrap();
        let mut out = vec![0u8; 64];
        let w = r
            .run(&frame_with_rid(b"", b"", None, b"rid"), &mut out)
            .unwrap();
        let (_, subs) = decode_subs(&out[..w]);
        assert_eq!(slot_of(&subs, SLOT_REQUEST_ID), Some(&b"rid"[..]));
        // Truncated header value.
        let mut trunc = response_payload(200, &[(b"x", b"y")], b"");
        trunc.truncate(trunc.len() - 1);
        assert!(NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &trunc)])).is_err());
        // Absurd header count (allocation guard).
        let mut absurd = vec![0u8; 10];
        absurd[2..6].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(NativeRoute::compile(&descriptor(&[], &[(PART_RESPONSE, &absurd)])).is_err());
        // Duplicate response part.
        let p = response_payload(200, &[], b"");
        assert!(NativeRoute::compile(&descriptor(
            &[],
            &[(PART_RESPONSE, p.as_slice()), (PART_RESPONSE, p.as_slice())]
        ))
        .is_err());
    }

    #[test]
    fn compile_rejects_v3_descriptor_with_version_error() {
        let mut d = descriptor(&[STAGE_PARSE_QUERY], &[]);
        d[4..8].copy_from_slice(&3u32.to_le_bytes());
        let err = match NativeRoute::compile(&d) {
            Ok(_) => panic!("a v3 descriptor must be rejected by the v4 stack"),
            Err(e) => e,
        };
        assert!(err.contains("unsupported version 3"), "got: {err}");
    }

    // ── v5 op program ───────────────────────────────────────────

    /// `[count u32]{[len u32][utf8]}…`
    fn push_str_list(p: &mut Vec<u8>, list: &[&[u8]]) {
        p.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for s in list {
            p.extend_from_slice(&(s.len() as u32).to_le_bytes());
            p.extend_from_slice(s);
        }
    }

    /// Encode a v5 request frame (mirror of `packRouteFrame`).
    #[allow(clippy::too_many_arguments)]
    fn frame_pre(
        query: &[u8],
        cookie: &[u8],
        body: Option<&[u8]>,
        rid: Option<&[u8]>,
        method: Option<u8>,
        ip: Option<&[u8]>,
        headers: Option<&[u8]>,
        https: bool,
    ) -> Vec<u8> {
        let has_body = body.map(|b| !b.is_empty()).unwrap_or(false);
        let mut flags = 0u32;
        if has_body {
            flags |= ROUTE_FRAME_FLAG_HAS_BODY;
        }
        if rid.is_some() {
            flags |= ROUTE_FRAME_FLAG_HAS_REQUEST_ID;
        }
        if method.is_some() {
            flags |= ROUTE_FRAME_FLAG_HAS_METHOD;
        }
        if ip.is_some() {
            flags |= ROUTE_FRAME_FLAG_HAS_IP;
        }
        if headers.is_some() {
            flags |= ROUTE_FRAME_FLAG_HAS_HEADERS;
        }
        if https {
            flags |= ROUTE_FRAME_FLAG_HTTPS;
        }
        let mut f = Vec::new();
        f.extend_from_slice(&flags.to_le_bytes());
        f.extend_from_slice(&(query.len() as u32).to_le_bytes());
        f.extend_from_slice(query);
        f.extend_from_slice(&(cookie.len() as u32).to_le_bytes());
        f.extend_from_slice(cookie);
        if has_body {
            let b = body.unwrap_or(&[]);
            f.extend_from_slice(&(b.len() as u32).to_le_bytes());
            f.extend_from_slice(b);
        }
        if let Some(r) = rid {
            f.extend_from_slice(&(r.len() as u32).to_le_bytes());
            f.extend_from_slice(r);
        }
        if let Some(m) = method {
            f.push(m);
        }
        if let Some(i) = ip {
            f.extend_from_slice(&(i.len() as u32).to_le_bytes());
            f.extend_from_slice(i);
        }
        if let Some(h) = headers {
            f.extend_from_slice(&(h.len() as u32).to_le_bytes());
            f.extend_from_slice(h);
        }
        f
    }

    /// Encode a program part payload:
    /// `[version u8][constCount u32]{[len u32][bytes]}…`
    /// `[opCount u32]{[tag u8][a u32][b u32][c u32]}…`
    fn program_payload(version: u8, consts: &[&[u8]], ops: &[(u8, u32, u32, u32)]) -> Vec<u8> {
        let mut p = Vec::new();
        p.push(version);
        p.extend_from_slice(&(consts.len() as u32).to_le_bytes());
        for c in consts {
            p.extend_from_slice(&(c.len() as u32).to_le_bytes());
            p.extend_from_slice(c);
        }
        p.extend_from_slice(&(ops.len() as u32).to_le_bytes());
        for (tag, a, b, c) in ops {
            p.push(*tag);
            p.extend_from_slice(&a.to_le_bytes());
            p.extend_from_slice(&b.to_le_bytes());
            p.extend_from_slice(&c.to_le_bytes());
        }
        p
    }

    /// `[count u32]{[tag u8][len u32][class payload]}…`
    fn response_set(classes: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&(classes.len() as u32).to_le_bytes());
        for (tag, payload) in classes {
            p.push(*tag);
            p.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            p.extend_from_slice(payload);
        }
        p
    }

    fn cors_config(
        creds: bool,
        origins: &[&[u8]],
        methods: &[&[u8]],
        headers: &[&[u8]],
    ) -> Vec<u8> {
        let mut p = vec![creds as u8];
        push_str_list(&mut p, origins);
        push_str_list(&mut p, methods);
        push_str_list(&mut p, headers);
        p
    }

    fn rate_config(limit: u32, window: u32, max: u32) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&limit.to_le_bytes());
        p.extend_from_slice(&window.to_le_bytes());
        p.extend_from_slice(&max.to_le_bytes());
        p
    }

    fn ip_trust_config(mode: u8, nets: &[&[u8]]) -> Vec<u8> {
        let mut p = vec![mode];
        if mode == 2 {
            push_str_list(&mut p, nets);
        }
        p
    }

    fn header_list(headers: &[(&[u8], &[u8])]) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&(headers.len() as u32).to_le_bytes());
        for (n, v) in headers {
            p.extend_from_slice(&(n.len() as u32).to_le_bytes());
            p.extend_from_slice(n);
            p.extend_from_slice(&(v.len() as u32).to_le_bytes());
            p.extend_from_slice(v);
        }
        p
    }

    /// A CORS-aware OK response set: classes 0..=3 as the TS builder emits.
    fn cors_ok_set(body: &[u8]) -> Vec<u8> {
        response_set(&[
            (
                CLASS_OK_NO_ORIGIN,
                response_payload(200, &[(b"content-type", b"application/json")], body),
            ),
            (
                CLASS_OK_WITH_ORIGIN,
                response_payload(
                    200,
                    &[
                        (b"content-type", b"application/json"),
                        (b"vary", b"Origin"),
                        (b"access-control-allow-origin", b"{origin}"),
                    ],
                    body,
                ),
            ),
            (CLASS_PREFLIGHT_OK, response_payload(204, &[], b"")),
            (
                CLASS_PREFLIGHT_FORBIDDEN,
                response_payload(403, &[], b"forbidden"),
            ),
        ])
    }

    /// A minimal OK-only response set (class 0).
    fn ok_set(body: &[u8]) -> Vec<u8> {
        response_set(&[(
            CLASS_OK_NO_ORIGIN,
            response_payload(200, &[(b"content-type", b"application/json")], body),
        )])
    }

    fn run_out(r: &NativeRoute, f: &[u8], cap: usize) -> Vec<u8> {
        let mut out = vec![0u8; cap];
        let w = r.run(f, &mut out).unwrap();
        out.truncate(w);
        out
    }

    #[test]
    fn program_registry_tags_are_stable() {
        let expected = [
            (OP_PARSE_QUERY, "parse_query"),
            (OP_PARSE_COOKIES, "parse_cookies"),
            (OP_LIMITS, "limits"),
            (OP_IP_TRUST, "ip_trust"),
            (OP_CORS, "cors"),
            (OP_RATE_LIMIT, "rate_limit"),
            (OP_SECURITY_HEADERS, "security_headers"),
            (OP_SET_HEADER, "set_header"),
            (OP_JSON_VALID, "json_valid"),
            (OP_SCHEMA_VALIDATE, "schema_validate"),
            (OP_RESPONSE_PROJECTION, "response_projection"),
            (OP_HALT, "halt"),
            (OP_JUMP, "jump"),
            (OP_BRANCH, "branch"),
            (OP_CALLOUT, "callout"),
        ];
        for (tag, name) in expected {
            assert_eq!(op_name(tag), Some(name), "tag {tag}");
        }
        assert_eq!(op_name(0), None, "tag 0 is not allocated");
        assert_eq!(op_name(200), None);
    }

    #[test]
    fn program_unknown_tag_is_rejected() {
        let set = ok_set(b"{}");
        let ops = [
            (OP_RESPONSE_PROJECTION, 0, 0, 0),
            (200u8, 0, 0, 0), // unknown tag
        ];
        let prog = program_payload(PROGRAM_REGISTRY_VERSION, &[&set], &ops);
        let err = match NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])) {
            Ok(_) => panic!("unknown tag must reject"),
            Err(e) => e,
        };
        assert!(err.contains("unknown op tag 200"), "got: {err}");
    }

    #[test]
    fn program_version_and_callout_are_rejected() {
        let set = ok_set(b"{}");
        let prog = program_payload(99, &[&set], &[(OP_RESPONSE_PROJECTION, 0, 0, 0)]);
        let err = match NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])) {
            Ok(_) => panic!("bad program version must reject"),
            Err(e) => e,
        };
        assert!(err.contains("unsupported program version 99"), "got: {err}");

        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set],
            &[(OP_CALLOUT, 7, 1, 0), (OP_RESPONSE_PROJECTION, 0, 0, 0)],
        );
        let err = match NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])) {
            Ok(_) => panic!("callout must reject"),
            Err(e) => e,
        };
        assert!(err.contains("callout op is not supported"), "got: {err}");
    }

    #[test]
    fn program_legacy_pre_part_is_rejected() {
        // Tag 6 is the removed pre-effect part: a stale v5 descriptor must be a
        // hard reject, never a silent misparse.
        assert!(NativeRoute::compile(&descriptor(&[], &[(PART_PRE_LEGACY, b"anything")])).is_err());
    }

    #[test]
    fn program_forward_only_jump_is_enforced() {
        let set = ok_set(b"{}");
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set],
            &[(OP_JUMP, 0, 0, 0), (OP_RESPONSE_PROJECTION, 0, 0, 0)],
        );
        assert!(NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).is_err());
    }

    #[test]
    fn program_zero_callout_response_round_trips() {
        let set = cors_ok_set(b"{\"ok\":true,\"requestId\":\"{requestId}\"}");
        let cors = cors_config(false, &[b"*"], &[], &[]);
        let sec = header_list(&[(b"x-content-type-options", b"nosniff")]);
        let ops = [
            (OP_PARSE_QUERY, 0, 0, 0),
            (OP_CORS, 1, 0, 0),
            (OP_SECURITY_HEADERS, 2, 0, 0),
            (OP_RESPONSE_PROJECTION, 0, 0, 0),
        ];
        let prog = program_payload(PROGRAM_REGISTRY_VERSION, &[&set, &cors, &sec], &ops);
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let packed = crate::test_support::pack_headers([("Origin", "https://app.example.com")]);
        let f = frame_pre(
            b"a=1&b=2",
            b"",
            None,
            Some(b"rid-1"),
            Some(0),
            Some(b"203.0.113.5"),
            Some(&packed),
            false,
        );
        let wire = run_out(&r, &f, 1024);
        let flags = u32::from_le_bytes(wire[0..4].try_into().unwrap());
        assert_ne!(flags & ROUTE_RESULT_FLAG_OK, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_HAS_RESPONSE, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_QUERY_VALID, 0);
        // CORS allowed + origin present → the with-origin class, with the
        // request-id + origin substitution slots. The `security_headers` op is
        // accepted but emits nothing in v6 (security is baked JS-side).
        let (class, subs) = decode_subs(&wire);
        assert_eq!(class, CLASS_OK_WITH_ORIGIN);
        assert_eq!(slot_of(&subs, SLOT_REQUEST_ID), Some(&b"rid-1"[..]));
        assert_eq!(
            slot_of(&subs, SLOT_ORIGIN),
            Some(&b"https://app.example.com"[..])
        );
    }

    #[test]
    fn program_parse_ops_drive_pair_verdict_without_a_terminal() {
        let ops = [(OP_PARSE_QUERY, 0, 0, 0), (OP_PARSE_COOKIES, 1, 0, 0)];
        let prog = program_payload(PROGRAM_REGISTRY_VERSION, &[], &ops);
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let wire = run_out(&r, &frame(b"a=1&b=2", b"s=v", None), 512);
        let flags = u32::from_le_bytes(wire[0..4].try_into().unwrap());
        assert_ne!(flags & ROUTE_RESULT_FLAG_QUERY_VALID, 0);
        assert_ne!(flags & ROUTE_RESULT_FLAG_COOKIE_VALID, 0);
        let mut pos = 8;
        let q = decode_pairs(&wire, &mut pos);
        let c = decode_pairs(&wire, &mut pos);
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
    fn program_cors_preflight_halts_204_and_403() {
        let set = cors_ok_set(b"{\"ok\":true}");
        let cors = cors_config(false, &[b"*"], &[], &[]);
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &cors],
            &[(OP_CORS, 1, 0, 0), (OP_RESPONSE_PROJECTION, 0, 0, 0)],
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();

        let allowed = crate::test_support::pack_headers([
            ("Origin", "https://app.example.com"),
            ("access-control-request-method", "POST"),
        ]);
        let wire = run_out(
            &r,
            &frame_pre(
                b"",
                b"",
                None,
                None,
                Some(6),
                Some(b"1.2.3.4"),
                Some(&allowed),
                false,
            ),
            512,
        );
        let (allowed_class, _) = decode_subs(&wire);
        assert_eq!(allowed_class, CLASS_PREFLIGHT_OK);
        assert_eq!(result_code(&wire), 0);

        let denied = crate::test_support::pack_headers([
            ("Origin", "https://app.example.com"),
            ("access-control-request-method", "DELETE"),
        ]);
        let wire = run_out(
            &r,
            &frame_pre(
                b"",
                b"",
                None,
                None,
                Some(6),
                Some(b"1.2.3.4"),
                Some(&denied),
                false,
            ),
            512,
        );
        let (class, _) = decode_subs(&wire);
        assert_eq!(class, CLASS_PREFLIGHT_FORBIDDEN);
        assert_eq!(result_code(&wire), 403);
    }

    #[test]
    fn program_rate_limit_halts_429_and_needed_size_does_not_consume() {
        let rl = response_payload(
            429,
            &[
                (b"content-type", b"application/json"),
                (b"ratelimit-remaining", b"{remaining}"),
                (b"retry-after", b"{retryAfterSecs}"),
            ],
            b"{\"retry_after_ms\":{retryAfterMs}}",
        );
        let set = response_set(&[
            (
                CLASS_OK_NO_ORIGIN,
                response_payload(200, &[(b"content-type", b"application/json")], b"{}"),
            ),
            (CLASS_RATE_LIMITED, rl),
        ]);
        let rate = rate_config(2, 60_000, 100_000);
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &rate],
            &[(OP_RATE_LIMIT, 1, 0, 0), (OP_RESPONSE_PROJECTION, 0, 0, 0)],
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let f = frame_pre(
            b"",
            b"",
            None,
            None,
            Some(0),
            Some(b"10.9.8.7"),
            None,
            false,
        );

        // Sizing pass: tiny buffer reports a bound and consumes no token.
        let mut small = [0u8; 8];
        let bound = r.run(&f, &mut small).unwrap();
        assert!(bound > 8);
        assert_eq!(small, [0u8; 8]);

        let w1 = run_out(&r, &f, bound);
        assert_eq!(result_code(&w1), 0);
        let w2 = run_out(&r, &f, bound);
        assert_eq!(result_code(&w2), 0);
        let w3 = run_out(&r, &f, bound);
        assert_eq!(result_code(&w3), 429);
        let (class, subs) = decode_subs(&w3);
        assert_eq!(class, CLASS_RATE_LIMITED);
        assert_eq!(slot_of(&subs, SLOT_REMAINING), Some(&b"0"[..]));
        assert!(slot_of(&subs, SLOT_RETRY_MS).is_some());
    }

    #[test]
    fn program_json_and_schema_validation_halt() {
        let schema = br#"{"type":"object","required":["x"],"properties":{"x":{"type":"number"}}}"#;
        let mut classes = vec![
            (CLASS_OK_NO_ORIGIN, response_payload(200, &[], b"{}")),
            (CLASS_INVALID_JSON, response_payload(400, &[], b"bad")),
            (CLASS_SCHEMA_FAILED, response_payload(422, &[], b"schema")),
        ];
        classes.sort_by_key(|(t, _)| *t);
        let set = response_set(&classes);
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &schema[..]],
            &[
                (OP_JSON_VALID, 0, 0, 1),
                (OP_SCHEMA_VALIDATE, 1, 0, 1),
                (OP_RESPONSE_PROJECTION, 0, 0, 0),
            ],
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();

        let bad_json = run_out(&r, &frame(b"", b"", Some(b"nope")), 256);
        assert_eq!(result_code(&bad_json), 400);
        assert_eq!(decode_subs(&bad_json).0, CLASS_INVALID_JSON);
        let schema_fail = run_out(&r, &frame(b"", b"", Some(br#"{"x":"s"}"#)), 256);
        assert_eq!(result_code(&schema_fail), 422);
        assert_eq!(decode_subs(&schema_fail).0, CLASS_SCHEMA_FAILED);
        let ok = run_out(&r, &frame(b"", b"", Some(br#"{"x":1}"#)), 256);
        assert_eq!(result_code(&ok), 0);
        assert_eq!(decode_subs(&ok).0, CLASS_OK_NO_ORIGIN);
    }

    #[test]
    fn program_branch_selects_a_runtime_variant() {
        // set_b references the request id (a slot), set_a does not — so the
        // branch is observable on the v6 substitution wire.
        let set_a = response_set(&[(CLASS_OK_NO_ORIGIN, response_payload(200, &[], b"A"))]);
        let set_b = response_set(&[(
            CLASS_OK_NO_ORIGIN,
            response_payload(200, &[], b"B{requestId}"),
        )]);
        // json_valid(out 0, require 0); branch(slot 0 -> op 3);
        // op 2 -> set_a ("A"); op 3 -> set_b ("B"). Valid jumps to B.
        let ops = [
            (OP_JSON_VALID, 0, 0, 0),
            (OP_BRANCH, 0, 3, 0),
            (OP_RESPONSE_PROJECTION, 0, 0, 0),
            (OP_RESPONSE_PROJECTION, 1, 0, 0),
        ];
        let prog = program_payload(PROGRAM_REGISTRY_VERSION, &[&set_a, &set_b], &ops);
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        // Valid JSON → branch taken → set_b → the request-id slot is present.
        let b = run_out(&r, &frame_with_rid(b"", b"", Some(b"{}"), b"rid-b"), 128);
        assert_eq!(
            slot_of(&decode_subs(&b).1, SLOT_REQUEST_ID),
            Some(&b"rid-b"[..])
        );
        // No body → not valid → set_a → no slots.
        let a = run_out(&r, &frame_with_rid(b"", b"", None, b"rid-a"), 128);
        assert!(decode_subs(&a).1.is_empty());
    }

    #[test]
    fn program_security_and_set_header_ops_are_accepted_but_emit_nothing() {
        // v6: static security headers + set_header are baked into the JS class
        // templates by the program builder. The executor still accepts and
        // const-validates both ops; they contribute no wire output.
        let set = ok_set(b"{}");
        let sec = header_list(&[(b"x-content-type-options", b"nosniff")]);
        let name = b"x-custom";
        let value = b"v-{requestId}";
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &sec, name, value],
            &[
                (OP_SECURITY_HEADERS, 1, 0, 0),
                (OP_SET_HEADER, 2, 3, SET_VALUE_CONST),
                (OP_RESPONSE_PROJECTION, 0, 0, 0),
            ],
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let f = frame_pre(b"", b"", None, Some(b"abc"), Some(0), None, None, false);
        let wire = run_out(&r, &f, 512);
        let (class, subs) = decode_subs(&wire);
        assert_eq!(class, CLASS_OK_NO_ORIGIN);
        assert!(subs.is_empty());
    }

    #[test]
    fn program_needed_size_convention_response() {
        let set = ok_set(b"{\"ok\":true,\"requestId\":\"{requestId}\"}");
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set],
            &[(OP_RESPONSE_PROJECTION, 0, 0, 0)],
        );
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let f = frame_with_rid(b"", b"", None, b"0193f2c4-0000-7000-8000-000000000000");
        let mut small = [0u8; 8];
        let needed = r.run(&f, &mut small).unwrap();
        assert!(needed > 8);
        assert_eq!(small, [0u8; 8]);
        let mut big = vec![0u8; needed];
        assert_eq!(r.run(&f, &mut big).unwrap(), needed);
    }

    #[test]
    fn program_missing_required_class_is_rejected() {
        // `schema_validate` references a set without the 422 class.
        let set = response_set(&[(CLASS_OK_NO_ORIGIN, response_payload(200, &[], b"{}"))]);
        let schema = br#"{"type":"object"}"#;
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &schema[..]],
            &[
                (OP_JSON_VALID, 0, 0, 0),
                (OP_SCHEMA_VALIDATE, 1, 0, 1),
                (OP_RESPONSE_PROJECTION, 0, 0, 0),
            ],
        );
        assert!(NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).is_err());
    }

    #[test]
    fn program_ip_trust_and_limits_run() {
        // A program that resolves the client IP, enforces the body limit, then
        // projects. Exercises the ip_trust + limits ops.
        let set = response_set(&[
            (CLASS_OK_NO_ORIGIN, response_payload(200, &[], b"ok")),
            (CLASS_BODY_TOO_LARGE, response_payload(413, &[], b"big")),
        ]);
        let ipcfg = ip_trust_config(2, &[b"10.0.0.0/8"]);
        let prog = program_payload(
            PROGRAM_REGISTRY_VERSION,
            &[&set, &ipcfg],
            &[
                (OP_IP_TRUST, 1, 0, 0),
                (OP_LIMITS, 1, 0, 0),
                (OP_RESPONSE_PROJECTION, 0, 0, 0),
            ],
        );
        // maxBodyBytes from `descriptor` is 2 MiB, so a small body passes.
        let r = NativeRoute::compile(&descriptor(&[], &[(PART_PROGRAM, &prog)])).unwrap();
        let wire = run_out(
            &r,
            &frame_pre(
                b"",
                b"",
                Some(b"{}"),
                None,
                Some(0),
                Some(b"10.1.2.3"),
                None,
                false,
            ),
            256,
        );
        let (class, _) = decode_subs(&wire);
        assert_eq!(class, CLASS_OK_NO_ORIGIN);
        assert_eq!(result_code(&wire), 0);
    }

    #[test]
    fn compile_rejects_v5_descriptor_with_version_error() {
        let mut d = descriptor(&[STAGE_PARSE_QUERY], &[]);
        d[4..8].copy_from_slice(&5u32.to_le_bytes());
        let err = match NativeRoute::compile(&d) {
            Ok(_) => panic!("a v5 descriptor must be rejected by the v6 stack"),
            Err(e) => e,
        };
        assert!(err.contains("unsupported version 5"), "got: {err}");
    }
}
