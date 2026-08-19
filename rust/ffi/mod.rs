//! C-ABI (`extern "C"`) exports for `bun:ffi` (Bun's JIT-compiled FFI,
//! ~10-20ns crossing vs ~100-300ns for N-API). The same cdylib serves BOTH
//! runtimes: Node loads it through napi-rs (napi_register_module_v1), Bun can
//! additionally `dlopen` it via `bun:ffi` and call these functions directly.
//!
//! The stateless `&[u8] -> scalar` / `&[u8] -> write-into-buffer` hot functions
//! (where the N-API crossing dominates the sub-µs cost) are the bulk of the
//! surface. The stateful ingress pipeline is ALSO exposed via
//! `castrum_ingress_handle_packed`, which takes the opaque inner handle from
//! `Ingress.ingressInnerPtr()` (valid only while the instance is alive — see
//! the function's safety note). Buffer-taking fns use raw `(ptr, len)` pairs;
//! output-buffer fns use `(out, out_cap)` and return bytes written (0 = error /
//! too small).
//!
//! # Safety
//! Every function is `unsafe` in the Rust sense (raw pointers) but keeps the
//! read/write within the caller-declared lengths. Callers (bun:ffi bindings in
//! `src/native/ffi.ts`) must pass pointers into live buffers of at least the
//! declared length, and for `castrum_ingress_handle_packed` a live handle from a
//! live `Ingress` instance.
//!
//! # Layout
//! Split by domain so the ~80 `castrum_*` symbols stay navigable. The symbol
//! registry contract (the dlopen map in `src/native/ffi.ts` + the source-level
//! parity guard in `test/unit/features/ffi-symbol-parity.test.ts`) is agnostic
//! to module layout — symbol NAMES never move, only the files they live in:
//!   - `util.rs` — shared helpers (`panic_guard`, `hmac_key_cached`, `aead_alg`,
//!     `cstring_return`/`CSTR_BUF`, `write_rate_check`)
//!   - `hashing.rs` — crc32 / fnv1a / xxh3, json/utf8 validity, hex/url codecs
//!   - `validators.rs` — email / UUID / IPv4 / IPv6 (`validator_c_abi!`)
//!   - `crypto.rs` — hmac, cookie sign/verify, csrf, password hash/verify, pbkdf2,
//!     aead, base64, random token
//!   - `jwt.rs` — jwt signer/verify + ed25519 / EdDSA JWT
//!   - `http.rs` — etag, conditional, http-date, media-type, accept, mime, url
//!     resolve/encode, http/query/cookie/form/multipart parse
//!   - `payload.rs` — ws accept key + frames, gzip/brotli, sse
//!   - `json.rs` — json patch, packed json token stream, schema validator
//!   - `rate_limit.rs` — rate limiter checks
//!   - `ingress.rs` — ingress pipeline + layout constants
//!   - `route.rs` — per-route native stack (`castrum_route_*`)
//!   - `tests.rs` — C-ABI unit tests

mod crypto;
mod hashing;
mod http;
mod ingress;
mod json;
mod jwt;
mod payload;
mod probe;
mod rate_limit;
mod route;
mod util;
mod validators;

#[cfg(test)]
mod tests;

// Re-export every symbol at the `ffi` module root so the shared `tests.rs`
// (`use super::*`) keeps working unchanged. The `#[no_mangle]` link symbols are
// independent of Rust visibility, so nothing in non-test code needs them.
#[cfg(test)]
pub(crate) use self::{crypto::*, hashing::*, http::*, ingress::*, json::*, jwt::*, payload::*, rate_limit::*, route::*, util::*, validators::*};
