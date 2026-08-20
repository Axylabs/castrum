# ADR-0001: The two ingress wire formats are a contract, not a bug

- **Status**: Accepted (2026-08-06)
- **Deciders**: maintainers (via benchmark + hardening passes)

## Context

The ingress layer ships two paths that consume the SAME native core
(`handleRequestPacked`):

1. `src/ingress/fast.ts` — `createIngressFast`; JS packs headers via
   `IngressInputPacker`; errors are `{"error":{code,status,message,requestId}}`
   with `x-ratelimit-*` headers.
2. `src/ingress/handlers.ts` — `createIngressHandler`; JS packs the full frame;
   success is Rust-generated `{"ok":true,...,"requestId":...}`, errors are
   `{"ok":false,"error":{"code","message"}}`, with `ratelimit-*` headers.

They also use separate result decoders (`FastIngressResult` vs
`BakedIngressResult`) and separate header-template builders.

## Decision

**Do not unify them.** The HTTP benchmark load generator (`bench/http/load.ts`)
requires `ok === true` + `requestId: string` on success and `error.code` /
`error.message` on errors — i.e. path 2's format. The two formats are a
**benchmark contract**: the benchmark server uses path 2, and changing its
wire shape invalidates baselines.

## Consequences

- Both paths stay hot and zero-alloc.
- Duplicated decoders/templates are intentional; sharing them is
  **forbidden** by AGENTS.md (it would couple two differently-shaped outputs).
- New contributors must not "helpfully" unify the formats.

## See also

- AGENTS.md §"Ingress: the two paths (do NOT conflate)"
- docs/INGRESS.md §"Wire format"
