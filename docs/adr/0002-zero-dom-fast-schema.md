# ADR-0002: Zero-DOM fast path for JSON Schema validation

- **Status**: Accepted (2026-08-07), extended 2026-08-11
- **Deciders**: maintainers (measured via `bun run check`)

## Context

`jsonschema::Validator::is_valid` requires a `serde_json::Value` — a full DOM
per document, measured at ~95% of validation cost. That made the Rust schema
path parity with `ajv` at best, so castrum couldn't match its own zero-DOM
wins (json_valid / json_sum / packed parsers).

## Decision

Implement a **zero-DOM draft-07 fast path** (`rust/json/fast_schema/`) that
compiles the common keyword subset into a `FastNode` AST and validates raw
bytes with a zero-alloc cursor. Unsupported keywords → `compile()` returns
`Err` → the caller falls back to the authoritative `jsonschema` crate (DOM
path). Parity is **byte-for-byte gated** against the crate
(`rust/json/fast_schema/tests.rs`).

Draft-07 is pinned because `jsonschema` 0.48's default draft is 2020-12 whose
`items` / `$ref`-sibling / boolean-exclusive semantics differ; both
`SchemaValidator` and `IngressSchema` build the reference with
`.with_draft(Draft7)` + `should_validate_formats(true)`.

## Consequences

- Fast path: scalar ~1.2–2.4x, batch ~1.0–1.56x vs `ajv` (release build).
- A `$schema` declaring non-draft-07 (or unsupported keywords) still falls
  back — versatility preserved.
- The fast path MUST stay byte-parity with the crate for the supported
  keyword surface; any divergence is a bug.

## See also

- rust/json/fast_schema/tests.rs (parity corpus)
- docs/ARCHITECTURE.md §JSON & schema
