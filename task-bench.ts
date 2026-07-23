import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { taskBytes } from "./data";

const MODE = process.env.MODE ?? "both";
const JOBS = Number(process.env.JOBS ?? 200);
const WORKERS = Number(process.env.WORKERS ?? 4);
const EVENTS = Number(process.env.EVENTS ?? 20_000);

const payload = taskBytes(EVENTS);

type RunResult = {
  mode: string;
  jobs: number;
  workers: number;
  events: number;
  totalMs: number;
  jobsPerSec: number;
};

async function runMode(mode: "native" | "rust"): Promise<RunResult> {
  const workerFile = fileURLToPath(new URL("./task-worker.ts", import.meta.url));

  const workers = Array.from(
    { length: WORKERS },
    () => new Worker(workerFile),
  );

  let sent = 0;
  let done = 0;
  let finished = false;

  const start = performance.now();

  return new Promise<RunResult>((resolve, reject) => {
    const finish = () => {
      if (finished) return;
      finished = true;

      const totalMs = performance.now() - start;

      for (const worker of workers) {
        worker.terminate();
      }

      resolve({
        mode,
        jobs: JOBS,
        workers: WORKERS,
        events: EVENTS,
        totalMs,
        jobsPerSec: JOBS / (totalMs / 1000),
      });
    };

    const sendNext = (worker: Worker) => {
      if (sent >= JOBS) return;

      const id = sent++;
      const input = payload.slice(0).buffer;

      worker.postMessage(
        {
          id,
          mode,
          input,
        },
        [input],
      );
    };

    for (const worker of workers) {
      worker.on("message", () => {
        done++;

        if (done >= JOBS) {
          finish();
          return;
        }

        sendNext(worker);
      });

      worker.on("error", reject);

      sendNext(worker);
      sendNext(worker);
    }
  });
}

const results: RunResult[] = [];

if (MODE === "both" || MODE === "native") {
  results.push(await runMode("native"));
}

if (MODE === "both" || MODE === "rust") {
  results.push(await runMode("rust"));
}

console.table(
  results.map((r) => ({
    mode: r.mode,
    jobs: r.jobs,
    workers: r.workers,
    events: r.events,
    "total ms": r.totalMs.toFixed(2),
    "jobs/s": r.jobsPerSec.toFixed(2),
  })),
);

if (results.length === 2) {
  const native = results.find((x) => x.mode === "native");
  const rustResult = results.find((x) => x.mode === "rust");

  if (native && rustResult) {
    const ratio = native.totalMs / Math.max(rustResult.totalMs, 1e-9);

    if (ratio >= 1) {
      console.log(`Background task: Rust ${ratio.toFixed(2)}x faster than native`);
    } else {
      console.log(`Background task: Native ${(1 / ratio).toFixed(2)}x faster than Rust`);
    }
  }
}