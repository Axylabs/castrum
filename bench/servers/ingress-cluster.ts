// bench/servers/ingress-cluster.ts
//
// Production-oriented multi-worker launcher for the optimized ingress server.
//
// Usage:
//   bun bench/servers/ingress-cluster.ts
//
// Environment:
//   INGRESS_WORKERS=16
//   INGRESS_REUSE_PORT=1
//   INGRESS_SECURITY_HEADERS=0
//   INGRESS_OUTPUT_BUF_BYTES=262144
//
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";

const workerCount = Math.max(
  1,
  Number(process.env.INGRESS_WORKERS || cpus().length) | 0,
);

const serverScript = fileURLToPath(
  new URL("./ingress-server.ts", import.meta.url),
);

const children = new Map<number, ReturnType<typeof Bun.spawn>>();
let shuttingDown = false;

function startWorker(id: number): void {
  const proc = Bun.spawn(["bun", "run", serverScript], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      INGRESS_WORKER_ID: String(id),
      INGRESS_REUSE_PORT: process.env.INGRESS_REUSE_PORT || "1",
    },
  });

  children.set(id, proc);

  proc.exited.then((code) => {
    if (shuttingDown) return;

    console.error(`[ingress-cluster] worker ${id} exited with code ${code}`);
    console.error(`[ingress-cluster] restarting worker ${id} in 250ms`);

    setTimeout(() => {
      if (!shuttingDown) {
        startWorker(id);
      }
    }, 250);
  });
}

for (let i = 0; i < workerCount; i++) {
  startWorker(i);
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    child.kill();
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});