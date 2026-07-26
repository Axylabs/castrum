// bench/servers/elysia-server.ts

import { Elysia, t } from "elysia";
import {
    PORTS,
    SECURITY_HEADERS,
    CORS_CONFIG,
    RATE_LIMIT_CONFIG,
    MAX_BODY_BYTES,
    parseCookies,
    parseQuery,
    nextRequestId,
    type ApiOk,
} from "./shared";

// ── Same rate limiter ──
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
import { cors } from '@elysia/cors'


const app = new Elysia({ serve: { port: PORTS.elysia }, })
    // ── Security headers on every response ──
    .onAfterHandle(({ set }) => {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
            set.headers[k] = v;
        }
    })
    // ── CORS ──
    .use(cors({
        origin: [...CORS_CONFIG.allowOrigin],
        methods: [...CORS_CONFIG.allowMethods],
        allowedHeaders: [...CORS_CONFIG.allowHeaders],
        exposeHeaders: [...CORS_CONFIG.exposeHeaders],
        credentials: CORS_CONFIG.allowCredentials,
        maxAge: CORS_CONFIG.maxAge,
    }))
    // ── Request ID + Rate limit guard ──
    .onBeforeHandle(({ request, set, cookie }) => {
        const requestId = nextRequestId();
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
            return {
                ok: false,
                error: { code: "rate_limited", message: "Too Many Requests", retry_after_ms: rl.resetMs - now },
            };
        }
    })
    // ── GET /health ──
    .get("/health", ({ request, set }) => {
        const url = new URL(request.url);
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: url.pathname,
            query: {},
            cookies: {},
        };
        return body;
    })
    // ── GET /api/users ──
    .get("/api/users", ({ request, set }) => {
        const url = new URL(request.url);
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: url.pathname,
            query: parseQuery(url),
            cookies: parseCookies(request.headers.get("cookie")),
        };
        return body;
    })
    // ── POST /api/users ──
    .post(
        "/api/users",
        async ({ request, set, body }) => {
            const url = new URL(request.url);
            const contentType = request.headers.get("content-type") ?? "";
            if (!contentType.includes("application/json")) {
                set.status = 415;
                return { ok: false, error: { code: "unsupported_media_type", message: "Content-Type must be application/json" } };
            }
            const raw = await request.arrayBuffer();
            if (raw.byteLength > MAX_BODY_BYTES) {
                set.status = 413;
                return { ok: false, error: { code: "body_too_large", message: "Request body is too large" } };
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(new TextDecoder().decode(raw));
            } catch {
                set.status = 400;
                return { ok: false, error: { code: "invalid_json", message: "Invalid JSON body" } };
            }
            // Inline validation (same rules as shared.validateUserBody)
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                set.status = 422;
                return { ok: false, error: { code: "schema_validation_failed", message: "Body must be a JSON object" } };
            }
            const obj = parsed as Record<string, unknown>;
            if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) {
                set.status = 422;
                return { ok: false, error: { code: "schema_validation_failed", message: "Field 'id' must be a finite number" } };
            }
            if (typeof obj.name !== "string" || obj.name.length === 0 || obj.name.length > 256) {
                set.status = 422;
                return { ok: false, error: { code: "schema_validation_failed", message: "Field 'name' must be a string between 1 and 256 characters" } };
            }
            const allowed = new Set(["id", "name", "email", "active", "tags"]);
            for (const key of Object.keys(obj)) {
                if (!allowed.has(key)) {
                    set.status = 422;
                    return { ok: false, error: { code: "schema_validation_failed", message: `Unknown field '${key}'` } };
                }
            }
            const result: ApiOk = {
                ok: true,
                requestId: set.headers["X-Request-Id"] as string,
                path: url.pathname,
                query: parseQuery(url),
                cookies: parseCookies(request.headers.get("cookie")),
                body: parsed,
            };
            return result;
        },
    )
    // ── POST /api/echo ──
    .post("/api/echo", async ({ request, set }) => {
        const raw = await request.arrayBuffer();
        if (raw.byteLength > MAX_BODY_BYTES) {
            set.status = 413;
            return { ok: false, error: { code: "body_too_large", message: "Request body is too large" } };
        }
        set.headers["Content-Type"] = request.headers.get("content-type") ?? "application/octet-stream";
        return raw;
    })
    // ── GET /api/cookies ──
    .get("/api/cookies", ({ request, set }) => {
        const url = new URL(request.url);
        const body: ApiOk = {
            ok: true,
            requestId: set.headers["X-Request-Id"] as string,
            path: url.pathname,
            query: {},
            cookies: parseCookies(request.headers.get("cookie")),
        };
        return body;
    })
    // ── 404 fallback ──
    .onError(({ code, set }) => {
        if (code === "NOT_FOUND") {
            set.status = 404;
            return { ok: false, error: { code: "not_found", message: "Route not found" } };
        }
        set.status = 500;
        return { ok: false, error: { code: "internal_error", message: "Internal server error" } };
    });

app.listen(PORTS.elysia);
console.log(`[elysia] listening on :${PORTS.elysia}`);