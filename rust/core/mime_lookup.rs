// rust/core/mime_lookup.rs — MIME type lookup
// Pure Rust, no napi dependencies.

use phf::{phf_map, Map};

const OCTET_STREAM: &[u8] = b"application/octet-stream";

static MIME_TABLE: Map<&'static str, &'static str> = phf_map! {
    "json" => "application/json",
    "js" => "text/javascript",
    "mjs" => "text/javascript",
    "cjs" => "text/javascript",
    "html" => "text/html",
    "htm" => "text/html",
    "css" => "text/css",
    "csv" => "text/csv",
    "xml" => "application/xml",
    "txt" => "text/plain",
    "png" => "image/png",
    "jpg" => "image/jpeg",
    "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "avif" => "image/avif",
    "svg" => "image/svg+xml",
    "ico" => "image/x-icon",
    "pdf" => "application/pdf",
    "zip" => "application/zip",
    "gz" => "application/gzip",
    "wasm" => "application/wasm",
    "map" => "application/json",
    "woff" => "font/woff",
    "woff2" => "font/woff2",
    "ttf" => "font/ttf",
    "otf" => "font/otf",
    "mp4" => "video/mp4",
    "webm" => "video/webm",
    "mp3" => "audio/mpeg",
    "ogg" => "audio/ogg",
};

/// Look up MIME type from a file extension.
pub fn mime_from_extension(ext: &[u8]) -> Vec<u8> {
    let text = match std::str::from_utf8(ext) {
        Ok(text) => text,
        Err(_) => return OCTET_STREAM.to_vec(),
    };

    let text = text.trim_start_matches('.');

    let mut stack = [0u8; 64];
    let lower: &str = if text.len() <= stack.len() {
        for (i, b) in text.bytes().enumerate() {
            stack[i] = b.to_ascii_lowercase();
        }
        match std::str::from_utf8(&stack[..text.len()]) {
            Ok(s) => s,
            Err(_) => return OCTET_STREAM.to_vec(),
        }
    } else {
        let owned = text.to_ascii_lowercase();
        return if let Some(mime) = MIME_TABLE.get(&owned) {
            mime.as_bytes().to_vec()
        } else {
            mime_guess::from_ext(&owned).first_or_octet_stream().essence_str().as_bytes().to_vec()
        };
    };

    if let Some(mime) = MIME_TABLE.get(lower) {
        mime.as_bytes().to_vec()
    } else {
        mime_guess::from_ext(lower).first_or_octet_stream().essence_str().as_bytes().to_vec()
    }
}