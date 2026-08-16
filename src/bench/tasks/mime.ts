// src/bench/tasks/mime.ts — CPU benchmark tasks: MIME-type lookup.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { toBytes } from '../../shared/bytes'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function mimeTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:mime',
      run: () => native.nativeMimeFromExtension('json').length,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:mime',
      run: () => toBytes(rust.mimeFromExtension(f.mimeExt)).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ]
}
