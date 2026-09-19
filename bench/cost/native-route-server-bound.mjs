// bench/cost/native-route-server-bound.mjs — END-TO-END server-bound measurement
// of the native declarative lane (route-wire v5 zero-callout op program) against
// the JS equivalent and castrum's existing ingress/router participants.
//
// Server-bound config (matches the ceiling methodology in docs/BENCHMARKS.md
// and bench/autocannon-stress.mjs): static path, AC_CONNECTIONS=2000,
// AC_PIPELINING=1, AC_WORKERS=4, median-of-N with run-major interleaving.
//
// Participants (all single-process Bun.serve on localhost):
//   native    bench/http/servers/native-program-server.ts  (v6 program lane)
//   jsnative  bench/http/servers/js-native-server.ts       (JS equivalent)
//   ingress   bench/http/servers/ingress-server.ts         (current ceiling)
//   router    bench/http/servers/router-server.ts          (current ceiling)
//
// Run with NODE (autocannon's client is tuned for Node's http stack):
//   node bench/cost/native-route-server-bound.mjs
// Env: AC_DURATION (default 15), AC_RUNS (default 3), AC_PATH (default
// /api/users), SERVERS (comma list to filter).

import { spawn } from "node:child_process";
import autocannon from "autocannon";

const PORTS = {
  native: 9130,
  jsnative: 9131,
  ingress: 9122,
  router: 9123,
};

const SCRIPTS = {
  native: { script: "bench/http/servers/native-program-server.ts", env: {} },
  jsnative: { script: "bench/http/servers/js-native-server.ts", env: {} },
  ingress: { script: "bench/http/servers/ingress-server.ts", env: {} },
  router: { script: "bench/http/servers/router-server.ts", env: {} },
};

const DURATION = Number(process.env.AC_DURATION ?? 15);
const CONNECTIONS = Number(process.env.AC_CONNECTIONS ?? 2000);
const WORKERS = Number(process.env.AC_WORKERS ?? 4);
const PIPELINING = Number(process.env.AC_PIPELINING ?? 1);
const RUNS = Math.max(1, Number(process.env.AC_RUNS ?? 3));
const PATH = process.env.AC_PATH ?? "/api/users";

const allKinds = ["native", "jsnative", "ingress", "router"];
const KINDS = process.env.SERVERS
  ? allKinds.filter((k) => process.env.SERVERS.split(",").includes(k))
  : allKinds;

async function portFree(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (res.ok) {
      throw new Error(`port :${port} already answers /health — kill the stale server`);
    }
  } catch (err) {
    if (err instanceof Error && /already answers/.test(err.message)) throw err;
  }
}

async function waitFor(port, proc, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`server for :${port} exited during startup (${proc.exitCode})`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server on :${port} not ready in ${timeoutMs}ms`);
}

async function start(kind) {
  const { script, env } = SCRIPTS[kind];
  const port = PORTS[kind];
  // native and nativeMemo share a port, so they are never started together.
  await portFree(port);
  const proc = spawn("bun", ["run", script], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  await waitFor(port, proc);
  return proc;
}

function run(kind) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url: `http://localhost:${PORTS[kind]}${PATH}`,
      connections: CONNECTIONS,
      duration: DURATION,
      pipelining: PIPELINING,
      workers: WORKERS,
      timeout: 10,
      title: `${kind} · ${PATH}`,
    });
    instance.on("error", reject);
    instance.on("done", resolve);
    autocannon.track(instance, { renderProgressBar: false });
  });
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

const procs = [];
const PER_RUN = new Set(); // all participants use distinct ports now

try {
  console.log(
    `native-route server-bound: path=${PATH} connections=${CONNECTIONS} pipelining=${PIPELINING} workers=${WORKERS} runs=${RUNS} duration=${DURATION}s`,
  );

  // Start persistent participants once.
  for (const kind of KINDS) {
    if (PER_RUN.has(kind)) continue;
    const proc = await start(kind);
    procs.push(proc);
    console.log(`✓ ${kind} ready on :${PORTS[kind]}`);
  }

  const results = new Map(KINDS.map((k) => [k, []]));
  for (let r = 0; r < RUNS; r++) {
    for (const kind of KINDS) {
      const perRun = PER_RUN.has(kind);
      const proc = perRun ? await start(kind) : null;
      const res = await run(kind);
      results.get(kind).push(res);
      if (proc) {
        proc.kill("SIGTERM");
        await new Promise((r2) => proc.once("exit", r2));
        await new Promise((r2) => setTimeout(r2, 250));
      }
      const rps = res.requests.average ?? 0;
      const p50 = res.latency.p50 ?? 0;
      console.log(
        `  round ${r + 1}/${RUNS} ${kind.padEnd(10)} ${rps.toFixed(0).padStart(7)} RPS  p50 ${p50.toFixed(3)}ms`,
      );
    }
  }

  console.log(`\n═══ server-bound median-of-${RUNS} (static ${PATH}) ═══`);
  console.log("  server        RPS(med)   spread          p50(med)  p99(med)");
  const rows = KINDS.map((kind) => {
    const rs = results.get(kind);
    const rpss = rs.map((x) => x.requests.average ?? 0);
    const p50 = median(rs.map((x) => x.latency.p50 ?? 0));
    const p99 = median(rs.map((x) => x.latency.p99 ?? 0));
    const med = median(rpss);
    const spread = `${Math.min(...rpss).toFixed(0)}…${Math.max(...rpss).toFixed(0)}`;
    console.log(
      `  ${kind.padEnd(12)} ${med.toFixed(0).padStart(8)}   ${spread.padEnd(14)} ${p50.toFixed(3).padStart(8)}  ${p99.toFixed(3).padStart(8)}`,
    );
    return { kind, med, p50, p99 };
  });
  const native = rows.find((r) => r.kind === "native");
  const ingress = rows.find((r) => r.kind === "ingress");
  if (native && ingress) {
    console.log(
      `\n  native vs ingress: ${(((native.med - ingress.med) / ingress.med) * 100).toFixed(1)}%  ` +
        `(native ${native.med.toFixed(0)} vs ingress ${ingress.med.toFixed(0)} RPS)`,
    );
  }
} finally {
  for (const p of procs) {
    if (p.exitCode === null) p.kill("SIGTERM");
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log("✗ servers stopped");
}
