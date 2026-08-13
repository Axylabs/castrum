import * as native from '../../baseline'
import { rawRandomToken } from '../raw-native'
import type { BenchTask } from '../types'

export function tokenTasks(): BenchTask[] {
  return [
    {
      name: 'native:random_token',
      run: () => native.nativeRandomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:random_token',
      // `rust.randomToken` delegates to crypto.getRandomValues under Bun
      // (BUN_WINS), so measure the raw addon here to keep the audit about the
      // addon vs the node baseline.
      run: () => rawRandomToken(32).byteLength,
      iterations: 1000,
      warmup: 100,
    },
  ]
}
