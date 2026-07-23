import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function queryTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:query_parse",
      run: () => native.nativeQueryParse(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:query_parse",
      run: () => rust.queryParse(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
