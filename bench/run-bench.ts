// bench/run-bench.ts — updated to show scenario groups
import { PORTS, type ServerKind } from "./servers/shared";
import { HTTP_SCENARIO_NAMES, runHttpScenario } from "./load";
import { getBunFFI } from "../src/native/ffi";
import { isBun } from "../src/shared/runtime";

const SERVERS: ServerKind[] = ["bun", "elysia", "ingress"];

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  kind: ServerKind;
  port: number;
}

/**
 * Verify nothing is already answering on `port` before we spawn a server.
 *
 * A previous killed run can leave a stale process bound to 9120–9122; without
 * this check `waitForServer` would happily measure the WRONG server. Note: the
 * ownership check is best-effort (health-response + spawn liveness) rather than
 * a full PID-of-listener lookup, so it is still the caller's job to ensure no
 * foreign process uses these ports.
 */
async function assertPortFree(port: number): Promise<void> {
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
    // Connection refused / not ready yet → port is free. Good.
  }
}

async function waitForServer(
  port: number,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 15_000,
): Promise<void> {
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
    await Bun.sleep(200);
  }
  throw new Error(`Server on :${port} did not become ready within ${timeoutMs}ms`);
}

async function startServer(kind: ServerKind): Promise<ServerHandle> {
  const script = `./bench/servers/${kind}-server.ts`;
  await assertPortFree(PORTS[kind]);
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  await waitForServer(PORTS[kind], proc);
  console.log(`✓ ${kind} server ready on :${PORTS[kind]}`);
  return { proc, kind, port: PORTS[kind] };
}

async function main() {
  // ── Transport guard (FFI is PRIMARY on Bun) ─────────────────────
  // The ingress server's per-request path runs through bun:ffi on Bun. When
  // the ffi transport is unavailable (Node, forced CASTRUM_FFI_MODE=napi, or a
  // failed bind-time self-test) this HTTP bench would silently measure the
  // napi fallback — print a warning so the report is never mistaken for the
  // primary path. CASTRUM_BENCH_FFI=1 turns that into a hard failure for CI
  // that must guarantee FFI-primary HTTP measurements (mirrors src/bench/run.ts).
  const ffiActive = getBunFFI() !== null;
  if (isBun() && !ffiActive) {
    const msg =
      "bun:ffi is NOT active on Bun — the ingress server will run through the " +
      "napi fallback. Unset CASTRUM_FFI_MODE (or set it to auto) and ensure the " +
      "addon bind-time self-test passes.";
    if (process.env.CASTRUM_BENCH_FFI === "1") {
      throw new Error(`CASTRUM_BENCH_FFI=1: ${msg}`);
    }
    console.warn(`\u26a0\ufe0f  ${msg}`);
  } else if (isBun()) {
    console.log("bun:ffi active — ingress runs through the primary FFI transport.");
  }

  const filterScenario = process.env.SCENARIO || process.argv[2];
  const filterServer = process.env.SERVER || process.argv[3];

  const scenarios = filterScenario
    ? HTTP_SCENARIO_NAMES.filter((s) => s.includes(filterScenario))
    : [...HTTP_SCENARIO_NAMES];

  const servers = filterServer
    ? SERVERS.filter((s) => s === filterServer)
    : [...SERVERS];

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Bun vs Elysia vs Ingress — Heavy JSON Load Benchmark  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Servers:    ${servers.join(", ")}`);
  console.log(`Scenarios:  ${scenarios.length} selected`);
  console.log(`  ${scenarios.join("\n  ")}`);
  console.log("");

  const handles: ServerHandle[] = [];
  for (const kind of servers) {
    handles.push(await startServer(kind));
  }

  const startTime = Date.now();

  for (const scenario of scenarios) {
    for (const handle of handles) {
      try {
        await runHttpScenario({
          scenario,
          server: handle.kind,
          port: handle.port,
        });
      } catch (err) {
        console.error(`✗ ${handle.kind} × ${scenario} failed:`, err);
      }
    }
  }

  for (const handle of handles) {
    handle.proc.kill();
    console.log(`✗ ${handle.kind} server stopped`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ All benchmarks complete in ${elapsed}s. Results in ./bench/results/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});