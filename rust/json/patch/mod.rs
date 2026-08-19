//! RFC 6902 JSON Patch — bounded scalar apply + parallel packed batch.
//!
//! Pure-Rust core (`apply_json_patch_bytes`, `run_json_patch_batch`) is
//! napi-free and unit-testable; the `#[napi]` entry points (`json_patch`,
//! `json_patch_batch_packed`) are thin boundaries that map `JsonPatchError` →
//! napi `Error` with stable context.
//!
//! Folder layout:
//!   - `pointer.rs` — RFC 6901 JSON Pointer parsing (escape rules).
//!   - `ops.rs`     — patch document parsing + RFC 6902 apply over sonic Value.
//!   - `engine.rs`  — bounded scalar apply + serial/rayon packed batch.
//!   - `api.rs`     — napi boundary.
//!   - `tests.rs`   — unit tests.
//!
//! **Sonic engine**: the `json-patch` crate is hardwired to `serde_json::Value`
//! (a per-key heap `String` DOM). This module implements RFC 6902 directly over
//! `sonic_rs::Value` (compact tagged nodes, no per-key heap `String`), so the
//! patch path no longer builds a `serde_json` DOM. RFC 6901 pointer escapes
//! (`~0`→`~`, `~1`→`/`) are validated eagerly at patch parse (bad escapes →
//! `InvalidPatch`, matching the crate's eager deserialization). The `test` op
//! uses sonic's `Value ==`, which has serde_json-identical number semantics
//! (`1 != 1.0`), preserving the crate's behavior.
//!
//! Hardening / efficiency notes:
//! - **Bounded sizes** — inputs are capped (`MAX_JSON_PATCH_INPUT`) and the
//!   result is capped (`MAX_JSON_PATCH_OUTPUT`). A malicious chain of
//!   RFC 6902 `copy` ops duplicates subtrees and can grow the output
//!   exponentially relative to the input; the cap refuses to hand such output
//!   back to the caller.
//! - **Capacity** — the common in-place field/array edit keeps the result ≈ the
//!   document size, so serialization starts at `doc.len()` and grows only when
//!   a patch genuinely expands the document (no 2× over-allocation for
//!   `test`/`remove`-heavy patches).
//! - **Scalability** — `json_patch_batch_packed` zips two packed buffers and
//!   applies patches in parallel via rayon when the workload justifies it
//!   (`should_parallelize`), staying serial and deterministic otherwise.

mod api;
mod engine;
mod ops;
mod pointer;

#[cfg(test)]
mod tests;

pub use self::api::{json_patch, json_patch_batch_packed};
pub use self::engine::{apply_json_patch_bytes, run_json_patch_batch, JsonPatchError};
