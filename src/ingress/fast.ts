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
  DEFAULT_MAX_BODY_BYTES,
  METHOD_KIND,
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
const encoder = new TextEncoder();
const EMPTY_BODY = new Uint8Array(0);
const EMPTY_IP_BYTES = encoder.encode("0.0.0.0");
const DEFAULT_OUTPUT_BUFFER_SIZE = 262_144;

// ── Fast ingress factory ─────────────────────────────
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
