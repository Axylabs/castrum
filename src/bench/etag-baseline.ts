// src/bench/etag-baseline.ts — JS baselines for ETag / HTTP-date / conditional.
// ETag uses the crc-32 baseline (matches Rust crc32fast → byte parity);
// HTTP-date uses Date.toUTCString() (IMF-fixdate-compatible). Bench-local only.

import { encoder } from "../shared/bytes";
import { nativeCrc32 } from "../baseline/tasks/hashing";

/** Generate a strong/weak ETag from the JS crc32 baseline. */
export function nativeEtag(data: Uint8Array, weak = false): Uint8Array {
  const hex = (nativeCrc32(data) >>> 0).toString(16).padStart(8, "0");
  const tag = weak ? `W/"${hex}"` : `"${hex}"`;
  return encoder.encode(tag);
}

/** Format a unix timestamp as an HTTP-date via Date.toUTCString(). */
export function nativeHttpDate(secs: number): Uint8Array {
  return encoder.encode(new Date(secs * 1000).toUTCString());
}

/** Hand-rolled JS conditional-request check (304 decision). */
export function nativeIsNotModified(
  etagValue: string,
  lastModifiedSecs: number,
  ifNoneMatch: string | null,
  ifModifiedSince: string | null,
): boolean {
  if (ifNoneMatch != null && ifNoneMatch.trim() !== "") {
    if (ifNoneMatch.trim() === "*") return true;
    const ourTag = etagValue.replace(/^W\//, "");
    return ifNoneMatch
      .split(",")
      .some((c) => c.trim().replace(/^W\//, "") === ourTag);
  }
  if (ifModifiedSince != null && lastModifiedSecs > 0) {
    const ims = Date.parse(ifModifiedSince) / 1000;
    if (Number.isFinite(ims)) {
      return lastModifiedSecs <= ims;
    }
  }
  return false;
}
