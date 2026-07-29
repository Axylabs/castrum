// src/ingress/index.ts — Public ingress API
//
// All constants come from Rust via src/ingress/constants.ts.
// For maximum performance, use createIngressFast() from ./fast.ts directly.
// This module wraps createIngressFast with convenience async API (createIngress).

import addon from "../native";
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
import {
  createIngressFast,
  FastIngressResult,
  buildResponseContext,
  buildTerminalResponse,
  headersForResult,
  safeTerminalStatus,
  statusForErrorCode,
  isValidResponseStatus,
  normalizeResponseStatus,
  errorCodeName,
  errorMessage,
  type IngressFastOptions,
  type IngressFastHandler,
  type ResponseBuildContext,
  type HeaderTemplate,
  type CorsStaticStrings,
  type SecurityHeadersOptions,
  type CorsOptions,
  generateRequestId,
} from "./fast";

// ── Re-export types from constants ──────────────────────────────
export {
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
};

// ── Public option types ──────────────────────────────────────────
export type { SecurityHeadersOptions, CorsOptions };

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

export interface IngressOptions extends IngressFastOptions {
  enableRequestIds?: boolean;
}

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

// ── HTTP status helpers (re-exported from fast.ts) ──────────────
export { isValidResponseStatus, statusForErrorCode, normalizeResponseStatus, safeTerminalStatus };

// ── Header template system (re-exported from fast.ts) ────────────
export { buildResponseContext, headersForResult };
export type { ResponseBuildContext, HeaderTemplate, CorsStaticStrings };

// ── Constants ────────────────────────────────────────────────────
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EMPTY_BODY = new Uint8Array(0);

// ── Sync factory ─────────────────────────────────────────────────
export function createIngressSync(
  options: IngressOptions = {},
): SyncIngressHandler {
  const fast = createIngressFast(options);

  return {
    run(req, ip, body, requestId, fn) {
      return fast.run(req, ip, body, requestId, (result) => {
        const out = fn(result);

        if (
          out !== null &&
          (typeof out === "object" || typeof out === "function") &&
          typeof (out as any).then === "function"
        ) {
          throw new Error("createIngressSync().run() callback must be synchronous.");
        }

        return out;
      });
    },
  };
}

// ── Body reading helpers (used by async API) ────────────────────
function readRequestBodyOnce(
  req: Request,
  maxBytes: number,
  guard: boolean,
): Promise<Uint8Array> {
  if (req.body === null) {
    return Promise.resolve(EMPTY_BODY);
  }

  return readBodyWithLimit(req, maxBytes, guard);
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
      options.enableRequestIds === false ? "" : decoder.decode(generateRequestId());

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

// ── Re-export fast.ts API for direct use ─────────────────────────
export { createIngressFast, FastIngressResult, generateRequestId };
export type { IngressFastHandler, IngressFastOptions };