// test/differential/transport-runner.ts — subprocess entry for the transport
// lane.
//
// The ffi/napi transport is selected once per process (`CASTRUM_FFI_MODE`,
// cached by `getBunFFI`), so `lanes.ts` cannot switch it in-process. This
// runner executes ONE lane (the baked route lane) with whatever transport the
// environment selected and prints the normalized result as JSON; the test
// spawns it twice (`CASTRUM_FFI_MODE=ffi` and `=napi`) and diffs the output.
//
// Not a `*.test.ts` file, so `bun test` does not pick it up.

import { CORPUS } from './corpus'
import { runLane } from './lanes'

const result = await runLane('baked', CORPUS)
process.stdout.write(JSON.stringify(result))
