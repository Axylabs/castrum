// bench/servers/ingress-server.ts — production-ready optimized Bun ingress server
import addon from "../../src/native";
import { safeTerminalStatus, errorCodeName } from "../../src/ingress";
import {
  PORTS,
  USER_SCHEMA_BYTES,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
} from "./shared";
import {
  OUT_VERDICT,
  OUT_FLAGS,
  OUT_RATE_LIMIT,
  OUT_RATE_REMAINING,
  OUT_RATE_RESET,
  OUT_RETRY_AFTER,
  OUT_COOKIES_JSON_LEN,
  OUT_QUERY_JSON_LEN,
  OUT_HEADER_VARIANT,
  OUT_BODY_JSON_LEN,
  OUT_DATA_START,
  FLAG_BODY_VALID_JSON,
  FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED,
  FLAG_IS_PREFLIGHT,
  FLAG_RATE_LIMITED,
  FLAG_TRUSTED_PROXY,
  FLAG_BODY_TRUNCATED,
  HV_JSON,
  HV_CORS_SIMPLE,
  HV_CORS_PREFLIGHT,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
  ERR_CODE_NONE as ERROR_CODE_NONE,
  ERR_CODE_CORS_PREFLIGHT as ERROR_CODE_CORS_PREFLIGHT,
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
  ERR_CODE_BODY_TOO_LARGE as ERROR_CODE_BODY_TOO_LARGE,
  ERR_CODE_INVALID_JSON as ERROR_CODE_INVALID_JSON,
  ERR_CODE_SCHEMA_VALIDATION as ERROR_CODE_SCHEMA_VALIDATION,
  ERR_CODE_BAD_REQUEST as ERROR_CODE_BAD_REQUEST,
  ERR_CODE_REQUEST_TOO_LARGE as ERROR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_INTERNAL as ERROR_CODE_INTERNAL,
} from "../../src/ingress/constants";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

const RATE_LIMIT_U32_MAX = 4_294_967_295;
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

const MAX_URL_BYTES = 65536;
const MAX_COOKIE_HEADER_BYTES = 8192;
const MAX_SMALL_HEADER_BYTES = 2048;
const MAX_XFF_HEADER_BYTES = 8192;

// Security headers are safe by default.
// For maximum API throughput behind an edge/proxy, set INGRESS_SECURITY_HEADERS=0.
const SECURITY_HEADERS_ENABLED = envFlag("INGRESS_SECURITY_HEADERS", true);

const REUSE_PORT = envFlag("INGRESS_REUSE_PORT", false);

// Observability (both opt-in, both write JSON lines to stderr).
const LOG_REQUESTS = envFlag("INGRESS_LOG_REQUESTS", false);
const ENABLE_METRICS = envFlag("INGRESS_METRICS", false);

const HOST = process.env.INGRESS_HOST || "0.0.0.0";
const IDLE_TIMEOUT = envNumber("INGRESS_IDLE_TIMEOUT", 30, 1);
const WORKER_ID = envNumber("INGRESS_WORKER_ID", 0, 0, 0xffff);

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
  result: FastIngressResult,
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

function recordRequest(status: number, result: FastIngressResult): void {
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

// ── Static header templates ──
const STATIC_SECURITY_ENTRIES: ReadonlyArray<[string, string]> =
  SECURITY_HEADERS_ENABLED
    ? Object.freeze(
      Object.entries(SECURITY_HEADERS).map(
        ([k, v]) => [k.toLowerCase(), v] as [string, string],
      ),
    )
    : Object.freeze([] as [string, string][]);

const CORS_ALLOW_METHODS = CORS_CONFIG.allowMethods.join(", ");
const CORS_ALLOW_HEADERS = CORS_CONFIG.allowHeaders.join(", ");
const CORS_EXPOSE_HEADERS = CORS_CONFIG.exposeHeaders.join(", ");
const CORS_MAX_AGE = String(CORS_CONFIG.maxAge);
const RATE_LIMIT_STR = String(RATE_LIMIT_CONFIG.limit);

const HEADER_TEMPLATES: ReadonlyArray<ReadonlyArray<[string, string]>> =
  Object.freeze(
    Array.from({ length: 32 }, (_, variant) => {
      const entries: [string, string][] = [...STATIC_SECURITY_ENTRIES];

      if ((variant & HV_JSON) !== 0) {
        entries.push(["content-type", "application/json"]);
      }

      if ((variant & HV_CORS_SIMPLE) !== 0) {
        entries.push(["vary", "Origin"]);
        if (CORS_CONFIG.allowCredentials) {
          entries.push(["access-control-allow-credentials", "true"]);
        }
        if (CORS_EXPOSE_HEADERS.length > 0) {
          entries.push(["access-control-expose-headers", CORS_EXPOSE_HEADERS]);
        }
      }

      if ((variant & HV_CORS_PREFLIGHT) !== 0) {
        entries.push([
          "vary",
          "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        ]);
        if (CORS_CONFIG.allowCredentials) {
          entries.push(["access-control-allow-credentials", "true"]);
        }
        entries.push(["access-control-allow-methods", CORS_ALLOW_METHODS]);
        entries.push(["access-control-allow-headers", CORS_ALLOW_HEADERS]);
        entries.push(["access-control-max-age", CORS_MAX_AGE]);
      }

      if ((variant & HV_RATE_ACTIVE) !== 0) {
        entries.push(["ratelimit-limit", RATE_LIMIT_STR]);
      }

      return Object.freeze(entries);
    }),
  );

function responseHeaders(
  variant: number,
  requestIdHeader: string | null,
  origin: string | null,
  rateRemaining?: number,
  rateResetSecs?: number,
  retryAfterSecs?: number,
): [string, string][] {
  const template: ReadonlyArray<[string, string]> =
    HEADER_TEMPLATES[variant & 31] ?? HEADER_TEMPLATES[0] ?? [];

  const needsRequestId = EMIT_REQUEST_ID_HEADER && requestIdHeader !== null;
  const needsOrigin =
    ((variant & HV_CORS_SIMPLE) !== 0 ||
      (variant & HV_CORS_PREFLIGHT) !== 0) &&
    origin !== null;
  const needsRate = (variant & HV_RATE_ACTIVE) !== 0;
  const needsRetry = (variant & HV_RATE_LIMITED) !== 0;

  if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
    return template as unknown as [string, string][];
  }

  let extra = 0;
  if (needsRequestId) extra++;
  if (needsOrigin) extra++;
  if (needsRate) extra += 2;
  if (needsRetry) extra++;

  const entries = new Array<[string, string]>(template.length + extra);
  let i = 0;

  for (; i < template.length; i++) {
    entries[i] = template[i]!;
  }

  if (needsRequestId) {
    entries[i++] = ["x-request-id", requestIdHeader as string];
  }

  if (needsOrigin) {
    entries[i++] = ["access-control-allow-origin", origin as string];
  }

  if (needsRate) {
    entries[i++] = ["ratelimit-remaining", String(rateRemaining ?? 0)];
    entries[i++] = ["ratelimit-reset", String(rateResetSecs ?? 0)];
  }

  if (needsRetry) {
    entries[i++] = ["retry-after", String(retryAfterSecs ?? 0)];
  }

  return entries;
}

function terminalHeaders(
  variant: number,
  ctx: IngressContext,
  result: FastIngressResult | null,
): [string, string][] {
  const base = responseHeaders(
    variant | HV_JSON,
    ctx.requestIdHeader,
    ctx.origin,
    result?.rateRemaining,
    result && result.rateResetMs > 0
      ? Math.ceil(result.rateResetMs / 1000)
      : undefined,
    result && result.retryAfterMs > 0
      ? Math.ceil(result.retryAfterMs / 1000)
      : undefined,
  );

  const out = new Array<[string, string]>(base.length + 1);
  for (let i = 0; i < base.length; i++) {
    out[i] = base[i]!;
  }
  out[base.length] = ["cache-control", "no-store"];
  return out;
}

// ── Static error bodies ──
function staticErrorBody(code: string, message: string): Uint8Array {
  return encoder.encode(
    `{"ok":false,"error":{"code":"${code}","message":"${message}"}}`,
  );
}

const ERROR_BODIES: Record<string, Uint8Array> = {
  not_found: staticErrorBody("not_found", "Not found"),
  unsupported_media_type: staticErrorBody(
    "unsupported_media_type",
    "Content-Type must be application/json",
  ),
  body_too_large: staticErrorBody(
    "body_too_large",
    "Request body is too large",
  ),
  invalid_json: staticErrorBody("invalid_json", "Invalid JSON body"),
  schema_validation_failed: staticErrorBody(
    "schema_validation_failed",
    "Request body failed schema validation",
  ),
  cors_preflight_not_allowed: staticErrorBody(
    "cors_preflight_not_allowed",
    "CORS preflight not allowed",
  ),
  bad_request: staticErrorBody("bad_request", "Bad request"),
  request_too_large: staticErrorBody("request_too_large", "Request too large"),
  rate_limited: staticErrorBody("rate_limited", "Too Many Requests"),
  internal: staticErrorBody("internal_error", "Internal server error"),
  rejected: staticErrorBody("rejected", "Rejected by ingress"),
};

const ERROR_CODE_BODIES: (Uint8Array | undefined)[] = [];
ERROR_CODE_BODIES[ERROR_CODE_CORS_PREFLIGHT] =
  ERROR_BODIES.cors_preflight_not_allowed;
ERROR_CODE_BODIES[ERROR_CODE_RATE_LIMITED] = ERROR_BODIES.rate_limited;
ERROR_CODE_BODIES[ERROR_CODE_BODY_TOO_LARGE] = ERROR_BODIES.body_too_large;
ERROR_CODE_BODIES[ERROR_CODE_INVALID_JSON] = ERROR_BODIES.invalid_json;
ERROR_CODE_BODIES[ERROR_CODE_SCHEMA_VALIDATION] =
  ERROR_BODIES.schema_validation_failed;
ERROR_CODE_BODIES[ERROR_CODE_BAD_REQUEST] = ERROR_BODIES.bad_request;
ERROR_CODE_BODIES[ERROR_CODE_REQUEST_TOO_LARGE] =
  ERROR_BODIES.request_too_large;
ERROR_CODE_BODIES[ERROR_CODE_INTERNAL] = ERROR_BODIES.internal;

const RATE_LIMIT_BODY_PREFIX = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":',
);
const RATE_LIMIT_BODY_SUFFIX = encoder.encode("}}");

function rateLimitedBody(retryAfterMs: number): Uint8Array {
  const digits = encoder.encode(String(Math.max(0, Math.floor(retryAfterMs))));
  const out = new Uint8Array(
    RATE_LIMIT_BODY_PREFIX.byteLength +
    digits.byteLength +
    RATE_LIMIT_BODY_SUFFIX.byteLength,
  );
  out.set(RATE_LIMIT_BODY_PREFIX, 0);
  out.set(digits, RATE_LIMIT_BODY_PREFIX.byteLength);
  out.set(
    RATE_LIMIT_BODY_SUFFIX,
    RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength,
  );
  return out;
}

// ── Fast request ID generator ──
const reqIdBinary = new Uint8Array(8);
const reqIdHex = new Uint8Array(16);
const reqIdHexLookup = new Uint8Array(256 * 2);

for (let i = 0; i < 256; i++) {
  reqIdHexLookup[i * 2] = "0123456789abcdef".charCodeAt(i >> 4);
  reqIdHexLookup[i * 2 + 1] = "0123456789abcdef".charCodeAt(i & 0x0f);
}

const workerId = WORKER_ID & 0xffff;
const bootRandom = (Math.random() * 0xffffffff) >>> 0;

const reqIdCounter = {
  hi: (bootRandom ^ (workerId << 16)) >>> 0,
  lo: 0,
};

function generateRequestId(): Uint8Array {
  if (reqIdCounter.lo === 0xffffffff) {
    reqIdCounter.lo = 0;
    reqIdCounter.hi = (reqIdCounter.hi + 1) >>> 0;
  } else {
    reqIdCounter.lo++;
  }

  reqIdBinary[0] = (reqIdCounter.hi >>> 24) & 0xff;
  reqIdBinary[1] = (reqIdCounter.hi >>> 16) & 0xff;
  reqIdBinary[2] = (reqIdCounter.hi >>> 8) & 0xff;
  reqIdBinary[3] = reqIdCounter.hi & 0xff;
  reqIdBinary[4] = (reqIdCounter.lo >>> 24) & 0xff;
  reqIdBinary[5] = (reqIdCounter.lo >>> 16) & 0xff;
  reqIdBinary[6] = (reqIdCounter.lo >>> 8) & 0xff;
  reqIdBinary[7] = reqIdCounter.lo & 0xff;

  for (let i = 0; i < 8; i++) {
    const b = reqIdBinary[i]!;
    reqIdHex[i * 2] = reqIdHexLookup[b * 2]!;
    reqIdHex[i * 2 + 1] = reqIdHexLookup[b * 2 + 1]!;
  }

  return reqIdHex;
}

// ── Fast result wrapper ──
const EMPTY_BODY = new Uint8Array(0);

class FastIngressResult {
  status = 0;
  verdict = 0;
  errorCode = 0;
  headerVariant = 0;
  rateRemaining = 0;
  rateResetMs = 0;
  retryAfterMs = 0;
  terminal = true;
  ok = false;
  isPreflight = false;
  corsAllowed = false;
  rateLimited = false;
  trustedProxy = false;
  bodyValidJson = false;
  schemaValid = false;
  bodyTruncated = false;
  body: Uint8Array = EMPTY_BODY;

  private _buf: Uint8Array = EMPTY_BODY;
  private _bodyJsonStart = OUT_DATA_START;
  private _bodyJsonLen = 0;

  refresh(buf: Uint8Array, body: Uint8Array, view: DataView): void {
    this._buf = buf;
    this.body = body;

    const h0 = view.getUint32(OUT_VERDICT, true);
    const h1 = view.getUint32(OUT_FLAGS, true);
    const h2 = view.getUint32(OUT_RATE_LIMIT, true);
    const h3 = view.getUint32(OUT_RATE_REMAINING, true);

    const cookiesLenRaw = view.getUint32(OUT_COOKIES_JSON_LEN, true);
    const queryLenRaw = view.getUint32(OUT_QUERY_JSON_LEN, true);
    const headerVariant = view.getUint8(OUT_HEADER_VARIANT);
    const bodyJsonLenRaw = view.getUint32(OUT_BODY_JSON_LEN, true);

    const safeCookiesLen =
      OUT_DATA_START + cookiesLenRaw <= buf.byteLength ? cookiesLenRaw : 0;
    const queryStart = OUT_DATA_START + safeCookiesLen;
    const safeQueryLen =
      queryStart + queryLenRaw <= buf.byteLength ? queryLenRaw : 0;
    const bodyJsonStart = queryStart + safeQueryLen;
    const safeBodyJsonLen =
      bodyJsonStart + bodyJsonLenRaw <= buf.byteLength ? bodyJsonLenRaw : 0;

    if (h0 === 0 && h1 === 0) {
      this.verdict = 1;
      this.errorCode = ERROR_CODE_INTERNAL;
      this.status = 500;
    } else {
      this.verdict = h0 & 0xff;
      this.errorCode = (h0 >>> 8) & 0xff;

      const rawStatus = (h0 >>> 16) & 0xffff;
      const validStatus =
        rawStatus === 101 || (rawStatus >= 200 && rawStatus <= 599);
      this.status = validStatus ? rawStatus : 500;
    }

    const flags = h1;

    this.rateRemaining = h3;

    if (h2 > 0 || (flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(view.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(view.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }

    this.headerVariant = headerVariant;
    this._bodyJsonStart = bodyJsonStart;
    this._bodyJsonLen = safeBodyJsonLen;

    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status >= 200 && this.status < 400;

    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0;
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0;
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0;
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0;
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0;

    this.bodyTruncated =
      (flags & FLAG_BODY_TRUNCATED) !== 0 ||
      safeCookiesLen !== cookiesLenRaw ||
      safeQueryLen !== queryLenRaw ||
      safeBodyJsonLen !== bodyJsonLenRaw;
  }

  invalidate(): void {
    this.status = 0;
    this.verdict = 0;
    this.errorCode = 0;
    this.headerVariant = 0;
    this.rateRemaining = 0;
    this.rateResetMs = 0;
    this.retryAfterMs = 0;
    this.terminal = true;
    this.ok = false;
    this.isPreflight = false;
    this.corsAllowed = false;
    this.rateLimited = false;
    this.trustedProxy = false;
    this.bodyValidJson = false;
    this.schemaValid = false;
    this.bodyTruncated = false;
    this.body = EMPTY_BODY;
    this._buf = EMPTY_BODY;
    this._bodyJsonStart = OUT_DATA_START;
    this._bodyJsonLen = 0;
  }

  setInternalError(): void {
    this.invalidate();
    this.status = 500;
    this.verdict = 1;
    this.errorCode = ERROR_CODE_INTERNAL;
    this.headerVariant = HV_JSON;
    this.terminal = true;
    this.ok = false;
  }

  bodyJson(copy: boolean): Uint8Array {
    if (this._bodyJsonLen === 0) {
      return EMPTY_BODY;
    }

    const end = this._bodyJsonStart + this._bodyJsonLen;
    if (end > this._buf.byteLength) {
      return EMPTY_BODY;
    }

    const slice = this._buf.subarray(this._bodyJsonStart, end);
    return (copy ? slice.slice() : slice) as Uint8Array;
  }
}

const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

interface HeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

const EMPTY_IP = "0.0.0.0";

// ── Optimized ingress wrapper ──
interface IngressContext {
  requestIdHeader: string | null;
  origin: string | null;
}

interface OptimizedIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: FastIngressResult, ctx: IngressContext) => T,
  ): T;
}

function createOptimizedIngress(options: any): OptimizedIngressHandler {
  const NativeIngress = (addon as any).Ingress;
  if (typeof NativeIngress !== "function") {
    throw new Error("Native Ingress class missing. Rebuild the Rust addon.");
  }

  const handler = new NativeIngress(options);
  if (typeof handler.handleRequestFullSync !== "function") {
    throw new Error(
      "Native Ingress.handleRequestFullSync missing. Rebuild the Rust addon.",
    );
  }

  const trust = options.trustProxy === true;
  const limit = options.rateLimit?.limit;
  const rateEnabled =
    typeof limit === "number" && limit !== RATE_LIMIT_U32_MAX && limit > 0;

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust && rateEnabled,
    proto: trust && options.https === undefined,
  };

  const result = new FastIngressResult();
  const ctx: IngressContext = {
    requestIdHeader: null,
    origin: null,
  };

  return {
    run(req, ip, body, fn) {
      const methodKind = METHOD_KIND[req.method] ?? 7;
      const ridBytes = generateRequestId();
      const requestIdStr = decoder.decode(ridBytes);

      ctx.requestIdHeader = EMIT_REQUEST_ID_HEADER ? requestIdStr : null;
      ctx.origin = headerPlan.cors ? req.headers.get("origin") : null;

      // Gather raw headers as [name, value][] — no binary packing in JS
      const headers: [string, string][] = [];
      const h = req.headers;

      if (headerPlan.cookie) {
        const v = h.get("cookie");
        if (v !== null && v.length <= MAX_COOKIE_HEADER_BYTES) {
          headers.push(["cookie", v]);
        }
      }

      if (headerPlan.cors) {
        const originV = h.get("origin");
        if (originV !== null && originV.length <= MAX_SMALL_HEADER_BYTES) {
          headers.push(["origin", originV]);
        }

        if (methodKind === 6) {
          const acrm = h.get("access-control-request-method");
          if (acrm !== null && acrm.length <= MAX_SMALL_HEADER_BYTES) {
            headers.push(["access-control-request-method", acrm]);
          }

          const acrh = h.get("access-control-request-headers");
          if (acrh !== null && acrh.length <= MAX_SMALL_HEADER_BYTES) {
            headers.push(["access-control-request-headers", acrh]);
          }
        }
      }

      if (headerPlan.proxy) {
        const xff = h.get("x-forwarded-for");
        if (xff !== null && xff.length <= MAX_XFF_HEADER_BYTES) {
          headers.push(["x-forwarded-for", xff]);
        }

        const xri = h.get("x-real-ip");
        if (xri !== null && xri.length <= MAX_SMALL_HEADER_BYTES) {
          headers.push(["x-real-ip", xri]);
        }
      }

      if (headerPlan.proto) {
        const xfp = h.get("x-forwarded-proto");
        if (xfp !== null && xfp.length <= MAX_SMALL_HEADER_BYTES) {
          headers.push(["x-forwarded-proto", xfp]);
        }
      }

      const ipStr = ip ?? EMPTY_IP;

      try {
        // Pass raw values to Rust — handleRequestFullSync packs them internally
        // in Rust synchronously, eliminating both JS-side encoding AND tokio overhead.
        const outputBuf = handler.handleRequestFullSync(
          methodKind,
          req.url,
          ipStr,
          requestIdStr,
          headers,
          body,
          OUTPUT_BUF_SIZE,
        );

        const outputView = new DataView(
          outputBuf.buffer,
          outputBuf.byteOffset,
          outputBuf.byteLength,
        );

        result.refresh(outputBuf, body ?? EMPTY_BODY, outputView);
      } catch (err) {
        result.setInternalError();
      }

      try {
        const out = fn(result, ctx);
        if (out instanceof Response) {
          recordRequest(out.status, result);
          logRequest(req, result, out.status, requestIdStr);
        }
        return out;
      } finally {
        result.invalidate();
        ctx.requestIdHeader = null;
        ctx.origin = null;
      }
    },
  };
}

// ── Response helpers ──
function internalErrorResponse(
  ctx: IngressContext,
  result?: FastIngressResult,
): Response {
  return new Response(ERROR_BODIES.internal, {
    status: 500,
    headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result ?? null),
  });
}

function terminalResponse(
  _req: Request,
  result: FastIngressResult,
  ctx: IngressContext,
): Response | null {
  if (!result.terminal) {
    return null;
  }

  const preflightAllowed = result.isPreflight && result.corsAllowed;

  if (preflightAllowed) {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(
        result.headerVariant,
        ctx.requestIdHeader,
        ctx.origin,
        result.rateRemaining,
        result.rateResetMs > 0
          ? Math.ceil(result.rateResetMs / 1000)
          : undefined,
        result.retryAfterMs > 0
          ? Math.ceil(result.retryAfterMs / 1000)
          : undefined,
      ),
    });
  }

  const status = safeTerminalStatus(result);

  const body: Uint8Array =
    result.errorCode === ERROR_CODE_RATE_LIMITED
      ? rateLimitedBody(result.retryAfterMs)
      : ERROR_CODE_BODIES[result.errorCode] ?? ERROR_BODIES.internal;

  return new Response(body, {
    status,
    headers: terminalHeaders(result.headerVariant, ctx, result),
  });
}

function errorResponse(
  _req: Request,
  result: FastIngressResult | null,
  status: number,
  code: string,
  message: string,
  ctx: IngressContext,
): Response {
  const body =
    ERROR_BODIES[code] ??
    encoder.encode(
      JSON.stringify({ ok: false, error: { code, message } }),
    );

  return new Response(body, {
    status,
    headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result),
  });
}

function withContentType(
  headers: ReadonlyArray<[string, string]>,
  contentType: string,
): [string, string][] {
  const out = new Array<[string, string]>(headers.length + 1);
  for (let i = 0; i < headers.length; i++) {
    out[i] = headers[i]!;
  }
  out[headers.length] = ["content-type", contentType];
  return out;
}

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

const healthIngress = createOptimizedIngress({
  ...baseOptions,
  parseCookies: false,
  parseQuery: false,
});

const usersReadIngress = createOptimizedIngress({
  ...baseOptions,
  parseCookies: true,
  parseQuery: true,
});

const usersWriteIngress = createOptimizedIngress({
  ...baseOptions,
  parseCookies: true,
  parseQuery: true,
  schema: USER_SCHEMA_BYTES,
  enableBodySizeGuard: true,
});

const cookiesIngress = createOptimizedIngress({
  ...baseOptions,
  parseCookies: true,
  parseQuery: false,
});

const echoIngress = createOptimizedIngress({
  ...baseOptions,
  parseCookies: false,
  parseQuery: false,
  emitMetadataJson: false,
});

const fallbackIngress = healthIngress;

// ── Route handler factories ──
function makeReadHandler(ingress: OptimizedIngressHandler) {
  return (req: Request, srv: any): Response =>
    ingress.run<Response>(req, ipFor(req, srv), null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      if (result.bodyTruncated) {
        return internalErrorResponse(ctx, result);
      }

      return new Response(result.bodyJson(COPY_BODY), {
        status: 200,
        headers: responseHeaders(
          result.headerVariant,
          ctx.requestIdHeader,
          ctx.origin,
          result.rateRemaining,
          result.rateResetMs > 0
            ? Math.ceil(result.rateResetMs / 1000)
            : undefined,
        ),
      });
    });
}

function makeHeadHandler(ingress: OptimizedIngressHandler) {
  return (req: Request, srv: any): Response =>
    ingress.run<Response>(req, ipFor(req, srv), null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      if (result.bodyTruncated) {
        return internalErrorResponse(ctx, result);
      }

      return new Response(null, {
        status: 200,
        headers: responseHeaders(
          result.headerVariant,
          ctx.requestIdHeader,
          ctx.origin,
          result.rateRemaining,
          result.rateResetMs > 0
            ? Math.ceil(result.rateResetMs / 1000)
            : undefined,
        ),
      });
    });
}

async function handleUsersWrite(req: Request, srv: any): Promise<Response> {
  const ip = ipFor(req, srv);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return errorResponse(
        req,
        result,
        415,
        "unsupported_media_type",
        "Content-Type must be application/json",
        ctx,
      );
    });
  }

  const contentLengthHeader = req.headers.get("content-length");
  const contentLength =
    contentLengthHeader === null ? NaN : Number(contentLengthHeader);

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return errorResponse(
        req,
        result,
        413,
        "body_too_large",
        "Request body is too large",
        ctx,
      );
    });
  }

  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return errorResponse(
        req,
        result,
        400,
        "bad_request",
        "Unable to read request body",
        ctx,
      );
    });
  }

  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return errorResponse(
        req,
        result,
        413,
        "body_too_large",
        "Request body is too large",
        ctx,
      );
    });
  }

  return usersWriteIngress.run(req, ip, bodyBytes, (result, ctx) => {
    const terminal = terminalResponse(req, result, ctx);
    if (terminal) return terminal;

    if (result.bodyTruncated) {
      return internalErrorResponse(ctx, result);
    }

    if (!result.bodyValidJson) {
      return errorResponse(
        req,
        result,
        400,
        "invalid_json",
        "Invalid JSON body",
        ctx,
      );
    }

    if (!result.schemaValid) {
      return errorResponse(
        req,
        result,
        422,
        "schema_validation_failed",
        "Request body failed schema validation",
        ctx,
      );
    }

    return new Response(result.bodyJson(COPY_BODY), {
      status: 200,
      headers: responseHeaders(
        result.headerVariant,
        ctx.requestIdHeader,
        ctx.origin,
        result.rateRemaining,
        result.rateResetMs > 0
          ? Math.ceil(result.rateResetMs / 1000)
          : undefined,
      ),
    });
  });
}

// ── Server ──
const serverOptions: any = {
  hostname: HOST,
  port: PORTS.ingress,
  idleTimeout: IDLE_TIMEOUT,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
  routes: {
    "/health": {
      GET: makeReadHandler(healthIngress),
      HEAD: makeHeadHandler(healthIngress),
    },

    "/api/users": {
      GET: makeReadHandler(usersReadIngress),
      POST: async (req: Request, srv: any) => handleUsersWrite(req, srv),
      PUT: async (req: Request, srv: any) => handleUsersWrite(req, srv),
      PATCH: async (req: Request, srv: any) => handleUsersWrite(req, srv),
      OPTIONS: (req: Request, srv: any) =>
        fallbackIngress.run(req, ipFor(req, srv), null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;

          return errorResponse(req, result, 404, "not_found", "Not found", ctx);
        }),
    },

    "/api/echo": {
      POST: async (req: Request, srv: any) => {
        const ip = ipFor(req, srv);

        const prep = echoIngress.run<{
          terminal?: Response;
          headers?: ReadonlyArray<[string, string]>;
        }>(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return { terminal };

          if (result.bodyTruncated) {
            return { terminal: internalErrorResponse(ctx, result) };
          }

          const hv = result.headerVariant & ~HV_JSON;

          return {
            headers: responseHeaders(
              hv,
              ctx.requestIdHeader,
              ctx.origin,
              result.rateRemaining,
              result.rateResetMs > 0
                ? Math.ceil(result.rateResetMs / 1000)
                : undefined,
            ),
          };
        });

        if (prep.terminal) return prep.terminal;

        const baseHeaders: ReadonlyArray<[string, string]> =
          prep.headers ?? HEADER_TEMPLATES[0] ?? [];

        const requestedContentType =
          req.headers.get("content-type") ?? "application/octet-stream";

        const contentLengthHeader = req.headers.get("content-length");
        const contentLength =
          contentLengthHeader === null ? NaN : Number(contentLengthHeader);

        if (Number.isFinite(contentLength)) {
          if (contentLength > MAX_BODY_BYTES) {
            return new Response(ERROR_BODIES.body_too_large, {
              status: 413,
              headers: withContentType(baseHeaders, "application/json"),
            });
          }

          if (contentLength <= 0 || req.body === null) {
            return new Response(null, {
              status: 200,
              headers: withContentType(baseHeaders, requestedContentType),
            });
          }

          return new Response(req.body, {
            status: 200,
            headers: withContentType(baseHeaders, requestedContentType),
          });
        }

        try {
          const bodyBytes = new Uint8Array(await req.arrayBuffer());

          if (bodyBytes.byteLength > MAX_BODY_BYTES) {
            return new Response(ERROR_BODIES.body_too_large, {
              status: 413,
              headers: withContentType(baseHeaders, "application/json"),
            });
          }

          return new Response(bodyBytes.byteLength > 0 ? bodyBytes : null, {
            status: 200,
            headers: withContentType(baseHeaders, requestedContentType),
          });
        } catch {
          return new Response(ERROR_BODIES.bad_request, {
            status: 400,
            headers: withContentType(baseHeaders, "application/json"),
          });
        }
      },
    },

    "/api/cookies": {
      GET: makeReadHandler(cookiesIngress),
    },
  },

  fetch(req: Request, srv: any) {
    const ip = ipFor(req, srv);

    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return errorResponse(req, result, 404, "not_found", "Not found", ctx);
    });
  },
};

if (REUSE_PORT) {
  serverOptions.reusePort = true;
}

let server: any;
try {
  server = Bun.serve(serverOptions);
} catch (err) {
  if (REUSE_PORT) {
    delete serverOptions.reusePort;
    server = Bun.serve(serverOptions);
  } else {
    throw err;
  }
}

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