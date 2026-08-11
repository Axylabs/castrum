// bench/servers/bun-server.ts — Correct Bun routing via `routes` property
import {
  PORTS,
  SECURITY_HEADERS,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  validateUserBody,
  type ApiOk,
  type ApiError,
} from "./shared";

// ── In-memory sliding-window rate limiter ──
const rateBuckets = new Map<string, { prev: number; curr: number; windowStart: number }>();

function rateLimitCheck(ip: string, now: number) {
  const limit = RATE_LIMIT_CONFIG.limit;
  const window = RATE_LIMIT_CONFIG.windowMs;
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { prev: 0, curr: 0, windowStart: now };
    rateBuckets.set(ip, bucket);
  }
  let elapsed = now - bucket.windowStart;
  if (elapsed >= window * 2) {
    bucket.prev = 0; bucket.curr = 0; bucket.windowStart = now; elapsed = 0;
  } else if (elapsed >= window) {
    bucket.prev = bucket.curr; bucket.curr = 0; bucket.windowStart += window; elapsed -= window;
  }
  const overlap = window - elapsed;
  const weighted = (bucket.prev * overlap) / window + bucket.curr;
  const reset = bucket.windowStart + window;
  if (weighted < limit) {
    bucket.curr++;
    return { allowed: true, remaining: Math.max(0, limit - Math.floor(weighted) - 1), resetMs: reset };
  }
  return { allowed: false, remaining: 0, resetMs: reset };
}

// ── CORS ──
function corsHeaders(origin: string | null, isPreflight: boolean): Record<string, string> | null {
  if (!origin || !CORS_CONFIG.allowOrigin.includes(origin as any)) return null;
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    Vary: isPreflight
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      : "Origin",
  };
  if (CORS_CONFIG.allowCredentials) h["Access-Control-Allow-Credentials"] = "true";
  if (isPreflight) {
    h["Access-Control-Allow-Methods"] = CORS_CONFIG.allowMethods.join(", ");
    h["Access-Control-Allow-Headers"] = CORS_CONFIG.allowHeaders.join(", ");
    h["Access-Control-Max-Age"] = String(CORS_CONFIG.maxAge);
  } else if (CORS_CONFIG.exposeHeaders.length > 0) {
    h["Access-Control-Expose-Headers"] = CORS_CONFIG.exposeHeaders.join(", ");
  }
  return h;
}

function buildHeaders(
  extra: Record<string, string>,
  origin: string | null,
  isPreflight = false,
): Record<string, string> {
  const cors = corsHeaders(origin, isPreflight);
  return { ...SECURITY_HEADERS, "Content-Type": "application/json", ...extra, ...(cors ?? {}) };
}

// ── Helpers ──
function getClientIp(req: Request, server: any): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    server?.requestIP?.(req)?.address ??
    "127.0.0.1"
  );
}

function parseQuery(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Convert Bun's CookieMap to a plain object */
function cookiesToRecord(cookies: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (cookies && typeof cookies.entries === "function") {
    for (const [key, value] of cookies.entries()) {
      out[key] = value;
    }
  }
  return out;
}

// ── Rate limit guard (shared across routes) ──
function checkRateLimit(req: Request, server: any): { allowed: boolean; headers: Record<string, string> } | Response {
  const ip = getClientIp(req, server);
  const now = Date.now();
  const rl = rateLimitCheck(ip, now);
  const requestId = crypto.randomUUID(); // ★ Bun native

  const rlHeaders: Record<string, string> = {
    "RateLimit-Limit": String(RATE_LIMIT_CONFIG.limit),
    "RateLimit-Remaining": String(rl.remaining),
    "RateLimit-Reset": String(Math.ceil(rl.resetMs / 1000)),
    "X-Request-Id": requestId,
  };

  if (!rl.allowed) {
    const retrySecs = Math.ceil((rl.resetMs - now) / 1000);
    return Response.json(
      { ok: false, error: { code: "rate_limited", message: "Too Many Requests", retry_after_ms: rl.resetMs - now } } satisfies ApiError,
      { status: 429, headers: buildHeaders({ ...rlHeaders, "Retry-After": String(retrySecs) }, req.headers.get("origin")) },
    );
  }

  return { allowed: true, headers: rlHeaders };
}

// ── Server with Bun's built-in `routes` ──
Bun.serve({
  port: PORTS.bun,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,

  // ★ Bun's native router — SIMD-accelerated route matching
  routes: {
    // GET /health — static response (zero-alloc after init)
    "/health": {
      GET: (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const origin = req.headers.get("origin");
        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/health",
          query: {},
          cookies: {},
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },
    },

    // /api/users — per-method handlers
    "/api/users": {
      GET: (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        // ★ req.cookies is Bun's built-in CookieMap
        const cookies = cookiesToRecord((req as any).cookies);
        const query = parseQuery(url);

        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query,
          cookies,
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      POST: async (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const url = new URL(req.url);
        const origin = req.headers.get("origin");

        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json(
            { ok: false, error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } } satisfies ApiError,
            { status: 415, headers: buildHeaders({}, origin) },
          );
        }

        // ★ Bun primitive: req.json() — no arrayBuffer + TextDecoder + JSON.parse
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return Response.json(
            { ok: false, error: { code: "invalid_json", message: "Invalid JSON body" } } satisfies ApiError,
            { status: 400, headers: buildHeaders({}, origin) },
          );
        }

        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json(
            { ok: false, error: { code: "schema_validation_failed", message: validationError } } satisfies ApiError,
            { status: 422, headers: buildHeaders({}, origin) },
          );
        }

        const cookies = cookiesToRecord((req as any).cookies);
        const query = parseQuery(url);
        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query,
          cookies,
          body: parsed,
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      // Handle PUT/PATCH via the same logic
      PUT: async (req: Request, srv: any) => {
        // Delegate to POST handler logic (same validation)
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;
        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json(
            { ok: false, error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } },
            { status: 415, headers: buildHeaders({}, origin) },
          );
        }
        let parsed: unknown;
        try { parsed = await req.json(); } catch {
          return Response.json({ ok: false, error: { code: "invalid_json", message: "Invalid JSON body" } }, { status: 400, headers: buildHeaders({}, origin) });
        }
        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json({ ok: false, error: { code: "schema_validation_failed", message: validationError } }, { status: 422, headers: buildHeaders({}, origin) });
        }
        const body: ApiOk = { ok: true, requestId: rl.headers["X-Request-Id"] ?? "", path: "/api/users", query: parseQuery(url), cookies: cookiesToRecord((req as any).cookies), body: parsed };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      PATCH: async (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;
        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json({ ok: false, error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } }, { status: 415, headers: buildHeaders({}, origin) });
        }
        let parsed: unknown;
        try { parsed = await req.json(); } catch {
          return Response.json({ ok: false, error: { code: "invalid_json", message: "Invalid JSON body" } }, { status: 400, headers: buildHeaders({}, origin) });
        }
        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json({ ok: false, error: { code: "schema_validation_failed", message: validationError } }, { status: 422, headers: buildHeaders({}, origin) });
        }
        const body: ApiOk = { ok: true, requestId: rl.headers["X-Request-Id"] ?? "", path: "/api/users", query: parseQuery(url), cookies: cookiesToRecord((req as any).cookies), body: parsed };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      // CORS preflight
      OPTIONS: (req: Request) => {
        const origin = req.headers.get("origin");
        const cors = corsHeaders(origin, true);
        if (!cors) {
          return Response.json(
            { ok: false, error: { code: "cors_not_allowed", message: "CORS preflight not allowed" } },
            { status: 403, headers: SECURITY_HEADERS },
          );
        }
        return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
      },
    },

    // POST /api/echo — stream body directly
    "/api/echo": {
      POST: (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const origin = req.headers.get("origin");
        const requestedContentType = req.headers.get("content-type") ?? "application/octet-stream";

        // ★ Stream req.body directly — zero buffering for echo
        return new Response(req.body, {
          status: 200,
          headers: buildHeaders({ ...rl.headers, "Content-Type": requestedContentType }, origin),
        });
      },
    },

    // GET /api/cookies — uses Bun's built-in req.cookies
    "/api/cookies": {
      GET: (req: Request, srv: any) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const origin = req.headers.get("origin");
        // ★ Bun's built-in CookieMap — no manual parsing, no cookie-es
        const cookies = cookiesToRecord((req as any).cookies);

        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/cookies",
          query: {},
          cookies,
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },
    },
  },

  // ★ Fallback for unmatched routes (404)
  fetch(req: Request) {
    const url = new URL(req.url);
    return Response.json(
      { ok: false, error: { code: "not_found", message: `Route ${req.method} ${url.pathname} not found` } } satisfies ApiError,
      { status: 404, headers: buildHeaders({}, req.headers.get("origin")) },
    );
  },
});

console.log(`[bun] listening on :${PORTS.bun} (Bun.serve routes)`);