// bench/autocannon-stress.mjs — max-throughput HTTP benchmark via autocannon
//
// WHY THIS FILE EXISTS
// --------------------
// The in-repo generator (bench/load.ts) uses Bun's `fetch()`, which by default
// caps at 256 simultaneous requests (BUN_CONFIG_MAX_HTTP_REQUESTS). The
// `03-stress` scenario fires maxConcurrent=10000, so ~9,700 requests queue FIFO
// client-side and the benchmark measures the GENERATOR, not the server (all four
// servers — bun/elysia/ingress/router — report the identical ~930 RPS / 15 s tail).
//
// autocannon (Node) has no such cap: it uses a real socket pool, scales across
// worker_threads, and reports RPS + latency percentiles natively. This runner
// spawns the same bench servers and drives them with autocannon so the servers'
// ACTUAL throughput is measurable.
//
// NOTE: run this with `node`, NOT `bun` — autocannon's client is tuned for
// Node's http stack, and running it under Bun's node:http shim would reintroduce
// the same class of measurement doubt this tool exists to remove.
//
// Usage (from the repo root):
//   node bench/autocannon-stress.mjs                # all servers, 03-stress mix
//   SERVER=ingress node bench/autocannon-stress.mjs # one server
//   AC_CONNECTIONS=200 AC_DURATION=20 node bench/autocannon-stress.mjs
//   SCENARIO=03-stress node bench/autocannon-stress.mjs
//
// Env knobs:
//   SERVER           bun|elysia|ingress|router (default: all)
//   SCENARIO         report tag only (default: 03-stress)
//   AC_DURATION      seconds per server run (default: 30)
//   AC_CONNECTIONS   concurrent keep-alive sockets (default: 2000 — the
//                    server-bound floor on this host for STATIC-path runs;
//                    the old 500 default let the client cap the server at
//                    ~41k RPS and hid the real ceiling — see docs/BENCHMARKS.md
//                    §Single-core ceiling. The DYNAMIC setupRequest mix is
//                    client-bound regardless (~47k here) and only validates
//                    shape/behavior — use AC_PATH for ceiling comparisons.)
//   AC_WORKERS       worker_threads to scale the client (default: 0 = single)
//   AC_PIPELINING    HTTP/1.1 pipelining depth (default: 1 — >1 is a
//                    client/transport artifact under GET on this stack and
//                    does NOT expose the server ceiling)
//   AC_TIMEOUT       per-request timeout seconds (default: 10)
//   AC_OUT_DIR       report dir (default: bench/results/autocannon)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Ports must match bench/http/servers/shared.ts (kept in sync manually). */
const PORTS = {
  bun: 9120,
  elysia: 9121,
  ingress: 9122,
  router: 9123,
};

const SERVERS = Object.keys(PORTS);

const DURATION = Number(process.env.AC_DURATION ?? 30);
const CONNECTIONS = Number(process.env.AC_CONNECTIONS ?? 2000);
const WORKERS = Number(process.env.AC_WORKERS ?? 0);
const PIPELINING = Number(process.env.AC_PIPELINING ?? 1);
const TIMEOUT = Number(process.env.AC_TIMEOUT ?? 10);
const SCENARIO = process.env.SCENARIO ?? "03-stress";
const OUT_DIR = process.env.AC_OUT_DIR ?? join(__dirname, "results", "autocannon");
// AC_PATH=/health → benchmark a SINGLE static path (no setupRequest). Debug/compare
// mode: autocannon's static path is far faster than its dynamic setupRequest path,
// so this isolates client-side vs server-side throughput. Combine with
// AC_METHOD/AC_BODY/AC_CONTENT_TYPE to exercise POST/JSON routes.
const STATIC_PATH = process.env.AC_PATH ?? "";
const STATIC_METHOD = process.env.AC_METHOD ?? "GET";
const STATIC_BODY = process.env.AC_BODY ?? "";
const STATIC_CONTENT_TYPE = process.env.AC_CONTENT_TYPE ?? "";
// AC_INSTANCES=N spawns N server processes sharing the port via SO_REUSEPORT
// (ingress/router only — they read INGRESS_REUSE_PORT; bun/elysia don't set it),
// demonstrating how the single-core Bun.serve ceiling scales across cores.
const INSTANCES = Number(process.env.AC_INSTANCES ?? 1);
const REUSE_CAPABLE = new Set(["ingress", "router"]);
// AC_RUNS=N repeats each server run N times and reports the MEDIAN across runs
// (default 1 = single run). Median-of-N tames the noisy-host variance this
// benchmark lives under (see the docs/BENCHMARKS.md note about load noise).
const RUNS = Math.max(1, Number(process.env.AC_RUNS ?? 1));

/**
 * Build an autocannon `setupRequest` that replicates the 03-stress weighted
 * flow mix: 50% GET /api/users?q=…&page=…, 30% POST /api/users (JSON body),
 * 20% GET /health.
 *
 * IMPORTANT — use the LIBRARY `requests: [{ setupRequest }]` API. autocannon's
 * `requestGenerator` option is CLI-ONLY and is silently ignored by the library
 * (every request then goes to `GET /` → 404 → "0 2xx, all non-2xx"). The
 * request object passed to `setupRequest` is REUSED across requests, so every
 * field the server could read (method/path/body/content-type/content-length)
 * must be set or cleared on every call.
 */
/**
 * Delete a header from a `setupRequest`-shared headers object case-insensitively.
 *
 * WHY THIS EXISTS (this is the fix for the 03-stress throughput collapse):
 * autocannon's request builder (httpRequestBuilder.js) writes the body size
 * header as `Content-Length` (capital L) on the SAME headers object that
 * `setupRequest` receives on the next call. A plain `delete req.headers["content-length"]`
 * (lowercase) leaves the stale `Content-Length: <n>` key behind. The next request in
 * the mix that has NO body then advertises `Content-Length: n` with zero body bytes,
 * so the server waits forever for a body that never arrives → the connection stalls
 * → after `timeout`s the idle ticker destroys it → ~76 req/s + 1k timeouts on every
 * server. Deleting case-insensitively clears the stale header regardless of the case
 * the builder used.
 */
function deleteHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function makeSetupRequest() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const randStr = (len) => {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += alphabet[(Math.random() * alphabet.length) | 0];
    }
    return out;
  };
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  return (req) => {
    const roll = Math.random();
    if (roll < 0.2) {
      // 20% GET /health — bodyless, so a stale Content-Length would hang the server
      req.method = "GET";
      req.path = "/health";
      req.body = undefined;
      deleteHeader(req.headers, "content-type");
      deleteHeader(req.headers, "content-length");
    } else if (roll < 0.5) {
      // 30% POST /api/users — small JSON body
      req.method = "POST";
      req.path = "/api/users";
      req.body = JSON.stringify({
        id: randInt(1, 999999),
        name: `stress_${randStr(12)}`,
      });
      req.headers["content-type"] = "application/json";
      // Builder re-adds the correct Content-Length below, but drop any stale
      // lowercase copy from a previous request first.
      deleteHeader(req.headers, "content-length");
    } else {
      // 50% GET /api/users?q=…&page=… — bodyless, stale Content-Length must go
      req.method = "GET";
      req.path = `/api/users?q=${randStr(20)}&page=${randInt(1, 50)}`;
      req.body = undefined;
      deleteHeader(req.headers, "content-type");
      deleteHeader(req.headers, "content-length");
    }
    return req;
  };
}

/** Refuse to start if something already answers on `port` (stale server guard). */
async function assertPortFree(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (res.ok) {
      throw new Error(
        `Port :${port} already answers /health — a stale or foreign server is ` +
          "already running there. Kill it before benchmarking to avoid measuring " +
          "the wrong process.",
      );
    }
  } catch (err) {
    if (err instanceof Error && /already answers/.test(err.message)) {
      throw err;
    }
    // Connection refused / not ready yet → port is free.
  }
}

async function waitForServer(port, proc, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(
        `Spawned server for :${port} exited during startup (code ${proc.exitCode}).`,
      );
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server on :${port} did not become ready within ${timeoutMs}ms`);
}

function startServer(kind) {
  const port = PORTS[kind];
  const count = REUSE_CAPABLE.has(kind) ? INSTANCES : 1;
  const script = `bench/http/servers/${kind}-server.ts`;
  return assertPortFree(port).then(() => {
    const procs = [];
    for (let i = 0; i < count; i++) {
      const proc = spawn("bun", ["run", script], {
        stdio: "inherit",
        env: {
          ...process.env,
          ...(REUSE_CAPABLE.has(kind) ? { INGRESS_REUSE_PORT: "1" } : {}),
        },
      });
      procs.push(proc);
    }
    return waitForServer(port, procs[0]).then(() => {
      // Give every reusePort process a beat to bind before loading starts, so
      // all N share the accept load from the first request.
      return new Promise((resolve) => setTimeout(resolve, 500)).then(() => {
        console.log(
          `✓ ${kind} server ready on :${port} (${count} process${count > 1 ? "es" : ""})`,
        );
        return procs;
      });
    });
  });
}

/** Run autocannon against `port` and resolve with the full result object. */
function runAutocannon(port, server) {
  return new Promise((resolve, reject) => {
    const opts = {
      url: STATIC_PATH
        ? `http://localhost:${port}${STATIC_PATH}`
        : `http://localhost:${port}`,
      connections: CONNECTIONS,
      duration: DURATION,
      timeout: TIMEOUT,
      pipelining: PIPELINING,
      workers: WORKERS,
      title: `${server} · ${SCENARIO}${STATIC_PATH ? ` · ${STATIC_PATH}` : ""}`,
      ...(STATIC_PATH
        ? {
            method: STATIC_METHOD,
            ...(STATIC_BODY ? { body: STATIC_BODY } : {}),
            ...(STATIC_CONTENT_TYPE
              ? { headers: { "content-type": STATIC_CONTENT_TYPE } }
              : {}),
          }
        : { requests: [{ setupRequest: makeSetupRequest() }] }),
    };
    const instance = autocannon(opts);
    instance.on("error", (err) => reject(err));
    instance.on("done", (result) => resolve(result));
    autocannon.track(instance, { renderProgressBar: true });
  });
}

/** Pick a latency percentile off an autocannon latency stats object. */
function latencyAt(stats, key, fallback = 0) {
  return Number.isFinite(stats?.[key]) ? stats[key] : fallback;
}

function fmtMs(n) {
  return Number.isFinite(n) ? n.toFixed(3) : "0.000";
}

function fmtNum(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

function toMarkdown(result, server) {
  const rps = result.requests.average ?? 0;
  const statusSummary = Object.entries(result.statusCodeStats ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, count]) => `${code}:${count}`)
    .join(", ");

  let md = `# Autocannon HTTP benchmark report — ${server} / ${SCENARIO}

Generated: ${new Date().toISOString()}

## Overview

${mdTable(
  ["Metric", "Value"],
  [
    ["Server", server],
    ["Scenario", SCENARIO],
    ["Duration sec", String(DURATION)],
    ["Connections", String(CONNECTIONS)],
    ["Pipelining", String(PIPELINING)],
    ["Workers", String(WORKERS)],
    ["Instances", String(INSTANCES)],
    ["Requests/sec (avg)", fmtNum(rps)],
    ["Total requests", String(result.requests.total ?? 0)],
    ["Throughput MB/s (avg)", fmtNum((result.throughput?.average ?? 0) / 1_048_576)],
    ["Avg latency ms", fmtMs(latencyAt(result.latency, "average"))],
    ["p50 ms", fmtMs(latencyAt(result.latency, "p50"))],
    ["p75 ms", fmtMs(latencyAt(result.latency, "p75"))],
    ["p90 ms", fmtMs(latencyAt(result.latency, "p90"))],
    ["p99 ms", fmtMs(latencyAt(result.latency, "p99"))],
    ["p99.9 ms", fmtMs(latencyAt(result.latency, "p99_9"))],
    ["Max latency ms", fmtMs(latencyAt(result.latency, "max"))],
    ["Non-2xx", String(result.non2xx ?? 0)],
    ["Errors", String(result.errors ?? 0)],
    ["Timeouts", String(result.timeouts ?? 0)],
    ["Status summary", statusSummary],
  ],
)}

## Latency percentiles (ms)

${mdTable(
  ["p50", "p75", "p90", "p99", "p99.9", "p99.99", "max"],
  [
    [
      fmtMs(latencyAt(result.latency, "p50")),
      fmtMs(latencyAt(result.latency, "p75")),
      fmtMs(latencyAt(result.latency, "p90")),
      fmtMs(latencyAt(result.latency, "p99")),
      fmtMs(latencyAt(result.latency, "p99_9")),
      fmtMs(latencyAt(result.latency, "p99_99")),
      fmtMs(latencyAt(result.latency, "max")),
    ],
  ],
)}

> Higher RPS + flat percentiles = the server is the bottleneck. A low RPS with a
> p99 near the timeout = the CLIENT cannot keep up (the in-repo generator's
> 256-fetch cap produces exactly that signature — see bench/autocannon-stress.mjs).
`;
  return md;
}

function writeReport(result, server) {
  const outDir = join(OUT_DIR, server);
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${SCENARIO}.ac`);
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${base}.md`, toMarkdown(result, server));
  console.log(`  report: ${base}.md`);
  console.log(`  json:   ${base}.json`);
}

/** Median of a numeric array (undefined/NaN-safe). */
function medianOf(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Summarise N autocannon results into a single median-of-N markdown report.
 * Reports per-metric median RPS/latency plus the spread (min/max RPS) so
 * run-to-run noise is visible rather than hidden.
 */
function toMedianMarkdown(results, server) {
  const rps = results.map((r) => r.requests.average ?? 0);
  const pick = (key) => medianOf(results.map((r) => latencyAt(r.latency, key)));
  const statusSummary =
    Object.entries(results[results.length - 1].statusCodeStats ?? {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([code, count]) => `${code}:${count}`)
      .join(", ");

  let md = `# Autocannon median-of-${results.length} report — ${server} / ${SCENARIO}

Generated: ${new Date().toISOString()}

${mdTable(
  ["Metric", "Value"],
  [
    ["Server", server],
    ["Scenario", SCENARIO],
    ["Runs (median-of-N)", String(results.length)],
    ["Duration sec / run", String(DURATION)],
    ["Connections", String(CONNECTIONS)],
    ["Pipelining", String(PIPELINING)],
    ["Workers", String(WORKERS)],
    ["Instances", String(INSTANCES)],
    ...(STATIC_PATH
      ? [
          ["Path", STATIC_PATH],
          ["Method", STATIC_METHOD],
          ...(STATIC_BODY ? [["Body", STATIC_BODY]] : []),
        ]
      : [["Request mix", "03-stress weighted"]]),
    ["Median Requests/sec", fmtNum(medianOf(rps))],
    ["RPS spread (min…max)", `${fmtNum(Math.min(...rps))} … ${fmtNum(Math.max(...rps))}`],
    ["Median Throughput MB/s", fmtNum(medianOf(results.map((r) => (r.throughput?.average ?? 0) / 1_048_576)))],
    ["Median p50 ms", fmtMs(pick("p50"))],
    ["Median p75 ms", fmtMs(pick("p75"))],
    ["Median p90 ms", fmtMs(pick("p90"))],
    ["Median p99 ms", fmtMs(pick("p99"))],
    ["Median p99.9 ms", fmtMs(pick("p99_9"))],
    ["Median max ms", fmtMs(pick("max"))],
    ["Non-2xx (last run)", String(results[results.length - 1].non2xx ?? 0)],
    ["Errors (last run)", String(results[results.length - 1].errors ?? 0)],
    ["Timeouts (last run)", String(results[results.length - 1].timeouts ?? 0)],
    ["Status summary (last run)", statusSummary],
  ],
)}

> Median-of-N across ${results.length} identical runs; RPS spread shows the
> host-noise band. Compare MEDIAN RPS across servers — not single runs.
`;
  return md;
}

function writeMedianReport(results, server) {
  const outDir = join(OUT_DIR, server);
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${SCENARIO}.median`);
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${base}.md`, toMedianMarkdown(results, server));
  console.log(`  median: ${base}.md`);
}

/**
 * Kill every spawned server process and WAIT for it to actually exit.
 *
 * A bare `proc.kill()` (SIGTERM) is fire-and-forget: under sustained 500-connection
 * load Bun can defer SIGTERM handling, leaving orphaned servers listening on the
 * bench ports. The next run then dies in `assertPortFree` with "already answers
 * /health" — and the "fixed" benchmark silently measures a stale server. This waits
 * for each process to exit (with a SIGKILL fallback after a short grace) so the
 * finally block can never strand a server.
 */
function killServerProcs(procs) {
  return Promise.all(
    procs.map(
      (proc) =>
        new Promise((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
          proc.once("exit", resolve);
          try {
            proc.kill("SIGTERM");
          } catch {
            return resolve();
          }
          const grace = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }
          }, 2000);
          proc.once("exit", () => clearTimeout(grace));
        }),
    ),
  );
}

async function main() {
  const filterServer = process.env.SERVER;
  const servers = filterServer
    ? SERVERS.filter((s) => s === filterServer)
    : [...SERVERS];

  if (servers.length === 0) {
    throw new Error(`Unknown SERVER=${filterServer}. Valid: ${SERVERS.join(", ")}`);
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Autocannon max-throughput benchmark (bun/elysia/ingress) ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Servers:    ${servers.join(", ")}`);
  console.log(`Scenario:   ${SCENARIO}`);
  console.log(`Duration:   ${DURATION}s · connections: ${CONNECTIONS} · pipelining: ${PIPELINING} · workers: ${WORKERS} · instances: ${INSTANCES}`);
  console.log("");

  const procs = [];
  try {
    for (const kind of servers) {
      procs.push(...(await startServer(kind)));
    }

    // RUN-MAJOR interleaving: visit every server once per round. On a noisy
    // host a single slow window then affects EVERY server's run-i equally, so
    // the median-of-N compares servers over the same load windows. The old
    // server-major order (all of bun's runs, then all of elysia's, …) biased
    // later servers (ingress/router) into later, noisier windows.
    const collected = new Map(servers.map((k) => [k, []]));
    for (let r = 0; r < RUNS; r++) {
      for (const kind of servers) {
        if (RUNS > 1) {
          console.log(`\n  round ${r + 1}/${RUNS} — ${kind} × ${SCENARIO}`);
        } else {
          console.log(`\n${"═".repeat(60)}`);
          console.log(`  AUTOCANNON × ${kind} × ${SCENARIO}`);
          console.log(`${"═".repeat(60)}`);
        }
        const result = await runAutocannon(PORTS[kind], kind);
        collected.get(kind).push(result);
        writeReport(result, kind);
      }
    }
    for (const kind of servers) {
      if (RUNS > 1) {
        writeMedianReport(collected.get(kind), kind);
      }
    }
  } finally {
    await killServerProcs(procs);
    console.log("✗ servers stopped");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
