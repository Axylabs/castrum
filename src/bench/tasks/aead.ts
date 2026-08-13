import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function aeadTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:aead_encrypt',
      run: () => native.nativeAeadEncrypt(f.aeadKey, f.aeadNonce, f.aeadPlaintext).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:aead_encrypt',
      run: () => rust.aeadEncrypt(f.aeadKey, f.aeadNonce, f.aeadPlaintext).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:aead_decrypt',
      run: () =>
        native.nativeAeadDecrypt(f.aeadKey, f.aeadNonce, f.aeadCiphertext)?.byteLength ?? 0,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:aead_decrypt',
      run: () => rust.aeadDecrypt(f.aeadKey, f.aeadNonce, f.aeadCiphertext)?.byteLength ?? 0,
      iterations: 500,
      warmup: 50,
    },
  ]
}
