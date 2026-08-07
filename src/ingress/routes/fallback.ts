// src/ingress/routes/fallback.ts — Pre-baked fallback handler.

import type { OptimizedIngressHandler } from "../handlers";
import { resolveIp, type BakedHandlerOptions } from "./common";

/**
 * Pre-baked fallback handler: 404 for unmatched routes / OPTIONS.
 */
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
