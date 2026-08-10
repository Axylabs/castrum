// src/ingress/index.ts — Public ingress API (barrel + sync/async factories)
//
// All constants come from Rust via src/ingress/constants.ts.
// For maximum performance, use createIngressFast() from ./fast.ts directly.
// This module wraps createIngressFast with convenience async API (createIngress).

import { decoder } from "../shared/bytes";
import { generateRequestId } from "../shared/request-id";
import { assertSyncCallback, DEFAULT_MAX_BODY_BYTES, DEFAULT_BODY_TIMEOUT_MS, METHOD_KIND } from "./shared";
import { createIngressFast } from "./fast";
import { buildResponseContext } from "./headers/fast-templates";
import { buildTerminalResponse } from "./response/terminal";
import { snapshotResult, syntheticContext, internalContext } from "./context";
import { readRequestBodyOnce } from "./body";
import { ERR_CODE_BODY_TOO_LARGE, ERR_CODE_INTERNAL } from "./constants";
import type {
  IngressOptions,
  IngressResult,
  IngressContext,
  SyncIngressHandler,
  IngressHandler,
} from "./types";

// ── Re-export the full public ingress API ─────────────────────────
export * from "./constants";
export * from "./status";
export * from "./errors";
export * from "./handlers";
export { createIngressFast, FastIngressResult } from "./fast";
export { buildTerminalResponse } from "./response/terminal";
export { buildResponseContext, headersForResult } from "./headers/fast-templates";
export { generateRequestId } from "../shared/request-id";
export { METHOD_KIND, DEFAULT_MAX_BODY_BYTES } from "./shared";
export type { HeaderPlan } from "./shared";
export type { ResponseBuildContext, HeaderTemplate } from "./headers/fast-templates";
export type { CorsStaticStrings, CorsOptions } from "./headers/cors";
export type { SecurityHeadersOptions } from "./headers/hsts";
export type { IngressFastHandler, IngressFastOptions } from "./options";
export type {
  IngressOptions,
  IngressContext,
  SyncIngressHandler,
  IngressHandler,
} from "./types";

// ── Sync factory ─────────────────────────────────────────────────

/**
 * Synchronous convenience wrapper over `createIngressFast` (path 1).
 *
 * The callback runs on the fast-path result and MUST be synchronous. Use
 * {@link createIngress} when you want automatic body reading + error contexts.
 */
export function createIngressSync(
  options: IngressOptions = {},
): SyncIngressHandler {
  const fast = createIngressFast(options);

  return {
    run(req, ip, body, requestId, fn) {
      return fast.run(req, ip, body, requestId, (result) => {
        const out = fn(result);
        assertSyncCallback(out, "createIngressSync().run()");
        return out;
      });
    },
  };
}

// ── Async factory ────────────────────────────────────────────────

/**
 * Async ingress factory: reads the request body (size guard + deadline) and
 * returns a snapshot `IngressContext` with a terminal `Response`.
 *
 * Recommended default for serverless/edge-style `fetch` handlers. For maximum
 * throughput use `createIngressFast` / `createIngressSync` directly.
 */
export function createIngress(options: IngressOptions = {}): IngressHandler {
  const sync = createIngressSync(options);

  const guard = options.enableBodySizeGuard !== false;
  const max = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;

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
          body = await readRequestBodyOnce(req, max, guard, bodyTimeoutMs);
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
