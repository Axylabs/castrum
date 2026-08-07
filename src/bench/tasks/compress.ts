import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function compressTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:gzip_compress",
      run: () => native.nativeGzipCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:gzip_compress",
      run: () => rust.gzipCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:gzip_decompress",
      run: () => native.nativeGzipDecompress(f.gzipCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:gzip_decompress",
      run: () => rust.gzipDecompress(f.gzipCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:brotli_compress",
      run: () => native.nativeBrotliCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:brotli_compress",
      run: () => rust.brotliCompress(f.compressPayload).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:brotli_decompress",
      run: () => native.nativeBrotliDecompress(f.brotliCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:brotli_decompress",
      run: () => rust.brotliDecompress(f.brotliCompressed).byteLength,
      iterations: 100,
      warmup: 10,
    },
  ];
}
