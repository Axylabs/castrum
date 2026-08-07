// src/bench/tasks/csrf.ts — CSRF token create/verify benchmarks.
//
// node:crypto baseline vs Rust CsrfProtector (instance constructed once with
// the secret, reused across iterations).

import { rust } from "../../rust-ffi";
import { nativeCsrfToken, nativeCsrfVerify } from "../csrf-baseline";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function csrfTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: HMAC key compiled once, reused.
  const protector = rust.createCsrfProtector(f.csrfSecret);
  const token = protector.create();

  return [
    {
      name: "native:csrf_create",
      run: () => nativeCsrfToken(f.csrfSecret).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:csrf_create",
      run: () => protector.create().byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "native:csrf_verify",
      run: () => (nativeCsrfVerify(token, f.csrfSecret) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:csrf_verify",
      run: () => (protector.verify(token) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
  ];
}
