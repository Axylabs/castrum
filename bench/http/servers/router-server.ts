// bench/http/servers/router-server.ts — per-route compiled-ingress server.
//
// Identical route surface to ingress-server.ts, but built with
// `createIngressRouter` instead of hand-wired `createIngressHandler` instances:
// each route compiles a DEDICATED native IngressInner from its own options,
// pre-warms at boot, and dispatches through the shared path/method matcher.
// Same wire format ({"ok":true,...,"requestId"} + `ratelimit-*`), same
// orchestrator probes via raw handlers, so the load generator's shape checks
// pass unchanged. This is the "one super solution" being benchmarked.

import { errorCodeName } from '../../../src/ingress';
import {
  createIngressRouter,
  createIngressMetrics,
  metricsHandler,
  livenessHandler,
  readinessHandler,
  healthHandler,
  RATE_LIMIT_U32_MAX,
  type BakedIngressResult,
} from '../../../src/ingress';
import {
  PORTS,
  envFlag,
  envNumber,
  USER_SCHEMA_BYTES,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
} from "./shared";
import { ERR_CODE_NONE as ERROR_CODE_NONE } from '../../../src/ingress/constants';

const RATE_ENABLED = RATE_LIMIT_CONFIG.limit !== RATE_LIMIT_U32_MAX && RATE_LIMIT_CONFIG.limit > 0;
const TRUST_PROXY = envFlag("INGRESS_TRUST_PROXY", false);
const HTTPS_FIXED = true;
const NEED_SOCKET_IP = RATE_ENABLED;

const EMIT_REQUEST_ID_HEADER = envFlag("INGRESS_REQUEST_ID_HEADER", false);

// Zero-copy pipeline-only responses (the native output slice is served via a
// streaming body that holds the pooled buffer until consumed — safe with the
// bounds below). Default is COPY mode — the SAME default as ingress-server.ts:
// measured at the server-bound config (2026-08-21, autocannon static POST
// /api/users, 2000 connections, pipelining 1, median-of-3) that per-request
// `ReadableStream` construction costs ~47% RPS (45.1k zero-copy vs 66.4k copy)
// and ~parity on GET — the small metadata envelope is cheaper to `slice()` +
// `new Response(bytes)` than to wrap in stream machinery. INGRESS_ZERO_COPY=1
// opts back in (large response-payload deployments); the legacy
// INGRESS_UNSAFE_ZERO_COPY alias is honored.
const ZERO_COPY_ENABLED = envFlag("INGRESS_ZERO_COPY", envFlag("INGRESS_UNSAFE_ZERO_COPY", false));
const COPY_BODY = !ZERO_COPY_ENABLED;
const ZERO_COPY_MAX_IN_FLIGHT = envNumber("INGRESS_ZERO_COPY_MAX_IN_FLIGHT", 128, 1);
const ZERO_COPY_TIMEOUT_MS = envNumber("INGRESS_ZERO_COPY_TIMEOUT_MS", 1000, 0);
const OUTPUT_BUF_SIZE = envNumber("INGRESS_OUTPUT_BUF_BYTES", 131072, 65536);
const SECURITY_HEADERS_ENABLED = envFlag("INGRESS_SECURITY_HEADERS", true);
const REUSE_PORT = envFlag("INGRESS_REUSE_PORT", false);
const LOG_REQUESTS = envFlag("INGRESS_LOG_REQUESTS", false);
const ENABLE_METRICS = envFlag("INGRESS_METRICS", false);
const HOST = process.env.INGRESS_HOST || "0.0.0.0";
const IDLE_TIMEOUT = envNumber("INGRESS_IDLE_TIMEOUT", 30, 1);

const ingressMetrics = ENABLE_METRICS ? createIngressMetrics() : null;

function logRequest(
  req: Request,
  result: BakedIngressResult,
  status: number,
  requestId: string,
): void {
  if (!LOG_REQUESTS) return;
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = req.url;
  }
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    kind: "request",
    requestId: requestId || undefined,
    method: req.method,
    path,
    status,
  };
  if (result.errorCode !== ERROR_CODE_NONE) entry.errorCode = errorCodeName(result.errorCode);
  if (result.rateLimited) entry.rateLimited = true;
  if (result.trustedProxy) entry.trustedProxy = true;
  if (result.retryAfterMs > 0) entry.retryAfterMs = result.retryAfterMs;
  process.stderr.write(JSON.stringify(entry) + "\n");
}

function ipFor(req: Request, srv: unknown): string | undefined {
  if (!NEED_SOCKET_IP) return undefined;
  const s = srv as { requestIP?: (req: Request) => { address?: string } | null } | null;
  return s?.requestIP?.(req)?.address || "0.0.0.0";
}

const baseOptions = {
  trustProxy: TRUST_PROXY,
  https: HTTPS_FIXED,
  maxBodyBytes: MAX_BODY_BYTES,
  enableBodySizeGuard: false,
  emitMetadataJson: true,
  cors: {
    allowOrigin: [...CORS_CONFIG.allowOrigin],
    allowMethods: [...CORS_CONFIG.allowMethods],
    allowHeaders: [...CORS_CONFIG.allowHeaders],
    exposeHeaders: [...CORS_CONFIG.exposeHeaders],
    allowCredentials: CORS_CONFIG.allowCredentials,
    maxAge: CORS_CONFIG.maxAge,
  },
  rateLimit: {
    limit: RATE_LIMIT_CONFIG.limit,
    windowMs: RATE_LIMIT_CONFIG.windowMs,
  },
};

const runtime = {
  emitRequestIdHeader: EMIT_REQUEST_ID_HEADER,
  enableSecurityHeaders: SECURITY_HEADERS_ENABLED,
  securityHeaders: Object.entries(SECURITY_HEADERS) as [string, string][],
  outputBufferSize: OUTPUT_BUF_SIZE,
  maxInFlight: ZERO_COPY_MAX_IN_FLIGHT,
  zeroCopyTimeoutMs: ZERO_COPY_TIMEOUT_MS,
  ...(ingressMetrics ? ingressMetrics.runtime : {}),
  onResponse: (
    req: Request,
    result: BakedIngressResult,
    status: number,
    requestId: string,
  ) => {
    if (ingressMetrics) {
      ingressMetrics.runtime.onResponse?.(req, result, status, requestId);
    }
    logRequest(req, result, status, requestId);
  },
};

// ── The router (per-route compiled ingress) ──
const router = createIngressRouter({
  warmOnCreate: true,
  runtime,
  getIp: ipFor,
  copyBody: COPY_BODY,
  routes: {
    "/health": {
      read: true,
      options: { ...baseOptions, parseCookies: false, parseQuery: false },
    },
    "/healthz": { raw: livenessHandler() },
    "/readyz": { raw: readinessHandler() },
    "/livez": { raw: healthHandler() },
    "/api/users": {
      read: true,
      write: true,
      maxBodyBytes: MAX_BODY_BYTES,
      options: {
        ...baseOptions,
        parseCookies: true,
        parseQuery: true,
        schema: USER_SCHEMA_BYTES,
        enableBodySizeGuard: true,
      },
    },
    "/api/echo": {
      echo: true,
      maxBodyBytes: MAX_BODY_BYTES,
      options: { ...baseOptions, parseCookies: false, parseQuery: false },
    },
    "/api/cookies": {
      read: true,
      options: { ...baseOptions, parseCookies: true, parseQuery: false },
    },
    "/api/native": {
      // LEAN native-stack route (route-wire v3): parseQuery+parseCookies in
      // ONE native call, JS builds the 2xx — the lean responder path measured
      // ~580ns cheaper per request than the full pipeline on this route shape
      // (bench/cost/native-route-vs-router.ts). Same wire shape (ok:true +
      // requestId) so the load generator's shape checks pass unchanged.
      native: {
        plan: { parseQuery: true, parseCookies: true },
        handler: (snap) =>
          Response.json({
            ok: true,
            requestId: snap.requestId,
            path: "/api/native",
            query: snap.query,
            cookies: snap.cookies,
          }),
      },
    },
  },
});

if (ingressMetrics) {
  // /metrics is served via the router's fetch dispatcher (raw handler).
  router.routes["/metrics"] = { GET: metricsHandler(ingressMetrics) as never };
}

const server = Bun.serve({
  hostname: HOST,
  port: PORTS.router,
  idleTimeout: IDLE_TIMEOUT,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
  reusePort: REUSE_PORT,
  routes: router.routes,
  fetch: router.fetch,
});

console.log(
  `[ingress-router] listening on :${server.port} (createIngressRouter, pre-warmed)`,
);

if (ENABLE_METRICS || LOG_REQUESTS) {
  console.log(
    `[ingress-router] config: trustProxy=${TRUST_PROXY} securityHeaders=${SECURITY_HEADERS_ENABLED} ` +
      `rateLimit=${RATE_ENABLED ? `${RATE_LIMIT_CONFIG.limit}/${RATE_LIMIT_CONFIG.windowMs}ms` : "off"} ` +
      `requestIdHeader=${EMIT_REQUEST_ID_HEADER} logRequests=${LOG_REQUESTS} metrics=${ENABLE_METRICS} ` +
      `outputBuf=${OUTPUT_BUF_SIZE} idleTimeout=${IDLE_TIMEOUT} reusePort=${REUSE_PORT}`,
  );
}

export { server, router };
