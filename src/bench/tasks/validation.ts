// src/bench/tasks/validation.ts — CPU benchmark tasks: email / UUID / IPv4 / IPv6 validation.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function validationTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:validate_email',
      run: () => (native.nativeValidateEmail(f.emailOk) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:validate_email',
      run: () => rust.validateEmail(f.emailOk),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:validate_uuid',
      run: () => (native.nativeValidateUuid(f.uuidOk) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:validate_uuid',
      run: () => rust.validateUuid(f.uuidOk),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:validate_ipv4',
      run: () => (native.nativeValidateIpv4(f.ipv4Ok) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:validate_ipv4',
      run: () => rust.validateIpv4(f.ipv4Ok),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'native:validate_ipv6',
      run: () => (native.nativeValidateIpv6(f.ipv6Ok) ? 1 : 0),
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:validate_ipv6',
      run: () => rust.validateIpv6(f.ipv6Ok),
      iterations: 1000,
      warmup: 100,
    },
  ]
}
