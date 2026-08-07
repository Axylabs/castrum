import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function jsonTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:json_valid",
      run: () => native.nativeJsonValid(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_valid",
      run: () => rust.jsonValid(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:json_parse",
      run: () => (native.nativeJsonParse(f.jsonPayload) as unknown[]).length,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_parse",
      run: () => (rust.jsonParse(f.jsonPayload) as unknown[]).length,
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:json_sum",
      run: () => native.nativeJsonSum(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_sum",
      run: () => rust.jsonSumIds(f.jsonPayload),
      iterations: 100,
      warmup: 10,
    },
  ];
}
