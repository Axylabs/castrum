// src/bench/media-type-baseline.ts — JS baseline for Content-Type parsing.
// Hand-rolled (RFC-ish) so the baseline stays dependency-free. Bench-local only.

export interface NativeMediaType {
  mediaType: string
  params: Record<string, string>
}

/** Parse `type/subtype; param=value` (hand-rolled JS baseline). */
export function nativeParseMediaType(header: string): NativeMediaType {
  const parts = header.split(';')
  const main = (parts[0] ?? '').trim()
  const slash = main.indexOf('/')
  const mediaType =
    slash === -1
      ? main.toLowerCase()
      : `${main.slice(0, slash).trim().toLowerCase()}/${main
          .slice(slash + 1)
          .trim()
          .toLowerCase()}`
  const params: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] as string
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    if (!name) continue
    let value = part.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1')
    }
    params[name] = value
  }
  return { mediaType, params }
}

/** Wildcard media-type match: any/any, type/any, or exact. */
export function nativeMediaTypeMatches(actual: string, expected: string): boolean {
  const [aType, aSub] = actual.toLowerCase().split('/')
  const [eType, eSub] = expected.toLowerCase().split('/')
  return (eType === '*' || eType === aType) && (eSub === '*' || eSub === aSub)
}
