// src/integration/batch.ts — Loader-backed bulk processing helpers.
//
// The higher-order loader (`castrum.loader`, src/loader) is built for BULK /
// coalesced work: many same-tick items dispatch as ONE packed native batch
// call instead of N native crossings, and expensive same-tick `load()`s
// coalesce into one packed flush. These helpers surface that machinery through
// the integration layer so the loader is actually USED at runtime — not just
// exported and benchmarked — for the workloads it genuinely serves.
//
// Honest guidance: for ONE item per request the loader's dispatch adds a small
// constant tax (~1.04–1.29x of a direct scalar call). Batching pays off when
// you process many items together (validating/hashing a list, batch schema
// checks) — exactly the pattern these helpers exist for.

import {
  loader,
  type LoaderBulk,
  type LoaderBulkArgs,
  type LoaderOpArgs,
  type LoaderOpName,
  type LoaderScalar,
} from "../loader";
import type { SchemaValidator } from "../shared/packed";

/**
 * Batch-validate JSON documents against a schema through the loader's bulk
 * `schemaValidate` path. Returns a bitset — byte `i` is 1 when document `i`
 * is valid (same shape as `rust.batch.schemaValidate`).
 */
export function validateMany(
  validator: SchemaValidator,
  docs: Uint8Array[],
): Uint8Array {
  return loader.schema(validator)(docs);
}

/** Count how many of `docs` validate against `validator` (one packed call). */
export function validateCount(
  validator: SchemaValidator,
  docs: Uint8Array[],
): number {
  return loader.schema(validator).count(docs);
}

/**
 * Generic loader bulk dispatch: `loader.run(op, items, ...rest)` → one packed
 * batch native call (or the adaptive scalar loop for tiny batches).
 */
export function runMany<K extends LoaderOpName>(
  op: K,
  items: Uint8Array[],
  ...rest: LoaderBulkArgs<K>
): LoaderBulk<K> {
  return loader.run(op, items, ...rest);
}

/** Single-item loader dispatch — pairs with `runMany` for mixed workloads. */
export function runOne<K extends LoaderOpName>(
  op: K,
  item: Uint8Array,
  ...rest: LoaderOpArgs[K]
): LoaderScalar<K> {
  return loader.run(op, item, ...rest);
}
