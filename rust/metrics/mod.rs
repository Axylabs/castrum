//! Metrics — a sharded, zero-dependency counters / gauges / histograms
//! registry with a Prometheus text-format renderer.
//!
//! Pure-Rust core (no napi types in signatures) so it stays unit-testable with
//! plain `cargo test`; the `#[napi]` projection lives in `api.rs` and the C-ABI
//! (`castrum_metrics_*`) exports in `rust/ffi/metrics.rs`. Both entry points
//! wrap the SAME [`registry::MetricsRegistry`] core.
//!
//! Design notes:
//! - Series are addressed by a `u32` family id returned at declaration time;
//!   per-label-set state lives in 64 lock-sharded hash maps keyed by the
//!   packed label bytes, so the hot path is one mutex acquire + one hash.
//! - Label VALUES cross the C ABI packed in ONE buffer separated by `\x1f`
//!   (unit separator); values must not contain `\x1f` or NUL (validated).
//! - Render output is deterministic: families in declaration order, series
//!   sorted by raw label bytes within each family.

pub mod api;
pub mod registry;

pub use self::registry::MetricsRegistry;
