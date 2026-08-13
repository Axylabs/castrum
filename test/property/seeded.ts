/**
 * Deterministic seeded PRNG for property tests (test/property/**).
 *
 * Property loops must be REPRODUCIBLE: a failing case has to be replayable
 * instead of depending on a fresh `Math.random()` stream. `mulberry32` is a
 * tiny, fast, well-known 32-bit PRNG. Bump the seed to explore a new
 * pseudo-random input space; the fixed default keeps CI runs stable.
 */

/** Create a `Math.random`-compatible deterministic generator from `seed`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Default fixed seed shared by the property suites (bump to explore new cases). */
export const PROPERTY_SEED = 0xc05ffee

/** Build a fresh deterministic generator at the shared default seed. */
export function seededRandom(): () => number {
  return mulberry32(PROPERTY_SEED)
}
