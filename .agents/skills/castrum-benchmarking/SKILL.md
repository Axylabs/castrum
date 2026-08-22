---
name: castrum-benchmarking
description: Run and interpret castrum's benchmark suite — which runner answers which question, how to read reports, and how to regenerate the native-vs-JS selection. Use when measuring performance or changing selection metadata.
---

# castrum: Benchmarking

Benchmarks are the source of truth for "where does performance come from".
`bench/README.md` is the runner index; `docs/BENCHMARKS.md` is the deep guide.
Never assume — measure before and after a hot-path change.

## Runner families

| Family | Directory | Asks | Runners |
|--------|-----------|------|---------|
| HTTP | `bench/http/` | "How fast is my server end-to-end?" | `run-bench.ts` (scenario runner), `load.ts` (load generator), `load-phase.ts` (startup cost), `servers/` (bun/elysia/ingress/router) |
| FFI transport | `bench/ffi/` | "bun:ffi vs napi vs Bun built-ins?" | `ffi-all.ts`, `ffi-load.ts`, `ffi-public.ts`, `ffi-margin.ts`, `ffi-workers.ts` |
| Cost / ingress internals | `bench/cost/` | "Where does per-request cost go inside ingress?" | `ingress-cost.ts`, `ingress-cost-post.ts`, `router-cost.ts` |
| Root | `bench/` | Cross-cutting | `startup.ts`, `autocannon-stress.mjs`, `measure.ts` |

## Which command for which question

- **CPU correctness + perf** → `bun run check` (== `bun bench.ts`, NOT a
  typecheck) → writes `bench/results/cpu/`. Task framework in `src/bench/`
  (34 task files); `native:`/`rust:` vs `js:` vs `diag:` task names; the
  `diag:` set feeds `docs/bun-builtins-decision-matrix.md` (NOT a shipped-op
  measurement).
- **HTTP ceiling** → `bun run bench:http` / `bench:http:ingress` /
  `bench:http:elysia` / `bench:http:bun-only`; scenarios 01–20 in
  `bench/http/load.ts` (`HTTP_SCENARIOS`). `bench:http:smoke` is the CI-gated
  **wire-format guard** — run it after touching any server or `handlers.ts`.
- **Autocannon cross-check (no Bun fetch cap)** → `bun run bench:http:ac`
  with `AC_*` env (`AC_PATH`, `AC_METHOD`, `AC_BODY`, `AC_CONNECTIONS`,
  `AC_WORKERS`, `AC_INSTANCES`, `AC_DURATION`, `SERVER`…). Read
  `docs/BENCHMARKS.md` §"Bun fetch() concurrency cap" BEFORE interpreting
  results; single-path static comparisons are the most stable signal;
  multi-core scaling needs `AC_INSTANCES` + `INGRESS_REUSE_PORT=1`.
- **FFI transport** → `bun run bench:ffi` / `bench:ffi:load` /
  `bench:ffi:public` / `bench:ffi:workers` / `bench:margin`
  (FFI-vs-napi margin → `bench/results/ffi-margin/`).
- **Ingress cost** → `bun run bench:ingress-cost` / `bench:ingress-cost:post`
  / `bench:router`.
- **Startup / first-call** → `bun run bench:startup` + `bun run bench:load`
  (import-cost decomposition).

## Regenerating the native-vs-JS selection

1. `bun scripts/select-native.ts --write` → rewrites `src/selection.json`.
2. `bun run build` → embeds it into the addon (`rust/selection.rs`
   `include_str!`).
3. `bun run check:selection` (== `select-native.ts --check`) gates CI.

> **Gotcha**: ops missing from `select-native.ts`'s `OPS` array get DELETED
> from the JSON. Keep the array in sync with the op surface.
> `src/shared/proven.ts` bakes the winners and `test/unit/contract/proven.test.ts`
> verifies each winner is wired.

## Controls

`CASTRUM_BENCH_BATCH_SIZE`, `CASTRUM_BENCH_FFI`, `HTTP_NO_SHAPE`,
`SERVER`, `SCENARIO`, `AC_*`. Results land under `bench/results/`
(gitignored): `cpu/`, per-server HTTP dirs, `ffi-margin/`, `router/`,
`startup/`, `autocannon/`.

## Reporting

Never quote a number without the machine + config that produced it. The
measured ceilings in `docs/BENCHMARKS.md` and `docs/bun-builtins-decision-matrix.md`
(name the Bun runtime version — 1.4.0) are the reference points; a change that
moves a shipped-op decision needs a re-run of both.
