#!/usr/bin/env bash
# scripts/build-v3.sh — build the x86-64-v3 (AVX2/BMI2/FMA/SSE4.2) addon variant.
#
# Produces `castrum.linux-x64-v3-gnu.node` in the package root, ALONGSIDE the
# baseline `castrum.linux-x64-gnu.node` produced by `bun run build` (napi).
# At runtime `src/native/loader.ts` picks the v3 variant when the host CPU
# supports x86-64-v3 AND the file is present, else falls back to baseline.
# ignus's own loader (packages/native/src/loader.ts) applies the same rule.
#
# This is a CPU-feature variant of the SAME x86_64-unknown-linux-gnu target —
# NOT a separate napi target — so it must stay OUT of package.json `napi.targets`
# (napi builds one binary per rust triple; CPU tiers are handled by the loader).
# It is built with a dedicated CARGO_TARGET_DIR so it never clobbers the
# baseline release artifacts in `target/release`.
#
# Usage: bash scripts/build-v3.sh   (x86-64 Linux only; no-op elsewhere)
# Package script: bun run build:v3
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ;;
  *)
    echo "→ x86-64-v3 variant not applicable on '$ARCH'; skipping." >&2
    exit 0
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/castrum.linux-x64-v3-gnu.node"

echo "→ Building x86-64-v3 addon variant (AVX2/BMI2/FMA/SSE4.2)…"

# The v3 cdylib is byte-for-byte the same Rust crate as the baseline build —
# only the target CPU differs. `lto = "fat"` + `codegen-units = 1` from the
# release profile apply here too (inherited from Cargo.toml).
CARGO_TARGET_DIR="$ROOT/target/perf" \
CARGO_BUILD_RUSTFLAGS="-C target-cpu=x86-64-v3 -C target-feature=+avx2,+bmi2,+fma,+sse4.2" \
  cargo build --release --lib

cp "$ROOT/target/perf/release/libcastrum.so" "$OUT"
echo "→ wrote $OUT"
