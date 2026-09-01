// src/native/ffi/build/metrics.ts — metrics-registry BunFFI methods.
//
// Wraps the `castrum_metrics_*` caller-owned-handle surface (route-stack
// ownership model): create returns a native `Box<MetricsRegistry>` handle,
// declare fns cross name/label-keys as cstring ARGS and return the u32 series
// id, and record/set/render take packed byte slices. Receives the raw dlopen'd
// symbols from `build()`.

import { decodeUtf8, encodeUtf8 } from '../../../shared/codec'
import type { BunFFI, Raw0, Raw3, Raw4, Raw5 } from '../types'
import type { BuildCtx } from './util'

/**
 * Sentinel returned by the declare fns (`u32::MAX`) on invalid input — fits
 * f64 exactly and can never collide with a real dense family id.
 */
export const METRICS_DECLARE_ERR = 0xffffffff

/** Empty label-values view (zero-label families). */
const EMPTY = new Uint8Array(0)

/**
 * Build the metrics-registry methods of the BunFFI surface.
 */
export function buildMetrics(
  sym: Record<string, (...a: unknown[]) => unknown>,
  ctx: BuildCtx,
): Partial<BunFFI> {
  const { lenOrView } = ctx
  const metricsCreateRaw = sym.castrum_metrics_create as Raw0
  const metricsCounterRaw = sym.castrum_metrics_counter as Raw3
  const metricsGaugeRaw = sym.castrum_metrics_gauge as Raw3
  const metricsHistogramRaw = sym.castrum_metrics_histogram as Raw4
  const metricsRecordRaw = sym.castrum_metrics_record as Raw5
  const metricsGaugeSetRaw = sym.castrum_metrics_gauge_set as Raw5
  // Zero-encode siblings: joined values cross as a cstring ARG.
  const metricsRecordStrRaw = sym.castrum_metrics_record_str as (...a: unknown[]) => number | bigint
  const metricsGaugeSetStrRaw = sym.castrum_metrics_gauge_set_str as (
    ...a: unknown[]
  ) => number | bigint
  const metricsRenderRaw = sym.castrum_metrics_render as Raw3
  const metricsSnapshotRaw = sym.castrum_metrics_snapshot as Raw3
  const metricsRecordBatchRaw = sym.castrum_metrics_record_batch as Raw3
  const metricsDestroyRaw = sym.castrum_metrics_destroy as (h: unknown) => void

  /** Declare helper: maps the C sentinel to a throw (fail fast at declare). */
  const declareOrThrow = (id: number | bigint, what: string): number => {
    const n = Number(id)
    if (n === METRICS_DECLARE_ERR) {
      throw new Error(`metrics: failed to declare ${what} (invalid name/labels/buckets)`)
    }
    return n
  }

  return {
    metricsCreate() {
      const h = Number(metricsCreateRaw())
      if (h === 0) throw new Error('metrics: registry allocation failed')
      return h
    },
    metricsCounter(handle, name, labelKeys) {
      return declareOrThrow(metricsCounterRaw(handle, name, labelKeys), `counter "${name}"`)
    },
    metricsGauge(handle, name, labelKeys) {
      return declareOrThrow(metricsGaugeRaw(handle, name, labelKeys), `gauge "${name}"`)
    },
    metricsHistogram(handle, name, labelKeys, bucketsCsv) {
      return declareOrThrow(
        metricsHistogramRaw(handle, name, labelKeys, bucketsCsv),
        `histogram "${name}"`,
      )
    },
    metricsRecord(handle, series, values, amount) {
      // Packed `\x1f`-separated values cross as `(ptr,len)`; u8 verdict.
      return Number(metricsRecordRaw(handle, series, values, lenOrView(values), amount)) === 1
    },
    metricsGaugeSet(handle, series, values, value) {
      return Number(metricsGaugeSetRaw(handle, series, values, lenOrView(values), value)) === 1
    },
    metricsRecordStr(handle, series, values, amount) {
      // `values` is the JOINED `\x1f` string — engine-transcoded (zero encode).
      return Number(metricsRecordStrRaw(handle, series, values, amount)) === 1
    },
    metricsGaugeSetStr(handle, series, values, value) {
      return Number(metricsGaugeSetStrRaw(handle, series, values, value)) === 1
    },
    metricsRender(handle, output) {
      // Needed-size convention (routeRun parity): `0` = real error → throw;
      // `> output.length` = the EXACT required size (caller grows once and
      // retries — never a doubling re-run loop).
      const w = Number(metricsRenderRaw(handle, output, lenOrView(output)))
      if (w === 0) throw new Error('metrics render: registry handle invalid or render failed')
      return w
    },
    metricsSnapshot(handle, output) {
      // Needed-size convention (routeRun parity): 0 throws; > length = exact.
      const w = Number(metricsSnapshotRaw(handle, output, lenOrView(output)))
      if (w === 0) throw new Error('metrics snapshot: registry handle invalid')
      return w
    },
    metricsRecordBatch(handle, packed) {
      return Number(metricsRecordBatchRaw(handle, packed, lenOrView(packed))) === 1
    },
    metricsDestroy(handle) {
      metricsDestroyRaw(handle)
    },
  }
}

/**
 * Bind-time self-test for the metrics surface (unique `ct.selftest.*` names).
 * Exercises every symbol's ABI at bind time; `false` disables the ffi layer
 * and forces the napi fallback.
 */
export function selfTestMetrics(b: BunFFI): boolean {
  let handle = 0
  try {
    handle = b.metricsCreate()
    if (handle === 0) return false

    const counter = b.metricsCounter(handle, 'ct_selftest_hits', 'route\u001fstatus')
    if (!Number.isInteger(counter) || counter < 0 || counter === METRICS_DECLARE_ERR) {
      console.error('FAIL: declare')
      return false
    }
    if (!b.metricsRecord(handle, counter, encodeUtf8('/a\u001f200'), 2)) {
      console.error('FAIL: record1')
      return false
    }
    if (!b.metricsRecord(handle, counter, encodeUtf8('/a\u001f200'), 1)) {
      console.error('FAIL: record2')
      return false
    }
    if (!b.metricsRecordStr(handle, counter, '/b\u001f200', 2)) {
      console.error('FAIL: recordStr')
      return false
    }

    console.error('CK: counter')
    const gauge = b.metricsGauge(handle, 'ct_selftest_depth', 'q')
    if (gauge === METRICS_DECLARE_ERR) return false
    if (!b.metricsGaugeSet(handle, gauge, encodeUtf8('jobs'), 4)) return false
    if (!b.metricsGaugeSetStr(handle, gauge, 'io', 6)) return false

    console.error('CK: gauge')
    const hist = b.metricsHistogram(handle, 'ct_selftest_latency', '', '0.1,0.5')
    if (hist === METRICS_DECLARE_ERR) return false
    if (!b.metricsRecord(handle, hist, EMPTY, 0.25)) return false
    if (b.metricsRecord(handle, hist, EMPTY, -1)) return false // negatives rejected

    console.error('CK: hist')
    // Arity mismatch must fail safely.
    if (b.metricsRecord(handle, counter, encodeUtf8('/a'), 1)) return false

    console.error('CK: arity')
    // Render: probe with a small buffer → exact required size; then render.
    const probe = new Uint8Array(16)
    const needed = b.metricsRender(handle, probe)
    if (needed <= probe.length) return false
    const out = new Uint8Array(needed)
    const written = b.metricsRender(handle, out)
    if (written !== needed) return false
    const text = decodeUtf8(out.subarray(0, written))
    if (
      !text.includes('ct_selftest_hits{route="/a",status="200"} 3\n') ||
      !text.includes('ct_selftest_hits{route="/b",status="200"} 2\n') ||
      !text.includes('ct_selftest_depth{q="jobs"} 4\n') ||
      !text.includes('ct_selftest_depth{q="io"} 6\n') ||
      !text.includes('ct_selftest_latency_bucket{le="0.5"} 1\n') ||
      !text.includes('ct_selftest_latency_count 1\n')
    ) {
      return false
    }

    console.error('CK: render')
    // Snapshot: packed dump starts with version=1 + familyCount>=3.
    {
      const probe2 = new Uint8Array(16)
      const need = b.metricsSnapshot(handle, probe2)
      if (need <= probe2.length) return false
      const snap = new Uint8Array(need)
      if (b.metricsSnapshot(handle, snap) !== need) return false
      const sv = new DataView(snap.buffer)
      if (sv.getUint32(0, true) !== 1) return false
      if (sv.getUint32(4, true) < 3) return false
    }

    console.error('CK: snapshot')
    // Batch: two entries in ONE crossing.
    {
      const c2 = b.metricsCounter(handle, 'ct_selftest_batch', 'k')
      const buf = new Uint8Array(64)
      const dv = new DataView(buf.buffer)
      dv.setUint32(0, 1, true)
      dv.setUint32(4, c2, true)
      dv.setUint32(8, 1, true)
      buf[12] = 'v'.charCodeAt(0)
      dv.setFloat64(13, 4, true)
      if (!b.metricsRecordBatch(handle, buf.subarray(0, 21))) return false
      const probe3 = new Uint8Array(16)
      const need3 = b.metricsRender(handle, probe3)
      const out3 = new Uint8Array(need3)
      b.metricsRender(handle, out3)
      if (!decodeUtf8(out3.subarray(0, need3)).includes('ct_selftest_batch{k="v"} 4')) {
        return false
      }
    }

    console.error('CK: batch')
    // A null handle must throw on declare (never dereference freed state).
    try {
      b.metricsCounter(0, 'ct_selftest_x', '')
      return false
    } catch {
      // expected
    }
    return true
  } catch (err) {
    console.error('METRICS SELFTEST THROW:', err)
    return false
  } finally {
    b.metricsDestroy(handle)
  }
}
