// src/bench/tasks/bun-builtins.ts — DIAGNOSTIC benchmark: castrum ops vs Bun
// built-ins. Answers "don't reinvent the wheel": for the same workload, does
// Bun's native implementation beat the Rust op?
//
// Task names use the `diag:` prefix (NOT `native:`/`rust:`) so the proven
// audit (src/shared/bench-classify.ts: matches PROVEN_SURFACE rustTask names
// or their `_`-suffixed variants) never aggregates these into a registry
// entry. The results land in bench/results/cpu/latest.json comparisons[] and
// feed docs/bun-builtins-decision-matrix.md.

import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

// Reduced argon2id cost (4 MiB / 1 iter) — matches the existing password
// bench so the comparison is cost-for-cost (see src/bench/tasks/password.ts).
const ARGON_OPTIONS = { mCost: 4096, tCost: 1, pCost: 1 };

export function bunBuiltinsTasks(f: BenchFixtures): BenchTask[] {
  return [
    // ── Hashing: Bun.hash (wyhash) / Bun.hash.crc32 vs FNV-1a / CRC32 ──
    {
      name: "diag:bun_hash_wyhash",
      run: () => native.nativeBunHashWyhash(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:fnv1a64",
      run: () => rust.fnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:bun_hash_crc32",
      run: () => native.nativeBunHashCrc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:crc32",
      run: () => rust.crc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:bun_hash_xxh3",
      run: () => native.nativeBunHashXxh3(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:xxh3",
      run: () => rust.xxh3(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },

    // ── HMAC: Bun.CryptoHasher vs rust.hmacSha256 ──
    {
      name: "diag:bun_hmac_sha256",
      run: () => native.nativeBunHmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "diag:hmac_sha256",
      run: () => rust.hmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },

    // ── Password: Bun.password.argon2id vs rust.passwordHash / Verify ──
    {
      name: "diag:bun_password_hash",
      run: () => native.nativeBunPasswordHash(f.passwordBytes, f.passwordSalt).length,
      iterations: 5,
      warmup: 1,
    },
    {
      name: "diag:password_hash",
      run: () => rust.passwordHash(f.passwordBytes, f.passwordSalt, ARGON_OPTIONS).byteLength,
      iterations: 5,
      warmup: 1,
    },
    {
      name: "diag:bun_password_verify",
      run: () => (native.nativeBunPasswordVerify(f.passwordBytes) ? 1 : 0),
      iterations: 5,
      warmup: 1,
    },
    {
      name: "diag:password_verify",
      run: () => {
        // Memoize a rust argon2id PHC for the (constant) fixture password once.
        if (RUST_VERIFY_PHC === null) {
          RUST_VERIFY_PHC = rust.passwordHash(f.passwordBytes, f.passwordSalt, ARGON_OPTIONS);
        }
        return rust.passwordVerify(f.passwordBytes, RUST_VERIFY_PHC) ? 1 : 0;
      },
      iterations: 5,
      warmup: 1,
    },

    // ── Password (bcrypt): Bun.password bcrypt vs rust bcrypt ──
    {
      name: "diag:bun_password_bcrypt_hash",
      run: () => native.nativeBunPasswordHashBcrypt(f.passwordBytes, BCRYPT_COST).length,
      iterations: 3,
      warmup: 1,
    },
    {
      name: "diag:bcrypt_hash",
      run: () => rust.passwordHashBcrypt(f.passwordBytes, BCRYPT_COST).length,
      iterations: 3,
      warmup: 1,
    },
    {
      name: "diag:bun_password_bcrypt_verify",
      run: () => (native.nativeBunPasswordVerifyBcrypt(f.passwordBytes, BCRYPT_COST) ? 1 : 0),
      iterations: 3,
      warmup: 1,
    },
    {
      name: "diag:bcrypt_verify",
      run: () => {
        if (RUST_BCRYPT_HASH === null) {
          RUST_BCRYPT_HASH = rust.passwordHashBcrypt(f.passwordBytes, BCRYPT_COST);
        }
        return rust.passwordVerifyBcrypt(f.passwordBytes, RUST_BCRYPT_HASH) ? 1 : 0;
      },
      iterations: 3,
      warmup: 1,
    },

    // ── PBKDF2: rust vs node:crypto pbkdf2Sync (Bun has no sync PBKDF2) ──
    {
      name: "diag:pbkdf2_sha256",
      run: () => native.nativePbkdf2Sha256(f.passwordBytes, f.passwordSalt, PBKDF2_ROUNDS, 32).byteLength,
      iterations: 10,
      warmup: 2,
    },
    {
      name: "diag:pbkdf2_sha256_rust",
      run: () => rust.pbkdf2Sha256(f.passwordBytes, f.passwordSalt, PBKDF2_ROUNDS, 32).byteLength,
      iterations: 10,
      warmup: 2,
    },

    // ── Random: Bun.randomUUIDv7 vs rust.randomToken(16) ──
    {
      name: "diag:bun_random_uuidv7",
      run: () => native.nativeBunRandomUuidV7().length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "diag:random_token16",
      run: () => rust.randomToken(16).byteLength,
      iterations: 1000,
      warmup: 100,
    },

    // ── Compression: Bun.gzipSync/gunzipSync + brotli sync vs rust ──
    {
      name: "diag:bun_gzip_compress",
      run: () => native.nativeBunGzipCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "diag:gzip_compress",
      run: () => rust.gzipCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "diag:bun_gzip_decompress",
      run: () => native.nativeBunGunzip(f.gzipCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "diag:gzip_decompress",
      run: () => rust.gzipDecompress(f.gzipCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },

    // NOTE: Bun has no synchronous brotli or Bun.validators in this version
    // (verified at runtime), so those comparisons are intentionally absent —
    // see docs/bun-builtins-decision-matrix.md.
  ];
}

// Module-level memoized rust argon2id PHC string for the fixture password.
let RUST_VERIFY_PHC: Uint8Array | null = null;
// Module-level memoized rust bcrypt PHC string for the fixture password.
let RUST_BCRYPT_HASH: string | null = null;

// Cost / rounds shared by the bcrypt + pbkdf2 diagnostic pairs.
const BCRYPT_COST = 10;
const PBKDF2_ROUNDS = 100_000;
