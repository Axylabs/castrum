// src/shared/runtime.ts — runtime detection helpers.
//
// castrum is Bun-first but must also run under Node.js. This module is the
// single place that detects the host runtime, so the rest of the codebase can
// branch on `isBun()` / `isNode()` without sprinkling `typeof Bun` checks
// everywhere. Importing this module has zero side effects.

export type RuntimeName = "bun" | "node" | "unknown";

/** Whether the current runtime is Bun (the primary target). */
export function isBun(): boolean {
  // Bun defines the global `Bun` object; Node does not.
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Whether the current runtime is Node.js. */
export function isNode(): boolean {
  return !isBun() && typeof process !== "undefined" && process.versions?.node != null;
}

/** Best-effort name of the current runtime. */
export function runtimeName(): RuntimeName {
  if (isBun()) return "bun";
  if (isNode()) return "node";
  return "unknown";
}

/** The Node.js major version when running under Node, otherwise `null`. */
export function nodeMajorVersion(): number | null {
  if (!isNode()) return null;
  const v = process.versions.node;
  const major = Number(v?.split(".")[0]);
  return Number.isFinite(major) ? major : null;
}
