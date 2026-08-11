// src/ingress/routes/options.ts — Pre-baked OPTIONS handler (CORS preflight).

import type { OptimizedIngressHandler } from "../types";
import { resolveIp, type BakedHandlerOptions } from "./common";
import { secondsFromMs } from "../shared";

/**
 * Pre-baked OPTIONS handler: serves the native pipeline's CORS preflight
 * decision — 204 when the preflight is allowed, 403 (terminal) when denied —
 * and a plain 204 for non-preflight OPTIONS.
 *
 * `createIngressServer` wires this for EVERY route that has a handler, so
 * read-only routes also answer preflights (previously OPTIONS only reached the
 * pipeline on write routes that also configured a fallback).
 */
export function optionsHandler(
  ingress: OptimizedIngressHandler,
  opts: BakedHandlerOptions = {},
): (req: Request, srv?: unknown) => Response {
  return (req, srv) =>
    ingress.run<Response>(req, resolveIp(req, srv, opts), null, (result, ctx) => {
      const terminal = ingress.terminalResponse(req, result, ctx);
      if (terminal) return terminal;

      return new Response(null, {
        status: 204,
        headers: ingress.responseHeaders(
          result.headerVariant,
          ctx.requestIdHeader,
          ctx.origin,
          result.rateRemaining,
          result.rateResetMs > 0
            ? secondsFromMs(result.rateResetMs)
            : undefined,
        ),
      });
    });
}
