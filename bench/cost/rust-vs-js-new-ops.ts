// bench/cost/rust-vs-js-new-ops.ts — three-way op cost: pure-JS (raw Bun) vs
// Rust-via-napi (the compiled addon) vs Rust-via-bun:ffi (Bun's primary
// transport), for the ops added for the ignex/safo scan: the metrics
// registry, batch fixed-width hex validation, and JS-RegExp escaping.
//
// The JS baselines mirror what the consumers actually ship today:
//   - metrics  — ignex `platform/metrics.ts`: per-event label-key building
//                (entries sort + 2× regex escape + join) + Map counters;
//                render walks the Map and concatenates Prometheus lines.
//   - hex      — safo `modules/*.ts`: per-item `/^[0-9a-f]{24}$/i` regex test
//                (+ a hand-rolled ASCII loop as the best-case JS baseline).
//   - regex    — MDN escapeRegExp replace chain + `new RegExp` compile.
//
// The ffi rows show what Bun 1.4 buys on top of Rust: cstring ARGs transcode
// strings IN-ENGINE (zero TextEncoder) and cstring returns clone back
// in-engine (zero TextDecoder) — the JS side only pays `values.join('\x1f')`.
//
// Run: `bun run bench:newops`

import { getAddon } from '../../src/native'
import { getBunFFI } from '../../src/native/ffi'
import { rust } from '../../src/rust-ffi'
import { encoder } from '../../src/shared/bytes'
import { measureNs as measure } from '../measure'

const bunFFI = getBunFFI()
const addon = getAddon()
if (!bunFFI) {
  console.log('NOTE: bun:ffi not active — ffi columns will read n/a\n')
}

// ── Shared fixtures ─────────────────────────────────────────────────────────
const LABEL_KEYS = 'route\x1fstatus'
const ROUTE = '/api/orders'
const STATUS = '200'

const HEX_OK_1 = '507f1f77bcf86cd799439011'
const HEX_BAD = 'zz-not-an-objectid!!'
const mkIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => (i % 10 === 0 ? HEX_BAD : HEX_OK_1))
const ID_200 = mkIds(200)
const ID_1000 = mkIds(1000)
const HEX_RE = /^[0-9a-f]{24}$/i

function hexOkAsciiLoop(s: string): boolean {
  if (s.length !== 24) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
    if (!ok) return false
  }
  return true
}

const NEEDLES = ['search term', 'a.c*(x)', '50% off [sale]', 'user@example.com']
const ESCAPE_RE = /[\\.*+?^${}()|[\]]/g

// Real traffic does NOT see constant labels — rotate through a small pool so
// neither side gets JIT constant-folding help.
const ROUTE_POOL = ['/api/orders', '/api/gigs', '/api/me/wallet', '/api/catalog/gigs']
const STATUS_POOL = ['200', '200', '201', '500']
let rot = 0
const nextLabels = (): [string, string] => {
  rot = (rot + 1) % ROUTE_POOL.length
  return [ROUTE_POOL[rot] ?? ROUTE, STATUS_POOL[rot] ?? STATUS]
}
const OBSERVE_VALUE = 0.13
const HIST_BUCKETS = [0.1, 0.25, 0.5, 1]

// ── JS baseline (the shipped implementation shape) ──────────────────────────
function jsMetrics() {
  const counters = new Map<string, number>()
  const hist = new Map<string, { counts: number[]; sum: number; count: number }>()
  const escapeLabelValue = (v: string): string =>
    v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return {
    counterInc(name: string, labels: Record<string, string>): void {
      const lk = Object.entries(labels)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
        .join(',')
      const key = `${name}{${lk}}`
      counters.set(key, (counters.get(key) ?? 0) + 1)
    },
    observe(name: string, labels: Record<string, string>, v: number): void {
      const lk = Object.entries(labels)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v2]) => `${k}="${escapeLabelValue(v2)}"`)
        .join(',')
      const key = `${name}{${lk}}`
      let st = hist.get(key)
      if (!st) {
        st = { counts: new Array(HIST_BUCKETS.length).fill(0), sum: 0, count: 0 }
        hist.set(key, st)
      }
      let i = 0
      while (i < HIST_BUCKETS.length && HIST_BUCKETS[i]! < v) i++
      if (i < st.counts.length) st.counts[i] = (st.counts[i] ?? 0) + 1
      st.sum += v
      st.count++
    },
    render(): string {
      let out = ''
      for (const [k, v] of counters) out += `${k} ${v}\n`
      return out
    },
  }
}
const js = jsMetrics()

// ── Native instances ────────────────────────────────────────────────────────
const reg = rust.createMetricsRegistry() // ffi-backed under Bun
const COUNTER_ID = reg.counter('bench_requests_total', ['route', 'status'])
const HIST_ID = reg.histogram('bench_latency_seconds', ['route', 'status'], HIST_BUCKETS)

const napiReg = new addon.MetricsRegistry()
const NAPI_COUNTER = napiReg.counter('bench_requests_total', ['route', 'status'])
const NAPI_HIST = napiReg.histogram('bench_latency_seconds', ['route', 'status'], HIST_BUCKETS)

// Raw C-ABI floor: second handle + PRE-packed values kept alive across events.
const rawHandle = bunFFI?.metricsCreate() ?? 0
const rawId = bunFFI?.metricsCounter(rawHandle, 'bench_requests_total', LABEL_KEYS) ?? 0

// Warm steady state (Map hits, not first-inserts; JIT warm-up).
for (let i = 0; i < 1000; i++) {
  const [r, s] = nextLabels()
  js.counterInc('bench_requests_total', { route: r, status: s })
  reg.record(COUNTER_ID, [r, s], 1)
  napiReg.record(NAPI_COUNTER, [r, s], 1)
}

// ── Measurements ────────────────────────────────────────────────────────────
const FFI_ON = bunFFI !== null && rawHandle !== 0

// Crossing floor: a null-handle no-op — pure FFI marshaling, zero native work.
const tCrossingFloor = FFI_ON ? measure(() => bunFFI!.metricsDestroy(0), 500_000) : NaN

// js encode share (what the OLD ffi wrapper paid per event before the _str ops)
const tPackOnly = measure(() => encoder.encode(`${ROUTE}\x1f${STATUS}`), 200_000)

// ── metrics: labeled counter inc (rotating labels) ──
const tJsCounter = measure(() => {
  const [r, s] = nextLabels()
  js.counterInc('bench_requests_total', { route: r, status: s })
}, 200_000)
const tNapiCounter = measure(() => {
  const [r, s] = nextLabels()
  napiReg.record(NAPI_COUNTER, [r, s], 1)
}, 200_000)
const tFfiCounter = measure(() => {
  const [r, s] = nextLabels()
  reg.record(COUNTER_ID, [r, s], 1)
}, 200_000)
const tFfiCounterRaw = FFI_ON
  ? measure(() => {
      bunFFI!.metricsRecordStr(rawHandle, rawId, `${ROUTE}\x1f${STATUS}`, 1)
    }, 200_000)
  : NaN

// ── metrics: labeled histogram observe (rotating labels) ──
const tJsObserve = measure(() => {
  const [r, s] = nextLabels()
  js.observe('bench_latency_seconds', { route: r, status: s }, OBSERVE_VALUE)
}, 200_000)
const tNapiObserve = measure(() => {
  const [r, s] = nextLabels()
  napiReg.record(NAPI_HIST, [r, s], OBSERVE_VALUE)
}, 200_000)
const tFfiObserve = measure(() => {
  const [r, s] = nextLabels()
  reg.record(HIST_ID, [r, s], OBSERVE_VALUE)
}, 200_000)

// ── metrics: render ~100 series ──
for (let i = 0; i < 100; i++) {
  js.counterInc(`bench_series_${i}_total`, { route: `/r${i}`, status: '200' })
  const id = reg.counter(`bench_series_${i}`, ['route', 'status'])
  reg.record(id, [`/r${i}`, '200'], 1)
  const nid = napiReg.counter(`bench_series_${i}`, ['route', 'status'])
  napiReg.record(nid, [`/r${i}`, '200'], 1)
}
const tJsRender = measure(() => js.render(), 20_000)
const tNapiRender = measure(() => napiReg.render(), 20_000)
const tFfiRender = measure(() => reg.render(), 20_000)

// ── batch fixed-width hex validation ──
const hexBytes200 = encoder.encode(ID_200.join('\n'))
const hexBytes1k = encoder.encode(ID_1000.join('\n'))
const tJsHex200 = measure(() => {
  let valid = 0
  for (const id of ID_200) if (HEX_RE.test(id)) valid++
  return valid
}, 5_000)
const tJsAscii200 = measure(() => {
  let valid = 0
  for (const id of ID_200) if (hexOkAsciiLoop(id)) valid++
  return valid
}, 5_000)
const tNapiHex200 = measure(() => addon.hexValidateBatch(hexBytes200, 24).length, 5_000)
const tFfiHexBytes200 = measure(
  () => rust.hexValidateBatch(hexBytes200, 24).length, 5_000)
const tFfiHexArr200 = measure(() => rust.hexValidateBatch(ID_200, 24).length, 5_000)

const tJsHex1k = measure(() => {
  let valid = 0
  for (const id of ID_1000) if (HEX_RE.test(id)) valid++
  return valid
}, 3_000)
const tNapiHex1k = measure(() => addon.hexValidateBatch(hexBytes1k, 24).length, 3_000)
const tFfiHexArr1k = measure(() => rust.hexValidateBatch(ID_1000, 24).length, 3_000)

// ── RegExp escaping ──
const tJsEscape = measure(() => {
  for (const nd of NEEDLES) nd.replace(ESCAPE_RE, '\\$&')
}, 200_000)
const tJsEscapeCompiled = measure(() => {
  // Full app pattern: escape AND compile the RegExp per request.
  for (const nd of NEEDLES) new RegExp(nd.replace(ESCAPE_RE, '\\$&'), 'i')
}, 50_000)
const tNapiEscape = measure(() => {
  for (const nd of NEEDLES) addon.regexEscape(nd)
}, 200_000)
const tFfiEscape = measure(() => {
  for (const nd of NEEDLES) rust.regexEscape(nd)
}, 200_000)

// ── Report ──────────────────────────────────────────────────────────────────
const fmt = (ns: number): string =>
  Number.isNaN(ns) ? '   n/a' : ns >= 1000 ? `${(ns / 1000).toFixed(2)}µs` : `${ns.toFixed(0)}ns`
const row = (label: string, ...cols: number[]): string =>
  `  ${label.padEnd(44)} ${cols.map((c) => fmt(c).padStart(9)).join(' │ ')}`
/** Ratio tag: how many times faster than the JS baseline the column ran. */
const speedTag = (jsNs: number, col: number): string =>
  Number.isNaN(col) || jsNs === 0 ? '' : `  ← ${(jsNs / col).toFixed(1)}x vs js`

console.log('═══ new ops: js (raw Bun) vs napi (Rust addon) vs ffi (Bun+Rust) ═══')
console.log(`  ns/op · min-of-5 · Bun ${Bun.version} · ffi ${FFI_ON ? 'active' : 'OFF'}`)
console.log('')
console.log(`  ${'ffi crossing floor (no-op symbol call)'.padEnd(44)} ${fmt(tCrossingFloor)}`)
console.log(`  ${'js pack share the old ffi paid (encode)'.padEnd(44)} ${fmt(tPackOnly)}`)
console.log('── metrics: labeled counter inc (rotating labels) ──')
console.log(row('js: key build (sort+escape+join) + Map', tJsCounter))
console.log(row('napi: MetricsRegistry.record', tNapiCounter), speedTag(tJsCounter, tNapiCounter))
console.log(row('ffi: registry.record (public)', tFfiCounter), speedTag(tJsCounter, tFfiCounter))
console.log(row('ffi: record_str (cstring arg, no encode)', tFfiCounterRaw),
  speedTag(tJsCounter, tFfiCounterRaw), `· floor=${fmt(tCrossingFloor)}`)
console.log('── metrics: labeled histogram observe (rotating) ──')
console.log(row('js: key build + bucket scan + sums', tJsObserve))
console.log(row('napi: MetricsRegistry.record(hist)', tNapiObserve), speedTag(tJsObserve, tNapiObserve))
console.log(row('ffi: registry.record(hist)', tFfiObserve), speedTag(tJsObserve, tFfiObserve))
console.log('── metrics: render ~100 series (per-scrape) ──')
console.log(row('js: Map walk + concat (bare lines)', tJsRender))
console.log(row('napi: registry.render()', tNapiRender))
console.log(row('ffi: registry.render()', tFfiRender))
console.log('── batch fixed-width hex validation ──')
console.log(row('js: 200× regex.test', tJsHex200))
console.log(row('js: 200× ascii-loop', tJsAscii200))
console.log(row('napi: hexValidateBatch(bytes)', tNapiHex200), speedTag(tJsHex200, tNapiHex200))
console.log(row('ffi: hexValidateBatch(bytes)', tFfiHexBytes200), speedTag(tJsHex200, tFfiHexBytes200))
console.log(row('ffi: hexValidateBatch(string[]) ← app shape', tFfiHexArr200),
  speedTag(tJsHex200, tFfiHexArr200))
console.log('')
console.log(row('js: 1000× regex.test', tJsHex1k))
console.log(row('napi: hexValidateBatch 1000 (bytes)', tNapiHex1k), speedTag(tJsHex1k, tNapiHex1k))
console.log(row('ffi: hexValidateBatch 1000 (string[])', tFfiHexArr1k),
  speedTag(tJsHex1k, tFfiHexArr1k))
console.log('── RegExp escaping (4 needles) ──')
console.log(row('js: replace-chain ×4', tJsEscape))
console.log(row('js: escape + new RegExp compile ×4', tJsEscapeCompiled))
console.log(row('napi: regexEscape(str) ×4', tNapiEscape), speedTag(tJsEscape, tNapiEscape))
console.log(row('ffi: regexEscape(str) ×4 (cstring→cstring)', tFfiEscape),
  speedTag(tJsEscape, tFfiEscape))

if (rawHandle !== 0) bunFFI?.metricsDestroy(rawHandle)
reg.destroy?.()
