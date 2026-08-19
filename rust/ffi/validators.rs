// rust/ffi/validators.rs — value-returning validators (email / UUID / IPv4 / IPv6).
//
// The input is a `bun:ffi` `cstring` ARG: the engine transcodes the JS string
// to a call-scoped NUL-terminated UTF-8 buffer in-engine, so the JS side does
// zero `encoder.encode` work and the callee borrows via `CStr::from_ptr` (no
// copy). Only text inputs (never NUL-containing) are valid — see the
// `cstring`-arg rule in docs/FFI_BUN_GUIDE.md.

/// Email / UUID / IPv4 / IPv6 validators → 1/0.
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
