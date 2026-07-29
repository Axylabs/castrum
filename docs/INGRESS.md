# Ingress Pipeline Documentation

## Overview

The Ingress pipeline is the core HTTP request processing system in bun-rust-practical. It handles incoming requests through a series of processing stages, writing decisions to a binary output buffer that is then interpreted by the TypeScript caller.

---

## Quick Start

```ts
import { createIngress, createIngressFast } from "bun-rust-practical";

// Fast synchronous handler (reuses internal buffers)
const fast = createIngressFast({
  parseCookies: true,
  parseQuery: true,
  cors: { allowOrigin: ["https://example.com"] },
  rateLimit: { limit: 100, windowMs: 60_000 },
});

// Inside your Bun server:
Bun.serve({
  fetch(req) {
    return fast.run(req, "192.168.1.1", null, "", (result) => {
      if (result.ok) {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Error", { status: result.status });
    });
  },
});

// Or use the async API (handles body reading automatically):
const handler = createIngress({
  requireJsonBody: true,
  schema: schemaBytes, // optional JSON Schema
  enableRequestIds: true,
});

Bun.serve({
  async fetch(req) {
    const ctx = await handler(req);
    if (ctx.response) return ctx.response; // terminal response (error)
    return new Response("OK", { status: 200 });
  },
});
```

---

## API Reference

### `createIngressFast(options?)`

Creates a **synchronous** ingress handler with zero allocations per request. Returns an `IngressFastHandler`.

```ts
interface IngressFastHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: FastIngressResult) => T,
  ): T;
}
```

**Important**: The callback `fn` must be synchronous. The handler reuses internal buffers and invalidates the result after `fn` returns.

### `createIngress(options?)`

Creates an **asynchronous** ingress handler that reads request bodies automatically. Returns an `IngressHandler`.

```ts
interface IngressHandler {
  (req: Request, ip?: string): Promise<IngressContext>;
}

interface IngressContext extends IngressFastResult {
  response: Response | null; // null if ok, Response if terminal
}
```

### `createIngressSync(options?)`

Creates a synchronous handler with the same API as `createIngressFast` but with explicit body/requestId parameters:

```ts
interface SyncIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: IngressFastResult) => T,
  ): T;
}
```

---

## Options Reference

### `IngressFastOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `trustProxy` | `boolean` | `false` | Trust `X-Forwarded-For` and `X-Real-IP` headers |
| `trustedProxies` | `{ enabled, networks? }` | — | Fine-grained proxy trust with optional network whitelist |
| `parseCookies` | `boolean` | `false` | Parse `Cookie` header into structured JSON |
| `parseQuery` | `boolean` | `false` | Parse URL query string into structured JSON |
| `requireJsonBody` | `boolean` | `false` | Require body to be valid JSON |
| `schema` | `Uint8Array` | — | JSON Schema (as UTF-8 bytes) for body validation |
| `cors` | `CorsOptions` | — | CORS configuration |
| `rateLimit` | `{ limit, windowMs, maxEntries }` | — | Rate limiting configuration |
| `security` | `SecurityHeadersOptions` | — | Security headers configuration |
| `https` | `boolean` | — | Force HTTPS detection (overrides auto-detection) |
| `maxBodyBytes` | `number` | 1,048,576 | Maximum body size (1 MB) |
| `enableSecurityHeaders` | `boolean` | `true` | Enable automatic security headers |
| `enableRequestIds` | `boolean` | `true` | Generate unique request IDs |
| `enableBodySizeGuard` | `boolean` | `true` | Guard against oversized bodies |
| `emitMetadataJson` | `boolean` | `false` | Emit metadata JSON in output (request ID, path, etc.) |
| `readBody` | `boolean` | — | Explicitly control body reading (auto-detected based on other options) |
| `outputBufferSize` | `number` | 262,144 | Initial size of the output buffer |
| `limits` | `LimitsOptions` | — | Fine-grained size limits for URL, headers, cookies, etc. |

### `CorsOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowOrigin` | `string[]` | — | Allowed origins (empty or `["*"]` = wildcard) |
| `allowMethods` | `string[]` | `["GET", "HEAD", "POST"]` | Allowed HTTP methods |
| `allowHeaders` | `string[]` | — | Allowed request headers |
| `exposeHeaders` | `string[]` | — | Exposed response headers |
| `allowCredentials` | `boolean` | `false` | Allow credentials (disables wildcard origin) |
| `maxAge` | `number` | — | Preflight cache max-age (seconds) |

### `SecurityHeadersOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `contentSecurityPolicy` | `string` | — | `Content-Security-Policy` header value |
| `hsts` | `boolean` | — | Enable HSTS |
| `hstsMaxAge` | `number` | 31,536,000 | HSTS max-age (seconds) |
| `hstsIncludeSubdomains` | `boolean` | `false` | HSTS includeSubDomains |
| `hstsPreload` | `boolean` | `false` | HSTS preload |
| `frameOptions` | `string` | `"DENY"` | `X-Frame-Options` value |
| `nosniff` | `boolean` | `true` | `X-Content-Type-Options: nosniff` |
| `referrerPolicy` | `string` | `"no-referrer"` | `Referrer-Policy` value |
| `coep` | `string` | — | `Cross-Origin-Embedder-Policy` |
| `coop` | `string` | — | `Cross-Origin-Opener-Policy` |
| `corp` | `string` | — | `Cross-Origin-Resource-Policy` |
| `xssProtection` | `string` | — | `X-XSS-Protection` value |

### `RateLimitOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | — | Maximum requests per window |
| `windowMs` | `number` | 1000 | Window duration (milliseconds) |
| `maxEntries` | `number` | — | Maximum tracked IPs (LRU eviction) |

### `LimitsOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxUrlBytes` | `number` | 65,536 | Maximum URL length |
| `maxQueryBytes` | `number` | 16,384 | Maximum query string length |
| `maxCookieBytes` | `number` | 8,192 | Maximum cookie header length |
| `maxHeadersBytes` | `number` | 65,536 | Maximum packed headers length |
| `maxHeaders` | `number` | 100 | Maximum number of headers |
| `maxPairs` | `number` | 1,024 | Maximum cookie/query key-value pairs |

---

## Result Interface

### `FastIngressResult`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `number` | HTTP status code |
| `verdict` | `number` | 0 = pass, 1 = terminal (error) |
| `flags` | `number` | Bitfield of FLAG_* values |
| `errorCode` | `number` | Error code enum |
| `terminal` | `boolean` | True if request processing should stop |
| `ok` | `boolean` | True if status is 2xx or 3xx and no errors |
| `https` | `boolean` | Request is HTTPS |
| `trustedProxy` | `boolean` | Request from trusted proxy |
| `hasCookies` | `boolean` | Cookie data present in output |
| `hasQuery` | `boolean` | Query data present in output |
| `bodyValidJson` | `boolean` | Body is valid JSON |
| `schemaValid` | `boolean` | Body passes JSON Schema validation |
| `corsAllowed` | `boolean` | CORS origin allowed |
| `isPreflight` | `boolean` | Request is a CORS preflight |
| `rateLimited` | `boolean` | Rate limit exceeded |
| `rateLimit` | `number` | Rate limit ceiling |
| `rateRemaining` | `number` | Remaining requests in window |
| `rateResetMs` | `number` | Timestamp when rate limit resets (ms) |
| `retryAfterMs` | `number` | Retry-After duration (ms) |
| `body` | `Uint8Array` | Original request body bytes |
| `headerVariant` | `number` | Header variant index (pre-computed header set) |
| `requestId` | `string` | Unique request identifier |
| `bodyTruncated` | `boolean` | Output data truncated |
| `cookiesJson()` | `string` | Lazy-decoded cookie JSON string |
| `queryJson()` | `string` | Lazy-decoded query JSON string |
| `bodyJson()` | `Uint8Array` | Lazy-decoded body metadata JSON bytes |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `ERR_CODE_NONE` (0) | 200 / varies | No error |
| `ERR_CODE_CORS_PREFLIGHT` (1) | 403 / 204 | CORS preflight rejected (or allowed → 204) |
| `ERR_CODE_RATE_LIMITED` (2) | 429 | Rate limit exceeded |
| `ERR_CODE_BODY_TOO_LARGE` (3) | 413 | Body exceeds maxBodyBytes |
| `ERR_CODE_INVALID_JSON` (4) | 400 | Invalid JSON body |
| `ERR_CODE_SCHEMA_VALIDATION` (5) | 422 | Schema validation failed |
| `ERR_CODE_BAD_REQUEST` (6) | 400 | Malformed request |
| `ERR_CODE_REQUEST_TOO_LARGE` (7) | 431 | Request headers/URL too large |
| `ERR_CODE_INTERNAL` (8) | 500 | Internal error |

---

## Request ID Generation

Request IDs are generated using a counter-based approach (no crypto overhead):

```
┌────────────────────────────────────────────┐
│ 64-bit ID: [hi: 32 bits][lo: 32 bits]      │
│                                             │
│ hi = BOOT_RANDOM ^ (WORKER_ID << 16)        │
│ lo = monotonic counter (increments per call)│
└────────────────────────────────────────────┘
```

- **Format**: 16-byte hex string (e.g., `"a1b2c3d4e5f6a7b8"`)
- **Uniqueness**: Unique within a single process instance
- **Performance**: ~20x faster than `crypto.randomUUID()`

---

## Header Variant System

The header template system pre-computes all possible header combinations at initialization time to avoid dynamic header construction per request. Each variant is a bitmask:

| Bit | Value | Meaning |
|-----|-------|---------|
| 0 | 1 (HV_JSON) | JSON error response headers |
| 1 | 2 (HV_CORS_SIMPLE) | CORS simple (non-preflight) headers |
| 2 | 4 (HV_CORS_PREFLIGHT) | CORS preflight headers |
| 3 | 8 (HV_RATE_ACTIVE) | Rate limit headers (x-ratelimit-*) |
| 4 | 16 (HV_RATE_LIMITED) | Retry-After header |

At request time, Rust computes the appropriate variant index, and TypeScript uses it to look up the pre-built header set.

---

## Complete Example: Custom Middleware

```ts
import { createIngressFast, FastIngressResult } from "bun-rust-practical";

const handler = createIngressFast({
  parseCookies: true,
  parseQuery: true,
  cors: {
    allowOrigin: ["https://app.example.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowCredentials: true,
  },
  rateLimit: {
    limit: 1000,
    windowMs: 60_000, // 1 minute
  },
  security: {
    hsts: true,
    hstsMaxAge: 31536000,
    frameOptions: "SAMEORIGIN",
    contentSecurityPolicy: "default-src 'self'",
  },
});

Bun.serve({
  port: 3000,
  async fetch(req) {
    const ip = req.headers.get("x-forwarded-for") ?? "0.0.0.0";

    return handler.run(req, ip, null, "", (result) => {
      if (result.terminal || !result.ok) {
        // Build error response using the status from the result
        return new Response(
          JSON.stringify({
            error: true,
            code: result.errorCode,
            message: getErrorMessage(result),
          }),
          {
            status: result.status,
            headers: {
              "content-type": "application/json",
              ...getCorsHeaders(result),
            },
          },
        );
      }

      // Access parsed data
      if (result.hasCookies) {
        const cookies = JSON.parse(result.cookiesJson());
        // use cookies...
      }

      if (result.hasQuery) {
        const query = JSON.parse(result.queryJson());
        // use query params...
      }

      // Successful request
      return new Response("Hello, world!", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
  },
});

function getErrorMessage(result: FastIngressResult): string {
  const messages: Record<number, string> = {
    1: "CORS preflight rejected",
    2: "Too many requests",
    3: "Request body too large",
    4: "Invalid JSON body",
    5: "Schema validation failed",
    6: "Bad request",
    7: "Request too large",
    8: "Internal server error",
  };
  return messages[result.errorCode] ?? "Unknown error";
}

function getCorsHeaders(result: FastIngressResult): Record<string, string> {
  if (result.corsAllowed) {
    return {
      "access-control-allow-origin": "https://app.example.com",
      "access-control-allow-credentials": "true",
    };
  }
  return {};
}