// bench/cost/ingress-cost.ts — per-request runtime cost decomposition for the
// pre-baked ingress handler (the "millions of requests" path).
//
// Times each phase of a request through `createIngressHandler(...).run()` in
// isolation (no sockets — direct handler calls), so we can see whether the
// per-request cost is the native pipeline, the FFI crossing, the JS packing,
// or the result decode. Run: `bun bench/ingress-cost.ts`.
//
// Phases:
//   run        : full handler.run(req, ip, null, cb) — ground truth
//   pack       : the JS packing the REAL server path pays (generateRequestId +
//                req.headers.get('origin') + gatherRawHeadersPacked + req.url —
//                url/ip go to native as bun:ffi `cstring` args, so the legacy
//                packParts frame assembly is NOT part of the primary path)
//   packFrame  : the legacy FALLBACK frame packing (gatherRawHeadersPacked +
//                inputPacker.packParts) — only used when the components C-ABI
//                is unavailable (stale addon / napi fallback)
//   native     : bunFFI.ingressHandlePacked into a pooled buffer (FFI + Rust
//                pipeline) on a PRE-PACKED frame — the pure native+FFI cost
//   refresh    : BakedIngressResult.refresh on a pre-written output (decode)
//   respond    : the RESPONSE-BUILD phase the real server pays on top of `run`
//                (responseHeaders + memoizedHeaders + body slice/copy +
//                `new Response`) — the biggest chunk the `run` number hides

import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { BufferPool } from '../../src/shared/buffer-pool'
import { viewForArrayBuffer } from '../../src/shared/bytes'
import { generateRequestId } from '../../src/shared/request-id'
import { createIngressHandler } from '../../src/ingress/handlers'
import { BakedIngressResult } from '../../src/ingress/decode/baked-result'
import {
  buildHeaderPlan,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
  secondsFromMs,
} from '../../src/ingress/shared'
import { IngressInputPacker } from '../../src/ingress/packing/input-packer'
import { gatherRawHeadersPacked } from '../../src/ingress/packing/gather-raw-headers'
import { memoizedHeaders } from '../../src/ingress/headers/memoized-headers'
import { measureNs as measure } from '../measure'

const OPTIONS: Parameters<typeof createIngressHandler>[0] = {
  trustProxy: false,
  // Match the real bench server (bench/http/servers/ingress-server.ts): CORS-only
  // header plan (parseCookies/parseQuery off), pinned https, emitMetadataJson
  // on, rate limit on.
  https: true,
  maxBodyBytes: 262144,
  emitMetadataJson: true,
  cors: {
    allowOrigin: ['https://app.example.com'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
    exposeHeaders: ['x-request-id'],
    allowCredentials: true,
    maxAge: 600,
  },
  // `limit: 1000` exhausted during the 2.5k warm-up + measured calls, so the
  // historical `run` number (496 ns) mostly measured 429 rejections, not the
  // full pipeline. `u32::MAX` matches ingress-cost-post.ts: rate limiting
  // stays ON (pipeline work unchanged) but can never exhaust — and a genuine
  // 429 would flip `r.status` to 429 in the callback, a visible failure.
  rateLimit: { limit: 4_294_967_295, windowMs: 60_000 },
}

const handler = createIngressHandler(OPTIONS, { outputBufferSize: 262144, emitRequestIdHeader: false })
const NativeIngress = getAddon().Ingress as new (o: unknown) => {
  ingressInnerPtr(): bigint
  handleRequestPacked(input: Uint8Array, body: Uint8Array | null, output: Uint8Array): number
}
// Retain the instance: `ingressPtr` points into its native state, so dropping
// the JS owner would let GC free it under the raw-pointer call sites.
const ingressInstance = new NativeIngress(OPTIONS)
const ingressPtr = Number(ingressInstance.ingressInnerPtr())
void ingressInstance
const bunFFI = getBunFFI()
if (!bunFFI) throw new Error('bun:ffi not active')

const req = new Request('http://localhost:9122/api/users?page=1&limit=20', {
  method: 'GET',
  headers: { host: 'localhost:9122', origin: 'https://app.example.com' },
})
const headerPlan = buildHeaderPlan(OPTIONS)
const methodKind = METHOD_KIND['GET'] ?? METHOD_KIND_UNKNOWN
const inputPacker = new IngressInputPacker()
const pool = new BufferPool({ initialSize: 262144 })
const result = new BakedIngressResult()
const EMPTY_BODY = new Uint8Array(0)

// Pre-build the frame once (the per-request JS work is what `pack` measures).
const packedHeaders = gatherRawHeadersPacked(req, headerPlan, methodKind, 'https://app.example.com')
const prePacked = inputPacker.packParts(methodKind, req.url, '127.0.0.1', generateRequestId(), packedHeaders)
const handle = pool.acquire(262144)

// ── Phase measurements ──
const tRun = measure(
  () => handler.run(req, '127.0.0.1', null, (r) => r.status),
  50_000,
)

const tPack = measure(
  () => {
    // The REAL components-path JS packing (what handler.run() actually pays):
    // request-id bytes, the origin fetch (once), gatherRawHeadersPacked, and
    // the req.url getter (passed to native as a cstring — no JS encode).
    const ridBytes = generateRequestId()
    const origin = req.headers.get('origin')
    const ph = gatherRawHeadersPacked(req, headerPlan, methodKind, origin)
    return ridBytes.byteLength + (origin?.length ?? 0) + ph.byteLength + req.url.length
  },
  50_000,
)

const tPackFrame = measure(
  () => {
    // Legacy FALLBACK path only: JS frame assembly + Buffer.write URL/IP encode.
    const ph = gatherRawHeadersPacked(req, headerPlan, methodKind, 'https://app.example.com')
    return inputPacker.packParts(methodKind, req.url, '127.0.0.1', generateRequestId(), ph)
  },
  50_000,
)

const tNative = measure(
  () => bunFFI.ingressHandlePacked(ingressPtr, prePacked, null, handle.buffer),
  50_000,
)

// The components entry run() ACTUALLY drives on Bun (12 args: rid + headers +
// body + output; url/ip are engine-transcoded cstring args). Measured on the
// same pre-gathered headers and a PRE-GENERATED rid so the delta vs `native` is
// the entry/arity cost — not request-id generation.
const preRid = generateRequestId()
const tNativeComponents = measure(
  () => {
    const w = bunFFI.ingressHandleComponents(
      ingressPtr,
      methodKind,
      req.url,
      '127.0.0.1',
      preRid,
      packedHeaders,
      null,
      handle.buffer,
    )
    if (w === 0) throw new Error('ingress components failed')
    return w
  },
  50_000,
)

const written = bunFFI.ingressHandlePacked(ingressPtr, prePacked, null, handle.buffer)
const used = handle.buffer.subarray(0, written)
const tRefresh = measure(
  () => result.refresh(used, EMPTY_BODY, viewForArrayBuffer(used.buffer, used.byteOffset)),
  50_000,
)

// The response-build phase the REAL server pays on top of `run`: the exact
// `readHandler` success path — responseHeaders (origin-cached template or
// rate-extras array) → memoizedHeaders (memo HIT in steady state) →
// `new Response(body.slice(), init)`. `buildSuccessInit` is not exported, so
// this replicates it inline with the same pieces.
const tRespond = measure(
  () => {
    result.refresh(used, EMPTY_BODY, viewForArrayBuffer(used.buffer, used.byteOffset))
    const init = {
      status: 200,
      headers: memoizedHeaders(
        handler.responseHeaders(
          result.headerVariant,
          null,
          'https://app.example.com',
          result.rateRemaining,
          result.rateResetMs > 0 ? secondsFromMs(result.rateResetMs) : undefined,
        ),
      ),
    }
    return new Response(result.bodyJson(true), init)
  },
  50_000,
)

console.log('═══ Ingress per-request cost (ns/op, min-of-5) ═══')
console.log(`  run       (full request)    : ${tRun.toFixed(0).padStart(7)}`)
console.log(`  pack      (JS packing)      : ${tPack.toFixed(0).padStart(7)}`)
console.log(`  packFrame (fallback frame)  : ${tPackFrame.toFixed(0).padStart(7)}`)
console.log(`  native    (FFI + pipeline)  : ${tNative.toFixed(0).padStart(7)}`)
console.log(`  nativeCmp (components entry) : ${tNativeComponents.toFixed(0).padStart(7)}`)
console.log(`  refresh   (result decode)   : ${tRefresh.toFixed(0).padStart(7)}`)
console.log(`  respond   (Response build)  : ${tRespond.toFixed(0).padStart(7)}`)
console.log(`  JS-side est (run−native)    : ${(tRun - tNative).toFixed(0).padStart(7)}`)
