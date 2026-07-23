import type { FfiRuntime } from "../runtime";

export function createJsonPatchApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_json_patch_v2,
        Math.max(1024, doc.byteLength + patch.byteLength + 1024),
        ptr(doc),
        doc.byteLength,
        ptr(patch),
        patch.byteLength,
      );
    },
  };
}

export type JsonPatchApi = ReturnType<typeof createJsonPatchApi>;
