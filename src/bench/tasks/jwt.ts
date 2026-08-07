import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function jwtTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:jwt_sign",
      run: () =>
        native
          .nativeJwtSign(f.jwtClaims, f.jwtSecret, 3600, f.jwtNowSeconds)
          .byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:jwt_sign",
      run: () =>
        rust.jwtSign(f.jwtClaims, f.jwtSecret, 3600, f.jwtNowSeconds).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:jwt_verify",
      run: () =>
        native.nativeJwtVerify(f.jwtToken, f.jwtSecret, f.jwtNowSeconds) ? 1 : 0,
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:jwt_verify",
      run: () =>
        rust.jwtVerify(f.jwtToken, f.jwtSecret, f.jwtNowSeconds) !== null ? 1 : 0,
      iterations: 500,
      warmup: 50,
    },
  ];
}
