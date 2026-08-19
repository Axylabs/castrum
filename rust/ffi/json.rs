// rust/ffi/json.rs — JSON C-ABI exports.
//
// RFC 6902 JSON patch, the packed JSON token stream (`castrum_json_parse_packed`),
// schema validation, and template rendering (opaque-handle paths).

use rustc_hash::FxHashMap;
use std::slice;

use super::util::panic_guard;

/// RFC 6902 JSON patch → patched doc into `out` (0 on invalid/inapplicable).
///
/// # Safety
/// `doc`/`patch` must be valid for reads of their lengths; `out` for `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_patch(
    doc: *const u8,
    dlen: usize,
    patch: *const u8,
    plen: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if doc.is_null() || patch.is_null() || out.is_null() {
        return 0;
    }
    // Wrap in panic_guard: a panic in the patch engine must not unwind through
    // the C ABI (process crash) — it becomes 0 (invalid input) instead.
    let Some(patched) = panic_guard(
        || {
            crate::json::patch::apply_json_patch_bytes(
                slice::from_raw_parts(doc, dlen),
                slice::from_raw_parts(patch, plen),
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if patched.len() > out_cap {
        // Needed-size convention (see compress_to_out!): exact retry, no re-run.
        return patched.len();
    }
    slice::from_raw_parts_mut(out, patched.len()).copy_from_slice(&patched);
    patched.len()
}

// ── Packed JSON token stream (structural parse, no re-parse) ────────
// `castrum_json_parse_packed` parses ONCE with sonic-rs and emits a typed
// token stream with a DEDUPLICATED string table. The JS side assembles the
// value directly from the tokens — it never re-parses JSON text, and repeated
// keys/values are decoded exactly once (the old cstring path re-serialized the
// whole doc to text and `JSON.parse`d it again, measured 3.92x slower than
// Bun's JSON.parse on the 5k-row fixture).
//
// Layout: `[u32 strCount]{[u32 len][utf8 bytes]}... [u32 treeLen][tree]`
// The tree is a single value encoded as a start/end-marker token stream
// (little-endian; no counts — the sonic-rs SeqAccess/MapAccess expose no
// size_hint, and markers let JS decode iteratively with `push`/`pop`):
//   0 = null | 1 = false | 2 = true | 3 = number (f64 LE, 8 bytes)
//   4 = string (u32 index into the string table)
//   5 = array start | 6 = object start
//   7 = array end | 8 = object end
//   9 = object key (u32 index into the string table)
// Object body: `6, (9, keyIdx, value)*, 8`.

const JSON_PACKED_NULL: u8 = 0;
const JSON_PACKED_FALSE: u8 = 1;
const JSON_PACKED_TRUE: u8 = 2;
const JSON_PACKED_NUMBER: u8 = 3;
const JSON_PACKED_STRING: u8 = 4;
const JSON_PACKED_ARRAY_START: u8 = 5;
const JSON_PACKED_OBJECT_START: u8 = 6;
const JSON_PACKED_ARRAY_END: u8 = 7;
const JSON_PACKED_OBJECT_END: u8 = 8;
const JSON_PACKED_KEY: u8 = 9;

/// Single-pass emitter. sonic-rs's fast parser drives this via serde, writing
/// the packed token stream DIRECTLY — there is NO intermediate `sonic_rs::Value`
/// DOM (building it measured ~1.0ms for the 5k-row fixture). Strings (keys +
/// values) are interned into a deduplicated table keyed by OWNED bytes
/// (`Vec<u8>`) so escaped strings work uniformly; lookups borrow (`get(&[u8])`)
/// without allocating. `FxHashMap` (rustc-hash) is used because default SipHash
/// is slow on short keys (same choice fast_schema makes); a hash collision only
/// costs an extra byte compare, never a wrong index. Dedup keeps the JS-side
/// decode to ~1 decode per unique string (a per-occurrence blob was ~10x worse
/// on the JS side due to rope-slicing).
pub(crate) struct JsonPackedEmitter {
    strings: FxHashMap<Vec<u8>, u32>,
    table: Vec<u8>,
    tree: Vec<u8>,
}

impl JsonPackedEmitter {
    #[inline]
    fn intern(&mut self, bytes: &[u8]) -> u32 {
        if let Some(&idx) = self.strings.get(bytes) {
            return idx;
        }
        let idx = self.strings.len() as u32;
        self.strings.insert(bytes.to_vec(), idx);
        self.table
            .extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        self.table.extend_from_slice(bytes);
        idx
    }

    #[inline]
    fn emit_u32(&mut self, v: u32) {
        self.tree.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    fn emit_string(&mut self, s: &str) {
        self.tree.push(JSON_PACKED_STRING);
        let idx = self.intern(s.as_bytes());
        self.emit_u32(idx);
    }

    #[inline]
    fn emit_key(&mut self, s: &str) {
        self.tree.push(JSON_PACKED_KEY);
        let idx = self.intern(s.as_bytes());
        self.emit_u32(idx);
    }

    #[inline]
    fn emit_number(&mut self, f: f64) {
        self.tree.push(JSON_PACKED_NUMBER);
        self.tree.extend_from_slice(&f.to_le_bytes());
    }
}

/// Seed that deserializes any nested value through the shared emitter.
struct JsonPackedSeed<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::DeserializeSeed<'de> for JsonPackedSeed<'_> {
    type Value = ();

    #[inline]
    fn deserialize<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_any(JsonPackedVisitor { out: self.out })
    }
}

/// Seed for object KEYS (always JSON strings).
struct JsonPackedKeySeed<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::DeserializeSeed<'de> for JsonPackedKeySeed<'_> {
    type Value = ();

    #[inline]
    fn deserialize<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_str(JsonPackedKeyVisitor { out: self.out })
    }
}

struct JsonPackedKeyVisitor<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::Visitor<'de> for JsonPackedKeyVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an object key")
    }

    #[inline]
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_key(v);
        Ok(())
    }

    #[inline]
    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_str(v)
    }

    #[inline]
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.visit_str(v.as_str())
    }
}

struct JsonPackedVisitor<'a> {
    out: &'a mut JsonPackedEmitter,
}

impl<'de> serde::de::Visitor<'de> for JsonPackedVisitor<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("any JSON value")
    }

    #[inline]
    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out
            .tree
            .push(if v { JSON_PACKED_TRUE } else { JSON_PACKED_FALSE });
        Ok(())
    }

    #[inline]
    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        // f64 = JS number semantics (the napi serde_json::Value path rounds the
        // same way JSON.parse does).
        self.out.emit_number(v as f64);
        Ok(())
    }

    #[inline]
    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_number(v as f64);
        Ok(())
    }

    #[inline]
    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_number(v);
        Ok(())
    }

    #[inline]
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v);
        Ok(())
    }

    #[inline]
    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v);
        Ok(())
    }

    #[inline]
    fn visit_string<E>(self, v: String) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.emit_string(v.as_str());
        Ok(())
    }

    #[inline]
    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.tree.push(JSON_PACKED_NULL);
        Ok(())
    }

    #[inline]
    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        self.out.tree.push(JSON_PACKED_NULL);
        Ok(())
    }

    #[inline]
    fn visit_some<D>(self, d: D) -> Result<Self::Value, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        d.deserialize_any(self)
    }

    #[inline]
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        self.out.tree.push(JSON_PACKED_ARRAY_START);
        while let Some(()) = seq.next_element_seed(JsonPackedSeed { out: &mut *self.out })? {}
        self.out.tree.push(JSON_PACKED_ARRAY_END);
        Ok(())
    }

    #[inline]
    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        self.out.tree.push(JSON_PACKED_OBJECT_START);
        while let Some(()) = map.next_key_seed(JsonPackedKeySeed { out: &mut *self.out })? {
            map.next_value_seed(JsonPackedSeed { out: &mut *self.out })?;
        }
        self.out.tree.push(JSON_PACKED_OBJECT_END);
        Ok(())
    }
}

impl<'de> serde::Deserialize<'de> for JsonPackedEmitter {
    #[inline]
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        let mut out = JsonPackedEmitter {
            strings: FxHashMap::default(),
            table: Vec::new(),
            tree: Vec::new(),
        };
        d.deserialize_any(JsonPackedVisitor { out: &mut out })?;
        Ok(out)
    }
}

/// Parse JSON → packed token stream (see the layout above). Needed-size
/// convention: `0` = invalid JSON (real error → JS throws); `w > out_cap` =
/// exact required size (JS allocates once and retries); else bytes written.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for `out_cap` writes.
#[no_mangle]
pub unsafe extern "C" fn castrum_json_parse_packed(
    data: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = slice::from_raw_parts(data, len);
    let Some(emitter) = panic_guard(|| sonic_rs::from_slice::<JsonPackedEmitter>(input).ok(), None)
    else {
        return 0;
    };
    // Write the packed [u32 stringsLen][table][u32 treeLen][tree] directly
    // into the caller's buffer — no intermediate Vec + second copy.
    let needed = 4 + emitter.table.len() + 4 + emitter.tree.len();
    if needed > out_cap {
        return needed;
    }
    let out = slice::from_raw_parts_mut(out, needed);
    let mut wp = 0usize;
    out[wp..wp + 4].copy_from_slice(&(emitter.strings.len() as u32).to_le_bytes());
    wp += 4;
    out[wp..wp + emitter.table.len()].copy_from_slice(&emitter.table);
    wp += emitter.table.len();
    out[wp..wp + 4].copy_from_slice(&(emitter.tree.len() as u32).to_le_bytes());
    wp += 4;
    out[wp..wp + emitter.tree.len()].copy_from_slice(&emitter.tree);
    wp += emitter.tree.len();
    wp
}

/// SchemaValidator: validate a document against the COMPILED schema via its
/// opaque inner handle. Returns 1 = valid. A null handle (0) → 0.
///
/// # Safety
/// `inner` must be a valid `SchemaValidator` pointer from `inner_ptr()`, alive
/// for the call.
#[no_mangle]
pub unsafe extern "C" fn castrum_schema_validator_validate(
    inner: usize,
    doc: *const u8,
    doc_len: usize,
) -> u8 {
    if inner == 0 || doc.is_null() {
        return 0;
    }
    let d = slice::from_raw_parts(doc, doc_len);
    panic_guard(
        || {
            u8::from(unsafe {
                crate::json::json_schema::schema_validator_validate_core(
                    inner as *const crate::json::json_schema::SchemaValidator,
                    d,
                )
            })
        },
        0,
    )
}

/// TemplateRenderer: render the compiled template with a pre-serialized JSON
/// context via its opaque inner handle. Needed-size convention; 0 = invalid
/// context / render error / null handle (real error).
///
/// # Safety
/// `inner` must be a valid `TemplateRenderer` pointer from `inner_ptr()`, alive
/// for the call; `out` for writes up to `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_template_render(
    inner: usize,
    context: *const u8,
    context_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if inner == 0 || context.is_null() || out.is_null() {
        return 0;
    }
    let c = slice::from_raw_parts(context, context_len);
    let Some(rendered) = panic_guard(
        || unsafe {
            crate::payload::template::template_render_core(
                inner as *const crate::payload::template::TemplateRenderer,
                c,
            )
            .ok()
        },
        None,
    ) else {
        return 0;
    };
    if rendered.len() > out_cap {
        return rendered.len();
    }
    slice::from_raw_parts_mut(out, rendered.len()).copy_from_slice(&rendered);
    rendered.len()
}
