export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
