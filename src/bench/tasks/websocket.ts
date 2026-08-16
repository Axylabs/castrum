// src/bench/tasks/websocket.ts — CPU benchmark tasks: WebSocket frame codec + accept-key.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function websocketTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:ws_accept_key',
      run: () => native.nativeWsAcceptKey(f.wsKey).byteLength,
      iterations: 1000,
      warmup: 100,
    },
    {
      name: 'rust:ws_accept_key',
      run: () => rust.wsAcceptKey(f.wsKeyBytes).length,
      iterations: 1000,
      warmup: 100,
    },
  ]
}
