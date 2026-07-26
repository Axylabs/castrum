// bench/servers/ingress-server.ts — OPTIMIZED FOR BUN 1.4
import {
  createIngress,
  type IngressOptions,
  type IngressResultLazy,
} from "../../src/ingress";
import {
  PORTS,
  USER_SCHEMA_BYTES,
  CORS_CONFIG,
  RATE_LIMIT_CONFIG,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  type ApiOk,
} from "./shared";

const decoder = new TextDecoder();

// Pre-frozen static headers — no per-request object spread
const STATIC_SECURITY_HEADERS = Object.freeze({ ...SECURITY_HEADERS });

const commonOptions: IngressOptions = {
  trustProxy: true,
  parseCookies: true,
  parseQuery: true,
  requireJsonBody: false,
  https: true,
  maxBodyBytes: MAX_BODY_BYTES,
  enableSecurityHeaders: false, // Added in JS below
  enableRequestIds: true,
  enableCacheKey: false,
  enablePathQuery: false, // JS extracts path from req.url directly
  enableBodySizeGuard: true,
  readBody: true,
  cors: {
    allowOrigin: [...CORS_CONFIG.allowOrigin],
    allowMethods: [...CORS_CONFIG.allowMethods],
    allowHeaders: [...CORS_CONFIG.allowHeaders],
    exposeHeaders: [...CORS_CONFIG.exposeHeaders],
    allowCredentials: CORS_CONFIG.allowCredentials,
    maxAge: CORS_CONFIG.maxAge,
  },
  rateLimit: {
    limit: RATE_LIMIT_CONFIG.limit,
    windowMs: RATE_LIMIT_CONFIG.windowMs,
  },
  security: {
    hstsMaxAge: 15_552_000,
    hstsIncludeSubdomains: true,
    hstsPreload: false,
  },
} as const;

const defaultIngress = createIngress(commonOptions);
const usersIngress = createIngress({ ...commonOptions, schema: USER_SCHEMA_BYTES });

// ── Fast path extraction (no URL object allocation) ──
function pathname(url: string): string {
  const schemeEnd = url.indexOf("://");
  let start = 0;
  if (schemeEnd >= 0) {
    start = url.indexOf("/", schemeEnd + 3);
    if (start < 0) return "/";
  } else {
    start = url.indexOf("/");
    if (start < 0) return "/";
  }
  const q = url.indexOf("?", start);
  const h = url.indexOf("#", start);
  let end = q;
  if (h >= 0 && (end < 0 || h < end)) end = h;
  return end < 0 ? url.slice(start) : url.slice(start, end);
}

function headersInitFromResult(
  result: IngressResultLazy,
  contentType?: string,
): Record<string, string> {
  // Start with static headers (no spread — direct assign)
  const h: Record<string, string> = {
    "Content-Security-Policy": STATIC_SECURITY_HEADERS["Content-Security-Policy"],
    "X-Frame-Options": STATIC_SECURITY_HEADERS["X-Frame-Options"],
    "X-Content-Type-Options": STATIC_SECURITY_HEADERS["X-Content-Type-Options"],
    "Referrer-Policy": STATIC_SECURITY_HEADERS["Referrer-Policy"],
    "Cross-Origin-Embedder-Policy": STATIC_SECURITY_HEADERS["Cross-Origin-Embedder-Policy"],
    "Cross-Origin-Opener-Policy": STATIC_SECURITY_HEADERS["Cross-Origin-Opener-Policy"],
    "Cross-Origin-Resource-Policy": STATIC_SECURITY_HEADERS["Cross-Origin-Resource-Policy"],
    "X-XSS-Protection": STATIC_SECURITY_HEADERS["X-XSS-Protection"],
    "Strict-Transport-Security": STATIC_SECURITY_HEADERS["Strict-Transport-Security"],
  };

  if (!result.https) {
    delete h["Strict-Transport-Security"];
  }
  if (contentType) {
    h["Content-Type"] = contentType;
  }

  const pairs = result.responseHeaders();
  for (let i = 0; i < pairs.length; i++) {
    h[pairs[i][0]] = pairs[i][1];
  }
  return h;
}

function terminalResponse(result: IngressResultLazy): Response | null {
  if (result.verdict === "continue" && !result.isPreflight && result.status < 400) {
    return null;
  }
  if (result.status === 204) {
    return new Response(null, { status: 204, headers: headersInitFromResult(result) });
  }
  const headers = headersInitFromResult(result, "application/json");
  const text = result.errorBodyText();
  const body = text.length > 0 && text.startsWith('{"')
    ? (text.startsWith('{"ok":') ? text : `{"ok":false,${text.slice(1)}`)
    : '{"ok":false,"error":{"code":"rejected","message":"Rejected by ingress"}}';
  return new Response(body, { status: result.status, headers });
}

function errorResponse(status: number, code: string, message: string, result?: IngressResultLazy): Response {
  const headers = result
    ? headersInitFromResult(result, "application/json")
    : { ...STATIC_SECURITY_HEADERS, "Content-Type": "application/json" };
  return new Response(
    `{"ok":false,"error":{"code":"${code}","message":"${message}"}}`,
    { status, headers },
  );
}

function pairsToObjectLazy(result: IngressResultLazy): Record<string, string | string[]> {
  const pairs = result.query();
  if (pairs.length === 0) return {};
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < pairs.length; i++) {
    const k = pairs[i][0];
    const v = pairs[i][1];
    const existing = out[k];
    if (existing === undefined) {
      out[k] = v;
    } else if (Array.isArray(existing)) {
      existing.push(v);
    } else {
      out[k] = [existing, v];
    }
  }
  return out;
}

function cookiesToObjectLazy(result: IngressResultLazy): Record<string, string> {
  const pairs = result.cookies();
  if (pairs.length === 0) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i++) {
    out[pairs[i][0]] = pairs[i][1];
  }
  return out;
}

const server = Bun.serve({
  port: PORTS.ingress,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
  async fetch(req: Request): Promise<Response> {
    const path = pathname(req.url);
    const method = req.method;

    // Bun 1.4: headers.get() is O(1) — no iteration needed
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "127.0.0.1";

    try {
      const isUsersWrite =
        path === "/api/users" &&
        (method === "POST" || method === "PUT" || method === "PATCH");

      let result: IngressResultLazy;

      if (isUsersWrite) {
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          result = await defaultIngress(req, ip);
          const terminal = terminalResponse(result);
          if (terminal) return terminal;
          return errorResponse(415, "unsupported_media_type", "Content-Type must be application/json", result);
        }
        result = await usersIngress(req, ip);
      } else {
        result = await defaultIngress(req, ip);
      }

      const terminal = terminalResponse(result);
      if (terminal) return terminal;

      // GET/HEAD /health
      if (path === "/health" && (method === "GET" || method === "HEAD")) {
        const body: ApiOk = {
          ok: true,
          requestId: result.requestId(),
          path,
          query: {},
          cookies: {},
        };
        return new Response(method === "HEAD" ? null : JSON.stringify(body), {
          status: 200,
          headers: headersInitFromResult(result, "application/json"),
        });
      }

      // GET /api/users
      if (path === "/api/users" && method === "GET") {
        const body: ApiOk = {
          ok: true,
          requestId: result.requestId(),
          path,
          query: pairsToObjectLazy(result),
          cookies: cookiesToObjectLazy(result),
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: headersInitFromResult(result, "application/json"),
        });
      }

      // POST/PUT/PATCH /api/users
      if (isUsersWrite) {
        let parsed: unknown = null;
        if (result.body.byteLength > 0) {
          try {
            parsed = JSON.parse(decoder.decode(result.body));
          } catch {
            return errorResponse(400, "invalid_json", "Invalid JSON body", result);
          }
        }
        const body: ApiOk = {
          ok: true,
          requestId: result.requestId(),
          path,
          query: pairsToObjectLazy(result),
          cookies: cookiesToObjectLazy(result),
          body: parsed,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: headersInitFromResult(result, "application/json"),
        });
      }

      // POST /api/echo
      if (path === "/api/echo" && method === "POST") {
        const headers = headersInitFromResult(
          result,
          req.headers.get("content-type") ?? "application/octet-stream",
        );
        return new Response(result.body.byteLength > 0 ? result.body : null, {
          status: 200,
          headers,
        });
      }

      // GET /api/cookies
      if (path === "/api/cookies" && method === "GET") {
        const body: ApiOk = {
          ok: true,
          requestId: result.requestId(),
          path,
          query: {},
          cookies: cookiesToObjectLazy(result),
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: headersInitFromResult(result, "application/json"),
        });
      }

      // 404
      return errorResponse(404, "not_found", `Route ${method} ${path} not found`, result);
    } catch (err) {
      if (err instanceof Response) return err;
      return new Response(
        `{"ok":false,"error":{"code":"internal_error","message":"${String(err).replace(/"/g, '\\"')}"}}`,
        {
          status: 500,
          headers: { ...STATIC_SECURITY_HEADERS, "Content-Type": "application/json" },
        },
      );
    }
  },
});

console.log(`[ingress] listening on :${PORTS.ingress}`);