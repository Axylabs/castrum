/**
 * Tests for the global higher-order-function data loader (`castrum.loader`).
 *
 * Covers: the HFC shape (`loader(op)` returns a specialized hot fn), scalar
 * parity, bulk (batch) parity vs `rust.batch.*`, the adaptive single-vs-bulk
 * dispatch, DataLoader-style microtask coalescing, the bounded LRU cache, and
 * the hmac batch wiring.
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";
import {
  createLoader,
  loader,
  LOADER_OP_NAMES,
  type LoaderOpName,
} from "../../../src/loader";

const bytes = (s: string): Uint8Array => encoder.encode(s);

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMAIL_OK = bytes("alice@example.com");
const EMAIL_BAD = bytes("not-an-email");
const JSON_OK = bytes('[{"id":1,"name":"alice"},{"id":2}]');
const QUERY = bytes("a=1&b=hello%20world&flag");
const UUID_OK = bytes("123e4567-e89b-12d3-a456-426614174000");
const HMAC_KEY = bytes("secret");
const HMAC_DATA = bytes("hello world");

describe("loader: higher-order function shape", () => {
  test("loader(op) returns a specialized, memoized hot function", () => {
    const a = loader("validateEmail");
    const b = loader("validateEmail");

    expect(typeof a).toBe("function");
    expect(a).toBe(b); // memoized — no registry dispatch on repeat calls
    expect(a.name).toBe("validateEmail");
    expect(a.stats).toBeDefined();
    expect(typeof a.clear).toBe("function");
    expect(typeof a.cache).toBe("function");
    expect(typeof a.load).toBe("function");
  });

  test("opNames exposes the curated set", () => {
    expect(LOADER_OP_NAMES).toContain("validateEmail");
    expect(LOADER_OP_NAMES).toContain("hmacSha256");
    expect(LOADER_OP_NAMES).toContain("crc32");
  });

  test("ops with required extra args do not expose load()", () => {
    const fn = loader("hmacSha256");
    expect(fn.load).toBeUndefined();
    expect(() => loader.load("hmacSha256", HMAC_DATA)).toThrow(
      /requires extra arguments/,
    );
  });
});

describe("loader: scalar parity", () => {
  test("single item → scalar result, matching rust.<op>", () => {
    const isEmail = loader("validateEmail");
    expect(isEmail(EMAIL_OK)).toBe(rust.validateEmail(EMAIL_OK));
    expect(isEmail(EMAIL_BAD)).toBe(rust.validateEmail(EMAIL_BAD));

    expect(loader("crc32")(HMAC_DATA)).toBe(rust.crc32(HMAC_DATA));
    expect(loader("jsonSumIds")(JSON_OK)).toBe(rust.jsonSumIds(JSON_OK));
    expect(loader("jsonValid")(JSON_OK)).toBe(rust.jsonValid(JSON_OK));
  });

  test("single item with extra args → scalar, matching rust.<op>", () => {
    const sign = loader("signCookie");
    expect(sign(HMAC_DATA, HMAC_KEY)).toEqual(rust.signCookie(HMAC_DATA, HMAC_KEY));

    const hmac = loader("hmacSha256");
    expect(hmac(HMAC_DATA, HMAC_KEY)).toEqual(rust.hmacSha256(HMAC_KEY, HMAC_DATA));

    const csrf = loader("csrfVerify");
    const token = rust.csrfToken(HMAC_KEY);
    expect(csrf(token, HMAC_KEY)).toBe(rust.csrfVerify(token, HMAC_KEY));
  });

  test("run(op, single) is the scalar path", () => {
    const before = loader.stats.scalarCalls;
    expect(loader.run("validateUuid", UUID_OK)).toBe(rust.validateUuid(UUID_OK));
    expect(loader.stats.scalarCalls).toBeGreaterThan(before);
  });
});

describe("loader: bulk (batch) parity", () => {
  test("array input → one packed batch call, matching rust.batch.<op>", () => {
    const emails = [EMAIL_OK, EMAIL_BAD, EMAIL_OK];
    const rustBits = rust.batch.validateEmail(emails);
    const loaderBits = loader("validateEmail")(emails);
    expect([...loaderBits]).toEqual([...rustBits]);

    const crc = loader("crc32")([HMAC_DATA, EMAIL_OK]);
    expect([...crc]).toEqual([...rust.batch.crc32([HMAC_DATA, EMAIL_OK])]);

    const sum = loader("jsonSumIds")([EMAIL_OK, EMAIL_BAD]);
    expect([...sum]).toEqual([...rust.batch.jsonSumIds([EMAIL_OK, EMAIL_BAD])]);

    const q = loader("queryParse")([QUERY]);
    expect(q.length).toBe(1);
    expect(q[0]).toEqual(rust.batch.queryParse([QUERY])[0]);
  });

  test("bytes ops bulk → Uint8Array[]; hmac batch wired through", () => {
    const items = [HMAC_DATA, EMAIL_OK];
    const got = loader("hmacSha256")(items, HMAC_KEY);
    const expected = rust.batch.hmacSha256(items, HMAC_KEY);
    expect(got.length).toBe(2);
    expect(got[0]).toEqual(expected[0]);
    expect(got[1]).toEqual(expected[1]);
  });

  test("skip-on-error ops degrade per-item (no throw)", () => {
    const bits = loader("jsonValid")([JSON_OK, bytes("{broken")]);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });

  test("run(op, bulk) increments the batch counter", () => {
    const l = createLoader();
    const before = l.stats.batchCalls;
    l.run("validateEmail", [EMAIL_OK, EMAIL_BAD]);
    expect(l.stats.batchCalls).toBe(before + 1);
  });
});

describe("loader: adaptive scalar-loop fallback", () => {
  test("batchMin forces tiny bulks through the scalar loop with identical shape", () => {
    // adaptive:false pins the threshold; batchMin:8 → n=2 routes to scalar loop.
    const l = createLoader({ adaptive: false, batchMin: 8 });
    const before = l.stats.scalarCalls;
    const got = l.run("validateEmail", [EMAIL_OK, EMAIL_BAD]);
    expect([...got]).toEqual([...rust.batch.validateEmail([EMAIL_OK, EMAIL_BAD])]);
    expect(l.stats.scalarCalls).toBeGreaterThan(before);
    expect(l.stats.batchCalls).toBe(0);
  });

  test("default (batchMin=2) batches n>=2", () => {
    const l = createLoader();
    const before = l.stats.batchCalls;
    l.run("validateEmail", [EMAIL_OK, EMAIL_BAD]);
    expect(l.stats.batchCalls).toBe(before + 1);
  });
});

describe("loader: microtask coalescing (load)", () => {
  test("same-tick loads coalesce into ONE native batch call", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    const beforeBatch = l.stats.batchCalls;
    const beforeFlushes = l.stats.flushes;

    const [r1, r2, r3] = await Promise.all([
      isEmail.load(EMAIL_OK),
      isEmail.load(EMAIL_BAD),
      isEmail.load(EMAIL_OK),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(r3).toBe(true);
    expect(l.stats.flushes).toBe(beforeFlushes + 1);
    expect(l.stats.batchCalls).toBe(beforeBatch + 1); // ONE packed call, not 3
  });

  test("results resolve in enqueue order", async () => {
    const l = createLoader();
    const results: (string | null)[] = [];
    const p1 = l("validateEmail").load(EMAIL_OK);
    const p2 = l("validateEmail").load(EMAIL_BAD);
    const p3 = l("validateEmail").load(EMAIL_OK);
    results.push((await p1) ? "ok" : "no");
    results.push((await p2) ? "ok" : "no");
    results.push((await p3) ? "ok" : "no");
    expect(results).toEqual(["ok", "no", "ok"]);
  });

  test("different ops in one tick flush separately", async () => {
    const l = createLoader();
    const before = l.stats.flushes;
    const [e, c] = await Promise.all([
      l("validateEmail").load(EMAIL_OK),
      l("crc32").load(HMAC_DATA),
    ]);
    expect(e).toBe(true);
    expect(c).toBe(rust.crc32(HMAC_DATA));
    expect(l.stats.flushes).toBeGreaterThan(before);
  });

  test("a single load in a tick uses the scalar path", async () => {
    const l = createLoader();
    const beforeScalar = l.stats.scalarCalls;
    const value = await l("validateEmail").load(EMAIL_OK);
    expect(value).toBe(true);
    expect(l.stats.scalarCalls).toBeGreaterThan(beforeScalar);
  });
});

describe("loader: hot-function cache (LRU)", () => {
  test("default key = fnv1a64(input); repeat loads hit the cache", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");

    expect(isEmail.cache(EMAIL_OK)).toBeUndefined(); // cold
    await isEmail.load(EMAIL_OK);
    expect(isEmail.cache(EMAIL_OK)).toBe(true); // warmed, default fnv1a64 key

    const hitsBefore = l.stats.cachedHits;
    const again = await isEmail.load(EMAIL_OK);
    expect(again).toBe(true);
    expect(l.stats.cachedHits).toBe(hitsBefore + 1); // no native compute
  });

  test("explicit key opts into caching and dedupes same-tick computes", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    const beforeBatch = l.stats.batchCalls;

    const [a, b] = await Promise.all([
      isEmail.load(EMAIL_OK, { key: "k1" }),
      isEmail.load(EMAIL_OK, { key: "k1" }), // same key → same tick
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(l.stats.batchCalls).toBe(beforeBatch + 1);
    expect(isEmail.cache(EMAIL_OK, "k1")).toBe(true);
  });

  test("LRU evicts the oldest key when capacity is exceeded", async () => {
    const l = createLoader({ maxCacheKeys: 3 });
    const crc = l("crc32");
    for (let i = 0; i < 4; i++) {
      await crc.load(bytes(`item-${i}`), { key: `k${i}` });
    }
    expect(l.stats.cacheEvictions).toBe(1);
    // k0 was evicted (oldest); k1..k3 are resident.
    expect(crc.cache(bytes("item-0"), "k0")).toBeUndefined();
    expect(crc.cache(bytes("item-3"), "k3")).toBe(rust.crc32(bytes("item-3")));
  });

  test("cache:false opts out for a single load", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    await isEmail.load(EMAIL_OK, { cache: false });
    expect(isEmail.cache(EMAIL_OK)).toBeUndefined();
  });

  test("clear() empties the shared cache", async () => {
    const l = createLoader();
    await l("validateEmail").load(EMAIL_OK);
    expect(l("validateEmail").cache(EMAIL_OK)).toBe(true);
    l.clear();
    expect(l("validateEmail").cache(EMAIL_OK)).toBeUndefined();
  });
});

describe("loader: configure() keeps dispatch + stats on the current context", () => {
  test("memoized op fn picks up the new cost model after configure", () => {
    const l = createLoader({ adaptive: false, batchMin: 2 });
    const isEmail = l("validateEmail");
    isEmail(EMAIL_OK);
    expect(isEmail.stats.batchMin).toBe(2);

    l.configure({ batchMin: 8 }); // a stale capture would keep reporting 2
    expect(isEmail.stats.batchMin).toBe(8);

    // n=2 now routes through the scalar loop (threshold raised), so the batch
    // counter must not advance.
    const beforeBatch = l.stats.batchCalls;
    l.run("validateEmail", [EMAIL_OK, EMAIL_BAD]);
    expect(l.stats.batchCalls).toBe(beforeBatch);
  });

  test("opFn dispatches stay visible in loader.stats after configure", () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    l.configure({ sampleEvery: 64 }); // rebuilds ctxs + rebinds op fns
    const before = l.stats.scalarCalls;
    isEmail(EMAIL_OK);
    expect(l.stats.scalarCalls).toBeGreaterThan(before);
  });

  test("configure clamps batchMin and rebuilds the cache on capacity change", async () => {
    const l = createLoader({ maxCacheKeys: 5 });
    l.configure({ batchMin: 99 });
    expect(l("validateEmail").stats.batchMin).toBe(8); // clamped to [2, 8]

    await l("validateEmail").load(EMAIL_OK); // populate the old cache
    l.configure({ maxCacheKeys: 10 });
    expect(l.stats.cacheSize).toBe(0); // rebuilt → old entries are gone
  });
});

describe("loader: edge shapes and error semantics", () => {
  test("empty bulk returns the correct empty result without throwing", () => {
    const l = createLoader();
    expect([...(l("validateEmail")([]) as Uint8Array)]).toEqual([]);
    expect([...(l("crc32")([]) as Uint32Array)]).toEqual([]);
    expect([...(l("jsonSumIds")([]) as BigInt64Array)]).toEqual([]);
    expect(l("queryParse")([])).toEqual([]);
    expect(l.stats.batchCalls).toBe(0); // empty bulk never takes the batch path
  });

  test("coalesced groups mirror rust.batch skip-on-error semantics", async () => {
    const l = createLoader();
    const sum = l("jsonSumIds");
    const badShape = bytes('{"id":1}'); // invalid shape → batch skips it (0n)
    const [a, b, c] = await Promise.all([
      sum.load(JSON_OK),
      sum.load(badShape),
      sum.load(JSON_OK),
    ]);
    // The packed batch is skip-on-error, matching rust.batch.jsonSumIds.
    expect(a).toBe(3n);
    expect(b).toBe(0n); // skipped, not thrown
    expect(c).toBe(3n);
  });

  test("a single coalesced load of a throwing input rejects (scalar path)", async () => {
    const l = createLoader();
    const sum = l("jsonSumIds");
    // n=1 routes through the scalar op, which throws on the invalid shape.
    await expect(sum.load(bytes('{"id":1}'))).rejects.toThrow(
      /expected an array/,
    );
  });

  test("load() on optional-arg ops coalesces with default args", async () => {
    const l = createLoader();
    const enc = l("base64Encode");
    const got = await enc.load(bytes("hello"));
    expect(got).toEqual(rust.base64Encode(bytes("hello"))); // default urlSafe=false, padding=true
  });

  test("cache keys are namespaced per op (no cross-op collision)", async () => {
    const l = createLoader();
    await l("validateEmail").load(EMAIL_OK);
    await l("crc32").load(EMAIL_OK);
    expect(l("validateEmail").cache(EMAIL_OK)).toBe(true);
    expect(l("crc32").cache(EMAIL_OK)).toBe(rust.crc32(EMAIL_OK));
  });
});

describe("loader: load() availability guard", () => {
  test("load() exists on no-rest ops and is absent on required-rest ops", () => {
    // Mirrors `hasRequiredRest` in src/loader/index.ts — guards against drift
    // between the LoadableName type and the runtime allowlist. Includes every
    // op with required extra args OR per-item companions (can't be coalesced).
    const REQUIRED_REST: LoaderOpName[] = [
      "signCookie",
      "verifyCookie",
      "csrfVerify",
      "passwordHash",
      "passwordVerify",
      "hmacSha256",
      "hmacSha256Verify",
      "aeadEncrypt",
      "aeadDecrypt",
      "jwtSign",
      "jwtVerify",
      "jsonPatch",
      "urlResolve",
      "wsFrameEncode",
      "schemaValidate",
    ];
    const l = createLoader();
    for (const name of LOADER_OP_NAMES) {
      const fn = l(name);
      if (REQUIRED_REST.includes(name)) {
        expect(fn.load, name).toBeUndefined();
      } else {
        expect(typeof fn.load, name).toBe("function");
      }
    }
  });
});

describe("loader: load-aware single↔coalesce strategy", () => {
  test("low sustained load switches load() to direct singles (no flush)", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    // 4 isolated single loads (unique inputs so they reach the flush, not the
    // cache) → each flushes alone → streak reaches SINGLE_AFTER.
    for (let i = 0; i < 4; i++) {
      expect(await isEmail.load(bytes(`user${i}@example.com`))).toBe(true);
    }
    expect(isEmail.stats.mode).toBe("single");

    const flushesBefore = l.stats.flushes;
    const scalarBefore = l.stats.scalarCalls;
    expect(await isEmail.load(EMAIL_BAD)).toBe(false);
    // Single mode dispatches the scalar directly — no coalescer flush.
    expect(l.stats.flushes).toBe(flushesBefore);
    expect(l.stats.scalarCalls).toBeGreaterThan(scalarBefore);
  });

  test("a same-tick burst switches a single-mode op back to bulk", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    // Unique inputs so the streak is built from real flushes, not cache hits.
    for (let i = 0; i < 4; i++) {
      await isEmail.load(bytes(`user${i}@example.com`));
    }
    expect(isEmail.stats.mode).toBe("single");

    const flushesBefore = l.stats.flushes;
    const [a, b, c] = await Promise.all([
      isEmail.load(EMAIL_OK),
      isEmail.load(EMAIL_BAD),
      isEmail.load(EMAIL_OK),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(c).toBe(true);
    expect(isEmail.stats.mode).toBe("coalesce"); // burst → back to bulk
    expect(l.stats.flushes).toBe(flushesBefore + 1); // ONE coalesced flush
  });

  test("loadStrategy: 'single' dispatches direct scalars from the start", async () => {
    const l = createLoader({ loadStrategy: "single" });
    const before = l.stats.scalarCalls;
    expect(await l("validateEmail").load(EMAIL_OK)).toBe(true);
    expect(l.stats.scalarCalls).toBeGreaterThan(before);
    expect(l.stats.flushes).toBe(0); // never touched the coalescer
  });

  test("loadStrategy: 'coalesce' always batches same-tick loads", async () => {
    const l = createLoader({ loadStrategy: "coalesce" });
    const before = l.stats.batchCalls;
    const [a, b] = await Promise.all([
      l("validateEmail").load(EMAIL_OK),
      l("validateEmail").load(EMAIL_BAD),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(l.stats.batchCalls).toBe(before + 1);
  });
});

describe("loader: adaptive default cache key", () => {
  test("keys are skipped once inputs prove unique (no cache growth)", async () => {
    const l = createLoader();
    const crc = l("crc32");
    for (let i = 0; i < 8; i++) {
      await crc.load(bytes(`unique-${i}`)); // warm-up keys all computed
    }
    expect(l.stats.cacheSize).toBe(8);
    for (let i = 8; i < 12; i++) {
      await crc.load(bytes(`unique-${i}`)); // keys skipped → no writes
    }
    expect(l.stats.cacheSize).toBe(8);
    expect(crc.cache(bytes("unique-9"))).toBeUndefined();
  });

  test("repeated inputs still hit the cache (keys not skipped)", async () => {
    const l = createLoader();
    const isEmail = l("validateEmail");
    // Warm up the cache with the repeated key (keys computed during warm-up).
    expect(await isEmail.load(EMAIL_OK)).toBe(true);
    expect(isEmail.cache(EMAIL_OK)).toBe(true);
    // Keep computing keys for the repeated workload (keyHits > 0).
    expect(await isEmail.load(EMAIL_OK)).toBe(true);
    expect(l.stats.cachedHits).toBeGreaterThan(0);
  });
});

// ── Expanded op coverage: hashing / url / mime / ws / base64url ─────────────

const SECRET = bytes("s3cr3t");
const FOO = bytes("foobar");
const RAW_FBFF = new Uint8Array([0xfb, 0xff]);
const AEAD_KEY = new Uint8Array(32).fill(7);
const AEAD_NONCE = new Uint8Array(12).fill(1);

describe("loader: expanded byte ops — scalar + bulk parity", () => {
  test("fnv1a64 scalar + bulk match rust (unsigned)", () => {
    const l = createLoader({ adaptive: false });
    expect(l("fnv1a64")(FOO)).toBe(rust.fnv1a64(FOO));
    const bulk = l("fnv1a64")([FOO, bytes("a")]);
    expect(bulk).toBeInstanceOf(BigUint64Array);
    expect(bulk[0]).toBe(rust.fnv1a64(FOO));
    expect(bulk[1]).toBe(rust.fnv1a64(bytes("a")));
    // Bulk element equals the scalar (parity contract).
    expect(bulk[0]).toBe(l("fnv1a64")(FOO));
  });

  test("fnv1a64 adaptive scalar-loop fallback stays unsigned", () => {
    // batchMin=8 forces n=2 through the scalar loop, which must still build a
    // BigUint64Array so high-bit hashes keep parity with the packed batch.
    const l = createLoader({ adaptive: false, batchMin: 8 });
    const bulk = l("fnv1a64")([FOO, bytes("a")]);
    expect(bulk).toBeInstanceOf(BigUint64Array);
    expect(bulk[0]).toBe(rust.fnv1a64(FOO));
    expect(bulk[1]).toBe(l("fnv1a64")(bytes("a")));
  });

  test("etag scalar + bulk match rust (strong + weak)", () => {
    const l = createLoader({ adaptive: false });
    expect(l("etag")(bytes("123456789"))).toEqual(
      rust.etag(bytes("123456789")),
    );
    const weak = l("etag")([bytes("123456789")], true);
    expect(weak[0]).toEqual(bytes('W/"cbf43926"'));
    const strong = l("etag")([bytes("123456789")]);
    expect(strong[0]).toEqual(bytes('"cbf43926"'));
  });

  test("url/base64url/ws/mime scalar + bulk match rust", () => {
    const l = createLoader({ adaptive: false });
    // urlEncode / urlDecode / urlDecodeBytes
    expect(l("urlEncode")(bytes("a b&c"))).toEqual(rust.urlEncode(bytes("a b&c")));
    expect(l("urlEncode")([bytes("a b&c")])[0]).toEqual(bytes("a%20b%26c"));
    expect(l("urlDecode")([bytes("a%20b")])[0]).toEqual(bytes("a b"));
    const utf8 = new Uint8Array([0xc3, 0xa9]);
    expect(l("urlDecodeBytes")([bytes("%C3%A9")])[0]).toEqual(utf8);
    // base64url
    expect(l("base64UrlEncode")(RAW_FBFF)).toEqual(bytes("-_8"));
    expect(l("base64UrlDecode")(bytes("-_8"))).toEqual(RAW_FBFF);
    expect(l("base64UrlEncode")([RAW_FBFF])[0]).toEqual(bytes("-_8"));
    // wsAcceptKey (vector matches the scalar test in rust/payload/websocket.rs)
    const ws = l("wsAcceptKey")([bytes("dGhlIHNhbXBsZSBub25jZQ==")]);
    expect(ws[0]).toEqual(bytes("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    // mime
    expect(l("mimeFromExtension")(bytes(".js"))).toEqual(bytes("text/javascript"));
    expect(l("mimeFromExtension")([bytes("PNG")])[0]).toEqual(bytes("image/png"));
  });
});

describe("loader: backend-feature op parity (aead/ws/sse/jwtSign)", () => {
  test("aeadEncrypt/aeadDecrypt scalar + bulk round-trip", () => {
    const l = createLoader({ adaptive: false });
    const ct = l("aeadEncrypt")(bytes("plaintext"), AEAD_KEY, AEAD_NONCE, "aes-256-gcm");
    expect(ct).toEqual(rust.aeadEncrypt(AEAD_KEY, AEAD_NONCE, bytes("plaintext"), "aes-256-gcm"));
    expect(l("aeadDecrypt")(ct, AEAD_KEY, AEAD_NONCE, "aes-256-gcm")).toEqual(bytes("plaintext"));
    // bulk: encrypt N, decrypt N — per-item nonce derivation matches scalar order
    const cts = l("aeadEncrypt")([bytes("one"), bytes("two")], AEAD_KEY, AEAD_NONCE, "aes-256-gcm");
    const pts = l("aeadDecrypt")(cts, AEAD_KEY, AEAD_NONCE, "aes-256-gcm");
    expect(pts[0]).toEqual(bytes("one"));
    expect(pts[1]).toEqual(bytes("two"));
  });

  test("wsFrameEncode bulk matches rust.batch", () => {
    const l = createLoader({ adaptive: false });
    const got = l("wsFrameEncode")([bytes("hi")], 1, false, true);
    expect(got[0]).toEqual(rust.batch.wsFrameEncode([bytes("hi")], 1, false, true)[0]);
    // scalar parity
    expect(l("wsFrameEncode")(bytes("hi"), 1, false, true)).toEqual(
      rust.wsFrameEncode(1, bytes("hi"), false, true),
    );
  });

  test("sseEncode scalar + bulk match rust", () => {
    const l = createLoader({ adaptive: false });
    expect(l("sseEncode")(bytes("hi"), "evt", "id1", 3000)).toEqual(
      rust.sseEncodeEvent("evt", bytes("hi"), "id1", 3000),
    );
    expect(l("sseEncode")([bytes("hi")], "evt")[0]).toEqual(
      rust.batch.sseEncode([bytes("hi")], "evt")[0],
    );
  });

  test("jwtSign scalar + bulk produce identical tokens", () => {
    const l = createLoader({ adaptive: false });
    const claims = bytes('{"sub":"1"}');
    const single = l("jwtSign")(claims, SECRET, null, 1700000000);
    expect(single).toEqual(
      rust.jwtSign(JSON.parse("{\"sub\":\"1\"}") as Record<string, unknown>, SECRET, null, 1700000000),
    );
    const bulk = l("jwtSign")([claims], SECRET, null, 1700000000);
    expect(bulk[0]).toEqual(single);
    expect(rust.batch.jwtVerify(bulk, SECRET, 1700000000)[0]).toBe(1);
  });
});

describe("loader: boolean-validity ops (verifyCookie, jwtVerify)", () => {
  test("verifyCookie single returns valid/invalid matching the batch bitset", () => {
    const l = createLoader({ adaptive: false });
    const signed = rust.signCookie(bytes("abc"), SECRET);
    expect(l("verifyCookie")(signed, SECRET)).toBe(true);
    expect(l("verifyCookie")(bytes("abc"), SECRET)).toBe(false);
    const bits = l("verifyCookie")([signed, bytes("abc")], SECRET);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
    // The batch element equals the scalar (parity contract).
    expect(bits[0] === 1).toBe(l("verifyCookie")(signed, SECRET));
  });

  test("jwtVerify single returns valid/invalid matching the batch bitset", () => {
    const l = createLoader({ adaptive: false });
    const token = rust.jwtSign({ sub: "1" }, SECRET, null, 1700000000);
    expect(l("jwtVerify")(token, SECRET, 1700000000)).toBe(true);
    expect(l("jwtVerify")(bytes("bogus"), SECRET, 1700000000)).toBe(false);
    const bits = l("jwtVerify")([token, bytes("bogus")], SECRET, 1700000000);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });
});

describe("loader: paired ops (jsonPatch, hmacSha256Verify, passwordVerify, urlResolve)", () => {
  test("jsonPatch scalar + bulk (packed + scalar-loop fallback)", () => {
    const doc = bytes('{"a":1}');
    const patch = bytes('[{"op":"add","path":"/b","value":2}]');
    const expected = bytes('{"a":1,"b":2}');
    const l = createLoader({ adaptive: false });
    // single
    expect(l("jsonPatch")(doc, patch)).toEqual(expected);
    // bulk n=2 → packed batch
    expect(l("jsonPatch")([doc, doc], [patch, patch])[0]).toEqual(expected);
    // bulk n=1 → adaptive scalar loop must split the companion correctly
    expect(l("jsonPatch")([doc], [patch])[0]).toEqual(expected);
    // forced scalar loop (batchMin raised) still splits companions
    const l2 = createLoader({ adaptive: false, batchMin: 8 });
    expect(l2("jsonPatch")([doc, doc], [patch, patch])[1]).toEqual(expected);
  });

  test("hmacSha256Verify scalar + bulk (key shared, sigs per-item)", () => {
    const data = bytes("msg");
    const sig = rust.hmacSha256(SECRET, data);
    const l = createLoader({ adaptive: false });
    expect(l("hmacSha256Verify")(data, SECRET, sig)).toBe(true);
    const bits = l("hmacSha256Verify")([data, data], SECRET, [sig, bytes("bad")]);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });

  test("passwordVerify scalar + bulk", () => {
    const salt = bytes("0123456789abcdef");
    const phc = rust.passwordHash(bytes("hunter2"), salt, {
      mCost: 8,
      tCost: 1,
      pCost: 1,
      outLen: 16,
    });
    const l = createLoader({ adaptive: false });
    expect(l("passwordVerify")(bytes("hunter2"), phc)).toBe(true);
    expect(l("passwordVerify")(bytes("nope"), phc)).toBe(false);
    const bits = l("passwordVerify")(
      [bytes("hunter2"), bytes("nope")],
      [phc, phc],
    );
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });

  test("urlResolve scalar + bulk (RFC 3986)", () => {
    const base = bytes("http://a/b/c/d;p?q");
    const ref = bytes("g");
    const l = createLoader({ adaptive: false });
    expect(l("urlResolve")(ref, base)).toEqual(bytes("http://a/b/c/g"));
    expect(l("urlResolve")([ref], [base])[0]).toEqual(bytes("http://a/b/c/g"));
  });
});

describe("loader: schema validation (schemaValidate op + loader.schema)", () => {
  const SCHEMA = bytes('{"type":"object","required":["id"]}');
  const GOOD = bytes('{"id":1}');
  const BAD = bytes("[]");

  test("schemaValidate scalar + bulk", () => {
    const validator = rust.createSchemaValidator(SCHEMA);
    const l = createLoader({ adaptive: false });
    expect(l("schemaValidate")(GOOD, validator)).toBe(true);
    expect(l("schemaValidate")(BAD, validator)).toBe(false);
    const bits = l("schemaValidate")([GOOD, BAD], validator);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });

  test("loader.schema(validator) → callable single/bulk/count", () => {
    const validator = rust.createSchemaValidator(SCHEMA);
    const l = createLoader({ adaptive: false });
    const schema = l.schema(validator);
    expect(schema(GOOD)).toBe(true);
    expect(schema(BAD)).toBe(false);
    const bits = schema([GOOD, BAD, GOOD]);
    expect([...bits]).toEqual([1, 0, 1]);
    expect(schema.count([GOOD, BAD, GOOD])).toBe(2);
    // count is a whole-batch op (no per-element counterpart).
    expect(rust.batch.schemaValidateCount(validator, [GOOD, BAD])).toBe(1);
  });
});
