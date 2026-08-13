// rust/json/fast_schema/errors.rs — Validation context + error collection.
//
// The fast path's single `validate` walk supports two modes via `Ctx`:
//   - bool mode  (`errors: None`) — zero-allocation, matches the original
//     `is_valid_bytes` hot path used by the ingress.
//   - detailed   (`errors: Some(..)`) — collects `SchemaError`s carrying an
//     instance JSON pointer, a schema JSON pointer, the failing keyword, and a
//     human-readable message.
//
// `suppress` silences recording during combinator branch checks (anyOf/oneOf/
// not/if-guard) whose internal outcome is not itself the cause of failure — a
// failing branch is only a cause if the whole combinator fails, at which point
// a summary error is recorded instead.

/// Maximum JSON nesting depth accepted by the fast path. Matches the default
/// recursion limits of sonic-rs (the ingress `json_valid_bytes` gate) and
/// serde_json (the DOM fallback), so rejecting deeper documents keeps the fast
/// path byte-parity with the reference AND prevents hostile deeply-nested JSON
/// from exhausting the native stack (a stack overflow is an UNCATCHABLE process
/// abort — `panic = "unwind"` + napi `catch_unwind` do NOT catch it).
pub(crate) const MAX_DEPTH: u32 = 128;

/// A single validation error, mirroring the field structure of
/// `jsonschema::ValidationError` (instance path, schema path, keyword, message)
/// but with our own message wording.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaError {
    /// RFC 6901 JSON pointer to the failing instance value ("" = root).
    pub(crate) instance_path: String,
    /// JSON pointer into the schema at the failing keyword.
    pub(crate) schema_path: String,
    /// The failing keyword (e.g. "type", "pattern", "required").
    pub(crate) keyword: String,
    /// Human-readable failure message.
    pub(crate) message: String,
}

/// One segment of the instance path being validated.
#[derive(Clone)]
pub(crate) enum PathStep {
    Key(Box<[u8]>),
    Index(usize),
}

pub(crate) struct Ctx {
    /// `None` = bool mode (zero-alloc). `Some` = detailed mode.
    pub(crate) errors: Option<Vec<SchemaError>>,
    /// Maximum number of errors to record (1 for validate-first-error).
    pub(crate) max_errors: usize,
    /// When true, `record` is a no-op (combinator branch checks).
    pub(crate) suppress: bool,
    /// Instance path stack (maintained in detailed mode AND capture mode).
    pub(crate) path: Vec<PathStep>,
    /// Current recursion depth of the validate walk (guarded by `MAX_DEPTH`).
    pub(crate) depth: u32,
    /// One-pass derive capture (None = disabled; the normal hot paths).
    pub(crate) capture: Option<super::capture::Capture>,
    /// Root input pointer for the current walk. Capture only fires on the ROOT
    /// cursor (sub-scan cursors point into sub-slices and are ignored), so
    /// captured byte ranges are always absolute into the original input.
    pub(crate) input_ptr: *const u8,
}

impl Ctx {
    pub(crate) fn bool_mode() -> Self {
        Self {
            errors: None,
            max_errors: usize::MAX,
            suppress: false,
            path: Vec::new(),
            depth: 0,
            capture: None,
            input_ptr: std::ptr::null(),
        }
    }

    pub(crate) fn detailed(max_errors: usize) -> Self {
        Self {
            errors: Some(Vec::new()),
            max_errors,
            suppress: false,
            path: Vec::new(),
            depth: 0,
            capture: None,
            input_ptr: std::ptr::null(),
        }
    }

    #[inline]
    pub(crate) fn is_detailed(&self) -> bool {
        self.errors.is_some()
    }

    #[inline]
    pub(crate) fn record(&mut self, schema_base: &str, keyword: &str, message: String) {
        if self.suppress {
            return;
        }
        let Some(errors) = &mut self.errors else {
            return;
        };
        if errors.len() >= self.max_errors {
            return;
        }
        let schema_path = if schema_base.is_empty() {
            format!("/{keyword}")
        } else {
            format!("{schema_base}/{keyword}")
        };
        errors.push(SchemaError {
            instance_path: build_pointer(&self.path),
            schema_path,
            keyword: keyword.to_string(),
            message,
        });
    }

    /// Run `f` with error recording suppressed (combinator branch checks).
    pub(crate) fn with_suppressed<R>(&mut self, f: impl FnOnce(&mut Self) -> R) -> R {
        let saved = self.suppress;
        self.suppress = true;
        let r = f(self);
        self.suppress = saved;
        r
    }

    /// Enter one nesting level of the validate walk. Returns false once the
    /// walk exceeds `MAX_DEPTH`; the caller must then fail validation WITHOUT
    /// recursing further (see `FastNode::validate`).
    #[inline]
    pub(crate) fn enter_depth(&mut self) -> bool {
        self.depth += 1;
        self.depth <= MAX_DEPTH
    }

    /// Leave one nesting level of the validate walk (mirrors `enter_depth`).
    #[inline]
    pub(crate) fn leave_depth(&mut self) {
        self.depth -= 1;
    }

    #[inline]
    pub(crate) fn push_key(&mut self, key: &[u8]) {
        if self.errors.is_some() {
            self.path.push(PathStep::Key(key.to_vec().into_boxed_slice()));
        }
    }

    #[inline]
    pub(crate) fn push_idx(&mut self, idx: usize) {
        if self.errors.is_some() {
            self.path.push(PathStep::Index(idx));
        }
    }

    #[inline]
    pub(crate) fn pop(&mut self) {
        if self.errors.is_some() {
            self.path.pop();
        }
    }

    /// Descend the capture trie for an object member key (capture mode only).
    #[inline]
    pub(crate) fn capture_enter_key(&mut self, data_ptr: *const u8, key: &[u8]) {
        let Some(cap) = &mut self.capture else {
            return;
        };
        if self.suppress || data_ptr != self.input_ptr {
            return;
        }
        cap.enter_key(key);
    }

    /// Leave the current capture-trie nesting level.
    #[inline]
    pub(crate) fn capture_exit_key(&mut self, data_ptr: *const u8) {
        let Some(cap) = &mut self.capture else {
            return;
        };
        if self.suppress || data_ptr != self.input_ptr {
            return;
        }
        cap.exit_key();
    }

    /// Record a scalar member value after it validated (capture mode only).
    #[inline]
    pub(crate) fn capture_record_value(&mut self, data_ptr: *const u8, start: usize, end: usize) {
        let Some(cap) = &mut self.capture else {
            return;
        };
        if self.suppress || data_ptr != self.input_ptr {
            return;
        }
        cap.record_value(start, end);
    }

    /// Record an array element count after it validated (capture mode only).
    #[inline]
    pub(crate) fn capture_record_length(&mut self, data_ptr: *const u8, count: usize) {
        let Some(cap) = &mut self.capture else {
            return;
        };
        if self.suppress || data_ptr != self.input_ptr {
            return;
        }
        cap.record_length(count);
    }

    pub(crate) fn into_errors(self) -> Vec<SchemaError> {
        self.errors.unwrap_or_default()
    }
}

/// Build an RFC 6901 JSON pointer from the path stack (`~` -> `~0`, `/` -> `~1`).
fn build_pointer(path: &[PathStep]) -> String {
    if path.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for step in path {
        match step {
            PathStep::Key(k) => {
                out.push('/');
                for &b in k.iter() {
                    match b {
                        b'~' => out.push_str("~0"),
                        b'/' => out.push_str("~1"),
                        _ => out.push(b as char),
                    }
                }
            }
            PathStep::Index(i) => {
                out.push('/');
                out.push_str(&i.to_string());
            }
        }
    }
    out
}
