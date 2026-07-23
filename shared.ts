export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/** Ensure a Uint8Array is backed by a plain ArrayBuffer (not SharedArrayBuffer). */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

// ===========================================================================
// EXISTING FUNCTIONS
// ===========================================================================

export function nativeJsonSum(bytes: Uint8Array): bigint {
  const text = decoder.decode(bytes);
  const rows = JSON.parse(text) as Array<{ id: number }>;
  let sum = 0;
  for (const row of rows) {
    sum += row.id;
  }
  return BigInt(sum);
}

export function nativeJsonValid(bytes: Uint8Array): boolean {
  try {
    JSON.parse(decoder.decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function nativeProductsAddBytes(bytes: Uint8Array): Uint8Array {
  const body = JSON.parse(decoder.decode(bytes));
  return encoder.encode(JSON.stringify({ created: true, body }));
}

export function nativeProductsGetIdBytes(id: string): Uint8Array {
  return encoder.encode(JSON.stringify({ product: { id } }));
}

export function nativeBatch(ops: any[]): any[] {
  return ops.map((op) => {
    switch (op?.op) {
      case "products.add":
        return { id: String(op?.id ?? ""), status: 201, body: { created: true, body: op?.body ?? {} } };
      case "products.get":
        return { id: String(op?.id ?? ""), status: 200, body: { product: { id: String(op?.params?.id ?? "") } } };
      default:
        return { id: String(op?.id ?? ""), status: 404, body: { error: "Unknown op" } };
    }
  });
}

export function nativeBatchBytes(bytes: Uint8Array): Uint8Array {
  const ops = JSON.parse(decoder.decode(bytes));
  return encoder.encode(JSON.stringify(nativeBatch(ops)));
}

export function nativeUrlSumHostLens(bytes: Uint8Array): bigint {
  const text = decoder.decode(bytes);
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      sum += new URL(line).hostname.length;
    } catch {
      // ignore
    }
  }
  return BigInt(sum);
}

export function nativePrimeCount(limit: number): number {
  if (limit < 2) return 0;
  const isPrime = new Uint8Array(limit + 1).fill(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let p = 2; p * p <= limit; p++) {
    if (isPrime[p]) {
      for (let m = p * p; m <= limit; m += p) isPrime[m] = 0;
    }
  }
  let count = 0;
  for (let i = 2; i <= limit; i++) if (isPrime[i]) count++;
  return count;
}

export function nativeHashU64(bytes: Uint8Array): bigint {
  return xxhash3U64(bytes);
}

export function nativeSha256U64(bytes: Uint8Array): bigint {
  const digest = new Bun.CryptoHasher("sha256").update(toBuffer(bytes)).digest();
  const digestBytes = new Uint8Array(
    (digest as Uint8Array).buffer as ArrayBuffer,
    (digest as Uint8Array).byteOffset,
    (digest as Uint8Array).byteLength,
  );
  return new DataView(
    digestBytes.buffer,
    digestBytes.byteOffset,
    digestBytes.byteLength,
  ).getBigUint64(0, false);
}

export function nativeTaskProcess(bytes: Uint8Array): Uint8Array {
  const input = JSON.parse(decoder.decode(bytes)) as { events: Array<{ id: number }> };
  let sum = 0;
  for (const event of input.events) sum += event.id;

  return encoder.encode(
    JSON.stringify({
      count: input.events.length,
      sum,
      hash: String(xxhash3U64(bytes)),
    }),
  );
}
// ===========================================================================
// HTTP PARSING
// ===========================================================================

export function nativeHttpParseRequest(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const lines = text.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  const method = parts[0] ?? "";
  const path = parts[1] ?? "";
  const version = parts[2] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) break;
    const colonIdx = line.indexOf(":");
    if (colonIdx >= 0) {
      headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
    }
  }
  return encoder.encode(JSON.stringify({ method, path, version, headers }));
}

export function nativeQueryParse(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const params: Record<string, any> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    const key = decodeURIComponent(eqIdx >= 0 ? pair.slice(0, eqIdx) : pair);
    const value = decodeURIComponent(eqIdx >= 0 ? pair.slice(eqIdx + 1) : "");
    if (key.endsWith("[]")) {
      const arrKey = key.slice(0, -2);
      if (!Array.isArray(params[arrKey])) params[arrKey] = [];
      params[arrKey].push(value);
    } else {
      params[key] = value;
    }
  }
  return encoder.encode(JSON.stringify(params));
}

export function nativeCookieParse(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies: Record<string, string> = {};
  for (const pair of text.split(";")) {
    const trimmed = pair.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx >= 0) {
      cookies[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return encoder.encode(JSON.stringify(cookies));
}

export function nativeCookieSerialize(
  name: string, value: string, maxAge: number,
  secure: boolean, httpOnly: boolean, sameSite: number,
): Uint8Array {
  let cookie = `${name}=${value}`;
  if (maxAge >= 0) cookie += `; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  if (httpOnly) cookie += "; HttpOnly";
  const ss = sameSite === 1 ? "Lax" : sameSite === 2 ? "Strict" : "None";
  cookie += `; SameSite=${ss}; Path=/`;
  return encoder.encode(cookie);
}

export function nativeUrlEncode(text: string): string {
  return encodeURIComponent(text);
}

export function nativeUrlDecode(text: string): string {
  return decodeURIComponent(text);
}

// ===========================================================================
// ROUTING
// ===========================================================================

export function nativeRouteMatch(pattern: string, path: string): Uint8Array | null {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  const lastPattern = patternSegments[patternSegments.length - 1];
  if (patternSegments.length !== pathSegments.length) {
    if (lastPattern !== "*") return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patSeg = patternSegments[i] ?? "";
    if (patSeg === "*") {
      params["*"] = pathSegments.slice(i).join("/");
      break;
    }
    if (i >= pathSegments.length) return null;
    const pathSeg = pathSegments[i] ?? "";
    if (patSeg.startsWith(":")) {
      params[patSeg.slice(1)] = pathSeg;
    } else if (patSeg !== pathSeg) {
      return null;
    }
  }
  return encoder.encode(JSON.stringify(params));
}

export function nativeRouteBuild(pattern: string, params: Record<string, string>): Uint8Array {
  let result = pattern;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, value);
  }
  return encoder.encode(result);
}

// ===========================================================================
// VALIDATION
// ===========================================================================

export function nativeValidateEmail(bytes: Uint8Array): boolean {
  const email = decoder.decode(bytes);
  if (email.length < 3 || email.length > 254) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (!local || local.length > 64 || !domain || domain.length > 253) return false;
  if (!domain.includes(".")) return false;
  return /^[a-zA-Z0-9._%+-]+$/.test(local) && /^[a-zA-Z0-9.-]+$/.test(domain);
}

export function nativeValidateUuid(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
}

export function nativeValidateIpv4(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const octets = text.split(".");
  if (octets.length !== 4) return false;
  return octets.every((o) => {
    if (!o || o.length > 3) return false;
    const n = Number(o);
    return Number.isInteger(n) && n >= 0 && n <= 255 && (o.length === 1 || o[0] !== "0");
  });
}

export function nativeValidateIpv6(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const parts = text.split("::");
  if (parts.length > 2) return false;
  let totalGroups = 0;
  for (const part of parts) {
    if (!part) continue;
    const groups = part.split(":");
    for (const group of groups) {
      if (!group || group.length > 4) return false;
      if (!/^[0-9a-fA-F]+$/.test(group)) return false;
      totalGroups++;
    }
  }
  if (parts.length === 2) return totalGroups <= 7;
  return totalGroups === 8;
}

export function nativeValidateLuhn(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const digits = text.replace(/\D/g, "").split("").map(Number);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i] ?? 0;
    if (alternate) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function nativeValidateJwtStructure(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  const parts = text.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[a-zA-Z0-9\-_=]+$/.test(p));
}

// ===========================================================================
// CRYPTO & ENCODING
// ===========================================================================

export function nativeHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const hmac = new Bun.CryptoHasher("sha256", toBuffer(key));
  hmac.update(toBuffer(data));
  const hex = hmac.digest("hex");
  return encoder.encode(hex);
}

export function nativeHmacSha256Verify(key: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  const expected = decoder.decode(nativeHmacSha256(key, data));
  const provided = decoder.decode(sig);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export function nativeBase64Encode(bytes: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(bytes).toString("base64"));
}

export function nativeBase64Decode(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.from(decoder.decode(bytes), "base64"));
}

export function nativeBase64UrlEncode(bytes: Uint8Array): Uint8Array {
  const b64 = Buffer.from(bytes).toString("base64");
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return encoder.encode(urlSafe);
}

export function nativeUuidV4(): string {
  return crypto.randomUUID();
}

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return encoder.encode(hex);
}

// ===========================================================================
// COMPRESSION
// ===========================================================================

export function nativeGzipCompress(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.gzipSync(toBuffer(bytes)));
}

export function nativeGzipDecompress(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Bun.gunzipSync(toBuffer(bytes)));
}

export function nativeCompressionRatio(bytes: Uint8Array): number {
  const compressed = nativeGzipCompress(bytes);
  return compressed.length / bytes.length;
}

// ===========================================================================
// STRING PROCESSING
// ===========================================================================

export function nativeHtmlEscape(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
  return encoder.encode(escaped);
}

export function nativeSlugify(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes).toLowerCase();
  const slug = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return encoder.encode(slug);
}

export function nativeTemplateRender(template: string, data: Record<string, any>): Uint8Array {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`{{${key}}}`, String(value));
  }
  return encoder.encode(result);
}

export function nativeRegexMatch(pattern: string, text: string): boolean {
  return new RegExp(pattern).test(text);
}

export function nativeRegexReplace(pattern: string, replacement: string, text: string): Uint8Array {
  const result = text.replace(new RegExp(pattern, "g"), replacement);
  return encoder.encode(result);
}

export function nativeTrim(bytes: Uint8Array): Uint8Array {
  return encoder.encode(decoder.decode(bytes).trim());
}

export function nativeCaseConvert(bytes: Uint8Array, mode: number): Uint8Array {
  const text = decoder.decode(bytes);
  let result: string;
  switch (mode) {
    case 0: result = text.toLowerCase(); break;
    case 1: result = text.toUpperCase(); break;
    case 2:
      result = text.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase());
      break;
    default: result = text;
  }
  return encoder.encode(result);
}

// ===========================================================================
// DATA PROCESSING
// ===========================================================================

export function nativeJsonSortBy(bytes: Uint8Array, key: string, descending: boolean): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  arr.sort((a: any, b: any) => {
    const diff = (a[key] ?? 0) - (b[key] ?? 0);
    return descending ? -diff : diff;
  });
  return encoder.encode(JSON.stringify(arr));
}

export function nativeJsonPaginate(bytes: Uint8Array, page: number, perPage: number): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const total = arr.length;
  const totalPages = Math.ceil(total / perPage);
  const start = (page - 1) * perPage;
  const data = arr.slice(start, start + perPage);
  return encoder.encode(JSON.stringify({ data, total, page, per_page: perPage, total_pages: totalPages }));
}

export function nativeJsonFilter(bytes: Uint8Array, key: string, value: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const filtered = arr.filter((item) => String(item[key] ?? "") === value);
  return encoder.encode(JSON.stringify(filtered));
}

export function nativeJsonAggregate(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const values: number[] = [];
  for (const item of arr) {
    const v = item[key];
    if (typeof v === "number") values.push(v);
  }
  if (values.length === 0) {
    return encoder.encode(JSON.stringify({ count: 0, sum: 0, avg: 0, min: 0, max: 0 }));
  }
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return encoder.encode(JSON.stringify({ count: values.length, sum, avg: sum / values.length, min, max }));
}

export function nativeJsonGroupBy(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const groups: Record<string, any[]> = {};
  for (const item of arr) {
    const groupKey = String(item[key] ?? "null");
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(item);
  }
  return encoder.encode(JSON.stringify(groups));
}

export function nativeJsonDedup(bytes: Uint8Array, key: string): Uint8Array {
  const arr = JSON.parse(decoder.decode(bytes)) as any[];
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of arr) {
    const k = JSON.stringify(item[key]);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return encoder.encode(JSON.stringify(result));
}

// ===========================================================================
// CACHING & RATE LIMITING
// ===========================================================================

export function nativeRateLimitCheck(
  state: { tokens: number; lastRefillMs: number },
  capacity: number, refillRate: number, nowMs: number, cost: number,
): boolean {
  const elapsedSecs = (nowMs - state.lastRefillMs) / 1000;
  const newTokens = Math.min(state.tokens + elapsedSecs * refillRate, capacity);
  if (newTokens >= cost) {
    state.tokens = newTokens - cost;
    state.lastRefillMs = nowMs;
    return true;
  }
  state.tokens = newTokens;
  state.lastRefillMs = nowMs;
  return false;
}

export function xxhash3U64(bytes: Uint8Array): bigint {
  return BigInt(Bun.hash.xxHash64(bytes));
}

export function nativeEtagGenerate(bytes: Uint8Array): string {
  return `"${xxhash3U64(bytes).toString(16).padStart(16, "0")}"`;
}

export function nativeEtagCheck(etag: string, header: string): boolean {
  for (const candidate of header.split(",")) {
    const trimmed = candidate.trim();
    if (trimmed === "*" || trimmed === etag.trim()) return true;
  }
  return false;
}

// ===========================================================================
// HTTP RESPONSE
// ===========================================================================

export function nativeHttpResponseBuild(
  status: number, body: Uint8Array, contentType: string, extraHeaders: string,
): Uint8Array {
  const statusTexts: Record<number, string> = {
    200: "OK", 201: "Created", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
    422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  };
  const statusText = statusTexts[status] ?? "Unknown";
  let header = `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n`;
  if (extraHeaders) {
    header += extraHeaders;
    if (!extraHeaders.endsWith("\r\n")) header += "\r\n";
  }
  header += "Connection: keep-alive\r\n\r\n";
  const headerBytes = encoder.encode(header);
  const result = new Uint8Array(headerBytes.length + body.length);
  result.set(headerBytes);
  result.set(body, headerBytes.length);
  return result;
}

export function nativeErrorResponse(status: number, message: string, code: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    error: { status, code, message, timestamp: new Date().toISOString() },
  }));
}

// ===========================================================================
// CORS & SECURITY
// ===========================================================================

export function nativeCorsHeaders(
  origin: string, allowed: string, methods: string, maxAge: number,
): Uint8Array {
  const allowedOrigins = allowed.split(",").map((s) => s.trim());
  const isAllowed = allowedOrigins.includes("*") || allowedOrigins.includes(origin);
  if (!isAllowed) return encoder.encode("");
  const headers =
    `Access-Control-Allow-Origin: ${allowedOrigins.includes("*") ? "*" : origin}\r\n` +
    `Access-Control-Allow-Methods: ${methods}\r\n` +
    `Access-Control-Allow-Headers: Content-Type, Authorization\r\n` +
    `Access-Control-Max-Age: ${maxAge}\r\n`;
  return encoder.encode(headers);
}

export function nativeSecurityHeaders(): Uint8Array {
  const headers =
    "Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n" +
    "X-Content-Type-Options: nosniff\r\n" +
    "X-Frame-Options: DENY\r\n" +
    "X-XSS-Protection: 1; mode=block\r\n" +
    "Referrer-Policy: strict-origin-when-cross-origin\r\n" +
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'\r\n";
  return encoder.encode(headers);
}

// ===========================================================================
// WEBSOCKET
// ===========================================================================

export function nativeWsFrameParse(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 2) return null;
  const byte0 = bytes[0] ?? 0;
  const byte1 = bytes[1] ?? 0;
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let headerSize = 2;
  if (payloadLen === 126) {
    if (bytes.length < 4) return null;
    payloadLen = ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    headerSize = 4;
  } else if (payloadLen === 127) {
    if (bytes.length < 10) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + 2, 8);
    payloadLen = Number(view.getBigUint64(0));
    headerSize = 10;
  }
  if (masked) headerSize += 4;
  const opcodeNames: Record<number, string> = {
    0: "continuation", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong",
  };
  return encoder.encode(JSON.stringify({
    fin, opcode, opcode_name: opcodeNames[opcode] ?? "unknown",
    masked, payload_length: payloadLen, header_size: headerSize,
  }));
}

export function nativeWsFrameBuild(opcode: number, payload: Uint8Array): Uint8Array {
  const frame: number[] = [];
  frame.push(0x80 | (opcode & 0x0f));
  if (payload.length < 126) {
    frame.push(payload.length);
  } else if (payload.length < 65536) {
    frame.push(126);
    frame.push((payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    frame.push(127);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(payload.length));
    for (let i = 0; i < 8; i++) frame.push(view.getUint8(i));
  }
  const result = new Uint8Array(frame.length + payload.length);
  result.set(frame);
  result.set(payload, frame.length);
  return result;
}

export function nativeWsAcceptKey(key: string): string {
  const magic = "258EAFA5-E914-47DA-95CA-5AB5DC11BE85";
  const combined = encoder.encode(key + magic);
  // Use Bun's crypto for SHA-1
  const hash = new Bun.CryptoHasher("sha1").update(toBuffer(combined)).digest();
  return Buffer.from(hash).toString("base64");
}

// ===========================================================================
// MIME & CONTENT NEGOTIATION
// ===========================================================================

export function nativeMimeFromExtension(ext: string): string {
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
    txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", gzip: "application/gzip",
    mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
    wasm: "application/wasm", avif: "image/avif",
    yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
    md: "text/markdown; charset=utf-8",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

export function nativeContentNegotiate(accept: string, available: string[]): string | null {
  const acceptTypes = accept.split(",").map((part) => {
    const segments = part.trim().split(";");
    const type = segments[0]?.trim() ?? "*/*";
    const qParam = segments.find((p) => p.trim().startsWith("q="));
    const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1.0;
    return { type, q };
  });
  acceptTypes.sort((a, b) => b.q - a.q);
  for (const { type } of acceptTypes) {
    if (type === "*/*") return available[0] ?? null;
    for (const avail of available) {
      if (avail === type) return avail;
      if (type.endsWith("/*") && avail.startsWith(type.slice(0, -1))) return avail;
    }
  }
  return null;
}

// ===========================================================================
// LOGGING
// ===========================================================================

export function nativeLogFormat(
  level: string, message: string, context: Record<string, any>, requestId: string,
): Uint8Array {
  const log = {
    timestamp: new Date().toISOString(),
    level, message, request_id: requestId, context,
  };
  return encoder.encode(JSON.stringify(log) + "\n");
}

export function nativeHistogramBucket(durationUs: number): number {
  const buckets = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
  for (let i = 0; i < buckets.length; i++) {
    if (durationUs <= (buckets[i] ?? Infinity)) return i;
  }
  return 11;
}

// ===========================================================================
// PATH UTILITIES
// ===========================================================================

export function nativePathNormalize(path: string): string {
  const components: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") { components.pop(); } else { components.push(component); }
  }
  return "/" + components.join("/");
}

export function nativePathIsSafe(path: string): boolean {
  return !path.includes("..") && !path.includes("\0");
}

export function nativePathJoin(base: string, segment: string): string {
  const baseTrimmed = base.replace(/\/+$/, "");
  const segTrimmed = segment.replace(/^\/+/, "");
  return `${baseTrimmed}/${segTrimmed}`;
}

// ===========================================================================
// SEARCH
// ===========================================================================

export function nativeBinarySearch(bytes: Uint8Array, target: number): number {
  const arr = JSON.parse(decoder.decode(bytes)) as number[];
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid] ?? 0;
    if (midVal === target) return mid;
    if (midVal < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function nativeTextSearchCount(text: Uint8Array, term: Uint8Array): number {
  const textStr = decoder.decode(text);
  const termStr = decoder.decode(term);
  if (!termStr) return 0;
  let count = 0, pos = 0;
  while ((pos = textStr.indexOf(termStr, pos)) !== -1) { count++; pos++; }
  return count;
}

export function nativeInvertedIndexBuild(bytes: Uint8Array): Uint8Array {
  const docs = JSON.parse(decoder.decode(bytes)) as Array<{ id: string; text: string }>;
  const index: Record<string, string[]> = {};
  for (const doc of docs) {
    for (const word of doc.text.split(/\s+/)) {
      const cleaned = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned) {
        if (!index[cleaned]) index[cleaned] = [];
        index[cleaned].push(doc.id);
      }
    }
  }
  return encoder.encode(JSON.stringify(index));
}

// ===========================================================================
// MATH & ENCODING
// ===========================================================================

export function nativeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function nativeFnv1a64(bytes: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i] ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash;
}

export function nativeItoa(value: number): string {
  return String(value);
}

export function nativeAtoi(text: string): number {
  return parseInt(text.trim(), 10) || 0;
}

export function nativeFormatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(2)} KB`;
  if (byteCount < 1024 * 1024 * 1024) return `${(byteCount / (1024 * 1024)).toFixed(2)} MB`;
  return `${(byteCount / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ===========================================================================
// PIPELINE
// ===========================================================================

export function nativeJsonPipeline(data: Uint8Array, ops: Uint8Array): Uint8Array {
  let obj = JSON.parse(decoder.decode(data));
  const operations = JSON.parse(decoder.decode(ops)) as Array<{
    op: string; field: string; value?: any; new_name?: string;
  }>;
  for (const operation of operations) {
    if (typeof obj !== "object" || obj === null) break;
    switch (operation.op) {
      case "add_field":
      case "set_field":
        obj[operation.field] = operation.value;
        break;
      case "remove_field":
        delete obj[operation.field];
        break;
      case "rename_field":
        if (operation.new_name && operation.field in obj) {
          obj[operation.new_name] = obj[operation.field];
          delete obj[operation.field];
        }
        break;
      case "uppercase_field":
        if (typeof obj[operation.field] === "string") {
          obj[operation.field] = obj[operation.field].toUpperCase();
        }
        break;
    }
  }
  return encoder.encode(JSON.stringify(obj));
}

// ===========================================================================
// CONNECTION & PROTOCOL
// ===========================================================================

export function nativeParseHost(host: string): { hostname: string; port: number } {
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx >= 0 && !host.includes("[")) {
    const portStr = host.slice(colonIdx + 1);
    if (/^\d+$/.test(portStr)) {
      return { hostname: host.slice(0, colonIdx), port: parseInt(portStr, 10) };
    }
  }
  return { hostname: host, port: 80 };
}

export function nativeUrlBuild(
  scheme: string, host: string, port: number, path: string, query: string,
): string {
  let url = `${scheme}://${host}`;
  const defaultPort = scheme === "https" ? 443 : 80;
  if (port !== 0 && port !== defaultPort) url += `:${port}`;
  if (path) {
    if (!path.startsWith("/")) url += "/";
    url += path;
  }
  if (query) url += `?${query}`;
  return url;
}

export function nativeContentTypeParse(header: string): { mime_type: string; params: Record<string, string> } {
  const parts = header.split(";");
  const mimeType = (parts[0] ?? "").trim();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = (parts[i] ?? "").trim();
    const eqIdx = part.indexOf("=");
    if (eqIdx >= 0) {
      params[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return { mime_type: mimeType, params };
}

// ===========================================================================
// JSON UTILITIES
// ===========================================================================

export function nativeJsonExtract(bytes: Uint8Array, keyPath: string): Uint8Array | null {
  const obj = JSON.parse(decoder.decode(bytes));
  let current: any = obj;
  for (const segment of keyPath.split(".")) {
    if (current == null) return null;
    if (Array.isArray(current)) {
      const idx = parseInt(segment, 10);
      if (isNaN(idx) || idx >= current.length) return null;
      current = current[idx];
    } else if (typeof current === "object") {
      current = current[segment];
    } else {
      return null;
    }
  }
  return encoder.encode(JSON.stringify(current));
}

export function nativeJsonFlatten(bytes: Uint8Array): Uint8Array {
  const obj = JSON.parse(decoder.decode(bytes));
  const flat: Record<string, any> = {};
  function flatten(value: any, prefix: string): void {
    if (value === null || typeof value !== "object") {
      flat[prefix] = value;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) flatten(value[i], `${prefix}.${i}`);
    } else {
      for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k);
    }
  }
  flatten(obj, "");
  return encoder.encode(JSON.stringify(flat));
}

export function nativeJsonMerge(bytes1: Uint8Array, bytes2: Uint8Array): Uint8Array {
  const obj1 = JSON.parse(decoder.decode(bytes1));
  const obj2 = JSON.parse(decoder.decode(bytes2));
  return encoder.encode(JSON.stringify({ ...obj1, ...obj2 }));
}


export function nativeJsonPatch(doc: Uint8Array, patch: Uint8Array): Uint8Array {
  const obj = JSON.parse(decoder.decode(doc));
  const ops = JSON.parse(decoder.decode(patch)) as Array<{ op: string; path: string; value?: any }>;
  for (const operation of ops) {
    const segments = operation.path.replace(/^\//, "").split("/");
    let current: any = obj;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] ?? "";
      if (Array.isArray(current)) current = current[parseInt(seg, 10)];
      else current = current[seg];
      if (current == null) break;
    }
    const lastSeg = segments[segments.length - 1] ?? "";
    if (current == null) continue;
    switch (operation.op) {
      case "replace":
      case "add":
        if (Array.isArray(current)) current[parseInt(lastSeg, 10)] = operation.value;
        else current[lastSeg] = operation.value;
        break;
      case "remove":
        if (Array.isArray(current)) current.splice(parseInt(lastSeg, 10), 1);
        else delete current[lastSeg];
        break;
    }
  }
  return encoder.encode(JSON.stringify(obj));
}

// Add to shared.ts
export function nativeMultipartParse(bytes: Uint8Array, boundary: string): Uint8Array {
  const text = decoder.decode(bytes);
  const delimiter = `--${boundary}`;
  const parts: any[] = [];
  let pos = 0;
  
  while (pos < text.length) {
    const start = text.indexOf(delimiter, pos);
    if (start === -1) break;
    
    const headerStart = start + delimiter.length;
    if (text.startsWith("--", headerStart)) break; // closing boundary
    
    let hStart = headerStart;
    if (text.startsWith("\r\n", hStart)) hStart += 2;
    
    const headerEnd = text.indexOf("\r\n\r\n", hStart);
    if (headerEnd === -1) break;
    
    const headersText = text.slice(hStart, headerEnd);
    const bodyStart = headerEnd + 4;
    const bodyEnd = text.indexOf(delimiter, bodyStart);
    const actualBodyEnd = bodyEnd === -1 ? text.length : bodyEnd - 2;
    
    const nameMatch = headersText.match(/name="([^"]+)"/);
    const filenameMatch = headersText.match(/filename="([^"]+)"/);
    const ctMatch = headersText.match(/Content-Type:\s*(.+)/i);
    
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filenameMatch ? filenameMatch[1] : "",
      content_type: ctMatch ? ctMatch[1]?.trim() : "",
      size: Math.max(0, actualBodyEnd - bodyStart),
    });
    pos = bodyEnd === -1 ? text.length : bodyEnd;
  }
  return encoder.encode(JSON.stringify(parts));
}