// src/ingress/packing/input-packer.ts — Binary-packed ingress input builder.
//
// Packs the per-request inputs (method kind + url + ip + request id + packed
// headers) into a single growable Uint8Array in the layout the native
// `Ingress.handleRequestPacked` expects.

import { encoder } from '../../shared/bytes'

const EMPTY_BYTES = new Uint8Array(0)
const EMPTY_IP_BYTES = encoder.encode('0.0.0.0')

/** Growable packer for the fast-path packed input buffer. */
export class IngressInputPacker {
  private buf: Uint8Array
  private view: DataView
  private pos = 0

  constructor(initialSize = 65536) {
    this.buf = new Uint8Array(Math.max(1024, initialSize))
    this.view = new DataView(this.buf.buffer)
  }

  private ensure(additional: number): void {
    const needed = this.pos + additional
    if (needed <= this.buf.byteLength) return

    let nextSize = this.buf.byteLength * 2
    while (nextSize < needed) {
      nextSize *= 2
    }

    const next = new Uint8Array(nextSize)
    next.set(this.buf.subarray(0, this.pos))

    this.buf = next
    this.view = new DataView(next.buffer)
  }

  private writeU8(value: number): void {
    this.ensure(1)
    this.buf[this.pos++] = value & 0xff
  }

  private writeLenPrefixed(bytes: Uint8Array): void {
    this.ensure(4 + bytes.byteLength)

    this.view.setUint32(this.pos, bytes.byteLength, true)
    this.pos += 4

    this.buf.set(bytes, this.pos)
    this.pos += bytes.byteLength
  }

  /** Pack the request inputs; the returned view is valid until the next pack. */
  pack(
    methodKind: number,
    urlBytes: Uint8Array,
    ipBytes: Uint8Array,
    requestIdBytes: Uint8Array,
    headers: Uint8Array,
  ): Uint8Array {
    this.pos = 0

    this.writeU8(methodKind)
    this.writeLenPrefixed(urlBytes)
    this.writeLenPrefixed(ipBytes)
    this.writeLenPrefixed(requestIdBytes)
    this.writeLenPrefixed(headers)

    return this.buf.subarray(0, this.pos)
  }

  /** Encode `value` directly into the buffer, length-prefixed (zero-copy). */
  private writeStringLenPrefixed(value: string): void {
    // 3 bytes per UTF-16 code unit is a safe upper bound (BMP non-ASCII);
    // surrogate pairs encode to fewer bytes per code unit.
    this.ensure(4 + value.length * 3)
    const valueLenPos = this.pos
    this.pos += 4
    const dest = this.buf.subarray(this.pos)
    const { written } = encoder.encodeInto(value, dest)
    this.view.setUint32(valueLenPos, written, true)
    this.pos += written
  }

  /**
   * Pack the request inputs from raw strings, encoding url/ip/requestId
   * directly into the internal buffer via `encodeInto` — three fewer
   * intermediate `Uint8Array` allocations + copies per request vs [`pack`].
   * The returned view is valid until the next pack.
   */
  packFromStrings(
    methodKind: number,
    url: string,
    ip: string | undefined,
    requestId: string | undefined,
    headers: Uint8Array,
  ): Uint8Array {
    this.pos = 0

    this.writeU8(methodKind)
    this.writeStringLenPrefixed(url)
    if (ip && ip.length > 0) {
      this.writeStringLenPrefixed(ip)
    } else {
      this.writeLenPrefixed(EMPTY_IP_BYTES)
    }
    if (requestId) {
      this.writeStringLenPrefixed(requestId)
    } else {
      this.writeLenPrefixed(EMPTY_BYTES)
    }
    this.writeLenPrefixed(headers)

    return this.buf.subarray(0, this.pos)
  }

  /**
   * Pack the request inputs with a mixed strategy: `url`/`ip` are encoded
   * directly from strings via `encodeInto` (no intermediate `Uint8Array`),
   * while `requestId`/`headers` are already-encoded byte slices copied in
   * verbatim.
   *
   * This removes the two `encoder.encode` allocations + copies per request
   * that [`pack`] pays for URL/IP, while keeping the pre-encoded request-id
   * bytes untouched (no decode-to-string → re-encode round trip, which
   * `packFromStrings` would incur when a request id was already generated as
   * bytes). The returned view is valid until the next pack.
   */
  packParts(
    methodKind: number,
    url: string,
    ip: string | undefined,
    requestId: Uint8Array,
    headers: Uint8Array,
  ): Uint8Array {
    this.pos = 0

    this.writeU8(methodKind)
    this.writeStringLenPrefixed(url)
    if (ip && ip.length > 0) {
      this.writeStringLenPrefixed(ip)
    } else {
      this.writeLenPrefixed(EMPTY_IP_BYTES)
    }
    this.writeLenPrefixed(requestId)
    this.writeLenPrefixed(headers)

    return this.buf.subarray(0, this.pos)
  }
}
