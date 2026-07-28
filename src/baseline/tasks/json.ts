// ── REMOVE: ──
// import { decoder } from "../../shared/bytes";

// ── In nativeJsonValid, replace: ──
// JSON.parse(decoder.decode(bytes));

// ── WITH: ──
// ★ Bun's JSON.parse accepts Uint8Array directly (Bun 1.1+)
export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(bytes as any); // Bun accepts Uint8Array
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const parsed = JSON.parse(bytes as any); // ★ No TextDecoder needed
  if (!Array.isArray(parsed)) return 0n;
  let sum = 0n;
  for (const row of parsed as Array<{ id?: unknown }>) {
    if (typeof row.id === "number" && Number.isFinite(row.id)) {
      sum += BigInt(Math.trunc(row.id));
    }
  }
  return sum;
}