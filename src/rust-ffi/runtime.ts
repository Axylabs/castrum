import { callOut, type FfiFunction } from "./call";
import { loadRustLibrary } from "./loader";
import { ptr } from "./pointer";

export interface FfiRuntime {
  ptr: typeof ptr;
  callOut: typeof callOut;
  symbols: Record<string, FfiFunction>;
}

export function createFfiRuntime(): FfiRuntime {
  const lib = loadRustLibrary();
  const symbols = lib.symbols as Record<string, FfiFunction>;

  return {
    ptr,
    callOut,
    symbols,
  };
}
