// src/shared/runtime.ts — runtime detection helpers (facade).
//
// Facade over the cached detection in `src/runtime/detect.ts` (the ONLY place
// `typeof Bun` is checked — resolved ONCE at module load by the runtime
// adapter). Kept so existing `isBun()` / `isNode()` / `runtimeName()` /
// `nodeMajorVersion()` call sites work unchanged.

import {
  detectedRuntime,
  isBunRuntime,
  isNodeRuntime,
  nodeMajorVersion as nodeMajorVersionDetected,
} from '../runtime/detect'
import type { RuntimeName as RuntimeNameType } from '../runtime/types'

/** Host runtime identifier. */
export type RuntimeName = RuntimeNameType

/** Whether the current runtime is Bun (the primary target). Cached once at load. */
export const isBun: () => boolean = isBunRuntime

/** Whether the current runtime is Node.js. */
export const isNode: () => boolean = isNodeRuntime

/** Best-effort name of the current runtime. */
export const runtimeName: () => RuntimeName = () => detectedRuntime

/** The Node.js major version when running under Node, otherwise `null`. */
export const nodeMajorVersion: () => number | null = nodeMajorVersionDetected
