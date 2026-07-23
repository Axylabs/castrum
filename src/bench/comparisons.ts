import type { ComparisonReport } from "./types";

export const comparisonReports: ComparisonReport[] = [
  { label: "JSON valid", nativeName: "native:json_valid", rustName: "rust:json_valid" },
  { label: "JSON sum", nativeName: "native:json_sum", rustName: "rust:json_sum" },
  { label: "HTTP parse", nativeName: "native:http_parse", rustName: "rust:http_parse" },
  { label: "Query parse", nativeName: "native:query_parse", rustName: "rust:query_parse" },
  { label: "Cookie parse", nativeName: "native:cookie_parse", rustName: "rust:cookie_parse" },
  { label: "Random token", nativeName: "native:random_token", rustName: "rust:random_token" },
  { label: "WebSocket accept", nativeName: "native:ws_accept_key", rustName: "rust:ws_accept_key" },
  { label: "JSON Patch", nativeName: "native:json_patch", rustName: "rust:json_patch" },
  { label: "HMAC sign", nativeName: "native:hmac_sha256", rustName: "rust:hmac_sha256" },
  { label: "HMAC verify", nativeName: "native:hmac_verify", rustName: "rust:hmac_verify" },
  { label: "Email validation", nativeName: "native:validate_email", rustName: "rust:validate_email" },
  { label: "UUID validation", nativeName: "native:validate_uuid", rustName: "rust:validate_uuid" },
  { label: "IPv4 validation", nativeName: "native:validate_ipv4", rustName: "rust:validate_ipv4" },
  { label: "IPv6 validation", nativeName: "native:validate_ipv6", rustName: "rust:validate_ipv6" },
  { label: "CRC32", nativeName: "native:crc32", rustName: "rust:crc32" },
  { label: "FNV-1a 64", nativeName: "native:fnv1a64", rustName: "rust:fnv1a64" },
  { label: "MIME lookup", nativeName: "native:mime", rustName: "rust:mime" },
  { label: "URL encode", nativeName: "native:url_encode", rustName: "rust:url_encode" },
  { label: "URL decode", nativeName: "native:url_decode", rustName: "rust:url_decode" },
];