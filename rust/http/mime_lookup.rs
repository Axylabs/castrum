use napi::bindgen_prelude::*;
use napi_derive::napi;
use phf::{phf_map, Map};

const OCTET_STREAM: &str = "application/octet-stream";

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

#[napi]
pub fn mime_from_extension(ext: Uint8Array) -> Buffer {
    let bytes = ext.as_ref();

    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Buffer::from(OCTET_STREAM.as_bytes().to_vec()),
    };

    let text = text.trim_start_matches('.');

    let mut stack = [0u8; 64];

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

    if let Some(mime) = MIME_TABLE.get(lower) {
        return Buffer::from(mime.as_bytes().to_vec());
    }

    let guessed = mime_guess::from_ext(lower).first_or_octet_stream();
    Buffer::from(guessed.essence_str().as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mime(input: &str) -> String {
        let out = mime_from_extension(Uint8Array::new(input.as_bytes().to_vec()));
        String::from_utf8_lossy(out.as_ref()).into_owned()
    }

    #[test]
    fn known_extensions() {
        assert_eq!(mime(".js"), "text/javascript");
        assert_eq!(mime("json"), "application/json");
        assert_eq!(mime(".html"), "text/html");
        assert_eq!(mime(".png"), "image/png");
        assert_eq!(mime(".pdf"), "application/pdf");
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(mime(".JS"), "text/javascript");
        assert_eq!(mime(".Jpg"), "image/jpeg");
    }

    #[test]
    fn unknown_and_empty_fall_back_to_octet_stream() {
        assert_eq!(mime(".xkrq"), "application/octet-stream");
        assert_eq!(mime(""), "application/octet-stream");
    }

    #[test]
    fn non_utf8_falls_back_to_octet_stream() {
        let out = mime_from_extension(Uint8Array::new(vec![0xff, 0xfe, 0xfd]));
        assert_eq!(
            String::from_utf8_lossy(out.as_ref()),
            "application/octet-stream"
        );
    }
}
