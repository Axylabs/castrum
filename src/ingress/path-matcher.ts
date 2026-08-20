// src/ingress/path-matcher.ts — `:param` / `*` path matching for pre-baked routes
//
// The dynamic-path matcher shared by the Node adapter (server-node.ts) and the
// router (router.ts). Bun's native router matches dynamic paths itself, so this
// only runs on Node / route-manager paths. The ingress pipeline does not echo
// path params in its response, so matching only selects the handler.

/** A matched dynamic route: the handler map + the extracted path params. */
export interface PathMatch {
  methods: Record<string, unknown>
  params: Record<string, string>
}

interface CompiledDynamicPattern {
  re: RegExp
  paramNames: string[]
  rest: boolean
  methods: Record<string, unknown>
  /** Number of literal (static) segments — used to prefer the most specific pattern. */
  staticSegments: number
}

/**
 * Build a path matcher over a route map, supporting `:param` and `*` (rest)
 * segments. Exact (static) paths always win over dynamic patterns; dynamic
 * patterns are ordered most-specific-first (most static segments, then fewest
 * params). Used by `createIngressServerNode` (Bun's native router already
 * matches dynamic patterns itself). The ingress pipeline does not echo path
 * params in its response, so matching only selects the handler.
 *
 * @param routes the built route map (`path` → `method` → handler)
 * @returns a matcher: `pathname` → `{ methods, params }` or `undefined`
 */
export function buildPathMatcher(
  routes: Record<string, Record<string, unknown>>,
): (pathname: string) => PathMatch | undefined {
  const exact = new Map<string, Record<string, unknown>>()
  const dynamic: CompiledDynamicPattern[] = []

  for (const [path, methods] of Object.entries(routes)) {
    const hasParam = path.indexOf(':') !== -1
    const hasRest = path.indexOf('*') !== -1
    if (!hasParam && !hasRest) {
      exact.set(path, methods)
      continue
    }

    const paramNames: string[] = []
    let rest = false
    let staticSegments = 0
    const parts = path.split('/').filter((s) => s.length > 0)
    const source = parts
      .map((seg) => {
        if (seg === '*') {
          rest = true
          return '(.*)'
        }
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1))
          return '([^/]+)'
        }
        staticSegments++
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/')

    dynamic.push({
      re: new RegExp(`^/${source}${rest ? '' : '/?$'}`),
      paramNames,
      rest,
      methods,
      staticSegments,
    })
  }

  dynamic.sort(
    (a, b) => b.staticSegments - a.staticSegments || a.paramNames.length - b.paramNames.length,
  )

  return (pathname: string) => {
    const exactHit = exact.get(pathname)
    if (exactHit !== undefined) {
      return { methods: exactHit, params: {} }
    }
    for (const d of dynamic) {
      const m = d.re.exec(pathname)
      if (m !== null) {
        const params: Record<string, string> = {}
        for (let i = 0; i < d.paramNames.length; i++) {
          const raw = m[i + 1]
          if (raw !== undefined) params[d.paramNames[i] ?? ''] = safeDecode(raw)
        }
        if (d.rest) {
          const restRaw = m[d.paramNames.length + 1]
          if (restRaw !== undefined) params['*'] = safeDecode(restRaw)
        }
        return { methods: d.methods, params }
      }
    }
    return undefined
  }
}

/**
 * Percent-decode a matched path segment, tolerating malformed escapes: a bad
 * `%` sequence is returned raw rather than throwing, so the matcher never
 * rejects a request over a decode error.
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
