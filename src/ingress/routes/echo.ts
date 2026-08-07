// src/ingress/routes/echo.ts — Pre-baked echo handler.

import type { OptimizedIngressHandler } from "../handlers";
import { resolveIp, type BakedHandlerOptions } from "./common";
import { DEFAULT_MAX_BODY_BYTES } from "../shared";
import { HV_JSON } from "../constants";
import { ERROR_BODIES } from "../response/error-bodies";

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
