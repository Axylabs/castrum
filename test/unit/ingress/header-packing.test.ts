/**
 * Tests for src/ingress/packing/header-packing.ts
 *
 * Regression coverage for the >8KB header corruption bug: writeHeaderPair grew
 * the buffer/view LOCALLY on overflow and never returned it, so any request
 * whose packed headers exceeded HEADER_BUF_SIZE (8192 bytes) silently lost the
 * overflow bytes.
 */

import { describe, test, expect } from "bun:test";
import { packHeaders } from "../../../src/ingress/packing/header-packing";
import type { HeaderPlan } from "../../../src/ingress/shared";

const FULL_PLAN: HeaderPlan = {
  cookie: true,
  cors: true,
  proxy: true,
  proto: true,
};

/** Decode the packed header format: [u16 count][u16 nameLen][name][u32 valLen][value]... */
function decodePacked(packed: Uint8Array): Array<[name: string, value: string]> {
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = dv.getUint16(0, true);
  let pos = 2;
  const pairs: Array<[string, string]> = [];

  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(pos, true);
    pos += 2;
    const name = new TextDecoder().decode(packed.subarray(pos, pos + nameLen));
    pos += nameLen;

    const valLen = dv.getUint32(pos, true);
    pos += 4;
    const value = new TextDecoder().decode(packed.subarray(pos, pos + valLen));
    pos += valLen;

    pairs.push([name, value]);
  }

  return pairs;
}

describe("packHeaders", () => {
  test("packs small headers into the fixed 8192-byte buffer", () => {
    const req = new Request("http://example.com/", {
      headers: {
        cookie: "session=abc123",
        origin: "https://app.example.com",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "5.6.7.8",
        "x-forwarded-proto": "https",
      },
    });

    const packed = packHeaders(req, FULL_PLAN);
    const pairs = decodePacked(packed);

    expect(pairs).toEqual([
      ["cookie", "session=abc123"],
      ["origin", "https://app.example.com"],
      ["x-forwarded-for", "1.2.3.4"],
      ["x-real-ip", "5.6.7.8"],
      ["x-forwarded-proto", "https"],
    ]);
  });

  test("preserves a header block larger than HEADER_BUF_SIZE (8192 bytes)", () => {
    // A cookie larger than the fixed buffer forces writeHeaderPair to grow the
    // buffer. The packed output must contain the FULL value, uncorrupted.
    const bigCookie = "big=" + "a".repeat(9000);
    const origin = "https://app.example.com";

    const req = new Request("http://example.com/", {
      headers: {
        cookie: bigCookie,
        origin,
      },
    });

    const packed = packHeaders(req, FULL_PLAN);
    expect(packed.length).toBeGreaterThan(8192);

    const pairs = decodePacked(packed);
    expect(pairs).toEqual([
      ["cookie", bigCookie],
      ["origin", origin],
    ]);
  });

  test("preserves multiple large headers that overflow together", () => {
    const bigOrigin = "https://app.example.com/" + "b".repeat(6000);
    const bigCookie = "session=" + "c".repeat(4000);

    const req = new Request("http://example.com/", {
      headers: {
        cookie: bigCookie,
        origin: bigOrigin,
        "x-forwarded-for": "9.9.9.9",
      },
    });

    const packed = packHeaders(req, FULL_PLAN);
    expect(packed.length).toBeGreaterThan(8192);

    const pairs = decodePacked(packed);
    expect(pairs).toEqual([
      ["cookie", bigCookie],
      ["origin", bigOrigin],
      ["x-forwarded-for", "9.9.9.9"],
    ]);
  });

  test("reuses the thread-local buffer without cross-request contamination", () => {
    // Two sequential packs: a small request followed by a large one must not
    // leak the large request's bytes into the small request's output.
    const small = new Request("http://example.com/", {
      headers: { cookie: "a=1" },
    });
    const large = new Request("http://example.com/", {
      headers: { cookie: "big=" + "x".repeat(10_000) },
    });

    const smallPacked = packHeaders(small, FULL_PLAN);
    const smallPairs = decodePacked(smallPacked);
    expect(smallPairs).toEqual([["cookie", "a=1"]]);

    const largePacked = packHeaders(large, FULL_PLAN);
    const largePairs = decodePacked(largePacked);
    expect(largePairs).toEqual([["cookie", "big=" + "x".repeat(10_000)]]);
  });
});
