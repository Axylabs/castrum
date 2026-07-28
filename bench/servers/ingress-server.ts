// bench/servers/ingress-server.ts — v9: PRODUCTION OPTIMIZED
//
// Env tuning:
//   INGRESS_REQUEST_ID_HEADER=1   Emit X-Request-Id header (off by default)
//   INGRESS_UNSAFE_ZERO_COPY=1    Benchmark-only: return subarrays of shared buffer
//   INGRESS_OUTPUT_BUF_BYTES=N    Rust output buffer size (default 131072)

import addon from "../../src/native";
import {
  PORTS,
  USER_SCHEMA_BYTES,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
} from "./shared";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Header variant bits (must match Rust) ──
const HV_JSON = 1 << 0;
const HV_CORS_SIMPLE = 1 << 1;
const HV_CORS_PREFLIGHT = 1 << 2;
const HV_RATE_ACTIVE = 1 << 3;
const HV_RATE_LIMITED = 1 << 4;

// ── Output buffer layout (must match Rust) ──
const OUT_VERDICT = 0;
const OUT_ERROR_CODE = 1;
const OUT_STATUS = 2;
const OUT_FLAGS = 4;
const OUT_RATE_LIMIT = 8;
const OUT_RATE_REMAINING = 12;
const OUT_RATE_RESET = 16;
const OUT_RETRY_AFTER = 24;
const OUT_COOKIES_JSON_LEN = 32;
const OUT_QUERY_JSON_LEN = 36;
const OUT_HEADER_VARIANT = 40;
const OUT_BODY_JSON_LEN = 44;
const OUT_DATA_START = 48;

// ── Flags ──
const FLAG_BODY_VALID_JSON = 1 << 2;
const FLAG_SCHEMA_VALID = 1 << 3;
const FLAG_CORS_ALLOWED = 1 << 4;
const FLAG_IS_PREFLIGHT = 1 << 5;
const FLAG_RATE_LIMITED = 1 << 6;

// ── Error codes ──
const ERROR_CODE_CORS_PREFLIGHT = 1;
const ERROR_CODE_RATE_LIMITED = 2;
const ERROR_CODE_BODY_TOO_LARGE = 3;
const ERROR_CODE_INVALID_JSON = 4;
const ERROR_CODE_SCHEMA_VALIDATION = 5;

// ── Runtime configuration ──
const RATE_LIMIT_U32_MAX = 4_294_967_295;
const RATE_ENABLED =
  RATE_LIMIT_CONFIG.limit !== RATE_LIMIT_U32_MAX &&
  RATE_LIMIT_CONFIG.limit > 0;
const TRUST_PROXY = true;
const HTTPS_FIXED = true;
const NEED_SOCKET_IP = RATE_ENABLED;
const EMIT_REQUEST_ID_HEADER = process.env.INGRESS_REQUEST_ID_HEADER === "1";
const UNSAFE_ZERO_COPY = process.env.INGRESS_UNSAFE_ZERO_COPY === "1";
const OUTPUT_BUF_SIZE = Math.max(
  65536,
  Number(process.env.INGRESS_OUTPUT_BUF_BYTES || 131072) | 0,
);

// ── Static header templates ──
const STATIC_SECURITY_ENTRIES: ReadonlyArray<[string, string]> = Object.freeze(
  Object.entries(SECURITY_HEADERS) as [string, string][],
);
const CORS_ALLOW_METHODS = CORS_CONFIG.allowMethods.join(", ");
const CORS_ALLOW_HEADERS = CORS_CONFIG.allowHeaders.join(", ");
const CORS_EXPOSE_HEADERS = CORS_CONFIG.exposeHeaders.join(", ");
const CORS_MAX_AGE = String(CORS_CONFIG.maxAge);
const RATE_LIMIT_STR = String(RATE_LIMIT_CONFIG.limit);

const HEADER_TEMPLATES: ReadonlyArray<ReadonlyArray<[string, string]>> =
  Object.freeze(
    Array.from({ length: 32 }, (_, variant) => {
      const entries: [string, string][] = [...STATIC_SECURITY_ENTRIES];
      if ((variant & HV_JSON) !== 0) entries.push(["Content-Type", "application/json"]);
      if ((variant & HV_CORS_SIMPLE) !== 0) {
        entries.push(["Vary", "Origin"]);
        if (CORS_CONFIG.allowCredentials) entries.push(["Access-Control-Allow-Credentials", "true"]);
        if (CORS_EXPOSE_HEADERS.length > 0) entries.push(["Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS]);
      }
      if ((variant & HV_CORS_PREFLIGHT) !== 0) {
        entries.push(["Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"]);
        if (CORS_CONFIG.allowCredentials) entries.push(["Access-Control-Allow-Credentials", "true"]);
        entries.push(["Access-Control-Allow-Methods", CORS_ALLOW_METHODS]);
        entries.push(["Access-Control-Allow-Headers", CORS_ALLOW_HEADERS]);
        entries.push(["Access-Control-Max-Age", CORS_MAX_AGE]);
      }
      if ((variant & HV_RATE_ACTIVE) !== 0) entries.push(["RateLimit-Limit", RATE_LIMIT_STR]);
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
  const template = HEADER_TEMPLATES[variant & 31];
  const needsRequestId = EMIT_REQUEST_ID_HEADER && requestIdHeader !== null;
  const needsOrigin =
    ((variant & HV_CORS_SIMPLE) !== 0 || (variant & HV_CORS_PREFLIGHT) !== 0) && origin !== null;
  const needsRate = (variant & HV_RATE_ACTIVE) !== 0;
  const needsRetry = (variant & HV_RATE_LIMITED) !== 0;

  if (!needsRequestId && !needsOrigin && !needsRate && !needsRetry) {
    return template as [string, string][];
  }

  let extra = 0;
  if (needsRequestId) extra++;
  if (needsOrigin) extra++;
  if (needsRate) extra += 2;
  if (needsRetry) extra++;

  const entries = new Array<[string, string]>(template.length + extra);
  let i = 0;
  for (; i < template.length; i++) entries[i] = template[i];
  if (needsRequestId) entries[i++] = ["X-Request-Id", requestIdHeader as string];
  if (needsOrigin) entries[i++] = ["Access-Control-Allow-Origin", origin as string];
  if (needsRate) {
    entries[i++] = ["RateLimit-Remaining", String(rateRemaining ?? 0)];
    entries[i++] = ["RateLimit-Reset", String(rateResetSecs ?? 0)];
  }
  if (needsRetry) entries[i++] = ["Retry-After", String(retryAfterSecs ?? 0)];
  return entries;
}

// ── Pre-serialized static error payloads ──
const STATIC_ERROR_BODIES: Record<number, Uint8Array> = {};
function initStaticErrors() {
  STATIC_ERROR_BODIES[ERROR_CODE_CORS_PREFLIGHT] = encoder.encode('{"ok":false,"error":{"code":"cors_preflight_not_allowed","message":"CORS preflight not allowed"}}');
  STATIC_ERROR_BODIES[ERROR_CODE_BODY_TOO_LARGE] = encoder.encode('{"ok":false,"error":{"code":"body_too_large","message":"Request body is too large"}}');
  STATIC_ERROR_BODIES[ERROR_CODE_INVALID_JSON] = encoder.encode('{"ok":false,"error":{"code":"invalid_json","message":"Invalid JSON body"}}');
  STATIC_ERROR_BODIES[ERROR_CODE_SCHEMA_VALIDATION] = encoder.encode('{"ok":false,"error":{"code":"schema_validation_failed","message":"Request body failed schema validation"}}');
}
initStaticErrors();
const STATIC_DEFAULT_ERROR = encoder.encode('{"ok":false,"error":{"code":"rejected","message":"Rejected by ingress"}}');

// ── Fast Request ID Generator (Hex Counter) ──
const reqIdCounter = { hi: 0, lo: 0 };
const reqIdBytes = new Uint8Array(16);
const reqIdHexLookup = new Uint8Array(256 * 2);
for (let i = 0; i < 256; i++) {
  reqIdHexLookup[i * 2] = "0123456789abcdef".charCodeAt(i >> 4);
  reqIdHexLookup[i * 2 + 1] = "0123456789abcdef".charCodeAt(i & 0x0f);
}

function generateRequestId(): Uint8Array {
  if (reqIdCounter.lo === 0xFFFFFFFF) {
    reqIdCounter.lo = 0;
    reqIdCounter.hi++;
  } else {
    reqIdCounter.lo++;
  }
  
  reqIdBytes[0] = (reqIdCounter.hi >>> 24) & 0xFF;
  reqIdBytes[1] = (reqIdCounter.hi >>> 16) & 0xFF;
  reqIdBytes[2] = (reqIdCounter.hi >>> 8) & 0xFF;
  reqIdBytes[3] = reqIdCounter.hi & 0xFF;
  reqIdBytes[4] = (reqIdCounter.lo >>> 24) & 0xFF;
  reqIdBytes[5] = (reqIdCounter.lo >>> 16) & 0xFF;
  reqIdBytes[6] = (reqIdCounter.lo >>> 8) & 0xFF;
  reqIdBytes[7] = reqIdCounter.lo & 0xFF;
  
  for (let i = 0; i < 8; i++) {
    const b = reqIdBytes[i];
    reqIdBytes[i * 2] = reqIdHexLookup[b * 2];
    reqIdBytes[i * 2 + 1] = reqIdHexLookup[b * 2 + 1];
  }
  return reqIdBytes;
}

// ── Fast result wrapper (unchanged — binary protocol) ──
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
  bodyValidJson = false;
  schemaValid = false;
  body: Uint8Array = EMPTY_BODY;
  private _buf: Uint8Array = EMPTY_BODY;
  private _view: DataView | null = null;
  private _cookiesJson: string | undefined = undefined;
  private _queryJson: string | undefined = undefined;
  private _cookiesLen = 0;
  private _queryLen = 0;
  private _queryStart = OUT_DATA_START;
  private _bodyJsonStart = OUT_DATA_START;
  private _bodyJsonLen = 0;

  refresh(buf: Uint8Array, body: Uint8Array, view: DataView): void {
    this._buf = buf;
    this._view = view;
    this.body = body;
    
    // Batch read 48-byte header to minimize DataView boundary crossings
    const h0 = view.getUint32(OUT_VERDICT, true);     // verdict, error, status
    const h1 = view.getUint32(OUT_FLAGS, true);       // flags
    const h2 = view.getUint32(OUT_RATE_LIMIT, true);  // rate_limit
    const h3 = view.getUint32(OUT_RATE_REMAINING, true); // rate_remaining
    
    this.verdict = h0 & 0xFF;
    this.errorCode = (h0 >>> 8) & 0xFF;
    this.status = (h0 >>> 16) & 0xFFFF;
    const flags = h1;
    
    this.rateRemaining = h3;
    if (h2 > 0 || (flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(view.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(view.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }
    
    this._cookiesLen = view.getUint32(OUT_COOKIES_JSON_LEN, true);
    this._queryLen = view.getUint32(OUT_QUERY_JSON_LEN, true);
    this.headerVariant = view.getUint8(OUT_HEADER_VARIANT);
    this._bodyJsonLen = view.getUint32(OUT_BODY_JSON_LEN, true);
    
    this._queryStart = OUT_DATA_START + this._cookiesLen;
    this._bodyJsonStart = this._queryStart + this._queryLen;
    
    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status < 400;
    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0;
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0;
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0;
    this._cookiesJson = undefined;
    this._queryJson = undefined;
  }

  invalidate(): void {
    this.status = 0; this.verdict = 0; this.errorCode = 0; this.headerVariant = 0;
    this.rateRemaining = 0; this.rateResetMs = 0; this.retryAfterMs = 0;
    this.terminal = true; this.ok = false; this.isPreflight = false; this.corsAllowed = false;
    this.bodyValidJson = false; this.schemaValid = false; this.body = EMPTY_BODY;
    this._buf = EMPTY_BODY; this._view = null;
    this._cookiesJson = undefined; this._queryJson = undefined;
    this._cookiesLen = 0; this._queryLen = 0;
    this._queryStart = OUT_DATA_START; this._bodyJsonStart = OUT_DATA_START; this._bodyJsonLen = 0;
  }

  cookiesJson(): string {
    if (this._cookiesJson !== undefined) return this._cookiesJson;
    if (this._cookiesLen === 0) { this._cookiesJson = "{}"; return this._cookiesJson; }
    this._cookiesJson = decoder.decode(this._buf.subarray(OUT_DATA_START, OUT_DATA_START + this._cookiesLen));
    return this._cookiesJson;
  }

  queryJson(): string {
    if (this._queryJson !== undefined) return this._queryJson;
    if (this._queryLen === 0) { this._queryJson = "{}"; return this._queryJson; }
    this._queryJson = decoder.decode(this._buf.subarray(this._queryStart, this._queryStart + this._queryLen));
    return this._queryJson;
  }

  bodyJson(copy: boolean): Uint8Array<ArrayBuffer> {
    if (this._bodyJsonLen === 0) {
      return EMPTY_BODY as Uint8Array<ArrayBuffer>;
    }
    const slice = this._buf.subarray(
      this._bodyJsonStart,
      this._bodyJsonStart + this._bodyJsonLen,
    );
    // Fixed dead ternary: actually respect the copy flag
    return copy ? slice.slice() : slice;
  }
}

// ── Header packing (unchanged — binary protocol to Rust) ──
interface HeaderPlan { cookie: boolean; cors: boolean; proxy: boolean; proto: boolean; }
const HDR_COOKIE = encoder.encode("cookie");
const HDR_ORIGIN = encoder.encode("origin");
const HDR_ACRM = encoder.encode("access-control-request-method");
const HDR_XFF = encoder.encode("x-forwarded-for");
const HDR_XRI = encoder.encode("x-real-ip");
const HDR_XFP = encoder.encode("x-forwarded-proto");

function createHeaderPacker(plan: HeaderPlan) {
  let buf = new Uint8Array(8192);
  let view = new DataView(buf.buffer);

  function ensureCapacity(pos: number, needed: number): void {
    if (pos + needed <= buf.length) return;
    const next = new Uint8Array(Math.max(buf.length * 2, pos + needed));
    next.set(buf.subarray(0, pos));
    buf = next;
    view = new DataView(buf.buffer);
  }

  function writeHeaderPair(pos: number, name: Uint8Array, value: string): number {
    const needed = 2 + name.length + 4 + value.length * 3;
    ensureCapacity(pos, needed);
    view.setUint16(pos, name.length, true);
    buf.set(name, pos + 2);
    pos += 2 + name.length;
    const valueLenPos = pos;
    pos += 4;
    const { written } = encoder.encodeInto(value, buf.subarray(pos));
    view.setUint32(valueLenPos, written, true);
    pos += written;
    return pos;
  }

  return function packHeaders(req: Request, isOptions: boolean): Uint8Array {
    let pos = 2;
    let count = 0;
    const headers = req.headers;
    if (plan.cookie) { const v = headers.get("cookie"); if (v !== null) { pos = writeHeaderPair(pos, HDR_COOKIE, v); count++; } }
    if (plan.cors) {
      const origin = headers.get("origin");
      if (origin !== null) { pos = writeHeaderPair(pos, HDR_ORIGIN, origin); count++; }
      if (isOptions) { const acrm = headers.get("access-control-request-method"); if (acrm !== null) { pos = writeHeaderPair(pos, HDR_ACRM, acrm); count++; } }
    }
    if (plan.proxy) {
      const xff = headers.get("x-forwarded-for"); if (xff !== null) { pos = writeHeaderPair(pos, HDR_XFF, xff); count++; }
      const xri = headers.get("x-real-ip"); if (xri !== null) { pos = writeHeaderPair(pos, HDR_XRI, xri); count++; }
    }
    if (plan.proto) { const xfp = headers.get("x-forwarded-proto"); if (xfp !== null) { pos = writeHeaderPair(pos, HDR_XFP, xfp); count++; } }
    view.setUint16(0, count, true);
    return buf.subarray(0, pos);
  };
}

// ── Optimized ingress wrapper ──
const METHOD_KIND: Record<string, number> = { GET: 0, HEAD: 1, POST: 2, PUT: 3, PATCH: 4, DELETE: 5, OPTIONS: 6 };
const EMPTY_IP_BYTES = encoder.encode("0.0.0.0");

interface IngressContext {
  requestIdHeader: string | null;
  origin: string | null;
}

interface OptimizedIngressHandler {
  run<T>(req: Request, ip: string | undefined, body: Uint8Array | null, fn: (result: FastIngressResult, ctx: IngressContext) => T): T;
}

function createOptimizedIngress(options: any): OptimizedIngressHandler {
  const NativeIngress = (addon as any).Ingress;
  if (typeof NativeIngress !== "function") throw new Error("Native Ingress class missing");
  const handler = new NativeIngress(options);
  if (typeof handler.handleRequest !== "function") throw new Error("Native Ingress.handleRequest missing. Rebuild the Rust addon.");

  const trust = options.trustProxy === true;
  const limit = options.rateLimit?.limit;
  const rateEnabled = typeof limit === "number" && limit !== RATE_LIMIT_U32_MAX && limit > 0;
  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust && rateEnabled,
    proto: trust && options.https === undefined,
  };
  const packHeaders = createHeaderPacker(headerPlan);
  const outputBuf = new Uint8Array(OUTPUT_BUF_SIZE);
  const outputView = new DataView(outputBuf.buffer, outputBuf.byteOffset, outputBuf.byteLength);
  const urlBuf = new Uint8Array(65536);
  const ipBuf = new Uint8Array(64);
  const result = new FastIngressResult();

  return {
    run(req, ip, body, fn) {
      const methodKind = METHOD_KIND[req.method] ?? 7;
      const isOptions = methodKind === 6;

      const urlWrite = encoder.encodeInto(req.url, urlBuf);
      let urlBytes: Uint8Array = urlBuf.subarray(0, urlWrite.written);
      if (urlWrite.read < req.url.length) urlBytes = encoder.encode(req.url);

      let ipBytes: Uint8Array = EMPTY_IP_BYTES;
      if (NEED_SOCKET_IP && ip) {
        const ipWrite = encoder.encodeInto(ip, ipBuf);
        ipBytes = ipBuf.subarray(0, ipWrite.written);
      }

      // Fast hex counter ID
      const ridBytes = generateRequestId();
      
      // Extract origin exactly once per request
      const origin = req.headers.get("origin");

      const ctx: IngressContext = {
        requestIdHeader: EMIT_REQUEST_ID_HEADER ? decoder.decode(ridBytes) : null,
        origin,
      };

      const headers = packHeaders(req, isOptions);
      handler.handleRequest(methodKind, urlBytes, ipBytes, ridBytes, headers, body, outputBuf);
      result.refresh(outputBuf, body ?? EMPTY_BODY, outputView);
      try {
        return fn(result, ctx);
      } finally {
        result.invalidate();
      }
    },
  };
}

// ── Terminal / error response helpers ──
function terminalResponse(req: Request, result: FastIngressResult, ctx: IngressContext): Response | null {
  if (!result.terminal) return null;
  const hv = result.headerVariant;
  const origin = ctx.origin;

  if (result.isPreflight && result.corsAllowed) {
    return new Response(null, { status: 204, headers: responseHeaders(hv, ctx.requestIdHeader, origin) });
  }

  let body: Uint8Array;
  if (result.errorCode === ERROR_CODE_RATE_LIMITED) {
    // Dynamic payload for rate limited
    const retryAfterMs = Math.max(0, Math.round(result.retryAfterMs));
    body = encoder.encode(`{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":${retryAfterMs}}}`);
  } else {
    body = STATIC_ERROR_BODIES[result.errorCode] ?? STATIC_DEFAULT_ERROR;
  }

  return new Response(body, {
    status: result.status,
    headers: responseHeaders(hv, ctx.requestIdHeader, origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000), Math.ceil(result.retryAfterMs / 1000)),
  });
}

function errorResponse(req: Request, result: FastIngressResult | null, status: number, code: string, message: string, ctx: IngressContext): Response {
  const hv = result?.headerVariant ?? HV_JSON;
  const origin = ctx.origin;
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: responseHeaders(hv, ctx.requestIdHeader, origin, result?.rateRemaining, result ? Math.ceil(result.rateResetMs / 1000) : undefined, result ? Math.ceil(result.retryAfterMs / 1000) : undefined),
  });
}

function withContentType(headers: ReadonlyArray<[string, string]>, contentType: string): [string, string][] {
  const out = new Array<[string, string]>(headers.length + 1);
  for (let i = 0; i < headers.length; i++) out[i] = headers[i];
  out[headers.length] = ["Content-Type", contentType];
  return out;
}

// ── Ingress instances ──
const baseOptions = {
  trustProxy: TRUST_PROXY,
  https: HTTPS_FIXED,
  maxBodyBytes: MAX_BODY_BYTES,
  enableSecurityHeaders: false,
  enableRequestIds: false,
  enableCacheKey: false,
  enablePathQuery: false,
  enableBodySizeGuard: false,
  cors: {
    allowOrigin: [...CORS_CONFIG.allowOrigin],
    allowMethods: [...CORS_CONFIG.allowMethods],
    allowHeaders: [...CORS_CONFIG.allowHeaders],
    exposeHeaders: [...CORS_CONFIG.exposeHeaders],
    allowCredentials: CORS_CONFIG.allowCredentials,
    maxAge: CORS_CONFIG.maxAge,
  },
  rateLimit: { limit: RATE_LIMIT_CONFIG.limit, windowMs: RATE_LIMIT_CONFIG.windowMs },
  security: { hstsMaxAge: 15_552_000, hstsIncludeSubdomains: true, hstsPreload: false },
};

const healthIngress = createOptimizedIngress({ ...baseOptions, parseCookies: false, parseQuery: false, readBody: false });
const usersReadIngress = createOptimizedIngress({ ...baseOptions, parseCookies: true, parseQuery: true, readBody: false });
const usersWriteIngress = createOptimizedIngress({ ...baseOptions, parseCookies: true, parseQuery: true, schema: USER_SCHEMA_BYTES, readBody: true, enableBodySizeGuard: true });
const cookiesIngress = createOptimizedIngress({ ...baseOptions, parseCookies: true, parseQuery: false, readBody: false });
const echoIngress = createOptimizedIngress({ ...baseOptions, parseCookies: false, parseQuery: false, readBody: false });
const fallbackIngress = healthIngress;

// ── Server with Bun routes ──
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORTS.ingress,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,

  routes: {
    "/health": {
      GET: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        return healthIngress.run(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;
          const hv = result.headerVariant;
          return new Response(result.bodyJson(!UNSAFE_ZERO_COPY), {
            status: 200,
            headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)),
          });
        });
      },
      HEAD: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        return healthIngress.run(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;
          const hv = result.headerVariant;
          return new Response(null, {
            status: 200,
            headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)),
          });
        });
      },
    },

    "/api/users": {
      GET: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        return usersReadIngress.run(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;
          const hv = result.headerVariant;
          return new Response(result.bodyJson(!UNSAFE_ZERO_COPY), {
            status: 200,
            headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)),
          });
        });
      },

      POST: async (req: Request, srv: any) => handleUsersWrite(req, srv),
      PUT: async (req: Request, srv: any) => handleUsersWrite(req, srv),
      PATCH: async (req: Request, srv: any) => handleUsersWrite(req, srv),

      OPTIONS: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        return fallbackIngress.run(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;
          return errorResponse(req, result, 404, "not_found", "Not found", ctx);
        });
      },
    },

    "/api/echo": {
      POST: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        const prep = echoIngress.run<{ terminal?: Response; headers?: ReadonlyArray<[string, string]> }>(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return { terminal };
          const hv = result.headerVariant & ~HV_JSON;
          return { headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)) };
        });
        if (prep.terminal) return prep.terminal;

        const baseHeaders = prep.headers ?? HEADER_TEMPLATES[0];
        const requestedContentType = req.headers.get("content-type") ?? "application/octet-stream";
        const contentLengthHeader = req.headers.get("content-length");
        const contentLength = contentLengthHeader === null ? NaN : Number(contentLengthHeader);

        if (Number.isFinite(contentLength)) {
          if (contentLength > MAX_BODY_BYTES) {
            return new Response(STATIC_ERROR_BODIES[ERROR_CODE_BODY_TOO_LARGE], {
              status: 413,
              headers: withContentType(baseHeaders, "application/json"),
            });
          }
          if (contentLength <= 0 || req.body === null) {
            return new Response(null, { status: 200, headers: withContentType(baseHeaders, requestedContentType) });
          }
          return new Response(req.body, { status: 200, headers: withContentType(baseHeaders, requestedContentType) });
        }

        return req.arrayBuffer().then((ab) => {
          const bodyBytes = new Uint8Array(ab);
          if (bodyBytes.byteLength > MAX_BODY_BYTES) {
            return new Response(STATIC_ERROR_BODIES[ERROR_CODE_BODY_TOO_LARGE], {
              status: 413,
              headers: withContentType(baseHeaders, "application/json"),
            });
          }
          return new Response(bodyBytes.byteLength > 0 ? bodyBytes : null, {
            status: 200,
            headers: withContentType(baseHeaders, requestedContentType),
          });
        });
      },
    },

    "/api/cookies": {
      GET: (req: Request, srv: any) => {
        const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
        return cookiesIngress.run(req, ip, null, (result, ctx) => {
          const terminal = terminalResponse(req, result, ctx);
          if (terminal) return terminal;
          const hv = result.headerVariant;
          return new Response(result.bodyJson(!UNSAFE_ZERO_COPY), {
            status: 200,
            headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)),
          });
        });
      },
    },
  },

  fetch(req: Request, srv: any) {
    const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;
      const url = new URL(req.url);
      return errorResponse(req, result, 404, "not_found", `Route ${req.method} ${url.pathname} not found`, ctx);
    });
  },
});

// ── Shared POST/PUT/PATCH /api/users handler ──
async function handleUsersWrite(req: Request, srv: any): Promise<Response> {
  const ip = NEED_SOCKET_IP ? srv?.requestIP?.(req)?.address || "0.0.0.0" : undefined;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;
      return errorResponse(req, result, 415, "unsupported_media_type", "Content-Type must be application/json", ctx);
    });
  }

  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    return fallbackIngress.run(req, ip, null, (result, ctx) => {
      const terminal = terminalResponse(req, result, ctx);
      if (terminal) return terminal;
      return errorResponse(req, result, 413, "body_too_large", "Request body is too large", ctx);
    });
  }

  return usersWriteIngress.run(req, ip, bodyBytes, (result, ctx) => {
    const terminal = terminalResponse(req, result, ctx);
    if (terminal) return terminal;
    if (!result.bodyValidJson) {
      return errorResponse(req, result, 400, "invalid_json", "Invalid JSON body", ctx);
    }
    if (!result.schemaValid) {
      return errorResponse(req, result, 422, "schema_validation_failed", "Request body failed schema validation", ctx);
    }

    // ★ FIX: Use the pre-serialized body from Rust directly! No JSON.parse/stringify!
    const hv = result.headerVariant;
    return new Response(result.bodyJson(!UNSAFE_ZERO_COPY), {
      status: 200,
      headers: responseHeaders(hv, ctx.requestIdHeader, ctx.origin, result.rateRemaining, Math.ceil(result.rateResetMs / 1000)),
    });
  });
}

console.log(`[ingress] listening on :${PORTS.ingress} (Bun.serve routes)`);