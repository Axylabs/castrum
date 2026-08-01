# Security Policy

## Reporting a Vulnerability

We take the security of bun-rust-practical seriously. If you discover a security vulnerability, please follow these steps:

1. **Do NOT open a public GitHub issue.** Security vulnerabilities should be reported privately.
2. Send an email to the maintainers at **[security@axylabs.dev](mailto:security@axylabs.dev)** with:
   - A description of the vulnerability
   - Steps to reproduce (if applicable)
   - Affected versions
   - Any potential impact or exploit scenarios

3. You will receive an acknowledgment within 48 hours.
4. We will work on a fix and disclose the vulnerability responsibly once a patch is available.

## Scope

The following areas are in scope for security reviews:

- **Rust native addon**: Memory safety, input validation, buffer overflows, panic safety
- **NAPI bridge**: Data serialization/deserialization, type confusion
- **Ingress pipeline**: Request validation, body size limits, CORS enforcement, rate limiting, proxy-trust/IP-spoofing handling
- **Cryptographic functions**: HMAC-SHA256, random token generation
- **Validation functions**: Email, UUID, IP address validation correctness
- **JSON operations**: Schema validation, patch operations

## Out of Scope

- **Distributed denial of service (DDoS)** at the network/edge level (e.g., volumetric attacks, amplification) — these are addressed by the surrounding infrastructure (load balancer, edge proxy, WAF). In-process resource-exhaustion defenses (request body limits, rate limiting, bounds-checked parsers) **are** maintained in this repository; see "Security Measures" below.
- Third-party dependency vulnerabilities (report to the respective maintainers; we also track advisories via CI tooling where configured).

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ |

## Security Measures

This project implements the following security measures:

1. **Memory safety**: Rust's ownership model prevents buffer overflows and use-after-free; all packed-input parsing is bounds-checked (`checked_add`, per-section length limits).
2. **Panic safety**: `panic = "unwind"` + `overflow-checks = true` in the release profile, so a Rust panic surfaces as a JS error (HTTP 500) instead of aborting the host process. Malformed input is exercised by fuzz-style property tests.
3. **Body size guarding**: Configurable maximum request body size, enforced at the socket, by `Content-Length`, and during streaming reads.
4. **Rate limiting**: Token-bucket per client IP, monotonic clock, **shared across all routes/instances in the process** (prevents route-splitting bypass). Distributed deployments should use a shared external store.
5. **Proxy-trust is opt-in**: `X-Forwarded-For` / `X-Real-IP` are ignored unless proxy trust is explicitly enabled with a trusted-proxy network list, preventing client-side IP spoofing.
6. **CORS enforcement**: Origin validation with strict allowlist; `allowCredentials` cannot be combined with `*`.
7. **Input validation**: All external inputs are validated before processing (fuzz-style property tests cover the reachable parsers).
8. **Minimal unsafe**: `unsafe` is used only where necessary and documented.

## Disclosure Process

1. Vulnerability reported privately
2. Maintainer acknowledges within 48 hours
3. Fix developed and tested
4. Patch released with advisory
5. Public disclosure after 30 days or when users have had reasonable time to update

Thank you for helping keep bun-rust-practical safe! 🔒