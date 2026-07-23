import * as native from "../../baseline";
import { rust } from "../../rust-ffi/raw";
import type { BenchTask } from "../types";

export function tokenTasks(): BenchTask[] {
  return [
    {
      name: "native:random_token",
      run: () => native.nativeRandomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:random_token",
      run: () => rust.randomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
