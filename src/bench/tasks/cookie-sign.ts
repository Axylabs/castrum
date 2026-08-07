// src/bench/tasks/cookie-sign.ts — signed-cookie benchmarks.
//
// node:crypto HMAC baseline vs Rust CookieSigner (instance constructed once
// with the secret, reused across iterations).

import { rust } from "../../rust-ffi";
import {
  nativeSignCookie,
  nativeVerifyCookie,
} from "../cookie-sign-baseline";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function cookieSignTasks(f: BenchFixtures): BenchTask[] {
  // Higher-order instance: HMAC key compiled once, reused.
  const signer = rust.createCookieSigner(f.cookieSecret);
  const signed = signer.sign(f.cookieValue);

  return [
    {
      name: "native:cookie_sign",
      run: () => nativeSignCookie(f.cookieValue, f.cookieSecret).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:cookie_sign",
      run: () => signer.sign(f.cookieValue).byteLength,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "native:cookie_verify",
      run: () => nativeVerifyCookie(signed, f.cookieSecret)?.byteLength ?? 0,
      iterations: 300,
      warmup: 30,
    },
    {
      name: "rust:cookie_verify",
      run: () => signer.verify(signed)?.byteLength ?? 0,
      iterations: 300,
      warmup: 30,
    },
  ];
}
