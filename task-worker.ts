import { parentPort } from "node:worker_threads";
import { rust } from "./native";
import { nativeTaskProcess } from "./shared";

if (!parentPort) {
  throw new Error("task-worker must be run as a worker thread");
}

parentPort.on("message", (msg) => {
  const input = new Uint8Array(msg.input);

  if (msg.mode === "rust") {
    const out = new Uint8Array(256 * 1024);

    const written = rust.taskProcess(input, out);

    parentPort!.postMessage({
      id: msg.id,
      ok: written >= 0,
      len: Number(written),
    });

    return;
  }

  const result = nativeTaskProcess(input);

  parentPort!.postMessage({
    id: msg.id,
    ok: true,
    len: result.byteLength,
  });
});