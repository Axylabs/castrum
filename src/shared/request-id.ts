// src/shared/request-id.ts — fast counter-based request ID generator.
//
// Used by both the fast and pre-baked ingress paths. Produces a 16-byte hex
// string (as bytes) from a per-process counter seeded with boot randomness and
// an optional worker ID — no crypto, no allocation per call (reuses buffers).
//
// SIDE-EFFECT NOTE (deliberate, kept for zero-alloc hot-path perf): the module
// holds mutable shared state — a counter and reusable BINARY/HEX scratch
// buffers. `generateRequestId()` returns a SINGLE shared HEX buffer that is
// overwritten on the next call. Callers must decode or copy the returned bytes
// before the next call; the alias is confined to this module so the hazard is
// local and documented here.

const HEX_LOOKUP = new Uint8Array(256 * 2);
for (let i = 0; i < 256; i++) {
  HEX_LOOKUP[i * 2] = "0123456789abcdef".charCodeAt(i >> 4);
  HEX_LOOKUP[i * 2 + 1] = "0123456789abcdef".charCodeAt(i & 0x0f);
}

const BINARY = new Uint8Array(8);
const HEX = new Uint8Array(16);

const WORKER_ID = Number(process.env.INGRESS_WORKER_ID || 0) & 0xffff;
const BOOT_RANDOM = (typeof crypto !== "undefined"
  ? (crypto as any).getRandomValues?.(new Uint32Array(1))?.[0] ??
    ((Math.random() * 0xffffffff) >>> 0)
  : (Math.random() * 0xffffffff) >>> 0) as number;

const COUNTER = {
  hi: (BOOT_RANDOM ^ (WORKER_ID << 16)) >>> 0,
  lo: 0,
};

/**
 * Generate the next request ID as 16 lowercase hex bytes (zero-alloc).
 *
 * @returns A shared buffer aliased across calls — decode/copy before the next
 *   `generateRequestId()` invocation.
 */
export function generateRequestId(): Uint8Array {
  if (COUNTER.lo === 0xffffffff) {
    COUNTER.lo = 0;
    COUNTER.hi = (COUNTER.hi + 1) >>> 0;
  } else {
    COUNTER.lo++;
  }

  BINARY[0] = (COUNTER.hi >>> 24) & 0xff;
  BINARY[1] = (COUNTER.hi >>> 16) & 0xff;
  BINARY[2] = (COUNTER.hi >>> 8) & 0xff;
  BINARY[3] = COUNTER.hi & 0xff;
  BINARY[4] = (COUNTER.lo >>> 24) & 0xff;
  BINARY[5] = (COUNTER.lo >>> 16) & 0xff;
  BINARY[6] = (COUNTER.lo >>> 8) & 0xff;
  BINARY[7] = COUNTER.lo & 0xff;

  for (let i = 0; i < 8; i++) {
    const b = BINARY[i] ?? 0;
    HEX[i * 2] = HEX_LOOKUP[b * 2] ?? 0;
    HEX[i * 2 + 1] = HEX_LOOKUP[b * 2 + 1] ?? 0;
  }

  return HEX;
}
