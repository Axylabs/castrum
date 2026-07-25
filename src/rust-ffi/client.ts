import { createRawRustClient } from "./raw";

/**
 * Optimized public client.
 *
 * This now uses the optimized Rust implementations directly.
 *
 * If you want a hybrid "fastest wins" client, re-run:
 *
 *   bun bench.ts
 *
 * Then override only the functions where native still wins for your
 * production payload sizes.
 */
export function createRustClient() {
  return createRawRustClient();
}

export type RustClient = ReturnType<typeof createRustClient>;
export const rust = createRustClient();