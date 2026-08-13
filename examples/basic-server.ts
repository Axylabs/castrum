// examples/basic-server.ts — Minimal castrum server (pre-baked ingress).
//
// Shows the ergonomic public API end-to-end: the pre-baked ingress pipeline
// (`createIngressHandler` + `createIngressServer`) wired to real HTTP routes,
// plus a couple of `rust.*` primitives. Everything here is synchronous.
//
// Run with:
//   bun examples/basic-server.ts
//
// Then exercise it:
//   curl -i http://localhost:3000/health
//   curl -i http://localhost:3000/healthz   (liveness probe)
//   curl -i http://localhost:3000/metrics   (Prometheus text, INGRESS_METRICS wiring)
//   curl -i -X POST http://localhost:3000/api/users \
//     -H 'content-type: application/json' -d '{"name":"Ada"}'
import {
  createIngressHandler,
  createIngressServer,
  createIngressMetrics,
  metricsHandler,
  livenessHandler,
  readinessHandler,
  healthHandler,
  rust,
} from "../index";

// ── rust.* primitives (zero-alloc, synchronous) ──────────────────────
const encoder = new TextEncoder();
console.log(
  "rust.validateEmail('ada@example.com') =>",
  rust.validateEmail(encoder.encode("ada@example.com")),
);
console.log("rust.crc32('hello') =>", rust.crc32(encoder.encode("hello")));

// ── Pre-baked ingress handler ────────────────────────────────────────
// Same options as createIngressFast; the handler packs the request frame in
// JS and drives the shared native core. Wire format: {"ok":true,...} on
// success, {"ok":false,"error":{...}} on errors, ratelimit-* headers.
const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true, // include url/ip/requestId in the response body
  cors: { allowOrigin: ["http://localhost:5173"] },
  rateLimit: { limit: 100, windowMs: 60_000 },
});

// Observability: the public Prometheus metrics + orchestrator probes. Wire the
// metrics runtime hooks into the handler so every request is counted, and serve
// /metrics + /healthz /readyz /livez as raw routes.
const metrics = createIngressMetrics();
const ingressWithMetrics = createIngressHandler(
  {
    parseCookies: true,
    parseQuery: true,
    emitMetadataJson: true,
    cors: { allowOrigin: ["http://localhost:5173"] },
    rateLimit: { limit: 100, windowMs: 60_000 },
  },
  metrics.runtime,
);

// ── Server (synchronous — wraps Bun.serve over the routes) ───────────
// Route keys map HTTP methods to the pre-baked handlers:
//   read    → GET + HEAD        write → POST + PUT + PATCH (+OPTIONS)
//   echo    → POST echo         cookies → GET + HEAD
//   handler → a raw request→Response function (probes / metrics)
const server = createIngressServer({
  port: 3000,
  routes: {
    "/health": { read: ingress },
    "/healthz": { read: livenessHandler() },
    "/readyz": { read: readinessHandler() },
    "/livez": { read: healthHandler() },
    "/metrics": { read: metricsHandler(metrics) },
    "/api/users": { read: ingressWithMetrics, write: ingressWithMetrics },
  },
  fallback: ingress, // any other path → 404
});

console.log(`listening on http://localhost:${server.port}`);
