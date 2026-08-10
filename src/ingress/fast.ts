// src/ingress/fast.ts — High-performance ingress handler (fast packed-input
// path).
//
// Thin factory module. The fast-path pipeline is decomposed into task-focused
// submodules:
//   - packing/header-packing.ts   binary header packing (zero intermediate strings)
//   - packing/input-packer.ts     packed-input buffer builder
//   - decode/fast-result.ts       FastIngressResult (zero-alloc lazy decode)
//   - headers/fast-templates.ts   header-template system
//   - response/terminal.ts        buildTerminalResponse
//   - status.ts / errors.ts / options.ts / shared.ts
//
// This module keeps `createIngressFast` and re-exports the full fast-path API
// so existing importers keep working.

import { getAddon, type IngressInstance } from "../native";
import { OUT_DATA_START } from "./constants";
import { IngressInputPacker } from "./packing/input-packer";
import { packHeaders } from "./packing/header-packing";
import {
  assertKnownIngressOptions,
  warnTrustProxyDeprecated,
} from "./options";
import { FastIngressResult } from "./decode/fast-result";
import type {
  IngressFastOptions,
  IngressFastHandler,
} from "./options";
import {
  assertSyncCallback,
  buildHeaderPlan,
  DEFAULT_MAX_BODY_BYTES,
  METHOD_KIND,
  METHOD_KIND_UNKNOWN,
  type HeaderPlan,
} from "./shared";

// ── Re-exports (back-compat: preserve fast.ts's original public surface) ──
export {
  isValidResponseStatus,
  statusForErrorCode,
  normalizeResponseStatus,
  safeTerminalStatus,
} from "./status";
export { errorCodeName, errorMessage } from "./errors";
export {
  buildResponseContext,
  headersForResult,
} from "./headers/fast-templates";
export type {
  HeaderTemplate,
  ResponseBuildContext,
} from "./headers/fast-templates";
export type { CorsStaticStrings, CorsOptions } from "./headers/cors";
export type { SecurityHeadersOptions } from "./headers/hsts";
export { FastIngressResult } from "./decode/fast-result";
export { buildTerminalResponse } from "./response/terminal";
export { DEFAULT_MAX_BODY_BYTES, METHOD_KIND } from "./shared";
export type { HeaderPlan } from "./shared";
export type { IngressFastOptions, IngressFastHandler } from "./options";
export { generateRequestId } from "../shared/request-id";

// ── Local constants ───────────────────────────────────────────
const EMPTY_BODY = new Uint8Array(0);
const DEFAULT_OUTPUT_BUFFER_SIZE = 262_144;

// ── Fast ingress factory ─────────────────────────────

/**
 * Create a fast packed-input ingress handler (path 1).
 *
 * JS packs the request headers into a binary buffer (`IngressInputPacker`) and
 * the native `Ingress.handleRequestPacked` decodes them. Responses use the
 * `{"error":{...}}` wire format with `x-ratelimit-*` headers.
 *
 * Prefer this when you want the lowest-overhead pipeline and will call `run()`
 * yourself with a **synchronous** callback. For ready-made route handlers and a
 * server builder, use `createIngressHandler` (path 2).
 */
export function createIngressFast(
  options: IngressFastOptions = {},
): IngressFastHandler {
  assertKnownIngressOptions(options);
  if (options.trustProxy === true) {
    warnTrustProxyDeprecated();
  }

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

  // Lazy: the native addon is only needed once a handler is created.
  const addon = getAddon();
  const NativeIngress = (addon as any).Ingress as new (opts: Record<string, unknown>) => IngressInstance;
  const handler = new NativeIngress(rustOptions);

  // Shared with the pre-baked handler path so cookie/cors/proxy/proto
  // extraction decisions can never silently diverge between the two paths.
  const headerPlan: HeaderPlan = buildHeaderPlan(options);

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
        const methodKind = METHOD_KIND[req.method] ?? METHOD_KIND_UNKNOWN;

        const headers = packHeaders(req, headerPlan);

        const input = inputPacker.packFromStrings(
          methodKind,
          req.url,
          ip,
          requestId,
          headers,
        );

        // handleRequestPacked returns the number of bytes it wrote; decode only
        // the written prefix (mirrors handlers.ts) so stale bytes past `written`
        // in the reused buffer can never be misread.
        const written = handler.handleRequestPacked(input, body, outputBuf);
        result.refresh(
          outputBuf.subarray(0, written),
          body ?? EMPTY_BODY,
          requestId,
        );
      } catch (err) {
        result.setInternalError(requestId);
        if (options.onError) {
          try {
            options.onError(err instanceof Error ? err : new Error(String(err)));
          } catch {
            // hook must never crash the handler
          }
        }
      }

      try {
        const out = fn(result);
        assertSyncCallback(out, "createIngressFast().run()");
        return out;
      } finally {
        result.invalidate();
      }
    },
  };
}
