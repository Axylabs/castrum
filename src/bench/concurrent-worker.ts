import * as native from '../baseline'
import { rust } from '../rust-ffi'
// Public `rustBatch` alias removed in 0.8.0 — bench-local shorthand.
const rustBatch = rust.batch
import { checksumValue } from './checksum'

type HmacPayload = {
  key: Uint8Array
  data: Uint8Array
}

let currentOp = ''
let currentPayload: unknown

function runOnce(op: string, payload: unknown): unknown {
  switch (op) {
    case 'native:json_valid':
      return native.nativeJsonValid(payload as Uint8Array) ? 1 : 0
    case 'rust:json_valid':
      return rust.jsonValid(payload as Uint8Array)

    case 'native:http_parse':
      return native.nativeHttpParseRequestPacked(payload as Uint8Array).byteLength
    case 'rust:http_parse':
      return rust.httpParseRequestPacked(payload as Uint8Array).byteLength

    case 'native:hmac_sha256': {
      const p = payload as HmacPayload
      return native.nativeHmacSha256(p.key, p.data).byteLength
    }
    case 'rust:hmac_sha256': {
      const p = payload as HmacPayload
      return rust.hmacSha256(p.key, p.data).byteLength
    }

    case 'native:validate_email':
      return native.nativeValidateEmail(payload as Uint8Array) ? 1 : 0
    case 'rust:validate_email':
      return rust.validateEmail(payload as Uint8Array)

    case 'native:validate_uuid':
      return native.nativeValidateUuid(payload as Uint8Array) ? 1 : 0
    case 'rust:validate_uuid':
      return rust.validateUuid(payload as Uint8Array)

    case 'native:validate_ipv4':
      return native.nativeValidateIpv4(payload as Uint8Array) ? 1 : 0
    case 'rust:validate_ipv4':
      return rust.validateIpv4(payload as Uint8Array)

    case 'native:validate_ipv6':
      return native.nativeValidateIpv6(payload as Uint8Array) ? 1 : 0
    case 'rust:validate_ipv6':
      return rust.validateIpv6(payload as Uint8Array)

    case 'native:query_parse':
      return native.nativeQueryParsePacked(payload as Uint8Array).byteLength
    case 'rust:query_parse':
      return rust.queryParsePacked(payload as Uint8Array).byteLength

    case 'native:cookie_parse':
      return native.nativeCookieParsePacked(payload as Uint8Array).byteLength
    case 'rust:cookie_parse':
      return rust.cookieParsePacked(payload as Uint8Array).byteLength

    case 'native:crc32':
      return native.nativeCrc32(payload as Uint8Array)
    case 'rust:crc32':
      return rust.crc32(payload as Uint8Array)

    case 'native:json_sum':
      return native.nativeJsonSum(payload as Uint8Array)
    case 'rust:json_sum':
      return rust.jsonSumIds(payload as Uint8Array)

    case 'native:json_valid_batch': {
      const items = payload as Uint8Array[]
      let count = 0
      for (const item of items) {
        if (native.nativeJsonValid(item)) count += 1
      }
      return count
    }

    case 'rust:json_valid_batch_packed': {
      const items = payload as Uint8Array[]
      const bits = rustBatch.jsonValid(items)
      let count = 0
      for (const bit of bits) count += bit
      return count
    }

    default:
      throw new Error(`Unknown concurrent op: ${op}`)
  }
}

/** Message the main thread sends to this worker. */
interface WorkerMessage {
  type?: string
  op?: string
  payload?: unknown
  warmup?: unknown
  iterations?: unknown
}

/**
 * Minimal worker-global surface this bench worker uses. Bun exposes these
 * globals in a worker context; typing them explicitly keeps `globalThis`
 * access type-safe (no `as any`).
 */
interface WorkerScope {
  onmessage: ((event: { data: WorkerMessage }) => void) | null
  postMessage(message: unknown): void
}

const ctx = globalThis as unknown as WorkerScope

ctx.onmessage = (event) => {
  const msg = event.data

  try {
    if (msg?.type === 'init') {
      currentOp = msg.op ?? ''
      currentPayload = msg.payload

      const warmup = Math.max(0, Number(msg.warmup ?? 0))
      for (let i = 0; i < warmup; i++) {
        checksumValue(runOnce(currentOp, currentPayload))
      }

      ctx.postMessage({ type: 'ready' })
      return
    }

    if (msg?.type === 'run') {
      const iterations = Math.max(1, Number(msg.iterations ?? 1))
      let checksum = 0n

      for (let i = 0; i < iterations; i++) {
        checksum += checksumValue(runOnce(currentOp, currentPayload))
      }

      ctx.postMessage({
        type: 'result',
        checksum: checksum.toString(),
      })
      return
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
