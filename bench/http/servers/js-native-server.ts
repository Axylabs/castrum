// bench/http/servers/js-native-server.ts — the JS-equivalent of
// native-program-server.ts: a raw Bun.serve route that parses the query,
// evaluates wildcard CORS, merges the same security headers, and assembles the
// same JSON body — the work the native program replaces.
//
// Participant for the server-bound ceiling measurement
// (bench/cost/native-route-server-bound.mjs).

import { envNumber } from "./shared";

const PORT = envNumber("JS_NATIVE_PORT", 9131, 1);

// Mirrors the native program's security-header set (buildBakedSecurityEntries
// with an empty options object).
const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (qs.length === 0) return out;
  let start = 0;
  for (let i = 0; i <= qs.length; i++) {
    if (i === qs.length || qs.charCodeAt(i) === 38 /* & */) {
      const eq = qs.indexOf("=", start);
      if (eq >= 0 && eq < i) out[qs.slice(start, eq)] = qs.slice(eq + 1, i);
      start = i + 1;
    }
  }
  return out;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  routes: {
    "/health": {
      GET: () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    },
    "/api/users": {
      GET: (req) => {
        const url = req.url;
        const qIndex = url.indexOf("?");
        const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : "";
        const query = parseQuery(queryStr);
        const origin = req.headers.get("origin");
        const requestId = globalThis.crypto.randomUUID();
        const body = JSON.stringify({ ok: true, requestId, query });
        const headers: Record<string, string> = { ...SECURITY };
        headers["content-type"] = "application/json";
        if (origin !== null) {
          headers.vary = "Origin";
          headers["access-control-allow-origin"] = origin;
        }
        return new Response(body, { status: 200, headers });
      },
    },
  },
  fetch: () => new Response("Not Found", { status: 404 }),
});

console.log(`[js-native] listening on :${server.port}`);
