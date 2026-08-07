// src/ingress/packing/input-packer.ts — Binary-packed ingress input builder.
//
// Packs the per-request inputs (method kind + url + ip + request id + packed
// headers) into a single growable Uint8Array in the layout the native
// `Ingress.handleRequestPacked` expects.

/** Growable packer for the fast-path packed input buffer. */
export class IngressInputPacker {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 65536) {
    this.buf = new Uint8Array(Math.max(1024, initialSize));
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(additional: number): void {
    const needed = this.pos + additional;
    if (needed <= this.buf.byteLength) return;

    let nextSize = this.buf.byteLength * 2;
    while (nextSize < needed) {
      nextSize *= 2;
    }

    const next = new Uint8Array(nextSize);
    next.set(this.buf.subarray(0, this.pos));

    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  private writeU8(value: number): void {
    this.ensure(1);
    this.buf[this.pos++] = value & 0xff;
  }

  private writeLenPrefixed(bytes: Uint8Array): void {
    this.ensure(4 + bytes.byteLength);

    this.view.setUint32(this.pos, bytes.byteLength, true);
    this.pos += 4;

    this.buf.set(bytes, this.pos);
    this.pos += bytes.byteLength;
  }

  /** Pack the request inputs; the returned view is valid until the next pack. */
  pack(
    methodKind: number,
    urlBytes: Uint8Array,
    ipBytes: Uint8Array,
    requestIdBytes: Uint8Array,
    headers: Uint8Array,
  ): Uint8Array {
    this.pos = 0;

    this.writeU8(methodKind);
    this.writeLenPrefixed(urlBytes);
    this.writeLenPrefixed(ipBytes);
    this.writeLenPrefixed(requestIdBytes);
    this.writeLenPrefixed(headers);

    return this.buf.subarray(0, this.pos);
  }
}
