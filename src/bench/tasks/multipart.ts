import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function multipartTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:multipart_parse",
      run: () =>
        native
          .nativeMultipartParse(f.multipartBody, f.multipartBoundary)
          .length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: "rust:multipart_parse",
      run: () =>
        rust.multipartParse(f.multipartBody, f.multipartBoundary).length,
      iterations: 1000,
      warmup: 100,
    },
  ];
}
