import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

// argon2id is intentionally CPU/memory-heavy; keep iterations low. The Rust
// side uses reduced memory cost (4 MiB, 1 iteration) so the comparison stays
// snappy; the JS baseline is Node's built-in scrypt (same class of work).
const options = { mCost: 4096, tCost: 1, pCost: 1 };

export function passwordTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: "native:password_hash",
      run: () =>
        native.nativePasswordHash(f.passwordBytes, f.passwordSalt, options)
          .byteLength,
      iterations: 10,
      warmup: 2,
    },
    {
      name: "rust:password_hash",
      run: () =>
        rust.passwordHash(f.passwordBytes, f.passwordSalt, options).byteLength,
      iterations: 10,
      warmup: 2,
    },
  ];
}
