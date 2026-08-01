/**
 * Tests for src/ingress/fast.ts
 *
 * Covers:
 * - generateRequestId correctness
 * - FastIngressResult refresh, invalidate, setInternalError
 * - FastIngressResult lazy decode (cookiesJson, queryJson, bodyJson)
 * - Status helpers (isValidResponseStatus, statusForErrorCode, normalizeResponseStatus, safeTerminalStatus)
 * - errorCodeName and errorMessage
 * - buildResponseContext and buildTerminalResponse
 * - headersForResult
 * - METHOD_KIND mapping
 */

import { describe, test, expect } from "bun:test";
import {
  generateRequestId,
  FastIngressResult,
  isValidResponseStatus,
  statusForErrorCode,
  normalizeResponseStatus,
  safeTerminalStatus,
  errorCodeName,
  errorMessage,
  buildResponseContext,
  buildTerminalResponse,
  headersForResult,
  createIngressFast,
  METHOD_KIND,
} from "../../../src/ingress/fast";

import {
  ERR_CODE_NONE,
  ERR_CODE_CORS_PREFLIGHT,
  ERR_CODE_RATE_LIMITED,
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_INVALID_JSON,
  ERR_CODE_SCHEMA_VALIDATION,
  ERR_CODE_BAD_REQUEST,
  ERR_CODE_REQUEST_TOO_LARGE,
  ERR_CODE_INTERNAL,
  FLAG_HAS_COOKIES,
  FLAG_HAS_QUERY,
  FLAG_BODY_VALID_JSON,
  FLAG_SCHEMA_VALID,
  FLAG_CORS_ALLOWED,
  FLAG_IS_PREFLIGHT,
  FLAG_RATE_LIMITED,
  FLAG_HTTPS,
  FLAG_TRUSTED_PROXY,
  FLAG_BODY_TRUNCATED,
  HV_CORS_SIMPLE,
  HV_CORS_PREFLIGHT,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
  HV_JSON,
  OUT_DATA_START,
  OUT_VERDICT,
  OUT_ERROR_CODE,
  OUT_STATUS,
  OUT_FLAGS,
  OUT_RATE_LIMIT,
  OUT_RATE_REMAINING,
  OUT_RATE_RESET,
  OUT_RETRY_AFTER,
  OUT_COOKIES_JSON_LEN,
  OUT_QUERY_JSON_LEN,
  OUT_HEADER_VARIANT,
  OUT_BODY_JSON_LEN,
} from "../../../src/ingress/constants";

// ── Helper: build an output buffer ────────────────────────────────────
function buildOutputBuffer(
  overrides: {
    verdict?: number;
    errorCode?: number;
    status?: number;
    flags?: number;
    rateLimit?: number;
    rateRemaining?: number;
    rateResetMs?: bigint;
    retryAfterMs?: bigint;
    cookiesJsonLen?: number;
    queryJsonLen?: number;
    headerVariant?: number;
    bodyJsonLen?: number;
    cookieData?: Uint8Array;
    queryData?: Uint8Array;
    bodyJsonData?: Uint8Array;
  } = {},
): Uint8Array {
  const size = Math.max(OUT_DATA_START + 256, OUT_DATA_START);
  const buf = new Uint8Array(size);
  buf.fill(0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  dv.setUint8(OUT_VERDICT, overrides.verdict ?? 0);
  dv.setUint8(OUT_ERROR_CODE, overrides.errorCode ?? 0);
  dv.setUint16(OUT_STATUS, overrides.status ?? 200, true);
  dv.setUint32(OUT_FLAGS, overrides.flags ?? 0, true);
  dv.setUint32(OUT_RATE_LIMIT, overrides.rateLimit ?? 0, true);
  dv.setUint32(OUT_RATE_REMAINING, overrides.rateRemaining ?? 0, true);
  dv.setBigUint64(OUT_RATE_RESET, overrides.rateResetMs ?? BigInt(0), true);
  dv.setBigUint64(OUT_RETRY_AFTER, overrides.retryAfterMs ?? BigInt(0), true);
  dv.setUint32(OUT_COOKIES_JSON_LEN, overrides.cookiesJsonLen ?? 0, true);
  dv.setUint32(OUT_QUERY_JSON_LEN, overrides.queryJsonLen ?? 0, true);
  dv.setUint8(OUT_HEADER_VARIANT, overrides.headerVariant ?? 0);
  dv.setUint32(OUT_BODY_JSON_LEN, overrides.bodyJsonLen ?? 0, true);

  if (overrides.cookieData) {
    buf.set(overrides.cookieData, OUT_DATA_START);
  }
  if (overrides.queryData) {
    buf.set(overrides.queryData, OUT_DATA_START + (overrides.cookiesJsonLen ?? 0));
  }
  if (overrides.bodyJsonData) {
    const bodyOffset =
      OUT_DATA_START +
      (overrides.cookiesJsonLen ?? 0) +
      (overrides.queryJsonLen ?? 0);
    buf.set(overrides.bodyJsonData, bodyOffset);
  }

  return buf;
}

function encoder(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── METHOD_KIND ───────────────────────────────────────────────────────
describe("METHOD_KIND", () => {
  test("maps standard HTTP methods to correct values", () => {
    expect(METHOD_KIND["GET"]).toBe(0);
    expect(METHOD_KIND["HEAD"]).toBe(1);
    expect(METHOD_KIND["POST"]).toBe(2);
    expect(METHOD_KIND["PUT"]).toBe(3);
    expect(METHOD_KIND["PATCH"]).toBe(4);
    expect(METHOD_KIND["DELETE"]).toBe(5);
    expect(METHOD_KIND["OPTIONS"]).toBe(6);
  });

  test("unknown method returns undefined", () => {
    expect(METHOD_KIND["TRACE"]).toBeUndefined();
  });
});

// ── generateRequestId ─────────────────────────────────────────────────
describe("generateRequestId", () => {
  test("returns a 16-byte Uint8Array", () => {
    const id = generateRequestId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.byteLength).toBe(16);
  });

  test("produces hex string when decoded", () => {
    const id = generateRequestId();
    const hex = new TextDecoder().decode(id);
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });

  test("produces unique consecutive IDs", () => {
    const ids = new Set<string>();
    const decoder = new TextDecoder();

    for (let i = 0; i < 100; i++) {
      ids.add(decoder.decode(generateRequestId()));
    }

    expect(ids.size).toBe(100);
  });
});

// ── FastIngressResult ─────────────────────────────────────────────────
describe("FastIngressResult", () => {
  test("starts in invalid state", () => {
    const r = new FastIngressResult();
    expect(r.status).toBe(500);
    expect(r.verdict).toBe(1);
    expect(r.errorCode).toBe(ERR_CODE_INTERNAL);
    expect(r.terminal).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("refresh parses a valid output buffer with 200 OK", () => {
    const buf = buildOutputBuffer({
      status: 200,
      verdict: 0,
      errorCode: ERR_CODE_NONE,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "test-request");

    expect(r.status).toBe(200);
    expect(r.verdict).toBe(0);
    expect(r.errorCode).toBe(ERR_CODE_NONE);
    expect(r.terminal).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("refresh parses terminal error response", () => {
    const buf = buildOutputBuffer({
      status: 413,
      verdict: 1,
      errorCode: ERR_CODE_BODY_TOO_LARGE,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "err-001");

    expect(r.status).toBe(413);
    expect(r.verdict).toBe(1);
    expect(r.terminal).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.bodyTruncated).toBe(false);
  });

  test("refresh parses flags correctly", () => {
    const flags =
      FLAG_HAS_COOKIES |
      FLAG_HAS_QUERY |
      FLAG_BODY_VALID_JSON |
      FLAG_CORS_ALLOWED |
      FLAG_HTTPS |
      FLAG_TRUSTED_PROXY;

    const buf = buildOutputBuffer({
      status: 200,
      verdict: 0,
      flags,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    expect(r.hasCookies).toBe(true);
    expect(r.hasQuery).toBe(true);
    expect(r.bodyValidJson).toBe(true);
    expect(r.corsAllowed).toBe(true);
    expect(r.https).toBe(true);
    expect(r.trustedProxy).toBe(true);
    expect(r.isPreflight).toBe(false);
    expect(r.rateLimited).toBe(false);
    expect(r.schemaValid).toBe(false);
  });

  test("refresh parses rate limit fields", () => {
    const buf = buildOutputBuffer({
      status: 429,
      verdict: 1,
      errorCode: ERR_CODE_RATE_LIMITED,
      flags: FLAG_RATE_LIMITED,
      rateLimit: 100,
      rateRemaining: 0,
      rateResetMs: BigInt(1000),
      retryAfterMs: BigInt(5000),
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    expect(r.rateLimited).toBe(true);
    expect(r.rateLimit).toBe(100);
    expect(r.rateRemaining).toBe(0);
    expect(r.rateResetMs).toBe(1000);
    expect(r.retryAfterMs).toBe(5000);
  });

  test("lazy decode: cookiesJson()", () => {
    const cookieJson = encoder('{"session":"abc123","theme":"dark"}');
    const buf = buildOutputBuffer({
      status: 200,
      verdict: 0,
      flags: FLAG_HAS_COOKIES,
      cookiesJsonLen: cookieJson.byteLength,
      cookieData: cookieJson,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    expect(r.hasCookies).toBe(true);
    expect(r.cookiesJson()).toBe('{"session":"abc123","theme":"dark"}');
  });

  test("lazy decode: queryJson()", () => {
    const queryJson = encoder('{"page":"1","limit":"10"}');
    const cookiesJson = encoder("{}");
    const buf = buildOutputBuffer({
      status: 200,
      verdict: 0,
      flags: FLAG_HAS_QUERY,
      cookiesJsonLen: cookiesJson.byteLength,
      cookieData: cookiesJson,
      queryJsonLen: queryJson.byteLength,
      queryData: queryJson,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    expect(r.hasQuery).toBe(true);
    expect(r.queryJson()).toBe('{"page":"1","limit":"10"}');
  });

  test("lazy decode: bodyJson()", () => {
    const bodyJson = encoder('{"requestId":"abc","path":"/api"}');
    const buf = buildOutputBuffer({
      status: 200,
      verdict: 0,
      bodyJsonLen: bodyJson.byteLength,
      bodyJsonData: bodyJson,
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    const result = r.bodyJson();
    expect(new TextDecoder().decode(result)).toBe('{"requestId":"abc","path":"/api"}');
  });

  test("invalidate resets result to error state", () => {
    const buf = buildOutputBuffer({ status: 200 });
    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "test");

    expect(r.ok).toBe(true);

    r.invalidate();
    expect(r.status).toBe(500);
    expect(r.verdict).toBe(1);
    expect(r.errorCode).toBe(ERR_CODE_INTERNAL);
    expect(r.terminal).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.requestId).toBe("");
  });

  test("setInternalError sets error without refresh", () => {
    const r = new FastIngressResult();
    r.setInternalError("err-req");

    expect(r.status).toBe(500);
    expect(r.errorCode).toBe(ERR_CODE_INTERNAL);
    expect(r.requestId).toBe("err-req");
  });

  test("uninitialized buffer is treated as internal error", () => {
    const buf = new Uint8Array(OUT_DATA_START + 10);
    buf.fill(0); // all zeros = uninitialized

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    expect(r.status).toBe(500);
    expect(r.errorCode).toBe(ERR_CODE_INTERNAL);
  });

  test("overlapping buffer bounds are handled gracefully", () => {
    const buf = buildOutputBuffer({
      status: 200,
      cookiesJsonLen: 1000, // larger than buffer
    });

    const r = new FastIngressResult();
    r.refresh(buf, new Uint8Array(0), "");

    // Should not throw — truncated flags should be set
    expect(r.bodyTruncated).toBe(true);
    expect(r.cookiesJson()).toBe("{}");
  });
});

// ── Status helpers ────────────────────────────────────────────────────
describe("isValidResponseStatus", () => {
  test("returns true for valid status codes", () => {
    expect(isValidResponseStatus(200)).toBe(true);
    expect(isValidResponseStatus(404)).toBe(true);
    expect(isValidResponseStatus(500)).toBe(true);
    expect(isValidResponseStatus(101)).toBe(true);
    expect(isValidResponseStatus(599)).toBe(true);
  });

  test("returns false for invalid status codes", () => {
    expect(isValidResponseStatus(0)).toBe(false);
    expect(isValidResponseStatus(99)).toBe(false);
    expect(isValidResponseStatus(600)).toBe(false);
    expect(isValidResponseStatus(100)).toBe(false);
  });
});

describe("statusForErrorCode", () => {
  test("maps error codes to HTTP status", () => {
    expect(statusForErrorCode(ERR_CODE_CORS_PREFLIGHT, false)).toBe(403);
    expect(statusForErrorCode(ERR_CODE_RATE_LIMITED, false)).toBe(429);
    expect(statusForErrorCode(ERR_CODE_BODY_TOO_LARGE, false)).toBe(413);
    expect(statusForErrorCode(ERR_CODE_INVALID_JSON, false)).toBe(400);
    expect(statusForErrorCode(ERR_CODE_SCHEMA_VALIDATION, false)).toBe(422);
    expect(statusForErrorCode(ERR_CODE_BAD_REQUEST, false)).toBe(400);
    expect(statusForErrorCode(ERR_CODE_REQUEST_TOO_LARGE, false)).toBe(431);
    expect(statusForErrorCode(ERR_CODE_INTERNAL, false)).toBe(500);
  });

  test("preflight allowed returns 204", () => {
    expect(statusForErrorCode(ERR_CODE_CORS_PREFLIGHT, true)).toBe(204);
  });
});

describe("normalizeResponseStatus", () => {
  test("returns valid status as-is", () => {
    expect(normalizeResponseStatus(200, ERR_CODE_NONE, false)).toBe(200);
    expect(normalizeResponseStatus(404, ERR_CODE_NONE, false)).toBe(404);
  });

  test("returns fallback for invalid status with error code", () => {
    expect(normalizeResponseStatus(0, ERR_CODE_BODY_TOO_LARGE, false)).toBe(413);
    expect(normalizeResponseStatus(99, ERR_CODE_INTERNAL, false)).toBe(500);
  });
});

describe("safeTerminalStatus", () => {
  test("preflight allowed returns 204", () => {
    const r = {
      status: 200,
      errorCode: ERR_CODE_NONE,
      isPreflight: true,
      corsAllowed: true,
    };
    expect(safeTerminalStatus(r)).toBe(204);
  });

  test("non-preflight with valid status defaults to 500 (safe fallback)", () => {
    const r = {
      status: 200,
      errorCode: ERR_CODE_NONE,
      isPreflight: false,
      corsAllowed: false,
    };
    // safeTerminalStatus returns 500 when status is valid but not an error,
    // since terminal responses should be error responses
    expect(safeTerminalStatus(r)).toBe(500);
  });

  test("non-preflight with error code fallback", () => {
    const r = {
      status: 200,
      errorCode: ERR_CODE_BODY_TOO_LARGE,
      isPreflight: false,
      corsAllowed: false,
    };
    expect(safeTerminalStatus(r)).toBe(413);
  });

  test("defaults to 500 for unknown error", () => {
    const r = {
      status: 0,
      errorCode: 99,
      isPreflight: false,
      corsAllowed: false,
    };
    expect(safeTerminalStatus(r)).toBe(500);
  });
});

// ── Error code helpers ────────────────────────────────────────────────
describe("errorCodeName", () => {
  test("returns correct names", () => {
    expect(errorCodeName(ERR_CODE_NONE)).toBe("none");
    expect(errorCodeName(ERR_CODE_CORS_PREFLIGHT)).toBe("cors_preflight");
    expect(errorCodeName(ERR_CODE_RATE_LIMITED)).toBe("rate_limited");
    expect(errorCodeName(ERR_CODE_BODY_TOO_LARGE)).toBe("body_too_large");
    expect(errorCodeName(ERR_CODE_INVALID_JSON)).toBe("invalid_json");
    expect(errorCodeName(ERR_CODE_SCHEMA_VALIDATION)).toBe("schema_validation");
    expect(errorCodeName(ERR_CODE_BAD_REQUEST)).toBe("bad_request");
    expect(errorCodeName(ERR_CODE_REQUEST_TOO_LARGE)).toBe("request_too_large");
    expect(errorCodeName(ERR_CODE_INTERNAL)).toBe("internal");
  });

  test("unknown code returns 'unknown'", () => {
    expect(errorCodeName(255)).toBe("unknown");
  });
});

describe("errorMessage", () => {
  test("returns correct messages", () => {
    expect(errorMessage(403, ERR_CODE_CORS_PREFLIGHT)).toBe("CORS preflight rejected");
    expect(errorMessage(429, ERR_CODE_RATE_LIMITED)).toBe("Too many requests");
    expect(errorMessage(413, ERR_CODE_BODY_TOO_LARGE)).toBe("Request body too large");
    expect(errorMessage(400, ERR_CODE_INVALID_JSON)).toBe("Invalid JSON body");
    expect(errorMessage(422, ERR_CODE_SCHEMA_VALIDATION)).toBe("JSON schema validation failed");
    expect(errorMessage(400, ERR_CODE_BAD_REQUEST)).toBe("Bad request");
    expect(errorMessage(431, ERR_CODE_REQUEST_TOO_LARGE)).toBe("Request too large");
    expect(errorMessage(500, ERR_CODE_INTERNAL)).toBe("Internal server error");
  });

  test("defaults for unknown error code", () => {
    expect(errorMessage(500, 255)).toBe("Internal server error");
    expect(errorMessage(400, 255)).toBe("Request rejected");
  });
});

// ── buildResponseContext & buildTerminalResponse ─────────────────────
describe("buildTerminalResponse", () => {
  test("returns null for non-terminal result", () => {
    const ctx = buildResponseContext({});
    const r = {
      terminal: false,
      isPreflight: false,
      corsAllowed: false,
      errorCode: ERR_CODE_NONE,
      status: 200,
      headerVariant: 0,
      https: false,
      rateLimit: 0,
      rateRemaining: 0,
      rateResetMs: 0,
      retryAfterMs: 0,
    };

    const response = buildTerminalResponse(ctx, r, new Request("http://localhost"), "");
    expect(response).toBeNull();
  });

  test("returns 204 for preflight allowed", () => {
    const ctx = buildResponseContext({
      cors: { allowOrigin: ["*"] },
    });
    const r = {
      terminal: true,
      isPreflight: true,
      corsAllowed: true,
      errorCode: ERR_CODE_NONE,
      status: 200,
      headerVariant: 9, // HV_JSON | HV_CORS_SIMPLE | HV_CORS_PREFLIGHT
      https: false,
      rateLimit: 0,
      rateRemaining: 0,
      rateResetMs: 0,
      retryAfterMs: 0,
    };

    const response = buildTerminalResponse(ctx, r, new Request("http://localhost", {
      headers: { origin: "http://example.com" },
    }), "rid-001");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
  });

  test("returns JSON error for terminal error", () => {
    const ctx = buildResponseContext({});
    const r = {
      terminal: true,
      isPreflight: false,
      corsAllowed: false,
      errorCode: ERR_CODE_BODY_TOO_LARGE,
      status: 413,
      headerVariant: HV_JSON,
      https: false,
      rateLimit: 0,
      rateRemaining: 0,
      rateResetMs: 0,
      retryAfterMs: 0,
    };

    const response = buildTerminalResponse(ctx, r, new Request("http://localhost"), "rid-002");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(413);
    expect(response!.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("includes x-request-id header when requestId is provided", () => {
    const ctx = buildResponseContext({ enableSecurityHeaders: false });
    const r = {
      terminal: true,
      isPreflight: false,
      corsAllowed: false,
      errorCode: ERR_CODE_RATE_LIMITED,
      status: 429,
      headerVariant: HV_JSON,
      https: false,
      rateLimit: 0,
      rateRemaining: 0,
      rateResetMs: 0,
      retryAfterMs: 0,
    };

    const response = buildTerminalResponse(ctx, r, new Request("http://localhost"), "req-abc");
    expect(response!.headers.get("x-request-id")).toBe("req-abc");
  });
});

describe("headersForResult", () => {
  test("returns basic headers for minimal context", () => {
    const ctx = buildResponseContext({ enableSecurityHeaders: false });
    const r = {
      headerVariant: HV_JSON,
      corsAllowed: false,
      rateRemaining: 0,
      rateResetMs: 0,
      retryAfterMs: 0,
      https: false,
    };

    const headers = headersForResult(ctx, r, new Request("http://localhost"), "req-001");
    expect(headers.get("x-request-id")).toBe("req-001");
  });
});

describe("createIngressFast option validation", () => {
  test("throws with a clear message on unknown option keys", () => {
    // Misspelled keys would otherwise be silently ignored by the native addon.
    expect(() => createIngressFast({ parseQuer: true } as any)).toThrow(
      /unknown option 'parseQuer'/,
    );
  });

  test("accepts known option keys", () => {
    expect(() =>
      createIngressFast({ parseQuery: true, parseCookies: true }),
    ).not.toThrow();
  });
});

describe("shared rate limiter across instances", () => {
  test("same rate-limit config shares one budget (no route-splitting bypass)", () => {
    const rl = { rateLimit: { limit: 2, windowMs: 60_000 } };
    const a = createIngressFast(rl);
    const b = createIngressFast(rl);
    const ip = "203.0.113.10";
    const hit = (h: ReturnType<typeof createIngressFast>, rid: string) =>
      h.run(new Request("https://x.test/api", { method: "GET" }), ip, null, rid, (r) => r.status);

    // Budget of 2 shared across both instances.
    expect(hit(a, "0000000000000001")).toBe(200);
    expect(hit(b, "0000000000000002")).toBe(200);
    expect(hit(a, "0000000000000003")).toBe(429);
    expect(hit(b, "0000000000000004")).toBe(429);
  });
});