//! The ingress HTTP pipeline (napi boundary): the `Ingress` class + entry
//! points (`handle_request_packed`, `handle_request_full_sync{,_into}`) live in
//! the `api` submodule. The core pipeline logic lives in the pure-Rust
//! `pipeline` submodule; see `docs/INGRESS.md` and `docs/REPO_MAP.md` for the
//! two JS-side paths.

// ── Ingress submodules (task-focused split of the former single-file module) ──
//   - api:        the `Ingress` napi class + `IngressInner` state (api.rs)
//   - pipeline:   the core request pipeline — `IngressInner::handle_packed`
//                 + `write_body_sections` + `BodySections` (pipeline.rs)
//   - tests:      unit tests (tests.rs)
//   - options:    JS-facing option structs + Limits
//   - time:       monotonic/wall-clock helpers
//   - packed:     packed-input readers + builder
//   - cors, proxy, ip_trust, rate_limit, terminal, output, ingress_constants:
//     the ingress support modules (moved into this folder from the crate root).
mod api;
mod pipeline;

#[cfg(test)]
mod tests;

pub(crate) mod options;
pub(crate) mod packed;
pub(crate) mod time;

pub(crate) mod cors;
pub mod ingress_constants;
pub(crate) mod ip_trust;
// Per-route native stack (`castrum_route_*` C-ABI + napi `Route` class) —
// the LIVE external wire consumed by `@ignex/native` (route-wire.ts v3).
// Supersedes the deleted `rust/route.rs` (dead external-project wire); see
// the module doc for the contract and the lenient-parse parity rules.
pub mod native_route;
pub(crate) mod output;
pub(crate) mod proxy;
pub(crate) mod rate_limit;
pub(crate) mod terminal;

#[cfg(test)]
pub(crate) use self::api::clamp_output_size;
pub use self::api::Ingress;
pub(crate) use self::api::IngressInner;
pub(crate) use self::native_route::NativeRoute;
pub(crate) use self::options::{IngressOptions, Limits};
#[cfg(test)]
pub(crate) use self::packed::build_packed_input_sync;
pub(crate) use self::pipeline::IngressSchema;
