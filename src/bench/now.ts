export function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000
}
