# Contributing to castrum

Thank you for your interest in contributing to castrum! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Architecture](#project-architecture)
- [Coding Standards](#coding-standards)
- [Testing Requirements](#testing-requirements)
- [Documentation Requirements](#documentation-requirements)
- [Pull Request Process](#pull-request-process)
- [Commit Convention](#commit-convention)

## Development Setup

### Prerequisites

- **Bun** >= 1.1.0
- **Rust** nightly (latest stable)
- **Node.js** (for napi-rs CLI, optional)

### Setup Steps

```bash
# 1. Clone the repository (or your fork)
git clone <repository-url>
cd castrum

# 2. Install dependencies
bun install

# 3. Build the Rust native addon
bun run build

# 4. Verify the build
bun run check
```

### Development Workflow

1. **Make changes to Rust code** → `cargo build --release` (or `bun run build`)
2. **Make changes to TypeScript code** → No build step needed (Bun runs TS directly)
3. **Run Rust tests** → `cargo test`
4. **Run TypeScript tests** → `bun test`
5. **Run benchmarks** → `bun bench.ts`

## Project Architecture

### Repository Structure

```
/
├── rust/          # Rust source (NAPI cdylib)
│   ├── lib.rs     # Crate root — module declarations
│   ├── unit_tests.rs # Rust unit tests (run with `cargo test`)
│   ├── *.rs       # One module per functional area
│   └── ...
├── src/           # TypeScript source
│   ├── ingress/   # HTTP ingress pipeline (fast.ts = packed, handlers.ts = pre-baked)
│   ├── native/    # Native addon loader
│   ├── rust-ffi/  # Raw Rust FFI bindings
│   ├── baseline/  # JS baseline impls (benchmarks)
│   ├── bench/     # Benchmark framework
│   ├── data/      # Data utilities
│   └── shared/    # Shared utilities
├── test/          # Tests (mirrors src/ structure)
├── bench/         # HTTP server benchmarks
└── docs/          # Documentation
```

### Key Design Principles

1. **Zero-copy where possible**: Rust functions accept and return `Uint8Array` to avoid serialization overhead
2. **Batch operations**: High-throughput operations process multiple items in a single FFI call
3. **Lazy decoding**: Parse result buffers on-demand rather than eagerly
4. **Pure-Rust core**: Modules keep napi types out of internal signatures so the core stays testable and composable (`cargo test`)
5. **Single source of truth**: Output buffer layout constants come from Rust via NAPI exports

## Coding Standards

### TypeScript

- **Format**: Use the project's Prettier/format-on-save configuration
- **Types**: All public APIs must have explicit TypeScript types
- **JSDoc**: All exported functions, classes, interfaces, and types must have JSDoc comments
- **Imports**: Use explicit named imports; avoid default imports for larger modules
- **Naming**: `camelCase` for functions/variables, `PascalCase` for classes/types/interfaces
- **File structure**: One logical module per file, export at the bottom

```ts
/**
 * Creates a fast ingress handler with zero-allocation per request.
 *
 * @param options - Configuration options for the ingress pipeline
 * @returns A synchronous ingress handler
 *
 * @example
 * ```ts
 * const handler = createIngressFast({ parseCookies: true });
 * handler.run(req, ip, body, rid, (result) => { ... });
 * ```
 */
export function createIngressFast(options: IngressFastOptions = {}): IngressFastHandler {
  // ...
}
```

### Rust

- **Format**: `rustfmt` with default settings
- **Clippy**: Run `cargo clippy` before submitting PRs — all warnings must be addressed
- **Unsafe**: Minimize `unsafe` blocks; document safety invariants when used
- **Doc comments**: All public items must have `///` doc comments
- **Naming**: `snake_case` for functions/variables, `PascalCase` for types/traits/enums
- **Error handling**: Use `Result<T, napi::Error>` for NAPI exports, `Result<T, String>` internally
- **Module structure**: Keep modules focused — one responsibility per module

```rust
/// Compute the FNV-1a 64-bit hash of the input bytes.
///
/// Uses the FNV-1a algorithm with offset basis 0xcbf29ce484222325
/// and prime 0x100000001b3. This is a fast, non-cryptographic hash.
///
/// # Arguments
/// * `input` - The bytes to hash
///
/// # Returns
/// The 64-bit FNV-1a hash value
#[inline(always)]
pub fn fnv1a64_bytes(input: &[u8]) -> u64 {
    // ...
}
```

## Testing Requirements

### Test Coverage

- **TypeScript unit tests**: ≥ 80% line coverage for all `src/` modules
- **Rust unit tests**: ≥ 70% line coverage for all `rust/` modules
- **Integration tests**: Cover the ingress pipeline end-to-end

### Test Structure

```
test/
├── unit/                  # Unit tests (mirror src/ structure)
│   ├── shared/
│   ├── ingress/
│   ├── data/
│   └── rust-ffi/
├── integration/           # Integration tests
│   ├── ingress.test.ts
│   └── rust-ffi.test.ts
├── property/              # Property-based tests
│   ├── validation.test.ts
│   └── hashing.test.ts
└── fixtures/              # Test fixtures
    └── ...
```

### Writing Tests

- **TypeScript tests**: Use Bun's built-in test runner (`bun test`)
- **Rust tests**: `cargo test` — core logic lives in `rust/unit_tests.rs` (wired from `lib.rs`)
- **Property-based tests**: Use `fast-check` for TypeScript
- **Naming**: `describe` blocks for modules, `test` for individual cases
- **Edge cases**: Always include: empty input, max-size input, invalid input, concurrent access

```ts
import { describe, test, expect } from "bun:test";

describe("generateRequestId", () => {
  test("returns a 16-byte hex string", () => {
    const id = generateRequestId();
    expect(id.byteLength).toBe(16);
  });

  test("produces unique consecutive IDs", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toEqual(b);
  });
});
```

## Documentation Requirements

### Code Documentation

Every public API element must have documentation:

- **TypeScript**: JSDoc with `@param`, `@returns`, `@example` where applicable
- **Rust**: `///` doc comments with `# Arguments`, `# Returns` sections
- **Complex algorithms**: Include inline comments explaining the "why" not just the "what"

### Documentation Files

- **README.md**: Must be kept in sync with the public API
- **docs/ARCHITECTURE.md**: Update when adding new modules or significant changes
- **docs/INGRESS.md**: Update when modifying the ingress pipeline
- **AGENTS.md**: AI agent instructions (commands, constraints, gotchas) — keep in sync when build/test commands or architecture change

## Pull Request Process

1. **Create a branch**: `feature/description` or `fix/description`
2. **Make your changes**: Following the coding standards above
3. **Write tests**: Cover your changes with appropriate tests
4. **Run the test suite**: `bun test` — all tests must pass
5. **Build the Rust addon**: `bun run build` — must succeed
6. **Update documentation**: If your changes affect the public API
7. **Open a PR**: Provide a clear description of the changes
8. **Code review**: At least one maintainer must approve
9. **Merge**: Squash-merge with a conventional commit message

### PR Checklist

- [ ] Code follows the project's coding standards
- [ ] Tests added/updated and passing
- [ ] Documentation updated
- [ ] Rust build succeeds (`bun run build`)
- [ ] No new clippy warnings
- [ ] Benchmarks not regressed (if applicable)

## Commit Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `test`: Adding or updating tests
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `perf`: Performance improvement
- `chore`: Build process or tooling changes

### Examples

```
feat(ingress): add support for custom error codes
fix(hashing): correct FNV-1a offset for empty input
docs: update README with new API reference
test(validation): add property-based tests for email
perf(json): reduce allocations in batch parsing
```

---

Thank you for contributing! 🚀