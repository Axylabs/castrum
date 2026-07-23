import * as native from "../../baseline";
import { rust } from "../../rust-ffi/raw";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function mimeTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:mime",
      run: () => native.nativeMimeFromExtension("json").length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:mime",
      run: () => rust.mimeFromExtension(f.mimeExt).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
