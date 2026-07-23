# bun-rust-practical

Practical Bun + Rust FFI benchmark package.

This package keeps only the practical Rust-accelerated functions and their native Bun/JavaScript benchmark equivalents.

## Build

```bash
bun install
cargo build --release
```

## Benchmark

```bash
bun bench.ts
```

Or:

```bash
bun run bench
```

## Exported API

```ts
import { rust, native } from "bun-rust-practical";
```

`rust` contains Rust FFI implementations.

`native` contains JavaScript/Bun baseline implementations used for benchmarking.
