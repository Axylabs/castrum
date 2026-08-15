//! sonic-rs → JS value marshaling + jsonschema-compatible equality.
//!
//! `serde_json::Value` DOMs are being replaced with `sonic_rs::Value` (compact
//! 16-byte tagged nodes, borrowed/inline strings, zero per-key heap `String`)
//! across the crate. The napi `serde-json` feature only marshals
//! `serde_json::Value` to JS, so this module supplies the hand-written
//! equivalent for `sonic_rs::Value`:
//!
//! - [`sonic_value_to_js`] walks a `sonic_rs::Value` directly into a JS value
//!   (no `serde_json::Value` intermediate, no generic serde trait dispatch).
//!   Number handling is byte-parity with the napi `serde-json` `ToNapiValue
//!   for serde_json::Number`: `PosInt` u64 ≤ u32::MAX → **Number**, larger →
//!   **BigInt**; `NegInt` i64 within ±2^53-1 → **Number**, outside → **BigInt**;
//!   `Float` → **Number** (see [`sonic_number_to_js`]).
//! - [`sonic_values_equal`] replicates jsonschema's `cmp::equal` (exact
//!   cross-type numeric equality via `num_cmp`, insertion-order object keys)
//!   for the fast_schema enum/const/uniqueItems paths.
//!
//! This module is napi-type-laden by design (it bridges to JS); pure numeric /
//! equality logic stays in the small private fns below and is unit-tested.

use napi::bindgen_prelude::{BigInt, Env, FromNapiValue, Null, Object, Result, ToNapiValue, Unknown};
use sonic_rs::JsonNumberTrait;

/// Wrap a `ToNapiValue` as an unconstrained-lifetime `Unknown`.
///
/// `Unknown<'env>` cannot borrow from the `Env` function parameter (that local
/// borrow can't escape the call), so we build the raw `napi_value` and re-wrap
/// via `Unknown::from_napi_value(env.raw(), …)` — the raw `napi_env`/`napi_value`
/// are Copy pointers rooted by the caller's handle scope, so the `'static`
/// phantom is nominal (the same pattern napi-rs uses for
/// `#[napi] fn(env: Env) -> Result<Unknown>`).
#[inline]
fn to_unknown(env: &Env, v: impl ToNapiValue) -> Result<Unknown<'static>> {
    // Safety: `env.raw()` is a valid napi_env for the call, and `v`'s JS value
    // is rooted in the caller's handle scope.
    let raw = unsafe { ToNapiValue::to_napi_value(env.raw(), v) }?;
    // Safety: same env + the just-created value are valid.
    unsafe { Unknown::from_napi_value(env.raw(), raw) }
}

/// Marshal a `sonic_rs::Value` into a JS value.
///
/// The returned JS value is fully independent of `value` (napi builds new
/// primitives/containers), so `value` may borrow from a caller buffer that is
/// released after the call.
pub(crate) fn sonic_value_to_js(env: &Env, value: &sonic_rs::Value) -> Result<Unknown<'static>> {
    match value.as_ref() {
        sonic_rs::value::ValueRef::Null => to_unknown(env, Null),
        sonic_rs::value::ValueRef::Bool(b) => to_unknown(env, b),
        sonic_rs::value::ValueRef::Number(n) => sonic_number_to_js(env, &n),
        sonic_rs::value::ValueRef::String(s) => to_unknown(env, env.create_string(s)?),
        sonic_rs::value::ValueRef::Array(arr) => {
            let mut out = env.create_array(arr.len() as u32)?;
            for (i, item) in arr.into_iter().enumerate() {
                out.set(i as u32, sonic_value_to_js(env, item)?)?;
            }
            to_unknown(env, out)
        }
        sonic_rs::value::ValueRef::Object(obj) => {
            let mut out = Object::new(env)?;
            for (k, v) in obj.iter() {
                out.set(k, sonic_value_to_js(env, v)?)?;
            }
            to_unknown(env, out)
        }
    }
}

/// Marshal a sonic `Number` to JS with **exact** parity to the napi
/// `serde-json` `ToNapiValue for serde_json::Number` (the behavior the old
/// `serde_json::Value` returns produced):
/// - PosInt (u64): `> u32::MAX` → **BigInt**, else → **Number** (the napi
///   serde-json impl routes u64 ≤ u32::MAX through `u32::to_napi_value`).
/// - NegInt (i64): outside ±2^53-1 (`MAX_SAFE_INT`) → **BigInt**, else →
///   **Number**.
/// - Float: **Number**.
///
/// `as_u64` is checked first so `PosInt` mirrors serde_json's u64-backed
/// `Number` (a positive integer that also fits i64 must still take the u64
/// branch — e.g. `3_000_000_000` is BigInt in serde_json, not Number).
fn sonic_number_to_js(env: &Env, n: &sonic_rs::Number) -> Result<Unknown<'static>> {
    const MAX_SAFE_INT: i64 = 9007199254740991; // 2^53 - 1 (napi `napi6` guard)
    if let Some(u) = n.as_u64() {
        if u > u32::MAX as u64 {
            to_unknown(env, BigInt::from(u))
        } else {
            to_unknown(env, u as u32)
        }
    } else if let Some(i) = n.as_i64() {
        if !(-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i) {
            to_unknown(env, BigInt::from(i))
        } else {
            to_unknown(env, i)
        }
    } else if let Some(f) = n.as_f64() {
        to_unknown(env, f)
    } else {
        // Unreachable for a parsed JSON number (all three are mutually
        // exhaustive over PosInt/NegInt/Float); defensive fallback.
        to_unknown(env, Null)
    }
}

/// JSON value equality replicating jsonschema's `cmp::equal` (exact across
/// u64/i64/f64 via `num_cmp`, insertion-order object keys). This is the sonic
/// `Value` twin of the serde_json `values_equal` in fast_schema/validate.rs —
/// keep the two semantically identical (the fast path must stay byte-parity
/// with the jsonschema crate).
pub(crate) fn sonic_values_equal(a: &sonic_rs::Value, b: &sonic_rs::Value) -> bool {
    use sonic_rs::value::ValueRef;
    match (a.as_ref(), b.as_ref()) {
        (ValueRef::Null, ValueRef::Null) => true,
        (ValueRef::Bool(x), ValueRef::Bool(y)) => x == y,
        (ValueRef::Number(x), ValueRef::Number(y)) => sonic_numbers_equal(&x, &y),
        (ValueRef::String(x), ValueRef::String(y)) => x == y,
        (ValueRef::Array(x), ValueRef::Array(y)) => {
            x.len() == y.len()
                && x.iter().zip(y.iter()).all(|(a, b)| sonic_values_equal(a, b))
        }
        (ValueRef::Object(x), ValueRef::Object(y)) => {
            // Insertion-order comparison, replicating jsonschema's cmp::equal
            // (key order is SIGNIFICANT in the crate's object equality).
            x.len() == y.len()
                && x
                    .iter()
                    .zip(y.iter())
                    .all(|((ka, va), (kb, vb))| ka == kb && sonic_values_equal(va, vb))
        }
        _ => false,
    }
}

/// Exact cross-representation number equality (num_cmp semantics, matching
/// jsonschema's `equal_numbers` without arbitrary-precision).
fn sonic_numbers_equal(a: &sonic_rs::Number, b: &sonic_rs::Number) -> bool {
    use num_cmp::NumCmp;
    if let Some(x) = a.as_u64() {
        if let Some(y) = b.as_u64() {
            return x == y;
        }
        if let Some(y) = b.as_i64() {
            return y >= 0 && x == y as u64;
        }
        return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
    }
    if let Some(x) = a.as_i64() {
        if let Some(y) = b.as_i64() {
            return x == y;
        }
        if let Some(y) = b.as_u64() {
            return x >= 0 && y == x as u64;
        }
        return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
    }
    if let Some(x) = a.as_f64() {
        if let Some(y) = b.as_f64() {
            return x == y;
        }
        if let Some(y) = b.as_u64() {
            return x.num_eq(y);
        }
        if let Some(y) = b.as_i64() {
            return x.num_eq(y);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Round-trip a serde_json Value through JSON bytes into a sonic Value.
    fn to_sonic(sv: &serde_json::Value) -> sonic_rs::Value {
        sonic_rs::from_slice::<sonic_rs::Value>(&serde_json::to_vec(sv).unwrap()).unwrap()
    }

    /// The serde_json reference implementation this port must match.
    fn serde_values_equal(a: &serde_json::Value, b: &serde_json::Value) -> bool {
        match (a, b) {
            (serde_json::Value::Null, serde_json::Value::Null) => true,
            (serde_json::Value::Bool(x), serde_json::Value::Bool(y)) => x == y,
            (serde_json::Value::Number(x), serde_json::Value::Number(y)) => {
                serde_numbers_equal(x, y)
            }
            (serde_json::Value::String(x), serde_json::Value::String(y)) => x == y,
            (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| serde_values_equal(a, b))
            }
            (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
                x.len() == y.len()
                    && x
                        .iter()
                        .zip(y.iter())
                        .all(|((ka, va), (kb, vb))| ka == kb && serde_values_equal(va, vb))
            }
            _ => false,
        }
    }

    fn serde_numbers_equal(a: &serde_json::Number, b: &serde_json::Number) -> bool {
        use num_cmp::NumCmp;
        if let Some(x) = a.as_u64() {
            if let Some(y) = b.as_u64() {
                return x == y;
            }
            if let Some(y) = b.as_i64() {
                return y >= 0 && x == y as u64;
            }
            return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
        }
        if let Some(x) = a.as_i64() {
            if let Some(y) = b.as_i64() {
                return x == y;
            }
            if let Some(y) = b.as_u64() {
                return x >= 0 && y == x as u64;
            }
            return x.num_eq(b.as_f64().unwrap_or(f64::NAN));
        }
        if let Some(x) = a.as_f64() {
            if let Some(y) = b.as_f64() {
                return x == y;
            }
            if let Some(y) = b.as_u64() {
                return x.num_eq(y);
            }
            if let Some(y) = b.as_i64() {
                return x.num_eq(y);
            }
        }
        false
    }

    fn corpus() -> Vec<serde_json::Value> {
        vec![
            json!(null),
            json!(true),
            json!(false),
            json!(0),
            json!(1),
            json!(-1),
            json!(i64::MAX),
            json!(i64::MIN),
            json!(u64::MAX),
            json!(1.5),
            json!(-2.25),
            json!(0.0),
            json!(1e300),
            json!(""),
            json!("hello"),
            json!("héllo wörld 😀"),
            json!(r#"escaped "quotes" \n \u0041"#),
            json!([]),
            json!([1, "two", true, null, [3.5], {"k": "v"}]),
            json!({"a": 1, "b": [1, 2, 3], "c": {"d": null, "e": "x"}}),
        ]
    }

    #[test]
    fn sonic_values_equal_matches_serde_reference() {
        let c = corpus();
        for a in &c {
            for b in &c {
                let sa = to_sonic(a);
                let sb = to_sonic(b);
                let sonic = sonic_values_equal(&sa, &sb);
                let serde = serde_values_equal(a, b);
                assert_eq!(
                    sonic, serde,
                    "mismatch: {a} vs {b} (sonic={sonic}, serde={serde})"
                );
            }
        }
    }

    #[test]
    fn numeric_cross_type_equality() {
        // 1 == 1.0 across representations (jsonschema cmp::equal).
        let one_int: serde_json::Value = json!(1);
        let one_float: serde_json::Value = json!(1.0);
        assert!(sonic_values_equal(&to_sonic(&one_int), &to_sonic(&one_float)));

        // u64 that exceeds i64::MAX is NOT equal to its wrapped i64.
        let big: serde_json::Value = json!(u64::MAX);
        let neg: serde_json::Value = json!(-1);
        assert!(!sonic_values_equal(&to_sonic(&big), &to_sonic(&neg)));

        // Exact fractional equality (1.5 != 1.5000000000000001 differs).
        let a: serde_json::Value = json!(1.5);
        let b: serde_json::Value = json!(1.5000000000000002);
        assert!(!sonic_values_equal(&to_sonic(&a), &to_sonic(&b)));

        // String vs number never equal.
        assert!(!sonic_values_equal(&to_sonic(&json!("1")), &to_sonic(&json!(1))));
    }

    #[test]
    fn object_key_order_is_significant() {
        let a = json!({"a": 1, "b": 2});
        let b = json!({"b": 2, "a": 1});
        assert!(sonic_values_equal(&to_sonic(&a), &to_sonic(&a)));
        assert!(!sonic_values_equal(&to_sonic(&a), &to_sonic(&b)));
    }
}
