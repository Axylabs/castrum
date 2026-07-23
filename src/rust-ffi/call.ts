import { ptr } from "./pointer";

export type FfiFunction = (...args: any[]) => bigint | number;

const MAX_OUTPUT_SIZE = 256 * 1024 * 1024;

export function callOut(
  fn: FfiFunction,
  outSize: number,
  ...args: any[]
): Uint8Array {
  let size = Math.max(1, outSize);

  for (;;) {
    const out = new Uint8Array(size);
    const written = fn(...args, ptr(out), out.byteLength);
    const w = typeof written === "bigint" ? written : BigInt(written);

    if (w === -2n) {
      if (size >= MAX_OUTPUT_SIZE) {
        throw new Error(
          `FFI call failed: output buffer too large (>${size} bytes)`,
        );
      }

      size = Math.min(size * 2, MAX_OUTPUT_SIZE);
      continue;
    }

    if (w < 0n) {
      throw new Error(`FFI call failed: ${written}`);
    }

return out.subarray(0, Number(w));
  }
}
