/**
 * Tests for the Rust multipart/form-data parser FFI, cross-checked against the
 * hand-rolled JS baseline.
 */

import { describe, test, expect } from "bun:test";
import { nativeMultipartParse } from "../../../src/baseline/tasks/multipart";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";
import { packBatch } from "../../../src/shared/packed";

const boundary = encoder.encode("TestBoundaryX");

function makeBody(): Uint8Array {
  return encoder.encode(
    "--TestBoundaryX\r\n" +
      'Content-Disposition: form-data; name="field1"\r\n\r\n' +
      "hello world\r\n" +
      "--TestBoundaryX\r\n" +
      'Content-Disposition: form-data; name="upload"; filename="a.txt"\r\n' +
      "Content-Type: text/plain\r\n\r\n" +
      "file contents here\r\n" +
      "--TestBoundaryX--\r\n",
  );
}

function toBytes(actual: unknown): number[] {
  return [...(actual as Uint8Array)];
}

describe("rust.multipartParse", () => {
  test("parses parts with names, filename, content-type", () => {
    const parts = rust.multipartParse(makeBody(), boundary);
    expect(parts).toHaveLength(2);

    expect(parts[0]?.name).toBe("field1");
    expect(parts[0]?.filename).toBeNull();
    expect(toBytes(parts[0]?.data)).toEqual([...encoder.encode("hello world")]);

    expect(parts[1]?.name).toBe("upload");
    expect(parts[1]?.filename).toBe("a.txt");
    expect(parts[1]?.contentType).toBe("text/plain");
    expect(toBytes(parts[1]?.data)).toEqual([
      ...encoder.encode("file contents here"),
    ]);
  });

  test("matches the JS baseline", () => {
    const native = nativeMultipartParse(makeBody(), boundary);
    const rustParts = rust.multipartParse(makeBody(), boundary);
    expect(rustParts.length).toBe(native.length);
    native.forEach((part, i) => {
      const r = rustParts[i];
      expect(r?.name).toBe(part.name);
      expect(r?.filename).toBe(part.filename);
      expect(r?.contentType).toBe(part.contentType);
      expect(toBytes(r?.data)).toEqual([...part.data]);
    });
  });

  test("returns empty for missing delimiter", () => {
    expect(rust.multipartParse(encoder.encode("no boundary here"), boundary)).toEqual([]);
  });

  test("handles binary data", () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
    const b = encoder.encode(
      "--TestBoundaryX\r\n" +
        'Content-Disposition: form-data; name="bin"\r\n\r\n',
    );
    const tail = encoder.encode("\r\n--TestBoundaryX--\r\n");
    const body = new Uint8Array(b.length + binary.length + tail.length);
    body.set(b, 0);
    body.set(binary, b.length);
    body.set(tail, b.length + binary.length);

    const parts = rust.multipartParse(body, boundary);
    expect(parts).toHaveLength(1);
    expect(toBytes(parts[0]?.data)).toEqual([...binary]);
  });
});

describe("rust.batch.multipartParse (packed)", () => {
  test("parses a packed batch", () => {
    const body = makeBody();
    const packed = packBatch([body, body]);
    const out = rust.packed.multipartParseBatchPacked(packed, boundary);
    // unpack [u32 count]{[u32 len][parts]} and sanity check first item decodes.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
  });
});

describe("rust.multipartParsePacked (zero-copy scalar)", () => {
  test("packed output matches the object path", () => {
    const packed = rust.multipartParsePacked(makeBody(), boundary);
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    const decoder = new TextDecoder();
    // [u32 count]{[u32 name_len][name][has_filename][u32 filename_len][filename][has_ct][u32 ct_len][ct][u32 data_len][data]}
    expect(view.getUint32(0, true)).toBe(2);

    const parts = rust.multipartParse(makeBody(), boundary);
    let pos = 4;
    for (const p of parts) {
      const nameLen = view.getUint32(pos, true);
      pos += 4;
      expect(decoder.decode(packed.subarray(pos, pos + nameLen))).toBe(p.name);
      pos += nameLen;

      const hasFile = packed[pos] as number;
      pos += 1;
      const fileLen = view.getUint32(pos, true);
      pos += 4;
      expect(
        hasFile ? decoder.decode(packed.subarray(pos, pos + fileLen)) : "",
      ).toBe(p.filename ?? "");
      pos += fileLen;

      const hasCt = packed[pos] as number;
      pos += 1;
      const ctLen = view.getUint32(pos, true);
      pos += 4;
      expect(
        hasCt ? decoder.decode(packed.subarray(pos, pos + ctLen)) : "",
      ).toBe(p.contentType ?? "");
      pos += ctLen;

      const dataLen = view.getUint32(pos, true);
      pos += 4;
      expect([...packed.subarray(pos, pos + dataLen)]).toEqual([...p.data]);
      pos += dataLen;
    }
  });
});
