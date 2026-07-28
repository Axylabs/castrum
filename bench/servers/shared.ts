// bench/servers/shared.ts — cleaned up
export const PORTS = {
  bun: 9120,
  elysia: 9121,
  ingress: 9122,
} as const;

export type ServerKind = keyof typeof PORTS;

export const USER_SCHEMA = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "number" },
    name: { type: "string", minLength: 1, maxLength: 256 },
    email: { type: "string", format: "email" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" }, maxItems: 20 },
  },
  additionalProperties: false,
} as const;

export const USER_SCHEMA_BYTES = new TextEncoder().encode(JSON.stringify(USER_SCHEMA));

export interface ApiOk {
  ok: true;
  requestId: string;
  path: string;
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  body?: unknown;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; retry_after_ms?: number };
}

export const CORS_CONFIG = {
  allowOrigin: ["https://app.example.com", "https://admin.example.com"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposeHeaders: ["X-Request-Id", "X-Trace-Id"],
  allowCredentials: true,
  maxAge: 86400,
} as const;

export const RATE_LIMIT_CONFIG = {
  limit: 4_294_967_295,
  windowMs: 60_000,
} as const;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-XSS-Protection": "0",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
};

export function validateUserBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be a JSON object";
  const obj = body as Record<string, unknown>;
  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) return "Field 'id' must be a finite number";
  if (typeof obj.name !== "string" || obj.name.length === 0 || obj.name.length > 256)
    return "Field 'name' must be a string between 1 and 256 characters";
  if (obj.email !== undefined && typeof obj.email !== "string") return "Field 'email' must be a string";
  if (obj.active !== undefined && typeof obj.active !== "boolean") return "Field 'active' must be a boolean";
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.length > 20) return "Field 'tags' must be an array with at most 20 items";
    for (const t of obj.tags) { if (typeof t !== "string") return "All tags must be strings"; }
  }
  const allowed = new Set(["id", "name", "email", "active", "tags"]);
  for (const key of Object.keys(obj)) { if (!allowed.has(key)) return `Unknown field '${key}'`; }
  return null;
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ── REMOVED (replaced by Bun / framework primitives): ──
// - jsonBytes()       → Response.json()
// - parseCookies()    → req.cookies (Bun) / cookie context (Elysia) / cookie-es
// - parseQuery()      → inline URLSearchParams / query context (Elysia)
// - nextRequestId()   → crypto.randomUUID()