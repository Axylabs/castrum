// src/ingress/routes/read.ts — Pre-baked GET read handler.

import type { OptimizedIngressHandler } from "../types";
import { resolveIp, type BakedHandlerOptions } from "./common";

/**
 * Pre-baked GET read handler: returns the ingress body JSON on success.
 */
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
}
