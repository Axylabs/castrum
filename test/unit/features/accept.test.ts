/**
 * Tests for the Rust Accept-Encoding FFI: `rust.parseAcceptEncoding` and
 * `rust.createAcceptNegotiator` (higher-order instance) — cross-checked against
 * the hand-rolled JS negotiation baseline.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";
import {
  nativeNegotiateEncoding,
  nativeParseAcceptEncoding,
} from "../../../src/bench/accept-baseline";

const SUPPORTED = ["gzip", "br", "identity"];

const HEADERS = [
  "gzip;q=0.8, deflate, br;q=1.0, *;q=0.1",
  "br",
  "gzip;q=0, *;q=1",
  "gzip;q=0.5, *;q=1",
  "br;q=0.1, *;q=0.9",
  "",
  "*;q=0, br;q=0.5",
];

describe("rust.parseAcceptEncoding", () => {
  test("matches the JS parse for encoding/q/order", () => {
    for (const header of HEADERS) {
      const rustPrefs = rust.parseAcceptEncoding(encoder.encode(header));
      const nativePrefs = nativeParseAcceptEncoding(header);
      expect(rustPrefs.length).toBe(nativePrefs.length);
      for (let i = 0; i < nativePrefs.length; i++) {
        expect(rustPrefs[i]?.encoding).toBe(nativePrefs[i]?.encoding);
        expect(Math.abs((rustPrefs[i]?.q ?? 0) - (nativePrefs[i]?.q ?? 0))).toBeLessThan(1e-4);
        expect(rustPrefs[i]?.order).toBe(nativePrefs[i]?.order);
      }
    }
  });
});

describe("AcceptNegotiator (higher-order instance)", () => {
  const negotiator = rust.createAcceptNegotiator(SUPPORTED);

  test("matches the JS negotiation baseline", () => {
    for (const header of HEADERS) {
      expect(negotiator.negotiate(encoder.encode(header))).toBe(
        nativeNegotiateEncoding(SUPPORTED, header),
      );
    }
  });

  test("returns null for identity when nothing acceptable", () => {
    expect(negotiator.negotiate(encoder.encode("gzip;q=0, *;q=0"))).toBeNull();
  });

  test("prefers explicit over wildcard", () => {
    // explicit gzip q=0.5 beats wildcard q=1 (most-specific reference wins).
    expect(negotiator.negotiate(encoder.encode("gzip;q=0.5, *;q=1"))).toBe(
      "gzip",
    );
  });
});
