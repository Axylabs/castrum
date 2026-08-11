// examples/basic-server.ts — Minimal castrum server (pre-baked ingress).
//
// Shows the ergonomic public API end-to-end: the pre-baked ingress pipeline
// (`createIngressHandler` + `createIngressServer`) wired to real HTTP routes,
// plus a couple of `rust.*` primitives. Everything here is synchronous.
//
// Run with:
//   bun examples/basic-server.ts
//
// Then exercise it:
//   curl -i http://localhost:3000/health
//   curl -i -X POST http://localhost:3000/api/users \
//     -H 'content-type: application/json' -d '{"name":"Ada"}'
import { createIngressHandler, createIngressServer, rust } from "../index";

// ── rust.* primitives (zero-alloc, synchronous) ──────────────────────
const encoder = new TextEncoder();
console.log(
  "rust.validateEmail('ada@example.com') =>",
  rust.validateEmail(encoder.encode("ada@example.com")),
);
console.log("rust.crc32('hello') =>", rust.crc32(encoder.encode("hello")));

// ── Pre-baked ingress handler ────────────────────────────────────────
// Same options as createIngressFast; the handler packs the request frame in
// JS and drives the shared native core. Wire format: {"ok":true,...} on
// success, {"ok":false,"error":{...}} on errors, ratelimit-* headers.
const ingress = createIngressHandler({
  parseCookies: true,
  parseQuery: true,
  emitMetadataJson: true, // include url/ip/requestId in the response body
  cors: { allowOrigin: ["http://localhost:5173"] },
  rateLimit: { limit: 100, windowMs: 60_000 },
});

// ── Server (synchronous — wraps Bun.serve over the routes) ───────────
// Route keys map HTTP methods to the pre-baked handlers:
//   read    → GET + HEAD        write → POST + PUT + PATCH (+OPTIONS)
//   echo    → POST echo         cookies → GET + HEAD
const server = createIngressServer({
  port: 3000,
  routes: {
    "/health": { read: ingress },
    "/api/users": { read: ingress, write: ingress },
  },
  fallback: ingress, // any other path → 404
});

console.log(`listening on http://localhost:${server.port}`);
