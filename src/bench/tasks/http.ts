import * as native from "../../baseline";
import { rust } from "../../rust-ffi/raw";
import { readHttpPacked } from "../../shared/packed";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function httpTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:http_parse",
      run: () => native.nativeHttpParseRequestPacked(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:http_parse",
      run: () => rust.httpParseRequestPacked(f.httpRaw).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:http_parse_pipeline",
      run: () => {
        const parsed = readHttpPacked(
          native.nativeHttpParseRequestPacked(f.httpRaw),
        );
        return (
          parsed.method.length +
          parsed.path.length +
          Object.keys(parsed.headers).length
        );
      },
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:http_parse_pipeline",
      run: () => {
        const parsed = readHttpPacked(rust.httpParseRequestPacked(f.httpRaw));
        return (
          parsed.method.length +
          parsed.path.length +
          Object.keys(parsed.headers).length
        );
      },
      iterations: 300,
      warmup: 30,
    },
  ];
}