// rust/ffi/route.rs — per-route native stack C-ABI exports (`castrum_route_*`).
//
// The live external wire consumed by `@ignex/native` (`createNativeRoute` →
// `route-wire.ts` v3): a route descriptor compiles ONCE into a pre-baked
// `NativeRoute` (rust/ingress/native_route.rs), then each request packs a tiny
// frame and gets a packed verdict in one call. The handle is an owned
// `Box<NativeRoute>` (opaque u64); `route_run` follows the needed-size
// convention (`0` = real error, `> out_cap` = exact required size) so the JS
// wrapper allocates once and retries at most once. All three are `panic_guard`ed
// — a panic must never unwind through the C ABI.

use std::slice;

use super::util::panic_guard;

/// Compile a route descriptor into an opaque handle (`0` = failure / null
/// input / panic). The handle is an owned `Box<NativeRoute>`; release it with
/// {@link castrum_route_destroy}.
///
/// # Safety
/// `desc` must be valid for reads of `desc_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_compile(desc: *const u8, desc_len: usize) -> u64 {
    if desc.is_null() {
        return 0;
    }
    let bytes = slice::from_raw_parts(desc, desc_len);
    panic_guard(
        || match crate::ingress::NativeRoute::compile(bytes) {
            Ok(route) => Box::into_raw(Box::new(route)) as u64,
            Err(_) => 0,
        },
        0,
    )
}

/// Run a compiled route on one request frame, writing the packed verdict into
/// `out`. Returns bytes written (`0` = real error / malformed frame / panic;
/// `> out_cap` = the EXACT required size — allocate once and retry).
///
/// # Safety
/// `handle` must be a live handle from {@link castrum_route_compile} (not yet
/// destroyed); `frame` valid for `frame_len` reads; `out` valid for `out_cap`
/// writes. The route is immutable (`&self`, no interior mutability), so
/// concurrent calls from multiple worker threads are safe.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_run(
    handle: u64,
    frame: *const u8,
    frame_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if handle == 0 || frame.is_null() || out.is_null() {
        return 0;
    }
    let route: &crate::ingress::NativeRoute = &*(handle as *const crate::ingress::NativeRoute);
    let frame_slice = slice::from_raw_parts(frame, frame_len);
    let out_slice = slice::from_raw_parts_mut(out, out_cap);
    // Aliasing insurance (mirrors castrum_ingress_handle_packed): a pooled
    // frame that overlaps `out` must be copied before the shared &/&mut borrow
    // pair (aliased &/&mut is instant UB). The JS wrapper uses distinct pooled
    // buffers, so this is a rare defensive copy.
    let owned_frame;
    let frame_ref: &[u8] = if crate::util::slices_overlap(frame_slice, out_slice) {
        owned_frame = frame_slice.to_vec();
        &owned_frame
    } else {
        frame_slice
    };
    panic_guard(|| route.run(frame_ref, out_slice).unwrap_or(0), 0)
}

/// Destroy a compiled route handle (frees the `Box<NativeRoute>`). A null
/// handle is a no-op; double-destroy is UB and must not be called.
///
/// # Safety
/// `handle` must come from {@link castrum_route_compile} and be destroyed at
/// most once.
#[no_mangle]
pub unsafe extern "C" fn castrum_route_destroy(handle: u64) {
    if handle != 0 {
        drop(Box::from_raw(handle as *mut crate::ingress::NativeRoute));
    }
}
