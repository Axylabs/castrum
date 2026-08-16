// src/bench/tasks/jwt.ts — CPU benchmark tasks: JWT sign / verify.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { encoder } from '../../shared/bytes'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function jwtTasks(f: BenchFixtures): BenchTask[] {
  // Pre-serialized claims (the byte-JSON overload's input).
  const claimsJson = encoder.encode(JSON.stringify(f.jwtClaims))

  return [
    {
      name: 'native:jwt_sign',
      run: () => native.nativeJwtSign(f.jwtClaims, f.jwtSecret, 3600, f.jwtNowSeconds).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:jwt_sign',
      run: () => rust.jwtSign(f.jwtClaims, f.jwtSecret, 3600, f.jwtNowSeconds).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:jwt_sign_bytes',
      run: () => rust.jwtSignBytes(claimsJson, f.jwtSecret, 3600, f.jwtNowSeconds).length,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:jwt_verify',
      run: () => (native.nativeJwtVerify(f.jwtToken, f.jwtSecret, f.jwtNowSeconds) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:jwt_verify',
      run: () => (rust.jwtVerify(f.jwtToken, f.jwtSecret, f.jwtNowSeconds) !== null ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
  ]
}
