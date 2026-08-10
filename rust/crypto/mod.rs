// rust/crypto/mod.rs — Auth & hashing.
//
// Pure-Rust crypto primitives + compiled-once napi instances (each instance
// precompiles its key/engine/params once at construction):
//   - hmac_sha256.rs   HMAC-SHA256 (+ HmacSigner instance)
//   - cookie_sign.rs   signed cookies `value.signature` (CookieSigner)
//   - csrf.rs          CSRF tokens, random hex + HMAC (CsrfProtector)
//   - jwt.rs           hand-rolled HS256 JWT (JwtSigner) + batch
//   - aead.rs          AES-256-GCM / chacha20-poly1305 (AeadCipher) + batch
//   - argon2.rs        argon2id password hashing (Argon2Hasher) + batch
//   - base64.rs        base64/base64url/hex codecs (Base64Codec)
//   - hashing.rs       FNV-1a / XXH3 / crc32 checksums
//   - random_token.rs  random hex tokens

pub mod aead;
pub mod argon2;
pub mod base64;
pub mod cookie_sign;
pub mod csrf;
pub mod hashing;
pub mod hmac_sha256;
pub mod jwt;
pub mod random_token;
