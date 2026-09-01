# castrum — API Reference

The complete public API, verified against the current source. For the friendly
overview and quick start, see the [README](../README.md); for the HTTP pipeline
deep-dive, see [`INGRESS.md`](./INGRESS.md).

Everything is **synchronous**. All byte-level functions accept `Uint8Array`;
`rust.text.*` provides string-in/string-out ergonomics.

---

## Runtime return-type divergence (Bun vs Node)

On **Bun** the `bun:ffi` C-ABI transport returns text results as **JS strings**
via JSC's native transfer (cstring → `new CString(ptr, 0, len)`), with **zero
`TextEncoder`/`TextDecoder`** on the hot path. So `rust.urlEncode`,
`rust.base64Encode`, `rust.hexEncode`, `rust.hmacSha256`, `rust.etag`,
`rust.wsAcceptKey`, `rust.randomToken`, `rust.signCookie`, `rust.verifyCookie`
(`string | null`), `rust.csrfToken`, `rust.passwordHash`,
`rust.passwordHashBcrypt`, `rust.jwtSignBytes`, `rust.jwtVerify`
(`string | null`), `rust.jsonPatch`, `rust.httpDate`, `rust.mimeFromExtension`,
`rust.urlResolve`, `rust.urlEncodeQuery`, and `rust.acceptNegotiatorNegotiate`
(`string | null` — the `null` is the C `NULL` sentinel) return **`string`** on Bun. On **Node** (napi fallback) the same
functions return **`Uint8Array`**. The TypeScript surface types these as
`Uint8Array | string`; normalize with `toBytes(value)` / `toText(value)` (from
`src/shared/bytes`). The `*Into`/pooled variants always return bytes on both
runtimes, and binary ops (`gzip*`, `brotli*`, `aead*`, `pbkdf2Sha256`,
`wsFrame*`, packed parsers, `batch.*`/`packed.*`) return `Uint8Array` on both.

---

## Core exports

| Export | Description |
|--------|-------------|
| `rust` | The default, shared native client — every Rust utility, flat and complete. |
| `createRust(options?)` | Build an isolated client (own caches / rayon settings). |
| `proven`, `PROVEN_SELECTION`, `provenImpl`, `provenStatus`, `isProven`, `provenSurface`, `provenSummary` | The full `rust.*` surface + the baked (pure-data) proven-selection registry of benchmark winners (`native` / `js` / `bun`). |
| `opImpl`, `isNativeOp`, `opDecision` | Native-vs-JS selection hints (benchmark-driven). |
| `loader`, `createLoader` | Higher-order loader over the batch surface. |
| `encoder`, `decoder` | Codec-backed UTF-8 helpers (shared native `TextEncoder` / Bun: `CString`; Node: `TextEncoder`/`TextDecoder`). `encode`/`decode` accept the `Uint8Array | string` union and normalize. |
| `uuidv7()` | UUIDv7 — `Bun.randomUUIDv7` on Bun, `crypto.randomUUID` on Node. |
| `AdaptiveEstimate`, `AdaptiveEstimateOptions` | Bounded EWMA adaptive-estimate utility. |
| `createMetrics`, `DEFAULT_BUCKETS` | Zero-dependency metrics registry (counters/gauges/histograms + Prometheus text). |
| `packBatch`, `packPairs`, `readPairsPacked`, `readHttpPacked`, `pairsToObject`, `parseQueryString`, `parseCookieHeader`, `parseFormBody`, `unpackBitset`, `unpackByteResults`, `unpackI64ArrayAsBigInt`, `unpackU32Array` | Packed-wire + high-level parsing utilities. |
| Ingress: `createIngress`, `createIngressSync`, `createIngressFast`, `createIngressHandler`, `createIngressServer`, `createIngressServerNode`, `createIngressRouter`, route factories, metrics/health/trace helpers | See [`INGRESS.md`](./INGRESS.md) and [`INGRESS-ROUTER.md`](./INGRESS-ROUTER.md). |
| Integration: `createPipeline`, `createWebSocketUpgrade`, `sseResponse` | Framework-agnostic helpers — see [`INGRESS.md`](./INGRESS.md) §Framework Integration. |

---

## The `rust` client

`rust` is a single flat object exposing **every** native utility. Text-oriented
operations also have ergonomic string variants under `rust.text`.

| Namespace | Description |
|-----------|-------------|
| `rust.crc32(...)`, `rust.jsonValid(...)`, … | Scalar utilities (bytes in → typed out) |
| `rust.text.mimeFromExtension(".js")`, … | String ergonomics (string in → string/bool out) |
| `rust.batch.jsonValid(docs)`, … | High-throughput batch (arrays → unpacked results) |
| `rust.packed.jsonValidBatchPacked(p)`, … | Raw packed low-level variants + metadata |
| `rust.configure({ ... })` | Override defaults on the shared instance |

`rust.transport()` returns `"ffi"` / `"napi"` (the resolved transport);
`rust.ffiActive()` reports whether the bun:ffi transport is live.

### Scalar utilities

| Function | Returns |
|----------|---------|
| `crc32(input)` | `number` — CRC32 checksum |
| `fnv1a64(input)` | `bigint` — FNV-1a 64-bit hash |
| `xxh3(input)` | `bigint` — XXH3-64 (non-crypto hash) |
| `hmacSha256(key, data)` | `Uint8Array` — HMAC-SHA256 signature |
| `hmacSha256Verify(key, data, sig)` | `boolean` |
| `jsonValid(input)` | `boolean` — JSON validity check (zero-DOM) |
| `jsonParse(input)` | `unknown` — JSON → JS value (native sonic-rs DOM; throws on invalid) |
| `jsonSumIds(input)` | `bigint` — sum of numeric `id` fields |
| `jsonPatch(doc, patch)` | `Uint8Array` — RFC 6902 result |
| `createSchemaValidator(schema)` | `SchemaValidator` — compile a JSON Schema (draft-07); `.validate(doc): boolean`, `.validateDetailed(doc): SchemaError[]`, `.validateFirstError(doc): SchemaError | null`, `.validateBatchPackedCount(packed): number`, … |
| `mimeFromExtension(ext)` | `Uint8Array` — MIME type |
| `randomToken(byteLen)` | `Uint8Array` — CSPRNG token |
| `urlEncode(input)` / `urlDecode(input)` | `Uint8Array` — percent encode/decode |
| `urlDecodeBytes(input)` | `Uint8Array` — strict %-decode (no UTF-8 check) |
| `validateEmail/Uuid/Ipv4/Ipv6(input)` | `boolean` |
| `wsAcceptKey(key)` | `Uint8Array` — WebSocket accept key |
| `passwordHashBcrypt(password, salt?, cost?)` | `Uint8Array` — bcrypt `$2b$` PHC string |
| `passwordVerifyBcrypt(password, phc)` | `boolean` |
| `pbkdf2Sha256(password, salt, iterations, dkLen?)` | `Uint8Array` — PBKDF2-HMAC-SHA256 |
| `gzipCompress(data)` / `gzipDecompress(data, maxDecompressed?)` | `Uint8Array` — gzip (decompress capped at 64 MiB by default) |
| `brotliCompress(data)` / `brotliDecompress(data, maxDecompressed?)` | `Uint8Array` — brotli |

### Framework actions (HTTP semantics + security)

| Function | Returns |
|----------|---------|
| `formParsePacked(body)` | `Uint8Array` — packed x-www-form-urlencoded pairs |
| `createFormParser(capacity?)` | `FormParser` — reusable-buffer form parser (`.parse`, `.parseInto`) |
| `parseMediaType(header)` | `{ mediaType, charset, boundary, params }` — Content-Type parse |
| `createMediaTypeParser()` | `MediaTypeParser` — `.parse`, `.matches(actual, expected)` (wildcards) |
| `createMediaTypeMatcher(expected)` | `MediaTypeMatcher` — `.matches(actual)` (expected precompiled once) |
| `etag(data, weak?)` | `Uint8Array` — strong/weak ETag (crc32-based) |
| `httpDate(secs?)` / `parseHttpDate(input)` | `Uint8Array` / `bigint | null` — IMF-fixdate format/parse |
| `createConditionalRequest(etag, lastModifiedSecs?)` | `ConditionalRequest` — `.isNotModified(ifNoneMatch, ifModifiedSince)` → 304 |
| `parseAcceptEncoding(header)` | `{ encoding, q, order }[]` |
| `createAcceptNegotiator(supported[])` | `AcceptNegotiator` — `.negotiate(header)` → best encoding |
| `base64Encode/Decode(input, urlSafe?, padding?)`, `base64UrlEncode/Decode(input)` | `Uint8Array` |
| `createBase64Codec(urlSafe?, padding?)` | `Base64Codec` — `.encode`, `.decode` |
| `hexEncode(input)` / `hexDecode(input)` | `Uint8Array` — lowercase hex |
| `signCookie(value, secret)` / `verifyCookie(signed, secret)` | `Uint8Array` / `Uint8Array | null` — signed cookies |
| `createCookieSigner(secret)` | `CookieSigner` — `.sign`, `.verify` (HMAC key compiled once) |
| `csrfToken(secret)` / `csrfVerify(token, secret)` | `Uint8Array` / `boolean` |
| `createCsrfProtector(secret)` | `CsrfProtector` — `.create`, `.verify` |
| `urlResolve(base, reference)` | `Uint8Array` — RFC 3986 resolution |
| `urlEncodeQuery(params)` | `Uint8Array` — percent-encoded query (sorted keys) |
| `createUrlBuilder(base)` | `UrlBuilder` — `.resolve(reference)` (base parsed once) |
| `createJwtSigner(secret, ttlSeconds?)` | `JwtSigner` — `.sign(claims, now)`, `.verify(token, now)` (HS256 key + ttl compiled once) |
| `createAeadCipher(key, algorithm?)` | `AeadCipher` — `.encrypt(nonce, pt)`, `.decrypt(nonce, ct)` (key compiled once) |
| `createArgon2Hasher(options?)` | `Argon2Hasher` — `.hash(password, salt)`, `.verify(password, phc)` (params compiled once) |
| `httpParseRequestPacked(bytes)` | packed HTTP request parse (low-level) |
| `queryParsePacked(query)` / `cookieParsePacked(header)` / `formParsePacked(body)` | packed pair parsing (low-level) |

> `passwordHash` / `passwordVerify` (argon2id) and `passwordHashBcrypt` /
> `passwordVerifyBcrypt` are also exposed as scalar helpers; the compiled-once
> `createArgon2Hasher` is preferred when hashing repeatedly.

### String ergonomics (`rust.text`)

```ts
rust.text.mimeFromExtension(".js");  // "text/javascript"
rust.text.mimeFromExtension("html"); // "text/html"
rust.text.urlEncode("a b");         // "a%20b"
rust.text.urlDecode("a%20b");       // "a b"
rust.text.wsAcceptKey(keyBase64);    // base64 accept key
rust.text.validateEmail("a@b.co");   // true
```

### Batch operations (`rust.batch`)

All batch helpers accept `Uint8Array[]` and return unpacked, ready-to-use results:

```ts
const docs = [encoder.encode('{"id":1}'), encoder.encode('{"id":2}')];

rust.batch.jsonValid(docs);             // Uint8Array bitset (1 per doc)
rust.batch.crc32(docs);                 // Uint32Array
rust.batch.jsonSumIds(docs);            // BigInt64Array
rust.batch.queryParse(docs);            // Uint8Array[]
rust.batch.formParse(docs);             // Uint8Array[] (packed pairs per doc)
rust.batch.signCookie(docs, secret);    // Uint8Array[] (signed)
rust.batch.verifyCookie(docs, secret);  // Uint8Array bitset (valid?)
rust.batch.csrfVerify(tokens, secret);  // Uint8Array bitset (valid?)
rust.batch.schemaValidate(validator, docs); // bitset

// Hashing / url / mime / ws / base64url
rust.batch.fnv1a64(docs);               // BigUint64Array (unsigned hashes)
rust.batch.etag(docs);                  // Uint8Array[]
rust.batch.urlEncode(docs);             // Uint8Array[]
rust.batch.urlDecode(docs);             // Uint8Array[]
rust.batch.base64UrlEncode(docs);       // Uint8Array[]
rust.batch.wsAcceptKey(keys);           // Uint8Array[]
rust.batch.mimeFromExtension(exts);     // Uint8Array[]

// Backend-framework batches (zipped lists / shared args)
rust.batch.passwordVerify(pwds, phcs);  // Uint8Array bitset (zipped)
rust.batch.urlResolve(bases, refs);     // Uint8Array[] (zipped)
rust.batch.jwtSign(claimDocs, secret);  // Uint8Array[] (sign N JSON claim docs)
rust.batch.jwtVerify(tokens, secret, now); // Uint8Array bitset
rust.batch.sseEncode(items, "event");   // Uint8Array[]
rust.batch.wsFrameEncode(items, 1, false, true); // Uint8Array[]
rust.batch.wsFrameDecode(frames);       // Uint8Array[] (payloads)
rust.batch.multipartParse(bodies, boundary); // MultipartPart[][]
```

Raw packed + metadata variants (advanced): `rust.packed.*` mirrors the native
functions 1:1 (`jsonValidBatchPacked`, `jsonValidBatchCountPacked`,
`queryParseBatchTotalLenPacked`, …).

---

## Higher-order data loader (`loader` / `createLoader`)

`loader` is a callable higher-order function over the whole batch surface. It
pre-binds an op so repeated calls skip registry dispatch, and it routes small
vs. large workloads automatically: a single item → one scalar native call, a
bulk → ONE packed batch call, and `load()` coalesces N same-tick calls into one
packed call (DataLoader-style) with a bounded LRU cache.

```ts
import { loader } from "castrum";

const isEmail = loader("validateEmail");
isEmail(emailBytes);                    // scalar → boolean
isEmail([a, b, c]);                     // bulk → Uint8Array bitset (one packed call)
await isEmail.load(a);                  // coalesced + cached (auto batch/strategy)

// Covered op families (44 ops):
//   hash     crc32, fnv1a64
//   json     jsonValid, jsonSumIds, jsonPatch*, schemaValidate
//   validate email, uuid, ipv4, ipv6
//   parse    query, cookie, form, httpParseRequest, urlResolve*
//   encode   hex, base64, base64Url, urlEncode, urlDecode, urlDecodeBytes, etag
//   compress gzip, brotli
//   crypto   hmacSha256, hmacSha256Verify*, signCookie, verifyCookie, csrfVerify,
//            passwordHash, passwordVerify*, aeadEncrypt, aeadDecrypt, jwtSign, jwtVerify
//   web      wsAcceptKey, wsFrameEncode, sseEncode, mimeFromExtension
//   (* = paired: per-item companion array, e.g. loader.run("jsonPatch", docs, patches))

// Paired ops take a companion array:
loader.run("jsonPatch", docs, patches);       // bulk
loader.run("jsonPatch", doc, patch);          // single

// verifyCookie / jwtVerify are boolean-validity ops (valid/invalid);
// use rust.verifyCookie / rust.jwtVerify for the decoded value.

// Bind a schema validator for repeated single/bulk validation + count:
const schema = loader.schema(rust.createSchemaValidator(schemaBytes));
schema(doc);              // boolean
schema(docs);             // Uint8Array bitset
schema.count(docs);       // number of valid docs

// Fine-grained control: createLoader({ adaptive, batchMin, maxCacheKeys, ... })
```

---

## The `proven` selection surface

`proven` is literally the same object as `rust` (`export const proven = rust`) —
nothing is filtered. Alongside it, the pure-data registry `PROVEN_SELECTION`
(`src/shared/proven.ts`) states which implementation is the benchmark-proven
winner for every op: `native` (the addon), `js` (pure TS), or `bun` (a Bun
built-in that is delegated under Bun). The winners are **baked** from
measurements (`src/selection.json` + `docs/bun-builtins-decision-matrix.md`),
and `test/unit/shared/proven.test.ts` verifies each winner is actually wired
(`opImpl` agrees, `builtins.has` matches, native/js entries match the addon's
embedded `selection.json`) — so the registry cannot silently drift. There is no
live benchmark gate (the old `check:proven` / `check:annotate` friction is gone).

- Statuses: `proven` (decisive win) / `parity` (borderline) / `unmeasured` (no
  direct ratio — pinned by policy). `provenImpl(op)` returns the baked winner.
- The full surface is unchanged — `rust.jsonParse`, `rust.createSchemaValidator`,
  etc. remain available for completeness; they just aren't advertised as wins.
- Classifications are based on the **release build on the shipped baseline CPU**
  (published artifacts are baseline — not the local SIMD `build:perf`).

```ts
import { proven, PROVEN_SELECTION, provenImpl } from "castrum";

proven.fnv1a64(bytes);        // native — Rust wins ~12x vs the JS baseline
provenImpl("crc32");          // "bun" — Bun.hash.crc32 wins under Bun
provenImpl("validateEmail");  // "js" — pure-TS wins
```

```bash
bun test test/unit/shared/proven.test.ts   # proves every baked winner is wired
```

---

## Native-vs-JS selection surface

For framework consumers that want to bind each operation to a fixed
implementation at load time (instead of calling `rust.*` directly):

```ts
import { opImpl, isNativeOp, opDecision } from "castrum";

opImpl("gzipCompress");   // "native" | "js" | null
isNativeOp("crc32");      // boolean
opDecision("fnv1a64");    // { impl, note? } | null
```

- Source of truth: `rust/selection.rs`, which embeds the benchmark-generated
  `src/selection.json` (produced by `scripts/select-native.ts --write`, audited
  by `--check` in CI).
- Under Bun, ops where the Bun built-in beats the Rust addon (gzip, crc32, xxh3,
  HMAC, random tokens) are selected as `"js"` (a JS path that delegates to the
  Bun built-in); under Node the base benchmark decision stands.
- Consumers read `opImpl(op)` **once at startup** and bind each op to a fixed
  implementation — they do not swap native↔js per call.

---

## Configuration

Defaults are selected automatically, and can be overridden:

```ts
// Defaults:
//   rayonThreads = max(1, hardwareConcurrency - 1)
//                  (env override: CASTRUM_RAYON_THREADS / RUST_RAYON_THREADS)
//   mimeCache    = true
//   hmacCache    = true

// Override per-instance options on the shared instance:
rust.configure({ mimeCache: false, hmacCache: false });

// Or create an isolated instance with custom defaults:
import { createRust } from "castrum";
const myRust = createRust({ mimeCache: false });
```

> **Thread pool note**: the rayon pool is process-wide and initialized **once**
> (native `OnceLock`) — the first initialization wins. Because importing the
> module initializes it with the default, set
> `CASTRUM_RAYON_THREADS` / `RUST_RAYON_THREADS` (or call
> `rust.configure({ rayonThreads })` / `createRust({ rayonThreads })` before any
> other pool use) to tune it. `mimeCache` / `hmacCache` are per-instance and can
> be toggled any time.

---

## Shared utilities

```ts
import {
  encoder, decoder,             // TextEncoder/TextDecoder singletons
  packBatch, packPairs,         // batch/pair packing
  unpackBitset, unpackByteResults, unpackI64ArrayAsBigInt, unpackU32Array,
  readPairsPacked, pairsToObject, readHttpPacked,
  parseQueryString, parseCookieHeader, parseFormBody,
  uuidv7, createMetrics,
} from "castrum";

parseQueryString("a=1&b=2&tag=a&tag=b");       // { a: "1", b: "2", tag: ["a", "b"] }
parseCookieHeader("session=abc; theme=dark");  // { session: "abc", theme: "dark" }
```

> **Environment variables**: see [`ENVIRONMENT.md`](./ENVIRONMENT.md) for the
> full reference of `INGRESS_*`, `CASTRUM_*`, and `RUST_*` runtime variables.

## Ingress & integration

The HTTP pipeline (options, route factories, `BakedIngressResult`, server
builders, observability, and the framework integration helpers) has its own
dedicated reference: [`INGRESS.md`](./INGRESS.md).
