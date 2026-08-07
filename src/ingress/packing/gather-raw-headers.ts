// src/ingress/packing/gather-raw-headers.ts — Raw header gathering (pre-baked
// path).
//
// The pre-baked path passes headers to the native addon as a plain
// [name, value][] array (the addon packs them internally in Rust). This module
// extracts exactly the headers selected by a HeaderPlan, with per-header size
// guards so oversized values are dropped rather than forwarded.

import type { HeaderPlan } from "../shared";

/** Upper bound for the `cookie` header value. */
export const MAX_COOKIE_HEADER_BYTES = 8192;
/** Upper bound for small single-value headers (origin, ACRM, ACRH, ...). */
export const MAX_SMALL_HEADER_BYTES = 2048;
/** Upper bound for the `x-forwarded-for` header value. */
export const MAX_XFF_HEADER_BYTES = 8192;

/**
 * Gather the request headers selected by `plan` as a `[name, value][]` array.
 * `methodKind` is the native method-kind enum (6 == OPTIONS).
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

    if (methodKind === 6) {
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
