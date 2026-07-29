// rust/core/runtime.rs — Generic runtime abstraction
// Pure Rust, no napi dependencies.
//
// Allows the same core logic to work under napi (Bun/Node) or native contexts.
// Only requires the caller to provide timestamp + buffer allocation.

use std::borrow::Cow;
use std::time::{SystemTime, UNIX_EPOCH};

// ── Runtime trait ──────────────────────────────────────────────────

/// Abstract runtime that the core modules can operate under.
///
/// Implementations: `NapiRuntime` (for Bun/Node via napi-rs), `NativeRuntime` (for CLI/testing).
pub trait Runtime {
    /// A buffer type that can be passed to/from the runtime.
    type Buffer: AsRef<[u8]> + AsMut<[u8]>;

    /// Allocate a buffer of the given size (zero-initialized).
    fn alloc_buffer(len: usize) -> Self::Buffer;

    /// Current wall-clock time in milliseconds since Unix epoch.
    fn now_ms() -> u64;

    /// Monotonic time in milliseconds (for measuring intervals).
    fn monotonic_ms() -> u128;
}

// ── Native (non-napi) Runtime ──────────────────────────────────────

/// Simple byte-vector based runtime for testing / non-napi usage.
pub struct NativeRuntime;

impl Runtime for NativeRuntime {
    type Buffer = Vec<u8>;

    #[inline(always)]
    fn alloc_buffer(len: usize) -> Vec<u8> {
        vec![0u8; len]
    }

    #[inline(always)]
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    #[inline(always)]
    fn monotonic_ms() -> u128 {
        // This is a best-effort monotonic clock.
        // For production, use a proper monotonic clock source.
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }
}

// ── Runtime-agnostic data structures ───────────────────────────────

/// Result of parsing a packed batch.
#[derive(Debug, Clone)]
pub struct PackedResult<'a> {
    pub items: Vec<&'a [u8]>,
    pub count: usize,
}

/// A generic key-value pair.
#[derive(Debug, Clone)]
pub struct KvPair<'a> {
    pub key: Cow<'a, [u8]>,
    pub value: Cow<'a, [u8]>,
}

/// Output modes for JSON serialization.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JsonEscapeMode {
    /// Input is valid UTF-8 (optimized path).
    Utf8,
    /// Input is arbitrary binary (must escape everything as \u00XX).
    Binary,
}

impl JsonEscapeMode {
    /// Determine the escape mode from a byte slice.
    #[inline(always)]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        if bytes.is_empty() {
            return Self::Utf8;
        }
        if bytes.iter().all(|&b| b < 0x80) {
            return Self::Utf8;
        }
        if std::str::from_utf8(bytes).is_ok() {
            Self::Utf8
        } else {
            Self::Binary
        }
    }
}
