// rust/payload/mod.rs — Output & streaming.
//
//   - compress.rs   gzip (zlib-rs) + brotli compress/decompress + batch
//   - sse.rs        SSE event framing + batch
//   - ws_frames.rs  RFC 6455 frame codec + batch
//   - websocket.rs  WebSocket accept-key
//   - template.rs   minijinja template rendering (TemplateRenderer) + batch

pub mod compress;
pub mod sse;
pub mod template;
pub mod websocket;
pub mod ws_frames;
