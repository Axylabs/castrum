/**
 * Tests for `createIngressServerNode` — the node:http adapter over the same
 * pre-baked route handlers as `createIngressServer` (Bun). Exercises the
 * adapter under bun test (node:http runs fine on Bun) so the Node path is
 * covered by the default suite, not only the Node CI job.
 */

import { describe, test, expect } from "bun:test";
import { createIngressHandler } from "../../../src/ingress/handlers";
import { createIngressServerNode } from "../../../src/ingress/server-node";

describe("createIngressServerNode", () => {
  test("serves GET through the pre-baked handlers over node:http", async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true });
    const srv = createIngressServerNode({
      port: 0,
      routes: { "/health": { read: ingress } },
    });

    const port = await srv.ready;
    expect(typeof port).toBe("number");

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { connection: "close" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);

    srv.stop();
  });

  test("unknown routes fall back to 404", async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true });
    const srv = createIngressServerNode({
      port: 0,
      routes: {},
      fallback: ingress,
    });

    const port = await srv.ready;
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { connection: "close" },
    });
    expect(res.status).toBe(404);
    srv.stop();
  });

  test("POST on a write route validates JSON and returns the ok wire format", async () => {
    const ingress = createIngressHandler({ emitMetadataJson: true });
    const srv = createIngressServerNode({
      port: 0,
      routes: { "/api/users": { read: ingress, write: ingress } },
    });

    const port = await srv.ready;
    const res = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; requestId?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.requestId).toBe("string");
    srv.stop();
  });
});
