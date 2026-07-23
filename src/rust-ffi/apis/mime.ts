import type { FfiRuntime } from "../runtime";

export function createMimeApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    mimeFromExtension(ext: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_mime_from_extension_v2,
        256,
        ptr(ext),
        ext.byteLength,
      );
    },
  };
}

export type MimeApi = ReturnType<typeof createMimeApi>;
