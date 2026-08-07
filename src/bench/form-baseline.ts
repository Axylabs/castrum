// src/bench/form-baseline.ts — JS baseline for x-www-form-urlencoded parsing.
//
// Reuses the URLSearchParams-based query baseline (the packed wire format is
// identical). Bench-local only — NOT part of the public `native` barrel.

import { nativeQueryParsePacked } from "../baseline/tasks/query";

/** Parse a form body with URLSearchParams and return packed pairs. */
export function nativeFormParsePacked(body: Uint8Array): Uint8Array {
  return nativeQueryParsePacked(body);
}

/** Total packed output bytes across N form bodies (baseline for batch). */
export function nativeFormParseBatchLen(bodies: Uint8Array[]): number {
  let total = 0;
  for (const body of bodies) {
    total += nativeFormParsePacked(body).byteLength;
  }
  return total;
}
