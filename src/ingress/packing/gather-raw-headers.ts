// src/ingress/packing/gather-raw-headers.ts — Raw header gathering (pre-baked
// path).
//
// The pre-baked path passes headers to the native addon as a plain
// [name, value][] array (the addon packs them internally in Rust). This module
// extracts exactly the headers selected by a HeaderPlan, with per-header size
// guards so oversized values are dropped rather than forwarded.

import { METHOD_KIND, type HeaderPlan } from "../shared";
import {
  HDR_ACRH,
  HDR_ACRM,
  HDR_COOKIE,
  HDR_ORIGIN,
  HDR_XFF,
  HDR_XFP,
  HDR_XRI,
  writeHeaderPair,
} from "./header-packing";

/** Upper bound for the `cookie` header value. */
export const MAX_COOKIE_HEADER_BYTES = 8192;
/** Upper bound for small single-value headers (origin, ACRM, ACRH, ...). */
export const MAX_SMALL_HEADER_BYTES = 2048;
/** Upper bound for the `x-forwarded-for` header value. */
export const MAX_XFF_HEADER_BYTES = 8192;

/** Scratch capacity for the reusable packed-header buffer. */
const HEADER_BUF_SIZE = 8192;

// Thread-local reusable header buffer (mirrors `packHeaders`' per-call-site
// isolation: the buffer is only borrowed for the duration of one gather call).
const [getHeaderBuf] = (() => {
  const tls = new Array<[Uint8Array, DataView]>();
  const MAX_CACHED = 256;
  let tlsIdx = 0;

  function acquire(): [Uint8Array, DataView] {
    const cached = tls[tlsIdx];
    tlsIdx = (tlsIdx + 1) % MAX_CACHED;
    if (cached) return cached;

    const buf = new Uint8Array(HEADER_BUF_SIZE);
    const view = new DataView(buf.buffer);
    const pair: [Uint8Array, DataView] = [buf, view];
    tls.push(pair);
    return pair;
  }

  return [acquire];
})();

/**
 * Gather the request headers selected by `plan` as a `[name, value][]` array.
 * `methodKind` is the native method-kind enum (see `METHOD_KIND`).
 */
export function gatherRawHeaders(
  req: Request,
  plan: HeaderPlan,
  methodKind: number,
): [string, string][] {
  const headers: [string, string][] = [];
  const h = req.headers;

  if (plan.cookie) {
    const v = h.get("cookie");
    if (v !== null && v.length <= MAX_COOKIE_HEADER_BYTES) {
      headers.push(["cookie", v]);
    }
  }

  if (plan.cors) {
    const originV = h.get("origin");
    if (originV !== null && originV.length <= MAX_SMALL_HEADER_BYTES) {
      headers.push(["origin", originV]);
    }

    if (methodKind === METHOD_KIND.OPTIONS) {
      const acrm = h.get("access-control-request-method");
      if (acrm !== null && acrm.length <= MAX_SMALL_HEADER_BYTES) {
        headers.push(["access-control-request-method", acrm]);
      }

      const acrh = h.get("access-control-request-headers");
      if (acrh !== null && acrh.length <= MAX_SMALL_HEADER_BYTES) {
        headers.push(["access-control-request-headers", acrh]);
      }
    }
  }

  if (plan.proxy) {
    const xff = h.get("x-forwarded-for");
    if (xff !== null && xff.length <= MAX_XFF_HEADER_BYTES) {
      headers.push(["x-forwarded-for", xff]);
    }

    const xri = h.get("x-real-ip");
    if (xri !== null && xri.length <= MAX_SMALL_HEADER_BYTES) {
      headers.push(["x-real-ip", xri]);
    }
  }

  if (plan.proto) {
    const xfp = h.get("x-forwarded-proto");
    if (xfp !== null && xfp.length <= MAX_SMALL_HEADER_BYTES) {
      headers.push(["x-forwarded-proto", xfp]);
    }
  }

  return headers;
}

/**
 * Gather the request headers selected by `plan` as a packed byte block
 * (`[u16 count] { [u16 name_len][name][u32 val_len][value] }`) written into a
 * reusable thread-local buffer.
 *
 * This is the zero-intermediate-string equivalent of [`gatherRawHeaders`] for
 * the packed-input pipeline: identical header selection and per-header size
 * guards, but no `[string, string][]` array and no napi string marshaling.
 * The returned view is valid only until the next call on this call site.
 */
export function gatherRawHeadersPacked(
  req: Request,
  plan: HeaderPlan,
  methodKind: number,
): Uint8Array {
  let [buf, view] = getHeaderBuf();
  let pos = 2;
  let count = 0;
  const h = req.headers;

  if (plan.cookie) {
    const v = h.get("cookie");
    if (v !== null && v.length <= MAX_COOKIE_HEADER_BYTES) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_COOKIE, v);
      count++;
    }
  }

  if (plan.cors) {
    const originV = h.get("origin");
    if (originV !== null && originV.length <= MAX_SMALL_HEADER_BYTES) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ORIGIN, originV);
      count++;
    }

    if (methodKind === METHOD_KIND.OPTIONS) {
      const acrm = h.get("access-control-request-method");
      if (acrm !== null && acrm.length <= MAX_SMALL_HEADER_BYTES) {
        [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ACRM, acrm);
        count++;
      }

      const acrh = h.get("access-control-request-headers");
      if (acrh !== null && acrh.length <= MAX_SMALL_HEADER_BYTES) {
        [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ACRH, acrh);
        count++;
      }
    }
  }

  if (plan.proxy) {
    const xff = h.get("x-forwarded-for");
    if (xff !== null && xff.length <= MAX_XFF_HEADER_BYTES) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XFF, xff);
      count++;
    }

    const xri = h.get("x-real-ip");
    if (xri !== null && xri.length <= MAX_SMALL_HEADER_BYTES) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XRI, xri);
      count++;
    }
  }

  if (plan.proto) {
    const xfp = h.get("x-forwarded-proto");
    if (xfp !== null && xfp.length <= MAX_SMALL_HEADER_BYTES) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XFP, xfp);
      count++;
    }
  }

  view.setUint16(0, count, true);
  return buf.subarray(0, pos);
}
