import addon from "./index";

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



  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
    return addon.hmacSha256(key, data);
  },

  httpParseRequest(bytes: Uint8Array): Uint8Array {
    return addon.httpParseRequest(bytes);
  },



  jsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
    return addon.jsonPatch(doc, patch);
  },

  mimeFromExtension(ext: Uint8Array): Uint8Array {
    return addon.mimeFromExtension(ext);
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

  hmacSha256Verify(
    key: Uint8Array,
    data: Uint8Array,
    sig: Uint8Array,
  ): number {
    return addon.hmacSha256Verify(key, data, sig) ? 1 : 0;
  },
};