// src/ingress/routes/json-write.ts — Pre-baked JSON-write handler
// (POST/PUT/PATCH).

import type { OptimizedIngressHandler } from "../handlers";
import { resolveIp, type BakedHandlerOptions } from "./common";
import { DEFAULT_MAX_BODY_BYTES } from "../shared";
import { readBodyWithLimit } from "../body";

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
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? 0;

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
      // Stream-read with the limit enforced WHILE reading — a body that
      // exceeds maxBodyBytes is rejected as soon as the limit is crossed,
      // never fully buffered first.
      bodyBytes = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const isTooLarge = code === "BODY_TOO_LARGE";
      return fallback.run(req, ip, null, (result, ctx) => {
        const terminal = fallback.terminalResponse(req, result, ctx);
        if (terminal) return terminal;

        return fallback.errorResponse(
          req,
          result,
          isTooLarge ? 413 : 408,
          isTooLarge ? "body_too_large" : "request_timeout",
          isTooLarge ? "Request body is too large" : "Request body read timed out",
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

      const init: ResponseInit = {
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
      };

      return copyBody
        ? new Response(result.bodyJson(true), init)
        : ingress.zeroCopyResponse(result, ctx, init);
    });
  };
}
