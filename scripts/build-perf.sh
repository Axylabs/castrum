#!/usr/bin/env bash
# scripts/build-perf.sh — machine-local, maximum-performance build.
#
# IMPORTANT: this is for LOCAL benchmarking only. It compiles for the host's
# x86-64-v3 microarchitecture (AVX2/BMI2/FMA/SSE4.2), which unlocks SIMD in
# crc32fast, sonic-rs, memchr, xxh3, simdutf8, and mimalloc.
#
# Published artifacts MUST use the baseline `bun run build` so they run on any
# x86-64 / aarch64 machine. Never use this script for `npm publish`.
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)
    echo "→ Building for x86-64-v3 (AVX2/BMI2/FMA/SSE4.2) — LOCAL ONLY, not for publish."
    CARGO_BUILD_RUSTFLAGS="-C target-cpu=x86-64-v3 -C target-feature=+avx2,+bmi2,+fma,+sse4.2 -C link-arg=-Wl,--gc-sections" \
      bun run build
    ;;
  arm64|aarch64)
    echo "→ aarch64 host: no target-cpu override (native baseline). Use 'bun run build' for publish."
    bun run build
    ;;
  *)
    echo "→ Unsupported arch '$ARCH'; falling back to baseline build." >&2
    bun run build
    ;;
esac
