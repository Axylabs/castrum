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
// The hash only selects a bucket — it is NOT the identity: each entry stores
// its serialized bytes alongside the compiled schema, and a hit is returned
// only when those bytes EQUAL the requested bytes. `xxh3_64` is
// non-cryptographic, so trusting the hash alone would let a craftable collision
// reuse the wrong validator (a validation-bypass class bug); the byte compare
// makes collisions a safe miss (compile + replace the colliding bucket) rather
// than a wrong-schema hit.
//
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
/// Upper clamp on the configured capacity — an absurd env value must not size
/// an unbounded LRU (each entry retains a compiled validator + its bytes).
const MAX_SCHEMA_CACHE_MAX: usize = 4096;

/// Cache entry: the exact serialized schema bytes (collision disambiguation)
/// plus the shared compiled schema.
type CacheEntry = (Vec<u8>, Arc<IngressSchema>);

/// Cache map: schema-hash → (schema bytes, shared compiled schema).
type SchemaMap = Mutex<LruCache<u64, CacheEntry>>;

/// Process-wide compiled-schema cache (lazily initialized on first compile).
static SCHEMA_CACHE: OnceLock<SchemaMap> = OnceLock::new();

/// Resolve a capacity from the raw env value: unset/unparseable/zero →
/// [`DEFAULT_SCHEMA_CACHE_MAX`], otherwise clamped to
/// `1..=MAX_SCHEMA_CACHE_MAX` (an LRU needs a nonzero capacity).
fn resolve_cap(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .map(|n| n.min(MAX_SCHEMA_CACHE_MAX))
        .unwrap_or(DEFAULT_SCHEMA_CACHE_MAX)
}

/// Resolve the configured cache capacity (`CASTRUM_SCHEMA_CACHE_MAX`).
fn cache_cap() -> usize {
    resolve_cap(std::env::var("CASTRUM_SCHEMA_CACHE_MAX").ok().as_deref())
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

    // Fast path: a hash hit is only trusted when the bytes MATCH (a colliding
    // hash falls through to a real compile, never a wrong-schema hit).
    if let Some((stored, existing)) = cache.lock().get(&key) {
        if stored.as_slice() == bytes.as_slice() {
            return Ok(Arc::clone(existing));
        }
    }

    // Miss: compile WITHOUT holding the lock (a slow compile must not block
    // other schema lookups/inserts).
    let compiled = Arc::new(IngressSchema::compile(schema_value)?);

    // Re-check under the lock: a concurrent thread may have compiled the same
    // schema while we were outside it — prefer the first inserter's Arc (same
    // bytes) so all callers share one instance. A colliding entry with
    // different bytes is REPLACED (the bucket holds exactly one schema).
    let mut guard = cache.lock();
    if let Some((stored, existing)) = guard.get(&key) {
        if stored.as_slice() == bytes.as_slice() {
            return Ok(Arc::clone(existing));
        }
    }
    let _ = guard.put(key, (bytes, Arc::clone(&compiled)));
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
    fn cap_defaults_clamps_and_rejects_bad_values() {
        assert_eq!(resolve_cap(None), DEFAULT_SCHEMA_CACHE_MAX);
        assert_eq!(resolve_cap(Some("")), DEFAULT_SCHEMA_CACHE_MAX);
        assert_eq!(resolve_cap(Some("abc")), DEFAULT_SCHEMA_CACHE_MAX);
        assert_eq!(resolve_cap(Some("0")), DEFAULT_SCHEMA_CACHE_MAX);
        assert_eq!(resolve_cap(Some("256")), 256);
        assert_eq!(resolve_cap(Some(" 64 ")), 64);
        // Absurd values are clamped so the LRU cannot be sized unboundedly.
        assert_eq!(resolve_cap(Some("999999999")), MAX_SCHEMA_CACHE_MAX);
    }

    #[test]
    fn hash_collision_returns_the_correct_schema() {
        let cache = local_cache(4);
        let schema_a = json!({ "type": "object", "required": ["a"] });
        let schema_b = json!({ "type": "object", "required": ["b"] });
        let bytes_b = serde_json::to_vec(&schema_b).unwrap();
        let key_b = schema_key(&bytes_b);

        // Simulate an xxh3 collision: an entry under B's key that actually holds
        // A's bytes + compiled validator. Under a hash-only cache this would be
        // returned for B (wrong-schema validation bypass).
        let a = get_or_compile_in(&cache, &schema_a).unwrap();
        let bytes_a = serde_json::to_vec(&schema_a).unwrap();
        let _ = cache.lock().put(key_b, (bytes_a, Arc::clone(&a)));

        // The byte compare must reject the collision and compile the REAL B.
        let b = get_or_compile_in(&cache, &schema_b).unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
        assert!(b.validate(br#"{"b":1}"#));
        assert!(!b.validate(br#"{"a":1}"#));
        // A itself still resolves correctly (its own bucket is intact).
        let a_again = get_or_compile_in(&cache, &schema_a).unwrap();
        assert!(Arc::ptr_eq(&a, &a_again));
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
