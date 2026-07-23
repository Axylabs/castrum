import { dlopen, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rustSymbols } from "./symbols";

export function resolveLibraryPath(): string {
  const candidates = [
    process.env.RUST_BENCH_LIB,
    fileURLToPath(
      new URL(`../../target/release/librust_bench.${suffix}`, import.meta.url),
    ),
    fileURLToPath(
      new URL(`../../target/release/rust_bench.${suffix}`, import.meta.url),
    ),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const libPath = candidates.find((path) => existsSync(path));

  if (!libPath) {
    console.error("Could not find Rust shared library.");
    console.error("Run: cargo build --release");
    console.error(`Looked for: ${candidates.join(", ")}`);
    process.exit(1);
    throw new Error("Rust shared library not found");
  }

  return libPath;
}

export function loadRustLibrary() {
  const libPath = resolveLibraryPath();
  console.log(`Loading Rust library: ${libPath}`);
  return dlopen(libPath, rustSymbols);
}
