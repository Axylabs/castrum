// src/integration/index.ts — framework-agnostic integration helpers.
//
// These helpers let any Bun backend framework (Hono, Elysia, or plain
// Bun.serve) embed castrum as a request stage:
//   - createPipeline   → run the ingress pipeline (rate-limit/CORS/schema/body)
//                        and either short-circuit or hand a context to the app
//   - createWebSocketUpgrade → RFC 6455 101 upgrade handshake
//   - sseResponse      → server-sent-events response framed on the fast path

export {
  runMany,
  runOne,
  validateCount,
  validateMany,
} from './batch'
export {
  type CreatePipelineOptions,
  createPipeline,
  type IngressPipeline,
  type PipelineContext,
  type PipelineResult,
  type PreprocessOutcome,
} from './pipeline'
export { type SseEvent, sseResponse } from './streaming'
export {
  createWebSocketUpgrade,
  type WebSocketUpgradeOptions,
  type WebSocketUpgradeResult,
} from './websocket'
