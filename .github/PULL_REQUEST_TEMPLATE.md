## Description

<!-- What does this change and why? Link the issue if any. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New `rust.*` primitive / native surface
- [ ] New TS surface
- [ ] Performance benchmark / classification change
- [ ] Docs / governance / CI
- [ ] Breaking change (needs CHANGELOG `### Removed (breaking)` + semver note)

## Checklist

- [ ] `cargo test --lib` passes
- [ ] `bun test` passes
- [ ] `bunx tsc --noEmit` + `bunx tsc --noEmit -p tsconfig.test.json` clean
- [ ] `bun run lint:ci` clean
- [ ] `bun run check:version` passes
- [ ] If Rust changed: `bun run build` then `bun run check` (release) — correctness
      checks pass and `check:proven:fail` is clean (note: wsFrameDecode etc. can
      flake on sub-µs ops — see repo memory)
- [ ] If servers/handlers changed: `bun run bench:http:smoke` — no
      `shape_failure` / `unexpected_status`
- [ ] New public function → added a `PROVEN_SURFACE` entry + TS/Rust tests
- [ ] New native primitive → verified against Bun built-in (decision matrix)
- [ ] CHANGELOG updated under `[Unreleased]`
