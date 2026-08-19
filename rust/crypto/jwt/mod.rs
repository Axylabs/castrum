//! HS256 / EdDSA JSON Web Tokens.
//!
//! Split into a small folder so the token machinery is navigable:
//!   - `token.rs` — pure token core (headers, HMAC, split/build/verify, zero-DOM
//!     time-claim checks, `iat`/`exp` injection). Reused by the napi boundary,
//!     the C-ABI fast paths in `rust/ffi.rs`, and `crate::crypto::ed25519`.
//!   - `api.rs` — napi entry points (scalar sign/verify, precompiled-key
//!     `JwtSigner` instance, C-ABI `_core` helpers, packed sign/verify batches).
//!   - `tests.rs` — unit tests.
//!
//! All items are re-exported at this module root (`pub use self::token::*` +
//! `pub use self::api::*`) so existing `crate::crypto::jwt::*` call sites keep
//! working unchanged.

mod api;
mod token;

#[cfg(test)]
mod tests;

pub use self::api::*;
pub use self::token::*;
