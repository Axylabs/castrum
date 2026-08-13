// src/integration/index.ts — framework-agnostic integration helpers.
//
// These helpers let any Bun backend framework (Hono, Elysia, or plain
// Bun.serve) embed castrum as a request stage:
//   - createPipeline   → run the ingress pipeline (rate-limit/CORS/schema/body)
//                        and either short-circuit or hand a context to the app
//   - createWebSocketUpgrade → RFC 6455 101 upgrade handshake
//   - sseResponse      → server-sent-events response framed on the fast path

export {
  createPipeline,
  type IngressPipeline,
  type PipelineResult,
  type PipelineContext,
  type PreprocessOutcome,
  type CreatePipelineOptions,
} from './pipeline'
export {
  createWebSocketUpgrade,
  type WebSocketUpgradeOptions,
  type WebSocketUpgradeResult,
} from './websocket'
export { sseResponse, type SseEvent } from './streaming'
export {
  validateMany,
  validateCount,
  runMany,
  runOne,
} from './batch'
