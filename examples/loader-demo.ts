// examples/loader-demo.ts — Higher-order data loader usage demo.
//
// Run: bun run examples/loader-demo.ts   (then hit the routes below)
//
// The loader (`castrum.loader`) is a higher-order function over the curated op
// set. It is the right tool when you process MANY values together — N same-tick
// items become ONE packed native batch call instead of N crossings. For a
// single value the direct `rust.*` scalar is marginally faster.
//
//   GET  /single  → one scalar dispatch           loader("validateEmail")(v)
//   POST /bulk    → ONE packed call for a list    loader("validateEmail")(vs)
//   POST /schema  → batch JSON-schema validation  loader.schema(v)(docs).count
//   GET  /hash    → batch HMAC-SHA256 in one call loader("hmacSha256")(vs, key)
//
// These are exactly the helpers exported as `src/integration/batch.ts`
// (validateMany / validateCount / runMany / runOne).

import { loader } from "../src/loader";
import { rust } from "../src/rust-ffi";
import { encoder } from "../src/shared/bytes";

const enc = encoder;

// Pre-bind specialized hot functions once (no per-call Map lookups).
const validateEmail = loader("validateEmail");
const hmac = loader("hmacSha256");
const schema = loader.schema(
  rust.createSchemaValidator(enc.encode(JSON.stringify({ type: "object", required: ["email"] }))),
);

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/single") {
      const ok = validateEmail(enc.encode("alice@example.com"));
      return Response.json({ ok });
    }

    if (url.pathname === "/bulk" && req.method === "POST") {
      const emails = (await req.json()) as string[];
      const bits = validateEmail(emails.map((e) => enc.encode(e)));
      return Response.json({ valid: [...bits] });
    }

    if (url.pathname === "/schema" && req.method === "POST") {
      const docs = (await req.json()) as Record<string, unknown>[];
      const count = schema.count(docs.map((d) => enc.encode(JSON.stringify(d))));
      return Response.json({ validCount: count });
    }

    if (url.pathname === "/hash") {
      const items = ["alpha", "beta", "gamma"].map((s) => enc.encode(s));
      const sigs = hmac(items, enc.encode("shared-secret"));
      return Response.json({ sigs: sigs.map((s) => Array.from(s)) });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("loader demo listening on http://localhost:3000");
