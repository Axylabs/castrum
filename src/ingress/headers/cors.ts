// src/ingress/headers/cors.ts — CORS static-string computation (fast path).
//
// Precomputes the static parts of the CORS policy (joined allow-lists, wildcard
// detection, credentials flag) once per handler so per-request header building
// never re-joins arrays.

/** User-facing CORS configuration. */
export interface CorsOptions {
  allowOrigin?: string[]
  allowMethods?: string[]
  allowHeaders?: string[]
  exposeHeaders?: string[]
  allowCredentials?: boolean
  maxAge?: number
}

/** Precomputed, immutable CORS policy strings. */
export interface CorsStaticStrings {
  readonly allowMethodsJoined: string
  readonly allowHeadersJoined: string
  readonly exposeHeadersJoined: string
  readonly maxAgeString: string | null
  readonly isWildcard: boolean
  readonly credentials: boolean
}

/** Compute the static CORS strings for a config, or `null` when disabled. */
export function buildCorsStaticStrings(cors: CorsOptions | undefined): CorsStaticStrings | null {
  if (!cors) return null

  const isWildcard =
    !cors.allowOrigin || cors.allowOrigin.length === 0 || cors.allowOrigin.includes('*')

  return {
    allowMethodsJoined: cors.allowMethods?.length
      ? cors.allowMethods.join(', ')
      : 'GET, HEAD, POST',
    allowHeadersJoined: cors.allowHeaders?.length ? cors.allowHeaders.join(', ') : '',
    exposeHeadersJoined: cors.exposeHeaders?.length ? cors.exposeHeaders.join(', ') : '',
    maxAgeString: typeof cors.maxAge === 'number' ? String(cors.maxAge) : null,
    isWildcard,
    credentials: cors.allowCredentials === true,
  }
}
