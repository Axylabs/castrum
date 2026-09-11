// bench/cost/task-offload.ts — sync native vs off-thread task runtime.
//
// Answers ONE question: what does it cost to keep Bun's event loop responsive
// while a CPU-bound native op runs? For each strategy it measures BOTH the
// wall time and the event-loop max-gap (starvation) — duration alone hides the
// problem this feature exists to fix.
//
// Run: bun run bench:task

import { rust } from '../../src/rust-ffi'
import { createTaskRuntime } from '../../src/task'

const MiB = 1024 * 1024
const payload = new Uint8Array(24 * MiB)
for (let i = 0; i < payload.length; i += 4096) payload[i] = (i * 2654435761) & 0xff

const compressed = Bun.gzipSync(payload)
console.log(
  `payload ${(payload.length / MiB).toFixed(0)} MiB → gzip ${(compressed.length / MiB).toFixed(2)} MiB` +
    ` | cores ${navigator.hardwareConcurrency} | bun ${Bun.version}\n`,
)

interface Row {
  variant: string
  ms: number
  gapMs: number
  note: string
}

/** Run `fn` and report duration + the worst event-loop stall it caused. */
async function measure(
  variant: string,
  note: string,
  run: () => unknown | Promise<unknown>,
): Promise<Row> {
  let maxGap = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 2)
  await Bun.sleep(30) // let the timer settle
  last = performance.now()
  const t0 = performance.now()
  await run()
  const ms = performance.now() - t0
  await Bun.sleep(30) // observe the gap the op created
  clearInterval(timer)
  maxGap = Math.max(maxGap, performance.now() - last)
  return { variant, ms, gapMs: maxGap, note }
}

const tasks = createTaskRuntime()
const rows: Row[] = []

rows.push(
  await measure('rust.gzipDecompress (sync native)', 'blocks the loop', () =>
    rust.gzipDecompress(compressed),
  ),
)
rows.push(
  await measure('Bun.gunzipSync (sync built-in)', 'blocks the loop', () =>
    Bun.gunzipSync(compressed),
  ),
)
if (typeof Bun.zstdDecompress === 'function') {
  const zstd = Bun.zstdCompressSync(payload)
  rows.push(
    await measure('Bun.zstdDecompress (Bun async ref)', 'Bun-native async', () =>
      Bun.zstdDecompress(zstd),
    ),
  )
}
rows.push(
  await measure('tasks.gzipDecompress (off-thread)', 'loop stays free', () =>
    tasks.gzipDecompress(compressed),
  ),
)

// Concurrency: many independent 1 MiB decompressions, sequential vs overlapped.
const chunk = payload.subarray(0, MiB)
const chunkGz = Bun.gzipSync(chunk)
const N = 32
rows.push(
  await measure(`${N}× rust.gzipDecompress (sequential)`, 'sync = no overlap', () => {
    for (let i = 0; i < N; i++) rust.gzipDecompress(chunkGz)
  }),
)
rows.push(
  await measure(`${N}× tasks.gzipDecompress (concurrent)`, 'pool = real parallel', () =>
    Promise.all(Array.from({ length: N }, () => tasks.gzipDecompress(chunkGz))),
  ),
)

// ── CPU-heavy, tiny output: the real offload sweet spot ──────────────
// A 300k-round PBKDF2 is ~100-300 ms of pure CPU with a 32-byte result, so the
// JS thread pays no result-copy cost at all — only the offload itself matters.
const password = new TextEncoder().encode('correct horse battery staple')
const salt = new TextEncoder().encode('saltsaltsalt')
const ROUNDS = 300_000
rows.push(
  await measure(`rust.pbkdf2Sha256 ${ROUNDS / 1000}k (sync)`, 'blocks the loop', () =>
    rust.pbkdf2Sha256(password, salt, ROUNDS, 32),
  ),
)
const { pbkdf2 } = await import('node:crypto')
rows.push(
  await measure('crypto.pbkdf2 (Node async ref)', 'Bun-native async', () =>
    new Promise<void>((resolve, reject) => {
      pbkdf2(password, salt, ROUNDS, 32, 'sha256', (err) => (err ? reject(err) : resolve()))
    }),
  ),
)
rows.push(
  await measure(`tasks.pbkdf2Sha256 ${ROUNDS / 1000}k (off-thread)`, 'tiny result, loop free', () =>
    tasks.pbkdf2Sha256(password, salt, { rounds: ROUNDS, dkLen: 32 }),
  ),
)
const K = 8
rows.push(
  await measure(`${K}× rust.pbkdf2Sha256 (sequential)`, 'sync = no overlap', () => {
    for (let i = 0; i < K; i++) rust.pbkdf2Sha256(password, salt, ROUNDS, 32)
  }),
)
rows.push(
  await measure(`${K}× tasks.pbkdf2Sha256 (concurrent)`, 'pool = real parallel', () =>
    Promise.all(
      Array.from({ length: K }, () =>
        tasks.pbkdf2Sha256(password, salt, { rounds: ROUNDS, dkLen: 32 }),
      ),
    ),
  ),
)

// ── argon2id verify: the auth-path stall ─────────────────────────────
// Bun offloads its own password API, but a verify with CUSTOM cost parameters
// has no async form — that is the case this op exists for.
const phc = rust.passwordHash(password, salt, {
  mCost: 32_768,
  tCost: 3,
  pCost: 1,
  outLen: 32,
}) as string
const phcBytes = new TextEncoder().encode(phc)
rows.push(
  await measure('rust.passwordVerify (sync native)', 'blocks the loop', () =>
    rust.passwordVerify(password, phcBytes),
  ),
)
rows.push(
  await measure('tasks.argon2Verify (off-thread)', 'one-byte answer, loop free', () =>
    tasks.argon2Verify(password, phcBytes),
  ),
)

// ── gzip compress: a built-in that stalls ────────────────────────────
// `rust.gzipCompress` delegates to `Bun.gzipSync` under Bun, so the sync row IS
// the built-in — offloading it is the only way to stop the stall.
rows.push(
  await measure('Bun.gzipSync (sync built-in)', 'blocks the loop', () =>
    Bun.gzipSync(payload),
  ),
)
rows.push(
  await measure('tasks.gzipCompress (off-thread)', 'loop stays free', () =>
    tasks.gzipCompress(payload),
  ),
)

// ── brotli decompress: large output, no size trailer ─────────────────
// Brotli has no ISIZE field, so the zero-copy destination starts from a ratio
// guess and the needed-size retry lands the exact size (at most one extra pass).
const brotliSrc = new Uint8Array(4 * MiB).fill(0x7a)
const brotli = rust.brotliCompress(brotliSrc, 5)
rows.push(
  await measure('rust.brotliDecompress (sync native)', 'blocks the loop', () =>
    rust.brotliDecompress(brotli),
  ),
)
rows.push(
  await measure('tasks.brotliDecompress (off-thread)', 'guess + exact retry', () =>
    tasks.brotliDecompress(brotli),
  ),
)

console.log(
  'variant'.padEnd(42),
  'time'.padStart(10),
  'loop stall'.padStart(12),
  '  note',
)
for (const r of rows) {
  console.log(
    r.variant.padEnd(42),
    `${r.ms.toFixed(1)}ms`.padStart(10),
    `${r.gapMs.toFixed(1)}ms`.padStart(12),
    `  ${r.note}`,
  )
}

// Per-task overhead: 2000 tiny tasks overlapped, so the batched doorbell cost
// is amortized the way the design intends. One run of this is noisy (±5%), so
// it is measured as best-of-N — the number to trust is the BEST case, because
// the worst case is scheduler interference rather than the runtime.
const smallGz = Bun.gzipSync(new TextEncoder().encode('x'.repeat(256)))
const TINY = 2000
const REPS = 5
let bestMs = Number.POSITIVE_INFINITY
for (let round = 0; round < REPS; round++) {
  const t0 = performance.now()
  await Promise.all(Array.from({ length: TINY }, () => tasks.gzipDecompress(smallGz)))
  bestMs = Math.min(bestMs, performance.now() - t0)
}
const after = tasks.stats()
console.log(
  `\nper-task overhead: ${((bestMs * 1e6) / TINY).toFixed(0)} ns/task` +
    ` (best of ${REPS} × ${TINY} overlapped 256 B decompressions in ${bestMs.toFixed(1)} ms)`,
)
console.log(
  `drain rounds: ${after.drains} for ${after.completed} completions` +
    ` → ${(after.completed / Math.max(1, after.drains)).toFixed(1)} completions/round` +
    ` (max batch ${after.maxBatch})`,
)
console.log(`pool threads: ${after.threads}`)
