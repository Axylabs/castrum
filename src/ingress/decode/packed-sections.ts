// src/ingress/decode/packed-sections.ts — Shared bounds-checked section layout.
//
// Both decoders (fast-result.ts and baked-result.ts) walk the same OUT_* data
// region: [cookies JSON][query JSON][body JSON], each u32-length-prefixed in
// the fixed header. This helper centralizes the bounds-checked offset math so
// a malformed/truncated buffer can never produce slices past its end.

import { OUT_DATA_START } from "../constants";

/** Bounds-checked section offsets for one ingress output buffer. */
export interface PackedSectionLayout {
  /** Cookie-JSON length clamped to the buffer (0 if none / out of range). */
  safeCookiesLen: number;
  /** Byte offset where the query-JSON section begins. */
  queryStart: number;
  /** Query-JSON length clamped to the buffer (0 if none / out of range). */
  safeQueryLen: number;
  /** Byte offset where the body-JSON section begins. */
  bodyJsonStart: number;
  /** Body-JSON length clamped to the buffer (0 if none / out of range). */
  safeBodyJsonLen: number;
  /** Whether any declared section length overran the buffer. */
  truncated: boolean;
}

/**
 * Compute bounds-checked section offsets for an ingress output buffer.
 *
 * Given the raw u32 section lengths (already read from the fixed header) and
 * the actual buffer length, returns safe (clamped-to-buffer) lengths and the
 * body-JSON start offset. Any length that would run past the end of the
 * buffer is clamped to 0 and reported via `truncated`, so callers never read
 * stale or out-of-bounds bytes.
 */
export function sectionLayout(
  bufLen: number,
  cookiesLen: number,
  queryLen: number,
  bodyLen: number,
): PackedSectionLayout {
  const safeCookiesLen =
    cookiesLen > 0 && OUT_DATA_START + cookiesLen <= bufLen ? cookiesLen : 0;
  const queryStart = OUT_DATA_START + safeCookiesLen;
  const safeQueryLen = queryLen > 0 && queryStart + queryLen <= bufLen ? queryLen : 0;
  const bodyJsonStart = queryStart + safeQueryLen;
  const safeBodyJsonLen =
    bodyLen > 0 && bodyJsonStart + bodyLen <= bufLen ? bodyLen : 0;

  return {
    safeCookiesLen,
    queryStart,
    safeQueryLen,
    bodyJsonStart,
    safeBodyJsonLen,
    truncated:
      safeCookiesLen !== cookiesLen ||
      safeQueryLen !== queryLen ||
      safeBodyJsonLen !== bodyLen,
  };
}
