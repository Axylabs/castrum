use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

use crate::fast_schema;
use crate::packed::PackedIter;
use crate::util::should_parallelize;

#[napi]
pub struct SchemaValidator {
    schema: Arc<jsonschema::Validator>,
    /// Zero-DOM fast path, engaged when the schema only uses the supported
    /// keyword subset; `None` falls back to the `jsonschema` crate DOM path.
    fast: Option<Arc<fast_schema::FastNode>>,
}

/// Total payload bytes in a packed buffer (`[u32 count] {[u32 len][bytes]}`),
/// computed in O(1) from the buffer length + header count. Used only as the
/// rayon-parallelism heuristic input, so trailing bytes just over-count harmlessly.
#[inline(always)]
fn packed_payload_bytes(data: &[u8], count: usize) -> usize {
    data.len().saturating_sub(4).saturating_sub(count * 4)
}

#[napi]
impl SchemaValidator {
    #[napi(constructor)]
    pub fn new(schema_bytes: Uint8Array) -> Result<Self> {
        let schema_value: Value = sonic_rs::from_slice(schema_bytes.as_ref())
            .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;

        let compiled = jsonschema::validator_for(&schema_value).map_err(|e| {
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
            let chunk_items = 256usize.max(64);
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

    /// Stream-validate a JSON array payload.
    ///
    /// This still materializes one array element at a time, because
    /// `jsonschema` currently expects a DOM-like value, but it avoids
    /// materializing the entire array at once.
    #[napi]
    pub fn validate_batch_streaming(&self, batch_bytes: Uint8Array) -> Result<u32> {
        let mut de = sonic_rs::Deserializer::from_slice(batch_bytes.as_ref());
        let seed = BatchSeed {
            validator: &self.schema,
        };

        let count = seed
            .deserialize(&mut de)
            .map_err(|e| Error::from_reason(format!("Streaming batch JSON error: {}", e)))?;

        Ok(count)
    }
}

struct BatchSeed<'a> {
    validator: &'a jsonschema::Validator,
}

impl<'de> DeserializeSeed<'de> for BatchSeed<'_> {
    type Value = u32;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(BatchVisitor {
            validator: self.validator,
        })
    }
}

struct BatchVisitor<'a> {
    validator: &'a jsonschema::Validator,
}

impl<'de> Visitor<'de> for BatchVisitor<'_> {
    type Value = u32;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON array of documents")
    }

    fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut count = 0u32;

        while let Some(value) = seq.next_element::<Value>()? {
            if self.validator.is_valid(&value) {
                count += 1;
            }
        }

        Ok(count)
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

        // Streaming batch: one JSON array of the same docs.
        let array: String = format!(
            "[{}]",
            docs.iter()
                .map(|d| std::str::from_utf8(d).unwrap())
                .collect::<Vec<_>>()
                .join(",")
        );
        let streamed = v
            .validate_batch_streaming(Uint8Array::new(array.into_bytes()))
            .unwrap();

        assert_eq!(count, 3);
        assert_eq!(bitset_count as usize, docs.len());
        assert_eq!(valid_from_bitset, 3);
        assert_eq!(streamed, 3);
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
}
