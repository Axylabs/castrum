// src/ingress/packing/header-packing.ts — Binary header packing (fast path).
//
// Packs the request headers selected by a HeaderPlan directly into a reusable
// Uint8Array with no intermediate strings. A bounded thread-local pool of
// scratch buffers keeps this allocation-free on the hot path while isolating
// the buffers per call-site sequence.

import type { HeaderPlan } from "../shared";

const encoder = new TextEncoder();

// ── Header name constants (pre-encoded) ────────────────────────
export const HDR_COOKIE = encoder.encode("cookie");
export const HDR_ORIGIN = encoder.encode("origin");
export const HDR_ACRM = encoder.encode("access-control-request-method");
export const HDR_ACRH = encoder.encode("access-control-request-headers");
export const HDR_XFF = encoder.encode("x-forwarded-for");
export const HDR_XRI = encoder.encode("x-real-ip");
export const HDR_XFP = encoder.encode("x-forwarded-proto");

const HEADER_BUF_SIZE = 8192;

// Thread-local header buffer for per-call isolation
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
 * Write one header pair into `buf`/`view`, growing them if needed.
 *
 * IMPORTANT: the header block can exceed `HEADER_BUF_SIZE` (e.g. a very large
 * cookie or origin header). When that happens `buf`/`view` are replaced by a
 * larger buffer, so the (possibly grown) buffer + view are returned alongside
 * the new position. Callers MUST thread the returned buffer/view back into
 * subsequent writes — otherwise the grown bytes are written into a discarded
 * array and the packed output is silently corrupted.
 */
export function writeHeaderPair(
  buf: Uint8Array,
  view: DataView,
  pos: number,
  name: Uint8Array,
  value: string,
): [pos: number, buf: Uint8Array, view: DataView] {
  const needed = 2 + name.length + 4 + value.length * 3;
  if (pos + needed > buf.length) {
    const next = new Uint8Array(Math.max(buf.length * 2, pos + needed));
    next.set(buf.subarray(0, pos));
    buf = next;
    view = new DataView(buf.buffer);
  }

  view.setUint16(pos, name.length, true);
  buf.set(name, pos + 2);
  pos += 2 + name.length;

  const valueLenPos = pos;
  pos += 4;

  const dest = buf.subarray(pos);
  const { written } = encoder.encodeInto(value, dest);

  view.setUint32(valueLenPos, written, true);
  pos += written;

  return [pos, buf, view];
}

/** Pack the headers selected by `plan` into a reusable Uint8Array. */
export function packHeaders(req: Request, plan: HeaderPlan): Uint8Array {
  let [buf, view] = getHeaderBuf();
  let pos = 2;
  let count = 0;

  const headers = req.headers;

  if (plan.cookie) {
    const v = headers.get("cookie");
    if (v !== null) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_COOKIE, v);
      count++;
    }
  }

  if (plan.cors) {
    const origin = headers.get("origin");
    if (origin !== null) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ORIGIN, origin);
      count++;
    }

    if (req.method === "OPTIONS") {
      const acrm = headers.get("access-control-request-method");
      if (acrm !== null) {
        [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ACRM, acrm);
        count++;
      }

      const acrh = headers.get("access-control-request-headers");
      if (acrh !== null) {
        [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_ACRH, acrh);
        count++;
      }
    }
  }

  if (plan.proxy) {
    const xff = headers.get("x-forwarded-for");
    if (xff !== null) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XFF, xff);
      count++;
    }

    const xri = headers.get("x-real-ip");
    if (xri !== null) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XRI, xri);
      count++;
    }
  }

  if (plan.proto) {
    const xfp = headers.get("x-forwarded-proto");
    if (xfp !== null) {
      [pos, buf, view] = writeHeaderPair(buf, view, pos, HDR_XFP, xfp);
      count++;
    }
  }

  view.setUint16(0, count, true);
  return buf.subarray(0, pos);
}
