// examples/loader-demo.ts — Higher-order data loader usage demo.
//
// Run: bun run examples/loader-demo.ts   (then hit the routes below)
//
// The loader (`castrum.loader`) is a higher-order function over the curated op
// set. It is the right tool when you process MANY values together — N same-tick
// items become ONE packed native batch call instead of N crossings. For a
// single value the direct `rust.*` scalar is marginally faster.
//
//   GET  /single    → one scalar dispatch          loader("validateEmail")(v)
//   POST /bulk      → ONE packed call for a list   loader("validateEmail")(vs)
//   POST /schema    → batch JSON-schema validation loader.schema(v)(docs).count
//   GET  /hash      → batch HMAC-SHA256 in one call loader("hmacSha256")(vs, key)
//   GET  /load      → SAME-TICK `load()` coalescing (DataLoader-style): N
//                     loads in one event-loop tick flush as ONE packed batch.
//   POST /validate  → validateMany / validateCount (src/integration/batch.ts)
//   GET  /run       → runMany / runOne over the same curated ops

import { loader } from "../src/loader";
import { rust } from "../src/rust-ffi";
import { encoder } from "../src/shared/bytes";
import {
  validateMany,
  validateCount,
  runMany,
  runOne,
} from "../src/integration/batch";

const enc = encoder;

// Pre-bind specialized hot functions once (no per-call Map lookups).
const validateEmail = loader("validateEmail");
const hmac = loader("hmacSha256");
const schema = loader.schema(
  rust.createSchemaValidator(enc.encode(JSON.stringify({ type: "object", required: ["email"] }))),
);

// A `load()`-bound op with a small cache (so repeated emails skip re-validate).
const isEmail = loader("validateEmail", { maxCacheKeys: 256 });

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

    // Same-tick `load()` coalescing: all five loads are issued before the
    // event loop ticks, so they flush as ONE packed native batch call. Each
    // `load()` resolves to its own value; the cache makes repeated emails
    // (alice) resolve without re-validating.
    if (url.pathname === "/load") {
      const batchCallsBefore = isEmail.stats.batchCalls;
      const [a, b, c] = await Promise.all([
        isEmail.load(enc.encode("alice@example.com")),
        isEmail.load(enc.encode("bob@example.com")),
        isEmail.load(enc.encode("alice@example.com")),
      ]);
      return Response.json({
        results: [a, b, c],
        mode: isEmail.stats.mode,
        coalescedBatchCalls: isEmail.stats.batchCalls - batchCallsBefore,
      });
    }

    if (url.pathname === "/validate" && req.method === "POST") {
      const docs = (await req.json()) as Record<string, unknown>[];
      const encoded = docs.map((d) => enc.encode(JSON.stringify(d)));
      const bitset = validateMany(
        rust.createSchemaValidator(
          enc.encode(JSON.stringify({ type: "object", required: ["email"] })),
        ),
        encoded,
      );
      const count = validateCount(
        rust.createSchemaValidator(
          enc.encode(JSON.stringify({ type: "object", required: ["email"] })),
        ),
        encoded,
      );
      return Response.json({ valid: [...bitset], validCount: count });
    }

    if (url.pathname === "/run") {
      const items = ["alpha", "beta", "gamma"].map((s) => enc.encode(s));
      const sigs = runMany("hmacSha256", items, enc.encode("shared-secret"));
      const one = runOne("hmacSha256", enc.encode("alpha"), enc.encode("shared-secret"));
      return Response.json({
        sigs: sigs.map((s) => Array.from(s)),
        first: Array.from(one),
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log("loader demo listening on http://localhost:3000");
