import * as ffi from "bun:ffi";

const ffiPtr = (ffi as any).ptr as
  | undefined
  | ((view: any, byteOffset?: number) => number);

export function ptr(view: ArrayBufferView): any {
  if (typeof ffiPtr === "function") {
    return ffiPtr(view);
  }

  const legacyPtr = (view as any).ptr;
  if (typeof legacyPtr === "number") {
    return legacyPtr;
  }

  return view;
}
