import { decoder } from "../shared/bytes";
import { sortKeys } from "../shared/json";

export function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export function assertEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label}`);
    console.error(`  actual:   ${String(actual)}`);
    console.error(`  expected: ${String(expected)}`);
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
