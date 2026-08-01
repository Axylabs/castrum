import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import { pairsToObject, readPairsPacked } from "../../shared/packed";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function cookieTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:cookie_parse",
      run: () => native.nativeCookieParsePacked(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:cookie_parse",
      run: () => rust.cookieParsePacked(f.cookieStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:cookie_parse_pipeline",
      run: () => {
        const obj = pairsToObject(
          readPairsPacked(native.nativeCookieParsePacked(f.cookieStr)),
        );
        return Object.keys(obj).length;
      },
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:cookie_parse_pipeline",
      run: () => {
        const obj = pairsToObject(
          readPairsPacked(rust.cookieParsePacked(f.cookieStr)),
        );
        return Object.keys(obj).length;
      },
      iterations: 300,
      warmup: 30,
    },
  ];
}