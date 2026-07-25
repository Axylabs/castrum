use napi::bindgen_prelude::*;
use napi_derive::napi;

const OCTET_STREAM: &str = "application/octet-stream";

fn common_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "json" => Some("application/json"),
        "js" | "mjs" | "cjs" => Some("text/javascript"),
        "html" | "htm" => Some("text/html"),
        "css" => Some("text/css"),
        "csv" => Some("text/csv"),
        "xml" => Some("application/xml"),
        "txt" => Some("text/plain"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "pdf" => Some("application/pdf"),
        "zip" => Some("application/zip"),
        "gz" => Some("application/gzip"),
        "wasm" => Some("application/wasm"),
        "map" => Some("application/json"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "ogg" => Some("audio/ogg"),
        _ => None,
    }
}

#[napi]
pub fn mime_from_extension(ext: Uint8Array) -> Buffer {
    let bytes = ext.as_ref();

    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Buffer::from(OCTET_STREAM.as_bytes().to_vec()),
    };

    let text = text.trim_start_matches('.');

    let mut stack = [0u8; 32];
    let lower_owned: String;

    let lower: &str = if text.len() <= stack.len() {
        for (i, b) in text.bytes().enumerate() {
            stack[i] = b.to_ascii_lowercase();
        }

        match std::str::from_utf8(&stack[..text.len()]) {
            Ok(s) => s,
            Err(_) => return Buffer::from(OCTET_STREAM.as_bytes().to_vec()),
        }
    } else {
        lower_owned = text.to_ascii_lowercase();
        &lower_owned
    };

    if let Some(mime) = common_mime(lower) {
        return Buffer::from(mime.as_bytes().to_vec());
    }

    let guessed = mime_guess::from_ext(lower).first_or_octet_stream();
    Buffer::from(guessed.essence_str().as_bytes().to_vec())
}