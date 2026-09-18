// rust/ingress/schema_cache.rs — Process-wide compiled-schema cache.
//
// `Ingress` and `NativeRoute` compile a request-body schema once at
// construction (`IngressSchema::compile`). When an application builds N routes
// over the SAME schema bytes, that is N identical compiles at startup and N
// copies retained at runtime. This module dedupes them: identical schema JSON
// yields ONE shared `Arc<IngressSchema>`, bounded by an LRU (default 128
// entries, override with `CASTRUM_SCHEMA_CACHE_MAX`).
//
// Key = a stable 64-bit hash of the raw serialized schema bytes (exact bytes:
// a different key order is a different key and simply compiles a second time).
// Only SUCCESSFUL compiles are cached. `IngressSchema` is immutable after
// compile (`Arc<jsonschema::Validator>` + optional `Arc<FastNode>`), so sharing
// the `Arc` across routes and threads is sound; mutable state is per-call
// (`Cursor`/`Ctx`), never on the schema.
//
// Concurrency: double-checked locking — the cache lock is released before the
// (slow) compile and re-taken for insert, so one slow compile never serializes
// other schema lookups.

use std::num::NonZeroUsize;
use std::sync::{Arc, OnceLock};

use lru::LruCache;
use parking_lot::Mutex;

use super::pipeline::IngressSchema;

/// Default cache capacity (distinct schema byte strings).
const DEFAULT_SCHEMA_CACHE_MAX: usize = 128;

/// Cache map: schema-hash → shared compiled schema.
type SchemaMap = Mutex<LruCache<u64, Arc<IngressSchema>>>;

/// Process-wide compiled-schema cache (lazily initialized on first compile).
static SCHEMA_CACHE: OnceLock<SchemaMap> = OnceLock::new();

/// Resolve the configured cache capacity (`CASTRUM_SCHEMA_CACHE_MAX`).
///
/// Falls back to [`DEFAULT_SCHEMA_CACHE_MAX`] for an unset, unparseable, or
/// zero value (an LRU needs a nonzero capacity).
fn cache_cap() -> usize {
    std::env::var("CASTRUM_SCHEMA_CACHE_MAX")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_SCHEMA_CACHE_MAX)
}

/// Hash the serialized schema bytes with the crate's XXH3-64 helper (stable and
/// well-distributed). The exact byte string is the identity: serialization
/// preserves key insertion order (`serde_json` is built with `preserve_order`),
/// so whitespace/key-order differences compile separately rather than collide.
#[inline]
fn schema_key(bytes: &[u8]) -> u64 {
    crate::crypto::hashing::fast_hash_bytes(bytes)
}

/// Look up (or compile and insert) the shared `IngressSchema` for
/// `schema_value`. Only successes are cached; a compile error is returned
/// verbatim (identical message to a direct `IngressSchema::compile`).
fn get_or_compile_in(
    cache: &SchemaMap,
    schema_value: &serde_json::Value,
) -> std::result::Result<Arc<IngressSchema>, String> {
    let bytes = serde_json::to_vec(schema_value).map_err(|e| e.to_string())?;
    let key = schema_key(&bytes);

    // Fast path: a hit returns the existing shared Arc.
    if let Some(existing) = cache.lock().get(&key) {
        return Ok(Arc::clone(existing));
    }

    // Miss: compile WITHOUT holding the lock (a slow compile must not block
    // other schema lookups/inserts).
    let compiled = Arc::new(IngressSchema::compile(schema_value)?);

    // Re-check under the lock: a concurrent thread may have compiled the same
    // schema while we were outside it — prefer the first inserter's Arc so all
    // callers share one instance.
    let mut guard = cache.lock();
    if let Some(existing) = guard.get(&key) {
        return Ok(Arc::clone(existing));
    }
    let _ = guard.put(key, Arc::clone(&compiled));
    drop(guard);
    Ok(compiled)
}

/// Return the shared compiled schema for `schema_value`, compiling it on first
/// use. Errors are NOT cached (a fixed schema compiles on the next attempt).
pub(crate) fn get_or_compile(
    schema_value: &serde_json::Value,
) -> std::result::Result<Arc<IngressSchema>, String> {
    let cache = SCHEMA_CACHE.get_or_init(|| {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(cache_cap()).expect("cache cap is nonzero"),
        ))
    });
    get_or_compile_in(cache, schema_value)
}

/// Drop every retained compiled schema. Idempotent and safe to call before
/// any schema has ever been compiled (the cache is then simply uninitialized).
/// Maintenance hook for the public `flushMemory()`.
pub fn clear_schema_cache() {
    if let Some(cache) = SCHEMA_CACHE.get() {
        cache.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local_cache(cap: usize) -> SchemaMap {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(cap).expect("test cap is nonzero"),
        ))
    }

    #[test]
    fn same_schema_bytes_share_one_arc() {
        let cache = local_cache(4);
        let schema = json!({
            "type": "object",
            "required": ["x"],
            "properties": { "x": { "type": "string" } }
        });

        let first = get_or_compile_in(&cache, &schema).unwrap();
        let second = get_or_compile_in(&cache, &schema).unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(cache.lock().len(), 1);
    }

    #[test]
    fn different_schema_bytes_compile_separately() {
        let cache = local_cache(4);
        let object = get_or_compile_in(&cache, &json!({ "type": "object" })).unwrap();
        let string = get_or_compile_in(&cache, &json!({ "type": "string" })).unwrap();

        assert!(!Arc::ptr_eq(&object, &string));
        assert_eq!(cache.lock().len(), 2);
    }

    #[test]
    fn compile_errors_are_not_cached() {
        let cache = local_cache(4);
        // `type` must be a string or array of strings — jsonschema rejects this
        // at build time, so it never reaches the cache.
        let invalid = json!({ "type": 42 });

        assert!(get_or_compile_in(&cache, &invalid).is_err());
        assert_eq!(cache.lock().len(), 0);
    }

    #[test]
    fn cache_is_bounded_by_capacity() {
        let cache = local_cache(2);
        for i in 0..3 {
            let schema = json!({
                "type": "object",
                "properties": { format!("k{i}"): { "type": "string" } }
            });
            get_or_compile_in(&cache, &schema).unwrap();
        }
        assert!(cache.lock().len() <= 2);
    }

    #[test]
    fn clear_empties_the_cache() {
        let cache = local_cache(4);
        let schema = json!({ "type": "object" });
        let first = get_or_compile_in(&cache, &schema).unwrap();

        cache.lock().clear();

        assert_eq!(cache.lock().len(), 0);
        let second = get_or_compile_in(&cache, &schema).unwrap();
        // A cleared cache recompiles: a fresh Arc, not the old shared one.
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn global_get_or_compile_and_clear() {
        // Use a schema unique to this test so parallel tests cannot repopulate
        // the key between the clear and the recompile.
        let schema = json!({
            "type": "object",
            "properties": { "schema_cache_global_probe": { "type": "integer" } }
        });

        clear_schema_cache();
        let first = get_or_compile(&schema).unwrap();
        let again = get_or_compile(&schema).unwrap();
        assert!(Arc::ptr_eq(&first, &again));

        clear_schema_cache();
        let recompiled = get_or_compile(&schema).unwrap();
        assert!(!Arc::ptr_eq(&first, &recompiled));
    }
}
