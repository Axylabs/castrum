// rust/ffi/metrics.rs — metrics-registry C-ABI exports (`castrum_metrics_*`).
//
// Stateful handles owned by the CALLER (the route-stack ownership model):
// `castrum_metrics_create` returns a `Box<MetricsRegistry>` handle, every call
// takes it as a `usize`, and `castrum_metrics_destroy` frees it. Series ids
// are `u32` family indices (idempotent declaration), label VALUES cross packed
// `\x1f`-separated in one `(ptr,len)` buffer, and render follows the
// needed-size convention. A null handle (0) → safe failure (0 / sentinel),
// never a dereference.

use std::slice;

use super::util::panic_guard;

/// `u32::MAX` — the declare-failure sentinel (fits f64 exactly; real series
/// ids are dense from 0 and capped well below this).
pub(crate) const METRICS_DECLARE_ERR: u32 = u32::MAX;

/// Create an empty metrics registry → opaque handle (`0` = allocation panic).
#[no_mangle]
pub extern "C" fn castrum_metrics_create() -> usize {
    let handle = Box::into_raw(Box::new(crate::metrics::MetricsRegistry::new()));
    handle as usize
}

/// Declare a counter family → series id (`METRICS_DECLARE_ERR` on error).
/// `label_keys` is a NUL-terminated `\x1f`-separated key list ("" = none).
///
/// # Safety
/// `handle` must be a live registry handle; `name`/`label_keys` valid C strings.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_counter(
    handle: usize,
    name: *const std::os::raw::c_char,
    label_keys: *const std::os::raw::c_char,
) -> u32 {
    if handle == 0 || name.is_null() || label_keys.is_null() {
        return METRICS_DECLARE_ERR;
    }
    let name = std::ffi::CStr::from_ptr(name).to_bytes();
    let keys = split_keys(std::ffi::CStr::from_ptr(label_keys).to_bytes());
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::declare(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                crate::metrics::registry::MetricsKind::Counter,
                std::str::from_utf8(name).unwrap_or_default(),
                &keys,
                &[],
            )
        },
        Err(String::new()),
    )
    .unwrap_or(METRICS_DECLARE_ERR)
}

/// Declare a gauge family → series id. Same ABI as [`castrum_metrics_counter`].
///
/// # Safety
/// See [`castrum_metrics_counter`].
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_gauge(
    handle: usize,
    name: *const std::os::raw::c_char,
    label_keys: *const std::os::raw::c_char,
) -> u32 {
    if handle == 0 || name.is_null() || label_keys.is_null() {
        return METRICS_DECLARE_ERR;
    }
    let name = std::ffi::CStr::from_ptr(name).to_bytes();
    let keys = split_keys(std::ffi::CStr::from_ptr(label_keys).to_bytes());
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::declare(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                crate::metrics::registry::MetricsKind::Gauge,
                std::str::from_utf8(name).unwrap_or_default(),
                &keys,
                &[],
            )
        },
        Err(String::new()),
    )
    .unwrap_or(METRICS_DECLARE_ERR)
}

/// Declare a histogram family → series id. `buckets_csv` is a NUL-terminated
/// comma-separated finite positive list ("" = the default latency buckets).
///
/// # Safety
/// See [`castrum_metrics_counter`].
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_histogram(
    handle: usize,
    name: *const std::os::raw::c_char,
    label_keys: *const std::os::raw::c_char,
    buckets_csv: *const std::os::raw::c_char,
) -> u32 {
    if handle == 0 || name.is_null() || label_keys.is_null() || buckets_csv.is_null() {
        return METRICS_DECLARE_ERR;
    }
    let name = std::ffi::CStr::from_ptr(name).to_bytes();
    let keys = split_keys(std::ffi::CStr::from_ptr(label_keys).to_bytes());
    let csv = std::ffi::CStr::from_ptr(buckets_csv).to_bytes();
    let buckets: Vec<f64> = std::str::from_utf8(csv)
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .collect();
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::declare(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                crate::metrics::registry::MetricsKind::Histogram,
                std::str::from_utf8(name).unwrap_or_default(),
                &keys,
                &buckets,
            )
        },
        Err(String::new()),
    )
    .unwrap_or(METRICS_DECLARE_ERR)
}

/// Record one event: counter/gauge `+= amount`, histogram observe `amount`.
/// `values` is the packed `\x1f`-separated label values. Returns 1 = ok.
///
/// # Safety
/// `handle` must be live; `values` valid for reads of `values_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_record(
    handle: usize,
    series: u32,
    values: *const u8,
    values_len: usize,
    amount: f64,
) -> u8 {
    if handle == 0 || (values.is_null() && values_len != 0) {
        return 0;
    }
    let vals = if values_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(values, values_len)
    };
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::add(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                series,
                vals,
                amount,
            )
        },
        Err(String::new()),
    )
    .is_ok() as u8
}

/// Gauge assignment (`= value`). Returns 1 = ok.
///
/// # Safety
/// See [`castrum_metrics_record`].
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_gauge_set(
    handle: usize,
    series: u32,
    values: *const u8,
    values_len: usize,
    value: f64,
) -> u8 {
    if handle == 0 || (values.is_null() && values_len != 0) {
        return 0;
    }
    let vals = if values_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(values, values_len)
    };
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::set(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                series,
                vals,
                value,
            )
        },
        Err(String::new()),
    )
    .is_ok() as u8
}

/// Record one event with the label VALUES crossing as a SINGLE `cstring` ARG
/// (`\x1f`-joined) — the engine transcodes the JS string in-engine, so the JS
/// hot path does ZERO `TextEncoder` work (`values.join('\x1f')` is all it
/// pays). Values must not contain NUL (a NUL would truncate the list — label
/// values are validated against NUL anyway). Returns 1 = ok.
///
/// # Safety
/// `handle` must be live; `values` a valid NUL-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_record_str(
    handle: usize,
    series: u32,
    values: *const std::os::raw::c_char,
    amount: f64,
) -> u8 {
    if handle == 0 || values.is_null() {
        return 0;
    }
    let vals = std::ffi::CStr::from_ptr(values).to_bytes();
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::add(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                series,
                vals,
                amount,
            )
        },
        Err(String::new()),
    )
    .is_ok() as u8
}

/// Gauge assignment (`= value`) with `\x1f`-joined `cstring` values — the
/// zero-encode sibling of [`castrum_metrics_gauge_set`]. Returns 1 = ok.
///
/// # Safety
/// See [`castrum_metrics_record_str`].
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_gauge_set_str(
    handle: usize,
    series: u32,
    values: *const std::os::raw::c_char,
    value: f64,
) -> u8 {
    if handle == 0 || values.is_null() {
        return 0;
    }
    let vals = std::ffi::CStr::from_ptr(values).to_bytes();
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::set(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                series,
                vals,
                value,
            )
        },
        Err(String::new()),
    )
    .is_ok() as u8
}

/// Render the Prometheus text format into `out` (needed-size convention:
/// `0` = null handle / render panic; `w > out_cap` = exact required size).
///
/// # Safety
/// `handle` must be live; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_render(
    handle: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if handle == 0 || out.is_null() {
        return 0;
    }
    let rendered = panic_guard(
        || {
            crate::metrics::MetricsRegistry::render(unsafe {
                &*(handle as *const crate::metrics::MetricsRegistry)
            })
        },
        Vec::new(),
    );
    if rendered.len() > out_cap {
        return rendered.len();
    }
    slice::from_raw_parts_mut(out, rendered.len()).copy_from_slice(&rendered);
    rendered.len()
}

/// Destroy a registry handle (idempotent-safe against null only; double-free
/// is caller error, same contract as `castrum_route_destroy`).
///
/// # Safety
/// `handle` must be either 0 or a live handle not yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_destroy(handle: usize) {
    if handle != 0 {
        drop(Box::from_raw(
            handle as *mut crate::metrics::MetricsRegistry,
        ));
    }
}

/// Split a `\x1f`-separated key list into owned strings (empty input → []).
fn split_keys(bytes: &[u8]) -> Vec<&str> {
    if bytes.is_empty() {
        return Vec::new();
    }
    std::str::from_utf8(bytes)
        .unwrap_or_default()
        .split('\x1f')
        .collect()
}

/// Dump the packed series snapshot (v1 wire format — see
/// `crate::metrics::registry::MetricsRegistry::snapshot_into`) into `out`.
/// Needed-size convention: `0` = null handle; `w > out_cap` = exact required
/// size; else bytes written.
///
/// # Safety
/// `handle` must be live; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_snapshot(
    handle: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if handle == 0 || out.is_null() {
        return 0;
    }
    let dumped = panic_guard(
        || {
            crate::metrics::MetricsRegistry::snapshot(unsafe {
                &*(handle as *const crate::metrics::MetricsRegistry)
            })
        },
        Vec::new(),
    );
    if dumped.len() > out_cap {
        return dumped.len();
    }
    slice::from_raw_parts_mut(out, dumped.len()).copy_from_slice(&dumped);
    dumped.len()
}

/// Record a BATCH of events in one crossing. Packed layout:
/// `[u32 n]{[u32 series][u32 valsLen][vals][f64 amount]}`. Returns 1 = all
/// applied; 0 = null handle / truncated / any entry failed (entries before a
/// failure stay applied).
///
/// # Safety
/// `handle` must be live; `packed` valid for reads of `packed_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_metrics_record_batch(
    handle: usize,
    packed: *const u8,
    packed_len: usize,
) -> u8 {
    if handle == 0 || (packed.is_null() && packed_len != 0) {
        return 0;
    }
    let buf = if packed_len == 0 {
        &[]
    } else {
        slice::from_raw_parts(packed, packed_len)
    };
    panic_guard(
        || {
            crate::metrics::MetricsRegistry::record_batch(
                unsafe { &*(handle as *const crate::metrics::MetricsRegistry) },
                buf,
            )
        },
        Err(String::new()),
    )
    .is_ok() as u8
}
