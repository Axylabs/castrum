// src/baseline/tasks/streaming.ts — JS baseline: SSE event framing.

import { decoder, encoder } from '../../shared/bytes'

// RFC 6455 §5.7 example mask key — used by BOTH the JS baseline and the Rust
// codec so encoded bytes are byte-identical (deterministic masking).
const MASK_KEY: [number, number, number, number] = [0x37, 0xfa, 0x21, 0x3d]

export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Uint8Array
}

/** JS baseline RFC 6455 frame encode (matches `rust.wsFrameEncode`). */
export function nativeWsFrameEncode(
  opcode: number,
  payload: Uint8Array,
  mask: boolean,
  fin: boolean,
): Uint8Array {
  const len = payload.length
  let headerLen = 2
  if (len > 125) headerLen += len > 65_535 ? 8 : 2
  if (mask) headerLen += 4

  const out = new Uint8Array(headerLen + len)
  let pos = 0
  out[pos++] = (fin ? 0x80 : 0) | (opcode & 0x0f)

  const maskBit = mask ? 0x80 : 0
  if (len <= 125) {
    out[pos++] = maskBit | len
  } else if (len <= 65_535) {
    out[pos++] = maskBit | 126
    out[pos++] = (len >>> 8) & 0xff
    out[pos++] = len & 0xff
  } else {
    out[pos++] = maskBit | 127
    const big = BigInt(len)
    for (let i = 7; i >= 0; i--) out[pos++] = Number((big >> BigInt(i * 8)) & 0xffn)
  }

  if (mask) {
    for (const b of MASK_KEY) out[pos++] = b
    for (let i = 0; i < len; i++) out[pos++] = (payload[i] ?? 0) ^ (MASK_KEY[i & 3] ?? 0)
  } else {
    out.set(payload, pos)
  }

  return out
}

/** JS baseline RFC 6455 frame decode (matches `rust.wsFrameDecode`). */
export function nativeWsFrameDecode(data: Uint8Array): WsFrame | null {
  if (data.length < 2) return null
  const buf = Buffer.from(data)

  const fin = ((buf[0] ?? 0) & 0x80) !== 0
  const opcode = (buf[0] ?? 0) & 0x0f
  const masked = ((buf[1] ?? 0) & 0x80) !== 0
  let len = (buf[1] ?? 0) & 0x7f
  let pos = 2

  if (len === 126) {
    if (buf.length < pos + 2) return null
    len = buf.readUInt16BE(pos)
    pos += 2
  } else if (len === 127) {
    if (buf.length < pos + 8) return null
    const big = buf.readBigUInt64BE(pos)
    len = big > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(big)
    pos += 8
  }

  const maskKey: [number, number, number, number] = [0, 0, 0, 0]
  if (masked) {
    if (buf.length < pos + 4) return null
    for (let i = 0; i < 4; i++) maskKey[i] = buf[pos + i] ?? 0
    pos += 4
  }

  const payloadBuf = buf.subarray(pos, pos + len)
  if (payloadBuf.length !== len) return null

  const payload = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    payload[i] = masked ? (payloadBuf[i] ?? 0) ^ (maskKey[i & 3] ?? 0) : (payloadBuf[i] ?? 0)
  }

  return { fin, opcode, payload }
}

/** JS baseline SSE event encode (matches `rust.sseEncodeEvent`). */
export function nativeSseEncodeEvent(
  event: string | null,
  data: Uint8Array,
  id: string | null,
  retry: number | null,
): Uint8Array {
  const lines: string[] = []
  if (id !== null) lines.push(`id: ${id}`)
  if (event !== null) lines.push(`event: ${event}`)
  if (retry !== null) lines.push(`retry: ${retry}`)

  const text = decoder.decode(data)
  for (const line of text.split('\n')) lines.push(`data: ${line}`)

  return encoder.encode(`${lines.join('\n')}\n\n`)
}
