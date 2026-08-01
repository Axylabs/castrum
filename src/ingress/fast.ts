// src/ingress/fast.ts — High-performance ingress handler for public API
//
// Merges the optimizations from bench/servers/ingress-server.ts into the public API.
// Key improvements over old createIngressSync:
//   - Counter-based request ID (no crypto.randomUUID)
//   - Pre-encoded header name buffers
//   - Reusable output buffer
//   - Zero-alloc result parsing with lazy decode
//   - All constants come from Rust (src/ingress/constants.ts)

import addon from "../native";
import type { IngressInstance } from "../native";
import { IngressInputPacker } from "./packed-input";
import {
  OUT_VERDICT, OUT_ERROR_CODE, OUT_STATUS, OUT_FLAGS,
  OUT_RATE_LIMIT, OUT_RATE_REMAINING, OUT_RATE_RESET, OUT_RETRY_AFTER,
  OUT_COOKIES_JSON_LEN, OUT_QUERY_JSON_LEN, OUT_HEADER_VARIANT, OUT_BODY_JSON_LEN,
  OUT_DATA_START,
  FLAG_HAS_COOKIES, FLAG_HAS_QUERY,
  FLAG_BODY_VALID_JSON, FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED, FLAG_IS_PREFLIGHT, FLAG_RATE_LIMITED,
  FLAG_HTTPS, FLAG_TRUSTED_PROXY, FLAG_BODY_TRUNCATED,
  HV_JSON, HV_CORS_SIMPLE, HV_CORS_PREFLIGHT, HV_RATE_ACTIVE, HV_RATE_LIMITED,
  HV_COUNT,
  ERR_CODE_NONE, ERR_CODE_CORS_PREFLIGHT, ERR_CODE_RATE_LIMITED,
  ERR_CODE_BODY_TOO_LARGE, ERR_CODE_INVALID_JSON, ERR_CODE_SCHEMA_VALIDATION,
  ERR_CODE_BAD_REQUEST, ERR_CODE_REQUEST_TOO_LARGE, ERR_CODE_INTERNAL,
} from "./constants";

// ── Constants ──────────────────────────────────────────────────
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
// Internal-only default for the reusable output buffer.
const DEFAULT_OUTPUT_BUFFER_SIZE = 262_144;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY_BODY = new Uint8Array(0);
const EMPTY_IP_BYTES = encoder.encode("0.0.0.0");

// ── Method mapping ─────────────────────────────────────────────
export const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

// ── Header name constants (pre-encoded) ────────────────────────
const HDR_COOKIE = encoder.encode("cookie");
const HDR_ORIGIN = encoder.encode("origin");
const HDR_ACRM = encoder.encode("access-control-request-method");
const HDR_ACRH = encoder.encode("access-control-request-headers");
const HDR_XFF = encoder.encode("x-forwarded-for");
const HDR_XRI = encoder.encode("x-real-ip");
const HDR_XFP = encoder.encode("x-forwarded-proto");

// ── Header plan ────────────────────────────────────────────────
export interface HeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

// ── Fast request ID generator (counter-based, no crypto) ──────
const REQ_ID_HEX_LOOKUP = new Uint8Array(256 * 2);
for (let i = 0; i < 256; i++) {
  REQ_ID_HEX_LOOKUP[i * 2] = "0123456789abcdef".charCodeAt(i >> 4);
  REQ_ID_HEX_LOOKUP[i * 2 + 1] = "0123456789abcdef".charCodeAt(i & 0x0f);
}

const REQ_ID_BINARY = new Uint8Array(8);
const REQ_ID_HEX = new Uint8Array(16);

const WORKER_ID = Number(process.env.INGRESS_WORKER_ID || 0) & 0xffff;
const BOOT_RANDOM = (typeof crypto !== "undefined"
  ? (crypto as any).getRandomValues?.(new Uint32Array(1))?.[0] ?? ((Math.random() * 0xffffffff) >>> 0)
  : (Math.random() * 0xffffffff) >>> 0) as number;

const REQ_ID_COUNTER = {
  hi: (BOOT_RANDOM ^ (WORKER_ID << 16)) >>> 0,
  lo: 0,
};

export function generateRequestId(): Uint8Array {
  if (REQ_ID_COUNTER.lo === 0xffffffff) {
    REQ_ID_COUNTER.lo = 0;
    REQ_ID_COUNTER.hi = (REQ_ID_COUNTER.hi + 1) >>> 0;
  } else {
    REQ_ID_COUNTER.lo++;
  }

  REQ_ID_BINARY[0] = (REQ_ID_COUNTER.hi >>> 24) & 0xff;
  REQ_ID_BINARY[1] = (REQ_ID_COUNTER.hi >>> 16) & 0xff;
  REQ_ID_BINARY[2] = (REQ_ID_COUNTER.hi >>> 8) & 0xff;
  REQ_ID_BINARY[3] = REQ_ID_COUNTER.hi & 0xff;
  REQ_ID_BINARY[4] = (REQ_ID_COUNTER.lo >>> 24) & 0xff;
  REQ_ID_BINARY[5] = (REQ_ID_COUNTER.lo >>> 16) & 0xff;
  REQ_ID_BINARY[6] = (REQ_ID_COUNTER.lo >>> 8) & 0xff;
  REQ_ID_BINARY[7] = REQ_ID_COUNTER.lo & 0xff;

  for (let i = 0; i < 8; i++) {
    const b = REQ_ID_BINARY[i]!;
    REQ_ID_HEX[i * 2] = REQ_ID_HEX_LOOKUP[b * 2]!;
    REQ_ID_HEX[i * 2 + 1] = REQ_ID_HEX_LOOKUP[b * 2 + 1]!;
  }

  return REQ_ID_HEX;
}

// ── Header packing (directly into Uint8Array, no intermediate strings) ──
const HEADER_BUF_SIZE = 8192;

// Thread-local header buffer for per-call isolation
const [getHeaderBuf] = (() => {
  const tls = new Array<[Uint8Array, DataView]>();
  const MAX_CACHED = 256;
  let tlsIdx = 0;

  function acquire(): [Uint8Array, DataView] {
    const cached = tls[tlsIdx];
    tlsIdx = (tlsIdx + 1) % MAX_CACHED;
    if (cached) return cached;

    const buf = new Uint8Array(HEADER_BUF_SIZE);
    const view = new DataView(buf.buffer);
    const pair: [Uint8Array, DataView] = [buf, view];
    tls.push(pair);
    return pair;
  }

  return [acquire];
})();

function writeHeaderPair(
  buf: Uint8Array,
  view: DataView,
  pos: number,
  name: Uint8Array,
  value: string,
): number {
  const needed = 2 + name.length + 4 + value.length * 3;

  if (pos + needed > buf.length) {
    const next = new Uint8Array(Math.max(buf.length * 2, pos + needed));
    next.set(buf.subarray(0, pos));
    buf = next;
    view = new DataView(buf.buffer);
  }

  view.setUint16(pos, name.length, true);
  buf.set(name, pos + 2);
  pos += 2 + name.length;

  const valueLenPos = pos;
  pos += 4;

  const dest = buf.subarray(pos);
  const { written } = encoder.encodeInto(value, dest);

  view.setUint32(valueLenPos, written, true);
  pos += written;

  return pos;
}

function packHeaders(req: Request, plan: HeaderPlan): Uint8Array {
  const [buf, view] = getHeaderBuf();
  let pos = 2;
  let count = 0;

  const headers = req.headers;

  if (plan.cookie) {
    const v = headers.get("cookie");
    if (v !== null) {
      pos = writeHeaderPair(buf, view, pos, HDR_COOKIE, v);
      count++;
    }
  }

  if (plan.cors) {
    const origin = headers.get("origin");
    if (origin !== null) {
      pos = writeHeaderPair(buf, view, pos, HDR_ORIGIN, origin);
      count++;
    }

    if (req.method === "OPTIONS") {
      const acrm = headers.get("access-control-request-method");
      if (acrm !== null) {
        pos = writeHeaderPair(buf, view, pos, HDR_ACRM, acrm);
        count++;
      }

      const acrh = headers.get("access-control-request-headers");
      if (acrh !== null) {
        pos = writeHeaderPair(buf, view, pos, HDR_ACRH, acrh);
        count++;
      }
    }
  }

  if (plan.proxy) {
    const xff = headers.get("x-forwarded-for");
    if (xff !== null) {
      pos = writeHeaderPair(buf, view, pos, HDR_XFF, xff);
      count++;
    }

    const xri = headers.get("x-real-ip");
    if (xri !== null) {
      pos = writeHeaderPair(buf, view, pos, HDR_XRI, xri);
      count++;
    }
  }

  if (plan.proto) {
    const xfp = headers.get("x-forwarded-proto");
    if (xfp !== null) {
      pos = writeHeaderPair(buf, view, pos, HDR_XFP, xfp);
      count++;
    }
  }

  view.setUint16(0, count, true);
  return buf.subarray(0, pos);
}

// ── Fast result (lazy decode, minimal allocations) ──────────────
export class FastIngressResult {
  status = 500;
  verdict = 1;
  flags = 0;
  errorCode = ERR_CODE_INTERNAL;
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
  requestId = "";
  bodyTruncated = false;

  // Lazy-decoded cookie/query JSON
  private _buf: Uint8Array = EMPTY_BODY;
  private _bodyJsonStart = OUT_DATA_START;
  private _bodyJsonLen = 0;
  private _cookiesBuf: Uint8Array | null = null;
  private _queryBuf: Uint8Array | null = null;
  private _cookiesDecoded: string | null = null;
  private _queryDecoded: string | null = null;

  refresh(buf: Uint8Array, body: Uint8Array, requestId: string): void {
    this._buf = buf;
    this.body = body;
    this.requestId = requestId;

    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const rawVerdict = dv.getUint8(OUT_VERDICT);
    const rawErrorCode = dv.getUint8(OUT_ERROR_CODE);
    const rawStatus = dv.getUint16(OUT_STATUS, true);
    const flags = dv.getUint32(OUT_FLAGS, true);

    const rateLimit = dv.getUint32(OUT_RATE_LIMIT, true);
    const rateRemaining = dv.getUint32(OUT_RATE_REMAINING, true);

    const cookiesJsonLen = dv.getUint32(OUT_COOKIES_JSON_LEN, true);
    const queryJsonLen = dv.getUint32(OUT_QUERY_JSON_LEN, true);

    const headerVariant = dv.getUint8(OUT_HEADER_VARIANT);
    const bodyJsonLen = dv.getUint32(OUT_BODY_JSON_LEN, true);

    const preflightAllowed =
      (flags & FLAG_IS_PREFLIGHT) !== 0 && (flags & FLAG_CORS_ALLOWED) !== 0;

    const normalizedStatus = normalizeResponseStatus(
      rawStatus,
      rawErrorCode,
      preflightAllowed,
    );

    const uninitialized =
      rawVerdict === 0 && rawErrorCode === 0 && rawStatus === 0 && flags === 0;

    if (uninitialized) {
      this.status = 500;
      this.verdict = 1;
      this.errorCode = ERR_CODE_INTERNAL;
    } else {
      this.status = normalizedStatus;
      this.verdict = rawVerdict;
      this.errorCode = rawErrorCode;
    }

    this.flags = flags;
    this.rateLimit = rateLimit;
    this.rateRemaining = rateRemaining;

    if (rateLimit > 0 || (flags & FLAG_RATE_LIMITED) !== 0) {
      this.rateResetMs = Number(dv.getBigUint64(OUT_RATE_RESET, true));
      this.retryAfterMs = Number(dv.getBigUint64(OUT_RETRY_AFTER, true));
    } else {
      this.rateResetMs = 0;
      this.retryAfterMs = 0;
    }

    this.headerVariant = headerVariant;
    this._bodyJsonLen = bodyJsonLen;

    this.terminal = this.verdict !== 0 || this.status >= 400;
    this.ok = this.verdict === 0 && this.status >= 200 && this.status < 400;

    this.https = (flags & FLAG_HTTPS) !== 0;
    this.trustedProxy = (flags & FLAG_TRUSTED_PROXY) !== 0;
    this.hasCookies = (flags & FLAG_HAS_COOKIES) !== 0;
    this.hasQuery = (flags & FLAG_HAS_QUERY) !== 0;
    this.bodyValidJson = (flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (flags & FLAG_SCHEMA_VALID) !== 0;
    this.corsAllowed = (flags & FLAG_CORS_ALLOWED) !== 0;
    this.isPreflight = (flags & FLAG_IS_PREFLIGHT) !== 0;
    this.rateLimited = (flags & FLAG_RATE_LIMITED) !== 0;

    const safeCookiesLen =
      cookiesJsonLen > 0 && OUT_DATA_START + cookiesJsonLen <= buf.byteLength
        ? cookiesJsonLen
        : 0;

    const queryStart = OUT_DATA_START + safeCookiesLen;

    const safeQueryLen =
      queryJsonLen > 0 && queryStart + queryJsonLen <= buf.byteLength
        ? queryJsonLen
        : 0;

    // Store slices for lazy decode instead of eagerly decoding strings
    this._cookiesBuf = safeCookiesLen > 0
      ? buf.subarray(OUT_DATA_START, OUT_DATA_START + safeCookiesLen)
      : null;
    this._cookiesDecoded = null;

    this._queryBuf = safeQueryLen > 0
      ? buf.subarray(queryStart, queryStart + safeQueryLen)
      : null;
    this._queryDecoded = null;

    this._bodyJsonStart = queryStart + safeQueryLen;

    this.bodyTruncated =
      (flags & FLAG_BODY_TRUNCATED) !== 0 ||
      safeCookiesLen !== cookiesJsonLen ||
      safeQueryLen !== queryJsonLen;
  }

  invalidate(): void {
    this.status = 500;
    this.verdict = 1;
    this.flags = 0;
    this.errorCode = ERR_CODE_INTERNAL;
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
    this.requestId = "";
    this.bodyTruncated = false;

    this._buf = EMPTY_BODY;
    this._bodyJsonLen = 0;
    this._bodyJsonStart = OUT_DATA_START;
    this._cookiesBuf = null;
    this._queryBuf = null;
    this._cookiesDecoded = null;
    this._queryDecoded = null;
  }

  setInternalError(requestId: string): void {
    this.invalidate();
    this.requestId = requestId;
  }

  cookiesJson(): string {
    if (this._cookiesDecoded !== null) return this._cookiesDecoded;
    if (this._cookiesBuf !== null) {
      this._cookiesDecoded = decoder.decode(this._cookiesBuf);
      return this._cookiesDecoded;
    }
    return "{}";
  }

  queryJson(): string {
    if (this._queryDecoded !== null) return this._queryDecoded;
    if (this._queryBuf !== null) {
      this._queryDecoded = decoder.decode(this._queryBuf);
      return this._queryDecoded;
    }
    return "{}";
  }

  bodyJson(): Uint8Array {
    if (this._bodyJsonLen === 0) return EMPTY_BODY;

    const end = this._bodyJsonStart + this._bodyJsonLen;

    if (end > this._buf.byteLength) {
      return EMPTY_BODY;
    }

    return this._buf.subarray(this._bodyJsonStart, end);
  }
}

// ── Status helpers ──────────────────────────────────────────
export function isValidResponseStatus(status: number): boolean {
  return status === 101 || (status >= 200 && status <= 599);
}

export function statusForErrorCode(
  errorCode: number,
  isPreflightAllowed: boolean,
): number {
  if (isPreflightAllowed) return 204;

  switch (errorCode) {
    case ERR_CODE_CORS_PREFLIGHT: return 403;
    case ERR_CODE_RATE_LIMITED: return 429;
    case ERR_CODE_BODY_TOO_LARGE: return 413;
    case ERR_CODE_INVALID_JSON: return 400;
    case ERR_CODE_SCHEMA_VALIDATION: return 422;
    case ERR_CODE_BAD_REQUEST: return 400;
    case ERR_CODE_REQUEST_TOO_LARGE: return 431;
    case ERR_CODE_INTERNAL: return 500;
    default: return 500;
  }
}

export function normalizeResponseStatus(
  status: number,
  errorCode: number,
  isPreflightAllowed: boolean,
): number {
  if (isValidResponseStatus(status)) {
    return status;
  }
  return statusForErrorCode(errorCode, isPreflightAllowed);
}

export function safeTerminalStatus(
  r: {
    readonly status: number;
    readonly errorCode: number;
    readonly isPreflight: boolean;
    readonly corsAllowed: boolean;
  },
): number {
  const preflightAllowed = r.isPreflight && r.corsAllowed;
  if (preflightAllowed) return 204;

  const s = normalizeResponseStatus(r.status, r.errorCode, false);

  if (s >= 400) return s;

  if (r.errorCode !== ERR_CODE_NONE) {
    return statusForErrorCode(r.errorCode, false);
  }

  return 500;
}

// ── Header template system ─────────────────────────────────
export interface HeaderTemplate {
  readonly entries: ReadonlyArray<readonly [string, string]>;
  readonly needsOriginEcho: boolean;
  readonly needsRateDynamic: boolean;
  readonly needsRetryAfter: boolean;
  readonly needsDynamicHsts: boolean;
}

export interface CorsStaticStrings {
  readonly allowMethodsJoined: string;
  readonly allowHeadersJoined: string;
  readonly exposeHeadersJoined: string;
  readonly maxAgeString: string | null;
  readonly isWildcard: boolean;
  readonly credentials: boolean;
}

export interface ResponseBuildContext {
  readonly templates: HeaderTemplate[];
  readonly corsStatic: CorsStaticStrings | null;
  readonly hstsValue: string | null;
}

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

function buildCorsStaticStrings(
  cors: CorsOptions | undefined,
): CorsStaticStrings | null {
  if (!cors) return null;

  const isWildcard =
    !cors.allowOrigin ||
    cors.allowOrigin.length === 0 ||
    cors.allowOrigin.includes("*");

  return {
    allowMethodsJoined: cors.allowMethods?.length
      ? cors.allowMethods.join(", ")
      : "GET, HEAD, POST",
    allowHeadersJoined: cors.allowHeaders?.length
      ? cors.allowHeaders.join(", ")
      : "",
    exposeHeadersJoined: cors.exposeHeaders?.length
      ? cors.exposeHeaders.join(", ")
      : "",
    maxAgeString: typeof cors.maxAge === "number" ? String(cors.maxAge) : null,
    isWildcard,
    credentials: cors.allowCredentials === true,
  };
}

function buildHstsValue(sec: SecurityHeadersOptions): string | null {
  const wantHsts =
    sec.hsts === true ||
    sec.hstsMaxAge !== undefined ||
    sec.hstsIncludeSubdomains === true ||
    sec.hstsPreload === true;

  if (!wantHsts) return null;

  const maxAge = sec.hstsMaxAge ?? 31_536_000;
  let value = `max-age=${maxAge}`;

  if (sec.hstsIncludeSubdomains) value += "; includeSubDomains";
  if (sec.hstsPreload) value += "; preload";

  return value;
}

export function buildResponseContext(
  options: {
    cors?: CorsOptions;
    security?: SecurityHeadersOptions;
    https?: boolean;
    enableSecurityHeaders?: boolean;
    rateLimit?: { limit?: number };
  },
): ResponseBuildContext {
  const templates = buildHeaderTemplates(options);
  const corsStatic = buildCorsStaticStrings(options.cors);
  const hstsValue = buildHstsValue(options.security ?? {});

  return { templates, corsStatic, hstsValue };
}

function buildHeaderTemplates(
  options: {
    cors?: CorsOptions;
    security?: SecurityHeadersOptions;
    https?: boolean;
    enableSecurityHeaders?: boolean;
    rateLimit?: { limit?: number };
  },
): HeaderTemplate[] {
  const templates: HeaderTemplate[] = new Array(HV_COUNT);

  const sec = options.security ?? {};
  const securityEnabled = options.enableSecurityHeaders !== false;
  const corsStatic = buildCorsStaticStrings(options.cors);
  const hstsValue = buildHstsValue(sec);
  const hstsIsDynamic = options.https === undefined && hstsValue !== null;

  const securityPairs: Array<[string, string]> = [];

  if (securityEnabled) {
    if (sec.nosniff !== false) {
      securityPairs.push(["x-content-type-options", "nosniff"]);
    }

    securityPairs.push(["x-frame-options", sec.frameOptions ?? "DENY"]);
    securityPairs.push(["referrer-policy", sec.referrerPolicy ?? "no-referrer"]);

    if (sec.xssProtection) {
      securityPairs.push(["x-xss-protection", sec.xssProtection]);
    }

    if (sec.contentSecurityPolicy) {
      securityPairs.push(["content-security-policy", sec.contentSecurityPolicy]);
    }

    if (sec.coep) {
      securityPairs.push(["cross-origin-embedder-policy", sec.coep]);
    }

    if (sec.coop) {
      securityPairs.push(["cross-origin-opener-policy", sec.coop]);
    }

    if (sec.corp) {
      securityPairs.push(["cross-origin-resource-policy", sec.corp]);
    }

    if (hstsValue !== null && options.https === true) {
      securityPairs.push(["strict-transport-security", hstsValue]);
    }
  }

  const corsVaryPairs: Array<[string, string]> = [];

  if (corsStatic) {
    corsVaryPairs.push(["vary", "Origin"]);

    if (!corsStatic.isWildcard) {
      corsVaryPairs.push(["vary", "Access-Control-Request-Method"]);
      corsVaryPairs.push(["vary", "Access-Control-Request-Headers"]);
    }
  }

  const corsPolicyPairs: Array<[string, string]> = [];

  if (corsStatic) {
    if (corsStatic.credentials) {
      corsPolicyPairs.push(["access-control-allow-credentials", "true"]);
    }

    if (corsStatic.exposeHeadersJoined) {
      corsPolicyPairs.push([
        "access-control-expose-headers",
        corsStatic.exposeHeadersJoined,
      ]);
    }
  }

  const corsPreflightPairs: Array<[string, string]> = [];

  if (corsStatic) {
    corsPreflightPairs.push([
      "access-control-allow-methods",
      corsStatic.allowMethodsJoined,
    ]);

    if (corsStatic.allowHeadersJoined) {
      corsPreflightPairs.push([
        "access-control-allow-headers",
        corsStatic.allowHeadersJoined,
      ]);
    }

    if (corsStatic.maxAgeString) {
      corsPreflightPairs.push(["access-control-max-age", corsStatic.maxAgeString]);
    }
  }

  const rateLimitCeiling: Array<[string, string]> = [];

  if (options.rateLimit?.limit && options.rateLimit.limit > 0) {
    rateLimitCeiling.push(["x-ratelimit-limit", String(options.rateLimit.limit)]);
  }

  for (let variant = 0; variant < HV_COUNT; variant++) {
    const isCorsSimple = (variant & HV_CORS_SIMPLE) !== 0;
    const isCorsPreflight = (variant & HV_CORS_PREFLIGHT) !== 0;
    const isRateActive = (variant & HV_RATE_ACTIVE) !== 0;
    const isRateLimited = (variant & HV_RATE_LIMITED) !== 0;

    const entries: Array<[string, string]> = [];

    if (securityEnabled) {
      for (let i = 0; i < securityPairs.length; i++) {
        entries.push(securityPairs[i]!);
      }
    }

    for (let i = 0; i < corsVaryPairs.length; i++) {
      entries.push(corsVaryPairs[i]!);
    }

    if (isCorsSimple || isCorsPreflight) {
      for (let i = 0; i < corsPolicyPairs.length; i++) {
        entries.push(corsPolicyPairs[i]!);
      }
    }

    if (isCorsPreflight) {
      for (let i = 0; i < corsPreflightPairs.length; i++) {
        entries.push(corsPreflightPairs[i]!);
      }
    }

    if (isRateActive) {
      for (let i = 0; i < rateLimitCeiling.length; i++) {
        entries.push(rateLimitCeiling[i]!);
      }
    }

    templates[variant] = {
      entries,
      needsOriginEcho: isCorsSimple || isCorsPreflight,
      needsRateDynamic: isRateActive,
      needsRetryAfter: isRateLimited,
      needsDynamicHsts: hstsIsDynamic,
    };
  }

  return templates;
}

export function headersForResult(
  ctx: ResponseBuildContext,
  r: {
    readonly headerVariant: number;
    readonly corsAllowed: boolean;
    readonly rateRemaining: number;
    readonly rateResetMs: number;
    readonly retryAfterMs: number;
    readonly https: boolean;
  },
  req: Request,
  requestId: string,
): Headers {
  const template =
    ctx.templates[r.headerVariant & 0x1f] ?? ctx.templates[0]!;

  const headers = new Headers();

  for (const [name, value] of template.entries) {
    headers.append(name, value);
  }

  if (requestId) {
    headers.set("x-request-id", requestId);
  }

  if (template.needsOriginEcho && r.corsAllowed && ctx.corsStatic) {
    const origin = req.headers.get("origin");

    if (origin) {
      if (ctx.corsStatic.isWildcard && !ctx.corsStatic.credentials) {
        headers.set("access-control-allow-origin", "*");
      } else {
        headers.set("access-control-allow-origin", origin);
      }
    }
  }

  if (template.needsRateDynamic) {
    headers.set("x-ratelimit-remaining", String(Math.max(0, r.rateRemaining)));

    if (r.rateResetMs > 0) {
      headers.set("x-ratelimit-reset", String(Math.ceil(r.rateResetMs / 1000)));
    }
  }

  if (template.needsRetryAfter && r.retryAfterMs > 0) {
    headers.set(
      "retry-after",
      String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))),
    );
  }

  if (template.needsDynamicHsts && r.https && ctx.hstsValue) {
    headers.set("strict-transport-security", ctx.hstsValue);
  }

  return headers;
}

// ── Error code helpers ─────────────────────────────────
export function errorCodeName(code: number): string {
  switch (code) {
    case ERR_CODE_NONE: return "none";
    case ERR_CODE_CORS_PREFLIGHT: return "cors_preflight";
    case ERR_CODE_RATE_LIMITED: return "rate_limited";
    case ERR_CODE_BODY_TOO_LARGE: return "body_too_large";
    case ERR_CODE_INVALID_JSON: return "invalid_json";
    case ERR_CODE_SCHEMA_VALIDATION: return "schema_validation";
    case ERR_CODE_BAD_REQUEST: return "bad_request";
    case ERR_CODE_REQUEST_TOO_LARGE: return "request_too_large";
    case ERR_CODE_INTERNAL: return "internal";
    default: return "unknown";
  }
}

export function errorMessage(status: number, code: number): string {
  switch (code) {
    case ERR_CODE_CORS_PREFLIGHT: return "CORS preflight rejected";
    case ERR_CODE_RATE_LIMITED: return "Too many requests";
    case ERR_CODE_BODY_TOO_LARGE: return "Request body too large";
    case ERR_CODE_INVALID_JSON: return "Invalid JSON body";
    case ERR_CODE_SCHEMA_VALIDATION: return "JSON schema validation failed";
    case ERR_CODE_BAD_REQUEST: return "Bad request";
    case ERR_CODE_REQUEST_TOO_LARGE: return "Request too large";
    case ERR_CODE_INTERNAL: return "Internal server error";
    default: return status >= 500 ? "Internal server error" : "Request rejected";
  }
}

export function buildTerminalResponse(
  ctx: ResponseBuildContext,
  r: {
    readonly terminal: boolean;
    readonly isPreflight: boolean;
    readonly corsAllowed: boolean;
    readonly errorCode: number;
    readonly status: number;
    readonly headerVariant: number;
    readonly https: boolean;
    readonly rateLimit: number;
    readonly rateRemaining: number;
    readonly rateResetMs: number;
    readonly retryAfterMs: number;
  },
  req: Request,
  requestId: string,
): Response | null {
  if (!r.terminal) return null;

  const preflightAllowed = r.isPreflight && r.corsAllowed;
  const headers = headersForResult(ctx, r, req, requestId);

  if (preflightAllowed) {
    return new Response(null, { status: 204, headers });
  }

  const status = safeTerminalStatus(r);

  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");

  const payload = JSON.stringify({
    error: {
      code: errorCodeName(r.errorCode),
      status,
      message: errorMessage(status, r.errorCode),
      requestId: requestId || undefined,
    },
  });

  return new Response(payload, { status, headers });
}

// ── Ingress options ────────────────────────────────────
export interface IngressFastOptions {
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean; networks?: string[] };
  parseCookies?: boolean;
  parseQuery?: boolean;
  requireJsonBody?: boolean;
  schema?: Uint8Array;
  cors?: CorsOptions;
  rateLimit?: { limit?: number; windowMs?: number; maxEntries?: number };
  security?: SecurityHeadersOptions;
  https?: boolean;
  maxBodyBytes?: number;
  enableSecurityHeaders?: boolean;
  enableRequestIds?: boolean;
  enableBodySizeGuard?: boolean;
  emitMetadataJson?: boolean;
  readBody?: boolean;
  outputBufferSize?: number;
  limits?: {
    maxUrlBytes?: number;
    maxQueryBytes?: number;
    maxCookieBytes?: number;
    maxHeadersBytes?: number;
    maxHeaders?: number;
    maxPairs?: number;
  };
}

export interface IngressFastHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: FastIngressResult) => T,
  ): T;
}

// ── Option validation (fail fast on misspelled keys) ─────────────
// Options are forwarded to the native addon as a plain object; a misspelled
// key would otherwise be silently ignored. Validate against the known set so
// misconfiguration fails loudly at construction time.
const KNOWN_INGRESS_OPTION_KEYS: ReadonlySet<string> = new Set([
  "trustProxy",
  "trustedProxies",
  "parseCookies",
  "parseQuery",
  "requireJsonBody",
  "schema",
  "cors",
  "rateLimit",
  "security",
  "https",
  "maxBodyBytes",
  "enableSecurityHeaders",
  "enableRequestIds",
  "enableBodySizeGuard",
  "emitMetadataJson",
  "readBody",
  "outputBufferSize",
  "limits",
]);

function assertKnownIngressOptions(options: IngressFastOptions): void {
  for (const key of Object.keys(options)) {
    if (!KNOWN_INGRESS_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `createIngressFast: unknown option '${key}'. ` +
          `Known options: ${[...KNOWN_INGRESS_OPTION_KEYS].sort().join(", ")}`,
      );
    }
  }
}

// ── Fast ingress factory ─────────────────────────────
export function createIngressFast(
  options: IngressFastOptions = {},
): IngressFastHandler {
  assertKnownIngressOptions(options);

  const rustOptions: Record<string, unknown> = {
    trustProxy: options.trustProxy,
    trustedProxies: options.trustedProxies
      ? {
          enabled: options.trustedProxies.enabled,
          networks: options.trustedProxies.networks,
        }
      : undefined,
    parseCookies: options.parseCookies,
    parseQuery: options.parseQuery,
    requireJsonBody: options.requireJsonBody,
    schema: options.schema,
    cors: options.cors
      ? {
          allowOrigin: options.cors.allowOrigin,
          allowMethods: options.cors.allowMethods,
          allowHeaders: options.cors.allowHeaders,
          exposeHeaders: options.cors.exposeHeaders,
          allowCredentials: options.cors.allowCredentials,
          maxAge: options.cors.maxAge,
        }
      : undefined,
    rateLimit: options.rateLimit
      ? {
          limit: options.rateLimit.limit,
          windowMs: options.rateLimit.windowMs,
          maxEntries: options.rateLimit.maxEntries,
        }
      : undefined,
    https: options.https,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    enableBodySizeGuard: options.enableBodySizeGuard !== false,
    emitMetadataJson: options.emitMetadataJson,
    limits: options.limits
      ? {
          maxUrlBytes: options.limits.maxUrlBytes,
          maxQueryBytes: options.limits.maxQueryBytes,
          maxCookieBytes: options.limits.maxCookieBytes,
          maxHeadersBytes: options.limits.maxHeadersBytes,
          maxHeaders: options.limits.maxHeaders,
          maxPairs: options.limits.maxPairs,
        }
      : undefined,
  };

  const NativeIngress = (addon as any).Ingress as new (opts: Record<string, unknown>) => IngressInstance;
  const handler = new NativeIngress(rustOptions);

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: options.trustProxy === true || options.trustedProxies?.enabled === true,
    proto: (options.trustProxy === true || options.trustedProxies?.enabled === true) && options.https === undefined,
  };

  const outputBufSize = Math.max(
    OUT_DATA_START,
    options.outputBufferSize ?? DEFAULT_OUTPUT_BUFFER_SIZE,
  );
  const outputBuf = new Uint8Array(outputBufSize);
  const inputPacker = new IngressInputPacker();
  const result = new FastIngressResult();

  return {
    run(req, ip, body, requestId, fn) {
      try {
        const methodKind = METHOD_KIND[req.method] ?? 7;

        const urlBytes = encoder.encode(req.url);
        const ipBytes =
          ip && ip.length > 0 ? encoder.encode(ip) : EMPTY_IP_BYTES;
        const ridBytes = requestId
          ? encoder.encode(requestId)
          : new Uint8Array(0);

        const headers = packHeaders(req, headerPlan);

        const input = inputPacker.pack(
          methodKind,
          urlBytes,
          ipBytes,
          ridBytes,
          headers,
        );

        handler.handleRequestPacked(input, body, outputBuf);
        result.refresh(outputBuf, body ?? EMPTY_BODY, requestId);
      } catch {
        result.setInternalError(requestId);
      }

      try {
        const out = fn(result);

        if (
          out !== null &&
          (typeof out === "object" || typeof out === "function") &&
          typeof (out as any).then === "function"
        ) {
          throw new Error(
            "createIngressFast().run() callback must be synchronous.",
          );
        }

        return out;
      } finally {
        result.invalidate();
      }
    },
  };
}