/**
 * Tests for src/ingress/context.ts — result snapshotting and synthetic/
 * internal context builders (previously untested).
 *
 * Covers:
 * - snapshotResult deep-snapshots fields and copies bodyJson (body aliases)
 * - syntheticContext renders 413 body-too-large in the fast-path wire format
 * - syntheticContext renders 408 request-timeout (ERR_CODE_REQUEST_TIMEOUT)
 * - internalContext renders a 500 internal-error context
 * - staticCorsAllowed honors allowOrigin / credentials rules
 */

import { describe, test, expect } from "bun:test";
import {
  snapshotResult,
  syntheticContext,
  internalContext,
  staticCorsAllowed,
} from "../../../src/ingress/context";
import { buildResponseContext } from "../../../src/ingress/headers/fast-templates";
import {
  ERR_CODE_BODY_TOO_LARGE,
  ERR_CODE_REQUEST_TIMEOUT,
} from "../../../src/ingress/constants";

const encoder = new TextEncoder();

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init);
}

/** Minimal stub result object satisfying the IngressResult shape. */
function stubResult(overrides: Partial<Parameters<typeof snapshotResult>[0]> = {}) {
  const cookies = "{\"sid\":\"a\"}";
  const query = "{\"page\":\"2\"}";
  const body = encoder.encode("{\"name\":\"ada\"}");

  return {
    status: 200,
    verdict: 0,
    flags: 0,
    errorCode: 0,
    terminal: false,
    ok: true,
    https: false,
    trustedProxy: false,
    hasCookies: true,
    hasQuery: true,
    bodyValidJson: true,
    schemaValid: true,
    corsAllowed: false,
    isPreflight: false,
    rateLimited: false,
    rateLimit: 0,
    rateRemaining: 0,
    rateResetMs: 0,
    retryAfterMs: 0,
    body,
    headerVariant: 0,
    requestId: "rid-1",
    bodyTruncated: false,
    cookiesJson: () => cookies,
    queryJson: () => query,
    bodyJson: () => body,
    ...overrides,
  };
}

describe("snapshotResult", () => {
  test("deep-snapshots scalar fields and lazy getters", () => {
    const r = stubResult();
    const snap = snapshotResult(r);

    expect(snap.ok).toBe(true);
    expect(snap.status).toBe(200);
    expect(snap.requestId).toBe("rid-1");
    expect(snap.cookiesJson()).toBe('{"sid":"a"}');
    expect(snap.queryJson()).toBe('{"page":"2"}');
  });

  test("bodyJson is a stable copy, safe after the live result is invalidated", () => {
    const r = stubResult();
    const snap = snapshotResult(r);

    const a = snap.bodyJson();
    const b = snap.bodyJson();
    expect(a).toEqual(encoder.encode('{"name":"ada"}'));
    // The snapshot copy is independent of the live result buffer.
    expect(a).not.toBe(r.body);
    // Each call returns the same stable copy (safe after invalidation).
    expect(b).toBe(a);
    // `body` aliases the original request-body buffer (documented; read-only).
    expect(snap.body).toBe(r.body);
  });
});

describe("syntheticContext / internalContext", () => {
  test("413 body-too-large renders in the fast-path wire format", async () => {
    const ctx = syntheticContext(
      req("/api"),
      "rid-1",
      {},
      buildResponseContext({}),
      413,
      ERR_CODE_BODY_TOO_LARGE,
    );

    expect(ctx.status).toBe(413);
    expect(ctx.ok).toBe(false);
    expect(ctx.terminal).toBe(true);
    expect(ctx.response).not.toBeNull();

    const body = JSON.parse(await (ctx.response as Response).text()) as {
      error: { code: string; status: number };
    };
    expect(body.error.code).toBe("body_too_large");
    expect(body.error.status).toBe(413);
  });

  test("408 request-timeout renders consistently (ERR_CODE_REQUEST_TIMEOUT)", async () => {
    const ctx = syntheticContext(
      req("/api"),
      "rid-1",
      {},
      buildResponseContext({}),
      408,
      ERR_CODE_REQUEST_TIMEOUT,
    );

    expect(ctx.status).toBe(408);
    const body = JSON.parse(await (ctx.response as Response).text()) as {
      error: { code: string; status: number; message: string };
    };
    expect(body.error.code).toBe("request_timeout");
    expect(body.error.status).toBe(408);
    expect(body.error.message).toMatch(/timed out/i);
  });

  test("internalContext renders a 500", async () => {
    const ctx = internalContext(req("/api"), "rid-1", {}, buildResponseContext({}));
    expect(ctx.status).toBe(500);
    expect(ctx.ok).toBe(false);
    const body = JSON.parse(await (ctx.response as Response).text()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("internal");
  });
});

describe("staticCorsAllowed", () => {
  test("denies when no CORS is configured", () => {
    expect(staticCorsAllowed({}, req("/api", { headers: { origin: "https://a.com" } }))).toBe(
      false,
    );
  });

  test("allows a matching origin from the allowlist", () => {
    const options = { cors: { allowOrigin: ["https://a.com"] } };
    expect(
      staticCorsAllowed(options, req("/api", { headers: { origin: "https://a.com" } })),
    ).toBe(true);
    expect(
      staticCorsAllowed(options, req("/api", { headers: { origin: "https://evil.com" } })),
    ).toBe(false);
  });

  test("wildcard is denied when credentials are required", () => {
    expect(
      staticCorsAllowed(
        { cors: { allowOrigin: ["*"], allowCredentials: true } },
        req("/api", { headers: { origin: "https://a.com" } }),
      ),
    ).toBe(false);
  });
});
