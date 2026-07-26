// src/ingress/index.ts — OPTIMIZED FOR BUN 1.4
//
// Key optimizations:
// - Direct header access via .get() instead of iteration (O(1) vs O(n))
// - Pre-allocated scratch buffer with no re-allocation in hot path
// - Minimal encoding work (only headers Rust needs)
// - No TextDecoder/TextEncoder allocation per request

import addon from "../native";
import { unpackIngressLazy, type IngressResultLazy } from "./unpack";

export * from "./unpack";

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string;
  hsts?: boolean;
  hstsMaxAge?: number;
  hstsIncludeSubdomains?: boolean;
  hstsPreload?: boolean;
  frameOptions?: string;
  nosniff?: boolean;
  referrerPolicy?: string;
  coep?: string;
  coop?: string;
  corp?: string;
  xssProtection?: string;
}

export interface CorsOptions {
  allowOrigin?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
}

export interface IngressOptions {
  trustProxy?: boolean;
  parseCookies?: boolean;
  parseQuery?: boolean;
  requireJsonBody?: boolean;
  schema?: Uint8Array;
  cors?: CorsOptions;
  rateLimit?: RateLimitOptions;
  security?: SecurityHeadersOptions;
  https?: boolean;
  maxBodyBytes?: number;
  enableSecurityHeaders?: boolean;
  enableRequestIds?: boolean;
  enableCacheKey?: boolean;
  enablePathQuery?: boolean;
  enableBodySizeGuard?: boolean;
  readBody?: boolean;
}

export interface IngressHandler {
  (req: Request, ip?: string): Promise<IngressResultLazy>;
}

interface HeaderPackingOptions {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

// ── Pre-allocated scratch buffer ──
// 64KB is enough for any realistic request meta.
// No re-allocation in the hot path.
const META_BUF_SIZE = 65536;
let metaBuf = new Uint8Array(META_BUF_SIZE);
let metaView = new DataView(metaBuf.buffer);

const EMPTY_BODY = new Uint8Array(0);
const encoder = new TextEncoder();

// Body cache to prevent double-reads
const bodyCache = new WeakMap<Request, Promise<Uint8Array>>();

/**
 * Pack request meta into the pre-allocated buffer.
 * Uses direct header .get() calls instead of iteration.
 * Bun 1.4's Headers.get() is O(1) hash lookup.
 */
function packMeta(
  req: Request,
  socketIp: string,
  headerOpts: HeaderPackingOptions,
): Uint8Array {
  let offset = 0;

  // ── Method (u16 len + bytes) ──
  const method = req.method;
  const methodLen = method.length; // ASCII, 1 byte per char
  metaView.setUint16(offset, methodLen, true);
  offset += 2;
  for (let i = 0; i < methodLen; i++) {
    metaBuf[offset + i] = method.charCodeAt(i);
  }
  offset += methodLen;

  // ── URL (u32 len + bytes) ──
  const url = req.url;
  const urlLen = url.length;
  metaView.setUint32(offset, urlLen, true);
  offset += 4;
  for (let i = 0; i < urlLen; i++) {
    metaBuf[offset + i] = url.charCodeAt(i);
  }
  offset += urlLen;

  // ── Socket IP (u16 len + bytes) ──
  const ipLen = socketIp.length;
  metaView.setUint16(offset, ipLen, true);
  offset += 2;
  for (let i = 0; i < ipLen; i++) {
    metaBuf[offset + i] = socketIp.charCodeAt(i);
  }
  offset += ipLen;

  // ── Packed headers ──
  const headersLenPos = offset;
  offset += 4; // placeholder for total headers length
  const packedHeadersStart = offset;
  offset += 2; // placeholder for count

  let count = 0;
  const headers = req.headers;

  // Direct O(1) access — no iteration, no toLowerCase(), no switch
  if (headerOpts.cookie) {
    const v = headers.get("cookie");
    if (v !== null) {
      offset = writeHeaderPair(offset, "cookie", v);
      count++;
    }
  }

  if (headerOpts.cors) {
    const origin = headers.get("origin");
    if (origin !== null) {
      offset = writeHeaderPair(offset, "origin", origin);
      count++;
    }
    const acrm = headers.get("access-control-request-method");
    if (acrm !== null) {
      offset = writeHeaderPair(offset, "access-control-request-method", acrm);
      count++;
    }
    const acrh = headers.get("access-control-request-headers");
    if (acrh !== null) {
      offset = writeHeaderPair(offset, "access-control-request-headers", acrh);
      count++;
    }
  }

  if (headerOpts.proxy) {
    const xff = headers.get("x-forwarded-for");
    if (xff !== null) {
      offset = writeHeaderPair(offset, "x-forwarded-for", xff);
      count++;
    }
    const xri = headers.get("x-real-ip");
    if (xri !== null) {
      offset = writeHeaderPair(offset, "x-real-ip", xri);
      count++;
    }
  }

  if (headerOpts.proto) {
    const xfp = headers.get("x-forwarded-proto");
    if (xfp !== null) {
      offset = writeHeaderPair(offset, "x-forwarded-proto", xfp);
      count++;
    }
  }

  // Write count and total length
  metaView.setUint16(packedHeadersStart, count, true);
  metaView.setUint32(headersLenPos, offset - packedHeadersStart, true);

  return metaBuf.subarray(0, offset);
}

/**
 * Write a single header pair: [u16 name_len][name_lower][u32 value_len][value]
 * Header names are already lowercase constants — no toLowerCase() needed.
 */
function writeHeaderPair(offset: number, name: string, value: string): number {
  // Name is always a known lowercase constant
  const nameLen = name.length;
  metaView.setUint16(offset, nameLen, true);
  offset += 2;
  for (let i = 0; i < nameLen; i++) {
    metaBuf[offset + i] = name.charCodeAt(i);
  }
  offset += nameLen;

  // Value — use encodeInto for potential multi-byte chars
  const maxValBytes = value.length * 3;
  const valLenPos = offset;
  offset += 4;
  const dest = metaBuf.subarray(offset, offset + maxValBytes);
  const { written } = encoder.encodeInto(value, dest);
  metaView.setUint32(valLenPos, written, true);
  offset += written;

  return offset;
}

function getSocketIp(req: Request, ip?: string): string {
  if (ip && ip.length > 0) return ip;
  const r = req as any;
  if (typeof r.socket?.remoteAddress === "string") return r.socket.remoteAddress;
  if (typeof r.socket?.address?.ip === "string") return r.socket.address.ip;
  if (typeof r.socket?.address === "string") return r.socket.address;
  return "";
}

function shouldReadBody(req: Request, wantsBody: boolean): boolean {
  if (!wantsBody) return false;
  const method = req.method;
  if (method === "OPTIONS" || method === "HEAD" || method === "TRACE") return false;
  if (req.body != null) return true;
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isBodyAlreadyUsedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("body") && (msg.includes("used") || msg.includes("consumed") || msg.includes("already"));
}

export function readRequestBodyOnce(req: Request): Promise<Uint8Array> {
  if (req.body === null) return Promise.resolve(EMPTY_BODY);
  const existing = bodyCache.get(req);
  if (existing) return existing;
  const p = req.arrayBuffer().then((buf) => new Uint8Array(buf)).catch((err) => {
    bodyCache.delete(req);
    throw err;
  });
  bodyCache.set(req, p);
  return p;
}

export function createIngress(options: IngressOptions = {}): IngressHandler {
  const handler = new (addon as any).Ingress(options);

  const wantsBody =
    options.readBody ?? (options.requireJsonBody === true || options.schema != null);

  const headerOpts: HeaderPackingOptions = {
    cookie: options.parseCookies !== false,
    cors: options.cors != null,
    proxy: options.trustProxy === true,
    proto: options.trustProxy === true && options.https === undefined,
  };

  return async function ingress(req: Request, ip?: string): Promise<IngressResultLazy> {
    let body: Uint8Array | null = null;

    if (shouldReadBody(req, wantsBody)) {
      try {
        body = await readRequestBodyOnce(req);
      } catch (err) {
        if (isBodyAlreadyUsedError(err)) {
          body = EMPTY_BODY;
        } else {
          throw err;
        }
      }
    }

    const socketIp = getSocketIp(req, ip);
    const meta = packMeta(req, socketIp, headerOpts);
    const packed = handler.handlePacked(meta, body);
    const result = unpackIngressLazy(packed as Uint8Array);

    // Attach JS-owned body (Rust never echoes it back)
    if (body !== null) {
      result.body = body;
    }

    return result;
  };
}