import addon, { type HmacSignerInstance } from "./index";
import { decoder } from "../shared/bytes";

const mimeByText = new Map<string, Uint8Array>();
const hmacSigners = new WeakMap<Uint8Array, HmacSignerInstance>();

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value);
  }

  throw new TypeError(
    `Expected bigint-compatible value, got ${typeof value}: ${String(value)}`,
  );
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Number(value);
  }

  return 0;
}

function normalizeExt(ext: Uint8Array): string {
  let s: string;

  try {
    s = decoder.decode(ext);
  } catch {
    return "";
  }

  if (s.charCodeAt(0) === 46) {
    s = s.slice(1);
  }

  return s.toLowerCase();
}

function cachedMime(ext: Uint8Array): Uint8Array {
  const key = normalizeExt(ext);

  let val = mimeByText.get(key);
  if (!val) {
    val = addon.mimeFromExtension(ext);
    mimeByText.set(key, val);
  }

  // Return a copy so callers cannot mutate cached bytes.
  return val.slice();
}

function getHmacSigner(key: Uint8Array): HmacSignerInstance {
  let signer = hmacSigners.get(key);

  if (!signer) {
    signer = new addon.HmacSigner(key);
    hmacSigners.set(key, signer);
  }

  return signer;
}

export const rustNative = {
  jsonValid(bytes: Uint8Array): number {
    return addon.jsonValid(bytes) ? 1 : 0;
  },

  jsonSumIds(bytes: Uint8Array): bigint {
    return asBigInt(addon.jsonSumIds(bytes) as unknown);
  },

  fnv1a64(bytes: Uint8Array): bigint {
    return asBigInt(addon.fnv1a64(bytes) as unknown);
  },

  crc32(bytes: Uint8Array): number {
    return asNumber(addon.crc32(bytes) as unknown) >>> 0;
  },

  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
    return addon.jsonPatch(doc, patch);
  },

  randomToken(byteLen: number): Uint8Array {
    return addon.randomToken(byteLen);
  },

  urlEncode(bytes: Uint8Array): Uint8Array {
    return addon.urlEncode(bytes);
  },

  urlDecode(bytes: Uint8Array): Uint8Array {
    return addon.urlDecode(bytes);
  },

  wsAcceptKey(key: Uint8Array): Uint8Array {
    return addon.wsAcceptKey(key);
  },

  initThreadPool(rayonThreads?: number) {
    return addon.initThreadPool(rayonThreads);
  },

  rayonNumThreads() {
    return asNumber(addon.rayonNumThreads() as unknown);
  },

  httpParseRequestPacked(bytes: Uint8Array): Uint8Array {
    return addon.httpParseRequestPacked(bytes);
  },

  httpParseRequestPackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return asNumber(addon.httpParseRequestPackedInto(bytes, out) as unknown) >>> 0;
  },

  queryParsePacked(bytes: Uint8Array): Uint8Array {
    return addon.queryParsePacked(bytes);
  },

  queryParsePackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return asNumber(addon.queryParsePackedInto(bytes, out) as unknown) >>> 0;
  },

  cookieParsePacked(bytes: Uint8Array): Uint8Array {
    return addon.cookieParsePacked(bytes);
  },

  cookieParsePackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return asNumber(addon.cookieParsePackedInto(bytes, out) as unknown) >>> 0;
  },

  createSchemaValidator(schema: Uint8Array) {
    return new addon.SchemaValidator(schema);
  },

  validateEmail(bytes: Uint8Array): number {
    return addon.validateEmail(bytes) ? 1 : 0;
  },

  validateUuid(bytes: Uint8Array): number {
    return addon.validateUuid(bytes) ? 1 : 0;
  },

  validateIpv4(bytes: Uint8Array): number {
    return addon.validateIpv4(bytes) ? 1 : 0;
  },

  validateIpv6(bytes: Uint8Array): number {
    return addon.validateIpv6(bytes) ? 1 : 0;
  },

  mimeFromExtension(ext: Uint8Array): Uint8Array {
    return cachedMime(ext);
  },

  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
    return getHmacSigner(key).sign(data);
  },

  hmacSha256Verify(
    key: Uint8Array,
    data: Uint8Array,
    sig: Uint8Array,
  ): number {
    return getHmacSigner(key).verify(data, sig) ? 1 : 0;
  },

  createHmacSigner(key: Uint8Array) {
    return new addon.HmacSigner(key);
  },
};