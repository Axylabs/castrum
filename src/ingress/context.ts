// src/ingress/context.ts — Result snapshotting + synthetic/error context
// builders for the async ingress API.

import { type ResponseBuildContext } from "./headers/fast-templates";
import { buildTerminalResponse } from "./response/terminal";
import {
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_INTERNAL,
  ERR_CODE_RATE_LIMITED,
  HV_JSON,
  HV_CORS_SIMPLE,
} from "./constants";
import type {
  IngressOptions,
  IngressResult,
  IngressContext,
} from "./types";

const EMPTY_BODY = new Uint8Array(0);

/** Deep-snapshot a result so the caller can use it after `run()` returns. */
export function snapshotResult(r: IngressResult): IngressResult {
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

/** Build a synthetic (terminal) context for body-size / error short-circuits. */
export function syntheticContext(
  req: Request,
  requestId: string,
  options: IngressOptions,
  responseCtx: ResponseBuildContext,
  status: number,
  errorCode: number,
): IngressContext {
  const corsAllowed = staticCorsAllowed(options, req);
  const variant = HV_JSON | (corsAllowed ? HV_CORS_SIMPLE : 0);

  const base: IngressResult = {
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

/** Build the internal-error context (status 500). */
export function internalContext(
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

/** Statically determine whether the configured CORS policy allows `req`. */
export function staticCorsAllowed(options: IngressOptions, req: Request): boolean {
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
