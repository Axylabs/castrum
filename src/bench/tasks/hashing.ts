import * as native from "../../baseline";
import { rust } from "../../rust-ffi/raw";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function hashingTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:crc32",
      run: () => native.nativeCrc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:crc32",
      run: () => rust.crc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "native:fnv1a64",
      run: () => native.nativeFnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:fnv1a64",
      run: () => rust.fnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
  ];
}
