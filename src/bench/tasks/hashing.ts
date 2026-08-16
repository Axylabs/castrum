// src/bench/tasks/hashing.ts — CPU benchmark tasks: FNV-1a / crc32 / xxh3.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { rawCrc32 } from '../raw-native'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function hashingTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:crc32',
      run: () => native.nativeCrc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:crc32',
      // `rust.crc32` delegates to Bun.hash.crc32 under Bun (BUN_WINS), so
      // measure the raw addon here to keep the audit about the addon vs the
      // node baseline.
      run: () => rawCrc32(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:fnv1a64',
      run: () => native.nativeFnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:fnv1a64',
      run: () => rust.fnv1a64(f.crcInput),
      iterations: 1000,
      warmup: 100,
    },
  ]
}
