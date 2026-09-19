// bench/http/servers/native-program-server.ts — route-wire v5 zero-callout op
// program served END-TO-END (Bun.serve): one `castrum_route_run` per request
// makes the parse + CORS + security decisions AND emits the framed HTTP
// response; JS only packs the frame and materializes the `Response`.
//
// This is the "native declarative lane" participant for the server-bound
// ceiling measurement (bench/cost/native-route-server-bound.mjs). The route
// shape is parse_query + CORS(wildcard) + security headers + response
// projection — the zero-callout shape the executor supports today.
//
// Env knobs:
//   NATIVE_ROUTE_MEMO=1  build response headers through a per-origin memoized
//                        `Headers` (the fix candidate for the array-of-pairs
//                        `new Response` cost) instead of passing pairs.

import { METHOD_KIND } from "../../../src/ingress";
import { createNativeRoute } from "../../../src/ingress/native-route";
import { encoder, decoder } from "../../../src/shared/bytes";
import { generateRequestId } from "../../../src/shared/request-id";
import { envNumber } from "./shared";

const PORT = envNumber("NATIVE_PROGRAM_PORT", 9130, 1);
const MEMO = process.env.NATIVE_ROUTE_MEMO === "1";

const OK_RESPONSE = {
  status: 200,
  headers: [{ name: "content-type", value: "application/json" }],
  body: encoder.encode(`{"ok":true,"requestId":"{requestId}"}`),
};
const PROGRAM_OPTIONS = {
  parseQuery: true,
  cors: { allowOrigin: ["*"] },
  security: {},
  requestIdHeader: false,
};

const route = createNativeRoute({ response: OK_RESPONSE, program: PROGRAM_OPTIONS });

// Per-origin memoized response Headers (fix candidate). The native class
// templates only vary in the CORS origin for this route, so one Headers per
// origin is safe to reuse.
const memoByOrigin = new Map<string, Headers>();
function memoHeaders(origin: string, pairs: Array<[string, string]>): Headers {
  let h = memoByOrigin.get(origin);
  if (h === undefined) {
    h = new Headers();
    for (const [n, v] of pairs) h.set(n, v);
    memoByOrigin.set(origin, h);
  }
  return h;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  routes: {
    "/health": {
      GET: () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    },
    "/api/users": {
      GET: (req, srv) => {
        const url = req.url;
        const qIndex = url.indexOf("?");
        const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : "";
        const cookieStr = req.headers.get("cookie") ?? "";
        const origin = req.headers.get("origin");
        const ip = (srv as { requestIP?: (r: Request) => { address?: string } | null })
          ?.requestIP?.(req)?.address;
        const rid = decoder.decode(generateRequestId());
        const pre = {
          methodKind: METHOD_KIND.GET,
          ip: ip ?? "",
          headers: origin === null ? [] : ([["origin", origin]] as Array<[string, string]>),
          https: true,
        };
        const r = route.run(queryStr, cookieStr, null, pre, rid);
        if (r.errorCode !== 0 || r.response === undefined) {
          return Response.json(
            { ok: false, error: { code: "internal", message: "native route failed" } },
            { status: 500 },
          );
        }
        const resp = r.response;
        const body = resp.body.slice();
        const headers = MEMO
          ? memoHeaders(origin ?? "", resp.headers)
          : resp.headers;
        return new Response(body, { status: resp.status, headers });
      },
    },
  },
  fetch: () => new Response("Not Found", { status: 404 }),
});

console.log(`[native-program] listening on :${server.port} (memo=${MEMO})`);
