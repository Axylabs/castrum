use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::de::{DeserializeSeed, Deserializer, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

use crate::util::{should_parallelize, total_bytes, unpack};
#[napi]
pub struct SchemaValidator {
    schema: Arc<jsonschema::Validator>,
}

#[napi]
impl SchemaValidator {
    #[napi(constructor)]
    pub fn new(schema_bytes: Uint8Array) -> Result<Self> {
        let schema_str = std::str::from_utf8(&schema_bytes)
            .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in schema"))?;

        let schema_value: Value = sonic_rs::from_str(schema_str)
            .map_err(|e| Error::new(Status::InvalidArg, format!("Schema JSON error: {}", e)))?;

        let compiled = jsonschema::validator_for(&schema_value).map_err(|e| {
            Error::new(
                Status::InvalidArg,
                format!("Schema compilation error: {}", e),
            )
        })?;

        Ok(Self {
            schema: Arc::new(compiled),
        })
    }

    #[inline]
    fn validate_doc(&self, bytes: &[u8]) -> bool {
        match sonic_rs::from_slice::<Value>(bytes) {
            Ok(value) => self.schema.is_valid(&value),
            Err(_) => false,
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
        let items = unpack(packed.as_ref())?;

        let count: u32 = if should_parallelize(items.len(), total_bytes(&items)) {
            use rayon::prelude::*;

            items
                .par_chunks(256)
                .map(|chunk| chunk.iter().filter(|item| self.validate_doc(item)).count() as u32)
                .sum()
        } else {
            items.iter().filter(|item| self.validate_doc(item)).count() as u32
        };

        Ok(count)
    }

    /// Validate a packed batch and return a packed bitset.
    ///
    /// Output format:
    ///
    ///   [u32 count]
    ///   [ceil(count / 8) bytes]
    #[napi]
    pub fn validate_batch_packed_bitset(&self, packed: Uint8Array) -> Result<Buffer> {
        let items = unpack(packed.as_ref())?;

        Ok(Buffer::from(crate::util::validation_bitset_chunked(
            &items,
            |item| self.validate_doc(item),
            256,
        )))
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
