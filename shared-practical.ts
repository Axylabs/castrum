// shared-practical.ts
import { decoder, encoder } from "./shared";

import { parse as parseCookie } from "cookie-es";
import { applyPatch } from "fast-json-patch";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import mime from "mime-types";
import validator from "validator";
import createRouter from "find-my-way";
import * as CRC32 from "crc-32";

function toPlainBuffer(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function nativeJsonValidV2(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeJsonSumV2(bytes: Uint8Array): bigint {
  const rows = JSON.parse(decoder.decode(bytes)) as Array<{ id: number }>;
  let sum = 0n;

  for (const row of rows) {
    if (typeof row.id === "number") {
      sum += BigInt(Math.trunc(row.id));
    }
  }

  return sum;
}

// ---------------------------------------------------------------------------
// HTTP parsing
// ---------------------------------------------------------------------------

export function nativeHttpParseRequestV2(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const lines = head.split("\r\n");

  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = ""] = requestLine.split(" ");

  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      headers.append(name, value);
    }
  }

  let path = target;

  try {
    const url = new URL(target, "http://internal");
    path = url.pathname + url.search;
  } catch {
    // keep raw target
  }

  return encoder.encode(
    JSON.stringify({
      method,
      path,
      version,
      headers: Object.fromEntries(headers.entries()),
    }),
  );
}

export function nativeQueryParseV2(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);

  const obj: Record<string, string | string[]> = {};

  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    obj[key] = values.length === 1 ? (values[0] ?? "") : values;
  }

  return encoder.encode(JSON.stringify(obj));
}

export function nativeCookieParseV2(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies = parseCookie(text);
  return encoder.encode(JSON.stringify(cookies));
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export function nativeRandomTokenV2(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return encoder.encode(Buffer.from(bytes).toString("hex"));
}

export function nativeWsAcceptKeyV2(key: string): Uint8Array {
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(key + magic);

  const hash = new Bun.CryptoHasher("sha1")
    .update(toPlainBuffer(combined))
    .digest();

  return encoder.encode(Buffer.from(hash).toString("base64"));
}

export function nativeHmacSha256V2(
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const hex = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest("hex");

  return encoder.encode(hex);
}

export function nativeHmacSha256VerifyV2(
  key: Uint8Array,
  data: Uint8Array,
  sig: Uint8Array,
): boolean {
  const expected = createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(data))
    .digest();

  const providedHex = decoder.decode(sig).trim();

  if (!/^[0-9a-fA-F]*$/.test(providedHex)) {
    return false;
  }

  const provided = Buffer.from(providedHex, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// JSON Patch
// ---------------------------------------------------------------------------

export function nativeJsonPatchV2(
  docBytes: Uint8Array,
  patchBytes: Uint8Array,
): Uint8Array {
  const doc = JSON.parse(decoder.decode(docBytes));
  const patch = JSON.parse(decoder.decode(patchBytes));

  const result = applyPatch(doc, patch, true, false).newDocument;

  return encoder.encode(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function nativeRouteMatchV2(
  pattern: string,
  path: string,
): Uint8Array | null {
  try {
    const router = createRouter({
      ignoreTrailingSlash: false,
      allowUnsafeRegex: false,
    });

    router.on("GET", pattern, () => {});

    const route = router.find("GET", path);

    if (!route) {
      return null;
    }

    return encoder.encode(JSON.stringify(route.params));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function nativeValidateEmailV2(bytes: Uint8Array): boolean {
  return validator.isEmail(decoder.decode(bytes));
}

export function nativeValidateUuidV2(bytes: Uint8Array): boolean {
  return validator.isUUID(decoder.decode(bytes), 4);
}

export function nativeValidateIpv4V2(bytes: Uint8Array): boolean {
  return validator.isIP(decoder.decode(bytes), 4);
}

export function nativeValidateIpv6V2(bytes: Uint8Array): boolean {
  return isIP(decoder.decode(bytes)) === 6;
}

export function nativeValidateLuhnV2(bytes: Uint8Array): boolean {
  return validator.isCreditCard(decoder.decode(bytes));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function nativeCrc32V2(bytes: Uint8Array): number {
  return CRC32.buf(bytes) >>> 0;
}

export function nativeFnv1a64V2(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash;
}

// ---------------------------------------------------------------------------
// MIME / URL
// ---------------------------------------------------------------------------

export function nativeMimeFromExtensionV2(ext: string): string {
  return mime.lookup(ext) || "application/octet-stream";
}

export function nativeUrlEncodeV2(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return encodeURIComponent(text);
}

export function nativeUrlDecodeV2(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : decoder.decode(input);
  return decodeURIComponent(text);
}