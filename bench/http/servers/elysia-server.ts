// bench/http/servers/elysia-server.ts — Using Elysia primitives
import { Elysia, t } from "elysia";
import { cors } from "@elysia/cors";
import {
    PORTS,
    SECURITY_HEADERS,
    CORS_CONFIG,
    RATE_LIMIT_CONFIG,
    type ApiOk,
} from "./shared";

// ── Same rate limiter ──
const rateBuckets = new Map<string, { prev: number; curr: number; windowStart: number }>();
function rateLimitCheck(ip: string, now: number) {
    const limit = RATE_LIMIT_CONFIG.limit;
    const window = RATE_LIMIT_CONFIG.windowMs;
    let bucket = rateBuckets.get(ip);
    if (!bucket) { bucket = { prev: 0, curr: 0, windowStart: now }; rateBuckets.set(ip, bucket); }
    let elapsed = now - bucket.windowStart;
    if (elapsed >= window * 2) { bucket.prev = 0; bucket.curr = 0; bucket.windowStart = now; elapsed = 0; }
    else if (elapsed >= window) { bucket.prev = bucket.curr; bucket.curr = 0; bucket.windowStart += window; elapsed -= window; }
    const overlap = window - elapsed;
    const weighted = (bucket.prev * overlap) / window + bucket.curr;
    const reset = bucket.windowStart + window;
    if (weighted < limit) { bucket.curr++; return { allowed: true, remaining: Math.max(0, limit - Math.floor(weighted) - 1), resetMs: reset }; }
    return { allowed: false, remaining: 0, resetMs: reset };
}

const app = new Elysia({ serve: { port: PORTS.elysia } })
    // ── Security headers ──
    .onAfterHandle(({ set }) => {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) set.headers[k] = v;
    })
    // ── CORS via plugin ──
    .use(cors({
        origin: [...CORS_CONFIG.allowOrigin],
        methods: [...CORS_CONFIG.allowMethods],
        allowedHeaders: [...CORS_CONFIG.allowHeaders],
        exposeHeaders: [...CORS_CONFIG.exposeHeaders],
        credentials: CORS_CONFIG.allowCredentials,
        maxAge: CORS_CONFIG.maxAge,
    }))
    // ── Request ID + Rate limit guard ──
    .onBeforeHandle(({ request, set }) => {
        // ★ Bun primitive: crypto.randomUUID()
        const requestId = crypto.randomUUID();
        set.headers["X-Request-Id"] = requestId;

        const ip =
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            request.headers.get("x-real-ip") ??
            "127.0.0.1";
        const now = Date.now();
        const rl = rateLimitCheck(ip, now);
        set.headers["RateLimit-Limit"] = String(RATE_LIMIT_CONFIG.limit);
        set.headers["RateLimit-Remaining"] = String(rl.remaining);
        set.headers["RateLimit-Reset"] = String(Math.ceil(rl.resetMs / 1000));
        if (!rl.allowed) {
            const retrySecs = Math.ceil((rl.resetMs - now) / 1000);
            set.headers["Retry-After"] = String(retrySecs);
            set.status = 429;
            return { ok: false, error: { code: "rate_limited", message: "Too Many Requests", retry_after_ms: rl.resetMs - now } };
        }
    })
    // ── GET /health ──
    .get("/health", ({ set }) => {
        // ★ No new URL(request.url) needed — path is known
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: "/health",
            query: {},
            cookies: {},
        };
        return body;
    })
    // ── GET /api/users ──
    .get("/api/users", ({ set, query, cookie }) => {
        // ★ Elysia primitives: `query` and `cookie` from context
        // No manual parseQuery(url) or parseCookies(header)
        const cookies: Record<string, string> = {};
        for (const [key, val] of Object.entries(cookie)) {
            // Elysia's cookie proxy: each entry has .value at runtime
            cookies[key] = (val as any)?.value ?? String(val ?? "");
        }
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: "/api/users",
            query: query as Record<string, string | string[]>,
            cookies,
        };
        return body;
    })
    // ── POST /api/users — ★ Elysia TypeBox schema validation ──
    .post(
        "/api/users",
        ({ set, body, query, cookie }) => {
            // ★ Elysia already parsed + validated the body via `body` schema below.
            // No manual arrayBuffer + TextDecoder + JSON.parse + validateUserBody.
            const cookies: Record<string, string> = {};
            for (const [key, val] of Object.entries(cookie)) {
                // Elysia's cookie proxy: each entry has .value at runtime
                cookies[key] = (val as any)?.value ?? String(val ?? "");
            }
            const result: ApiOk = {
                ok: true,
                requestId: set.headers["X-Request-Id"] as string,
                path: "/api/users",
                query: query as Record<string, string | string[]>,
                cookies,
                body,
            };
            return result;
        },
        {
            // ★ TypeBox schema — Elysia validates automatically, returns 422 on failure
            body: t.Object({
                id: t.Number(),
                name: t.String({ minLength: 1, maxLength: 256 }),
                email: t.Optional(t.String()),
                active: t.Optional(t.Boolean()),
                tags: t.Optional(t.Array(t.String(), { maxItems: 20 })),
            }, { additionalProperties: false }),
        },
    )
    // ── POST /api/echo ──
    .post("/api/echo", async ({ request, set }) => {
        // ★ Stream body directly for echo — no buffering
        const requestedContentType = request.headers.get("content-type") ?? "application/octet-stream";
        set.headers["Content-Type"] = requestedContentType;
        return request.body;
    })
    // ── GET /api/cookies ──
    .get("/api/cookies", ({ set, cookie }) => {
        // ★ Elysia's built-in cookie parsing
        const cookies: Record<string, string> = {};
        for (const [key, val] of Object.entries(cookie)) {
            // Elysia's cookie proxy: each entry has .value at runtime
            cookies[key] = (val as any)?.value ?? String(val ?? "");
        }
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: "/api/cookies",
            query: {},
            cookies,
        };
        return body;
    })
    // ── 404 fallback ──
    .onError(({ code, set }) => {
        if (code === "NOT_FOUND") {
            set.status = 404;
            return { ok: false, error: { code: "not_found", message: "Route not found" } };
        }
        if (code === "VALIDATION") {
            set.status = 422;
            return { ok: false, error: { code: "schema_validation_failed", message: "Request body failed schema validation" } };
        }
        set.status = 500;
        return { ok: false, error: { code: "internal_error", message: "Internal server error" } };
    });

app.listen(PORTS.elysia);
console.log(`[elysia] listening on :${PORTS.elysia}`);