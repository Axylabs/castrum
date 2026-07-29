import addon from "../native";
import { IngressInputPacker } from "./packed-input";

// ── Public option types ──────────────────────────────────────────
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
  maxEntries?: number;
}

export interface TrustedProxyOptions {
  enabled?: boolean;
  networks?: string[];
}

export interface IngressLimitsOptions {
  maxUrlBytes?: number;
  maxQueryBytes?: number;
  maxCookieBytes?: number;
  maxHeadersBytes?: number;
  maxHeaders?: number;
  maxPairs?: number;
}

export interface IngressOptions {
  trustProxy?: boolean;
  trustedProxies?: TrustedProxyOptions;
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
  enableBodySizeGuard?: boolean;
  emitMetadataJson?: boolean;
  readBody?: boolean;
  outputBufferSize?: number;
  limits?: IngressLimitsOptions;
}

// ── Output buffer layout ─────────────────────────────────────────
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

// ── Flags ────────────────────────────────────────────────────────
const FLAG_HAS_COOKIES = 1 << 0;
const FLAG_HAS_QUERY = 1 << 1;
const FLAG_BODY_VALID_JSON = 1 << 2;
const FLAG_SCHEMA_VALID = 1 << 3;
const FLAG_CORS_ALLOWED = 1 << 4;
const FLAG_IS_PREFLIGHT = 1 << 5;
const FLAG_RATE_LIMITED = 1 << 6;
const FLAG_HTTPS = 1 << 7;
const FLAG_TRUSTED_PROXY = 1 << 8;
const FLAG_BODY_TRUNCATED = 1 << 9;

// ── Header variant bits ──────────────────────────────────────────
const HV_JSON = 1 << 0;
const HV_CORS_SIMPLE = 1 << 1;
const HV_CORS_PREFLIGHT = 1 << 2;
const HV_RATE_ACTIVE = 1 << 3;
const HV_RATE_LIMITED = 1 << 4;
const HV_COUNT = 32;

// ── Error codes ──────────────────────────────────────────────────
const ERR_CODE_NONE = 0;
const ERR_CODE_CORS_PREFLIGHT = 1;
const ERR_CODE_RATE_LIMITED = 2;
const ERR_CODE_BODY_TOO_LARGE = 3;
const ERR_CODE_INVALID_JSON = 4;
const ERR_CODE_SCHEMA_VALIDATION = 5;
const ERR_CODE_BAD_REQUEST = 6;
const ERR_CODE_REQUEST_TOO_LARGE = 7;
const ERR_CODE_INTERNAL = 8;

// ── Constants ────────────────────────────────────────────────────
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_OUTPUT_BUFFER_SIZE = 262_144;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EMPTY_BODY = new Uint8Array(0);
const EMPTY_IP_BYTES = encoder.encode("0.0.0.0");
const EMPTY_REQUEST_ID_BYTES = encoder.encode("");

// ── Result types ─────────────────────────────────────────────────
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
  readonly requestId: string;
  readonly bodyTruncated: boolean;

  cookiesJson(): string;
  queryJson(): string;
  bodyJson(): Uint8Array;
}

export interface IngressContext extends IngressFastResult {
  response: Response | null;
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

export interface IngressHandler {
  (req: Request, ip?: string): Promise<IngressContext>;
}

// ── HTTP status helpers ─────────────────────────────────────────
export function isValidResponseStatus(status: number): boolean {
  return status === 101 || (status >= 200 && status <= 599);
}

export function statusForErrorCode(
  errorCode: number,
  isPreflightAllowed: boolean,
): number {
  if (isPreflightAllowed) return 204;

  switch (errorCode) {
    case ERR_CODE_CORS_PREFLIGHT:
      return 403;
    case ERR_CODE_RATE_LIMITED:
      return 429;
    case ERR_CODE_BODY_TOO_LARGE:
      return 413;
    case ERR_CODE_INVALID_JSON:
      return 400;
    case ERR_CODE_SCHEMA_VALIDATION:
      return 422;
    case ERR_CODE_BAD_REQUEST:
      return 400;
    case ERR_CODE_REQUEST_TOO_LARGE:
      return 431;
    case ERR_CODE_INTERNAL:
      return 500;
    default:
      return 500;
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
  r: Pick<
    IngressFastResult,
    "status" | "errorCode" | "isPreflight" | "corsAllowed"
  >,
): number {
  const preflightAllowed = r.isPreflight && r.corsAllowed;
  if (preflightAllowed) return 204;

  const status = normalizeResponseStatus(r.status, r.errorCode, false);

  if (status >= 400) {
    return status;
  }

  if (r.errorCode !== ERR_CODE_NONE) {
    return statusForErrorCode(r.errorCode, false);
  }

  // A terminal result with no error code and a non-error status is invalid.
  // Fail closed.
  return 500;
}

// ── Header template system ───────────────────────────────────────
interface HeaderTemplate {
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
  options: IngressOptions,
): ResponseBuildContext {
  const templates = buildHeaderTemplates(options);
  const corsStatic = buildCorsStaticStrings(options.cors);
  const hstsValue = buildHstsValue(options.security ?? {});

  return { templates, corsStatic, hstsValue };
}

function buildHeaderTemplates(options: IngressOptions): HeaderTemplate[] {
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
  r: IngressFastResult,
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

function buildTerminalResponse(
  ctx: ResponseBuildContext,
  r: IngressFastResult,
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

  return new Response(payload, {
    status,
    headers,
  });
}

// ── Method mapping ───────────────────────────────────────────────
const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

// ── Header packing ───────────────────────────────────────────────
const HEADER_BUF_SIZE = 8192;

let headerBuf = new Uint8Array(HEADER_BUF_SIZE);
let headerView = new DataView(headerBuf.buffer);

const HDR_COOKIE = encoder.encode("cookie");
const HDR_ORIGIN = encoder.encode("origin");
const HDR_ACRM = encoder.encode("access-control-request-method");
const HDR_ACRH = encoder.encode("access-control-request-headers");
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
  let pos = 2;
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

      const acrh = headers.get("access-control-request-headers");
      if (acrh !== null) {
        pos = writeHeaderPair(pos, HDR_ACRH, acrh);
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

function writeHeaderPair(
  pos: number,
  name: Uint8Array,
  value: string,
): number {
  const needed = 2 + name.length + 4 + value.length * 3;

  if (pos + needed > headerBuf.length) {
    const next = new Uint8Array(Math.max(headerBuf.length * 2, pos + needed));
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

// ── Body reading ─────────────────────────────────────────────────
const bodyCache = new WeakMap<Request, Promise<Uint8Array>>();

function readRequestBodyOnce(
  req: Request,
  maxBytes: number,
  guard: boolean,
): Promise<Uint8Array> {
  if (req.body === null) {
    return Promise.resolve(EMPTY_BODY);
  }

  const existing = bodyCache.get(req);
  if (existing) {
    return existing;
  }

  const p = readBodyWithLimit(req, maxBytes, guard).catch((err) => {
    bodyCache.delete(req);
    throw err;
  });

  bodyCache.set(req, p);
  return p;
}

async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
  guard: boolean,
): Promise<Uint8Array> {
  const body = req.body;

  if (!body) {
    return EMPTY_BODY;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    if (!value) continue;

    total += value.byteLength;

    if (guard && total > maxBytes) {
      await reader.cancel().catch(() => {});

      const err = new Error("BODY_TOO_LARGE");
      (err as any).code = "BODY_TOO_LARGE";

      throw err;
    }

    chunks.push(value);
  }

  return concatUint8Arrays(chunks, total);
}

function concatUint8Arrays(
  chunks: Uint8Array[],
  total: number,
): Uint8Array {
  if (chunks.length === 0) return EMPTY_BODY;
  if (chunks.length === 1) return chunks[0]!;

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

// ── Mutable result ───────────────────────────────────────────────
class MutableIngressResult implements IngressFastResult {
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

  private _cookiesJson = "{}";
  private _queryJson = "{}";
  private _bodyJsonLen = 0;
  private _bodyJsonStart = OUT_DATA_START;
  private _buf: Uint8Array = EMPTY_BODY;

  refresh(buf: Uint8Array, body: Uint8Array, requestId: string): void {
    this._buf = buf;

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
      rawVerdict === 0 &&
      rawErrorCode === 0 &&
      rawStatus === 0 &&
      flags === 0;

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

    if (this.rateLimit > 0 || (this.flags & FLAG_RATE_LIMITED) !== 0) {
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

    this.https = (this.flags & FLAG_HTTPS) !== 0;
    this.trustedProxy = (this.flags & FLAG_TRUSTED_PROXY) !== 0;
    this.hasCookies = (this.flags & FLAG_HAS_COOKIES) !== 0;
    this.hasQuery = (this.flags & FLAG_HAS_QUERY) !== 0;
    this.bodyValidJson = (this.flags & FLAG_BODY_VALID_JSON) !== 0;
    this.schemaValid = (this.flags & FLAG_SCHEMA_VALID) !== 0;
    this.corsAllowed = (this.flags & FLAG_CORS_ALLOWED) !== 0;
    this.isPreflight = (this.flags & FLAG_IS_PREFLIGHT) !== 0;
    this.rateLimited = (this.flags & FLAG_RATE_LIMITED) !== 0;

    const safeCookiesLen =
      cookiesJsonLen > 0 && OUT_DATA_START + cookiesJsonLen <= buf.byteLength
        ? cookiesJsonLen
        : 0;

    const queryStart = OUT_DATA_START + safeCookiesLen;

    const safeQueryLen =
      queryJsonLen > 0 && queryStart + queryJsonLen <= buf.byteLength
        ? queryJsonLen
        : 0;

    if (safeCookiesLen > 0) {
      this._cookiesJson = decoder.decode(
        buf.subarray(OUT_DATA_START, OUT_DATA_START + safeCookiesLen),
      );
    } else {
      this._cookiesJson = "{}";
    }

    if (safeQueryLen > 0) {
      this._queryJson = decoder.decode(
        buf.subarray(queryStart, queryStart + safeQueryLen),
      );
    } else {
      this._queryJson = "{}";
    }

    this._bodyJsonStart = queryStart + safeQueryLen;

    this.body = body;
    this.requestId = requestId;

    this.bodyTruncated =
      (this.flags & FLAG_BODY_TRUNCATED) !== 0 ||
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

    this._cookiesJson = "{}";
    this._queryJson = "{}";
    this._bodyJsonLen = 0;
    this._bodyJsonStart = OUT_DATA_START;
    this._buf = EMPTY_BODY;
  }

  setInternalError(requestId: string): void {
    this.invalidate();
    this.requestId = requestId;
  }

  cookiesJson(): string {
    return this._cookiesJson;
  }

  queryJson(): string {
    return this._queryJson;
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

// ── Sync factory ─────────────────────────────────────────────────
export function createIngressSync(
  options: IngressOptions = {},
): SyncIngressHandler {
  const rustOptions = {
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

  const handler = new (addon as any).Ingress(rustOptions);

  if (typeof handler.handleRequestPacked !== "function") {
    throw new Error("Native Ingress handleRequestPacked() is unavailable");
  }

  const proxyEnabled =
    options.trustProxy === true || options.trustedProxies?.enabled === true;

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: proxyEnabled,
    proto: proxyEnabled && options.https === undefined,
  };

  const outputBuf = new Uint8Array(
    Math.max(
      OUT_DATA_START,
      options.outputBufferSize ?? DEFAULT_OUTPUT_BUFFER_SIZE,
    ),
  );

  const inputPacker = new IngressInputPacker();
  const result = new MutableIngressResult();

  return {
    run(req, ip, body, requestId, fn) {
      try {
        const methodKind = METHOD_KIND[req.method] ?? 7;

        const urlBytes = encoder.encode(req.url);
        const ipBytes =
          ip && ip.length > 0 ? encoder.encode(ip) : EMPTY_IP_BYTES;
        const ridBytes = requestId
          ? encoder.encode(requestId)
          : EMPTY_REQUEST_ID_BYTES;

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
          throw new Error("createIngressSync().run() callback must be synchronous.");
        }

        return out;
      } finally {
        result.invalidate();
      }
    },
  };
}

// ── Async factory ────────────────────────────────────────────────
export function createIngress(options: IngressOptions = {}): IngressHandler {
  const sync = createIngressSync(options);

  const guard = options.enableBodySizeGuard !== false;
  const max = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const wantsBody =
    options.readBody === true ||
    options.requireJsonBody === true ||
    options.schema != null ||
    (options.readBody !== false && guard);

  const responseCtx = buildResponseContext(options);

  return async function ingressAsync(
    req: Request,
    ip?: string,
  ): Promise<IngressContext> {
    const requestId =
      options.enableRequestIds === false ? "" : newRequestId();

    try {
      if (guard) {
        const rawLen = req.headers.get("content-length");
        const contentLength = Number(rawLen ?? "0");

        if (Number.isFinite(contentLength) && contentLength > max) {
          return syntheticContext(
            req,
            requestId,
            options,
            responseCtx,
            413,
            ERR_CODE_BODY_TOO_LARGE,
          );
        }
      }

      let body: Uint8Array | null = null;

      if (wantsBody && req.body !== null) {
        try {
          body = await readRequestBodyOnce(req, max, guard);
        } catch (err) {
          if ((err as any)?.code === "BODY_TOO_LARGE") {
            return syntheticContext(
              req,
              requestId,
              options,
              responseCtx,
              413,
              ERR_CODE_BODY_TOO_LARGE,
            );
          }

          throw err;
        }
      }

      return sync.run(req, ip, body, requestId, (r) => {
        const snapshot = snapshotResult(r);
        const response = buildTerminalResponse(
          responseCtx,
          snapshot,
          req,
          requestId,
        );

        return {
          ...snapshot,
          response,
        };
      });
    } catch {
      return internalContext(req, requestId, options, responseCtx);
    }
  };
}

// ── Result helpers ───────────────────────────────────────────────
function snapshotResult(r: IngressFastResult): IngressFastResult {
  const cookies = r.cookiesJson();
  const query = r.queryJson();
  const bodyJson = r.bodyJson().slice();
  const body = r.body;

  return {
    status: r.status,
    verdict: r.verdict,
    flags: r.flags,
    errorCode: r.errorCode,
    terminal: r.terminal,
    ok: r.ok,
    https: r.https,
    trustedProxy: r.trustedProxy,
    hasCookies: r.hasCookies,
    hasQuery: r.hasQuery,
    bodyValidJson: r.bodyValidJson,
    schemaValid: r.schemaValid,
    corsAllowed: r.corsAllowed,
    isPreflight: r.isPreflight,
    rateLimited: r.rateLimited,
    rateLimit: r.rateLimit,
    rateRemaining: r.rateRemaining,
    rateResetMs: r.rateResetMs,
    retryAfterMs: r.retryAfterMs,
    body,
    headerVariant: r.headerVariant,
    requestId: r.requestId,
    bodyTruncated: r.bodyTruncated,

    cookiesJson: () => cookies,
    queryJson: () => query,
    bodyJson: () => bodyJson,
  };
}

function syntheticContext(
  req: Request,
  requestId: string,
  options: IngressOptions,
  responseCtx: ResponseBuildContext,
  status: number,
  errorCode: number,
): IngressContext {
  const corsAllowed = staticCorsAllowed(options, req);
  const variant = HV_JSON | (corsAllowed ? HV_CORS_SIMPLE : 0);

  const base: IngressFastResult = {
    status,
    verdict: 1,
    flags: 0,
    errorCode,
    terminal: true,
    ok: false,
    https: options.https === true,
    trustedProxy:
      options.trustProxy === true ||
      options.trustedProxies?.enabled === true,
    hasCookies: false,
    hasQuery: false,
    bodyValidJson: false,
    schemaValid: false,
    corsAllowed,
    isPreflight: false,
    rateLimited: errorCode === ERR_CODE_RATE_LIMITED,
    rateLimit: options.rateLimit?.limit ?? 0,
    rateRemaining: 0,
    rateResetMs: 0,
    retryAfterMs: 0,
    body: EMPTY_BODY,
    headerVariant: variant,
    requestId,
    bodyTruncated: false,

    cookiesJson: () => "{}",
    queryJson: () => "{}",
    bodyJson: () => EMPTY_BODY,
  };

  return {
    ...base,
    response: buildTerminalResponse(responseCtx, base, req, requestId),
  };
}

function internalContext(
  req: Request,
  requestId: string,
  options: IngressOptions,
  responseCtx: ResponseBuildContext,
): IngressContext {
  return syntheticContext(
    req,
    requestId,
    options,
    responseCtx,
    500,
    ERR_CODE_INTERNAL,
  );
}

function newRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function staticCorsAllowed(options: IngressOptions, req: Request): boolean {
  const cors = options.cors;
  if (!cors) return false;

  const origin = req.headers.get("origin");
  if (!origin) return false;

  const list = cors.allowOrigin;

  if (!list || list.length === 0) {
    return cors.allowCredentials !== true;
  }

  if (list.includes("*")) {
    return cors.allowCredentials !== true;
  }

  return list.includes(origin);
}

// ── Error code helpers ───────────────────────────────────────────
function errorCodeName(code: number): string {
  switch (code) {
    case ERR_CODE_NONE:
      return "none";
    case ERR_CODE_CORS_PREFLIGHT:
      return "cors_preflight";
    case ERR_CODE_RATE_LIMITED:
      return "rate_limited";
    case ERR_CODE_BODY_TOO_LARGE:
      return "body_too_large";
    case ERR_CODE_INVALID_JSON:
      return "invalid_json";
    case ERR_CODE_SCHEMA_VALIDATION:
      return "schema_validation";
    case ERR_CODE_BAD_REQUEST:
      return "bad_request";
    case ERR_CODE_REQUEST_TOO_LARGE:
      return "request_too_large";
    case ERR_CODE_INTERNAL:
      return "internal";
    default:
      return "unknown";
  }
}

function errorMessage(status: number, code: number): string {
  switch (code) {
    case ERR_CODE_CORS_PREFLIGHT:
      return "CORS preflight rejected";
    case ERR_CODE_RATE_LIMITED:
      return "Too many requests";
    case ERR_CODE_BODY_TOO_LARGE:
      return "Request body too large";
    case ERR_CODE_INVALID_JSON:
      return "Invalid JSON body";
    case ERR_CODE_SCHEMA_VALIDATION:
      return "JSON schema validation failed";
    case ERR_CODE_BAD_REQUEST:
      return "Bad request";
    case ERR_CODE_REQUEST_TOO_LARGE:
      return "Request too large";
    case ERR_CODE_INTERNAL:
      return "Internal server error";
    default:
      return status >= 500 ? "Internal server error" : "Request rejected";
  }
}