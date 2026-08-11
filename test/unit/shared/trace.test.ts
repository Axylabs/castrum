/**
 * Tests for W3C trace-context helpers (src/shared/trace.ts).
 */

import { describe, test, expect } from "bun:test";
import {
  parseTraceParent,
  createTraceId,
  createSpanId,
  serializeTraceParent,
} from "../../../src/shared/trace";

const VALID =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceParent", () => {
  test("parses a valid header", () => {
    const t = parseTraceParent(VALID);
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.version).toBe("00");
    expect(t.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(t.spanId).toBe("00f067aa0ba902b7");
    expect(t.sampled).toBe(true);
  });

  test("sampled flag is false when bit 0 is clear", () => {
    const t = parseTraceParent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    );
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.sampled).toBe(false);
  });

  test("rejects malformed input", () => {
    expect(parseTraceParent(null)).toBeNull();
    expect(parseTraceParent("")).toBeNull();
    expect(parseTraceParent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull(); // version != 00
    expect(parseTraceParent("00-1234-00f067aa0ba902b7-01")).toBeNull(); // short trace id
    expect(parseTraceParent("00-zz92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull(); // non-hex
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7")).toBeNull(); // missing flags
  });

  test("round-trips through serializeTraceParent", () => {
    const t = parseTraceParent(VALID);
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(serializeTraceParent(t)).toBe(VALID);
  });
});

describe("trace id / span id generation", () => {
  test("createTraceId returns 32 hex chars", () => {
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("createSpanId returns 16 hex chars", () => {
    expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("ids are unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(createSpanId());
    expect(ids.size).toBe(100);
  });
});
