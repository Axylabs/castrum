// rust/ffi/validators.rs — value-returning validators (email / UUID / IPv4 / IPv6).
//
// Two ABI shapes per validator (docs/FFI_BUN_GUIDE.md §3):
//   - `castrum_validate_*`      — `cstring` ARG: the engine transcodes the JS
//     STRING to a call-scoped NUL-terminated UTF-8 buffer in-engine, so the
//     JS side does zero encode work and the callee borrows via `CStr::from_ptr`
//     (no copy). The fast path when the caller holds a JS string.
//   - `castrum_validate_*_bytes` — `(ptr,len)` pair: zero transcode when the
//     caller already holds BYTES (a cstring ARG would force a CString decode
//     in JS and an engine re-encode — measured ~100 ns/call of pure waste;
//     guide rule "cstring args are a LOSS for BYTE inputs").

/// Email / UUID / IPv4 / IPv6 validators → 1/0 (`cstring` ARG shape).
macro_rules! validator_c_abi {
    ($name:ident, $core:path) => {
        #[doc = concat!("Validate input as a ", stringify!($name), " → 1/0.")]
        ///
        /// # Safety
        /// `data` must be a valid NUL-terminated C string.
        #[no_mangle]
        pub unsafe extern "C" fn $name(data: *const std::os::raw::c_char) -> u8 {
            if data.is_null() {
                return 0;
            }
            u8::from($core(std::ffi::CStr::from_ptr(data).to_bytes()))
        }
    };
}

/// Email / UUID / IPv4 / IPv6 validators over raw bytes → 1/0 (`(ptr,len)` shape).
macro_rules! validator_bytes_c_abi {
    ($name:ident, $core:path) => {
        #[doc = concat!("Validate raw bytes as a ", stringify!($name), " → 1/0.")]
        ///
        /// Byte-input sibling of the `cstring`-ARG validator: no NUL
        /// termination required (the length bounds the read), so JS callers
        /// with existing byte buffers skip the decode + engine re-encode.
        ///
        /// # Safety
        /// `data` must be valid for reads of `len` bytes.
        #[no_mangle]
        pub unsafe extern "C" fn $name(data: *const u8, len: usize) -> u8 {
            if data.is_null() && len != 0 {
                return 0;
            }
            let bytes = if len == 0 {
                &[]
            } else {
                std::slice::from_raw_parts(data, len)
            };
            u8::from($core(bytes))
        }
    };
}

validator_c_abi!(
    castrum_validate_email,
    crate::util::validation::validate_email_bytes
);
validator_c_abi!(
    castrum_validate_uuid,
    crate::util::validation::validate_uuid_bytes
);
validator_c_abi!(
    castrum_validate_ipv4,
    crate::util::validation::validate_ipv4_bytes
);
validator_c_abi!(
    castrum_validate_ipv6,
    crate::util::validation::validate_ipv6_bytes
);

validator_bytes_c_abi!(
    castrum_validate_email_bytes,
    crate::util::validation::validate_email_bytes
);
validator_bytes_c_abi!(
    castrum_validate_uuid_bytes,
    crate::util::validation::validate_uuid_bytes
);
validator_bytes_c_abi!(
    castrum_validate_ipv4_bytes,
    crate::util::validation::validate_ipv4_bytes
);
validator_bytes_c_abi!(
    castrum_validate_ipv6_bytes,
    crate::util::validation::validate_ipv6_bytes
);

/// Batch fixed-width hex validation: NEWLINE-separated lines in `data`, one
/// verdict byte (1 = exactly `width` hex chars, 0 = not) per line into `out`.
/// Needed-size convention: `0` = bad width / null pointers (real error);
/// `w > out_cap` = exact required size; else bytes written.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes; `out` for writes up to
/// `out_cap`.
#[no_mangle]
pub unsafe extern "C" fn castrum_hex_validate_batch(
    data: *const u8,
    len: usize,
    width: u32,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if data.is_null() || out.is_null() {
        return 0;
    }
    let input = std::slice::from_raw_parts(data, len);
    let needed = crate::util::validation::hex_batch_count(input);
    if needed > out_cap {
        return needed;
    }
    // `needed` verdict bytes fit — one bounded scratch Vec, one copy out.
    let mut buf = Vec::with_capacity(needed);
    match crate::util::validation::hex_batch_valid_into(input, width as usize, &mut buf) {
        Ok(()) if buf.len() <= out_cap => {
            std::slice::from_raw_parts_mut(out, buf.len()).copy_from_slice(&buf);
            buf.len()
        }
        _ => 0,
    }
}
