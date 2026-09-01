//! NAPI projection of the metrics registry (`MetricsRegistry` JS class).
//!
//! Ergonomic surface for Node / the napi fallback transport: labels cross as
//! string arrays here (the C-ABI hot path packs them `\x1f`-separated instead
//! — see `rust/ffi/metrics.rs`). Both wrap the SAME pure core, so outputs are
//! byte-identical across transports.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::registry::{MetricsKind, MetricsRegistry as CoreRegistry};

/// Pack optional label values into the core's `\x1f`-separated wire format.
fn pack(values: Option<&Vec<String>>) -> Vec<u8> {
    let Some(vals) = values else {
        return Vec::new();
    };
    let need = vals.iter().map(String::len).sum::<usize>() + vals.len().saturating_sub(1);
    let mut out = Vec::with_capacity(need);
    for (i, v) in vals.iter().enumerate() {
        if i > 0 {
            out.push(super::registry::METRICS_VALUE_SEP);
        }
        out.extend_from_slice(v.as_bytes());
    }
    out
}

fn throw<E: std::fmt::Display>(e: E) -> Error {
    Error::new(Status::InvalidArg, e.to_string())
}

/// Borrow the optional label list as `&[&str]` (lives for the call).
fn borrowed_keys(labels: &Option<Vec<String>>) -> Vec<&str> {
    labels
        .as_ref()
        .map_or(Vec::new(), |l| l.iter().map(String::as_str).collect())
}

/// Sharded counters / gauges / histograms registry with a Prometheus
/// text-format render. Series are declared once (returning an id) and updated
/// per event; render is deterministic across calls.
///
/// @example
/// ```ts
/// const m = new MetricsRegistry()
/// const hits = m.counter('http_requests_total', ['route', 'status'])
/// m.record(hits, ['/a', '200'], 1)
/// m.render() // "# TYPE http_requests_total counter\nhttp_requests_total{...} 1\n"
/// ```
#[napi]
pub struct MetricsRegistry {
    inner: CoreRegistry,
}

#[napi]
impl MetricsRegistry {
    /// Create an empty registry.
    #[napi(constructor)]
    #[allow(clippy::new_without_default)] // napi constructors can't derive Default
    pub fn new() -> Self {
        Self {
            inner: CoreRegistry::new(),
        }
    }

    /// Declare a counter family → its series id (idempotent per shape).
    #[napi]
    pub fn counter(&self, name: String, labels: Option<Vec<String>>) -> Result<u32> {
        let keys: Vec<&str> = borrowed_keys(&labels);
        self.inner
            .declare(MetricsKind::Counter, &name, &keys, &[])
            .map_err(throw)
    }

    /// Declare a gauge family → its series id (idempotent per shape).
    #[napi]
    pub fn gauge(&self, name: String, labels: Option<Vec<String>>) -> Result<u32> {
        let keys: Vec<&str> = borrowed_keys(&labels);
        self.inner
            .declare(MetricsKind::Gauge, &name, &keys, &[])
            .map_err(throw)
    }

    /// Declare a histogram family → its series id. Empty/omitted `buckets`
    /// selects the default latency buckets (sorted + deduped internally).
    #[napi]
    pub fn histogram(
        &self,
        name: String,
        labels: Option<Vec<String>>,
        buckets: Option<Vec<f64>>,
    ) -> Result<u32> {
        let keys: Vec<&str> = borrowed_keys(&labels);
        self.inner
            .declare(
                MetricsKind::Histogram,
                &name,
                &keys,
                &buckets.unwrap_or_default(),
            )
            .map_err(throw)
    }

    /// Counter/gauge `+= amount`, or histogram observe `amount`.
    #[napi]
    pub fn record(&self, series: u32, values: Option<Vec<String>>, amount: f64) -> Result<()> {
        self.inner
            .add(series, &pack(values.as_ref()), amount)
            .map_err(throw)
    }

    /// Gauge assignment (`= value`).
    #[napi]
    pub fn gauge_set(&self, series: u32, values: Option<Vec<String>>, value: f64) -> Result<()> {
        self.inner
            .set(series, &pack(values.as_ref()), value)
            .map_err(throw)
    }

    /// Render the Prometheus text exposition format (deterministic order).
    /// Invalid UTF-8 in label values becomes replacement chars here.
    #[napi]
    pub fn render(&self) -> String {
        String::from_utf8_lossy(&self.inner.render()).into_owned()
    }

    /// Opaque handle for the C-ABI fast path (`castrum_metrics_*` symbols).
    /// Only valid while THIS instance is alive; the JS wrapper holds it.
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        &self.inner as *const CoreRegistry as u64
    }

    /// Number of live series (tests / introspection).
    #[napi]
    pub fn series_count(&self) -> u32 {
        self.inner.series_count() as u32
    }

    /// Dump every live series in the packed v1 snapshot format (families then
    /// series — see the registry core for the exact layout). The machine-
    /// readable read path for exporters (OTLP) and tests.
    #[napi]
    pub fn snapshot(&self) -> Buffer {
        self.inner.snapshot().into()
    }
}
