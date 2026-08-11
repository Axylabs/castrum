// src/ingress/health.ts — Liveness / readiness / health probe route factories.
//
// Enterprise-grade operators need orchestrator probes (Kubernetes `livenessProbe`
// / `readinessProbe`). These factories return route handlers compatible with the
// pre-baked route spec — serve them from `createIngressServer` (Bun) or
// `createIngressServerNode` (Node):
//
//   createIngressServer({ routes: {
//     "/healthz": { read: livenessHandler() },
//     "/readyz":  { read: readinessHandler(async () => db.ping() === "ok") },
//     "/livez":   { read: healthHandler() },
//   }});
//
// The liveness probe NEVER touches dependencies (process alive? -> 200).
// The readiness probe runs the optional `check` (deps up? -> 200/503).
// The health probe is an alias of liveness (process up) plus optional check.

export interface ReadinessResult {
  status: number;
  body: string;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Liveness probe: `200 {"status":"ok"}` as long as the process is alive.
 * Never touches dependencies.
 */
export function livenessHandler() {
  return (_req: Request): Response => jsonResponse(200, { status: "ok" });
}

/**
 * Readiness probe: runs the optional async `check` (dependency readiness).
 * Returns `200 {"status":"ready"}` when the check passes (or no check is
 * given), `503 {"status":"not_ready"}` when it throws or returns false.
 */
export function readinessHandler(check?: () => boolean | Promise<boolean>) {
  return async (_req: Request): Promise<Response> => {
    if (!check) return jsonResponse(200, { status: "ready" });
    try {
      const ok = await check();
      return ok
        ? jsonResponse(200, { status: "ready" })
        : jsonResponse(503, { status: "not_ready" });
    } catch (err) {
      return jsonResponse(503, {
        status: "not_ready",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Combined health probe: liveness by default, plus an optional readiness
 * `check`. When a `check` is provided the response is 503 on failure
 * (readiness semantics), otherwise always 200.
 */
export function healthHandler(check?: () => boolean | Promise<boolean>) {
  return check ? readinessHandler(check) : livenessHandler();
}
