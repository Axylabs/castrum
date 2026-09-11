// rust/task/tests.rs — pool / ring / cancellation / panic / doorbell tests.
//
// These touch PROCESS-WIDE state (one pool + one ring per process), so they are
// serialized by a test mutex rather than relying on the default parallel test
// threads.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use super::completion::{self, Completion};
use super::ops::{
    self, OP_GZIP_COMPRESS, OP_GZIP_DECOMPRESS, OP_TEST_PANIC, STATUS_CANCELLED, STATUS_ERROR,
    STATUS_OK,
};
use super::runtime;

/// Serializes tests that share the global ring/pool/cancel set.
static LOCK: Mutex<()> = Mutex::new(());

fn parse(buf: &[u8], written: usize) -> Vec<(u64, u32, Vec<u8>)> {
    let mut out = Vec::new();
    if written < 4 {
        return out;
    }
    let count = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let mut off = 4usize;
    for _ in 0..count {
        if off + 16 > written {
            break;
        }
        let id = u64::from_le_bytes(buf[off..off + 8].try_into().unwrap());
        let status = u32::from_le_bytes(buf[off + 8..off + 12].try_into().unwrap());
        let len = u32::from_le_bytes(buf[off + 12..off + 16].try_into().unwrap()) as usize;
        off += 16;
        if off + len > written {
            break;
        }
        out.push((id, status, buf[off..off + len].to_vec()));
        off += len;
    }
    out
}

/// Drain everything pending into a right-sized buffer (one grow retry).
fn drain_all() -> Vec<(u64, u32, Vec<u8>)> {
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let w = completion::drain(&mut buf);
        if w == 0 {
            return Vec::new();
        }
        if w > buf.len() {
            buf = vec![0u8; w];
            continue;
        }
        return parse(&buf, w);
    }
}

/// Poll until `id` completes (10 s guard) and return `(status, body)`.
fn wait_for(id: u64) -> (u32, Vec<u8>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        for (rid, status, body) in drain_all() {
            if rid == id {
                return (status, body);
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "task {id} never completed"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn gzip_args(payload: &[u8]) -> Vec<u8> {
    let compressed = crate::payload::compress::gzip_compress_bytes(payload, 6).unwrap();
    let mut args = Vec::with_capacity(4 + compressed.len());
    args.extend_from_slice(&0u32.to_le_bytes());
    args.extend_from_slice(&compressed);
    args
}

#[test]
fn submit_runs_off_thread_and_drains() {
    let _g = LOCK.lock();
    completion::clear();
    let payload = b"hello castrum tasks".repeat(64);
    assert!(super::submit_op(OP_GZIP_DECOMPRESS, gzip_args(&payload), 0x1001));
    let (status, body) = wait_for(0x1001);
    assert_eq!(status, STATUS_OK);
    assert_eq!(body, payload);
}

#[test]
fn a_slice_submit_reads_the_payload_in_place() {
    let _g = LOCK.lock();
    completion::clear();
    // Zero-copy INPUT: only the 4-byte level header crosses the boundary; the
    // payload pointer is read on the worker. The buffer must outlive the task,
    // which is exactly the contract JS upholds by holding `Deferred.keep`.
    let payload = b"zero-copy input payload".repeat(256);
    let hdr = 6u32.to_le_bytes().to_vec();
    assert!(super::submit_slice_op(
        OP_GZIP_COMPRESS,
        hdr,
        payload.as_ptr() as usize,
        payload.len(),
        0x1009,
    ));
    let (status, body) = wait_for(0x1009);
    assert_eq!(status, STATUS_OK);

    let restored =
        crate::payload::compress::gzip_decompress_bytes(&body, payload.len() + 1).unwrap();
    assert_eq!(restored, payload);

    // A null payload with a zero length is an empty input, not a crash.
    completion::clear();
    assert!(super::submit_slice_op(
        OP_GZIP_COMPRESS,
        6u32.to_le_bytes().to_vec(),
        0,
        0,
        0x100A
    ));
    assert_eq!(wait_for(0x100A).0, STATUS_OK);
}

#[test]
fn error_status_carries_a_message() {
    let _g = LOCK.lock();
    completion::clear();
    // Too-short args → the op returns an error string, not a panic.
    assert!(super::submit_op(OP_GZIP_DECOMPRESS, vec![], 0x1002));
    let (status, body) = wait_for(0x1002);
    assert_eq!(status, STATUS_ERROR);
    assert!(String::from_utf8_lossy(&body).contains("too short"));
}

#[test]
fn cancellation_is_acknowledged() {
    let _g = LOCK.lock();
    completion::clear();
    let id = 0x1003;
    assert!(ops::mark_cancelled(id));
    ops::execute_guarded(OP_GZIP_DECOMPRESS, &gzip_args(b"x"), id);
    let (status, _) = wait_for(id);
    assert_eq!(status, STATUS_CANCELLED);
}

#[test]
fn a_panicking_task_is_contained() {
    let _g = LOCK.lock();
    completion::clear();
    assert!(super::submit_op(OP_TEST_PANIC, vec![], 0x1004));
    let (status, body) = wait_for(0x1004);
    assert_eq!(status, STATUS_ERROR);
    assert!(String::from_utf8_lossy(&body).contains("panicked"));
}

#[test]
fn drain_uses_the_needed_size_convention() {
    let _g = LOCK.lock();
    completion::clear();
    completion::set_doorbell(0);
    completion::push(Completion {
        id: 7,
        status: STATUS_OK,
        body: vec![1, 2, 3],
    });
    let mut tiny = [0u8; 1];
    let needed = completion::drain(&mut tiny);
    assert_eq!(needed, 4 + 16 + 3);
    // Nothing was consumed, so a right-sized retry still gets it.
    let mut ok = vec![0u8; needed];
    let written = completion::drain(&mut ok);
    assert_eq!(written, needed);
    let parsed = parse(&ok, written);
    assert_eq!(parsed, vec![(7u64, STATUS_OK, vec![1u8, 2, 3])]);
}

static BELLS: AtomicU32 = AtomicU32::new(0);

extern "C" fn bell() {
    BELLS.fetch_add(1, Ordering::SeqCst);
}

#[test]
fn doorbell_coalesces_a_batch() {
    let _g = LOCK.lock();
    completion::clear();
    completion::set_doorbell(bell as *const () as usize);
    BELLS.store(0, Ordering::SeqCst);
    completion::push(Completion {
        id: 1,
        status: STATUS_OK,
        body: vec![0],
    });
    completion::push(Completion {
        id: 2,
        status: STATUS_OK,
        body: vec![0],
    });
    // Both pushes land inside one armed window → exactly one crossing.
    assert_eq!(BELLS.load(Ordering::SeqCst), 1);
    let mut buf = vec![0u8; 4096];
    assert!(completion::drain(&mut buf) > 0);
    // A push after the drain re-arms the bell.
    completion::push(Completion {
        id: 3,
        status: STATUS_OK,
        body: vec![0],
    });
    assert_eq!(BELLS.load(Ordering::SeqCst), 2);
    completion::drain(&mut buf);
    completion::set_doorbell(0);
    completion::clear();
}

#[test]
fn pool_starts_with_a_nonzero_thread_count() {
    let _g = LOCK.lock();
    runtime::init(None);
    assert!(runtime::threads() >= 1);
}
