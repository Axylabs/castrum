export function checksumValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }

  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }

  if (typeof value === "string") {
    return BigInt(value.length);
  }

  if (value instanceof Uint8Array) {
    return BigInt(value.byteLength) + BigInt(value[0] ?? 0);
  }

  if (value != null) {
    return 1n;
  }

  return 0n;
}
