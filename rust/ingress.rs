// rust/ingress.rs — PRODUCTION OPTIMIZED FOR BUN 1.4
//
// Key optimizations:
// - Pre-indexed known headers (O(1) lookup vs O(n) scan)
// - Thread-local batched RNG for trace/span IDs
// - Tiered output format (minimal for continue, full for rejections)
// - Rate limiter short-circuit when limit == u32::MAX
// - No path/query/body echo (JS already owns these)
// - Stack-allocated response header builder
// - Zero heap allocation in hot path for simple requests

use napi::bindgen_prelude::*;
use napi::{Env, Status};
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hashing::{fast_hash_bytes, fast_hash_cache_key, fast_hash_seeded};
use crate::util::trim_ascii_whitespace;

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

// ── Static constants ──
const APPLICATION_JSON: &[u8] = b"application/json";

const H_ACCESS_CONTROL_ALLOW_ORIGIN: &[u8] = b"Access-Control-Allow-Origin";
const H_ACCESS_CONTROL_ALLOW_CREDENTIALS: &[u8] = b"Access-Control-Allow-Credentials";
const H_ACCESS_CONTROL_ALLOW_METHODS: &[u8] = b"Access-Control-Allow-Methods";
const H_ACCESS_CONTROL_ALLOW_HEADERS: &[u8] = b"Access-Control-Allow-Headers";
const H_ACCESS_CONTROL_EXPOSE_HEADERS: &[u8] = b"Access-Control-Expose-Headers";
const H_ACCESS_CONTROL_MAX_AGE: &[u8] = b"Access-Control-Max-Age";
const H_VARY: &[u8] = b"Vary";
const H_RATELIMIT_LIMIT: &[u8] = b"RateLimit-Limit";
const H_RATELIMIT_REMAINING: &[u8] = b"RateLimit-Remaining";
const H_RATELIMIT_RESET: &[u8] = b"RateLimit-Reset";
const H_RETRY_AFTER: &[u8] = b"Retry-After";
const H_CONTENT_TYPE: &[u8] = b"Content-Type";
const H_X_REQUEST_ID: &[u8] = b"X-Request-Id";
const H_X_TRACE_ID: &[u8] = b"X-Trace-Id";
const H_X_SPAN_ID: &[u8] = b"X-Span-Id";

static EMPTY_PAIRS: [u8; 4] = [0u8, 0u8, 0u8, 0u8];

static ERR_CORS_PREFLIGHT: &[u8] =
    br#"{"error":{"code":"cors_preflight_not_allowed","message":"CORS preflight not allowed"}}"#;
static ERR_BODY_TOO_LARGE: &[u8] =
    br#"{"error":{"code":"body_too_large","message":"Request body is too large"}}"#;
static ERR_INVALID_JSON: &[u8] =
    br#"{"error":{"code":"invalid_json","message":"Invalid JSON body"}}"#;
static ERR_SCHEMA_VALIDATION: &[u8] =
    br#"{"error":{"code":"schema_validation_failed","message":"Request body failed schema validation"}}"#;

// ── Method classification ──
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
fn classify_method_bytes(method: &[u8]) -> MethodKind {
    match method.len() {
        3 => {
            if method.eq_ignore_ascii_case(b"GET") {
                MethodKind::Get
            } else if method.eq_ignore_ascii_case(b"PUT") {
                MethodKind::Put
            } else {
                MethodKind::Other
            }
        }
        4 => {
            if method.eq_ignore_ascii_case(b"POST") {
                MethodKind::Post
            } else if method.eq_ignore_ascii_case(b"HEAD") {
                MethodKind::Head
            } else {
                MethodKind::Other
            }
        }
        5 => {
            if method.eq_ignore_ascii_case(b"PATCH") {
                MethodKind::Patch
            } else {
                MethodKind::Other
            }
        }
        6 => {
            if method.eq_ignore_ascii_case(b"DELETE") {
                MethodKind::Delete
            } else {
                MethodKind::Other
            }
        }
        7 => {
            if method.eq_ignore_ascii_case(b"OPTIONS") {
                MethodKind::Options
            } else {
                MethodKind::Other
            }
        }
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

// ── Pre-indexed packed headers ──
// Instead of O(n) linear scan per lookup, we index known headers during parse.
// Unknown headers are still stored for iteration but known ones are O(1).

const MAX_INLINE_HEADERS: usize = 32;

/// Indices into the offsets array for known headers.
/// u16::MAX means "not present".
const IDX_NONE: u16 = u16::MAX;

struct PackedHeaders<'a> {
    data: &'a [u8],
    // (name_start, name_end, value_start, value_end)
    offsets: smallvec::SmallVec<[(u32, u32, u32, u32); MAX_INLINE_HEADERS]>,
    // Pre-computed indices for known headers (value_start, value_end)
    origin: Option<(u32, u32)>,
    cookie: Option<(u32, u32)>,
    xff: Option<(u32, u32)>,
    x_real_ip: Option<(u32, u32)>,
    x_forwarded_proto: Option<(u32, u32)>,
    acrm: Option<(u32, u32)>,  // access-control-request-method
    acrh: Option<(u32, u32)>,  // access-control-request-headers
}

impl<'a> PackedHeaders<'a> {
    #[inline(always)]
    fn parse(packed: &'a [u8]) -> Self {
        let mut result = Self {
            data: packed,
            offsets: smallvec::SmallVec::new(),
            origin: None,
            cookie: None,
            xff: None,
            x_real_ip: None,
            x_forwarded_proto: None,
            acrm: None,
            acrh: None,
        };

        if packed.len() < 2 {
            return result;
        }

        let count = u16::from_le_bytes([packed[0], packed[1]]) as usize;
        let mut pos = 2usize;

        for _ in 0..count {
            if pos.saturating_add(2) > packed.len() {
                break;
            }
            let name_len = u16::from_le_bytes([packed[pos], packed[pos + 1]]) as usize;
            pos += 2;
            let name_start = pos;
            let Some(name_end) = name_start.checked_add(name_len) else {
                break;
            };
            if name_end > packed.len() {
                break;
            }
            pos = name_end;

            if pos.saturating_add(4) > packed.len() {
                break;
            }
            let value_len = u32::from_le_bytes([
                packed[pos],
                packed[pos + 1],
                packed[pos + 2],
                packed[pos + 3],
            ]) as usize;
            pos += 4;
            let value_start = pos;
            let Some(value_end) = value_start.checked_add(value_len) else {
                break;
            };
            if value_end > packed.len() {
                break;
            }
            pos = value_end;

            let ns = name_start as u32;
            let ne = name_end as u32;
            let vs = value_start as u32;
            let ve = value_end as u32;

            // Pre-index known headers during parse (single pass)
            let name = &packed[name_start..name_end];
            match name.len() {
                6 => {
                    if name == b"origin" {
                        result.origin = Some((vs, ve));
                    } else if name == b"cookie" {
                        result.cookie = Some((vs, ve));
                    }
                }
                15 => {
                    if name == b"x-forwarded-for" {
                        result.xff = Some((vs, ve));
                    }
                }
                10 => {
                    if name == b"x-real-ip" {
                        // x-real-ip is 9 bytes, but check anyway
                    }
                }
                9 => {
                    if name == b"x-real-ip" {
                        result.x_real_ip = Some((vs, ve));
                    }
                }
                17 => {
                    if name == b"x-forwarded-proto" {
                        result.x_forwarded_proto = Some((vs, ve));
                    }
                }
                31 => {
                    if name == b"access-control-request-method" {
                        result.acrm = Some((vs, ve));
                    }
                }
                32 => {
                    if name == b"access-control-request-headers" {
                        result.acrh = Some((vs, ve));
                    }
                }
                _ => {}
            }

            result.offsets.push((ns, ne, vs, ve));
        }

        result
    }

    /// O(1) lookup for pre-indexed headers.
    #[inline(always)]
    fn get_origin(&self) -> Option<&'a [u8]> {
        self.origin.map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_cookie(&self) -> Option<&'a [u8]> {
        self.cookie.map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_xff(&self) -> Option<&'a [u8]> {
        self.xff.map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_x_real_ip(&self) -> Option<&'a [u8]> {
        self.x_real_ip.map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_x_forwarded_proto(&self) -> Option<&'a [u8]> {
        self.x_forwarded_proto
            .map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_acrm(&self) -> Option<&'a [u8]> {
        self.acrm.map(|(s, e)| &self.data[s as usize..e as usize])
    }

    #[inline(always)]
    fn get_acrh(&self) -> Option<&'a [u8]> {
        self.acrh.map(|(s, e)| &self.data[s as usize..e as usize])
    }
}

// ── Packed request meta parsing ──
struct RequestMeta<'a> {
    method: &'a [u8],
    url: &'a [u8],
    socket_ip: &'a [u8],
    headers: PackedHeaders<'a>,
}

#[inline(always)]
fn read_u16(data: &[u8], pos: &mut usize) -> Result<u16> {
    let end = pos
        .checked_add(2)
        .ok_or_else(|| Error::new(Status::InvalidArg, "meta: truncated u16"))?;
    if end > data.len() {
        return Err(Error::new(Status::InvalidArg, "meta: truncated u16"));
    }
    let v = u16::from_le_bytes([data[*pos], data[*pos + 1]]);
    *pos = end;
    Ok(v)
}

#[inline(always)]
fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32> {
    let end = pos
        .checked_add(4)
        .ok_or_else(|| Error::new(Status::InvalidArg, "meta: truncated u32"))?;
    if end > data.len() {
        return Err(Error::new(Status::InvalidArg, "meta: truncated u32"));
    }
    let v = u32::from_le_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
    *pos = end;
    Ok(v)
}

#[inline(always)]
fn read_slice<'a>(data: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = pos
        .checked_add(len)
        .ok_or_else(|| Error::new(Status::InvalidArg, "meta: length overflow"))?;
    if end > data.len() {
        return Err(Error::new(Status::InvalidArg, "meta: truncated bytes"));
    }
    let out = &data[*pos..end];
    *pos = end;
    Ok(out)
}

#[inline(always)]
fn parse_request_meta(meta: &[u8]) -> Result<RequestMeta<'_>> {
    let mut pos = 0usize;
    let method_len = read_u16(meta, &mut pos)? as usize;
    let method = read_slice(meta, &mut pos, method_len)?;
    let url_len = read_u32(meta, &mut pos)? as usize;
    let url = read_slice(meta, &mut pos, url_len)?;
    let socket_ip_len = read_u16(meta, &mut pos)? as usize;
    let socket_ip = read_slice(meta, &mut pos, socket_ip_len)?;
    let packed_headers_len = read_u32(meta, &mut pos)? as usize;
    let packed_headers = read_slice(meta, &mut pos, packed_headers_len)?;
    let headers = PackedHeaders::parse(packed_headers);
    Ok(RequestMeta {
        method,
        url,
        socket_ip,
        headers,
    })
}

// ── Sharded rate limiter with short-circuit ──
const RATE_SHARDS: usize = 16;

struct RateBucket {
    prev: u32,
    curr: u32,
    window_start: u64,
    expires_at: u64,
}

struct RateShard {
    map: parking_lot::Mutex<hashbrown::HashMap<u64, RateBucket>>,
}

static RATE_SHARDS_STATE: OnceLock<[RateShard; RATE_SHARDS]> = OnceLock::new();
static LIMITER_ID: AtomicU64 = AtomicU64::new(0);

fn rate_shards() -> &'static [RateShard; RATE_SHARDS] {
    RATE_SHARDS_STATE.get_or_init(|| {
        std::array::from_fn(|_| RateShard {
            map: parking_lot::Mutex::new(hashbrown::HashMap::with_capacity(1024)),
        })
    })
}

struct RateLimitPolicy {
    limit: u32,
    window_ms: u64,
    key_base: u64,
    /// If true, rate limiting is effectively disabled (limit == u32::MAX).
    disabled: bool,
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

fn rate_limit_check(key: u64, limit: u32, window_ms: u64, now_ms: u64) -> (bool, u32, u64) {
    let window = window_ms.max(1);
    let shard_idx = (key as usize) & (RATE_SHARDS - 1);
    let shard = &rate_shards()[shard_idx];
    let mut map = shard.map.lock();

    if map.len() > 12_500 {
        map.retain(|_, b| b.expires_at > now_ms);
    }

    let entry = map.entry(key).or_insert(RateBucket {
        prev: 0,
        curr: 0,
        window_start: now_ms,
        expires_at: now_ms.saturating_add(window.saturating_mul(2)),
    });

    let mut elapsed = now_ms.saturating_sub(entry.window_start);
    if elapsed >= window.saturating_mul(2) {
        entry.prev = 0;
        entry.curr = 0;
        entry.window_start = now_ms;
        elapsed = 0;
    } else if elapsed >= window {
        entry.prev = entry.curr;
        entry.curr = 0;
        entry.window_start = entry.window_start.saturating_add(window);
        elapsed = elapsed.saturating_sub(window);
    }

    let overlap = window.saturating_sub(elapsed);
    let weighted = ((entry.prev as u64) * overlap / window) + entry.curr as u64;
    let reset = entry.window_start.saturating_add(window);
    entry.expires_at = reset.saturating_add(window);

    if weighted < limit as u64 {
        entry.curr = entry.curr.saturating_add(1);
        let remaining = (limit as u64).saturating_sub(weighted.saturating_add(1)) as u32;
        (true, remaining, reset)
    } else {
        (false, 0, reset)
    }
}

// ── Time helpers ──
static RATE_START: OnceLock<std::time::Instant> = OnceLock::new();
static WALL_OFFSET_MS: OnceLock<i128> = OnceLock::new();

#[inline(always)]
fn rate_start() -> &'static std::time::Instant {
    RATE_START.get_or_init(std::time::Instant::now)
}

#[inline(always)]
fn monotonic_ms() -> u64 {
    rate_start().elapsed().as_millis() as u64
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

// ── Thread-local batched ID generation ──
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

const ID_POOL_SIZE: usize = 64;

struct IdPool {
    trace_raw: [[u8; 32]; ID_POOL_SIZE],
    span_raw: [[u8; 16]; ID_POOL_SIZE],
    pos: usize,
}

impl IdPool {
    fn new() -> Self {
        Self {
            trace_raw: [[0u8; 32]; ID_POOL_SIZE],
            span_raw: [[0u8; 16]; ID_POOL_SIZE],
            pos: ID_POOL_SIZE, // Force refill on first use
        }
    }

    #[inline(always)]
    fn refill(&mut self) {
        // Single syscall for all IDs in the batch
        let trace_bytes: &mut [u8] =
            unsafe { std::slice::from_raw_parts_mut(self.trace_raw.as_mut_ptr() as *mut u8, ID_POOL_SIZE * 32) };
        let span_bytes: &mut [u8] =
            unsafe { std::slice::from_raw_parts_mut(self.span_raw.as_mut_ptr() as *mut u8, ID_POOL_SIZE * 16) };

        #[cfg(feature = "fast-ids")]
        {
            let mut rng = fastrand::Rng::new();
            rng.fill(trace_bytes);
            rng.fill(span_bytes);
        }
        #[cfg(not(feature = "fast-ids"))]
        {
            let _ = getrandom::fill(trace_bytes);
            let _ = getrandom::fill(span_bytes);
        }

        self.pos = 0;
    }

    #[inline(always)]
    fn next(&mut self) -> (&[u8; 32], &[u8; 16]) {
        if self.pos >= ID_POOL_SIZE {
            self.refill();
        }
        let idx = self.pos;
        self.pos += 1;
        (&self.trace_raw[idx], &self.span_raw[idx])
    }
}

thread_local! {
    static ID_POOL: std::cell::RefCell<IdPool> = std::cell::RefCell::new(IdPool::new());
}

#[inline(always)]
fn hex_encode_lower(bytes: &[u8], out: &mut [u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for (i, &b) in bytes.iter().enumerate() {
        out[2 * i] = HEX[(b >> 4) as usize];
        out[2 * i + 1] = HEX[(b & 0x0f) as usize];
    }
}

fn base36_inline(mut n: u64) -> arrayvec::ArrayString<13> {
    const BASE36: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = arrayvec::ArrayString::<13>::new();
    if n == 0 {
        let _ = out.try_push('0');
        return out;
    }
    let mut digits = [0u8; 13];
    let mut i = 0;
    while n > 0 {
        digits[i] = BASE36[(n % 36) as usize];
        n /= 36;
        i += 1;
    }
    for &d in digits[..i].iter().rev() {
        let _ = out.try_push(d as char);
    }
    out
}

struct Ids {
    request_id: [u8; 32],
    request_id_len: u8,
    trace_hex: [u8; 64],
    span_hex: [u8; 32],
}

#[inline(always)]
fn generate_ids() -> Ids {
    let now = wall_now_ms();
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff;

    // Request ID: base36(timestamp)-base36(counter)
    let mut request_id = [0u8; 32];
    let mut pos = 0u8;
    let ts_str = base36_inline(now);
    let ts_bytes = ts_str.as_bytes();
    request_id[..ts_bytes.len()].copy_from_slice(ts_bytes);
    pos += ts_bytes.len() as u8;
    request_id[pos as usize] = b'-';
    pos += 1;
    let ctr_str = base36_inline(counter);
    let ctr_bytes = ctr_str.as_bytes();
    request_id[pos as usize..pos as usize + ctr_bytes.len()].copy_from_slice(ctr_bytes);
    pos += ctr_bytes.len() as u8;

    // Trace + Span from pooled RNG
    let mut trace_hex = [0u8; 64];
    let mut span_hex = [0u8; 32];

    ID_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let (trace_raw, span_raw) = pool.next();
        hex_encode_lower(trace_raw, &mut trace_hex);
        hex_encode_lower(span_raw, &mut span_hex);
    });

    Ids {
        request_id,
        request_id_len: pos,
        trace_hex,
        span_hex,
    }
}

// ── Response header builder (stack-allocated, zero heap) ──
const MAX_RESPONSE_HEADERS: usize = 24;

enum HeaderValue<'a> {
    Static(&'static [u8]),
    Borrowed(&'a [u8]),
    Inline([u8; 64], u8),
}

impl<'a> HeaderValue<'a> {
    #[inline(always)]
    fn as_slice(&self) -> &[u8] {
        match self {
            HeaderValue::Static(s) => s,
            HeaderValue::Borrowed(s) => s,
            HeaderValue::Inline(buf, len) => &buf[..*len as usize],
        }
    }
}

struct ResponseHeaderSlot<'a> {
    name: &'static [u8],
    value: HeaderValue<'a>,
}

struct ResponseHeaderBuilder<'a> {
    slots: [Option<ResponseHeaderSlot<'a>>; MAX_RESPONSE_HEADERS],
    count: usize,
}

impl<'a> ResponseHeaderBuilder<'a> {
    #[inline(always)]
    fn new() -> Self {
        Self {
            slots: [const { None }; MAX_RESPONSE_HEADERS],
            count: 0,
        }
    }

    #[inline(always)]
    fn push_static(&mut self, name: &'static [u8], value: &'static [u8]) {
        if self.count < MAX_RESPONSE_HEADERS {
            self.slots[self.count] = Some(ResponseHeaderSlot {
                name,
                value: HeaderValue::Static(value),
            });
            self.count += 1;
        }
    }

    #[inline(always)]
    fn push_borrow(&mut self, name: &'static [u8], value: &'a [u8]) {
        if self.count < MAX_RESPONSE_HEADERS {
            self.slots[self.count] = Some(ResponseHeaderSlot {
                name,
                value: HeaderValue::Borrowed(value),
            });
            self.count += 1;
        }
    }

    #[inline(always)]
    fn push_inline(&mut self, name: &'static [u8], value: &[u8]) {
        if self.count >= MAX_RESPONSE_HEADERS || value.len() > 64 {
            return;
        }
        let mut buf = [0u8; 64];
        buf[..value.len()].copy_from_slice(value);
        self.slots[self.count] = Some(ResponseHeaderSlot {
            name,
            value: HeaderValue::Inline(buf, value.len() as u8),
        });
        self.count += 1;
    }

    #[inline(always)]
    fn push_u32(&mut self, name: &'static [u8], value: u32) {
        let mut buf = itoa::Buffer::new();
        let s = buf.format(value);
        self.push_inline(name, s.as_bytes());
    }

    #[inline(always)]
    fn push_u64(&mut self, name: &'static [u8], value: u64) {
        let mut buf = itoa::Buffer::new();
        let s = buf.format(value);
        self.push_inline(name, s.as_bytes());
    }

    #[inline(always)]
    fn packed_size(&self) -> usize {
        let mut total = 4; // count u32
        for i in 0..self.count {
            if let Some(slot) = &self.slots[i] {
                let value = slot.value.as_slice();
                total += 4 + slot.name.len() + 4 + value.len();
            }
        }
        total
    }

    fn write_packed(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&(self.count as u32).to_le_bytes());
        for i in 0..self.count {
            if let Some(slot) = &self.slots[i] {
                out.extend_from_slice(&(slot.name.len() as u32).to_le_bytes());
                out.extend_from_slice(slot.name);
                let val = slot.value.as_slice();
                out.extend_from_slice(&(val.len() as u32).to_le_bytes());
                out.extend_from_slice(val);
            }
        }
    }
}

// ── NAPI option structs ──
#[napi(object)]
#[derive(Default)]
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
#[derive(Default)]
pub struct CorsOptions {
    pub allow_origin: Option<Vec<String>>,
    pub allow_methods: Option<Vec<String>>,
    pub allow_headers: Option<Vec<String>>,
    pub expose_headers: Option<Vec<String>>,
    pub allow_credentials: Option<bool>,
    pub max_age: Option<u32>,
}

#[napi(object)]
#[derive(Default)]
pub struct RateLimitOptions {
    pub limit: Option<u32>,
    pub window_ms: Option<u32>,
}

#[napi(object)]
#[derive(Default)]
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
}

// ── Ingress class ──
#[napi]
pub struct Ingress {
    trust_proxy: bool,
    parse_cookies: bool,
    parse_query: bool,
    https_fixed: Option<bool>,
    max_body_bytes: usize,
    enable_security_headers: bool,
    enable_request_ids: bool,
    enable_cache_key: bool,
    enable_path_query: bool,
    enable_body_size_guard: bool,
    body_mode: BodyMode,
    cors: Option<CorsEngine>,
    rate: Option<RateLimitPolicy>,
    security_http: Vec<(&'static [u8], Vec<u8>)>,
    security_https: Vec<(&'static [u8], Vec<u8>)>,
}

enum BodyMode {
    Ignore,
    Json,
    JsonSchema(Arc<jsonschema::Validator>),
}

use std::sync::Arc;

enum CorsMode {
    Wildcard,
    Allowlist(Vec<Vec<u8>>),
}

struct CorsEngine {
    mode: CorsMode,
    credentials: bool,
    allow_methods: Vec<u8>,
    allow_headers: Option<Vec<u8>>,
    expose_headers: Option<Vec<u8>>,
    max_age: Option<Vec<u8>>,
}

struct CorsEvaluation {
    allowed: bool,
    preflight: bool,
}

#[napi]
impl Ingress {
    #[napi(constructor)]
    pub fn new(options: IngressOptions) -> Result<Self> {
        let trust_proxy = options.trust_proxy.unwrap_or(false);
        let parse_cookies = options.parse_cookies.unwrap_or(true);
        let parse_query = options.parse_query.unwrap_or(true);
        let require_json_body = options.require_json_body.unwrap_or(false);
        let enable_security_headers = options.enable_security_headers.unwrap_or(true);
        let enable_request_ids = options.enable_request_ids.unwrap_or(true);
        let enable_cache_key = options.enable_cache_key.unwrap_or(true);
        let enable_path_query = options.enable_path_query.unwrap_or(true);
        let enable_body_size_guard = options.enable_body_size_guard.unwrap_or(true);
        let max_body_bytes = match options.max_body_bytes {
            Some(0) => usize::MAX,
            Some(v) => v as usize,
            None => 8 * 1024 * 1024,
        };

        let body_mode = if let Some(schema_bytes) = options.schema {
            let schema_value: serde_json::Value = sonic_rs::from_slice(schema_bytes.as_ref())
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON: {}", e)))?;
            let compiled = jsonschema::validator_for(&schema_value)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Schema compile: {}", e)))?;
            BodyMode::JsonSchema(Arc::new(compiled))
        } else if require_json_body {
            BodyMode::Json
        } else {
            BodyMode::Ignore
        };

        let cors = options.cors.map(CorsEngine::from_options);
        let rate = options
            .rate_limit
            .map(|rl| RateLimitPolicy::new(rl.limit.unwrap_or(100), rl.window_ms.unwrap_or(60_000)));

        let security_cfg = options.security.unwrap_or_default();
        let security_http = if enable_security_headers {
            build_security_headers_vec(&security_cfg, false)
        } else {
            Vec::new()
        };
        let security_https = if enable_security_headers {
            build_security_headers_vec(&security_cfg, true)
        } else {
            Vec::new()
        };

        Ok(Self {
            trust_proxy,
            parse_cookies,
            parse_query,
            https_fixed: options.https,
            max_body_bytes,
            body_mode,
            cors,
            rate,
            security_http,
            security_https,
            enable_body_size_guard,
            enable_cache_key,
            enable_path_query,
            enable_request_ids,
            enable_security_headers,
        })
    }

    /// Optimized entrypoint for Bun 1.4.
    ///
    /// Meta format (unchanged):
    ///   [u16 method_len][method]
    ///   [u32 url_len][url]
    ///   [u16 socket_ip_len][socket_ip]
    ///   [u32 packed_headers_len][packed_headers]
    ///
    /// Output format v3 (BREAKING — smaller, no redundant data):
    ///   [u8 version=3]
    ///   [u8 verdict]
    ///   [u16 status]
    ///   [u32 flags]
    ///   [u64 cache_key]
    ///   [u32 request_id_len][request_id]
    ///   [u32 trace_id_len][trace_id]
    ///   [u32 span_id_len][span_id]
    ///   [u32 rate_remaining]
    ///   [u64 rate_reset_ms]
    ///   [u32 response_headers_count]
    ///   repeated: [u32 name_len][name][u32 value_len][value]
    ///   [u32 cookies_len][cookies_packed]
    ///   [u32 query_len][query_packed]
    ///   [u32 error_body_len][error_body]
    ///
    /// REMOVED from output (JS already has these):
    ///   - path (JS has req.url)
    ///   - raw_query (JS has req.url)
    ///   - body (JS owns it, never echoed)
    #[napi(ts_args_type = "meta: Uint8Array, body: Uint8Array | null")]
    pub fn handle_packed(
        &self,
        _env: Env,
        meta: Uint8Array,
        body: Option<Uint8Array>,
    ) -> Result<Buffer> {
        let req = parse_request_meta(meta.as_ref())?;
        let body_bytes: Option<&[u8]> = body.as_ref().map(|b| b.as_ref());
        let out = self.process_packed(&req, body_bytes)?;
        Ok(Buffer::from(out))
    }
}

impl Ingress {
    fn process_packed(&self, req: &RequestMeta, body: Option<&[u8]>) -> Result<Vec<u8>> {
        let method_kind = classify_method_bytes(req.method);

        let (path, raw_query) = if self.enable_path_query {
            extract_path_query(req.url)
        } else {
            (&b"/"[..], &[][..])
        };

        // IP extraction using pre-indexed headers (O(1))
        let candidate_ip = extract_ip_packed(&req.headers, req.socket_ip, self.trust_proxy);
        let ip: &[u8] = if self.trust_proxy
            && !candidate_ip.is_empty()
            && !crate::validation::validate_ipv4_bytes(candidate_ip)
            && !crate::validation::validate_ipv6_bytes(candidate_ip)
            && !req.socket_ip.is_empty()
        {
            req.socket_ip
        } else {
            candidate_ip
        };

        let https = request_is_https_packed(req.url, &req.headers, self.trust_proxy, self.https_fixed);

        let mut flags: u32 = 0;
        if https {
            flags |= FLAG_HTTPS;
        }
        if self.trust_proxy {
            flags |= FLAG_TRUSTED_PROXY;
        }

        let cache_key = if self.enable_cache_key {
            fast_hash_cache_key(req.method, path, raw_query)
        } else {
            0
        };

        let mut resp_headers = ResponseHeaderBuilder::new();

        if self.enable_security_headers {
            let sec = if https { &self.security_https } else { &self.security_http };
            for (name, value) in sec {
                resp_headers.push_borrow(name, value.as_slice());
            }
        }

        // CORS evaluation using pre-indexed headers
        let mut cors_allowed = false;
        let mut is_preflight = false;
        if let Some(cors_engine) = &self.cors {
            if req.headers.get_origin().is_some() {
                let eval = cors_engine.evaluate_into(method_kind, &req.headers, &mut resp_headers);
                cors_allowed = eval.allowed;
                is_preflight = eval.preflight;
                if cors_allowed {
                    flags |= FLAG_CORS_ALLOWED;
                }
                if is_preflight {
                    flags |= FLAG_IS_PREFLIGHT;
                }
            }
        }

        // CORS preflight short-circuit
        if is_preflight {
            if cors_allowed {
                let ids = if self.enable_request_ids {
                    let ids = generate_ids();
                    resp_headers.push_inline(H_X_REQUEST_ID, &ids.request_id[..ids.request_id_len as usize]);
                    resp_headers.push_inline(H_X_TRACE_ID, &ids.trace_hex);
                    resp_headers.push_inline(H_X_SPAN_ID, &ids.span_hex);
                    Some(ids)
                } else {
                    None
                };
                return Ok(self.pack_output_v3(
                    2, 204, flags, cache_key, &resp_headers, ids.as_ref(),
                    0, 0,
                    EMPTY_PAIRS.as_slice(), EMPTY_PAIRS.as_slice(), &[],
                ));
            } else {
                resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
                return Ok(self.pack_output_v3(
                    1, 403, flags, cache_key, &resp_headers, None,
                    0, 0,
                    EMPTY_PAIRS.as_slice(), EMPTY_PAIRS.as_slice(), ERR_CORS_PREFLIGHT,
                ));
            }
        }

        // Rate limiting with short-circuit
        let mut rate_remaining: u32 = 0;
        let mut rate_reset_ms: u64 = 0;
        if let Some(policy) = &self.rate {
            if policy.disabled {
                // Short-circuit: no mutex, no hashmap, no math
                rate_remaining = policy.limit.saturating_sub(1);
                rate_reset_ms = rate_now_ms().saturating_add(policy.window_ms);
                resp_headers.push_u32(H_RATELIMIT_LIMIT, policy.limit);
                resp_headers.push_u32(H_RATELIMIT_REMAINING, rate_remaining);
                resp_headers.push_u64(H_RATELIMIT_RESET, rate_reset_ms / 1000);
            } else {
                let now = rate_now_ms();
                let key = fast_hash_seeded(ip, policy.key_base);
                let (allowed, remaining, reset_ms) =
                    rate_limit_check(key, policy.limit, policy.window_ms, now);
                rate_remaining = remaining;
                rate_reset_ms = reset_ms;
                resp_headers.push_u32(H_RATELIMIT_LIMIT, policy.limit);
                resp_headers.push_u32(H_RATELIMIT_REMAINING, remaining);
                resp_headers.push_u64(H_RATELIMIT_RESET, reset_ms / 1000);

                if !allowed {
                    flags |= FLAG_RATE_LIMITED;
                    let retry_ms = reset_ms.saturating_sub(now);
                    let retry_secs = (retry_ms + 999) / 1000;
                    resp_headers.push_u64(H_RETRY_AFTER, retry_secs);
                    resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
                    let mut err_buf = [0u8; 128];
                    let err_len = write_rate_limit_error(&mut err_buf, retry_ms);
                    return Ok(self.pack_output_v3(
                        1, 429, flags, cache_key, &resp_headers, None,
                        rate_remaining, rate_reset_ms,
                        EMPTY_PAIRS.as_slice(), EMPTY_PAIRS.as_slice(), &err_buf[..err_len],
                    ));
                }
            }
        }

        let body_bytes = body.unwrap_or(&[]);

        // Body size guard
        if self.enable_body_size_guard && body_bytes.len() > self.max_body_bytes {
            resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
            return Ok(self.pack_output_v3(
                1, 413, flags, cache_key, &resp_headers, None,
                rate_remaining, rate_reset_ms,
                EMPTY_PAIRS.as_slice(), EMPTY_PAIRS.as_slice(), ERR_BODY_TOO_LARGE,
            ));
        }

        // Cookies parsing using pre-indexed header
        let cookies_packed: std::borrow::Cow<[u8]> = if self.parse_cookies {
            match req.headers.get_cookie() {
                Some(cookie) if !cookie.is_empty() => {
                    std::borrow::Cow::Owned(parse_cookies_packed_exact(cookie))
                }
                _ => std::borrow::Cow::Borrowed(EMPTY_PAIRS.as_slice()),
            }
        } else {
            std::borrow::Cow::Borrowed(EMPTY_PAIRS.as_slice())
        };
        if packed_count(cookies_packed.as_ref()) > 0 {
            flags |= FLAG_HAS_COOKIES;
        }

        // Query parsing
        let query_packed: std::borrow::Cow<[u8]> = if self.parse_query && !raw_query.is_empty() {
            std::borrow::Cow::Owned(parse_query_packed_exact(raw_query))
        } else {
            std::borrow::Cow::Borrowed(EMPTY_PAIRS.as_slice())
        };
        if packed_count(query_packed.as_ref()) > 0 {
            flags |= FLAG_HAS_QUERY;
        }

        // Request IDs
        let ids = if self.enable_request_ids {
            let ids = generate_ids();
            resp_headers.push_inline(H_X_REQUEST_ID, &ids.request_id[..ids.request_id_len as usize]);
            resp_headers.push_inline(H_X_TRACE_ID, &ids.trace_hex);
            resp_headers.push_inline(H_X_SPAN_ID, &ids.span_hex);
            Some(ids)
        } else {
            None
        };

        // Body validation
        let enforce_body = match &self.body_mode {
            BodyMode::Ignore => false,
            BodyMode::Json | BodyMode::JsonSchema(_) => {
                method_may_have_body(method_kind) || !body_bytes.is_empty()
            }
        };

        if enforce_body {
            match &self.body_mode {
                BodyMode::Ignore => {}
                BodyMode::Json => {
                    if body_bytes.is_empty() || !crate::json_ops::json_valid_bytes(body_bytes) {
                        resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
                        return Ok(self.pack_output_v3(
                            1, 400, flags, cache_key, &resp_headers, ids.as_ref(),
                            rate_remaining, rate_reset_ms,
                            cookies_packed.as_ref(), query_packed.as_ref(), ERR_INVALID_JSON,
                        ));
                    }
                    flags |= FLAG_BODY_VALID_JSON;
                }
                BodyMode::JsonSchema(validator) => {
                    let doc: serde_json::Value = match sonic_rs::from_slice(body_bytes) {
                        Ok(doc) => doc,
                        Err(_) => {
                            resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
                            return Ok(self.pack_output_v3(
                                1, 400, flags, cache_key, &resp_headers, ids.as_ref(),
                                rate_remaining, rate_reset_ms,
                                cookies_packed.as_ref(), query_packed.as_ref(), ERR_INVALID_JSON,
                            ));
                        }
                    };
                    flags |= FLAG_BODY_VALID_JSON;
                    if validator.is_valid(&doc) {
                        flags |= FLAG_SCHEMA_VALID;
                    } else {
                        resp_headers.push_static(H_CONTENT_TYPE, APPLICATION_JSON);
                        return Ok(self.pack_output_v3(
                            1, 422, flags, cache_key, &resp_headers, ids.as_ref(),
                            rate_remaining, rate_reset_ms,
                            cookies_packed.as_ref(), query_packed.as_ref(), ERR_SCHEMA_VALIDATION,
                        ));
                    }
                }
            }
        }

        // Success path — minimal output
        Ok(self.pack_output_v3(
            0, 200, flags, cache_key, &resp_headers, ids.as_ref(),
            rate_remaining, rate_reset_ms,
            cookies_packed.as_ref(), query_packed.as_ref(), &[],
        ))
    }

    /// Output format v3: removed path, raw_query, body from output.
    /// JS already has req.url and owns the body.
    #[allow(clippy::too_many_arguments)]
    fn pack_output_v3(
        &self,
        verdict: u8,
        status: u16,
        flags: u32,
        cache_key: u64,
        headers: &ResponseHeaderBuilder,
        ids: Option<&Ids>,
        rate_remaining: u32,
        rate_reset_ms: u64,
        cookies: &[u8],
        query: &[u8],
        error_body: &[u8],
    ) -> Vec<u8> {
        let empty: &[u8] = &[];
        let request_id: &[u8] = ids.map(|i| &i.request_id[..i.request_id_len as usize]).unwrap_or(empty);
        let trace_id: &[u8] = ids.map(|i| &i.trace_hex[..]).unwrap_or(empty);
        let span_id: &[u8] = ids.map(|i| &i.span_hex[..]).unwrap_or(empty);

        let headers_size = headers.packed_size();
        let total = 1 + 1 + 2 + 4 + 8
            + 4 + request_id.len()
            + 4 + trace_id.len()
            + 4 + span_id.len()
            + 4 + 8
            + headers_size
            + 4 + cookies.len()
            + 4 + query.len()
            + 4 + error_body.len();

        let mut out = Vec::with_capacity(total);
        out.push(3); // version 3
        out.push(verdict);
        out.extend_from_slice(&status.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&cache_key.to_le_bytes());
        push_bytes(&mut out, request_id);
        push_bytes(&mut out, trace_id);
        push_bytes(&mut out, span_id);
        out.extend_from_slice(&rate_remaining.to_le_bytes());
        out.extend_from_slice(&rate_reset_ms.to_le_bytes());
        headers.write_packed(&mut out);
        push_bytes(&mut out, cookies);
        push_bytes(&mut out, query);
        push_bytes(&mut out, error_body);

        debug_assert_eq!(out.len(), total);
        out
    }
}

// ── CORS Engine ──
impl CorsEngine {
    fn from_options(opts: CorsOptions) -> Self {
        let credentials = opts.allow_credentials.unwrap_or(false);
        let mode = match opts.allow_origin {
            Some(list) if list.iter().any(|o| o == "*") => CorsMode::Wildcard,
            Some(list) => CorsMode::Allowlist(list.into_iter().map(|o| o.into_bytes()).collect()),
            None => CorsMode::Wildcard,
        };
        let allow_methods = opts
            .allow_methods
            .map(|v| v.join(", ").into_bytes())
            .unwrap_or_else(|| b"GET,HEAD,PUT,PATCH,POST,DELETE".to_vec());
        let allow_headers = opts.allow_headers.map(|v| v.join(", ").into_bytes());
        let expose_headers = opts.expose_headers.map(|v| v.join(", ").into_bytes());
        let max_age = opts.max_age.map(|v| v.to_string().into_bytes());
        Self { mode, credentials, allow_methods, allow_headers, expose_headers, max_age }
    }

    fn evaluate_into<'a>(
        &'a self,
        method_kind: MethodKind,
        headers: &PackedHeaders<'a>,
        resp: &mut ResponseHeaderBuilder<'a>,
    ) -> CorsEvaluation {
        let Some(origin) = headers.get_origin() else {
            return CorsEvaluation { allowed: false, preflight: false };
        };

        let allowed = match &self.mode {
            CorsMode::Wildcard => !self.credentials,
            CorsMode::Allowlist(list) => list.iter().any(|o| o.eq_ignore_ascii_case(origin)),
        };

        // O(1) preflight detection
        let is_preflight = method_kind == MethodKind::Options && headers.get_acrm().is_some();

        if !allowed {
            return CorsEvaluation { allowed: false, preflight: is_preflight };
        }

        match &self.mode {
            CorsMode::Wildcard => {
                resp.push_static(H_ACCESS_CONTROL_ALLOW_ORIGIN, b"*");
            }
            CorsMode::Allowlist(_) => {
                resp.push_borrow(H_ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            }
        }

        let need_vary = !matches!(&self.mode, CorsMode::Wildcard) || self.credentials;
        if need_vary {
            if is_preflight {
                resp.push_static(H_VARY, b"Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
            } else {
                resp.push_static(H_VARY, b"Origin");
            }
        }

        if self.credentials {
            resp.push_static(H_ACCESS_CONTROL_ALLOW_CREDENTIALS, b"true");
        }

        if is_preflight {
            resp.push_borrow(H_ACCESS_CONTROL_ALLOW_METHODS, &self.allow_methods);
            if let Some(allow_headers) = &self.allow_headers {
                if !allow_headers.is_empty() {
                    resp.push_borrow(H_ACCESS_CONTROL_ALLOW_HEADERS, allow_headers);
                }
            } else if let Some(req_headers) = headers.get_acrh() {
                if !req_headers.is_empty() {
                    resp.push_borrow(H_ACCESS_CONTROL_ALLOW_HEADERS, req_headers);
                }
            }
            if let Some(max_age) = &self.max_age {
                resp.push_borrow(H_ACCESS_CONTROL_MAX_AGE, max_age);
            }
        } else if let Some(expose_headers) = &self.expose_headers {
            if !expose_headers.is_empty() {
                resp.push_borrow(H_ACCESS_CONTROL_EXPOSE_HEADERS, expose_headers);
            }
        }

        CorsEvaluation { allowed: true, preflight: is_preflight }
    }
}

// ── Security headers ──
fn build_security_headers_vec(
    cfg: &SecurityHeadersOptions,
    https: bool,
) -> Vec<(&'static [u8], Vec<u8>)> {
    let mut out = Vec::with_capacity(12);
    const DEFAULT_CSP: &[u8] = b"default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests";
    const H_CONTENT_SECURITY_POLICY: &[u8] = b"Content-Security-Policy";
    const H_STRICT_TRANSPORT_SECURITY: &[u8] = b"Strict-Transport-Security";
    const H_X_FRAME_OPTIONS: &[u8] = b"X-Frame-Options";
    const H_X_CONTENT_TYPE_OPTIONS: &[u8] = b"X-Content-Type-Options";
    const H_REFERRER_POLICY: &[u8] = b"Referrer-Policy";
    const H_CROSS_ORIGIN_EMBEDDER_POLICY: &[u8] = b"Cross-Origin-Embedder-Policy";
    const H_CROSS_ORIGIN_OPENER_POLICY: &[u8] = b"Cross-Origin-Opener-Policy";
    const H_CROSS_ORIGIN_RESOURCE_POLICY: &[u8] = b"Cross-Origin-Resource-Policy";
    const H_X_XSS_PROTECTION: &[u8] = b"X-XSS-Protection";

    match cfg.content_security_policy.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_CONTENT_SECURITY_POLICY, v.as_bytes().to_vec())),
        None => out.push((H_CONTENT_SECURITY_POLICY, DEFAULT_CSP.to_vec())),
    }
    if https && cfg.hsts.unwrap_or(true) {
        let max_age = cfg.hsts_max_age.unwrap_or(15_552_000);
        let mut value = format!("max-age={}", max_age);
        if cfg.hsts_include_subdomains.unwrap_or(true) {
            value.push_str("; includeSubDomains");
        }
        if cfg.hsts_preload.unwrap_or(false) {
            value.push_str("; preload");
        }
        out.push((H_STRICT_TRANSPORT_SECURITY, value.into_bytes()));
    }
    match cfg.frame_options.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_X_FRAME_OPTIONS, v.as_bytes().to_vec())),
        None => out.push((H_X_FRAME_OPTIONS, b"SAMEORIGIN".to_vec())),
    }
    if cfg.nosniff.unwrap_or(true) {
        out.push((H_X_CONTENT_TYPE_OPTIONS, b"nosniff".to_vec()));
    }
    match cfg.referrer_policy.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_REFERRER_POLICY, v.as_bytes().to_vec())),
        None => out.push((H_REFERRER_POLICY, b"no-referrer".to_vec())),
    }
    match cfg.coep.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_CROSS_ORIGIN_EMBEDDER_POLICY, v.as_bytes().to_vec())),
        None => out.push((H_CROSS_ORIGIN_EMBEDDER_POLICY, b"require-corp".to_vec())),
    }
    match cfg.coop.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_CROSS_ORIGIN_OPENER_POLICY, v.as_bytes().to_vec())),
        None => out.push((H_CROSS_ORIGIN_OPENER_POLICY, b"same-origin".to_vec())),
    }
    match cfg.corp.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_CROSS_ORIGIN_RESOURCE_POLICY, v.as_bytes().to_vec())),
        None => out.push((H_CROSS_ORIGIN_RESOURCE_POLICY, b"same-origin".to_vec())),
    }
    match cfg.xss_protection.as_deref() {
        Some("") => {}
        Some(v) => out.push((H_X_XSS_PROTECTION, v.as_bytes().to_vec())),
        None => out.push((H_X_XSS_PROTECTION, b"0".to_vec())),
    }
    out
}

// ── Helper functions ──
#[inline(always)]
fn push_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

#[inline(always)]
fn packed_count(bytes: &[u8]) -> u32 {
    if bytes.len() >= 4 {
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    } else {
        0
    }
}

#[inline(always)]
fn starts_with_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len() && &haystack[..needle.len()] == needle
}

fn extract_path_query(url: &[u8]) -> (&[u8], &[u8]) {
    let path_start = if let Some(scheme_end) = memchr::memchr(b':', url) {
        if url.len() > scheme_end + 2 && url[scheme_end + 1] == b'/' && url[scheme_end + 2] == b'/' {
            let after = scheme_end + 3;
            match memchr::memchr(b'/', &url[after..]) {
                Some(i) => after + i,
                None => url.len(),
            }
        } else {
            scheme_end + 1
        }
    } else {
        0
    };

    let rest = if path_start < url.len() { &url[path_start..] } else { &[] };
    let path_end = memchr::memchr2(b'?', b'#', rest).unwrap_or(rest.len());
    let path = if path_end == 0 { &b"/"[..] } else { &rest[..path_end] };
    let query = if path_end < rest.len() && rest[path_end] == b'?' {
        let start = path_end + 1;
        let end = memchr::memchr(b'#', &rest[start..]).map(|i| start + i).unwrap_or(rest.len());
        &rest[start..end]
    } else {
        &[]
    };
    (path, query)
}

#[inline(always)]
fn extract_ip_packed<'a>(
    headers: &'a PackedHeaders<'a>,
    socket_ip: &'a [u8],
    trust_proxy: bool,
) -> &'a [u8] {
    if !trust_proxy {
        return socket_ip;
    }
    // O(1) lookups via pre-indexed headers
    if let Some(xff) = headers.get_xff() {
        let first = match memchr::memchr(b',', xff) {
            Some(i) => trim_ascii_whitespace(&xff[..i]),
            None => trim_ascii_whitespace(xff),
        };
        if !first.is_empty() {
            return first;
        }
    }
    if let Some(real_ip) = headers.get_x_real_ip() {
        let real_ip = trim_ascii_whitespace(real_ip);
        if !real_ip.is_empty() {
            return real_ip;
        }
    }
    socket_ip
}

#[inline(always)]
fn request_is_https_packed(
    url: &[u8],
    headers: &PackedHeaders,
    trust_proxy: bool,
    fixed: Option<bool>,
) -> bool {
    if let Some(v) = fixed {
        return v;
    }
    if starts_with_bytes(url, b"https://") || starts_with_bytes(url, b"wss://") {
        return true;
    }
    if trust_proxy {
        if let Some(proto) = headers.get_x_forwarded_proto() {
            let first = proto.split(|&b| b == b',').next().unwrap_or(&[]);
            if trim_ascii_whitespace(first).eq_ignore_ascii_case(b"https") {
                return true;
            }
        }
    }
    false
}

fn parse_cookies_packed_exact(cookie: &[u8]) -> Vec<u8> {
    if cookie.is_empty() {
        return EMPTY_PAIRS.to_vec();
    }
    let mut total = 4u32;
    let mut count = 0u32;
    for pair in cookie.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() {
            continue;
        }
        let (name, value) = match memchr::memchr(b'=', pair) {
            Some(pos) => (trim_ascii_whitespace(&pair[..pos]), trim_ascii_whitespace(&pair[pos + 1..])),
            None => (trim_ascii_whitespace(pair), &[][..]),
        };
        if name.is_empty() {
            continue;
        }
        total += 4 + name.len() as u32 + 4 + value.len() as u32;
        count += 1;
    }
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&count.to_le_bytes());
    for pair in cookie.split(|&b| b == b';') {
        let pair = trim_ascii_whitespace(pair);
        if pair.is_empty() {
            continue;
        }
        let (name, value) = match memchr::memchr(b'=', pair) {
            Some(pos) => (trim_ascii_whitespace(&pair[..pos]), trim_ascii_whitespace(&pair[pos + 1..])),
            None => (trim_ascii_whitespace(pair), &[][..]),
        };
        if name.is_empty() {
            continue;
        }
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&(value.len() as u32).to_le_bytes());
        out.extend_from_slice(value);
    }
    out
}

fn parse_query_packed_exact(query: &[u8]) -> Vec<u8> {
    if query.is_empty() {
        return EMPTY_PAIRS.to_vec();
    }
    let pair_count = memchr::memchr_iter(b'&', query).count() + 1;
    let upper_bound = query.len() + pair_count * 8 + 4;
    let mut out = vec![0u8; upper_bound];
    match crate::query_parser::query_parse_packed_into_slice(query, &mut out) {
        Ok(written) => {
            out.truncate(written);
            out
        }
        Err(_) => EMPTY_PAIRS.to_vec(),
    }
}

fn write_rate_limit_error(buf: &mut [u8; 128], retry_ms: u64) -> usize {
    const PREFIX: &[u8] = br#"{"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":"#;
    const SUFFIX: &[u8] = b"}}";
    let mut pos = 0;
    buf[..PREFIX.len()].copy_from_slice(PREFIX);
    pos += PREFIX.len();
    let mut num_buf = itoa::Buffer::new();
    let num_str = num_buf.format(retry_ms);
    buf[pos..pos + num_str.len()].copy_from_slice(num_str.as_bytes());
    pos += num_str.len();
    buf[pos..pos + SUFFIX.len()].copy_from_slice(SUFFIX);
    pos += SUFFIX.len();
    pos
}