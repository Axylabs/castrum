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

- **Rust native addon**: Memory safety, input validation, buffer overflows
- **NAPI bridge**: Data serialization/deserialization, type confusion
- **Ingress pipeline**: Request validation, body size limits, CORS enforcement, rate limiting
- **Cryptographic functions**: HMAC-SHA256, random token generation
- **Validation functions**: Email, UUID, IP address validation correctness
- **JSON operations**: Schema validation, patch operations

## Out of Scope

- Denial of service (DoS) through resource exhaustion (separate issue tracker)
- Third-party dependency vulnerabilities (report to respective maintainers)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ |

## Security Measures

This project implements the following security measures:

1. **Memory safety**: Rust's ownership model prevents buffer overflows and use-after-free
2. **Body size guarding**: Configurable maximum request body size
3. **Rate limiting**: Token-bucket algorithm per client IP
4. **CORS enforcement**: Origin validation with strict default
5. **Input validation**: All external inputs are validated before processing
6. **No unsafe patterns (minimal)**: `unsafe` is used only where absolutely necessary and documented

## Disclosure Process

1. Vulnerability reported privately
2. Maintainer acknowledges within 48 hours
3. Fix developed and tested
4. Patch released with advisory
5. Public disclosure after 30 days or when users have had reasonable time to update

Thank you for helping keep bun-rust-practical safe! 🔒