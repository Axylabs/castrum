// src/ingress/handlers.ts — Pre-baked ingress handler functions
//
// A ready-to-use convenience layer for consuming the optimized ingress pipeline
// (native Ingress.handleRequestFullSync) with zero boilerplate. Any system can
// wire up ingress in a few lines:
//
//   import {
//     createIngressHandler, readHandler, jsonWriteHandler,
//     echoHandler, fallbackHandler, createIngressServer,
//   } from "./index";
//
//   const ingress = createIngressHandler({
//     parseCookies: true,
//     parseQuery: true,
//     cors: { allowOrigin: ["https://app.example.com"] },
//   });
//
//   // Route handlers — runtime-agnostic, work with any fetch-style server:
//   const routes = {
//     "/health": { GET: readHandler(ingress) },
//     "/api/x":  { GET: readHandler(ingress), POST: jsonWriteHandler(ingress) },
//   };
//
//   // Or the full Bun.serve builder:
//   createIngressServer({ port: 3000, routes: { "/health": { read: ingress } } });
//
// This module deliberately keeps the benchmark's wire format ({"ok":false,
// "error":{...}} bodies, `ratelimit-*` headers). It does NOT reuse fast.ts's
// response builders because those emit a different payload shape.

import addon from "../native";
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
  ERR_CODE_CORS_PREFLIGHT as ERROR_CODE_CORS_PREFLIGHT,
  ERR_CODE_RATE_LIMITED as ERROR_CODE_RATE_LIMITED,
  ERR_CODE_BODY_TOO_LARGE as ERROR_CODE_BODY_TOO_LARGE,
  ERR_CODE_INVALID_JSON as ERROR_CODE_INVALID_JSON,
  ERR_CODE_SCHEMA_VALIDATION as ERROR_CODE_SCHEMA_VALIDATION,
  ERR_CODE_BAD_REQUEST as ERROR_CODE_BAD_REQUEST,
  ERR_CODE_REQUEST_TOO_LARGE as ERROR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_INTERNAL as ERROR_CODE_INTERNAL,
} from "./constants";
import {
  METHOD_KIND,
  generateRequestId,
  safeTerminalStatus,
  DEFAULT_MAX_BODY_BYTES,
  type HeaderPlan,
} from "./fast";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY_BODY = new Uint8Array(0);
const EMPTY_IP = "0.0.0.0";

/** Sentinel value used by Rust to mean "rate limiting disabled". */
export const RATE_LIMIT_U32_MAX = 4_294_967_295;

const DEFAULT_OUTPUT_BUF_SIZE = 131_072;

const MAX_COOKIE_HEADER_BYTES = 8192;
const MAX_SMALL_HEADER_BYTES = 2048;
const MAX_XFF_HEADER_BYTES = 8192;

// ── Static error bodies ──
function staticErrorBody(code: string, message: string): Uint8Array {
  return encoder.encode(
    `{"ok":false,"error":{"code":"${code}","message":"${message}"}}`,
  );
}

export const ERROR_BODIES: Record<string, Uint8Array> = {
  not_found: staticErrorBody("not_found", "Not found"),
  unsupported_media_type: staticErrorBody(
    "unsupported_media_type",
    "Content-Type must be application/json",
  ),
  body_too_large: staticErrorBody("body_too_large", "Request body is too large"),
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

// ── Zero-alloc result wrapper ──
export class BakedIngressResult {
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

// ── Types ────────────────────────────────────────────────────────
export interface BakedContext {
  requestIdHeader: string | null;
  origin: string | null;
}

export interface BakedIngressRuntime {
  /** Emit an `x-request-id` header on responses. Default: false. */
  emitRequestIdHeader?: boolean;
  /** Enable security headers on responses. Default: true. */
  enableSecurityHeaders?: boolean;
  /** Ordered `[name, value]` security headers (names are lowercased). */
  securityHeaders?: ReadonlyArray<[string, string]>;
  /** Native output buffer size in bytes. Default: 131072. */
  outputBufferSize?: number;
  /** Invoked after a Response is produced (for metrics/logging hooks). */
  onResponse?: (
    req: Request,
    result: BakedIngressResult,
    status: number,
    requestId: string,
  ) => void;
}

/**
 * An optimized ingress handler. `run()` is the zero-alloc pipeline entry
 * point; the response-builder methods are pre-baked and bound to this
 * handler's configuration, so consumers can build custom routes without
 * touching header templates or error bodies.
 */
export interface OptimizedIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T;

  responseHeaders(
    variant: number,
    requestIdHeader: string | null,
    origin: string | null,
    rateRemaining?: number,
    rateResetSecs?: number,
    retryAfterSecs?: number,
  ): [string, string][];

  terminalHeaders(
    variant: number,
    ctx: BakedContext,
    result: BakedIngressResult | null,
  ): [string, string][];

  terminalResponse(
    req: Request,
    result: BakedIngressResult,
    ctx: BakedContext,
  ): Response | null;

  errorResponse(
    req: Request,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response;

  internalErrorResponse(ctx: BakedContext, result?: BakedIngressResult): Response;

  withContentType(
    headers: ReadonlyArray<[string, string]>,
    contentType: string,
  ): [string, string][];
}

// ── Optimized ingress factory ─────────────────────────────────────
export function createIngressHandler(
  options: Record<string, unknown>,
  runtime: BakedIngressRuntime = {},
): OptimizedIngressHandler {
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
  const rateLimit = options.rateLimit as { limit?: number } | undefined;
  const limit = rateLimit?.limit;
  const rateEnabled =
    typeof limit === "number" && limit !== RATE_LIMIT_U32_MAX && limit > 0;

  const headerPlan: HeaderPlan = {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust && rateEnabled,
    proto: trust && options.https === undefined,
  };

  const emitRequestIdHeader = runtime.emitRequestIdHeader === true;
  const outputBufferSize = runtime.outputBufferSize ?? DEFAULT_OUTPUT_BUF_SIZE;

  // ── Variant-indexed header templates (precomputed once) ──
  const cors = options.cors as
    | {
        allowOrigin?: string[];
        allowMethods?: string[];
        allowHeaders?: string[];
        exposeHeaders?: string[];
        allowCredentials?: boolean;
        maxAge?: number;
      }
    | undefined;

  const securityEntries: ReadonlyArray<[string, string]> =
    runtime.enableSecurityHeaders === false
      ? Object.freeze([] as [string, string][])
      : Object.freeze(
          (runtime.securityHeaders ?? []).map(
            ([k, v]) => [k.toLowerCase(), v] as [string, string],
          ),
        );

  const corsAllowMethods = cors?.allowMethods?.join(", ") ?? "";
  const corsAllowHeaders = cors?.allowHeaders?.join(", ") ?? "";
  const corsExposeHeaders = cors?.exposeHeaders?.join(", ") ?? "";
  const corsMaxAge = cors?.maxAge != null ? String(cors.maxAge) : "";
  const rateLimitStr = rateEnabled ? String(limit) : "";

  const headerTemplates: ReadonlyArray<ReadonlyArray<[string, string]>> =
    Object.freeze(
      Array.from({ length: 32 }, (_, variant) => {
        const entries: [string, string][] = [...securityEntries];

        if ((variant & HV_JSON) !== 0) {
          entries.push(["content-type", "application/json"]);
        }

        if ((variant & HV_CORS_SIMPLE) !== 0) {
          entries.push(["vary", "Origin"]);
          if (cors?.allowCredentials) {
            entries.push(["access-control-allow-credentials", "true"]);
          }
          if (corsExposeHeaders.length > 0) {
            entries.push(["access-control-expose-headers", corsExposeHeaders]);
          }
        }

        if ((variant & HV_CORS_PREFLIGHT) !== 0) {
          entries.push([
            "vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
          ]);
          if (cors?.allowCredentials) {
            entries.push(["access-control-allow-credentials", "true"]);
          }
          entries.push(["access-control-allow-methods", corsAllowMethods]);
          entries.push(["access-control-allow-headers", corsAllowHeaders]);
          entries.push(["access-control-max-age", corsMaxAge]);
        }

        if ((variant & HV_RATE_ACTIVE) !== 0) {
          entries.push(["ratelimit-limit", rateLimitStr]);
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
      headerTemplates[variant & 31] ?? headerTemplates[0] ?? [];

    const needsRequestId = emitRequestIdHeader && requestIdHeader !== null;
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
    ctx: BakedContext,
    result: BakedIngressResult | null,
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

  function terminalResponse(
    _req: Request,
    result: BakedIngressResult,
    ctx: BakedContext,
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
        : (ERROR_CODE_BODIES[result.errorCode] ?? ERROR_BODIES.internal!);

    return new Response(body, {
      status,
      headers: terminalHeaders(result.headerVariant, ctx, result),
    });
  }

  function errorResponse(
    _req: Request,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response {
    const body =
      ERROR_BODIES[code] ??
      encoder.encode(JSON.stringify({ ok: false, error: { code, message } }));

    return new Response(body, {
      status,
      headers: terminalHeaders(result?.headerVariant ?? HV_JSON, ctx, result),
    });
  }

  function internalErrorResponse(
    ctx: BakedContext,
    result?: BakedIngressResult,
  ): Response {
    return new Response(ERROR_BODIES.internal, {
      status: 500,
      headers: terminalHeaders(
        result?.headerVariant ?? HV_JSON,
        ctx,
        result ?? null,
      ),
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

  const result = new BakedIngressResult();
  const ctx: BakedContext = {
    requestIdHeader: null,
    origin: null,
  };

  function run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T {
    const methodKind = METHOD_KIND[req.method] ?? 7;
    const ridBytes = generateRequestId();
    const requestIdStr = decoder.decode(ridBytes);

    ctx.requestIdHeader = emitRequestIdHeader ? requestIdStr : null;
    ctx.origin = headerPlan.cors ? req.headers.get("origin") : null;

    // Gather raw headers as [name, value][] — no binary packing in JS.
    // handleRequestFullSync packs them internally in Rust synchronously,
    // eliminating both JS-side encoding and async overhead.
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
      const outputBuf = handler.handleRequestFullSync(
        methodKind,
        req.url,
        ipStr,
        requestIdStr,
        headers,
        body,
        outputBufferSize,
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
        runtime.onResponse?.(req, result, out.status, requestIdStr);
      }
      return out;
    } finally {
      result.invalidate();
      ctx.requestIdHeader = null;
      ctx.origin = null;
    }
  }

  return {
    run,
    responseHeaders,
    terminalHeaders,
    terminalResponse,
    errorResponse,
    internalErrorResponse,
    withContentType,
  };
}

// ── Route-handler factories ───────────────────────────────────────
export interface BakedHandlerOptions {
  /** Resolve the client IP from the server object (e.g. `srv.requestIP`). */
  getIp?: (req: Request, srv: unknown) => string | undefined;
  /** Copy body slices instead of sharing the native buffer. Default: true (safe). */
  copyBody?: boolean;
  /** Maximum request body bytes for write/echo handlers. Default: 1 MiB. */
  maxBodyBytes?: number;
  /** Fallback handler used for write error paths. Defaults to the write ingress. */
  fallback?: OptimizedIngressHandler;
}

function resolveIp(
  req: Request,
  srv: unknown,
  opts: BakedHandlerOptions,
): string | undefined {
  return opts.getIp ? opts.getIp(req, srv) : undefined;
}

/** Pre-baked GET read handler: returns the ingress body JSON on success. */
export function readHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  const copyBody = opts.copyBody !== false;

  return (req, srv) =>
    ingress.run<Response>(req, resolveIp(req, srv, opts), null, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      if (result.bodyTruncated) {
        return ingress.internalErrorResponse(ctx, result);
      }

      return new Response(result.bodyJson(copyBody), {
        status: 200,
        headers: ingress.responseHeaders(
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

/** Pre-baked HEAD read handler: headers only, no body. */
export function headHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  return (req, srv) =>
    ingress.run<Response>(req, resolveIp(req, srv, opts), null, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      if (result.bodyTruncated) {
        return ingress.internalErrorResponse(ctx, result);
      }

      return new Response(null, {
        status: 200,
        headers: ingress.responseHeaders(
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

/**
 * Pre-baked JSON-write handler (POST/PUT/PATCH): enforces Content-Type,
 * content-length/body-size limits, JSON validity and (optionally) schema
 * validation, then returns the ingress body JSON on success.
 */
export function jsonWriteHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Promise<Response> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fallback = opts.fallback ?? ingress;
  const copyBody = opts.copyBody !== false;

  return async (req, srv) => {
    const ip = resolveIp(req, srv, opts);

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx);
        if (terminal) return terminal;

        return fallback.errorResponse(
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

    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx);
        if (terminal) return terminal;

        return fallback.errorResponse(
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
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx);
        if (terminal) return terminal;

        return fallback.errorResponse(
          req,
          result,
          400,
          "bad_request",
          "Unable to read request body",
          ctx,
        );
      });
    }

    if (bodyBytes.byteLength > maxBodyBytes) {
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx);
        if (terminal) return terminal;

        return fallback.errorResponse(
          req,
          result,
          413,
          "body_too_large",
          "Request body is too large",
          ctx,
        );
      });
    }

    return ingress.run(req, ip, bodyBytes, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      if (result.bodyTruncated) {
        return ingress.internalErrorResponse(ctx, result);
      }

      if (!result.bodyValidJson) {
        return ingress.errorResponse(
          req,
          result,
          400,
          "invalid_json",
          "Invalid JSON body",
          ctx,
        );
      }

      if (!result.schemaValid) {
        return ingress.errorResponse(
          req,
          result,
          422,
          "schema_validation_failed",
          "Request body failed schema validation",
          ctx,
        );
      }

      return new Response(result.bodyJson(copyBody), {
        status: 200,
        headers: ingress.responseHeaders(
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
  };
}

/**
 * Pre-baked echo handler: streams the request body back with the client's
 * Content-Type, bounded by `maxBodyBytes`.
 */
export function echoHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Promise<Response> {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req, srv) => {
    const ip = resolveIp(req, srv, opts);

    const prep = ingress.run<{
      terminal?: Response;
      headers?: ReadonlyArray<[string, string]>;
    }>(req, ip, null, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return { terminal };

      if (result.bodyTruncated) {
        return { terminal: ingress.internalErrorResponse(ctx, result) };
      }

      const hv = result.headerVariant & ~HV_JSON;

      return {
        headers: ingress.responseHeaders(
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

    const baseHeaders: ReadonlyArray<[string, string]> = prep.headers ?? [];

    const requestedContentType =
      req.headers.get("content-type") ?? "application/octet-stream";

    const contentLengthHeader = req.headers.get("content-length");
    const contentLength =
      contentLengthHeader === null ? NaN : Number(contentLengthHeader);

    if (Number.isFinite(contentLength)) {
      if (contentLength > maxBodyBytes) {
        return new Response(ERROR_BODIES.body_too_large, {
          status: 413,
          headers: ingress.withContentType(baseHeaders, "application/json"),
        });
      }

      if (contentLength <= 0 || req.body === null) {
        return new Response(null, {
          status: 200,
          headers: ingress.withContentType(baseHeaders, requestedContentType),
        });
      }

      return new Response(req.body, {
        status: 200,
        headers: ingress.withContentType(baseHeaders, requestedContentType),
      });
    }

    try {
      const bodyBytes = new Uint8Array(await req.arrayBuffer());

      if (bodyBytes.byteLength > maxBodyBytes) {
        return new Response(ERROR_BODIES.body_too_large, {
          status: 413,
          headers: ingress.withContentType(baseHeaders, "application/json"),
        });
      }

      return new Response(bodyBytes.byteLength > 0 ? bodyBytes : null, {
        status: 200,
        headers: ingress.withContentType(baseHeaders, requestedContentType),
      });
    } catch {
      return new Response(ERROR_BODIES.bad_request, {
        status: 400,
        headers: ingress.withContentType(baseHeaders, "application/json"),
      });
    }
  };
}

/** Pre-baked fallback handler: 404 for unmatched routes / OPTIONS. */
export function fallbackHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  return (req, srv) =>
    ingress.run<Response>(req, resolveIp(req, srv, opts), null, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return ingress.errorResponse(
        req,
        result,
        404,
        "not_found",
        "Not found",
        ctx,
      );
    });
}

// ── Bun.serve builder ─────────────────────────────────────────────
export interface BakedRoute {
  /** Wires GET + HEAD read handlers. */
  read?: OptimizedIngressHandler;
  /** Wires POST/PUT/PATCH JSON-write handlers (and OPTIONS fallback). */
  write?: OptimizedIngressHandler;
  /** Wires a POST echo handler. */
  echo?: OptimizedIngressHandler;
  /** Wires a GET read handler (cookies-style route). */
  cookies?: OptimizedIngressHandler;
  /** Overrides `maxBodyBytes` for this route's write/echo handlers. */
  maxBodyBytes?: number;
}

export interface CreateIngressServerOptions {
  port: number;
  hostname?: string;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  reusePort?: boolean;
  copyBody?: boolean;
  getIp?: (req: Request, srv: unknown) => string | undefined;
  routes: Record<string, BakedRoute>;
  fallback?: OptimizedIngressHandler;
}

export interface BakedServer {
  server: ReturnType<typeof Bun.serve>;
  stop(): void;
  port: number;
}

/** Build a Bun.serve config from pre-baked route handlers. */
export function createIngressServer(
  options: CreateIngressServerOptions,
): BakedServer {
  const baseOpts: BakedHandlerOptions = {
    getIp: options.getIp,
    copyBody: options.copyBody,
  };

  const serverRoutes: Record<string, Record<string, unknown>> = {};

  for (const [path, spec] of Object.entries(options.routes)) {
    const routeOpts: BakedHandlerOptions = {
      ...baseOpts,
      maxBodyBytes: spec.maxBodyBytes,
    };
    const methods: Record<string, unknown> = {};

    if (spec.read) {
      methods.GET = readHandler(spec.read, routeOpts);
      methods.HEAD = headHandler(spec.read, routeOpts);
    }

    if (spec.write) {
      const writeOpts: BakedHandlerOptions = {
        ...routeOpts,
        fallback: options.fallback ?? spec.write,
      };
      methods.POST = jsonWriteHandler(spec.write, writeOpts);
      methods.PUT = jsonWriteHandler(spec.write, writeOpts);
      methods.PATCH = jsonWriteHandler(spec.write, writeOpts);
      if (options.fallback) {
        methods.OPTIONS = fallbackHandler(options.fallback, routeOpts);
      }
    }

    if (spec.echo) {
      methods.POST = echoHandler(spec.echo, routeOpts);
    }

    if (spec.cookies) {
      methods.GET = readHandler(spec.cookies, routeOpts);
    }

    serverRoutes[path] = methods;
  }

  const serverOptions: Record<string, unknown> = {
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    idleTimeout: options.idleTimeout ?? 30,
    routes: serverRoutes,
  };

  if (options.maxRequestBodySize !== undefined) {
    serverOptions.maxRequestBodySize = options.maxRequestBodySize;
  }
  if (options.reusePort) {
    serverOptions.reusePort = true;
  }
  if (options.fallback) {
    serverOptions.fetch = fallbackHandler(options.fallback, baseOpts);
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve(serverOptions as any);
  } catch (err) {
    if (options.reusePort) {
      delete serverOptions.reusePort;
      server = Bun.serve(serverOptions as any);
    } else {
      throw err;
    }
  }

  return {
    server,
    stop: () => {
      try {
        server.stop(true);
      } catch {
        // already stopped
      }
    },
    port: options.port,
  };
}
