// src/rust-ffi/scalar/json.ts — JSON scalar methods.
//
// Mirrors rust/json/*: validate, DOM parse, id-sum and RFC 6902 patch.

import { asBigInt } from "../options";
import type { RustClientContext } from "../context";

/** JSON scalar methods (`Pick<RustScalar, ...>`). */
export function buildJson(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    jsonValid(input: Uint8Array): boolean {
      return addon.jsonValid(input);
    },
    jsonParse(input: Uint8Array): unknown {
      return addon.jsonParse(input);
    },
    jsonSumIds(input: Uint8Array): bigint {
      return asBigInt(addon.jsonSumIds(input) as unknown);
    },
    jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
      return addon.jsonPatch(doc, patch);
    },
  };
}
