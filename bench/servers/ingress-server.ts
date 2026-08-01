// bench/servers/ingress-server.ts — production-ready optimized Bun ingress server
//
// This server is a thin wiring layer over the pre-baked ingress handlers in
// src/ingress/handlers.ts. The handlers are re-exported at the bottom of this
// file so any system can consume the optimized ingress pipeline with minimal
// effort:
//
//   import { createIngressHandler, readHandler, createIngressServer } from "./ingress-server";
import { errorCodeName } from "../../src/ingress";
import {
  createIngressHandler,
  createIngressServer,
  RATE_LIMIT_U32_MAX,
  type BakedIngressResult,
} from "../../src/ingress";
import {
  PORTS,
  USER_SCHEMA_BYTES,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
} from "./shared";
import {
  ERR_CODE_NONE as ERROR_CODE_NONE,
  ERR_CODE_INTERNAL as ERROR_CODE_INTERNAL,
} from "../../src/ingress/constants";

// ── Runtime configuration (validated) ──

/** Read a boolean env flag with a safe default; warn on invalid values. */
function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  console.warn(
    `[ingress] WARN: env ${name}=${JSON.stringify(raw)} is not a boolean; using default ${defaultValue}`,
  );
  return defaultValue;
}

/** Read an integer env var with min/max clamping; warn on NaN. */
function envNumber(
  name: string,
  defaultValue: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(
      `[ingress] WARN: env ${name}=${JSON.stringify(raw)} is not a number; using default ${defaultValue}`,
    );
    return defaultValue;
  }
  if (n < min) {
    console.warn(`[ingress] WARN: env ${name}=${n} below min ${min}; using ${min}`);
    return min;
  }
  if (n > max) {
    console.warn(`[ingress] WARN: env ${name}=${n} above max ${max}; using ${max}`);
    return max;
  }
  return n;
}

const RATE_ENABLED =
  RATE_LIMIT_CONFIG.limit !== RATE_LIMIT_U32_MAX &&
  RATE_LIMIT_CONFIG.limit > 0;

// SECURITY: proxy trust is OPT-IN. Defaulting to on lets any client spoof
// X-Forwarded-For / X-Real-IP and impersonate arbitrary IPs for IP-based rate
// limiting. Enable (INGRESS_TRUST_PROXY=1) only behind a trusted edge and pair
// it with an explicit trusted-proxy network list.
const TRUST_PROXY = envFlag("INGRESS_TRUST_PROXY", false);
const HTTPS_FIXED = true;
const NEED_SOCKET_IP = RATE_ENABLED;

const EMIT_REQUEST_ID_HEADER = envFlag("INGRESS_REQUEST_ID_HEADER", false);

// Safe default: copy response bodies.
// Do not enable zero-copy unless you implement per-response output buffers.
const UNSAFE_ZERO_COPY = envFlag("INGRESS_UNSAFE_ZERO_COPY", false);
const COPY_BODY = !UNSAFE_ZERO_COPY;

const OUTPUT_BUF_SIZE = envNumber("INGRESS_OUTPUT_BUF_BYTES", 131072, 65536);

// Security headers are safe by default.
// For maximum API throughput behind an edge/proxy, set INGRESS_SECURITY_HEADERS=0.
const SECURITY_HEADERS_ENABLED = envFlag("INGRESS_SECURITY_HEADERS", true);

const REUSE_PORT = envFlag("INGRESS_REUSE_PORT", false);

// Observability (both opt-in, both write JSON lines to stderr).
const LOG_REQUESTS = envFlag("INGRESS_LOG_REQUESTS", false);
const ENABLE_METRICS = envFlag("INGRESS_METRICS", false);

const HOST = process.env.INGRESS_HOST || "0.0.0.0";
const IDLE_TIMEOUT = envNumber("INGRESS_IDLE_TIMEOUT", 30, 1);

// ── Request logging & metrics (opt-in) ────────────────────────────
// INGRESS_LOG_REQUESTS=1 -> one JSON line per request on stderr.
// INGRESS_METRICS=1      -> periodic aggregate summary on stderr.
interface MetricsState {
  total: number;
  byStatusClass: { "2xx": number; "4xx": number; "5xx": number; "204": number };
  rateLimited: number;
  internalErrors: number;
  startMs: number;
}

const metrics: MetricsState | null = ENABLE_METRICS
  ? {
      total: 0,
      byStatusClass: { "2xx": 0, "4xx": 0, "5xx": 0, "204": 0 },
      rateLimited: 0,
      internalErrors: 0,
      startMs: Date.now(),
    }
  : null;

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

  if (result.errorCode !== ERROR_CODE_NONE) {
    entry.errorCode = errorCodeName(result.errorCode);
  }
  if (result.rateLimited) entry.rateLimited = true;
  if (result.trustedProxy) entry.trustedProxy = true;
  if (result.retryAfterMs > 0) entry.retryAfterMs = result.retryAfterMs;

  process.stderr.write(JSON.stringify(entry) + "\n");
}

function recordRequest(status: number, result: BakedIngressResult): void {
  if (!metrics) return;

  metrics.total++;
  if (status === 204) metrics.byStatusClass["204"]++;
  else if (status >= 500) metrics.byStatusClass["5xx"]++;
  else if (status >= 400) metrics.byStatusClass["4xx"]++;
  else metrics.byStatusClass["2xx"]++;

  if (result.rateLimited) metrics.rateLimited++;
  if (result.errorCode === ERROR_CODE_INTERNAL) metrics.internalErrors++;
}

function startMetricsReporter(): void {
  if (!metrics) return;

  const timer = setInterval(() => {
    const elapsedMs = Math.max(1, Date.now() - metrics.startMs);
    const rps = metrics.total / (elapsedMs / 1000);
    const summary = {
      ts: new Date().toISOString(),
      kind: "metrics",
      total: metrics.total,
      rps: Number(rps.toFixed(2)),
      status: metrics.byStatusClass,
      rateLimited: metrics.rateLimited,
      internalErrors: metrics.internalErrors,
      uptimeMs: elapsedMs,
    };
    process.stderr.write(JSON.stringify(summary) + "\n");
  }, 10_000);

  // Don't keep the process alive just for the reporter.
  (timer as unknown as { unref?: () => void }).unref?.();
}

// ── Optimized ingress instances ──
// The optimized pipeline (native Ingress.handleRequestFullSync), the
// zero-alloc result wrapper, header templates, error bodies and all route
// handlers now live in src/ingress/handlers.ts. This file only wires config.

function ipFor(req: Request, srv: any): string | undefined {
  if (!NEED_SOCKET_IP) return undefined;
  return srv?.requestIP?.(req)?.address || "0.0.0.0";
}

// ── Ingress instances ──
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

// Shared runtime: request-id emission, security headers, output buffer size
// and the metrics/logging hook (all opt-in via env).
const runtime = {
  emitRequestIdHeader: EMIT_REQUEST_ID_HEADER,
  enableSecurityHeaders: SECURITY_HEADERS_ENABLED,
  securityHeaders: Object.entries(SECURITY_HEADERS) as [string, string][],
  outputBufferSize: OUTPUT_BUF_SIZE,
  onResponse: (
    req: Request,
    result: BakedIngressResult,
    status: number,
    requestId: string,
  ) => {
    recordRequest(status, result);
    logRequest(req, result, status, requestId);
  },
};

const healthIngress = createIngressHandler(
  { ...baseOptions, parseCookies: false, parseQuery: false },
  runtime,
);

const usersReadIngress = createIngressHandler(
  { ...baseOptions, parseCookies: true, parseQuery: true },
  runtime,
);

const usersWriteIngress = createIngressHandler(
  {
    ...baseOptions,
    parseCookies: true,
    parseQuery: true,
    schema: USER_SCHEMA_BYTES,
    enableBodySizeGuard: true,
  },
  runtime,
);

const cookiesIngress = createIngressHandler(
  { ...baseOptions, parseCookies: true, parseQuery: false },
  runtime,
);

const echoIngress = createIngressHandler(
  {
    ...baseOptions,
    parseCookies: false,
    parseQuery: false,
    emitMetadataJson: false,
  },
  runtime,
);

const fallbackIngress = healthIngress;

// ── Server ──
createIngressServer({
  port: PORTS.ingress,
  hostname: HOST,
  idleTimeout: IDLE_TIMEOUT,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
  reusePort: REUSE_PORT,
  copyBody: COPY_BODY,
  getIp: ipFor,
  routes: {
    "/health": { read: healthIngress },
    "/api/users": {
      read: usersReadIngress,
      write: usersWriteIngress,
      maxBodyBytes: MAX_BODY_BYTES,
    },
    "/api/echo": { echo: echoIngress, maxBodyBytes: MAX_BODY_BYTES },
    "/api/cookies": { read: cookiesIngress },
  },
  fallback: fallbackIngress,
});

startMetricsReporter();

console.log(
  `[ingress] listening on :${PORTS.ingress} (optimized Bun.serve routes)`,
);

if (ENABLE_METRICS || LOG_REQUESTS) {
  console.log(
    `[ingress] config: trustProxy=${TRUST_PROXY} securityHeaders=${SECURITY_HEADERS_ENABLED} ` +
      `rateLimit=${RATE_ENABLED ? `${RATE_LIMIT_CONFIG.limit}/${RATE_LIMIT_CONFIG.windowMs}ms` : "off"} ` +
      `requestIdHeader=${EMIT_REQUEST_ID_HEADER} logRequests=${LOG_REQUESTS} metrics=${ENABLE_METRICS} ` +
      `outputBuf=${OUTPUT_BUF_SIZE} idleTimeout=${IDLE_TIMEOUT} reusePort=${REUSE_PORT}`,
  );
}

// ── Pre-baked ingress handlers (re-exported for any consumer) ──
export {
  createIngressHandler,
  createIngressServer,
  readHandler,
  headHandler,
  jsonWriteHandler,
  echoHandler,
  fallbackHandler,
  RATE_LIMIT_U32_MAX,
  ERROR_BODIES,
} from "../../src/ingress/handlers";
export type {
  BakedIngressResult,
  BakedContext,
  BakedHandlerOptions,
  BakedIngressRuntime,
  BakedRoute,
  CreateIngressServerOptions,
  BakedServer,
  OptimizedIngressHandler,
} from "../../src/ingress/handlers";