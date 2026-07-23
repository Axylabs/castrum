import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function httpTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:http_parse",
      run: () => native.nativeHttpParseRequest(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:http_parse",
      run: () => rust.httpParseRequest(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
