import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function urlTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:url_encode",
      run: () => native.nativeUrlEncode("hello world & foo=bar").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:url_encode",
      run: () => rust.urlEncode(f.urlEncodeInput).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:url_decode",
      run: () =>
        native.nativeUrlDecode("hello%20world%20%26%20foo%3Dbar").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:url_decode",
      run: () => rust.urlDecode(f.urlDecodeInput).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    // Pooled-output variants: a single pre-allocated buffer reused across
    // iterations, so the FFI crossing is the only per-call cost (no Vec+Buffer
    // alloc). Shows Rust's best case vs the allocating native baseline.
    {
      name: "rust:url_encode_into",
      run: (() => {
        const out = new Uint8Array(256);
        return () => rust.urlEncodeInto(f.urlEncodeInput, out);
      })(),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:url_decode_into",
      run: (() => {
        const out = new Uint8Array(256);
        return () => rust.urlDecodeInto(f.urlDecodeInput, out);
      })(),
      iterations: 1000,
      warmup: 100,
    },
  ];
}
