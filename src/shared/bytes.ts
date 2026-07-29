/**
 * Shared TextEncoder instance for encoding strings to UTF-8 bytes.
 *
 * Reusing a single encoder avoids allocation overhead in hot paths.
 */
export const encoder = new TextEncoder();

/**
 * Shared TextDecoder instance for decoding UTF-8 bytes to strings.
 *
 * Reusing a single decoder avoids allocation overhead in hot paths.
 */
export const decoder = new TextDecoder();

/**
 * Creates an independent copy of a Uint8Array.
 *
 * This ensures the returned buffer has its own backing store, decoupled
 * from the original. Useful when the original buffer is a view (subarray)
 * that may be reused or mutated.
 *
 * @param bytes - The source buffer to copy
 * @returns A new Uint8Array with an independent backing store
 *
 * @example
 * ```ts
 * const original = new Uint8Array([1, 2, 3]);
 * const copy = toPlainBuffer(original);
 * copy[0] = 99; // does not affect original
 * ```
 */
export function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
