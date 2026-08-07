// test/integration/node-enterprise.test.mjs
//
// Enterprise Node.js coverage for the compiled ESM entry (`dist/index.js`):
//   - Buffer-as-input interop (the natural Node input type)
//   - the precompiled higher-order instances (JwtSigner/AeadCipher/Argon2Hasher/
//     MediaTypeMatcher + TemplateRenderer batch)
//   - node:crypto cross-checks, including chacha20-poly1305 (verifiable ONLY on
//     Node — Bun's node:crypto lacks it)
//   - node:http adapter hardening: keep-alive reuse, socket-level 413, malformed
//     request → castrum JSON 400, slowloris body timeout → 408
//
// Run with: bun run build:js && node --test test/integration/node-enterprise.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createCipheriv, randomBytes } from "node:crypto";

import * as castrum from "../../dist/index.js";

const encoder = new TextEncoder();

// ── 1. Buffer-as-input interop (Buffer extends Uint8Array) ────────
test("Node Buffer works as FFI input everywhere", () => {
  const buf = Buffer.from([104, 105]);
  assert.equal(castrum.rust.crc32(buf), 3633523372);
  assert.equal(castrum.rust.jsonValid(Buffer.from('{"a":1}')), true);

  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const data = Buffer.from("hello buffer");
  const sig = castrum.rust.hmacSha256(key, data);
  assert.equal(
    castrum.rust.hmacSha256Verify(key, data, sig),
    true,
    "hmac sign+verify with Buffer inputs",
  );
});

// ── 2. Precompiled higher-order instances ─────────────────────────
test("JwtSigner signs and verifies with a precompiled key", () => {
  const signer = castrum.rust.createJwtSigner(
    Buffer.from("super-secret-jwt-key"),
    3600,
  );
  const now = 1_000_000;
  const token = signer.sign({ sub: "123", role: "admin" }, now);
  const verified = signer.verify(token, now);
  assert.equal(verified.sub, "123");
  assert.equal(verified.iat, now);
  assert.equal(verified.exp, now + 3600);

  const other = castrum.rust.createJwtSigner(Buffer.from("other-secret"), 3600);
  assert.equal(other.verify(token, now), null);
});

test("AeadCipher roundtrips and matches node:crypto (AES-256-GCM)", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const nonce = Buffer.from("abcdefghijkl");
  const pt = Buffer.from("session payload");

  const cipher = castrum.rust.createAeadCipher(key);
  const ct = Buffer.from(cipher.encrypt(nonce, pt));
  assert.deepEqual(Buffer.from(cipher.decrypt(nonce, ct)), pt);
  assert.equal(ct.byteLength, pt.byteLength + 16);

  // Cross-check against node:crypto (Node's OpenSSL AES-256-GCM).
  const nodeCipher = createCipheriv("aes-256-gcm", key, nonce);
  const nodeCt = Buffer.concat([nodeCipher.update(pt), nodeCipher.final()]);
  const nodeTag = nodeCipher.getAuthTag();
  assert.deepEqual(Buffer.concat([nodeCt, nodeTag]), ct, "AES-256-GCM parity");
});

// Bun's node:crypto lacks chacha20-poly1305 — only Node/OpenSSL can verify it.
let CHACHA_SUPPORTED = true;
try {
  createCipheriv("chacha20-poly1305", randomBytes(32), randomBytes(12));
} catch {
  CHACHA_SUPPORTED = false;
}

test("AeadCipher chacha20-poly1305 cross-check (Node-only OpenSSL)", (t) => {
  if (!CHACHA_SUPPORTED) {
    t.skip("chacha20-poly1305 is unavailable in this runtime's node:crypto");
    return;
  }
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const pt = Buffer.from("cross-check payload");

  const nodeCipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  const nodeCt = Buffer.concat([nodeCipher.update(pt), nodeCipher.final()]);
  const nodeTag = nodeCipher.getAuthTag();
  const expected = Buffer.concat([nodeCt, nodeTag]);

  const aead = castrum.rust.createAeadCipher(key, "chacha20-poly1305");
  const got = Buffer.from(aead.encrypt(nonce, pt));
  assert.deepEqual(got, expected, "chacha20-poly1305 parity with node:crypto");
  assert.deepEqual(
    Buffer.from(aead.decrypt(nonce, got)),
    pt,
    "chacha decrypt roundtrip",
  );
});

test("Argon2Hasher + MediaTypeMatcher work under Node", () => {
  const hasher = castrum.rust.createArgon2Hasher({
    mCost: 4096,
    tCost: 2,
    pCost: 1,
  });
  const password = Buffer.from("correct horse battery staple");
  const salt = Buffer.from("0123456789abcdef");
  const phc = hasher.hash(password, salt);
  assert.equal(hasher.verify(password, phc), true);
  assert.equal(hasher.verify(Buffer.from("wrong"), phc), false);

  const matcher = castrum.rust.createMediaTypeMatcher(
    Buffer.from("Application/JSON"),
  );
  assert.equal(matcher.matches(Buffer.from("application/json; charset=utf-8")), true);
  assert.equal(matcher.matches(Buffer.from("text/html")), false);
});

test("TemplateRenderer.renderBatchPacked reuses the compiled template", () => {
  const renderer = castrum.rust.createTemplateRenderer("Hello {{ name }}!");
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, 2, true);
  const a = encoder.encode(JSON.stringify({ name: "Alice" }));
  const b = encoder.encode(JSON.stringify({ name: "Bob" }));
  const la = new Uint8Array(4);
  const lb = new Uint8Array(4);
  new DataView(la.buffer).setUint32(0, a.byteLength, true);
  new DataView(lb.buffer).setUint32(0, b.byteLength, true);
  const packed = new Uint8Array(4 + la.byteLength + a.byteLength + lb.byteLength + b.byteLength);
  let off = 0;
  for (const p of [count, la, a, lb, b]) {
    packed.set(p, off);
    off += p.byteLength;
  }
  const out = renderer.renderBatchPacked(packed);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(dv.getUint32(0, true), 2);
  const lenA = dv.getUint32(4, true);
  const sA = Buffer.from(out.subarray(8, 8 + lenA)).toString();
  assert.equal(sA, "Hello Alice!");
});

// ── 3. createIngressFast POST / JSON body through native ─────────
test("createIngressFast POST with requireJsonBody + schema", async () => {
  const schema = encoder.encode(
    JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }),
  );
  const fast = castrum.createIngressFast({
    requireJsonBody: true,
    schema,
    emitMetadataJson: true,
  });
  const req = new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":"alice"}',
  });
  const bodyBytes = new Uint8Array(await req.arrayBuffer());

  let captured;
  fast.run(req, "1.2.3.4", bodyBytes, "rid-1", (result) => {
    captured = {
      ok: result.ok,
      status: result.status,
      bodyValidJson: result.bodyValidJson,
      schemaValid: result.schemaValid,
      bodyTruncated: result.bodyTruncated,
    };
  });
  assert.deepEqual(captured, {
    ok: true,
    status: 200,
    bodyValidJson: true,
    schemaValid: true,
    bodyTruncated: false,
  });

  // Schema failure → 422.
  const bad = new Request("http://localhost/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"name":123}',
  });
  const badBytes = new Uint8Array(await bad.arrayBuffer());
  let badCaptured;
  fast.run(bad, "1.2.3.4", badBytes, "rid-2", (result) => {
    badCaptured = {
      status: result.status,
      bodyValidJson: result.bodyValidJson,
      schemaValid: result.schemaValid,
    };
  });
  assert.deepEqual(badCaptured, {
    status: 422,
    bodyValidJson: true,
    schemaValid: false,
  });
});

// ── 4. node:http adapter hardening ────────────────────────────────
function startServer(options) {
  const ingress = castrum.createIngressHandler(
    { emitMetadataJson: true, parseCookies: true, parseQuery: true },
    { outputBufferSize: 65536 },
  );
  const srv = castrum.createIngressServerNode({
    port: 0,
    routes: options.routes ?? {
      "/health": { read: ingress },
      "/write": { write: ingress, maxBodyBytes: 128, bodyTimeoutMs: 200 },
    },
    maxRequestBodySize: 1024,
    ...options.extra,
  });
  return { srv, port: srv.ready };
}

test("adapter serves keep-alive requests on one socket", async () => {
  const { srv, port } = startServer({});
  const p = await port;
  const http = await import("node:http");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const get = (path) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: p, path, agent, method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });

    assert.equal(await get("/health"), 200);
    assert.equal(await get("/health"), 200);
    // Let the agent pool the idle socket before introspecting it.
    await new Promise((r) => setTimeout(r, 50));
    // Same agent + single socket → the socket is reused (idle → freeSockets).
    const key = agent.getName({ host: "127.0.0.1", port: p });
    const inUse = (agent.sockets[key] ?? []).length;
    const free = (agent.freeSockets[key] ?? []).length;
    assert.equal(
      inUse + free,
      1,
      `keep-alive must reuse one socket (key=${key}, inUse=${inUse}, free=${free})`,
    );
  } finally {
    agent.destroy();
    srv.stop(true);
  }
});

test("adapter rejects oversized requests at the socket (413)", async () => {
  const { srv, port } = startServer({});
  const p = await port;
  try {
    const http = await import("node:http");
    const body = "x".repeat(4096); // > maxRequestBodySize (1024)

    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: p,
          path: "/health",
          method: "POST",
          headers: { "content-length": String(body.length) },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(status.status, 413);
    assert.match(status.data, /body_too_large/);
  } finally {
    srv.stop(true);
  }
});

test("adapter returns castrum JSON for a malformed request (clientError)", async () => {
  const { srv, port } = startServer({});
  const p = await port;
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, "127.0.0.1", () => {
        sock.write("garbage-not-http\r\n\r\n");
      });
      let data = "";
      sock.on("data", (c) => (data += c.toString()));
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        resolve(data);
      }, 2000);
    });
    assert.match(response, /400 Bad Request/);
    assert.match(response, /bad_request/);
  } finally {
    srv.stop(true);
  }
});

test("slowloris body read hits the route bodyTimeoutMs → 408", async () => {
  const { srv, port } = startServer({});
  const p = await port;
  try {
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(p, "127.0.0.1", () => {
        // Advertise a body UNDER the route maxBodyBytes (128) but never finish
        // sending it — readBodyWithLimit's deadline must fire → 408.
        sock.write(
          "POST /write HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: 50\r\n" +
            "\r\n" +
            '{"par',
        );
      });
      let data = "";
      sock.on("data", (c) => (data += c.toString()));
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        resolve(data);
      }, 2500);
    });

    // bodyTimeoutMs=200 fired while the body was still trickling → 408.
    assert.match(response, /408/);
    assert.match(response, /request_timeout/);
  } finally {
    srv.stop(true);
  }
});
