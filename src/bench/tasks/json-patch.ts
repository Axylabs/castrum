// src/bench/tasks/json-patch.ts — CPU benchmark tasks: JSON Patch (RFC 6902).

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function jsonPatchTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:json_patch',
      run: () => native.nativeJsonPatch(f.jsonDoc, f.jsonPatch).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:json_patch',
      run: () => rust.jsonPatch(f.jsonDoc, f.jsonPatch).length,
      iterations: 500,
      warmup: 50,
    },
  ]
}
