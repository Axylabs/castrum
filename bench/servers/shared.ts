// bench/servers/shared.ts

export const PORTS = {
  bun: 9120,
  elysia: 9121,
  ingress: 9122,
} as const;

export type ServerKind = keyof typeof PORTS;

// ── JSON Schema (identical for all three) ──
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

export const USER_SCHEMA_BYTES = new TextEncoder().encode(
  JSON.stringify(USER_SCHEMA),
);

// ── Standardised JSON response shape ──
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
  error: { code: string; message: string };
}

// ── CORS config (identical) ──
export const CORS_CONFIG = {
  allowOrigin: ["https://app.example.com", "https://admin.example.com"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposeHeaders: ["X-Request-Id", "X-Trace-Id"],
  allowCredentials: true,
  maxAge: 86400,
} as const;

// ── Rate limit config (identical) ──
//
// IMPORTANT:
// Rust ingress uses u32 for rate-limit limit.
// Do not use 10000000000000000000000 here.
// Use u32 max if you effectively want "unlimited" for benchmarks.
export const RATE_LIMIT_CONFIG = {
  limit: 4_294_967_295,
  windowMs: 60_000,
} as const;

// ── Security headers (identical) ──
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

// ── Helpers ──
const encoder = new TextEncoder();

export function jsonBytes(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};

  const out: Record<string, string> = {};

  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;

    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  return out;
}

export function parseQuery(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};

  for (const [key, value] of url.searchParams.entries()) {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }

  return out;
}

export function validateUserBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Body must be a JSON object";
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) {
    return "Field 'id' must be a finite number";
  }

  if (
    typeof obj.name !== "string" ||
    obj.name.length === 0 ||
    obj.name.length > 256
  ) {
    return "Field 'name' must be a string between 1 and 256 characters";
  }

  if (obj.email !== undefined && typeof obj.email !== "string") {
    return "Field 'email' must be a string";
  }

  if (obj.active !== undefined && typeof obj.active !== "boolean") {
    return "Field 'active' must be a boolean";
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.length > 20) {
      return "Field 'tags' must be an array with at most 20 items";
    }

    for (const t of obj.tags) {
      if (typeof t !== "string") return "All tags must be strings";
    }
  }

  const allowed = new Set(["id", "name", "email", "active", "tags"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field '${key}'`;
  }

  return null;
}

let requestCounter = 0;

export function nextRequestId(): string {
  return `${Date.now().toString(36)}-${(requestCounter++ & 0xffffffff).toString(36)}`;
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB