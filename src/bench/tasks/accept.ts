// src/bench/tasks/accept.ts — Accept-Encoding negotiation benchmarks.
//
// Hand-rolled JS baseline vs Rust AcceptNegotiator (instance constructed once
// with the supported list, reused across iterations).

import { rust } from "../../rust-ffi";
import { decoder } from "../../shared/bytes";
import { nativeNegotiateEncoding } from "../accept-baseline";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

const SUPPORTED = ["gzip", "br", "identity"];

export function acceptTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: supported list compiled once, reused.
  const negotiator = rust.createAcceptNegotiator(SUPPORTED);
  const headerStr = decoder.decode(f.acceptEncodingHeader);

  return [
    {
      name: "native:accept_negotiate",
      run: () => nativeNegotiateEncoding(SUPPORTED, headerStr)?.length ?? 0,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:accept_negotiate",
      run: () => negotiator.negotiate(f.acceptEncodingHeader)?.length ?? 0,
      iterations: 300,
      warmup: 30,
    },
  ];
}
