// src/ingress/index.ts — v6: ZERO-ALLOC NAPI BOUNDARY
//
// v6 changes from v5:
// ⭐ 1. method passed as u8 enum (no String alloc).
// ⭐ 2. url/ip/requestId passed as Uint8Array (zero-copy &[u8] in Rust).
// ⭐ 3. Pre-encoded constant bytes for method/IP avoid per-request TextEncoder calls.
// ⭐ 4. Calls handle_request_v6 (falls back to handle_request if unavailable).

import addon from "../native";

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string;
  hsts?: boolean;
  hstsMaxAge?: number;
  hstsIncludeSubdomains?: boolean;
  hstsPreload?: boolean;
  frameOptions?: string;
  nosniff?: boolean;
  referrerPolicy?: string;
  coep?: string;
  coop?: string;
  corp?: string;
  xssProtection?: string;
}

export interface CorsOptions {
  allowOrigin?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
}

export interface IngressOptions {
  trustProxy?: boolean;
  parseCookies?: boolean;
  parseQuery?: boolean;
  requireJsonBody?: boolean;
  schema?: Uint8Array;
  cors?: CorsOptions;
  rateLimit?: RateLimitOptions;
  security?: SecurityHeadersOptions;
  https?: boolean;
  maxBodyBytes?: number;
  enableSecurityHeaders?: boolean;
  enableRequestIds?: boolean;
  enableCacheKey?: boolean;
  enablePathQuery?: boolean;
  enableBodySizeGuard?: boolean;
  readBody?: boolean;
}

// ── Output buffer layout v5/v6 (must match Rust) ──
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
const FLAG_HAS_COOKIES = 1 << 0;
const FLAG_HAS_QUERY = 1 << 1;
const FLAG_BODY_VALID_JSON = 1 << 2;
const FLAG_SCHEMA_VALID = 1 << 3;
const FLAG_CORS_ALLOWED = 1 << 4;
const FLAG_IS_PREFLIGHT = 1 << 5;
const FLAG_RATE_LIMITED = 1 << 6;
const FLAG_HTTPS = 1 << 7;
const FLAG_TRUSTED_PROXY = 1 << 8;

export interface IngressFastResult {
  readonly status: number;
  readonly verdict: number;
  readonly flags: number;
  readonly errorCode: number;
  readonly terminal: boolean;
  readonly ok: boolean;
  readonly https: boolean;
  readonly trustedProxy: boolean;
  readonly hasCookies: boolean;
  readonly hasQuery: boolean;
  readonly bodyValidJson: boolean;
  readonly schemaValid: boolean;
  readonly corsAllowed: boolean;
  readonly isPreflight: boolean;
  readonly rateLimited: boolean;
  readonly rateLimit: number;
  readonly rateRemaining: number;
  readonly rateResetMs: number;
  readonly retryAfterMs: number;
  readonly body: Uint8Array;
  readonly headerVariant: number;
  cookiesJson(): string;
  queryJson(): string;
  bodyJson(): Uint8Array;
}

export interface SyncIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: IngressFastResult) => T,
  ): T;
}

// ── v6: Method → u8 lookup (avoids String copy across NAPI) ──
const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

// ── v6: Shared encoder + pre-encoded constants ──
const encoder = new TextEncoder();
const EMPTY_IP_BYTES = encoder.encode("0.0.0.0");

// ── Header packing (unchanged from v5) ──
const HEADER_BUF_SIZE = 8192;
let headerBuf = new Uint8Array(HEADER_BUF_SIZE);
let headerView = new DataView(headerBuf.buffer);
const HDR_COOKIE = encoder.encode("cookie");
const HDR_ORIGIN = encoder.encode("origin");
const HDR_ACRM = encoder.encode("access-control-request-method");
const HDR_XFF = encoder.encode("x-forwarded-for");
const HDR_XRI = encoder.encode("x-real-ip");
const HDR_XFP = encoder.encode("x-forwarded-proto");
const headerEncoder = new TextEncoder();

interface HeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

function packHeaders(req: Request, plan: HeaderPlan): Uint8Array {
  let pos = 0;
  pos += 2;
  let count = 0;
  const headers = req.headers;

  if (plan.cookie) {
    const v = headers.get("cookie");
    if (v !== null) {
      pos = writeHeaderPair(pos, HDR_COOKIE, v);
      count++;
    }
  }
  if (plan.cors) {
    const origin = headers.get("origin");
    if (origin !== null) {
      pos = writeHeaderPair(pos, HDR_ORIGIN, origin);
      count++;
    }
    if (req.method === "OPTIONS") {
      const acrm = headers.get("access-control-request-method");
      if (acrm !== null) {
        pos = writeHeaderPair(pos, HDR_ACRM, acrm);
        count++;
      }
    }
  }
  if (plan.proxy) {
    const xff = headers.get("x-forwarded-for");
    if (xff !== null) {
      pos = writeHeaderPair(pos, HDR_XFF, xff);
      count++;
    }
    const xri = headers.get("x-real-ip");
    if (xri !== null) {
      pos = writeHeaderPair(pos, HDR_XRI, xri);
      count++;
    }
  }
  if (plan.proto) {
    const xfp = headers.get("x-forwarded-proto");
    if (xfp !== null) {
      pos = writeHeaderPair(pos, HDR_XFP, xfp);
      count++;
    }
  }

  headerView.setUint16(0, count, true);
  return headerBuf.subarray(0, pos);
}

function writeHeaderPair(pos: number, name: Uint8Array, value: string): number {
  const needed = 2 + name.length + 4 + value.length * 3;
  if (pos + needed > headerBuf.length) {
    const next = new Uint8Array(headerBuf.length * 2);
    next.set(headerBuf.subarray(0, pos));
    headerBuf = next;
    headerView = new DataView(headerBuf.buffer);
  }
  headerView.setUint16(pos, name.length, true);
  headerBuf.set(name, pos + 2);
  pos += 2 + name.length;
  const valueLenPos = pos;
  pos += 4;
  const dest = headerBuf.subarray(pos);
  const { written } = headerEncoder.encodeInto(value, dest);
  headerView.setUint32(valueLenPos, written, true);
  pos += written;
  return pos;
}

// ── Body reading (unchanged) ──
const EMPTY_BODY = new Uint8Array(0);
const bodyCache = new WeakMap<Request, Promise<Uint8Array>>();

export function readRequestBodyOnce(req: Request): Promise<Uint8Array> {
  if (req.body === null) return Promise.resolve(EMPTY_BODY);
  const existing = bodyCache.get(req);
  if (existing) return existing;
  const p = req
    .arrayBuffer()
    .then((buf) => new Uint8Array(buf))
    .catch((err) => {
      bodyCache.delete(req);
      throw err;
    });
  bodyCache.set(req, p);
  return p;
}

// ── Mutable result (unchanged from v5) ──
const decoder = new TextDecoder();

class MutableIngressResult implements IngressFastResult {
  status = 0;
  verdict = 0;
  flags = 0;
  errorCode = 0;
  terminal = true;
  ok = false;
  https = false;
  trustedProxy = false;
  hasCookies = false;
  hasQuery = false;
  bodyValidJson = false;
  schemaValid = false;
  corsAllowed = false;
  isPreflight = false;
  rateLimited = false;
  rateLimit = 0;
  rateRemaining = 0;
  rateResetMs = 0;
  retryAfterMs = 0;
  body: Uint8Array = EMPTY_BODY;
  headerVariant = 0;

  private _cookiesJson = "{}";
  private _queryJson = "{}";
  private _bodyJsonLen = 0;
  private _bodyJsonStart = 0;
  private _buf: Uint8Array = EMPTY_BODY;

  refresh(buf: Uint8Array, body: Uint8Array): void {
    this._buf = buf;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.verdict = dv.getUint8(OUT_VERDICT);
    this.errorCode = dv.getUint8(OUT_ERROR_CODE);
    this.status = dv.getUint16(OUT_STATUS, true);
    this.flags = dv.getUint32(OUT_FLAGS, true);
    this.rateLimit = dv.getUint32(OUT_RATE_LIMIT, true);
    this.rateRemaining = dv.getUint32(OUT_RATE_REMAINING, true);

    if (this.rateLimit > 0 || (this.flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(dv.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(dv.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }

    const cookiesJsonLen = dv.getUint32(OUT_COOKIES_JSON_LEN, true);
    const queryJsonLen = dv.getUint32(OUT_QUERY_JSON_LEN, true);
    this.headerVariant = dv.getUint8(OUT_HEADER_VARIANT);
    this._bodyJsonLen = dv.getUint32(OUT_BODY_JSON_LEN, true);

    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status < 400;
    this.https = (this.flags & FLAG_HTTPS) !== 0;
    this.trustedProxy = (this.flags & FLAG_TRUSTED_PROXY) !== 0;
    this.hasCookies = (this.flags & FLAG_HAS_COOKIES) !== 0;
    this.hasQuery = (this.flags & FLAG_HAS_QUERY) !== 0;
    this.bodyValidJson = (this.flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (this.flags & FLAG_SCHEMA_VALID) !== 0;
    this.corsAllowed = (this.flags & FLAG_CORS_ALLOWED) !== 0;
    this.isPreflight = (this.flags & FLAG_IS_PREFLIGHT) !== 0;
    this.rateLimited = (this.flags & FLAG_RATE_LIMITED) !== 0;

    if (cookiesJsonLen > 0) {
      this._cookiesJson = decoder.decode(
        buf.subarray(OUT_DATA_START, OUT_DATA_START + cookiesJsonLen),
      );
    } else {
      this._cookiesJson = "{}";
    }
    const qStart = OUT_DATA_START + cookiesJsonLen;
    if (queryJsonLen > 0) {
      this._queryJson = decoder.decode(buf.subarray(qStart, qStart + queryJsonLen));
    } else {
      this._queryJson = "{}";
    }
    this._bodyJsonStart = qStart + queryJsonLen;
    this.body = body;
  }

  invalidate(): void {
    this.status = 0;
    this.verdict = 0;
    this.flags = 0;
    this.errorCode = 0;
    this.terminal = true;
    this.ok = false;
    this.https = false;
    this.trustedProxy = false;
    this.hasCookies = false;
    this.hasQuery = false;
    this.bodyValidJson = false;
    this.schemaValid = false;
    this.corsAllowed = false;
    this.isPreflight = false;
    this.rateLimited = false;
    this.rateLimit = 0;
    this.rateRemaining = 0;
    this.rateResetMs = 0;
    this.retryAfterMs = 0;
    this.body = EMPTY_BODY;
    this.headerVariant = 0;
    this._cookiesJson = "{}";
    this._queryJson = "{}";
    this._bodyJsonLen = 0;
    this._bodyJsonStart = 0;
    this._buf = EMPTY_BODY;
  }

  cookiesJson(): string {
    return this._cookiesJson;
  }
  queryJson(): string {
    return this._queryJson;
  }
  bodyJson(): Uint8Array {
    if (this._bodyJsonLen === 0) return EMPTY_BODY;
    return this._buf.subarray(
      this._bodyJsonStart,
      this._bodyJsonStart + this._bodyJsonLen,
    );
  }
}

// ── Factory ──
export function createIngressSync(
  options: IngressOptions = {},
): SyncIngressHandler {
  const handler = new (addon as any).Ingress(options);

  // v6: detect if handle_request_v6 is available
  const hasV6 = typeof handler.handleRequestV6 === "function";

  const trust = options.trustProxy === true;
  const rateEnabled = (() => {
    const limit = options.rateLimit?.limit;
    if (typeof limit !== "number") return false;
    if (limit === 4_294_967_295) return false;
    return limit > 0;
  })();

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust && rateEnabled,
    proto: trust && options.https === undefined,
  };

  const outputBuf = new Uint8Array(65536);
  const result = new MutableIngressResult();

  if (hasV6) {
    // ── v6 fast path: zero String allocations ──
    return {
      run(req, ip, body, requestId, fn) {
        const methodKind = METHOD_KIND[req.method] ?? 7;
        const urlBytes = encoder.encode(req.url);
        const ipBytes = ip ? encoder.encode(ip) : EMPTY_IP_BYTES;
        const ridBytes = encoder.encode(requestId);
        const headers = packHeaders(req, headerPlan);

        handler.handleRequestV6(
          methodKind,
          urlBytes,
          ipBytes,
          ridBytes,
          headers,
          body,
          outputBuf,
        );

        result.refresh(outputBuf, body ?? EMPTY_BODY);
        try {
          const out = fn(result);
          if (
            out !== null &&
            (typeof out === "object" || typeof out === "function") &&
            typeof (out as any).then === "function"
          ) {
            throw new Error(
              "createIngressSync().run() callback must be synchronous.",
            );
          }
          return out;
        } finally {
          result.invalidate();
        }
      },
    };
  }

  // ── v5 fallback (unchanged) ──
  return {
    run(req, ip, body, requestId, fn) {
      const socketIp = ip || "";
      const headers = packHeaders(req, headerPlan);
      handler.handleRequest(
        req.method,
        req.url,
        socketIp,
        requestId,
        headers,
        body,
        outputBuf,
      );
      result.refresh(outputBuf, body ?? EMPTY_BODY);
      try {
        const out = fn(result);
        if (
          out !== null &&
          (typeof out === "object" || typeof out === "function") &&
          typeof (out as any).then === "function"
        ) {
          throw new Error(
            "createIngressSync().run() callback must be synchronous.",
          );
        }
        return out;
      } finally {
        result.invalidate();
      }
    },
  };
}

// ── Legacy async wrapper (unchanged) ──
let asyncRequestCounter = 0;

export interface IngressHandler {
  (req: Request, ip?: string): Promise<IngressFastResult>;
}

export function createIngress(options: IngressOptions = {}): IngressHandler {
  const sync = createIngressSync(options);
  const wantsBody =
    options.readBody ??
    (options.requireJsonBody === true || options.schema != null);

  return async function ingressAsync(
    req: Request,
    ip?: string,
  ): Promise<IngressFastResult> {
    const requestId = `${Date.now().toString(36)}-${(asyncRequestCounter++ & 0xffffffff).toString(36)}`;
    let body: Uint8Array | null = null;
    if (wantsBody && req.body !== null) {
      try {
        body = await readRequestBodyOnce(req);
      } catch {
        body = EMPTY_BODY;
      }
    }
    return sync.run(req, ip, body, requestId, (r) => ({
      ...r,
      body: r.body.slice(),
      cookiesJson: () => r.cookiesJson(),
      queryJson: () => r.queryJson(),
      bodyJson: () => r.bodyJson().slice(),
    }));
  };
}