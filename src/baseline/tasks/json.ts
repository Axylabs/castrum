import { decoder } from "../../shared/bytes";

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const parsed = JSON.parse(decoder.decode(bytes));

  if (!Array.isArray(parsed)) {
    return 0n;
  }

  let sum = 0n;

  for (const row of parsed as Array<{ id?: unknown }>) {
    if (typeof row.id === "number" && Number.isFinite(row.id)) {
      sum += BigInt(Math.trunc(row.id));
    }
  }

  return sum;
}
