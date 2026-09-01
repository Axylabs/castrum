// rust/json/json_schema.rs — SchemaValidator napi class (fast + DOM fallback + batch).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::sync::Arc;

use crate::json::fast_schema;
use crate::util::packed::PackedIter;
use crate::util::should_parallelize;

#[napi]
pub struct SchemaValidator {
    schema: Arc<jsonschema::Validator>,
    /// Zero-DOM fast path, engaged when the schema only uses the supported
    /// keyword subset; `None` falls back to the `jsonschema` crate DOM path.
    fast: Option<Arc<fast_schema::FastNode>>,
}

/// C-ABI support: validate a document against the compiled schema.
///
/// # Safety
/// `p` must be a valid `*const SchemaValidator` from `inner_ptr`, alive for
/// the call (the JS wrapper holds the napi instance).
pub(crate) unsafe fn schema_validator_validate_core(p: *const SchemaValidator, doc: &[u8]) -> bool {
    let this = &*p;
    this.validate_doc(doc)
}

/// Fused wire-level validation: parse a RAW query string into JSON (the same
/// `query_to_json_into_slice` the ingress hot path uses — `+`/`%XX` decoded,
/// duplicate keys last-wins) and draft-07-validate it against the compiled
/// schema in ONE call. `false` = malformed query OR schema violation; callers
/// fall back to the detailed path for exact errors on failure.
///
/// # Safety
/// `p` must be a valid `*const SchemaValidator` from `inner_ptr`, alive for
/// the call.
pub(crate) unsafe fn schema_validate_query_core(p: *const SchemaValidator, qs: &[u8]) -> bool {
    let this = &*p;
    // json_ser's JSON writers need headroom beyond the input length (escape
    // expansion + per-pair overhead); queries are tiny so this is cheap.
    let cap = qs.len() * 12 + 256;
    let mut json = vec![0u8; cap];
    match crate::json::json_ser::query_to_json_into_slice(qs, &mut json, 512) {
        Ok(w) => this.validate_doc(&json[..w]),
        Err(_) => false,
    }
}

/// Fused cookie-header variant: parse (trim + DQUOTE-unwrap, NO percent-decode
/// — cookie semantics) into JSON and validate. Same verdict contract.
///
/// # Safety
/// See [`schema_validate_query_core`].
pub(crate) unsafe fn schema_validate_cookie_core(p: *const SchemaValidator, header: &[u8]) -> bool {
    let this = &*p;
    let cap = header.len() * 12 + 256;
    let mut json = vec![0u8; cap];
    match crate::json::json_ser::cookie_json_into_slice(header, &mut json, 128) {
        Ok(w) => this.validate_doc(&json[..w]),
        Err(_) => false,
    }
}

/// Total payload bytes in a packed buffer (`[u32 count] {[u32 len][bytes]}`),
/// computed in O(1) from the buffer length + header count. Used only as the
/// rayon-parallelism heuristic input, so trailing bytes just over-count harmlessly.
#[inline(always)]
fn packed_payload_bytes(data: &[u8], count: usize) -> usize {
    data.len().saturating_sub(4).saturating_sub(count * 4)
}

/// A single JSON Schema validation error (fast path + DOM fallback).
#[napi(object)]
pub struct SchemaError {
    /// RFC 6901 JSON pointer to the failing instance value ("" = root).
    pub instance_path: String,
    /// JSON pointer into the schema at the failing keyword.
    pub schema_path: String,
    /// The failing keyword (e.g. "type", "pattern", "required").
    pub keyword: String,
    /// Human-readable failure message.
    pub message: String,
}

impl From<crate::json::fast_schema::SchemaError> for SchemaError {
    fn from(e: crate::json::fast_schema::SchemaError) -> Self {
        Self {
            instance_path: e.instance_path,
            schema_path: e.schema_path,
            keyword: e.keyword,
            message: e.message,
        }
    }
}

/// A single derived value captured during one-pass validation.
#[napi(object)]
pub struct JsonDeriveValue {
    /// `"int" | "number" | "string" | "bool" | "null"`.
    pub kind: String,
    pub int: Option<i64>,
    pub number: Option<f64>,
    pub text: Option<String>,
    pub boolean: Option<bool>,
}

/// Result of a one-pass `validate + derive`.
#[napi(object)]
pub struct JsonDeriveResult {
    /// `true` when the document is schema-valid; `false` → caller rejects.
    pub ok: bool,
    /// One entry per requested path (`None` = path absent from the document).
    pub values: Vec<Option<JsonDeriveValue>>,
}

#[napi]
impl SchemaValidator {
    #[napi(constructor)]
    pub fn new(schema_bytes: Uint8Array) -> Result<Self> {
        let schema_value: Value = sonic_rs::from_slice(schema_bytes.as_ref())
            .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;

        // `should_validate_formats(true)`: jsonschema 0.48 disables format
        // validation by default (validator_for uses default options), which
        // silently ignored `format:` keywords (e.g. the ingress USER_SCHEMA's
        // `format: "email"`). The zero-DOM fast path now honors `format:
        // "email"`, so the DOM fallback must validate formats too — otherwise
        // the two diverge on every format-using schema.
        //
        // `.with_draft(Draft7)`: the fast path implements draft-07 semantics,
        // and jsonschema 0.48's DEFAULT draft (no `$schema`) is 2020-12. Pin
        // the authoritative DOM validator to draft-07 so schemas without a
        // `$schema` behave identically on both paths. Schemas that DO declare a
        // different `$schema` still honor it (the document overrides the
        // default), and the fast path falls back for those.
        let compiled = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .should_validate_formats(true)
            .build(&schema_value)
            .map_err(|e| {
                Error::new(
                    Status::InvalidArg,
                    format!("Schema compilation error: {}", e),
                )
            })?;

        // The zero-DOM fast path engages only for schemas using the supported
        // keyword subset; anything else falls back to the compiled crate.
        let fast = fast_schema::compile(&schema_value).ok().map(Arc::new);

        Ok(Self {
            schema: Arc::new(compiled),
            fast,
        })
    }

    #[inline]
    fn validate_doc(&self, bytes: &[u8]) -> bool {
        if let Some(fast) = &self.fast {
            return fast.is_valid_bytes(bytes);
        }
        match sonic_rs::from_slice::<Value>(bytes) {
            Ok(value) => self.schema.is_valid(&value),
            Err(_) => false,
        }
    }

    /// Validate a single JSON document against the schema.
    #[napi]
    pub fn validate(&self, input: Uint8Array) -> bool {
        self.validate_doc(input.as_ref())
    }

    /// Opaque handle to the compiled schema, for the `bun:ffi` C-ABI fast path
    /// (`castrum_schema_validator_validate` in rust/ffi.rs). Only valid while
    /// THIS instance is alive; the JS wrapper holds the instance.
    #[napi]
    pub fn inner_ptr(&self) -> u64 {
        self as *const SchemaValidator as u64
    }

    /// One-pass validate + extract: validate `input` against the schema and
    /// capture scalar values / array lengths at `paths` during the SAME walk
    /// (no `JSON.parse`, no DOM). For "derive" routes (response built from a
    /// handful of body fields) this replaces `JSON.parse` + Ajv on the happy
    /// path and rejects invalid bodies with zero DOM/GC.
    ///
    /// `paths` are RFC 6901 JSON pointers of OBJECT KEYS; a trailing `/-`
    /// captures the ARRAY LENGTH at that path (e.g. `"/totalCents"`,
    /// `"/lineItems/-"`). Array-index steps are not supported.
    #[napi]
    pub fn derive(&self, input: Uint8Array, paths: Vec<String>) -> Result<JsonDeriveResult> {
        let targets = parse_derive_targets(&paths)?;
        if let Some(fast) = &self.fast {
            let (ok, cap) = fast.validate_with_capture(input.as_ref(), targets.clone());
            Ok(JsonDeriveResult {
                ok,
                values: derive_values(&cap, ok, &targets, input.as_ref()),
            })
        } else {
            self.derive_dom(input.as_ref(), &targets)
        }
    }

    /// Validate a single JSON document and return detailed errors (empty = valid).
    ///
    /// On the zero-DOM fast path this returns every collected error; on the DOM
    /// fallback path only the first validation error is produced.
    #[napi]
    pub fn validate_detailed(&self, input: Uint8Array) -> Vec<SchemaError> {
        if let Some(fast) = &self.fast {
            return fast
                .validate_errors(input.as_ref(), usize::MAX)
                .into_iter()
                .map(SchemaError::from)
                .collect();
        }
        match sonic_rs::from_slice::<Value>(input.as_ref()) {
            Ok(value) => match self.schema.validate(&value) {
                Ok(()) => Vec::new(),
                Err(e) => vec![SchemaError {
                    instance_path: e.instance_path().to_string(),
                    schema_path: e.schema_path().to_string(),
                    keyword: format!("{:?}", e.kind()),
                    message: e.to_string(),
                }],
            },
            Err(_) => vec![SchemaError {
                instance_path: String::new(),
                schema_path: String::new(),
                keyword: "parse".to_string(),
                message: "document is not valid JSON".to_string(),
            }],
        }
    }

    /// Validate a single JSON document and return only the first error (if any).
    #[napi]
    pub fn validate_first_error(&self, input: Uint8Array) -> Option<SchemaError> {
        if let Some(fast) = &self.fast {
            return fast
                .validate_errors(input.as_ref(), 1)
                .into_iter()
                .next()
                .map(SchemaError::from);
        }
        match sonic_rs::from_slice::<Value>(input.as_ref()) {
            Ok(value) => match self.schema.validate(&value) {
                Ok(()) => None,
                Err(e) => Some(SchemaError {
                    instance_path: e.instance_path().to_string(),
                    schema_path: e.schema_path().to_string(),
                    keyword: format!("{:?}", e.kind()),
                    message: e.to_string(),
                }),
            },
            Err(_) => Some(SchemaError {
                instance_path: String::new(),
                schema_path: String::new(),
                keyword: "parse".to_string(),
                message: "document is not valid JSON".to_string(),
            }),
        }
    }

    /// Validate a packed batch of individual JSON documents.
    ///
    /// Input format:
    ///
    ///   [u32 count]
    ///   repeated:
    ///     [u32 doc_len]
    ///     [doc bytes]
    ///
    /// This avoids materializing the entire batch into one DOM array.
    #[napi]
    pub fn validate_batch_packed_count(&self, packed: Uint8Array) -> Result<u32> {
        let data = packed.as_ref();
        let iter = PackedIter::new(data)?;
        let count = iter.len();
        let payload = packed_payload_bytes(data, count);

        // Serial path is zero-alloc (PackedIter); only very large batches pay the
        // one-time slice collect to enable rayon parallelism.
        let valid: usize = if should_parallelize(count, payload) {
            use rayon::prelude::*;
            let items: Vec<&[u8]> = PackedIter::new(data)?.collect();
            items
                .par_iter()
                .filter(|item| self.validate_doc(item))
                .count()
        } else {
            PackedIter::new(data)?
                .filter(|item| self.validate_doc(item))
                .count()
        };

        Ok(valid as u32)
    }

    /// Validate a packed batch and return a packed bitset.
    ///
    /// Output format:
    ///
    ///   [u32 count]
    ///   [ceil(count / 8) bytes]
    #[napi]
    pub fn validate_batch_packed_bitset(&self, packed: Uint8Array) -> Result<Buffer> {
        let data = packed.as_ref();
        let iter = PackedIter::new(data)?;
        let count = iter.len();
        let payload = packed_payload_bytes(data, count);

        let bitset_len = count.div_ceil(8);
        let mut out = Vec::with_capacity(4 + bitset_len);
        out.extend_from_slice(&(count as u32).to_le_bytes());
        out.resize(4 + bitset_len, 0);

        if count == 0 {
            return Ok(Buffer::from(out));
        }

        if should_parallelize(count, payload) {
            use rayon::prelude::*;
            let items: Vec<&[u8]> = PackedIter::new(data)?.collect();
            let chunk_items = 256usize;
            let chunk_bytes = chunk_items.div_ceil(8);
            let bits = &mut out[4..];
            bits.par_chunks_mut(chunk_bytes)
                .enumerate()
                .for_each(|(chunk_idx, chunk)| {
                    let start_item = chunk_idx * chunk_bytes * 8;
                    let end_item = (start_item + chunk.len() * 8).min(count);
                    let start_byte = start_item / 8;
                    for i in start_item..end_item {
                        if self.validate_doc(items[i]) {
                            chunk[(i / 8) - start_byte] |= 1 << (i & 7);
                        }
                    }
                });
        } else {
            for (i, item) in PackedIter::new(data)?.enumerate() {
                if self.validate_doc(item) {
                    out[4 + (i >> 3)] |= 1 << (i & 7);
                }
            }
        }

        Ok(Buffer::from(out))
    }
}

fn parse_derive_targets(paths: &[String]) -> Result<Vec<fast_schema::TargetPath>> {
    let mut targets = Vec::with_capacity(paths.len());
    for p in paths {
        match fast_schema::parse_target(p) {
            Some(t) => targets.push(t),
            None => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "derive path \"{p}\" must be a JSON pointer of object keys (e.g. \"/totalCents\", \"/lineItems/-\")"
                    ),
                ));
            }
        }
    }
    Ok(targets)
}

/// Turn a completed capture into the napi result values (fast path).
fn derive_values(
    cap: &fast_schema::Capture,
    ok: bool,
    targets: &[fast_schema::TargetPath],
    input: &[u8],
) -> Vec<Option<JsonDeriveValue>> {
    targets
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if !ok {
                return None;
            }
            match t.kind {
                fast_schema::CaptureKind::Length => cap.length(i).map(|n| JsonDeriveValue {
                    kind: "int".to_string(),
                    int: Some(n as i64),
                    number: None,
                    text: None,
                    boolean: None,
                }),
                fast_schema::CaptureKind::Value => cap.value_range(i).and_then(|(s, e)| {
                    if e <= s || e > input.len() {
                        None
                    } else {
                        Some(scalar_value(&input[s..e]))
                    }
                }),
            }
        })
        .collect()
}

/// Classify a captured raw scalar value (bytes are exactly the JSON value).
fn scalar_value(raw: &[u8]) -> JsonDeriveValue {
    let null_value = JsonDeriveValue {
        kind: "null".to_string(),
        int: None,
        number: None,
        text: None,
        boolean: None,
    };
    let Some(first) = raw.first() else {
        return null_value;
    };
    match first {
        b'"' => match serde_json::from_slice::<String>(raw) {
            Ok(s) => JsonDeriveValue {
                kind: "string".to_string(),
                int: None,
                number: None,
                text: Some(s),
                boolean: None,
            },
            Err(_) => null_value,
        },
        b't' | b'f' => JsonDeriveValue {
            kind: "bool".to_string(),
            int: None,
            number: None,
            text: None,
            boolean: Some(*first == b't'),
        },
        b'n' => null_value,
        _ => {
            let s = std::str::from_utf8(raw).unwrap_or("");
            if let Ok(i) = s.parse::<i64>() {
                JsonDeriveValue {
                    kind: "int".to_string(),
                    int: Some(i),
                    number: None,
                    text: None,
                    boolean: None,
                }
            } else if let Ok(f) = s.parse::<f64>() {
                JsonDeriveValue {
                    kind: "number".to_string(),
                    int: None,
                    number: Some(f),
                    text: None,
                    boolean: None,
                }
            } else {
                null_value
            }
        }
    }
}

/// JSON pointer string for a target path (for the DOM-fallback extraction).
fn pointer_for(t: &fast_schema::TargetPath) -> String {
    let mut out = String::new();
    for step in &t.steps {
        out.push('/');
        for &b in step.iter() {
            match b {
                b'~' => out.push_str("~0"),
                b'/' => out.push_str("~1"),
                _ => out.push(b as char),
            }
        }
    }
    out
}

fn dom_scalar(v: &Value) -> JsonDeriveValue {
    match v {
        Value::Null => JsonDeriveValue {
            kind: "null".to_string(),
            int: None,
            number: None,
            text: None,
            boolean: None,
        },
        Value::Bool(b) => JsonDeriveValue {
            kind: "bool".to_string(),
            int: None,
            number: None,
            text: None,
            boolean: Some(*b),
        },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                JsonDeriveValue {
                    kind: "int".to_string(),
                    int: Some(i),
                    number: None,
                    text: None,
                    boolean: None,
                }
            } else if let Some(f) = n.as_f64() {
                JsonDeriveValue {
                    kind: "number".to_string(),
                    int: None,
                    number: Some(f),
                    text: None,
                    boolean: None,
                }
            } else {
                JsonDeriveValue {
                    kind: "number".to_string(),
                    int: None,
                    number: None,
                    text: None,
                    boolean: None,
                }
            }
        }
        Value::String(s) => JsonDeriveValue {
            kind: "string".to_string(),
            int: None,
            number: None,
            text: Some(s.clone()),
            boolean: None,
        },
        Value::Array(_) | Value::Object(_) => JsonDeriveValue {
            kind: "null".to_string(),
            int: None,
            number: None,
            text: None,
            boolean: None,
        },
    }
}

impl SchemaValidator {
    /// DOM-fallback derive (schemas outside the fast subset): validate then
    /// extract with serde_json pointers. Correctness matters; perf is fine
    /// (this is the rare non-fast-schema case).
    fn derive_dom(
        &self,
        bytes: &[u8],
        targets: &[fast_schema::TargetPath],
    ) -> Result<JsonDeriveResult> {
        let value: Value = match sonic_rs::from_slice(bytes) {
            Ok(v) => v,
            Err(_) => {
                return Ok(JsonDeriveResult {
                    ok: false,
                    values: (0..targets.len()).map(|_| None).collect(),
                });
            }
        };
        if !self.schema.is_valid(&value) {
            return Ok(JsonDeriveResult {
                ok: false,
                values: (0..targets.len()).map(|_| None).collect(),
            });
        }
        let values = targets
            .iter()
            .map(|t| {
                let ptr = pointer_for(t);
                match t.kind {
                    fast_schema::CaptureKind::Length => value
                        .pointer(&ptr)
                        .and_then(|v| v.as_array())
                        .map(|a| JsonDeriveValue {
                            kind: "int".to_string(),
                            int: Some(a.len() as i64),
                            number: None,
                            text: None,
                            boolean: None,
                        }),
                    fast_schema::CaptureKind::Value => value.pointer(&ptr).map(dom_scalar),
                }
            })
            .collect();
        Ok(JsonDeriveResult { ok: true, values })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = r#"{
      "type": "object",
      "required": ["id", "name"],
      "properties": {
        "id": { "type": "number" },
        "name": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }"#;

    fn validator() -> SchemaValidator {
        SchemaValidator::new(Uint8Array::new(SCHEMA.as_bytes().to_vec())).unwrap()
    }

    #[test]
    fn validate_accepts_valid_doc() {
        let v = validator();
        assert!(v.validate_doc(br#"{"id":1,"name":"alice"}"#));
    }

    #[test]
    fn validate_rejects_invalid_doc() {
        let v = validator();
        // Wrong types + extra properties (additionalProperties: false).
        assert!(!v.validate_doc(br#"{"id":"x","name":"alice"}"#));
        assert!(!v.validate_doc(br#"{"id":1,"name":42}"#));
        assert!(!v.validate_doc(br#"{"id":1,"name":"alice","extra":true}"#));
        // Malformed JSON is not valid either.
        assert!(!v.validate_doc(b"{nope"));
    }

    #[test]
    fn validate_batch_count_matches() {
        let v = validator();
        let docs: [&[u8]; 3] = [
            br#"{"id":1,"name":"a"}"#,
            br#"{"id":2,"name":"b"}"#,
            br#"{"id":"bad"}"#,
        ];
        // Build packed [u32 count]{[u32 len][doc]} by hand.
        let mut packed = Vec::new();
        packed.extend_from_slice(&(docs.len() as u32).to_le_bytes());
        for doc in docs {
            packed.extend_from_slice(&(doc.len() as u32).to_le_bytes());
            packed.extend_from_slice(doc);
        }

        let count = v
            .validate_batch_packed_count(Uint8Array::new(packed))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn batch_paths_agree() {
        let v = validator();
        let docs: [&[u8]; 5] = [
            br#"{"id":1,"name":"a"}"#,
            br#"{"id":2,"name":"b"}"#,
            br#"{"id":"bad"}"#,
            br#"{"id":3,"name":42}"#,
            br#"{"id":4,"name":"c"}"#,
        ];

        // Packed batch: [u32 count]{[u32 len][doc]}.
        let mut packed = Vec::new();
        packed.extend_from_slice(&(docs.len() as u32).to_le_bytes());
        for doc in docs {
            packed.extend_from_slice(&(doc.len() as u32).to_le_bytes());
            packed.extend_from_slice(doc);
        }

        let count = v
            .validate_batch_packed_count(Uint8Array::new(packed.clone()))
            .unwrap();
        let bitset = v
            .validate_batch_packed_bitset(Uint8Array::new(packed))
            .unwrap();

        let bitset_count = u32::from_le_bytes([bitset[0], bitset[1], bitset[2], bitset[3]]);
        let valid_from_bitset = (0..docs.len())
            .filter(|&i| (bitset[4 + (i >> 3)] >> (i & 7)) & 1 == 1)
            .count();

        assert_eq!(count, 3);
        assert_eq!(bitset_count as usize, docs.len());
        assert_eq!(valid_from_bitset, 3);
    }

    /// Diagnostic: splits per-document cost into DOM build vs schema walk, to
    /// confirm where the schema-validation budget goes. No timing assertion
    /// (would be flaky in CI); print with `cargo test -- --nocapture`.
    #[test]
    fn dom_build_vs_validate_cost() {
        let v = validator();
        let doc: &[u8] = br#"{"id":1,"name":"user_1","active":true,"score":1.25,"tags":["alpha","beta"],"nested":{"version":1,"createdAt":"2026-01-01T00:00:00Z"}}"#;
        const N: u32 = 20_000;

        // Warm both paths.
        for _ in 0..1_000 {
            let _ = sonic_rs::from_slice::<Value>(doc).unwrap();
        }
        let parsed: Value = sonic_rs::from_slice(doc).unwrap();
        for _ in 0..1_000 {
            let _ = v.schema.is_valid(&parsed);
        }

        let t0 = std::time::Instant::now();
        for _ in 0..N {
            let _ = sonic_rs::from_slice::<Value>(doc).unwrap();
        }
        let parse_ns = t0.elapsed().as_nanos() as f64 / N as f64;

        let t1 = std::time::Instant::now();
        for _ in 0..N {
            let _ = v.schema.is_valid(&parsed);
        }
        let validate_ns = t1.elapsed().as_nanos() as f64 / N as f64;

        let total = parse_ns + validate_ns;
        println!(
            "schema micro-bench: dom-build {parse_ns:.0}ns  validate {validate_ns:.0}ns  dom-share {:.0}%",
            parse_ns / total * 100.0
        );

        // Correctness sanity: a doc matching the test SCHEMA (id+name only,
        // additionalProperties:false) must pass; the larger fixture-like doc has
        // extra properties and is correctly rejected by that schema.
        assert!(v.validate_doc(br#"{"id":1,"name":"a"}"#));
        assert!(!v.validate_doc(doc));
    }

    // ── one-pass derive (validate + extract) ────────────────────────────────

    const ORDERS_SCHEMA: &str = r#"{
      "type": "object",
      "required": ["orderId","lineItems","totalCents","customer"],
      "properties": {
        "orderId": { "type": "string" },
        "customer": {
          "type": "object",
          "required": ["id","email"],
          "properties": { "id": {"type":"string"}, "email": {"type":"string"} }
        },
        "lineItems": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["sku","quantity"],
            "properties": {
              "sku": {"type":"string"},
              "quantity": {"type":"integer","minimum":1}
            }
          }
        },
        "totalCents": { "type": "integer" }
      },
      "additionalProperties": false
    }"#;

    const ORDERS_DOC: &str = r#"{
      "orderId": "ord_1",
      "customer": {"id":"cus_1","email":"a@b.c"},
      "lineItems": [
        {"sku":"A","quantity":2},
        {"sku":"B","quantity":3},
        {"sku":"C","quantity":1}
      ],
      "totalCents": 108000
    }"#;

    fn orders_validator() -> SchemaValidator {
        SchemaValidator::new(Uint8Array::new(ORDERS_SCHEMA.as_bytes().to_vec())).unwrap()
    }

    fn derive(v: &SchemaValidator, doc: &[u8], paths: &[&str]) -> JsonDeriveResult {
        let p: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        v.derive(Uint8Array::new(doc.to_vec()), p).unwrap()
    }

    #[test]
    fn derive_extracts_count_and_int() {
        let v = orders_validator();
        let r = derive(&v, ORDERS_DOC.as_bytes(), &["/lineItems/-", "/totalCents"]);
        assert!(r.ok);
        assert_eq!(r.values.len(), 2);
        let count = r.values[0].as_ref().unwrap();
        assert_eq!(count.kind, "int");
        assert_eq!(count.int, Some(3));
        let total = r.values[1].as_ref().unwrap();
        assert_eq!(total.kind, "int");
        assert_eq!(total.int, Some(108000));
    }

    #[test]
    fn derive_extracts_string() {
        let v = orders_validator();
        let r = derive(&v, ORDERS_DOC.as_bytes(), &["/customer/email"]);
        assert!(r.ok);
        let email = r.values[0].as_ref().unwrap();
        assert_eq!(email.kind, "string");
        assert_eq!(email.text.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn derive_missing_path_is_none() {
        let v = orders_validator();
        let r = derive(&v, ORDERS_DOC.as_bytes(), &["/nope", "/lineItems/-"]);
        assert!(r.ok);
        assert!(r.values[0].is_none());
        assert_eq!(r.values[1].as_ref().unwrap().int, Some(3));
    }

    #[test]
    fn derive_invalid_doc_is_not_ok() {
        let v = orders_validator();
        // bad sku type at lineItems[0]
        let bad: &[u8] = br#"{"orderId":"o","customer":{"id":"c","email":"e@x"},
          "lineItems":[{"sku":123,"quantity":2}],"totalCents":1}"#;
        let r = derive(&v, bad, &["/lineItems/-", "/totalCents"]);
        assert!(!r.ok);
        assert!(r.values[0].is_none());
        // malformed JSON
        let r2 = derive(&v, b"{oops", &["/totalCents"]);
        assert!(!r2.ok);
    }

    #[test]
    fn derive_matches_plain_validate() {
        // For a batch of docs, derive.ok must equal validate_doc exactly.
        let v = orders_validator();
        let docs: [&[u8]; 5] = [
            ORDERS_DOC.as_bytes(),
            br#"{"orderId":"o","customer":{"id":"c","email":"e"},
                "lineItems":[],"totalCents":0}"#,
            br#"{"orderId":"o","customer":{"id":"c","email":"e"},
                "lineItems":[{"sku":"a","quantity":0}],"totalCents":1}"#,
            br#"{"orderId":"o","customer":{"id":"c","email":"e"},
                "lineItems":[{"sku":"a","quantity":2}],"totalCents":"x"}"#,
            b"not json at all",
        ];
        for doc in docs {
            let expected = v.validate_doc(doc);
            let r = derive(&v, doc, &["/totalCents", "/lineItems/-"]);
            assert_eq!(r.ok, expected, "derive.ok must equal validate_doc");
        }
    }
}
