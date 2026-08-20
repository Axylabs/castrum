# test/ — where tests live and why

The test tree mirrors `src/` so a contributor looking for the test of a
module finds it in the same relative location.

| Directory | Tests what | Maps to `src/` |
|-----------|------------|----------------|
| `unit/native/` | Addon loader path resolution (`loader.test.ts`), the `bun:ffi` transport + bind-time self-test (`ffi.test.ts`, `ffi-symbol-parity.test.ts`), and the higher-order-function loader HFC (`loader-hfc*.test.ts`) | `src/native/`, `src/loader/` |
| `unit/rust-ffi/` | The public `rust.*` op surface: json (+ schema/derive), jsonPatch, jwt, hmac (`hash`), aead, compress, accept, etag, multipart, template, validation, url/url-join, mime, encoding, batch, password, token, csrf, cookie-sign, instances, mutation, packed-into, packed-meta, empty-input-matrix, streaming, form, media-type | `src/rust-ffi/` |
| `unit/contract/` | Cross-surface contracts: op wiring (`wiring`), Bun built-in delegation (`delegation`), import-time contract (`import-contract`), and the baked proven selection (`proven`) | `src/shared/proven.ts`, `src/selection.ts` |
| `unit/ingress/` | The ingress pipeline: fast + pre-baked handlers, router, server (Bun + Node), options, smuggling defense, native-route stack, header packing | `src/ingress/` |
| `unit/shared/` | Zero-dep shared helpers: bytes/codec/response, buffer-pool, metrics/log/trace/uuid, runtime seam, packed wire + pairs/parsers | `src/shared/` |
| `unit/integration/` | Framework-agnostic helpers (`createPipeline`, batch, streaming, websocket) | `src/integration/` |
| `compat/` | Cross-version compatibility contracts (`flux-contract`) | — |
| `property/` | Property-based / adversarial parsers (round-trip + no-panic guarantees) | `rust/` + `src/shared/packed` |

## Where does a NEW test go?

- A test for a `src/native/*` or `src/loader/*` module → `unit/native/`.
- A test for a `rust.*` / `src/rust-ffi/*` op → `unit/rust-ffi/`.
- A test pinning a cross-surface wiring/delegation/proven contract → `unit/contract/`.
- A test for an ingress component → `unit/ingress/` (mirror the `src/ingress/*`
  subfolder when it exists: `decode/`, `headers/`, `response/`, `routes/`,
  `packing/`).
- A test for a shared helper → `unit/shared/`.

## Conventions

- Every test file mirrors the module-header convention: a `/** … */` or `// …`
  comment saying what it pins.
- Keep the largest files split by concern (e.g. `loader-hfc.test.ts` =
  dispatch/ops parity vs `loader-hfc-coalesce.test.ts` = coalescing/cache
  lifecycle; `json.test.ts` = parse/schema vs `json-patch.test.ts` = patch).
- A single-cohesion suite (e.g. `ffi.test.ts`, `smuggling.test.ts`,
  `native-route.test.ts`) stays in ONE file even when long — do not split it
  into artificial seams that duplicate setup.
- Run `bun test` (whole suite) + `bunx tsc --noEmit -p tsconfig.test.json`
  after adding a test; `bun run lint` keeps import order/format consistent.
