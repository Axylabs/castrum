/**
 * Tests for the Rust WebSocket frame codec + SSE framing FFI, cross-checked for
 * byte parity against the JS baselines.
 */

import { describe, test, expect } from "bun:test";
import {
  nativeSseEncodeEvent,
  nativeWsFrameEncode,
} from "../../../src/baseline/tasks/streaming";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";

function toBytes(actual: unknown): number[] {
  return [...(actual as Uint8Array)];
}

describe("ws frames", () => {
  test("encode matches baseline byte-for-byte (masked)", () => {
    const payload = encoder.encode("Hello WebSocket!");
    const native = nativeWsFrameEncode(0x1, payload, true, true);
    const rustFrame = rust.wsFrameEncode(0x1, payload, true, true);
    expect(toBytes(rustFrame)).toEqual(toBytes(native));
  });

  test("encode matches baseline byte-for-byte (unmasked, medium length)", () => {
    const payload = encoder.encode("x".repeat(300));
    const native = nativeWsFrameEncode(0x2, payload, false, true);
    const rustFrame = rust.wsFrameEncode(0x2, payload, false, true);
    expect(toBytes(rustFrame)).toEqual(toBytes(native));
  });

  test("decode roundtrip", () => {
    const payload = encoder.encode("ping payload");
    const frame = rust.wsFrameEncode(0x9, payload, true, false);
    const decoded = rust.wsFrameDecode(frame);
    expect(decoded?.opcode).toBe(9);
    expect(decoded?.fin).toBe(false);
    expect(toBytes(decoded?.payload)).toEqual([...payload]);
  });

  test("decode returns null for truncated input", () => {
    expect(rust.wsFrameDecode(encoder.encode(""))).toBeNull();
    expect(rust.wsFrameDecode(encoder.encode("\x81"))).toBeNull();
    const frame = rust.wsFrameEncode(0x1, encoder.encode("hello"), false, true);
    expect(rust.wsFrameDecode(frame.subarray(0, frame.length - 1))).toBeNull();
  });
});

describe("sse", () => {
  test("encode matches baseline byte-for-byte", () => {
    const data = encoder.encode("line1\nline2");
    const native = nativeSseEncodeEvent("update", data, "42", 3000);
    const rustEvent = rust.sseEncodeEvent("update", data, "42", 3000);
    expect(toBytes(rustEvent)).toEqual(toBytes(native));
  });

  test("basic event framing", () => {
    const rustEvent = rust.sseEncodeEvent(null, encoder.encode("hello"), null, null);
    expect(toBytes(rustEvent)).toEqual([...encoder.encode("data: hello\n\n")]);
  });
});
