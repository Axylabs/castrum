/**
 * Tests for pooled output buffers in src/ingress/handlers.ts
 *
 * Covers:
 * - pooled run() returns correct, well-formed responses
 * - copy vs zero-copy modes produce identical bodies for the same request
 * - pooled run() serves terminal (error) responses without leaking/hanging
 * - jsonWriteHandler works end-to-end through the pooled path
 */

import { describe, test, expect } from "bun:test";
import {
  createIngressHandler,
  readHandler,
  jsonWriteHandler,
} from "../../../src/ingress/handlers";

const baseOptions = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
};

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9999${path}`, init);
}

describe("pooled ingress output buffers (handlers.ts)", () => {
  test("pooled run() returns a 200 ok:true response for a GET", async () => {
    const h = createIngressHandler(
      { ...baseOptions },
      { outputBufferSize: 131072 },
    );
    const res = await h.run<Response>(
      req("/health"),
      undefined,
      null,
      (result, ctx) => {
        const t = h.terminalResponse(req("/health"), result, ctx);
        // bodyJson returns a Uint8Array — a valid Response body (no BodyInit
        // global under the ESNext lib config).
        return (
          t ??
          new Response(result.bodyJson(true) as Uint8Array, { status: 200 })
        );
      },
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.ok).toBe(true);
    expect(typeof body.requestId).toBe("string");
  });

  test("copy and zero-copy modes produce identical bodies", async () => {
    const h = createIngressHandler(
      { ...baseOptions },
      { outputBufferSize: 131072 },
    );
    const r = req("/api/users?page=2&limit=10", {
      headers: { cookie: "sid=abc123; theme=dark" },
    });

    const copyRes = await readHandler(h, { copyBody: true })(r);
    const zeroRes = await readHandler(h, { copyBody: false })(r);

    expect(copyRes.status).toBe(200);
    expect(zeroRes.status).toBe(200);

    const copyParsed = JSON.parse(await copyRes.text()) as Record<string, unknown>;
    const zeroParsed = JSON.parse(await zeroRes.text()) as Record<string, unknown>;
    // request IDs legitimately differ per request — compare everything else
    const { requestId: _copyRid, ...copyRest } = copyParsed;
    const { requestId: _zeroRid, ...zeroRest } = zeroParsed;
    expect(zeroRest).toEqual(copyRest);
  });

  test("pooled run() serves terminal error responses (body too large)", async () => {
    const h = createIngressHandler({ ...baseOptions }, {});
    const bigBody = JSON.stringify({ name: "x".repeat(4096) });
    const res = await jsonWriteHandler(h, { maxBodyBytes: 128 })(
      req("/api/users", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(bigBody.length),
        },
        body: bigBody,
      }),
    );
    expect([413, 400]).toContain(res.status);
    await res.text(); // must not hang or throw
  });

  test("pooled jsonWriteHandler returns 200 for valid JSON without a schema", async () => {
    // Regression: with no schema configured, valid JSON must not be rejected
    // with 422 (FLAG_SCHEMA_VALID is set as a trivial pass in the native).
    const h = createIngressHandler(
      { ...baseOptions, requireJsonBody: true },
      {},
    );
    const res = await jsonWriteHandler(h, { maxBodyBytes: 1024 })(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada", age: 36 }),
      }),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
  });

  test("pooled jsonWriteHandler enforces a configured schema", async () => {
    const schema = new TextEncoder().encode(
      JSON.stringify({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: true,
      }),
    );
    const h = createIngressHandler(
      { ...baseOptions, requireJsonBody: true, schema },
      {},
    );
    const write = jsonWriteHandler(h, { maxBodyBytes: 1024 });

    const valid = await write(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      }),
    );
    expect(valid.status).toBe(200);

    const invalid = await write(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ age: 36 }),
      }),
    );
    expect(invalid.status).toBe(422);
  });

  test("jsonWriteHandler with no requireJsonBody/schema validates JSON itself", async () => {
    // Regression: when neither `requireJsonBody` nor a `schema` is configured
    // on the ingress, the pipeline skips JSON validation, so `bodyValidJson`/
    // `schemaValid` stay false. The write handler must still accept valid JSON
    // (200) and reject malformed/empty bodies (400) using the zero-DOM native
    // check — a shared `{ read, write }` ingress (the documented pattern) must
    // not 400 every valid POST.
    const h = createIngressHandler({ ...baseOptions }); // no requireJsonBody, no schema
    const write = jsonWriteHandler(h, { maxBodyBytes: 1024 });

    const valid = await write(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada", age: 36 }),
      }),
    );
    expect(valid.status).toBe(200);
    const parsed = JSON.parse(await valid.text()) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);

    const malformed = await write(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(malformed.status).toBe(400);
    const errBody = JSON.parse(await malformed.text()) as {
      error?: { code?: string };
    };
    expect(errBody.error?.code).toBe("invalid_json");

    const empty = await write(
      req("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      }),
    );
    expect(empty.status).toBe(400);
  });

  test("many sequential pooled requests keep working (no cross-request corruption)", async () => {
    const h = createIngressHandler(
      { ...baseOptions },
      { outputBufferSize: 131072 },
    );
    const read = readHandler(h, { copyBody: true });
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = await read(req(`/api/users?page=${i}`));
      expect(res.status).toBe(200);
      const body = JSON.parse(await res.text());
      expect(body.ok).toBe(true);
      expect(typeof body.requestId).toBe("string");
      seen.add(body.requestId as string);
    }
    // request IDs must all be distinct (pool reuse must not clobber them)
    expect(seen.size).toBe(50);
  });
});
