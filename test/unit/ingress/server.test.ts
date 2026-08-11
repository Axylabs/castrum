/**
 * Tests for src/ingress/server.ts:
 * - `buildRouteHandlers` — the pure route → { method → handler } wiring shared
 *   by both `createIngressServer` (Bun) and `createIngressServerNode` (node:http)
 * - `gracefulShutdown` — signal-driven drain-then-force lifecycle
 * - `createIngressServer` — a REAL Bun.serve started on a random port
 */

import { describe, test, expect } from "bun:test";
import {
  buildRouteHandlers,
  createIngressServer,
  gracefulShutdown,
} from "../../../src/ingress/server";
import { createIngressHandler } from "../../../src/ingress/handlers";

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
});

// jsonWriteHandler treats a body as valid JSON only when requireJsonBody (or a
// schema) is configured, so the write route needs its own handler.
const writeIngress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  requireJsonBody: true,
});

describe("buildRouteHandlers", () => {
  test("read spec maps to GET and HEAD", () => {
    const { routes } = buildRouteHandlers({
      routes: { "/health": { read: ingress } },
    });
    const route = routes["/health"];
    expect(typeof route.GET).toBe("function");
    expect(typeof route.HEAD).toBe("function");
    expect(route.POST).toBeUndefined();
  });

  test("write spec maps to POST/PUT/PATCH; OPTIONS is wired for every route", () => {
    const { routes } = buildRouteHandlers({
      routes: { "/api": { write: ingress } },
    });
    expect(typeof routes["/api"].POST).toBe("function");
    expect(typeof routes["/api"].PUT).toBe("function");
    expect(typeof routes["/api"].PATCH).toBe("function");
    // CORS preflight is served for every route (not just with a fallback).
    expect(typeof routes["/api"].OPTIONS).toBe("function");
  });

  test("echo, cookies, delete specs map to their methods; read-only routes get OPTIONS", () => {
    const { routes } = buildRouteHandlers({
      routes: {
        "/e": { echo: ingress },
        "/c": { cookies: ingress },
        "/r": { delete: ingress },
        "/h": { read: ingress },
      },
    });
    expect(typeof routes["/e"].POST).toBe("function");
    expect(typeof routes["/c"].GET).toBe("function");
    expect(typeof routes["/r"].DELETE).toBe("function");
    expect(typeof routes["/h"].OPTIONS).toBe("function");
  });

  test("baseOpts carry getIp/copyBody", () => {
    const { baseOpts } = buildRouteHandlers({
      getIp: () => "1.2.3.4",
      copyBody: false,
      routes: {},
    });
    expect(baseOpts.getIp).toBeDefined();
    expect(baseOpts.copyBody).toBe(false);
  });

  test("a wired GET handler runs the real pipeline end to end", async () => {
    const { routes } = buildRouteHandlers({
      routes: { "/x": { read: ingress } },
    });
    const handler = routes["/x"].GET as (req: Request) => Response;
    const res = await handler(new Request("http://localhost:1/"));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.ok).toBe(true);
    expect(typeof body.requestId).toBe("string");
  });
});

describe("createIngressServer (real Bun.serve)", () => {
  test("routes GET + POST, 404 fallback, and stops cleanly", async () => {
    const srv = createIngressServer({
      port: 0,
      routes: {
        "/health": { read: ingress },
        "/api": { write: writeIngress },
      },
      fallback: ingress,
    });

    const port = srv.server.port ?? 0;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const healthBody = JSON.parse(await health.text()) as { ok: boolean };
      expect(healthBody.ok).toBe(true);

      const api = await fetch(`${base}/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      });
      expect(api.status).toBe(200);

      const fallback = await fetch(`${base}/nope`);
      expect(fallback.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  test("srv.port is the real bound port; DELETE + OPTIONS preflight work", async () => {
    const corsIngress = createIngressHandler({
      emitMetadataJson: true,
      cors: {
        allowOrigin: ["https://app.example.com"],
        allowMethods: ["GET", "DELETE"],
      },
    });
    const srv = createIngressServer({
      port: 0,
      routes: {
        "/items": { delete: corsIngress },
        "/health": { read: corsIngress },
      },
    });

    // `srv.port` is the ACTUAL bound port even with port: 0.
    const port = srv.port;
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    try {
      const del = await fetch(`${base}/items`, {
        method: "DELETE",
        headers: { origin: "https://app.example.com" },
      });
      expect(del.status).toBe(200);

      // CORS preflight on a READ-ONLY route: OPTIONS /health → 204 allowed.
      const pre = await fetch(`${base}/health`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "GET",
        },
      });
      expect(pre.status).toBe(204);
    } finally {
      srv.stop();
    }
  });
});

describe("gracefulShutdown", () => {
  test("soft-stops then force-closes after the grace period; cleanup detaches", async () => {
    const stops: Array<boolean | undefined> = [];
    const handle = {
      port: 1,
      stop: (force?: boolean) => {
        stops.push(force);
      },
    };
    const cleanup = gracefulShutdown([handle], {
      timeoutMs: 15,
      signals: ["SIGTERM"],
    });

    process.emit("SIGTERM");
    expect(stops).toEqual([false]); // soft stop (drain) first

    await Bun.sleep(40);
    expect(stops).toEqual([false, true]); // force-close after the grace period

    cleanup();
    const count = stops.length;
    process.emit("SIGTERM"); // after cleanup: no-op
    expect(stops.length).toBe(count);
  });

  test("a second signal during shutdown is ignored (idempotent)", async () => {
    const stops: Array<boolean | undefined> = [];
    const handle = {
      port: 1,
      stop: (force?: boolean) => {
        stops.push(force);
      },
    };
    const cleanup = gracefulShutdown([handle], {
      timeoutMs: 20,
      signals: ["SIGINT"],
    });

    process.emit("SIGINT");
    process.emit("SIGINT");
    expect(stops).toEqual([false]); // only one drain, despite two signals

    await Bun.sleep(50);
    expect(stops).toEqual([false, true]);
    cleanup();
  });

  test("ignores handles that throw on stop", () => {
    const stops: Array<boolean | undefined> = [];
    const bad = {
      port: 1,
      stop: () => {
        throw new Error("already stopped");
      },
    };
    const good = {
      port: 2,
      stop: (force?: boolean) => {
        stops.push(force);
      },
    };
    const cleanup = gracefulShutdown([bad, good], {
      timeoutMs: 10,
      signals: ["SIGTERM"],
    });

    expect(() => process.emit("SIGTERM")).not.toThrow();
    expect(stops).toEqual([false]);
    cleanup();
  });
});
