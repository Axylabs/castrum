import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function cookieTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:cookie_parse",
      run: () => native.nativeCookieParse(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:cookie_parse",
      run: () => rust.cookieParse(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
  ];
}
