import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
  gzipSync,
} from "node:zlib";

export function nativeGzipCompress(
  data: Uint8Array,
  level?: number | null,
): Uint8Array {
  return new Uint8Array(
    gzipSync(Buffer.from(data), { level: level ?? 6 }),
  );
}

export function nativeGzipDecompress(data: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(Buffer.from(data)));
}

export function nativeBrotliCompress(
  data: Uint8Array,
  quality?: number | null,
): Uint8Array {
  return new Uint8Array(
    brotliCompressSync(Buffer.from(data), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: quality ?? 5,
      },
    }),
  );
}

export function nativeBrotliDecompress(data: Uint8Array): Uint8Array {
  return new Uint8Array(brotliDecompressSync(Buffer.from(data)));
}
