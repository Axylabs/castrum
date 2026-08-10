/**
 * Tests for src/ingress/server.ts `buildRouteHandlers` — the pure route →
 * { method → handler } wiring shared by both `createIngressServer` (Bun) and
 * `createIngressServerNode` (node:http). No server is started here.
 */

import { describe, test, expect } from "bun:test";
import { buildRouteHandlers } from "../../../src/ingress/server";
import { createIngressHandler } from "../../../src/ingress/handlers";

const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
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

  test("write spec maps to POST/PUT/PATCH; OPTIONS only with a fallback", () => {
    const { routes } = buildRouteHandlers({
      routes: { "/api": { write: ingress } },
    });
    expect(typeof routes["/api"].POST).toBe("function");
    expect(typeof routes["/api"].PUT).toBe("function");
    expect(typeof routes["/api"].PATCH).toBe("function");
    expect(routes["/api"].OPTIONS).toBeUndefined();

    const withFallback = buildRouteHandlers({
      fallback: ingress,
      routes: { "/api": { write: ingress } },
    });
    expect(typeof withFallback.routes["/api"].OPTIONS).toBe("function");
  });

  test("echo and cookies specs map to their methods", () => {
    const { routes } = buildRouteHandlers({
      routes: { "/e": { echo: ingress }, "/c": { cookies: ingress } },
    });
    expect(typeof routes["/e"].POST).toBe("function");
    expect(typeof routes["/c"].GET).toBe("function");
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
