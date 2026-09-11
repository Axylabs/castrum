// src/task/index.ts — public barrel for the off-thread task runtime.

export {
  TASK_OP,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_ERROR,
  TASK_STATUS_OK,
  brotliCapacityGuess,
  encodeArgon2VerifyArgs,
  encodeBrotliDecompressArgs,
  encodeGzipCompressHeader,
  encodeGzipDecompressArgs,
  encodePbkdf2Args,
  gzipCompressUpperBound,
} from './op'
export type { TaskOpName } from './op'
export { createTaskRuntime } from './runtime'
export type {
  Pbkdf2RunOptions,
  TaskRunOptions,
  TaskRuntime,
  TaskRuntimeOptions,
  TaskStats,
} from './runtime'
