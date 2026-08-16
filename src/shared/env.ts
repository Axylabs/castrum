// src/shared/env.ts — Centralized environment-variable resolution.
//
// Runtime env vars use the `CASTRUM_*` prefix (plus the napi-rs standard
// `NAPI_RS_NATIVE_LIBRARY_PATH`). All reads MUST go through `resolveEnvVar` so
// they can never drift apart (they previously lived inline at several call
// sites with different shapes).

/** First set value among `preferred` and its legacy aliases, or `undefined`. */
export function resolveEnvVar(
  preferred: string,
  legacy: readonly string[] = [],
): string | undefined {
  const direct = process.env[preferred]
  if (direct !== undefined) return direct
  for (const alias of legacy) {
    const aliasValue = process.env[alias]
    if (aliasValue !== undefined) return aliasValue
  }
  return undefined
}
