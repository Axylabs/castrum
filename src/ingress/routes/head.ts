// src/ingress/routes/head.ts — Pre-baked HEAD read handler.

import type { OptimizedIngressHandler } from "../handlers";
import { resolveIp, type BakedHandlerOptions } from "./common";

/**
 * Pre-baked HEAD read handler: headers only, no body.
 */
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
