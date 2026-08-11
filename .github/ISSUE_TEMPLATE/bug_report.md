---
name: Bug report
about: Report a defect in castrum (native addon, ingress, or tooling)
title: "[bug] "
labels: bug
assignees: ""
---

## Summary

<!-- One or two sentences describing the bug. -->

## Reproduction

```bash
# Minimal repro (commands / code)
```

## Expected vs actual

- Expected: …
- Actual: …

## Environment

- castrum version: (e.g. `0.9.0`)
- Runtime: Bun `bun --version` / Node `node --version`
- Platform: (e.g. `x86_64-unknown-linux-gnu`, musl?)
- Native addon: release (`bun run build`) or debug (`bun run build:debug`)?

## Impact

<!-- Performance? Crash/panic? Wire-format breakage? Security? -->

## Checklist

- [ ] Reproduced on a release build (debug builds inflate timings / mask panics)
- [ ] `bun run check:version` passes
- [ ] `bun test` + `cargo test --lib` green on the failing branch (if applicable)
