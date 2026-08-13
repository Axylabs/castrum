import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { rawHmacSha256 } from '../raw-native'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function hmacTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:hmac_sha256',
      run: () => native.nativeHmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:hmac_sha256',
      // `rust.hmacSha256` delegates to Bun.CryptoHasher under Bun (BUN_WINS),
      // so measure the raw addon here to keep the audit about the addon vs
      // the node baseline.
      run: () => rawHmacSha256(f.hmacKey, f.hmacData).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:hmac_verify',
      run: () => (native.nativeHmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:hmac_verify',
      run: () => rust.hmacSha256Verify(f.hmacKey, f.hmacData, f.hmacSig),
      iterations: 500,
      warmup: 50,
    },
  ]
}
