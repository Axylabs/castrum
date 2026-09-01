//! Sharded metrics registry (counters / gauges / histograms) + Prometheus
//! text-format render. Pure core — no napi types.
//!
//! Hot path (`add`/`set`): validate → build the packed series key in a reused
//! buffer → one shard-mutex acquire → update. The key is
//! `family_u32_le \0 raw_label_bytes`, so the render pass can attribute each
//! entry to its family without re-parsing label structure; raw bytes are safe
//! as a grouping key because render-time escaping is injective.

use std::sync::{Arc, Mutex};

/// A declared metric family kind.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MetricsKind {
    /// Monotonic counter (`add` only).
    Counter,
    /// Arbitrary gauge (`set` / `add`).
    Gauge,
    /// Cumulative histogram with fixed buckets (observe via `add`).
    Histogram,
}

/// Hard cap on families per registry (a typo loop should fail fast, not OOM).
pub const METRICS_MAX_FAMILIES: usize = 4096;
/// Shard count for the per-label-set state (power of two; one mutex acquire
/// per hot-path call — same contention profile as the rate limiter's shards).
pub const METRICS_SHARDS: usize = 64;
/// Max labels per family.
pub const METRICS_MAX_LABELS: usize = 16;
/// Max histogram buckets per family (plus the implicit `+Inf` bucket).
pub const METRICS_MAX_BUCKETS: usize = 64;
/// Separator between packed label VALUES on the C-ABI hot path.
pub const METRICS_VALUE_SEP: u8 = 0x1f;

/// Default latency-style buckets when a histogram is declared without any.
pub const METRICS_DEFAULT_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// A declared family: validated name/kind plus the metadata needed to build
/// series keys and render. `Arc`s keep the per-record metadata snapshot cheap
/// (the families lock is held only to clone these handles).
struct Family {
    name: Arc<str>,
    kind: MetricsKind,
    label_keys: Arc<[Arc<str>]>,
    buckets: Arc<[f64]>,
}

/// Per-label-set state. Scalars are one f64 (Prometheus samples are doubles);
/// histograms accumulate per-bucket counts (cumulative upper bounds) + sum.
enum Value {
    Scalar(f64),
    Hist {
        counts: Vec<u64>,
        sum: f64,
        count: u64,
    },
}

impl Value {
    fn new_for(kind: MetricsKind, buckets: &[f64]) -> Self {
        match kind {
            MetricsKind::Histogram => Value::Hist {
                counts: vec![0; buckets.len()],
                sum: 0.0,
                count: 0,
            },
            _ => Value::Scalar(0.0),
        }
    }
}

/// The registry. Cheap to construct; shareable across threads.
pub struct MetricsRegistry {
    families: Mutex<Vec<Family>>,
    shards: Vec<Mutex<std::collections::HashMap<Vec<u8>, Value>>>,
}

#[inline]
fn valid_metric_ident(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > 256 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b':') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b':')
}

#[inline]
fn finite(v: f64) -> bool {
    v.is_finite()
}

/// Locate the bucket whose cumulative upper bound is the first `>= v`.
/// Returns `buckets.len()` for above-the-last-bucket values (+Inf bucket).
#[inline]
fn bucket_index(buckets: &[f64], v: f64) -> usize {
    buckets.partition_point(|&b| b < v)
}

/// Snapshot of one family's declaration (cheap Arc clones; released before
/// the shard lock is taken).
type FamilySnapshot = (Arc<str>, MetricsKind, Arc<[Arc<str>]>, Arc<[f64]>);

impl MetricsRegistry {
    /// Create an empty registry with [`METRICS_SHARDS`] shards.
    pub fn new() -> Self {
        let shards = (0..METRICS_SHARDS)
            .map(|_| Mutex::new(std::collections::HashMap::new()))
            .collect();
        MetricsRegistry {
            families: Mutex::new(Vec::new()),
            shards,
        }
    }

    /// Declare a family and return its `u32` series id. Declaring the same
    /// `(name, kind, label keys)` twice is idempotent (same id); a name reused
    /// with a different shape is an error (Prometheus type-conflict class).
    ///
    /// `buckets` is only read for histograms (empty → the default buckets).
    pub fn declare(
        &self,
        kind: MetricsKind,
        name: &str,
        label_keys: &[&str],
        buckets: &[f64],
    ) -> Result<u32, String> {
        if !valid_metric_ident(name.as_bytes()) {
            return Err(format!("invalid metric name: {name:?}"));
        }
        if label_keys.len() > METRICS_MAX_LABELS {
            return Err(format!("too many labels ({})", label_keys.len()));
        }
        for k in label_keys {
            if !valid_metric_ident(k.as_bytes()) {
                return Err(format!("invalid label name: {k:?}"));
            }
        }
        let mut sorted_buckets: Vec<f64> = if kind == MetricsKind::Histogram && buckets.is_empty() {
            METRICS_DEFAULT_BUCKETS.to_vec()
        } else {
            buckets.to_vec()
        };
        if kind == MetricsKind::Histogram {
            if sorted_buckets.len() > METRICS_MAX_BUCKETS {
                return Err(format!("too many buckets ({})", sorted_buckets.len()));
            }
            if sorted_buckets.iter().any(|b| !finite(*b) || *b <= 0.0) {
                return Err("histogram buckets must be finite and > 0".to_string());
            }
            sorted_buckets.sort_by(|a, b| a.partial_cmp(b).expect("all finite"));
            sorted_buckets.dedup();
        }

        let mut families = self.families.lock().expect("families lock");
        for (idx, fam) in families.iter().enumerate() {
            if &*fam.name == name {
                let same_shape = fam.kind == kind
                    && fam.label_keys.len() == label_keys.len()
                    && fam
                        .label_keys
                        .iter()
                        .zip(label_keys.iter())
                        .all(|(a, b)| &**a == *b)
                    && (kind != MetricsKind::Histogram
                        || fam.buckets.as_ref() == sorted_buckets.as_slice());
                return if same_shape {
                    Ok(idx as u32)
                } else {
                    Err(format!(
                        "metric {name:?} re-declared with a different shape"
                    ))
                };
            }
        }
        let idx = families.len();
        if idx >= METRICS_MAX_FAMILIES {
            return Err(format!(
                "registry full (max {METRICS_MAX_FAMILIES} families)"
            ));
        }
        families.push(Family {
            name: Arc::from(name),
            kind,
            label_keys: label_keys.iter().map(|k| Arc::from(*k)).collect(),
            buckets: sorted_buckets.into(),
        });
        Ok(idx as u32)
    }

    /// Snapshot the family metadata (cheap Arc clones; releases the lock).
    #[inline]
    fn family(&self, series: u32) -> std::result::Result<FamilySnapshot, String> {
        let families = self.families.lock().expect("families lock");
        let fam = families
            .get(series as usize)
            .ok_or_else(|| format!("unknown series id {series}"))?;
        Ok((
            Arc::clone(&fam.name),
            fam.kind,
            Arc::clone(&fam.label_keys),
            Arc::clone(&fam.buckets),
        ))
    }

    /// Split the packed `\x1f`-separated label values and validate arity +
    /// forbidden bytes (NUL would corrupt the map key; the separator itself
    /// cannot be embedded in a single value by construction).
    #[inline]
    fn validate_values(packed: &[u8], n_labels: usize) -> Result<(), String> {
        if packed.contains(&0) {
            return Err("label values must not contain NUL".to_string());
        }
        let mut count = usize::from(!packed.is_empty());
        for &b in packed {
            if b == METRICS_VALUE_SEP {
                count += 1;
            }
        }
        // An empty packed buffer is valid ONLY for zero-label families; an
        // empty value among several ("a=\x1fb") still counts via separators.
        if n_labels == 0 && packed.is_empty() {
            return Ok(());
        }
        if count != n_labels {
            return Err(format!("expected {n_labels} label value(s), got {count}"));
        }
        Ok(())
    }

    /// Build the sharded-map key into `out`: `family_u32_le \0 v1 \x1f v2 ...`.
    #[inline]
    fn build_key(out: &mut Vec<u8>, series: u32, packed_values: &[u8]) {
        out.clear();
        out.extend_from_slice(&series.to_le_bytes());
        out.push(0);
        out.extend_from_slice(packed_values);
    }

    #[inline]
    fn shard_for(key: &[u8]) -> usize {
        // crate::crypto::hashing::fnv1a64 is the repo's standard non-crypto hash.
        (crate::crypto::hashing::fnv1a64_bytes(key) as usize) & (METRICS_SHARDS - 1)
    }

    /// Counter/gauge `+= amount`, or histogram observe `amount`. Counters and
    /// gauges accept any finite amount; histograms require `>= 0`
    /// (Prometheus observes non-negative quantities).
    pub fn add(&self, series: u32, packed_values: &[u8], amount: f64) -> Result<(), String> {
        if !finite(amount) {
            return Err("amount must be finite".to_string());
        }
        let (_name, kind, label_keys, buckets) = self.family(series)?;
        Self::validate_values(packed_values, label_keys.len())?;
        let mut key = Vec::with_capacity(5 + packed_values.len());
        Self::build_key(&mut key, series, packed_values);
        let shard = &self.shards[Self::shard_for(&key)];
        let mut map = shard.lock().expect("shard lock");
        let value = match map.get_mut(&key) {
            Some(v) => v,
            None => map
                .entry(key.clone())
                .or_insert_with(|| Value::new_for(kind, &buckets)),
        };
        match value {
            Value::Scalar(s) => *s += amount,
            Value::Hist { counts, sum, count } => {
                if amount < 0.0 {
                    return Err("histogram observations must be >= 0".to_string());
                }
                let idx = bucket_index(&buckets, amount);
                if let Some(c) = counts.get_mut(idx) {
                    *c += 1;
                }
                *sum += amount;
                *count += 1;
            }
        }
        Ok(())
    }

    /// Gauge assignment (`= value`); errors on counter/histogram families.
    pub fn set(&self, series: u32, packed_values: &[u8], value: f64) -> Result<(), String> {
        if !finite(value) {
            return Err("value must be finite".to_string());
        }
        let (_name, kind, label_keys, _buckets) = self.family(series)?;
        if kind != MetricsKind::Gauge {
            return Err("set() is only valid on gauges".to_string());
        }
        Self::validate_values(packed_values, label_keys.len())?;
        let mut key = Vec::with_capacity(5 + packed_values.len());
        Self::build_key(&mut key, series, packed_values);
        let shard = &self.shards[Self::shard_for(&key)];
        let mut map = shard.lock().expect("shard lock");
        let v = match map.get_mut(&key) {
            Some(v) => v,
            None => map.entry(key.clone()).or_insert(Value::Scalar(value)),
        };
        if let Value::Scalar(s) = v {
            *s = value;
        }
        Ok(())
    }

    /// Number of live series across all shards (tests / introspection).
    pub fn series_count(&self) -> usize {
        self.shards
            .iter()
            .map(|s| s.lock().expect("shard lock").len())
            .sum()
    }

    /// Render the Prometheus text format (deterministic: declaration order per
    /// family, series sorted by raw label bytes). Output bytes are ASCII
    /// scaffolding + raw label-value bytes; invalid UTF-8 in values becomes a
    /// replacement char at the JS decode boundary.
    pub fn render_into(&self, out: &mut Vec<u8>) {
        struct Row {
            family: u32,
            labels: Vec<u8>,
            value: Value,
        }
        let mut rows: Vec<Row> = Vec::new();
        for shard in &self.shards {
            let map = shard.lock().expect("shard lock");
            for (k, v) in map.iter() {
                rows.push(Row {
                    family: u32::from_le_bytes([k[0], k[1], k[2], k[3]]),
                    labels: k[5..].to_vec(),
                    value: match v {
                        Value::Scalar(s) => Value::Scalar(*s),
                        Value::Hist { counts, sum, count } => Value::Hist {
                            counts: counts.clone(),
                            sum: *sum,
                            count: *count,
                        },
                    },
                });
            }
        }
        rows.sort_by(|a, b| {
            a.family
                .cmp(&b.family)
                .then_with(|| a.labels.cmp(&b.labels))
        });

        let families = self.families.lock().expect("families lock");
        let mut row_iter = rows.into_iter().peekable();
        for (idx, fam) in families.iter().enumerate() {
            let kind_str = match fam.kind {
                MetricsKind::Counter => "counter",
                MetricsKind::Gauge => "gauge",
                MetricsKind::Histogram => "histogram",
            };
            out.extend_from_slice(b"# TYPE ");
            out.extend_from_slice(fam.name.as_bytes());
            out.push(b' ');
            out.extend_from_slice(kind_str.as_bytes());
            out.push(b'\n');

            while let Some(row) = row_iter.peek() {
                if row.family != idx as u32 {
                    break;
                }
                let row = row_iter.next().expect("peeked");
                match row.value {
                    Value::Scalar(s) => {
                        out.extend_from_slice(fam.name.as_bytes());
                        write_labels(out, &fam.label_keys, &row.labels, None);
                        out.push(b' ');
                        write_f64(out, s);
                        out.push(b'\n');
                    }
                    Value::Hist { counts, sum, count } => {
                        let mut cumulative: u64 = 0;
                        for (i, &le) in fam.buckets.iter().enumerate() {
                            cumulative += counts.get(i).copied().unwrap_or(0);
                            out.extend_from_slice(fam.name.as_bytes());
                            out.extend_from_slice(b"_bucket");
                            let mut le_buf = Vec::new();
                            write_f64(&mut le_buf, le);
                            write_labels(out, &fam.label_keys, &row.labels, Some((b"le", &le_buf)));
                            out.push(b' ');
                            write_u64(out, cumulative);
                            out.push(b'\n');
                        }
                        out.extend_from_slice(fam.name.as_bytes());
                        out.extend_from_slice(b"_bucket");
                        write_labels(out, &fam.label_keys, &row.labels, Some((b"le", b"+Inf")));
                        out.push(b' ');
                        write_u64(out, count);
                        out.push(b'\n');

                        out.extend_from_slice(fam.name.as_bytes());
                        out.extend_from_slice(b"_sum");
                        write_labels(out, &fam.label_keys, &row.labels, None);
                        out.push(b' ');
                        write_f64(out, sum);
                        out.push(b'\n');

                        out.extend_from_slice(fam.name.as_bytes());
                        out.extend_from_slice(b"_count");
                        write_labels(out, &fam.label_keys, &row.labels, None);
                        out.push(b' ');
                        write_u64(out, count);
                        out.push(b'\n');
                    }
                }
            }
        }
    }

    /// Dump every live series in the packed snapshot format (v1):
    ///
    /// `[u32 version=1][u32 familyCount]` then per family
    /// `[u32 familyId][u8 kind][u32 nameLen][name][u32 keysLen][keys \x1f-joined]
    ///  [u32 nBuckets]{f64 le}` then `[u32 seriesCount]` and per series
    /// `[u32 familyId][u32 valsLen][values \x1f-joined]` followed by
    /// `f64 value` (counter/gauge) or `f64 sum + u64 count + u64[nBuckets]`
    /// raw per-bucket counts (histogram). All integers/f64 little-endian.
    ///
    /// This is the machine-readable read path (OTLP exporters, tests) — the
    /// text render stays the Prometheus wire format. Families come first so a
    /// decoder can resolve names/kind/bucket bounds while walking series;
    /// series are grouped by family in declaration order, labels sorted by raw
    /// bytes within a family (deterministic).
    pub fn snapshot_into(&self, out: &mut Vec<u8>) {
        // Cold path: clone rows out of the shards (values are small), sort,
        // emit. Deterministic order mirrors render_into.
        let mut rows: Vec<(u32, Vec<u8>, Value)> = Vec::new();
        for shard in &self.shards {
            let map = shard.lock().expect("shard lock");
            for (k, v) in map.iter() {
                rows.push((
                    u32::from_le_bytes([k[0], k[1], k[2], k[3]]),
                    k[5..].to_vec(),
                    match v {
                        Value::Scalar(s) => Value::Scalar(*s),
                        Value::Hist { counts, sum, count } => Value::Hist {
                            counts: counts.clone(),
                            sum: *sum,
                            count: *count,
                        },
                    },
                ));
            }
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        out.extend_from_slice(&1u32.to_le_bytes());
        let families = self.families.lock().expect("families lock");
        out.extend_from_slice(&(families.len() as u32).to_le_bytes());
        for (id, fam) in families.iter().enumerate() {
            out.extend_from_slice(&(id as u32).to_le_bytes());
            out.push(match fam.kind {
                MetricsKind::Counter => 0,
                MetricsKind::Gauge => 1,
                MetricsKind::Histogram => 2,
            });
            out.extend_from_slice(&(fam.name.len() as u32).to_le_bytes());
            out.extend_from_slice(fam.name.as_bytes());
            let keys_joined = fam
                .label_keys
                .iter()
                .map(|k| k.as_bytes())
                .collect::<Vec<_>>()
                .join(&METRICS_VALUE_SEP);
            out.extend_from_slice(&(keys_joined.len() as u32).to_le_bytes());
            out.extend_from_slice(&keys_joined);
            out.extend_from_slice(&(fam.buckets.len() as u32).to_le_bytes());
            for &le in fam.buckets.iter() {
                out.extend_from_slice(&le.to_le_bytes());
            }
        }
        out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        for (family, labels, value) in &rows {
            out.extend_from_slice(&family.to_le_bytes());
            out.extend_from_slice(&(labels.len() as u32).to_le_bytes());
            out.extend_from_slice(labels);
            match value {
                Value::Scalar(v) => out.extend_from_slice(&v.to_le_bytes()),
                Value::Hist { counts, sum, count } => {
                    out.extend_from_slice(&sum.to_le_bytes());
                    out.extend_from_slice(&count.to_le_bytes());
                    for c in counts {
                        out.extend_from_slice(&c.to_le_bytes());
                    }
                }
            }
        }
    }

    /// Record N events in ONE lock-per-series pass. Packed layout:
    /// `[u32 n]{[u32 series][u32 valsLen][vals][f64 amount]}`. Errors on any
    /// unknown series / arity mismatch / invalid amount (all-or-nothing is NOT
    /// guaranteed — entries before a failure stay applied).
    pub fn record_batch(&self, packed: &[u8]) -> Result<(), String> {
        if packed.len() < 4 {
            return Err("batch too small".to_string());
        }
        let n = u32::from_le_bytes([packed[0], packed[1], packed[2], packed[3]]) as usize;
        let mut pos = 4usize;
        for _ in 0..n {
            if pos + 8 > packed.len() {
                return Err("truncated batch entry".to_string());
            }
            let series = u32::from_le_bytes([
                packed[pos],
                packed[pos + 1],
                packed[pos + 2],
                packed[pos + 3],
            ]);
            pos += 4;
            let vlen = u32::from_le_bytes([
                packed[pos],
                packed[pos + 1],
                packed[pos + 2],
                packed[pos + 3],
            ]) as usize;
            pos += 4;
            if pos + vlen + 8 > packed.len() {
                return Err("truncated batch values".to_string());
            }
            let vals = &packed[pos..pos + vlen];
            pos += vlen;
            let mut amt_b = [0u8; 8];
            amt_b.copy_from_slice(&packed[pos..pos + 8]);
            pos += 8;
            let amount = f64::from_le_bytes(amt_b);
            self.add(series, vals, amount)?;
        }
        Ok(())
    }

    /// Convenience allocating wrapper over [`Self::snapshot_into`].
    pub fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        self.snapshot_into(&mut out);
        out
    }

    /// Convenience allocating wrapper over [`Self::render_into`].
    pub fn render(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        self.render_into(&mut out);
        out
    }
}

impl Default for MetricsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Write `{k="v",...}` (values escaped) from the family's label keys + the
/// raw packed values; nothing when there are no labels. `extra` appends one
/// more literal pair after them (the histogram `le` bound).
fn write_labels(
    out: &mut Vec<u8>,
    keys: &[Arc<str>],
    raw_values: &[u8],
    extra: Option<(&[u8], &[u8])>,
) {
    if keys.is_empty() && extra.is_none() {
        return;
    }
    out.push(b'{');
    let mut wrote = false;
    let mut start = 0usize;
    let mut key_idx = 0usize;
    let emit_pair = |out: &mut Vec<u8>, key: &[u8], val: &[u8], wrote: &mut bool| {
        if *wrote {
            out.push(b',');
        }
        out.extend_from_slice(key);
        out.extend_from_slice(b"=\"");
        write_escaped(out, val);
        out.push(b'"');
        *wrote = true;
    };
    while start < raw_values.len() {
        let end = raw_values[start..]
            .iter()
            .position(|&b| b == METRICS_VALUE_SEP)
            .map_or(raw_values.len(), |p| start + p);
        let key: &[u8] = keys.get(key_idx).map_or(b"l", |k| k.as_bytes());
        emit_pair(out, key, &raw_values[start..end], &mut wrote);
        key_idx += 1;
        start = end + 1;
    }
    if let Some((k, v)) = extra {
        emit_pair(out, k, v, &mut wrote);
    }
    out.push(b'}');
}

/// Prometheus label-value escaping: `\` → `\\`, `"` → `\"`, newline → `\n`.
/// Injective, so raw-byte grouping keys never collide after escaping.
fn write_escaped(out: &mut Vec<u8>, val: &[u8]) {
    for &c in val {
        match c {
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'"' => out.extend_from_slice(b"\\\""),
            b'\n' => out.extend_from_slice(b"\\n"),
            _ => out.push(c),
        }
    }
}

/// Format a float Prometheus-style: integral values without a decimal point,
/// everything else via Rust's shortest round-trip display.
fn write_f64(out: &mut Vec<u8>, v: f64) {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        let s = (v as i64).to_string();
        out.extend_from_slice(s.as_bytes());
    } else {
        let s = format!("{v}");
        out.extend_from_slice(s.as_bytes());
    }
}

fn write_u64(out: &mut Vec<u8>, v: u64) {
    let s = v.to_string();
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn text(reg: &MetricsRegistry) -> String {
        String::from_utf8(reg.render()).expect("render scaffolding is ASCII")
    }

    #[test]
    fn counters_accumulate_and_render() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(
                MetricsKind::Counter,
                "http_requests_total",
                &["route", "status"],
                &[],
            )
            .expect("declare");
        assert_eq!(c, 0);
        reg.add(c, b"/a\x1f200", 1.0).expect("ok");
        reg.add(c, b"/a\x1f200", 2.0).expect("ok");
        reg.add(c, b"/b\x1f500", 1.0).expect("ok");
        let t = text(&reg);
        assert!(t.contains("# TYPE http_requests_total counter"));
        assert!(t.contains("http_requests_total{route=\"/a\",status=\"200\"} 3\n"));
        assert!(t.contains("http_requests_total{route=\"/b\",status=\"500\"} 1\n"));
    }

    #[test]
    fn counter_without_labels_renders_bare() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "uptime", &[], &[])
            .expect("declare");
        reg.add(c, b"", 5.0).expect("ok");
        assert!(text(&reg).contains("\nuptime 5\n"));
    }

    #[test]
    fn gauge_set_overrides_add() {
        let reg = MetricsRegistry::new();
        let g = reg
            .declare(MetricsKind::Gauge, "queue_depth", &["q"], &[])
            .expect("declare");
        reg.add(g, b"jobs", 10.0).expect("ok");
        reg.set(g, b"jobs", 4.5).expect("ok");
        assert!(text(&reg).contains("queue_depth{q=\"jobs\"} 4.5\n"));
        assert!(reg.set(g, b"jobs", f64::NAN).is_err());
    }

    #[test]
    fn set_rejected_on_counters() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "hits", &[], &[])
            .expect("declare");
        assert!(reg.set(c, b"", 1.0).is_err());
    }

    #[test]
    fn histogram_buckets_cumulative_with_sum_and_count() {
        let reg = MetricsRegistry::new();
        let h = reg
            .declare(
                MetricsKind::Histogram,
                "latency_seconds",
                &["op"],
                &[0.1, 0.5],
            )
            .expect("declare");
        for v in [0.05_f64, 0.2, 0.7] {
            reg.add(h, b"get", v).expect("observe");
        }
        let t = text(&reg);
        assert!(t.contains("# TYPE latency_seconds histogram"));
        assert!(t.contains("latency_seconds_bucket{op=\"get\",le=\"0.1\"} 1\n"));
        assert!(t.contains("latency_seconds_bucket{op=\"get\",le=\"0.5\"} 2\n"));
        assert!(t.contains("latency_seconds_bucket{op=\"get\",le=\"+Inf\"} 3\n"));
        assert!(t.contains("latency_seconds_sum{op=\"get\"} 0.95\n"));
        assert!(t.contains("latency_seconds_count{op=\"get\"} 3\n"));
    }

    #[test]
    fn histogram_default_buckets_when_empty() {
        let reg = MetricsRegistry::new();
        let h = reg
            .declare(MetricsKind::Histogram, "dur", &[], &[])
            .expect("declare");
        reg.add(h, b"", 100.0).expect("observe"); // above every default bucket
        let t = text(&reg);
        assert!(t.contains("dur_bucket{le=\"+Inf\"} 1\n"));
        assert!(!t.contains("dur_bucket{le=\"10\"} 1\n"));
    }

    #[test]
    fn negative_observation_rejected() {
        let reg = MetricsRegistry::new();
        let h = reg
            .declare(MetricsKind::Histogram, "h", &[], &[1.0])
            .expect("declare");
        assert!(reg.add(h, b"", -1.0).is_err());
    }

    #[test]
    fn escaping_is_applied_at_render() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "esc", &["path"], &[])
            .expect("declare");
        reg.add(c, b"/a\"b\\c\nd", 1.0).expect("ok");
        assert!(text(&reg).contains("esc{path=\"/a\\\"b\\\\c\\nd\"} 1\n"));
    }

    #[test]
    fn arity_and_byte_validation() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "m", &["a"], &[])
            .expect("declare");
        assert!(reg.add(c, b"", 1.0).is_err()); // missing value
        assert!(reg.add(c, b"x\x1fy", 1.0).is_err()); // too many
        assert!(reg.add(c, b"a\x1f\x00", 1.0).is_err()); // NUL rejected
    }

    #[test]
    fn declare_idempotent_but_shape_conflicts_error() {
        let reg = MetricsRegistry::new();
        let a = reg
            .declare(MetricsKind::Counter, "m", &["a"], &[])
            .expect("first");
        let b = reg
            .declare(MetricsKind::Counter, "m", &["a"], &[])
            .expect("idempotent");
        assert_eq!(a, b);
        assert!(reg.declare(MetricsKind::Gauge, "m", &["a"], &[]).is_err());
        assert!(reg
            .declare(MetricsKind::Counter, "m", &["a", "b"], &[])
            .is_err());
    }

    #[test]
    fn invalid_names_and_label_keys() {
        let reg = MetricsRegistry::new();
        assert!(reg.declare(MetricsKind::Counter, "9bad", &[], &[]).is_err());
        assert!(reg.declare(MetricsKind::Counter, "", &[], &[]).is_err());
        assert!(reg
            .declare(MetricsKind::Counter, "has space", &[], &[])
            .is_err());
        assert!(reg
            .declare(MetricsKind::Counter, "ok", &["bad-key"], &[])
            .is_err());
        // colons/underscores are legal metric-namespace characters
        assert!(reg
            .declare(MetricsKind::Counter, "_ok:name_", &[], &[])
            .is_ok());
    }

    #[test]
    fn unknown_series_and_non_finite() {
        let reg = MetricsRegistry::new();
        assert!(reg.add(42, b"", 1.0).is_err());
        let c = reg
            .declare(MetricsKind::Counter, "c", &[], &[])
            .expect("declare");
        assert!(reg.add(c, b"", f64::INFINITY).is_err());
    }

    #[test]
    fn render_is_deterministic_across_shards() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "det", &["k"], &[])
            .expect("declare");
        for i in 0..300u32 {
            reg.add(c, format!("k{i}").as_bytes(), 1.0).expect("ok");
        }
        let first = reg.render();
        let second = reg.render();
        assert_eq!(first, second);
        assert_eq!(reg.series_count(), 300);
    }

    #[test]
    fn concurrent_records_do_not_deadlock_or_lose_writes() {
        let reg = Arc::new(MetricsRegistry::new());
        let c = reg
            .declare(MetricsKind::Counter, "conc", &["w"], &[])
            .expect("declare");
        let handles: Vec<_> = (0..8)
            .map(|w| {
                let reg = Arc::clone(&reg);
                thread::spawn(move || {
                    for _ in 0..1000 {
                        reg.add(c, format!("w{w}").as_bytes(), 1.0).expect("ok");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("join");
        }
        let t = text(&reg);
        for w in 0..8 {
            assert!(t.contains(&format!("conc{{w=\"w{w}\"}} 1000\n")));
        }
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn snapshot_round_trip_shape() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(
                MetricsKind::Counter,
                "snap_total",
                &["route", "status"],
                &[],
            )
            .expect("declare");
        reg.add(c, b"/a\x1f200", 2.0).expect("ok");
        reg.add(c, b"/b\x1f500", 1.0).expect("ok");
        let g = reg
            .declare(MetricsKind::Gauge, "snap_depth", &[], &[])
            .expect("g");
        reg.set(g, b"", 3.5).expect("set");
        let h = reg
            .declare(MetricsKind::Histogram, "snap_lat", &["op"], &[0.1, 0.5])
            .expect("hist");
        reg.add(h, b"get", 0.2).expect("observe");

        let bytes = reg.snapshot();
        assert_eq!(&bytes[0..4], &1u32.to_le_bytes());
        assert_eq!(&bytes[4..8], &3u32.to_le_bytes());

        let mut off = 8usize;
        let rd_u32 = |b: &[u8], o: usize| -> u32 {
            u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
        };
        for (idx, expected_name) in ["snap_total", "snap_depth", "snap_lat"].iter().enumerate() {
            let fam_id = rd_u32(&bytes, off);
            assert_eq!(fam_id as usize, idx);
            off += 4;
            let kind = bytes[off];
            off += 1;
            let nlen = rd_u32(&bytes, off) as usize;
            off += 4;
            assert_eq!(&bytes[off..off + nlen], expected_name.as_bytes());
            off += nlen;
            let klen = rd_u32(&bytes, off) as usize;
            off += 4;
            off += klen;
            let nb = rd_u32(&bytes, off) as usize;
            off += 4;
            off += nb * 8;
            if idx == 2 {
                assert_eq!(kind, 2);
                assert_eq!(nb, 2);
            }
        }
        let scount = rd_u32(&bytes, off) as usize;
        off += 4;
        assert_eq!(scount, 4);
        {
            let fam = rd_u32(&bytes, off);
            assert_eq!(fam, 0);
            off += 4;
            let vlen = rd_u32(&bytes, off) as usize;
            off += 4;
            assert_eq!(&bytes[off..off + vlen], b"/a\x1f200");
            off += vlen;
            let mut v = [0u8; 8];
            v.copy_from_slice(&bytes[off..off + 8]);
            assert_eq!(f64::from_le_bytes(v), 2.0);
        }
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn record_batch_applies_all_entries() {
        let reg = MetricsRegistry::new();
        let c = reg
            .declare(MetricsKind::Counter, "b_total", &["route", "status"], &[])
            .expect("c");
        // packed: 2 entries
        let mut buf = Vec::new();
        buf.extend_from_slice(&2u32.to_le_bytes());
        for (route, status, amount) in [("/a", "200", 3.0f64), ("/b", "500", 1.0)] {
            let mut vals = String::with_capacity(route.len() + status.len() + 1);
            vals.push_str(route);
            vals.push('\u{1f}');
            vals.push_str(status);
            buf.extend_from_slice(&(c.to_le_bytes()));
            buf.extend_from_slice(&(vals.len() as u32).to_le_bytes());
            buf.extend_from_slice(vals.as_bytes());
            buf.extend_from_slice(&amount.to_le_bytes());
        }
        reg.record_batch(&buf).expect("batch ok");
        let text = String::from_utf8_lossy(&reg.render()).into_owned();
        // /a,200 → 3 ; /b,500 → 1 (separate series)
        assert!(
            text.contains("b_total{route=\"/a\",status=\"200\"} 3"),
            "{text}"
        );
        assert!(
            text.contains("b_total{route=\"/b\",status=\"500\"} 1"),
            "{text}"
        );
    }

    #[test]
    fn record_batch_rejects_truncated() {
        let reg = MetricsRegistry::new();
        assert!(reg.record_batch(&[2, 0, 0, 0]).is_err());
        assert!(reg.record_batch(&[]).is_err());
    }
}
