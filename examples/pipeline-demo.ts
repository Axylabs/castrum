// examples/pipeline-demo.ts — createPipeline: framework-agnostic ingress.
//
// `createPipeline` (src/integration/pipeline.ts) is the general-purpose
// adoption path: it wraps the pre-baked ingress handler behind a small
// framework-neutral API (preprocess / handleRequest / readBody) so you can drop
// castrum's hardening (rate limiting, CORS, body guards, request ids, schema)
// into ANY Bun/Node framework — Hono, Elysia, or a plain Bun.serve fetch
// handler.
//
// This demo shows:
//   1. handleRequest — the whole pipeline behind a plain fetch handler.
//   2. preprocess    — the middleware pattern: short-circuit on terminal
//      (rate-limited / 4xx), else pass the PipelineContext (requestId, locals)
//      into your app handler.
//   3. W3C trace correlation — an onRequest hook parses `traceparent` and logs
//      the traceId/spanId so logs correlate across services.
//
// Run:  bun run examples/pipeline-demo.ts
// Test: curl -i http://localhost:3001/
//       curl -i -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' http://localhost:3001/

import { createPipeline } from "../src/integration";
import {
  parseTraceParent,
  createTraceId,
  createSpanId,
} from "../src/shared/trace";

// ── The pipeline: hardening + observability hooks, framework-neutral ──
const pipeline = createPipeline({
  options: {
    parseCookies: true,
    parseQuery: true,
    rateLimit: { limit: 100, windowMs: 60_000 },
    cors: { allowOrigin: ["http://localhost:5173"] },
  },
  runtime: {
    // W3C trace correlation: parse the incoming `traceparent`, or start a new
    // trace; log traceId/spanId so request logs correlate across services
    // (src/shared/trace.ts is the primitive; wire it into your logger).
    onRequest(req, requestId, ip) {
      const trace = parseTraceParent(req.headers.get("traceparent"));
      const traceId = trace?.traceId ?? createTraceId();
      const spanId = trace ? createSpanId() : traceId.slice(0, 16);
      console.log(
        JSON.stringify({ event: "trace", requestId, traceId, spanId, ip: ip ?? null }),
      );
    },
  },
});

// ── 1. handleRequest: the whole pipeline behind a plain fetch handler ──
// Rate limiting, CORS, body guards, request ids and the (optional) schema are
// all enforced; the response is rendered from the pipeline result.
Bun.serve({ port: 3001, fetch: (req) => pipeline.handleRequest(req) });

// ── 2. preprocess: the middleware pattern (short-circuit, pass ctx to app) ──
// A Hono/Elysia-style framework would call this inside a middleware:
//
//   async function middleware(req: Request) {
//     const { terminal, response, ctx } = await pipeline.preprocess(req);
//     if (terminal && response) return response; // rate-limited / rejected
//     // ctx.requestId / ctx.ip / ctx.locals → app handler context
//     return myAppHandler(ctx.requestId, ctx.locals)(req);
//   }
//
// `pipeline.readBody(req)` is also exported for app-side body reads with the
// same size-guard + deadline semantics as the pipeline.

console.log("pipeline demo listening on http://localhost:3001");
console.log("  GET /    → pipeline.handleRequest (200 {ok:true, requestId})");
console.log("  rateLimit: 100/min  ·  send a traceparent header to see trace correlation");
