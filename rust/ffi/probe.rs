// rust/ffi/probe.rs — diagnostic C-ABI probes (bench-only, NOT in the ffi.ts surface).
//
// Used ONLY by bench/ffi-margin.ts to isolate the fixed per-call FFI cost into
// its components: the bare trampoline (noop), scalar-arg/return conversion
// (echo_usize, which can be bound with either `usize` or `u64_fast` to measure
// BigInt boxing in isolation), TypedArray-view→pointer resolution
// (echo_view), and `cstring`-ARG transcoding (echo_cstr — the engine encodes
// the JS string to a call-scoped NUL-terminated buffer; the callee borrows it
// via `CStr::from_ptr`, never dereferencing beyond NUL). They are trivial,
// non-fallible, allocate nothing, and are NOT part of the shipped
// `src/native/ffi.ts` dlopen map, so the bind-time self-test does not cover
// them. The `ffi_probe_*` prefix (NOT `castrum_*`) keeps them out of the
// shipped-symbol namespace so the source-level symbol-parity guard
// (test/unit/features/ffi-symbol-parity.test.ts) stays meaningful.

use std::slice;

/// Bare C-ABI trampoline floor: does nothing, returns nothing.
#[no_mangle]
pub extern "C" fn ffi_probe_noop() {}

/// Scalar pass-through: returns `v` unchanged. Measures scalar-arg + return
/// conversion only (bind with `usize` vs `u64_fast` to isolate BigInt boxing).
#[no_mangle]
pub extern "C" fn ffi_probe_echo_usize(v: usize) -> usize {
    v
}

/// View pass-through: returns the byte length of the `(ptr, len)` pair.
/// Measures TypedArray-view→pointer resolution + (ptr,len) arg conversion.
///
/// # Safety
/// `data` must be valid for reads of `len` bytes (the pointer is only used to
/// form a slice whose length we return — never dereferenced).
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_view(data: *const u8, len: usize) -> usize {
    if data.is_null() && len != 0 {
        return 0;
    }
    let _ = slice::from_raw_parts(data, len);
    len
}

/// `cstring`-ARG pass-through: returns the byte length of the NUL-terminated
/// C string the engine produced by transcoding a JS string arg. Measures the
/// engine-side JS-string→UTF-8 transcode + call-scoped buffer + callee
/// `CStr::from_ptr` borrow — the cost a `'cstring'` input arg adds compared
/// with a JS-side `encoder.encode` + `(ptr,len)` pair. The pointer is only
/// used to form a slice whose length we return — never dereferenced beyond
/// NUL.
///
/// # Safety
/// `data` must be a valid NUL-terminated C string for reads up to its terminator.
#[no_mangle]
pub unsafe extern "C" fn ffi_probe_echo_cstr(data: *const std::os::raw::c_char) -> usize {
    if data.is_null() {
        return 0;
    }
    std::ffi::CStr::from_ptr(data).to_bytes().len()
}
