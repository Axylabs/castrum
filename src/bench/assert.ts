import { decoder } from "../shared/bytes";
import { sortKeys } from "../shared/json";

export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}

/**
 * Some Bun/NAPI builds return Rust i64/u64 as number when the value fits
 * inside Number.MAX_SAFE_INTEGER, while baseline code returns bigint.
 *
 * For benchmark correctness checks, integer number and bigint should be
 * treated as equal when their numeric value is the same.
 */
function normalizeScalar(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(Math.trunc(value));
  }

  return value;
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const a = normalizeScalar(actual);
  const b = normalizeScalar(expected);

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(
      `  actual:   ${String(actual)} (${typeName(actual)})`,
    );
    console.error(
      `  expected: ${String(expected)} (${typeName(expected)})`,
    );
    process.exit(1);
    throw new Error(`Assertion failed: ${label}`);
  }
}

export function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const a = JSON.stringify(sortKeys(actual));
  const b = JSON.stringify(sortKeys(expected));

  if (a !== b) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${a}`);
    console.error(`  expected: ${b}`);
    process.exit(1);
    throw new Error(`Assertion failed: ${label}`);
  }
}