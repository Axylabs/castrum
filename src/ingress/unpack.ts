// src/ingress/unpack.ts — OPTIMIZED FOR OUTPUT FORMAT v3
//
// v3 format (no path, no raw_query, no body echo):
//   [u8 version=3]
//   [u8 verdict]
//   [u16 status]
//   [u32 flags]
//   [u64 cache_key]
//   [u32 request_id_len][request_id]
//   [u32 trace_id_len][trace_id]
//   [u32 span_id_len][span_id]
//   [u32 rate_remaining]
//   [u64 rate_reset_ms]
//   [u32 response_headers_count]
//   repeated: [u32 name_len][name][u32 value_len][value]
//   [u32 cookies_len][cookies_packed]
//   [u32 query_len][query_packed]
//   [u32 error_body_len][error_body]

import { decoder } from "../shared/bytes";
import { readPairsPacked, type Pair } from "../shared/packed";

export const INGRESS_FLAG_HAS_COOKIES = 1 << 0;
export const INGRESS_FLAG_HAS_QUERY = 1 << 1;
export const INGRESS_FLAG_BODY_VALID_JSON = 1 << 2;
export const INGRESS_FLAG_SCHEMA_VALID = 1 << 3;
export const INGRESS_FLAG_CORS_ALLOWED = 1 << 4;
export const INGRESS_FLAG_IS_PREFLIGHT = 1 << 5;
export const INGRESS_FLAG_RATE_LIMITED = 1 << 6;
export const INGRESS_FLAG_HTTPS = 1 << 7;
export const INGRESS_FLAG_TRUSTED_PROXY = 1 << 8;

export type IngressVerdict = "continue" | "reject" | "preflight";

export interface IngressResultLazy {
  readonly version: number;
  readonly verdict: IngressVerdict;
  readonly verdictCode: number;
  readonly status: number;
  readonly flags: number;
  readonly hasCookies: boolean;
  readonly hasQuery: boolean;
  readonly bodyValidJson: boolean;
  readonly schemaValid: boolean;
  readonly corsAllowed: boolean;
  readonly isPreflight: boolean;
  readonly rateLimited: boolean;
  readonly https: boolean;
  readonly trustedProxy: boolean;
  readonly cacheKey: bigint;
  readonly rateLimitRemaining: number;
  readonly rateLimitResetMs: bigint;
  requestId(): string;
  traceId(): string;
  spanId(): string;
  errorBodyText(): string;
  responseHeaders(): Pair[];
  cookies(): Pair[];
  query(): Pair[];
  readonly errorBody: Uint8Array;
  body: Uint8Array;
  readonly responseHeadersRaw: Uint8Array;
  readonly cookiesPacked: Uint8Array;
  readonly queryPacked: Uint8Array;
}

const EMPTY_BYTES = new Uint8Array(0);

class IngressResultLazyImpl implements IngressResultLazy {
  readonly version: number;
  readonly verdict: IngressVerdict;
  readonly verdictCode: number;
  readonly status: number;
  readonly flags: number;
  readonly hasCookies: boolean;
  readonly hasQuery: boolean;
  readonly bodyValidJson: boolean;
  readonly schemaValid: boolean;
  readonly corsAllowed: boolean;
  readonly isPreflight: boolean;
  readonly rateLimited: boolean;
  readonly https: boolean;
  readonly trustedProxy: boolean;
  readonly cacheKey: bigint;
  readonly rateLimitRemaining: number;
  readonly rateLimitResetMs: bigint;
  readonly errorBody: Uint8Array;
  body: Uint8Array;
  readonly responseHeadersRaw: Uint8Array;
  readonly cookiesPacked: Uint8Array;
  readonly queryPacked: Uint8Array;

  private bytes: Uint8Array;
  private requestIdOffset: number;
  private requestIdLen: number;
  private traceIdOffset: number;
  private traceIdLen: number;
  private spanIdOffset: number;
  private spanIdLen: number;
  private responseHeadersOffset: number;
  private responseHeadersCount: number;
  private errorBodyOffset: number;
  private errorBodyLen: number;

  private _requestId?: string;
  private _traceId?: string;
  private _spanId?: string;
  private _errorBodyText?: string;
  private _responseHeaders?: Pair[];
  private _cookies?: Pair[];
  private _query?: Pair[];

  constructor(input: Uint8Array) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input as any);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    const version = dv.getUint8(offset); offset += 1;
    if (version !== 3) {
      throw new Error(`unsupported ingress packed version: ${version}`);
    }

    const verdictCode = dv.getUint8(offset); offset += 1;
    const status = dv.getUint16(offset, true); offset += 2;
    const flags = dv.getUint32(offset, true); offset += 4;
    const cacheKey = dv.getBigUint64(offset, true); offset += 8;

    // Request ID
    const requestIdOffset = offset;
    const requestIdLen = dv.getUint32(offset, true);
    offset += 4 + requestIdLen;

    // Trace ID
    const traceIdOffset = offset;
    const traceIdLen = dv.getUint32(offset, true);
    offset += 4 + traceIdLen;

    // Span ID
    const spanIdOffset = offset;
    const spanIdLen = dv.getUint32(offset, true);
    offset += 4 + spanIdLen;

    const rateLimitRemaining = dv.getUint32(offset, true); offset += 4;
    const rateLimitResetMs = dv.getBigUint64(offset, true); offset += 8;

    // Response headers — skip to compute end offset
    const responseHeadersOffset = offset;
    const responseHeadersCount = dv.getUint32(offset, true);
    offset += 4;
    for (let i = 0; i < responseHeadersCount; i++) {
      const kl = dv.getUint32(offset, true); offset += 4 + kl;
      const vl = dv.getUint32(offset, true); offset += 4 + vl;
    }
    const responseHeadersEnd = offset;

    // Cookies
    const cookiesPackedOffset = offset;
    const cookiesPackedLen = dv.getUint32(offset, true);
    offset += 4 + cookiesPackedLen;

    // Query
    const queryPackedOffset = offset;
    const queryPackedLen = dv.getUint32(offset, true);
    offset += 4 + queryPackedLen;

    // Error body
    const errorBodyOffset = offset;
    const errorBodyLen = dv.getUint32(offset, true);
    offset += 4 + errorBodyLen;

    // v3: NO path, NO raw_query, NO body

    const verdict: IngressVerdict =
      verdictCode === 0 ? "continue" : verdictCode === 1 ? "reject" : "preflight";
    const has = (bit: number): boolean => (flags & bit) !== 0;

    this.bytes = bytes;
    this.version = version;
    this.verdict = verdict;
    this.verdictCode = verdictCode;
    this.status = status;
    this.flags = flags;
    this.hasCookies = has(INGRESS_FLAG_HAS_COOKIES);
    this.hasQuery = has(INGRESS_FLAG_HAS_QUERY);
    this.bodyValidJson = has(INGRESS_FLAG_BODY_VALID_JSON);
    this.schemaValid = has(INGRESS_FLAG_SCHEMA_VALID);
    this.corsAllowed = has(INGRESS_FLAG_CORS_ALLOWED);
    this.isPreflight = has(INGRESS_FLAG_IS_PREFLIGHT);
    this.rateLimited = has(INGRESS_FLAG_RATE_LIMITED);
    this.https = has(INGRESS_FLAG_HTTPS);
    this.trustedProxy = has(INGRESS_FLAG_TRUSTED_PROXY);
    this.cacheKey = cacheKey;
    this.rateLimitRemaining = rateLimitRemaining;
    this.rateLimitResetMs = rateLimitResetMs;

    this.requestIdOffset = requestIdOffset;
    this.requestIdLen = requestIdLen;
    this.traceIdOffset = traceIdOffset;
    this.traceIdLen = traceIdLen;
    this.spanIdOffset = spanIdOffset;
    this.spanIdLen = spanIdLen;
    this.responseHeadersOffset = responseHeadersOffset;
    this.responseHeadersCount = responseHeadersCount;
    this.errorBodyOffset = errorBodyOffset;
    this.errorBodyLen = errorBodyLen;

    this.responseHeadersRaw = bytes.subarray(responseHeadersOffset, responseHeadersEnd);
    this.cookiesPacked = bytes.subarray(cookiesPackedOffset + 4, cookiesPackedOffset + 4 + cookiesPackedLen);
    this.queryPacked = bytes.subarray(queryPackedOffset + 4, queryPackedOffset + 4 + queryPackedLen);
    this.errorBody = bytes.subarray(errorBodyOffset + 4, errorBodyOffset + 4 + errorBodyLen);
    this.body = EMPTY_BYTES; // JS attaches the real body after unpacking
  }

  private decode(offset: number, len: number): string {
    if (len === 0) return "";
    return decoder.decode(this.bytes.subarray(offset + 4, offset + 4 + len));
  }

  requestId(): string {
    if (this._requestId === undefined) {
      this._requestId = this.decode(this.requestIdOffset, this.requestIdLen);
    }
    return this._requestId;
  }

  traceId(): string {
    if (this._traceId === undefined) {
      this._traceId = this.decode(this.traceIdOffset, this.traceIdLen);
    }
    return this._traceId;
  }

  spanId(): string {
    if (this._spanId === undefined) {
      this._spanId = this.decode(this.spanIdOffset, this.spanIdLen);
    }
    return this._spanId;
  }

  errorBodyText(): string {
    if (this._errorBodyText === undefined) {
      this._errorBodyText = this.errorBodyLen === 0
        ? ""
        : decoder.decode(this.bytes.subarray(this.errorBodyOffset + 4, this.errorBodyOffset + 4 + this.errorBodyLen));
    }
    return this._errorBodyText;
  }

  responseHeaders(): Pair[] {
    if (this._responseHeaders === undefined) {
      this._responseHeaders = this.responseHeadersCount === 0
        ? []
        : readPairsFromRegion(this.bytes, this.responseHeadersOffset, this.responseHeadersCount);
    }
    return this._responseHeaders;
  }

  cookies(): Pair[] {
    if (this._cookies === undefined) {
      this._cookies = readPairsPacked(this.cookiesPacked);
    }
    return this._cookies;
  }

  query(): Pair[] {
    if (this._query === undefined) {
      this._query = readPairsPacked(this.queryPacked);
    }
    return this._query;
  }
}

export function unpackIngressLazy(input: Uint8Array): IngressResultLazy {
  return new IngressResultLazyImpl(input);
}

function readPairsFromRegion(bytes: Uint8Array, offset: number, count: number): Pair[] {
  if (count === 0) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Pair[] = new Array(count);
  let pos = offset + 4; // skip count u32
  for (let i = 0; i < count; i++) {
    const keyLen = dv.getUint32(pos, true); pos += 4;
    const key = decoder.decode(bytes.subarray(pos, pos + keyLen)); pos += keyLen;
    const valLen = dv.getUint32(pos, true); pos += 4;
    const val = decoder.decode(bytes.subarray(pos, pos + valLen)); pos += valLen;
    out[i] = [key, val];
  }
  return out;
}

// Backward-compatible eager unpack
export interface IngressResult {
  version: number;
  verdict: IngressVerdict;
  verdictCode: number;
  status: number;
  flags: number;
  hasCookies: boolean;
  hasQuery: boolean;
  bodyValidJson: boolean;
  schemaValid: boolean;
  corsAllowed: boolean;
  isPreflight: boolean;
  rateLimited: boolean;
  https: boolean;
  trustedProxy: boolean;
  cacheKey: bigint;
  requestId: string;
  traceId: string;
  spanId: string;
  rateLimitRemaining: number;
  rateLimitResetMs: bigint;
  responseHeaders: Pair[];
  cookies: Pair[];
  query: Pair[];
  errorBody: Uint8Array;
  errorBodyText: string;
  body: Uint8Array;
}

export function unpackIngress(input: Uint8Array): IngressResult {
  const lazy = unpackIngressLazy(input);
  return {
    version: lazy.version,
    verdict: lazy.verdict,
    verdictCode: lazy.verdictCode,
    status: lazy.status,
    flags: lazy.flags,
    hasCookies: lazy.hasCookies,
    hasQuery: lazy.hasQuery,
    bodyValidJson: lazy.bodyValidJson,
    schemaValid: lazy.schemaValid,
    corsAllowed: lazy.corsAllowed,
    isPreflight: lazy.isPreflight,
    rateLimited: lazy.rateLimited,
    https: lazy.https,
    trustedProxy: lazy.trustedProxy,
    cacheKey: lazy.cacheKey,
    requestId: lazy.requestId(),
    traceId: lazy.traceId(),
    spanId: lazy.spanId(),
    rateLimitRemaining: lazy.rateLimitRemaining,
    rateLimitResetMs: lazy.rateLimitResetMs,
    responseHeaders: lazy.responseHeaders(),
    cookies: lazy.cookies(),
    query: lazy.query(),
    errorBody: lazy.errorBody,
    errorBodyText: lazy.errorBodyText(),
    body: lazy.body,
  };
}