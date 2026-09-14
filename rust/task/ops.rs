// rust/task/ops.rs — the task op dispatch table + cancellation.
//
// v1 ships ONE op (`gzip.decompress`) because it is the clearest possible
// story: castrum deliberately keeps gzip decompression native (Bun's
// `Bun.gunzipSync` has no decompression-bomb cap) and it is the op that
// measured a 28.5 ms event-loop stall — so offloading it is a real win, not a
// benchmark contrivance. New ops are one arm each; the packed arg convention
// is `[u32 op-specific header][payload]`.

use parking_lot::Mutex;
use std::collections::HashSet;

use crate::crypto::argon2::verify_password;
use crate::payload::compress::{
    brotli_decompress_bytes, brotli_decompress_into, gzip_compress_bytes, gzip_decompress_bytes,
    gzip_decompress_into, StreamError, DEFAULT_MAX_DECOMPRESSED,
};

use super::completion::{self, Completion};

/// `gzip.decompress` — args `[u32 maxDecompressed LE][gzip bytes]`
/// (0 = {@link DEFAULT_MAX_DECOMPRESSED}).
pub const OP_GZIP_DECOMPRESS: u32 = 1;

/// `pbkdf2.sha256` — args `[u32 rounds][u32 dkLen][u32 saltLen][salt][password]`.
/// The ideal offload shape: 10-200 ms of pure CPU, 1-64 bytes of output.
pub const OP_PBKDF2_SHA256: u32 = 2;

/// `gzip.decompress` writing directly into a caller-provided buffer
/// (zero-copy output): args `[u32 maxDecompressed LE][gzip bytes]`. The
/// completion body is the 8-byte LE written length, not the data.
pub const OP_GZIP_DECOMPRESS_INTO: u32 = 3;

/// `argon2id.verify` — args `[u32 pwLen][u32 phcLen][password][phc]`; the body
/// is ONE byte (`1` = match). The other textbook offload shape: the PHC string
/// pins the cost parameters, so this is tens to hundreds of ms of CPU for a
/// one-bit answer.
pub const OP_ARGON2_VERIFY: u32 = 4;

/// `brotli.decompress` — args `[u32 maxDecompressed LE][brotli bytes]`.
pub const OP_BROTLI_DECOMPRESS: u32 = 5;

/// `brotli.decompress` into a caller buffer (zero-copy), same args. Brotli has
/// no ISIZE trailer, so the caller guesses a capacity and retries once on
/// {@link STATUS_TOO_SMALL} — the needed-size convention covers it.
pub const OP_BROTLI_DECOMPRESS_INTO: u32 = 6;

/// `gzip.compress` — args `[u32 level][gzip bytes]`. Worth offloading even on
/// Bun: `Bun.gzipSync` measured a 7.6 ms loop stall on 24 MiB. Deliberately has
/// NO zero-copy (`_into`) form: a compressed result is small relative to its
/// input, so pre-sizing a destination from the worst-case bound would allocate
/// far more than the copy it saves. The copy path is the right shape here.
pub const OP_GZIP_COMPRESS: u32 = 7;

/// Test-only op whose body panics — pins the `catch_unwind` containment.
#[cfg(test)]
pub const OP_TEST_PANIC: u32 = 0xFFFF;

pub const STATUS_OK: u32 = 0;
pub const STATUS_ERROR: u32 = 1;
pub const STATUS_CANCELLED: u32 = 2;
/// The caller's output buffer was too small; the body carries the exact
/// required size as 8 bytes LE so the caller can retry once.
pub const STATUS_TOO_SMALL: u32 = 3;
/// The op has no zero-copy (`_into`) form; the caller falls back to the copy
/// path. Keeps an older/stale addon from breaking the caller.
pub const STATUS_UNSUPPORTED: u32 = 4;

static CANCELLED: Mutex<Option<HashSet<u64>>> = Mutex::new(None);

/// Mark a task id cancelled. Returns `true` the first time, `false` if the id
/// was already marked (or unknown — the task may have finished).
pub fn mark_cancelled(id: u64) -> bool {
    CANCELLED.lock().get_or_insert_with(HashSet::new).insert(id)
}

fn is_cancelled(id: u64) -> bool {
    CANCELLED.lock().as_ref().is_some_and(|s| s.contains(&id))
}

fn clear_cancelled(id: u64) {
    if let Some(s) = CANCELLED.lock().as_mut() {
        s.remove(&id);
    }
}

/// Run one task and publish its completion. Never unwinds outward.
pub fn execute_guarded(op: u32, args: &[u8], id: u64) {
    let n = header_len(op).min(args.len());
    let (hdr, data) = args.split_at(n);
    let panicked =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(op, hdr, data, id)))
            .is_err();
    if panicked {
        clear_cancelled(id);
        completion::push(Completion {
            id,
            status: STATUS_ERROR,
            body: b"task panicked (contained)".to_vec(),
        });
    }
}

/// Ops whose args are ONE packed blob read out of the caller's slice. The
/// payload is read in place (zero-copy INPUT), so a large argument never gets
/// copied on the JS thread — which is what made offloading a big compression a
/// net loss (see docs/RND-CONCURRENCY.md §7b).
///
/// # Safety
/// `data`/`data_len` must describe a readable region that stays alive and
/// unmodified until the completion for `id` is drained.
pub unsafe fn execute_slice_guarded(
    op: u32,
    hdr: &[u8],
    data: *const u8,
    data_len: usize,
    id: u64,
) {
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let data: &[u8] = if data.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(data, data_len)
        };
        execute(op, hdr, data, id);
    }))
    .is_err();
    if panicked {
        clear_cancelled(id);
        completion::push(Completion {
            id,
            status: STATUS_ERROR,
            body: b"task panicked (contained)".to_vec(),
        });
    }
}

/// Bytes of op-specific header that precede the payload in a packed args blob.
/// The `_INTO` (zero-copy output) and copy forms of an op share a header.
const fn header_len(op: u32) -> usize {
    match op {
        OP_GZIP_DECOMPRESS
        | OP_GZIP_DECOMPRESS_INTO
        | OP_BROTLI_DECOMPRESS
        | OP_BROTLI_DECOMPRESS_INTO
        | OP_GZIP_COMPRESS => 4,
        OP_ARGON2_VERIFY => 8,
        OP_PBKDF2_SHA256 => 12,
        _ => 0,
    }
}

/// Map a streaming-codec outcome onto a task result, sharing the needed-size
/// convention: a too-small destination yields the EXACT required size as an
/// 8-byte LE body so the caller can allocate once and retry.
fn stream_result(
    r: std::result::Result<usize, StreamError>,
    what: &str,
) -> std::result::Result<usize, (u32, Vec<u8>)> {
    match r {
        Ok(written) => Ok(written),
        Err(StreamError::TooSmall { needed }) => {
            Err((STATUS_TOO_SMALL, (needed as u64).to_le_bytes().to_vec()))
        }
        Err(StreamError::ExceedsMax(cap)) => Err((
            STATUS_ERROR,
            format!("{what}: exceeded the {cap}-byte cap").into_bytes(),
        )),
        Err(StreamError::Io(e)) => Err((STATUS_ERROR, format!("{what}: {e}").into_bytes())),
    }
}

/// Read one little-endian u32 out of an op header, or `None` when short.
fn hdr_u32(hdr: &[u8], off: usize) -> Option<u32> {
    let b = hdr.get(off..off + 4)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// The cap header shared by the decompress ops: `0` means the native default.
fn cap_of(hdr: &[u8]) -> Option<usize> {
    let raw = hdr_u32(hdr, 0)?;
    Some(if raw == 0 {
        DEFAULT_MAX_DECOMPRESSED
    } else {
        raw as usize
    })
}

/// Run an op that writes into `out` (zero-copy output). `Ok(written)`, or
/// `Err((status, body))` — a too-small buffer yields `STATUS_TOO_SMALL` with
/// the exact required size as the 8-byte body.
fn run_into(
    op: u32,
    hdr: &[u8],
    data: &[u8],
    out: &mut [u8],
) -> std::result::Result<usize, (u32, Vec<u8>)> {
    match op {
        OP_GZIP_DECOMPRESS_INTO => match cap_of(hdr) {
            Some(max) => stream_result(gzip_decompress_into(data, max, out), "gzip decompress"),
            None => Err((STATUS_ERROR, b"gzip.decompress: header too short".to_vec())),
        },
        OP_BROTLI_DECOMPRESS_INTO => match cap_of(hdr) {
            Some(max) => stream_result(brotli_decompress_into(data, max, out), "brotli decompress"),
            None => Err((
                STATUS_ERROR,
                b"brotli.decompress: header too short".to_vec(),
            )),
        },
        _ => Err((STATUS_UNSUPPORTED, Vec::new())),
    }
}

/// Execute a zero-copy op into the caller's buffer and publish its completion.
/// The completion body is the 8-byte LE written length (not the data), so the
/// JS side hands back a view of the buffer it already owns — no copy at all.
///
/// # Safety
/// `out` must be valid for writes of `out_cap` bytes and must stay alive (and
/// untouched by JS) until the completion for `id` is drained.
pub unsafe fn execute_into_guarded(op: u32, args: &[u8], id: u64, out: *mut u8, out_cap: usize) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if is_cancelled(id) {
            return Err((STATUS_CANCELLED, Vec::new()));
        }
        if out.is_null() || out_cap == 0 {
            return Err((STATUS_ERROR, b"task: null output buffer".to_vec()));
        }
        let slice = std::slice::from_raw_parts_mut(out, out_cap);
        let n = header_len(op).min(args.len());
        let (hdr, data) = args.split_at(n);
        run_into(op, hdr, data, slice)
    }));
    clear_cancelled(id);
    match outcome {
        Ok(Ok(written)) => completion::push(Completion {
            id,
            status: STATUS_OK,
            body: (written as u64).to_le_bytes().to_vec(),
        }),
        Ok(Err((status, body))) => completion::push(Completion { id, status, body }),
        Err(_) => completion::push(Completion {
            id,
            status: STATUS_ERROR,
            body: b"task panicked (contained)".to_vec(),
        }),
    }
}

fn execute(op: u32, hdr: &[u8], data: &[u8], id: u64) {
    if is_cancelled(id) {
        clear_cancelled(id);
        completion::push(Completion {
            id,
            status: STATUS_CANCELLED,
            body: Vec::new(),
        });
        return;
    }
    let (status, body) = match run_op(op, hdr, data) {
        Ok(b) => (STATUS_OK, b),
        Err(e) => (STATUS_ERROR, e.into_bytes()),
    };
    clear_cancelled(id);
    completion::push(Completion { id, status, body });
}

fn run_op(op: u32, hdr: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    match op {
        OP_GZIP_DECOMPRESS => match cap_of(hdr) {
            Some(max) => gzip_decompress_bytes(data, max).map_err(|e| e.to_string()),
            None => Err("gzip.decompress: header too short".to_string()),
        },
        OP_BROTLI_DECOMPRESS => match cap_of(hdr) {
            Some(max) => brotli_decompress_bytes(data, max).map_err(|e| e.to_string()),
            None => Err("brotli.decompress: header too short".to_string()),
        },
        OP_GZIP_COMPRESS => match hdr_u32(hdr, 0) {
            Some(level) => gzip_compress_bytes(data, level.min(9)).map_err(|e| e.to_string()),
            None => Err("gzip.compress: header too short".to_string()),
        },
        OP_ARGON2_VERIFY => {
            let (Some(pw_len), Some(phc_len)) = (hdr_u32(hdr, 0), hdr_u32(hdr, 4)) else {
                return Err("argon2id.verify: header too short".to_string());
            };
            let (pw_len, phc_len) = (pw_len as usize, phc_len as usize);
            if data.len() < pw_len + phc_len {
                return Err("argon2id.verify: truncated password/phc".to_string());
            }
            let (password, phc) = data.split_at(pw_len);
            // A malformed PHC string is a NON-MATCH, never an error — the
            // synchronous `rust.passwordVerify` behaves the same way.
            Ok(vec![u8::from(verify_password(password, &phc[..phc_len]))])
        }
        OP_PBKDF2_SHA256 => {
            let (Some(rounds), Some(dk_len), Some(salt_len)) =
                (hdr_u32(hdr, 0), hdr_u32(hdr, 4), hdr_u32(hdr, 8))
            else {
                return Err("pbkdf2.sha256: header too short".to_string());
            };
            let salt_len = salt_len as usize;
            if data.len() < salt_len {
                return Err("pbkdf2.sha256: truncated salt".to_string());
            }
            let (salt, password) = data.split_at(salt_len);
            Ok(crate::crypto::pbkdf2::pbkdf2_sha256_into(
                password, salt, rounds, dk_len,
            ))
        }
        #[cfg(test)]
        OP_TEST_PANIC => panic!("intentional test panic"),
        _ => Err(format!("unknown task op {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror the packed-args split so tests exercise the same boundary the
    /// C-ABI `submit` does (header first, payload after).
    fn run_packed(op: u32, args: &[u8]) -> Result<Vec<u8>, String> {
        let n = header_len(op).min(args.len());
        run_op(op, &args[..n], &args[n..])
    }

    fn run_into_packed(
        op: u32,
        args: &[u8],
        out: &mut [u8],
    ) -> std::result::Result<usize, (u32, Vec<u8>)> {
        let n = header_len(op).min(args.len());
        run_into(op, &args[..n], &args[n..], out)
    }

    #[test]
    fn run_op_round_trips_gzip() {
        let payload = b"task op payload".repeat(32);
        let compressed = crate::payload::compress::gzip_compress_bytes(&payload, 6).unwrap();
        let mut args = Vec::with_capacity(4 + compressed.len());
        args.extend_from_slice(&0u32.to_le_bytes());
        args.extend_from_slice(&compressed);
        assert_eq!(run_packed(OP_GZIP_DECOMPRESS, &args).unwrap(), payload);
    }

    #[test]
    fn unknown_op_is_an_error() {
        assert!(run_packed(42, &[]).is_err());
    }

    #[test]
    fn pbkdf2_op_matches_the_known_vector() {
        let mut args = Vec::new();
        args.extend_from_slice(&1u32.to_le_bytes()); // rounds
        args.extend_from_slice(&32u32.to_le_bytes()); // dk_len
        args.extend_from_slice(&4u32.to_le_bytes()); // salt len
        args.extend_from_slice(b"salt");
        args.extend_from_slice(b"password");
        let out = run_packed(OP_PBKDF2_SHA256, &args).unwrap();
        let hex: String = out.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
    }

    #[test]
    fn gzip_into_reports_the_exact_needed_size_and_then_succeeds() {
        let payload = b"zero-copy output".repeat(64);
        let compressed = crate::payload::compress::gzip_compress_bytes(&payload, 6).unwrap();
        let mut args = Vec::new();
        args.extend_from_slice(&0u32.to_le_bytes());
        args.extend_from_slice(&compressed);

        // Too small → TOO_SMALL with the exact required size.
        let mut tiny = [0u8; 8];
        match run_into_packed(OP_GZIP_DECOMPRESS_INTO, &args, &mut tiny) {
            Err((STATUS_TOO_SMALL, body)) => {
                let needed = u64::from_le_bytes(body.try_into().unwrap());
                assert_eq!(needed, payload.len() as u64);
            }
            Ok(w) => panic!("expected TooSmall, got Ok({w})"),
            Err((s, _)) => panic!("expected TooSmall, got status {s}"),
        }

        // Exact size → writes the payload, no copy on the JS side.
        let mut exact = vec![0u8; payload.len()];
        assert_eq!(
            run_into_packed(OP_GZIP_DECOMPRESS_INTO, &args, &mut exact).unwrap(),
            payload.len()
        );
        assert_eq!(exact, payload);
    }

    #[test]
    fn an_op_without_an_into_form_is_unsupported() {
        let mut out = [0u8; 16];
        assert!(matches!(
            run_into_packed(OP_PBKDF2_SHA256, &[], &mut out),
            Err((STATUS_UNSUPPORTED, _))
        ));
    }

    #[test]
    fn gzip_compress_round_trips_through_the_task_op() {
        let payload = b"compress me".repeat(128);
        let mut args = Vec::new();
        args.extend_from_slice(&6u32.to_le_bytes());
        args.extend_from_slice(&payload);

        let compressed = run_packed(OP_GZIP_COMPRESS, &args).unwrap();
        assert!(compressed.len() < payload.len());
        assert_eq!(
            crate::payload::compress::gzip_decompress_bytes(&compressed, payload.len() + 1)
                .unwrap(),
            payload
        );
    }

    #[test]
    fn brotli_into_reports_the_exact_needed_size_and_then_succeeds() {
        let payload = b"brotli zero-copy output".repeat(64);
        let compressed = crate::payload::compress::brotli_compress_bytes(&payload, 5).unwrap();
        let mut args = Vec::new();
        args.extend_from_slice(&0u32.to_le_bytes());
        args.extend_from_slice(&compressed);

        // Too small (a capacity GUESS, since brotli has no ISIZE trailer) →
        // TOO_SMALL with the exact required size.
        let mut tiny = [0u8; 16];
        match run_into_packed(OP_BROTLI_DECOMPRESS_INTO, &args, &mut tiny) {
            Err((STATUS_TOO_SMALL, body)) => {
                assert_eq!(
                    u64::from_le_bytes(body.try_into().unwrap()),
                    payload.len() as u64
                );
            }
            Ok(w) => panic!("expected TooSmall, got Ok({w})"),
            Err((s, _)) => panic!("expected TooSmall, got status {s}"),
        }

        let mut exact = vec![0u8; payload.len()];
        assert_eq!(
            run_into_packed(OP_BROTLI_DECOMPRESS_INTO, &args, &mut exact).unwrap(),
            payload.len()
        );
        assert_eq!(exact, payload);
    }

    #[test]
    fn argon2_verify_answers_in_one_byte() {
        let phc = crate::crypto::argon2::hash_password(b"hunter2", b"saltysalt", 4096, 1, 1, 32)
            .expect("hash");

        let mut args = Vec::new();
        let pw = b"hunter2";
        let phc_bytes = phc.as_bytes();
        args.extend_from_slice(&(pw.len() as u32).to_le_bytes());
        args.extend_from_slice(&(phc_bytes.len() as u32).to_le_bytes());
        args.extend_from_slice(pw);
        args.extend_from_slice(phc_bytes);

        assert_eq!(run_packed(OP_ARGON2_VERIFY, &args).unwrap(), vec![1]);

        // Wrong password → 0, and a malformed PHC string is a NON-MATCH, never
        // an error (parity with the synchronous `rust.passwordVerify`).
        let mut wrong = Vec::new();
        let bad = b"nope";
        wrong.extend_from_slice(&(bad.len() as u32).to_le_bytes());
        wrong.extend_from_slice(&(phc_bytes.len() as u32).to_le_bytes());
        wrong.extend_from_slice(bad);
        wrong.extend_from_slice(phc_bytes);
        assert_eq!(run_packed(OP_ARGON2_VERIFY, &wrong).unwrap(), vec![0]);

        let mut malformed = Vec::new();
        let junk = b"not-a-phc";
        malformed.extend_from_slice(&(bad.len() as u32).to_le_bytes());
        malformed.extend_from_slice(&(junk.len() as u32).to_le_bytes());
        malformed.extend_from_slice(bad);
        malformed.extend_from_slice(junk);
        assert_eq!(run_packed(OP_ARGON2_VERIFY, &malformed).unwrap(), vec![0]);
    }

    #[test]
    fn a_truncated_argon2_arg_header_is_an_error() {
        let mut args = Vec::new();
        args.extend_from_slice(&64u32.to_le_bytes());
        args.extend_from_slice(&64u32.to_le_bytes());
        args.extend_from_slice(b"short");
        assert!(run_packed(OP_ARGON2_VERIFY, &args).is_err());
    }

    #[test]
    fn gzip_cap_is_enforced() {
        // 1 MiB of zeros compresses tiny; a 16-byte cap must reject it.
        let payload = vec![0u8; 1 << 20];
        let compressed = crate::payload::compress::gzip_compress_bytes(&payload, 6).unwrap();
        let mut args = Vec::new();
        args.extend_from_slice(&16u32.to_le_bytes());
        args.extend_from_slice(&compressed);
        assert!(run_packed(OP_GZIP_DECOMPRESS, &args).is_err());
    }
}
