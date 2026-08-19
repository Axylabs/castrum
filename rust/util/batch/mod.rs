//! util/batch/ — packed aggregate batch helpers.
//!
//! The packed-wire batch machinery used by the `*_batch_packed` napi APIs and
//! the C-ABI `castrum_*_batch_packed` exports:
//!   - `core.rs` — generic packed-buffer routing (serial zero-alloc vs rayon
//!     direct-write) for the sum/bitset/bytes-map/count/total-len shapes, plus
//!     the one-off domain `*_bytes` helpers they wire. The rayon branch
//!     delegates to the generic `util::batch_core` helpers.
//!   - `api.rs` — the thin `#[napi]` boundary over `core.rs`.
//!   - `tests.rs` — serial/parallel parity + `_into` byte-parity tests.
//!
//! Public names are re-exported here so existing call sites keep working
//! unchanged (`crate::util::batch::*` and the `crate::util::run_*` shims in
//! `util/mod.rs`).

mod api;
mod core;

#[cfg(test)]
mod tests;

pub(crate) use self::core::*;
pub use self::api::*;
