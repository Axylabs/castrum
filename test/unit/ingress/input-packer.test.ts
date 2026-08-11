/**
 * Tests for `IngressInputPacker` — the binary packed-input frame builder
 * (src/ingress/packing/input-packer.ts). Verifies the exact wire layout the
 * native `Ingress.handleRequestPacked` expects, buffer growth, and the
 * no-alloc `packFromStrings` path.
 */

import { describe, test, expect } from "bun:test";
import { IngressInputPacker } from "../../../src/ingress/packing/input-packer";
import { decoder, encoder } from "../../../src/shared/bytes";

const EMPTY = new Uint8Array(0);

function readSections(out: Uint8Array): {
  methodKind: number;
  sections: Uint8Array[];
} {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const methodKind = out[0];
  let pos = 1;
  const sections: Uint8Array[] = [];
  while (pos < out.byteLength) {
    const len = dv.getUint32(pos, true);
    pos += 4;
    sections.push(out.subarray(pos, pos + len));
    pos += len;
  }
  return { methodKind, sections };
}

describe("IngressInputPacker", () => {
  test("pack writes the fixed frame layout", () => {
    const packer = new IngressInputPacker();
    const url = encoder.encode("/api/users");
    const ip = encoder.encode("192.168.1.1");
    const rid = encoder.encode("rid-123");
    const headers = new Uint8Array([0, 0]); // empty header-pair block

    const out = packer.pack(2, url, ip, rid, headers); // method 2 = POST
    const { methodKind, sections } = readSections(out);

    expect(methodKind).toBe(2);
    expect(sections.length).toBe(4);
    expect(decoder.decode(sections[0])).toBe("/api/users");
    expect(decoder.decode(sections[1])).toBe("192.168.1.1");
    expect(decoder.decode(sections[2])).toBe("rid-123");
    expect(Array.from(sections[3])).toEqual([0, 0]);
  });

  test("packFromStrings encodes the same layout from strings", () => {
    const packer = new IngressInputPacker();
    const out = packer.packFromStrings(0, "/health", "10.0.0.1", "r1", EMPTY);

    const { methodKind, sections } = readSections(out);
    expect(methodKind).toBe(0);
    expect(sections.length).toBe(4);
    expect(decoder.decode(sections[0])).toBe("/health");
    expect(decoder.decode(sections[1])).toBe("10.0.0.1");
    expect(decoder.decode(sections[2])).toBe("r1");
  });

  test("packFromStrings falls back to EMPTY_IP / empty rid when absent", () => {
    const packer = new IngressInputPacker();
    const out = packer.packFromStrings(0, "/x", undefined, undefined, EMPTY);
    const { sections } = readSections(out);
    // ip falls back to "0.0.0.0", rid to an empty section.
    expect(decoder.decode(sections[1])).toBe("0.0.0.0");
    expect(sections[2].byteLength).toBe(0);
  });

  test("grows the buffer for inputs larger than the initial capacity", () => {
    const packer = new IngressInputPacker(64); // tiny initial buffer
    const big = new Uint8Array(5000).fill(97); // 'a'
    const out = packer.pack(0, big, big, big, big);

    const { sections } = readSections(out);
    expect(sections.length).toBe(4);
    for (const s of sections) {
      expect(s.byteLength).toBe(5000);
    }
    expect(out.byteLength).toBe(1 + 4 * 4 + 4 * 5000);
  });

  test("reuses the same backing ArrayBuffer across packs", () => {
    const packer = new IngressInputPacker();
    const a = packer.pack(0, encoder.encode("/a"), EMPTY, EMPTY, EMPTY);
    const b = packer.pack(0, encoder.encode("/b"), EMPTY, EMPTY, EMPTY);
    // Zero-alloc reuse: the packer must not allocate a fresh buffer each pack.
    expect(a.buffer).toBe(b.buffer);
  });
});
