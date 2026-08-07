// src/bench/accept-baseline.ts — JS baseline for Accept-Encoding negotiation.
// Hand-rolled q-value negotiation mirroring RFC 7231 §5.3.4. Bench-local only.

export interface NativeEncodingPref {
  encoding: string;
  q: number;
  order: number;
}

/** Parse an Accept-Encoding header (lowercased, q default 1). */
export function nativeParseAcceptEncoding(header: string): NativeEncodingPref[] {
  const out: NativeEncodingPref[] = [];
  let order = 0;
  for (const part of header.split(",")) {
    const segments = part.trim().split(";");
    const name = (segments[0] ?? "").trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (let i = 1; i < segments.length; i++) {
      const attr = segments[i] as string;
      const eq = attr.indexOf("=");
      if (eq !== -1 && attr.slice(0, eq).trim().toLowerCase() === "q") {
        const v = Number.parseFloat(attr.slice(eq + 1));
        q = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
      }
    }
    out.push({ encoding: name, q, order });
    order += 1;
  }
  return out;
}

/** Best supported encoding for a header, or null for identity. */
export function nativeNegotiateEncoding(
  supported: string[],
  header: string,
): string | null {
  const prefs = nativeParseAcceptEncoding(header);
  if (prefs.length === 0) return supported[0] ?? null;

  let best: { encoding: string; q: number; spec: number; order: number } | null = null;
  for (const sup of supported) {
    let matched: { q: number; spec: number; order: number } | null = null;
    for (const p of prefs) {
      const spec = p.encoding === sup ? 2 : p.encoding === "*" ? 1 : 0;
      if (spec === 0) continue;
      if (
        !matched ||
        spec > matched.spec ||
        (spec === matched.spec && p.order < matched.order)
      ) {
        matched = { q: p.q, spec, order: p.order };
      }
    }
    if (!matched || matched.q <= 0) continue;
    const cand = {
      encoding: sup,
      q: matched.q,
      spec: matched.spec,
      order: matched.order,
    };
    if (
      !best ||
      cand.spec > best.spec ||
      (cand.spec === best.spec &&
        (Math.abs(cand.q - best.q) > 1e-4 ? cand.q > best.q : cand.order < best.order))
    ) {
      best = cand;
    }
  }
  return best ? best.encoding : null;
}
