// src/native/ffi/build/task.ts — off-thread task runtime BunFFI methods.
//
// The thinnest possible binding: `rust/task/` owns the pool, the result ring,
// and the batched doorbell. This file only adapts the `(ptr,len)` ABI pair
// (probe-gated `buffer`/`buffer_length` vs explicit lengths) and converts the
// `u64_fast` byte counts to numbers.
//
// See docs/RND-CONCURRENCY.md for the design and the measured costs.

import type { BunFFI, Raw0, Raw2, Raw4, Raw6 } from '../types'
import type { BuildCtx } from './util'

/** Raw 1-arg C-ABI symbol signature (a lone scalar arg or a bare pointer). */
type Raw1 = (a: unknown) => number | bigint

/**
 * Build the off-thread task-runtime methods of the BunFFI surface. `ctx`
 * supplies the probe-gated length adapter (`lenOrView`).
 */
export function buildTask(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView } = ctx

  const init = sym.castrum_task_init as Raw1
  const submit = sym.castrum_task_submit as Raw4
  const submitOut = sym.castrum_task_submit_out as Raw6
  const submitSlice = sym.castrum_task_submit_slice as Raw6
  const drain = sym.castrum_task_drain as Raw2
  const pending = sym.castrum_task_pending as Raw0
  const cancel = sym.castrum_task_cancel as Raw1
  const setDoorbell = sym.castrum_task_set_doorbell as Raw1
  const shutdown = sym.castrum_task_shutdown as Raw0
  const threads = sym.castrum_task_threads as Raw0

  return {
    taskInit: (n) => Number(init(n)),
    // `args` is copied onto the worker by Rust, so the caller's pooled buffer
    // may be released as soon as this returns.
    taskSubmit: (op, args, taskId) => Number(submit(op, args, lenOrView(args), taskId)),
    taskSubmitOut: (op, args, taskId, output) =>
      Number(submitOut(op, args, lenOrView(args), taskId, output, lenOrView(output))),
    // Zero-copy INPUT: the header is copied by Rust, the payload is read in
    // place — which is why the runtime must hold a reference to `data` for the
    // whole task (see `Deferred.keep` in src/task/runtime.ts).
    taskSubmitSlice: (op, hdr, data, taskId) =>
      Number(submitSlice(op, hdr, lenOrView(hdr), data, lenOrView(data), taskId)),
    taskDrain: (output) => Number(drain(output, lenOrView(output))),
    taskPending: () => Number(pending()),
    taskCancel: (taskId) => Number(cancel(taskId)),
    taskSetDoorbell: (ptr) => Number(setDoorbell(ptr)),
    taskShutdown: () => Number(shutdown()),
    taskThreads: () => Number(threads()),
  }
}

/**
 * Bind-time self-test for the task symbols. The pool is intentionally NOT
 * started here (no threads at import time) and no completion is produced;
 * the full submit→drain→doorbell path is exercised by `test/unit/task/`.
 */
export function selfTestTask(b: BunFFI): boolean {
  try {
    if (typeof b.taskPending() !== 'number') return false
    if (typeof b.taskThreads() !== 'number' || b.taskThreads() < 0) return false
    // `0` disables the doorbell — safe at bind time (nothing is in flight).
    if (b.taskSetDoorbell(0) !== 1) return false
    // An empty ring → 0; exercises the drain symbol without allocating anything.
    if (typeof b.taskDrain(new Uint8Array(4)) !== 'number') return false
    // NOT called: submitting here would start the pool threads at bind time.
    // The full submit/submit_out path is exercised by test/unit/task/.
    if (typeof b.taskSubmitOut !== 'function') return false
    if (typeof b.taskSubmitSlice !== 'function') return false
    return true
  } catch {
    return false
  }
}
