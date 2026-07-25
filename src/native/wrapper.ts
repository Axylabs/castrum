import addon from "./index";
import type { HmacSignerInstance } from "./index";
import { decoder } from "../shared/bytes";

export const rustNative = {

  jsonValid(bytes: Uint8Array): number {
    return addon.jsonValid(bytes) ? 1 : 0;
  },

  jsonSumIds(bytes: Uint8Array): bigint {
    return BigInt(addon.jsonSumIds(bytes));
  },

  fnv1a64(bytes: Uint8Array): bigint {
    return BigInt(addon.fnv1a64(bytes));
  },
  cookieParse(bytes: Uint8Array): Uint8Array {
    return addon.cookieParse(bytes);
  },

  crc32(bytes: Uint8Array): number {
    return addon.crc32(bytes);
  },




  httpParseRequest(bytes: Uint8Array): Uint8Array {
    return addon.httpParseRequest(bytes);
  },



  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
    return addon.jsonPatch(doc, patch);
  },

  queryParse(bytes: Uint8Array): Uint8Array {
    return addon.queryParse(bytes);
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

  createRouter(routes: string[]) {
    return new addon.HttpRouter(routes);
  },

  initThreadPool(rayonThreads?: number) {
    return addon.initThreadPool(rayonThreads);
  },

  rayonNumThreads() {
    return addon.rayonNumThreads();
  },

  httpParseRequestPacked(bytes: Uint8Array): Uint8Array {
    return addon.httpParseRequestPacked(bytes);
  },

  httpParseRequestPackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return addon.httpParseRequestPackedInto(bytes, out);
  },

  queryParsePacked(bytes: Uint8Array): Uint8Array {
    return addon.queryParsePacked(bytes);
  },

  queryParsePackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return addon.queryParsePackedInto(bytes, out);
  },

  cookieParsePacked(bytes: Uint8Array): Uint8Array {
    return addon.cookieParsePacked(bytes);
  },

  cookieParsePackedInto(bytes: Uint8Array, out: Uint8Array): number {
    return addon.cookieParsePackedInto(bytes, out);
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
};


const mimeByBytes = new WeakMap<Uint8Array, Uint8Array>();
const mimeByText = new Map<string, Uint8Array>();

const hmacByBytes = new WeakMap<Uint8Array, HmacSignerInstance>();
const hmacByText = new Map<string, HmacSignerInstance>();

function normalizeExt(ext: Uint8Array): string {
  let s = decoder.decode(ext);
  if (s.charCodeAt(0) === 46) s = s.slice(1); // strip leading "."
  return s.toLowerCase();
}

function cachedMime(ext: Uint8Array): Uint8Array {
  const direct = mimeByBytes.get(ext);
  if (direct) return direct;

  const key = normalizeExt(ext);
  let val = mimeByText.get(key);

  if (!val) {
    val = addon.mimeFromExtension(ext);
    mimeByText.set(key, val);
  }

  mimeByBytes.set(ext, val);
  return val;
}

function getHmacSigner(key: Uint8Array): HmacSignerInstance {
  const direct = hmacByBytes.get(key);
  if (direct) return direct;

  // Optional text-based cache for textual keys.
  // If your keys are sensitive binary material and you do not want
  // decoded key strings retained in memory, remove this branch.
  let keyText = "";
  try {
    keyText = decoder.decode(key);
  } catch {
    keyText = "";
  }

  let signer = keyText ? hmacByText.get(keyText) : undefined;

  if (!signer) {
    signer = new addon.HmacSigner(key);
    if (keyText) hmacByText.set(keyText, signer);
  }

  hmacByBytes.set(key, signer);
  return signer;
}