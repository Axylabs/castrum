// bench/servers/bun-server.ts

import {
  PORTS,
  SECURITY_HEADERS,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  jsonBytes,
  parseCookies,
  parseQuery,
  validateUserBody,
  nextRequestId,
  type ApiOk,
  type ApiError,
} from "./shared";

// ── In-memory sliding-window rate limiter (same algorithm for all servers) ──
const rateBuckets = new Map<string, { prev: number; curr: number; windowStart: number }>();

function rateLimitCheck(ip: string, now: number): { allowed: boolean; remaining: number; resetMs: number } {
  const limit = RATE_LIMIT_CONFIG.limit;
  const window = RATE_LIMIT_CONFIG.windowMs;
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { prev: 0, curr: 0, windowStart: now };
    rateBuckets.set(ip, bucket);
  }
  let elapsed = now - bucket.windowStart;
  if (elapsed >= window * 2) {
    bucket.prev = 0;
    bucket.curr = 0;
    bucket.windowStart = now;
    elapsed = 0;
  } else if (elapsed >= window) {
    bucket.prev = bucket.curr;
    bucket.curr = 0;
    bucket.windowStart += window;
    elapsed -= window;
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

// ── CORS evaluation ──
function corsHeaders(origin: string | null, method: string, isPreflight: boolean): Record<string, string> | null {
  if (!origin) return null;
  const allowed = CORS_CONFIG.allowOrigin.includes(origin as any);
  if (!allowed) return null;
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    Vary: isPreflight
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      : "Origin",
  };
  if (CORS_CONFIG.allowCredentials) {
    h["Access-Control-Allow-Credentials"] = "true";
  }
  if (isPreflight) {
    h["Access-Control-Allow-Methods"] = CORS_CONFIG.allowMethods.join(", ");
    h["Access-Control-Allow-Headers"] = CORS_CONFIG.allowHeaders.join(", ");
    h["Access-Control-Max-Age"] = String(CORS_CONFIG.maxAge);
  } else if (CORS_CONFIG.exposeHeaders.length > 0) {
    h["Access-Control-Expose-Headers"] = CORS_CONFIG.exposeHeaders.join(", ");
  }
  return h;
}

function buildResponseHeaders(
  status: number,
  extra: Record<string, string>,
  origin: string | null,
  method: string,
  isPreflight: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    ...extra,
  };
  const cors = corsHeaders(origin, method, isPreflight);
  if (cors) Object.assign(headers, cors);
  return headers;
}

function errorResponse(status: number, code: string, message: string, origin: string | null, method: string): Response {
  const body: ApiError = { ok: false, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: buildResponseHeaders(status, {}, origin, method, false),
  });
}

// ── Server ──
const server = Bun.serve({
  port: PORTS.bun,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,

 async fetch(req: Request):  Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const origin = req.headers.get("origin");
    const requestId = nextRequestId();
    const now = Date.now();

    // ── CORS preflight short-circuit ──
    if (method === "OPTIONS" && req.headers.get("access-control-request-method")) {
      const cors = corsHeaders(origin, method, true);
      if (!cors) {
        return errorResponse(403, "cors_not_allowed", "CORS preflight not allowed", origin, method);
      }
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...cors, "X-Request-Id": requestId },
      });
    }

    // ── Rate limiting ──
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "127.0.0.1";
    const rl = rateLimitCheck(ip, now);
    const rlHeaders: Record<string, string> = {
      "RateLimit-Limit": String(RATE_LIMIT_CONFIG.limit),
      "RateLimit-Remaining": String(rl.remaining),
      "RateLimit-Reset": String(Math.ceil(rl.resetMs / 1000)),
      "X-Request-Id": requestId,
    };
    if (!rl.allowed) {
      const retrySecs = Math.ceil((rl.resetMs - now) / 1000);
      return new Response(
        JSON.stringify({ ok: false, error: { code: "rate_limited", message: "Too Many Requests", retry_after_ms: rl.resetMs - now } }),
        {
          status: 429,
          headers: buildResponseHeaders(429, { ...rlHeaders, "Retry-After": String(retrySecs) }, origin, method, false),
        },
      );
    }

    // ── Routes ──
    try {
      // GET /health
      if (path === "/health" && method === "GET") {
        const body: ApiOk = { ok: true, requestId, path, query: {}, cookies: {} };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: buildResponseHeaders(200, rlHeaders, origin, method, false),
        });
      }

      // GET /api/users  (query + cookie parsing)
      if (path === "/api/users" && method === "GET") {
        const query = parseQuery(url);
        const cookies = parseCookies(req.headers.get("cookie"));
        const body: ApiOk = { ok: true, requestId, path, query, cookies };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: buildResponseHeaders(200, rlHeaders, origin, method, false),
        });
      }

      // POST /api/users  (JSON body + schema validation)
      if (path === "/api/users" && (method === "POST" || method === "PUT" || method === "PATCH")) {
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return errorResponse(415, "unsupported_media_type", "Content-Type must be application/json", origin, method);
        }
        const rawBody = await req.arrayBuffer();
        if (rawBody.byteLength > MAX_BODY_BYTES) {
          return errorResponse(413, "body_too_large", "Request body is too large", origin, method);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(rawBody));
        } catch {
          return errorResponse(400, "invalid_json", "Invalid JSON body", origin, method);
        }
        const validationError = validateUserBody(parsed);
        if (validationError) {
          return errorResponse(422, "schema_validation_failed", validationError, origin, method);
        }
        const query = parseQuery(url);
        const cookies = parseCookies(req.headers.get("cookie"));
        const body: ApiOk = { ok: true, requestId, path, query, cookies, body: parsed };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: buildResponseHeaders(200, rlHeaders, origin, method, false),
        });
      }

      // POST /api/echo  (large body echo)
      if (path === "/api/echo" && method === "POST") {
        const rawBody = await req.arrayBuffer();
        if (rawBody.byteLength > MAX_BODY_BYTES) {
          return errorResponse(413, "body_too_large", "Request body is too large", origin, method);
        }
        return new Response(rawBody, {
          status: 200,
          headers: buildResponseHeaders(200, { ...rlHeaders, "Content-Type": req.headers.get("content-type") ?? "application/octet-stream" }, origin, method, false),
        });
      }

      // GET /api/cookies  (cookie-heavy)
      if (path === "/api/cookies" && method === "GET") {
        const cookies = parseCookies(req.headers.get("cookie"));
        const body: ApiOk = { ok: true, requestId, path, query: {}, cookies };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: buildResponseHeaders(200, rlHeaders, origin, method, false),
        });
      }

      // 404
      return errorResponse(404, "not_found", `Route ${method} ${path} not found`, origin, method);
    } catch (err) {
      return errorResponse(500, "internal_error", String(err), origin, method);
    }
  },
});

console.log(`[bun] listening on :${PORTS.bun}`);