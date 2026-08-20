# bench/ — which runner answers which question

The benchmark suite is grouped into three families plus a root set. Every
runner is invoked via `bun run bench:<name>` (see package.json); the plan says
use the scripts, not raw paths, so a future move only touches package.json.

| Family | Directory | Asks | Runners |
|--------|-----------|------|---------|
| HTTP | `bench/http/` | "How fast is my server end-to-end?" | `run-bench.ts` (scenario runner), `load.ts` (load generator), `load-phase.ts` (startup/import cost decomposition), `servers/` (bun/elysia/ingress/router server + `shared.ts`) |
| FFI transport | `bench/ffi/` | "How fast is the `bun:ffi` C-ABI transport vs napi vs Bun built-ins?" | `ffi-all.ts`, `ffi-load.ts`, `ffi-public.ts`, `ffi-margin.ts`, `ffi-workers.ts` (+ `ffi-worker-script.ts`) |
| Cost / ingress internals | `bench/cost/` | "Where does the per-request cost go inside the ingress pipeline?" | `ingress-cost.ts`, `ingress-cost-post.ts`, `router-cost.ts` |
| Root | `bench/` | Cross-cutting | `startup.ts` (import + first-call), `autocannon-stress.mjs` (autocannon load), `measure.ts` (shared `measureNs`/`measureNsAsync` timing helpers) |

## Which runner for which question

- **"Is my server fast under real HTTP?"** → `bun run bench:http` (all servers)
  or `bun run bench:http:ingress` (ingress only). Add/choose a scenario in
  `bench/http/load.ts` (`HTTP_SCENARIOS`); the smoke variant
  (`bench:http:smoke`) is the CI-gated wire-format guard.
- **"Is the FFI transport faster than napi / Bun built-ins?"** →
  `bun run bench:ffi` (full comparison), `bench:ffi:load` (per-op throughput),
  `bench:ffi:margin` (FFI-vs-napi margin, writes `bench/results/ffi-margin/`),
  `bench:ffi:workers` (multi-worker thread-safety).
- **"How much does the ingress pipeline cost per request?"** →
  `bun run bench:ingress-cost` / `bench:ingress-cost:post` / `bench:router`.
- **"Where does `import castrum` time go?"** → `bun run bench:startup` +
  `bun run bench:load` (load-phase decomposition).

## Results

Centralized under `bench/results/` (gitignored): `cpu/` (CPU bench report),
`http/`-style per-server dirs from the scenario runner, `ffi-margin/`,
`router/`, `startup/`, `autocannon/`. The CPU bench (`bun run check` →
`bench.ts`) persists a machine-readable report to `bench/results/cpu/`.

## How to add a scenario / server

1. Add a server: create `bench/http/servers/<name>-server.ts` (see
   `ingress-server.ts` as the model), bind the same `PORTS` in
   `bench/http/servers/shared.ts` + `bench/autocannon-stress.mjs`.
2. Add a scenario: extend `HTTP_SCENARIOS` in `bench/http/load.ts` (phases,
   weighted flows, `shapeValidation` policy).
3. Add a package.json script (or extend an existing `bench:http:*` alias) and
   run `bun run bench:http:smoke` to confirm shape checks still pass.
