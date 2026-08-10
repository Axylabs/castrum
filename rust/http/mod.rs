//! HTTP wire formats & parsing (zero-alloc parsers + wire helpers).
//
// Zero-alloc parsers and wire-format helpers for the HTTP surface:
//   - headers.rs       zero-alloc packed-header parser (HeaderRefs)
//   - method.rs        HTTP method classification
//   - http_parser.rs   HTTP request line + headers → packed request
//   - cookie_parser.rs cookie header → packed pairs
//   - query_parser.rs  query/form-string → packed pairs
//   - form.rs          x-www-form-urlencoded body parser (FormParser instance)
//   - media_type.rs    Content-Type parser + wildcard matching instances
//   - url_codec.rs     percent-encoding encode/decode
//   - url_join.rs      RFC 3986 url_resolve + query builder (UrlBuilder)
//   - etag.rs          HTTP cache semantics (etag / http_date / 304)
//   - accept.rs        Accept-Encoding negotiation (AcceptNegotiator)
//   - mime_lookup.rs   extension → MIME type (phf table)
//   - multipart.rs     multipart/form-data parser (+ limits)

pub mod accept;
pub mod cookie_parser;
pub mod etag;
pub mod form;
pub mod headers;
pub mod http_parser;
pub mod media_type;
pub mod method;
pub mod mime_lookup;
pub mod multipart;
pub mod query_parser;
pub mod url_codec;
pub mod url_join;
