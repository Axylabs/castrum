// bench/ffi/ffi-workers.ts — verify the bun:ffi layer holds up under multi-worker
// server load (the realistic "huge request rate" scenario): N workers each
// hammer rust.crc32 / rust.hexEncode via the ffi path and cross-check results
// against the napi addon. Confirms no thread-safety issue from sharing one
// dlopen'd cdylib across worker threads.
//
// Run: bun run bench/ffi-workers.ts

const SCRIPT = new URL("./ffi-worker-script.ts", import.meta.url).pathname;
const N = 4;

const workers = Array.from({ length: N }, () => new Worker(SCRIPT));
const results = await Promise.all(
  workers.map(
    (w) =>
      new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 20_000);
        w.addEventListener("message", (e: any) => {
          clearTimeout(timer);
          resolve(e.data);
        });
        w.addEventListener("error", (e: any) => {
          clearTimeout(timer);
          resolve({ ok: false, error: String(e?.message ?? e) });
        });
      }),
  ),
);

for (const [i, r] of results.entries()) {
  if (!r.ok) {
    console.log(`worker ${i}: ERROR ${r.error}`);
    continue;
  }
  console.log(
    `worker ${i}: ffiActive=${r.ffiActive} crcOk=${r.crcOk} hexOk=${r.hexOk} crc=${r.crcNs.toFixed(0)}ns hex=${r.hexNs.toFixed(0)}ns`,
  );
}

const allOk = results.every((r) => r.ok && r.ffiActive && r.crcOk && r.hexOk);
const ok = results.filter((r) => r.ok);
const avgCrc = ok.reduce((a, r) => a + r.crcNs, 0) / ok.length;
console.log("");
console.log(`all ${N} workers correct + ffi active: ${allOk}`);
console.log(
  `avg crc32 via ffi per worker: ${avgCrc.toFixed(1)}ns (~${(1e9 / avgCrc / 1e6).toFixed(1)}M ops/s/worker)`,
);
console.log(
  `aggregate ffi crc32 across ${N} workers: ~${(((1e9 / avgCrc) * N) / 1e6).toFixed(1)}M ops/s`,
);
for (const w of workers) w.terminate();
