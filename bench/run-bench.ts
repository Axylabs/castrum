// bench/run-bench.ts — updated to show scenario groups
import { PORTS, type ServerKind } from "./servers/shared";
import { HTTP_SCENARIO_NAMES, runHttpScenario } from "./load";

const SERVERS: ServerKind[] = ["bun", "elysia", "ingress"];

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  kind: ServerKind;
  port: number;
}

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  await waitForServer(PORTS[kind]);
  console.log(`✓ ${kind} server ready on :${PORTS[kind]}`);
  return { proc, kind, port: PORTS[kind] };
}

async function main() {
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