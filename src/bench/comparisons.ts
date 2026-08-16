import type { ComparisonReport } from './types'

export const comparisonReports: ComparisonReport[] = [
  // ── Original sequential benchmarks ──
  { label: 'JSON valid', nativeName: 'native:json_valid', rustName: 'rust:json_valid' },
  { label: 'JSON parse (5k rows)', nativeName: 'native:json_parse', rustName: 'rust:json_parse' },
  { label: 'JSON sum', nativeName: 'native:json_sum', rustName: 'rust:json_sum' },
  {
    label: 'JSON schema validate',
    nativeName: 'native:json_schema_validate',
    rustName: 'rust:json_schema_validate',
  },
  { label: 'HTTP parse', nativeName: 'native:http_parse', rustName: 'rust:http_parse' },
  { label: 'Query parse', nativeName: 'native:query_parse', rustName: 'rust:query_parse' },
  { label: 'Form parse', nativeName: 'native:form_parse', rustName: 'rust:form_parse' },
  {
    label: 'Media type parse',
    nativeName: 'native:media_type_parse',
    rustName: 'rust:media_type_parse',
  },
  { label: 'ETag', nativeName: 'native:etag', rustName: 'rust:etag' },
  { label: 'HTTP date', nativeName: 'native:http_date', rustName: 'rust:http_date' },
  { label: 'HTTP date (pooled)', nativeName: 'native:http_date', rustName: 'rust:http_date_into' },
  { label: 'Conditional request', nativeName: 'native:conditional', rustName: 'rust:conditional' },
  {
    label: 'Accept-Encoding negotiate',
    nativeName: 'native:accept_negotiate',
    rustName: 'rust:accept_negotiate',
  },
  {
    label: 'Base64 encode',
    nativeName: 'native:base64_encode',
    rustName: 'rust:base64_encode_into',
  },
  {
    label: 'Base64 encode (allocating)',
    nativeName: 'native:base64_encode',
    rustName: 'rust:base64_encode',
  },
  {
    label: 'Base64 decode',
    nativeName: 'native:base64_decode',
    rustName: 'rust:base64_decode_into',
  },
  {
    label: 'Base64 decode (allocating)',
    nativeName: 'native:base64_decode',
    rustName: 'rust:base64_decode',
  },
  { label: 'Hex encode', nativeName: 'native:hex_encode', rustName: 'rust:hex_encode_into' },
  {
    label: 'Hex encode (allocating)',
    nativeName: 'native:hex_encode',
    rustName: 'rust:hex_encode',
  },
  { label: 'Hex decode', nativeName: 'native:hex_decode', rustName: 'rust:hex_decode_into' },
  {
    label: 'Hex decode (allocating)',
    nativeName: 'native:hex_decode',
    rustName: 'rust:hex_decode',
  },
  { label: 'Cookie sign', nativeName: 'native:cookie_sign', rustName: 'rust:cookie_sign' },
  { label: 'Cookie verify', nativeName: 'native:cookie_verify', rustName: 'rust:cookie_verify' },
  { label: 'CSRF create', nativeName: 'native:csrf_create', rustName: 'rust:csrf_create' },
  { label: 'CSRF verify', nativeName: 'native:csrf_verify', rustName: 'rust:csrf_verify' },
  { label: 'URL resolve', nativeName: 'native:url_resolve', rustName: 'rust:url_resolve' },
  {
    label: 'URL query build',
    nativeName: 'native:url_encode_query',
    rustName: 'rust:url_encode_query',
  },
  { label: 'Cookie parse', nativeName: 'native:cookie_parse', rustName: 'rust:cookie_parse' },
  { label: 'Random token', nativeName: 'native:random_token', rustName: 'rust:random_token' },
  { label: 'WebSocket accept', nativeName: 'native:ws_accept_key', rustName: 'rust:ws_accept_key' },
  { label: 'JSON Patch', nativeName: 'native:json_patch', rustName: 'rust:json_patch' },
  { label: 'HMAC sign', nativeName: 'native:hmac_sha256', rustName: 'rust:hmac_sha256' },
  { label: 'HMAC verify', nativeName: 'native:hmac_verify', rustName: 'rust:hmac_verify' },
  {
    label: 'Email validation',
    nativeName: 'native:validate_email',
    rustName: 'rust:validate_email',
  },
  { label: 'UUID validation', nativeName: 'native:validate_uuid', rustName: 'rust:validate_uuid' },
  { label: 'IPv4 validation', nativeName: 'native:validate_ipv4', rustName: 'rust:validate_ipv4' },
  { label: 'IPv6 validation', nativeName: 'native:validate_ipv6', rustName: 'rust:validate_ipv6' },
  { label: 'CRC32', nativeName: 'native:crc32', rustName: 'rust:crc32' },
  { label: 'FNV-1a 64', nativeName: 'native:fnv1a64', rustName: 'rust:fnv1a64' },
  { label: 'MIME lookup', nativeName: 'native:mime', rustName: 'rust:mime' },
  { label: 'URL encode', nativeName: 'native:url_encode', rustName: 'rust:url_encode_into' },
  { label: 'URL decode', nativeName: 'native:url_decode', rustName: 'rust:url_decode_into' },
  {
    label: 'URL encode (allocating)',
    nativeName: 'native:url_encode',
    rustName: 'rust:url_encode',
  },
  {
    label: 'URL decode (allocating)',
    nativeName: 'native:url_decode',
    rustName: 'rust:url_decode',
  },
  {
    label: 'URL decode (bytes)',
    nativeName: 'native:url_decode_bytes',
    rustName: 'rust:url_decode_bytes',
  },
  {
    label: 'ETag (pooled)',
    nativeName: 'native:etag',
    rustName: 'rust:etag_into',
  },
  {
    label: 'HMAC sign (pooled)',
    nativeName: 'native:hmac_sha256',
    rustName: 'rust:hmac_sha256_into',
  },
  {
    label: 'Cookie sign (pooled)',
    nativeName: 'native:cookie_sign',
    rustName: 'rust:sign_cookie_into',
  },
  {
    label: 'AEAD encrypt (pooled)',
    nativeName: 'native:aead_encrypt',
    rustName: 'rust:aead_encrypt_into',
  },
  {
    label: 'WS frame encode (pooled)',
    nativeName: 'native:ws_frame_encode',
    rustName: 'rust:ws_frame_encode_into',
  },
  {
    label: 'Gzip compress (pooled)',
    nativeName: 'native:gzip_compress',
    rustName: 'rust:gzip_compress_into',
  },
  {
    label: 'Brotli compress (pooled)',
    nativeName: 'native:brotli_compress',
    rustName: 'rust:brotli_compress_into',
  },

  // ── Backend-framework features (sequential) ──
  { label: 'JWT sign', nativeName: 'native:jwt_sign', rustName: 'rust:jwt_sign' },
  { label: 'JWT sign (bytes)', nativeName: 'native:jwt_sign', rustName: 'rust:jwt_sign_bytes' },
  { label: 'JWT verify', nativeName: 'native:jwt_verify', rustName: 'rust:jwt_verify' },
  {
    label: 'Password hash (argon2id vs scrypt)',
    nativeName: 'native:password_hash',
    rustName: 'rust:password_hash',
  },
  { label: 'AEAD encrypt', nativeName: 'native:aead_encrypt', rustName: 'rust:aead_encrypt' },
  { label: 'AEAD decrypt', nativeName: 'native:aead_decrypt', rustName: 'rust:aead_decrypt' },
  { label: 'Gzip compress', nativeName: 'native:gzip_compress', rustName: 'rust:gzip_compress' },
  {
    label: 'Gzip decompress',
    nativeName: 'native:gzip_decompress',
    rustName: 'rust:gzip_decompress',
  },
  {
    label: 'Brotli compress',
    nativeName: 'native:brotli_compress',
    rustName: 'rust:brotli_compress',
  },
  {
    label: 'Brotli decompress',
    nativeName: 'native:brotli_decompress',
    rustName: 'rust:brotli_decompress',
  },
  {
    label: 'Multipart parse',
    nativeName: 'native:multipart_parse',
    rustName: 'rust:multipart_parse',
  },
  {
    label: 'Template render',
    nativeName: 'native:template_render',
    rustName: 'rust:template_render',
  },
  {
    label: 'Template render (bytes)',
    nativeName: 'native:template_render',
    rustName: 'rust:template_render_bytes',
  },
  {
    label: 'WS frame encode',
    nativeName: 'native:ws_frame_encode',
    rustName: 'rust:ws_frame_encode',
  },
  {
    label: 'WS frame decode',
    nativeName: 'native:ws_frame_decode',
    rustName: 'rust:ws_frame_decode',
  },
  { label: 'SSE encode', nativeName: 'native:sse_encode', rustName: 'rust:sse_encode' },
  {
    label: 'SSE encode (pooled)',
    nativeName: 'native:sse_encode',
    rustName: 'rust:sse_encode_into',
  },

  // ── Complex payload benchmarks ──
  {
    label: 'JSON valid (50k rows)',
    nativeName: 'native:json_valid_large',
    rustName: 'rust:json_valid_large',
  },
  {
    label: 'JSON valid (100k rows)',
    nativeName: 'native:json_valid_huge',
    rustName: 'rust:json_valid_huge',
  },
  {
    label: 'JSON valid (deep nested)',
    nativeName: 'native:json_valid_deep',
    rustName: 'rust:json_valid_deep',
  },
  {
    label: 'JSON sum (50k rows)',
    nativeName: 'native:json_sum_large',
    rustName: 'rust:json_sum_large',
  },
  {
    label: 'HTTP parse (complex)',
    nativeName: 'native:http_parse_complex',
    rustName: 'rust:http_parse_complex',
  },
  {
    label: 'HTTP parse (huge)',
    nativeName: 'native:http_parse_huge',
    rustName: 'rust:http_parse_huge',
  },
  {
    label: 'Cookie parse (large)',
    nativeName: 'native:cookie_parse_large',
    rustName: 'rust:cookie_parse_large',
  },
  {
    label: 'Query parse (complex)',
    nativeName: 'native:query_parse_complex',
    rustName: 'rust:query_parse_complex',
  },
  {
    label: 'URL encode (large)',
    nativeName: 'native:url_encode_large',
    rustName: 'rust:url_encode_large',
  },
  {
    label: 'URL decode (large)',
    nativeName: 'native:url_decode_large',
    rustName: 'rust:url_decode_large',
  },
  {
    label: 'JSON valid (batch 100)',
    nativeName: 'native:json_valid_batch',
    rustName: 'rust:json_valid_batch',
  },
  {
    label: 'Email validate (batch 100)',
    nativeName: 'native:validate_email_batch',
    rustName: 'rust:validate_email_batch',
  },
  {
    label: 'UUID validate (batch 100)',
    nativeName: 'native:validate_uuid_batch',
    rustName: 'rust:validate_uuid_batch',
  },
  {
    label: 'IPv4 validate (batch 100)',
    nativeName: 'native:validate_ipv4_batch',
    rustName: 'rust:validate_ipv4_batch',
  },
  {
    label: 'Query parse (batch 100)',
    nativeName: 'native:query_parse_batch',
    rustName: 'rust:query_parse_batch',
  },
  {
    label: 'Form parse (batch 100)',
    nativeName: 'native:form_parse_batch',
    rustName: 'rust:form_parse_batch',
  },
  {
    label: 'JSON schema validate (batch 100)',
    nativeName: 'native:json_schema_validate_batch',
    rustName: 'rust:json_schema_validate_batch',
  },

  // ── Backend-framework features (batch) ──
  {
    label: 'Password hash (batch 20)',
    nativeName: 'native:password_hash_batch',
    rustName: 'rust:password_hash_batch',
  },
  {
    label: 'JWT verify (batch 100)',
    nativeName: 'native:jwt_verify_batch',
    rustName: 'rust:jwt_verify_batch',
  },
  {
    label: 'Gzip compress (batch 100)',
    nativeName: 'native:gzip_compress_batch',
    rustName: 'rust:gzip_compress_batch',
  },
  {
    label: 'Template render (batch 100)',
    nativeName: 'native:template_render_batch',
    rustName: 'rust:template_render_batch',
  },

  // ── Concurrent burst benchmarks ──
  {
    label: 'JSON valid concurrent (10x50)',
    nativeName: 'native:json_valid_concurrent_10',
    rustName: 'rust:json_valid_concurrent_10',
  },
  {
    label: 'JSON valid concurrent (50x20)',
    nativeName: 'native:json_valid_concurrent_50',
    rustName: 'rust:json_valid_concurrent_50',
  },
  {
    label: 'HTTP parse concurrent (20x50)',
    nativeName: 'native:http_parse_concurrent_20',
    rustName: 'rust:http_parse_concurrent_20',
  },
  {
    label: 'HMAC concurrent (20x30)',
    nativeName: 'native:hmac_sha256_concurrent_20',
    rustName: 'rust:hmac_sha256_concurrent_20',
  },
  {
    label: 'Email validate concurrent (50x40)',
    nativeName: 'native:validate_email_concurrent_50',
    rustName: 'rust:validate_email_concurrent_50',
  },
  {
    label: 'UUID validate concurrent (50x40)',
    nativeName: 'native:validate_uuid_concurrent_50',
    rustName: 'rust:validate_uuid_concurrent_50',
  },
  {
    label: 'Query parse concurrent (20x50)',
    nativeName: 'native:query_parse_concurrent_20',
    rustName: 'rust:query_parse_concurrent_20',
  },
  {
    label: 'Cookie parse concurrent (20x50)',
    nativeName: 'native:cookie_parse_concurrent_20',
    rustName: 'rust:cookie_parse_concurrent_20',
  },
  {
    label: 'CRC32 concurrent (20x100)',
    nativeName: 'native:crc32_concurrent_20',
    rustName: 'rust:crc32_concurrent_20',
  },
  {
    label: 'JSON sum concurrent (20x20)',
    nativeName: 'native:json_sum_concurrent_20',
    rustName: 'rust:json_sum_concurrent_20',
  },

  // ── Stress benchmarks (2s) ──
  {
    label: 'JSON valid stress (2s)',
    nativeName: 'native:json_valid_stress',
    rustName: 'rust:json_valid_stress',
  },
  {
    label: 'HTTP parse stress (2s)',
    nativeName: 'native:http_parse_stress',
    rustName: 'rust:http_parse_stress',
  },
  {
    label: 'HMAC stress (2s)',
    nativeName: 'native:hmac_sha256_stress',
    rustName: 'rust:hmac_sha256_stress',
  },
  { label: 'CRC32 stress (2s)', nativeName: 'native:crc32_stress', rustName: 'rust:crc32_stress' },
  {
    label: 'Query parse stress (2s)',
    nativeName: 'native:query_parse_stress',
    rustName: 'rust:query_parse_stress',
  },
  {
    label: 'JSON sum stress (2s)',
    nativeName: 'native:json_sum_stress',
    rustName: 'rust:json_sum_stress',
  },
  {
    label: 'Email validate stress (2s)',
    nativeName: 'native:validate_email_stress',
    rustName: 'rust:validate_email_stress',
  },
  {
    label: 'Cookie parse stress (2s)',
    nativeName: 'native:cookie_parse_stress',
    rustName: 'rust:cookie_parse_stress',
  },
  {
    label: 'UUID validate stress (2s)',
    nativeName: 'native:validate_uuid_stress',
    rustName: 'rust:validate_uuid_stress',
  },
  {
    label: 'WebSocket accept stress (2s)',
    nativeName: 'native:ws_accept_key_stress',
    rustName: 'rust:ws_accept_key_stress',
  },

  {
    label: 'HTTP parse pipeline',
    nativeName: 'native:http_parse_pipeline',
    rustName: 'rust:http_parse_pipeline',
  },
  {
    label: 'Query parse pipeline',
    nativeName: 'native:query_parse_pipeline',
    rustName: 'rust:query_parse_pipeline',
  },
  {
    label: 'Cookie parse pipeline',
    nativeName: 'native:cookie_parse_pipeline',
    rustName: 'rust:cookie_parse_pipeline',
  },

  // ── Diagnostic: castrum vs Bun built-ins (diag: task names — kept out of
  //    the shipped-op `native:`/`rust:` comparisons; feeds
  //    docs/bun-builtins-decision-matrix.md) ──
  {
    label: 'FNV-1a 64 vs Bun.hash (wyhash)',
    nativeName: 'diag:bun_hash_wyhash',
    rustName: 'diag:fnv1a64',
  },
  { label: 'CRC32 vs Bun.hash.crc32', nativeName: 'diag:bun_hash_crc32', rustName: 'diag:crc32' },
  { label: 'XXH3-64 vs Bun.hash.xxHash3', nativeName: 'diag:bun_hash_xxh3', rustName: 'diag:xxh3' },
  {
    label: 'HMAC-SHA256 vs Bun.CryptoHasher',
    nativeName: 'diag:bun_hmac_sha256',
    rustName: 'diag:hmac_sha256',
  },
  {
    label: 'Password hash vs Bun.password.argon2id',
    nativeName: 'diag:bun_password_hash',
    rustName: 'diag:password_hash',
  },
  {
    label: 'Password verify vs Bun.password.verify',
    nativeName: 'diag:bun_password_verify',
    rustName: 'diag:password_verify',
  },
  {
    label: 'Password hash (bcrypt) vs Bun.password.bcrypt',
    nativeName: 'diag:bun_password_bcrypt_hash',
    rustName: 'diag:bcrypt_hash',
  },
  {
    label: 'Password verify (bcrypt) vs Bun.password.bcrypt',
    nativeName: 'diag:bun_password_bcrypt_verify',
    rustName: 'diag:bcrypt_verify',
  },
  {
    label: 'PBKDF2-HMAC-SHA256 vs node:crypto pbkdf2Sync',
    nativeName: 'diag:pbkdf2_sha256',
    rustName: 'diag:pbkdf2_sha256_rust',
  },
  {
    label: 'Random token vs Bun.randomUUIDv7',
    nativeName: 'diag:bun_random_uuidv7',
    rustName: 'diag:random_token16',
  },
  {
    label: 'Gzip compress vs Bun.gzipSync',
    nativeName: 'diag:bun_gzip_compress',
    rustName: 'diag:gzip_compress',
  },
  {
    label: 'Gzip decompress vs Bun.gunzipSync',
    nativeName: 'diag:bun_gzip_decompress',
    rustName: 'diag:gzip_decompress',
  },
]
