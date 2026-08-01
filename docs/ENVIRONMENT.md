# Environment Variables Reference

This document lists every environment variable read by the package and its
example servers. All values are read once at module load; invalid values are
warned about and replaced with the documented default.

## Ingress server (`bench/servers/ingress-server.ts`)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `INGRESS_TRUST_PROXY` | bool | `false` | **Opt-in.** When `true`, honors `X-Forwarded-For` / `X-Real-IP` for client-IP resolution. Keep **off** unless the server sits behind a trusted edge that strips these headers, otherwise clients can spoof arbitrary IPs for IP-based rate limiting. |
| `INGRESS_REQUEST_ID_HEADER` | bool | `false` | Emit an `x-request-id` response header per request. The request ID is always generated internally; this only controls whether it is echoed to clients. |
| `INGRESS_UNSAFE_ZERO_COPY` | bool | `false` | Enable zero-copy response bodies. **Not recommended** unless per-response output buffers are implemented; leave off for safety (bodies are copied by default). |
| `INGRESS_OUTPUT_BUF_BYTES` | int | `131072` | Size of the Rust output buffer (min `65536`). If cookies + query + metadata JSON exceed this, `FLAG_BODY_TRUNCATED` is set and the request fails closed. |
| `INGRESS_SECURITY_HEADERS` | bool | `true` | Emit the precomputed security headers (CSP, HSTS, X-Frame-Options, etc.). Disable only behind an edge that already sets them. |
| `INGRESS_REUSE_PORT` | bool | `false` | Enable `SO_REUSEPORT` for multi-process deployments (spawn N processes, each with a distinct `INGRESS_WORKER_ID`). |
| `INGRESS_LOG_REQUESTS` | bool | `false` | Write one JSON line per request to **stderr** (`{ts, kind, requestId, method, path, status, errorCode?, rateLimited?, ...}`). |
| `INGRESS_METRICS` | bool | `false` | Write a periodic aggregate summary to **stderr** every 10s (`{ts, kind, total, rps, status, rateLimited, internalErrors}`). |
| `INGRESS_HOST` | string | `0.0.0.0` | Bind address. |
| `INGRESS_IDLE_TIMEOUT` | int | `30` | Idle keep-alive timeout in seconds (min `1`). |
| `INGRESS_WORKER_ID` | int | `0` | Worker identifier (0–65535), mixed into request-ID generation to reduce collision risk across processes. |

Boolean flags accept `1`/`true`/`yes`/`on` for true and `0`/`false`/`no`/`off`
for false; anything else is warned about and falls back to the default.

## Rust FFI thread pool

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RUST_BENCH_RAYON_THREADS` / `RUST_RAYON_THREADS` | int | `max(1, cores-1)` | Rayon thread pool size. The pool is process-wide and initialized **once** — the first use wins. With lazy init, call `rust.configure({ rayonThreads })` (or set this env) before the first batch operation. |
| `RUST_BENCH_MAX_RAYON_THREADS` | int | `cores` | Hard cap on rayon threads (native). |
| `RUST_BENCH_PIN_CORES` | (presence) | — | When set (Linux), pin rayon worker threads to distinct cores. |

## Native addon loader (`src/native/index.ts`)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RUST_BENCH_DEBUG` | (presence) | — | Log the resolved addon path and exported keys at load time. |
