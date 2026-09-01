// rust/ffi/payload.rs — payload C-ABI exports.
//
// WebSocket accept-key + frame encode/decode, gzip/brotli compress-decompress
// (via the shared `compress_to_out!` macro — see the needed-size convention),
// and SSE event encoding.

use std::slice;

use super::util::{cstring_return, panic_guard};

/// RFC 6455 Sec-WebSocket-Accept (28 bytes) returned as a null-terminated C
/// string into the per-thread reused buffer (`cstring` return).
///
/// `key` is a `bun:ffi` `cstring` ARG — the engine transcodes the JS base64 key
/// in-engine (JS does zero encode; the callee borrows via `CStr::from_ptr`).
/// The pooled `castrum_ws_accept_key_into` keeps the `(ptr,len)` byte form.
///
/// # Safety
/// `key` must be a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_accept_key(
    key: *const std::os::raw::c_char,
) -> *const std::os::raw::c_char {
    if key.is_null() {
        return std::ptr::null();
    }
    cstring_return(28, |out| {
        crate::payload::websocket::ws_accept_key_into(std::ffi::CStr::from_ptr(key).to_bytes(), out)
            .ok()
    })
}

/// RFC 6455 Sec-WebSocket-Accept written directly into a caller buffer — the
/// pooled sibling of `castrum_ws_accept_key` (no cstring round-trip). Writes 28
/// bytes; returns bytes written, the exact required size when `out_cap` is too
/// small, or 0 on a malformed key.
///
/// # Safety
/// `key` must be valid for reads of `klen` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_accept_key_into(
    key: *const u8,
    klen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if key.is_null() || out.is_null() {
        return 0;
    }
    if out_cap < 28 {
        return 28;
    }
    match crate::payload::websocket::ws_accept_key_into(
        slice::from_raw_parts(key, klen),
        slice::from_raw_parts_mut(out, 28),
    ) {
        Ok(28) => 28,
        _ => 0,
    }
}

/// WebSocket frame encode into `out` (opcode 1/2/8/9/10, `mask`/`fin` flags).
///
/// # Safety
/// `payload` must be valid for reads of `plen` bytes; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_frame_encode(
    opcode: u8,
    payload: *const u8,
    plen: usize,
    mask: u8,
    fin: u8,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if payload.is_null() || out.is_null() {
        return 0;
    }
    crate::payload::ws_frames::encode_frame_into(
        opcode,
        slice::from_raw_parts(payload, plen),
        mask != 0,
        fin != 0,
        slice::from_raw_parts_mut(out, out_cap),
    )
    .unwrap_or(0)
}

/// Decode a WebSocket frame into a packed `[u8 flags][u8 opcode][u32 payload_len]
/// [payload]` layout (flags bit0 = FIN). Returns bytes written, 0 on malformed
/// input. JS decodes the small header into the `WsFrame` shape.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_ws_frame_decode_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let Some(frame) = crate::payload::ws_frames::decode_frame(slice::from_raw_parts(data, len))
    else {
        return 0;
    };
    let Some(need) = 6usize.checked_add(frame.payload.len()) else {
        return 0;
    };
    if need > out_cap {
        return 0;
    }
    let o = slice::from_raw_parts_mut(out, need);
    o[0] = u8::from(frame.fin);
    o[1] = frame.opcode;
    o[2..6].copy_from_slice(&(frame.payload.len() as u32).to_le_bytes());
    o[6..].copy_from_slice(&frame.payload);
    need
}

// ── Compression (gzip / brotli) ──────────────────────────────────

macro_rules! compress_to_out {
    ($name:ident, $core:path, $extra:ty) => {
        #[doc = concat!("Run `", stringify!($core), "` and write the result into `out`.")]
        ///
        /// # Convention
        /// Returns the exact total bytes the result requires (the written count
        /// on success, or the needed size when `out_cap` is too small). The JS
        /// wrapper compares against `out_cap` to distinguish success from
        /// too-small, so a miss allocates EXACTLY once and retries — it never
        /// re-runs the whole (de)compression in a grow loop. `0` is reserved
        /// for a REAL error (invalid stream / decompression-cap exceeded).
        ///
        /// # Safety
        /// `data` must be valid for reads of `len` bytes; `out` for writes up to `out_cap`.
        #[no_mangle]
        pub unsafe extern "C" fn $name(
            data: *const u8,
            len: usize,
            extra: $extra,
            out: *mut u8,
            out_cap: usize,
        ) -> usize {
            if data.is_null() || out.is_null() {
                return 0;
            }
            let input = slice::from_raw_parts(data, len);
            let output = slice::from_raw_parts_mut(out, out_cap);
            panic_guard(
                || match $core(input, extra, output) {
                    Ok(w) => w,
                    // Needed-size convention: report the EXACT required size so the
                    // JS wrapper allocates once and retries (never a re-run loop).
                    Err(crate::payload::compress::StreamError::TooSmall { needed }) => needed,
                    // Real error (invalid stream / decompression cap exceeded) → 0.
                    Err(_) => 0,
                },
                0,
            )
        }
    };
}

compress_to_out!(
    castrum_gzip_compress,
    crate::payload::compress::gzip_compress_into,
    u32
);
compress_to_out!(
    castrum_gzip_decompress,
    crate::payload::compress::gzip_decompress_into,
    usize
);
compress_to_out!(
    castrum_brotli_compress,
    crate::payload::compress::brotli_compress_into,
    u32
);
compress_to_out!(
    castrum_brotli_decompress,
    crate::payload::compress::brotli_decompress_into,
    usize
);

/// Read the original (uncompressed) size from a gzip stream's ISIZE trailer
/// (last 4 bytes, little-endian, original size mod 2^32). Returns the EXACT
/// output size for a single-member standard gzip stream, or 0 when the input
/// isn't a usable standard gzip stream (too short / not gzip magic). Lets the
/// JS wrapper pre-size the decompress buffer exactly so the happy path is a
/// single pass (no grow-retry re-run).
///
/// # Safety
/// `data` must be valid for reads of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_gzip_isize(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len < 18 {
        return 0;
    }
    let s = slice::from_raw_parts(data, len);
    if s[0] != 0x1f || s[1] != 0x8b {
        return 0;
    }
    u32::from_le_bytes([s[len - 4], s[len - 3], s[len - 2], s[len - 1]])
}

/// Encode one SSE event into `out`. Optional fields use `flags` bits
/// (1 = event present, 2 = id present, 4 = retry present) so a present-but-empty
/// string is distinct from an absent one, matching the napi `Option<String>`.
/// Returns bytes written, or 0 on a too-small buffer / invalid UTF-8 in
/// event/id (JS sizes `data_len + 64` to guarantee success). FFI sibling of the
/// napi `sse_encode_event` — the wrapper decodes nothing (output is raw SSE
/// bytes), so this just removes the napi crossing.
///
/// # Safety
/// `event`/`id` must be valid for reads of `event_len`/`id_len` bytes when their
/// flag is set; `data` valid for `data_len` reads; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_sse_encode_into(
    event: *const u8,
    event_len: usize,
    data: *const u8,
    data_len: usize,
    id: *const u8,
    id_len: usize,
    flags: u8,
    retry: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    // A PRESENT but empty event/id is valid (emits the line) — only a null
    // pointer with its flag set is malformed (would be UB to slice).
    if (flags & 1 != 0 && event.is_null()) || (flags & 2 != 0 && id.is_null()) {
        return 0;
    }
    panic_guard(
        || -> Option<usize> {
            let data_bytes = slice::from_raw_parts(data, data_len);
            let output = slice::from_raw_parts_mut(out, out_cap);
            let event_opt = if flags & 1 != 0 {
                Some(std::str::from_utf8(slice::from_raw_parts(event, event_len)).ok()?)
            } else {
                None
            };
            let id_opt = if flags & 2 != 0 {
                Some(std::str::from_utf8(slice::from_raw_parts(id, id_len)).ok()?)
            } else {
                None
            };
            let retry_opt = if flags & 4 != 0 {
                Some(u64::from(retry))
            } else {
                None
            };
            match crate::payload::sse::encode_event_into_slice(
                event_opt, data_bytes, id_opt, retry_opt, output,
            ) {
                Ok(w) => Some(w),
                // Too-small buffer: return the exact required size so the JS
                // wrapper allocates ONCE and retries (needed-size convention);
                // 0 stays a real error (invalid UTF-8 in event/id above).
                Err(_) => Some(crate::payload::sse::encode_event_size(
                    event_opt, data_bytes, id_opt, retry_opt,
                )),
            }
        },
        None,
    )
    .unwrap_or(0)
}
