// src/ingress/index.ts — Public ingress API (barrel).
//
// All constants come from Rust via src/ingress/constants.ts. For maximum
// performance use createIngressFast() from ./fast.ts directly. The convenience
// factories (`createIngressSync` / `createIngress`) live in ./sync.ts and are
// re-exported here so this barrel stays a pure re-export hub.

// Runtime-driven server factory: picks Bun.serve on Bun and the node:http
// adapter on Node via the runtime adapter (src/runtime/server.ts). This
// explicit re-export SHADOWS the Bun-only `createIngressServer` from
// './server' (re-exported via './handlers' below) so the public API serves
// one backend per runtime. `createIngressServerNode` remains exported for
// consumers who want the Node backend pinned.
export { createIngressServer } from '../runtime/index'
export { generateRequestId } from '../shared/request-id'
export type { TraceContext } from '../shared/trace'
// W3C trace context helpers (parse `traceparent` for log/hook correlation).
export {
  createSpanId,
  createTraceId,
  parseTraceParent,
  serializeTraceParent,
} from '../shared/trace'
// ── Re-export the full public ingress API ─────────────────────────
export * from './constants'
export * from './errors'
export { createIngressFast, FastIngressResult } from './fast'
export * from './handlers'
export type { CorsOptions, CorsStaticStrings } from './headers/cors'
export type { HeaderTemplate, ResponseBuildContext } from './headers/fast-templates'
export { buildResponseContext, headersForResult } from './headers/fast-templates'
export type { SecurityHeadersOptions } from './headers/hsts'
export { healthHandler, livenessHandler, readinessHandler } from './health'
export type { IngressMetrics } from './metrics'
// ── Observability (zero-dep): metrics, health probes ─────────────
export { createIngressMetrics, metricsHandler } from './metrics'
export type { IngressFastHandler, IngressFastOptions } from './options'
export { buildTerminalResponse } from './response/terminal'
export type { CreateIngressRouterOptions, IngressRouter, RouterRouteSpec } from './router'
export { createIngressRouter } from './router'
export type { HeaderPlan } from './shared'
export { DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES, METHOD_KIND } from './shared'
export * from './status'
// ── Convenience factories (see ./sync.ts) ────────────────────────
export { createIngress, createIngressSync } from './sync'
export type {
  IngressContext,
  IngressHandler,
  IngressOptions,
  NativeRequestContext,
  NativeResponder,
  SyncIngressHandler,
  TerminalStyle,
} from './types'
