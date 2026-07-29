use std::sync::Arc;
pub struct SchemaValidator {
    inner: Option<Arc<jsonschema::Validator>>,
}
impl SchemaValidator {
    pub fn new(schema: &[u8]) -> Result<Self, String> {
        let schema_str = std::str::from_utf8(schema).map_err(|e| e.to_string())?;
        let value: serde_json::Value = sonic_rs::from_str(schema_str).map_err(|e| e.to_string())?;
        let validator = jsonschema::validator_for(&value).map_err(|e| e.to_string())?;
        Ok(Self { inner: Some(Arc::new(validator)) })
    }
    pub fn is_valid(&self, data: &[u8]) -> bool {
        self.inner.as_ref().map_or(false, |v| {
            sonic_rs::from_slice::<serde_json::Value>(data)
                .ok()
                .map_or(false, |doc| v.is_valid(&doc))
        })
    }
    pub fn validate_batch_packed_count(&self, packed: &[u8]) -> u32 { 0 }
    pub fn validate_batch_packed_bitset(&self, packed: &[u8]) -> Vec<u8> { vec![] }
}
