// src/ingress/pre-effects.ts — native op-program plan builder (route-wire v5).
//
// `buildProgramPlan` lowers a route's pre-effect CONFIG (CORS / rate-limit /
// security / IP trust), its parse/validate steps, and its OK response
// projection into an OPEN op program: an ordered op list plus the const table
// the native executor interprets (`rust/ingress/native_route.rs`). It REUSES the
// existing TS builders (`buildBakedHeaderTemplates`,
// `buildBakedSecurityEntries`, `buildCorsStaticStrings`, the pre-encoded
// `ERROR_BODIES`) so the emitted bytes match castrum's pre-baked JS path by
// construction — the native side only makes the DECISION and substitutes.
//
// Security headers are a real `security_headers` op (merged at emission) rather
// than baked into every class template; the class templates themselves are
// built with an empty security list.
//
// IMPURE by policy: it reads the HV_* layout constants from `./constants`
// (which touches the addon). Calls happen at COMPILE time (route construction),
// never per request.

import { encoder } from '../shared/bytes'
import {
  HV_CORS_PREFLIGHT,
  HV_CORS_SIMPLE,
  HV_JSON,
  HV_RATE_ACTIVE,
  HV_RATE_LIMITED,
} from './constants'
import type { CorsOptions } from './headers/cors'
import { buildCorsStaticStrings } from './headers/cors'
import { buildBakedHeaderTemplates } from './headers/baked-templates'
import type { SecurityHeadersOptions } from './headers/hsts'
import { buildBakedSecurityEntries } from './headers/security'
import {
  ROUTE_CLASS,
  ROUTE_OP,
  type RouteWireOp,
  type RouteWireResponse,
  type RouteWireResponseHeader,
  encodeCorsConfig,
  encodeHeaderList,
  encodeIpTrustConfig,
  encodeRateConfig,
  encodeResponseSet,
} from './packing/route-wire'
import { ERROR_BODIES } from './response/error-bodies'

/** Empty body (204 preflight / constants). */
const EMPTY_BODY = new Uint8Array(0)

/**
 * The `errors` body template with a `{retryAfterMs}` placeholder, matching
 * `rateLimitedBody()` byte-for-byte once substituted.
 */
const RATE_LIMIT_BODY_TEMPLATE = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":{retryAfterMs}}',
)

/** Options accepted by {@link buildProgramPlan}. */
export interface ProgramPlanOptions {
  /** CORS policy (evaluated natively by `CorsEngine`). */
  cors?: CorsOptions
  /** Rate-limit policy. `limit` enables the native limiter. */
  rateLimit?: { limit?: number; windowMs?: number; maxEntries?: number }
  /** Structured security-headers options (reused from the baked path). */
  security?: SecurityHeadersOptions
  /** Force security headers on/off (default: on when `security` is present). */
  enableSecurityHeaders?: boolean
  /** Raw `runtime.securityHeaders` pairs merged over the structured options. */
  rawSecurityHeaders?: ReadonlyArray<[string, string]>
  /** `https` is pinned true (drives dynamic HSTS). */
  https?: boolean
  /** Emit an `x-request-id` header in every class template. */
  requestIdHeader?: boolean
  /** Trust every proxy hop (deprecated `trustProxy: true`). */
  trustProxy?: boolean
  /** Trusted proxy networks (CIDR or IP). */
  trustedProxies?: { networks?: string[] }
  /** Emit a `parse_query` op (result carries query-valid + a query section). */
  parseQuery?: boolean
  /** Emit a `parse_cookies` op. */
  parseCookies?: boolean
  /** Emit `json_valid` (require) + `schema_validate` body-verdict ops. */
  validateBody?: {
    /** Draft-07 schema bytes. */
    schema: Uint8Array
    /** Reject a non-JSON body with 400 before the schema check. */
    requireJson?: boolean
  }
}

/** A decoded op-program plan: the const table + the ordered op stream. */
export interface RouteWireProgramPlan {
  /** Const-table blobs referenced by op operands. */
  consts: Uint8Array[]
  /** The ordered ops. */
  ops: RouteWireOp[]
}

/**
 * Append the dynamic CORS/rate/retry extras to a baked template, in the same
 * order the pre-baked JS path uses (`responseHeaders`): template, x-request-id,
 * allow-origin, ratelimit-remaining/reset, retry-after.
 */
function withExtras(
  template: ReadonlyArray<readonly [string, string]>,
  opts: { requestId: boolean; origin: boolean; rate: boolean; retry: boolean },
): RouteWireResponseHeader[] {
  const out: RouteWireResponseHeader[] = template.map(([name, value]) => ({ name, value }))
  if (opts.requestId) out.push({ name: 'x-request-id', value: '{requestId}' })
  if (opts.origin) out.push({ name: 'access-control-allow-origin', value: '{origin}' })
  if (opts.rate) {
    out.push({ name: 'ratelimit-remaining', value: '{remaining}' })
    out.push({ name: 'ratelimit-reset', value: '{resetSecs}' })
  }
  if (opts.retry) out.push({ name: 'retry-after', value: '{retryAfterSecs}' })
  return out
}

/** Like {@link withExtras} but appends `cache-control: no-store` last. */
function withTerminalExtras(
  template: ReadonlyArray<readonly [string, string]>,
  opts: { requestId: boolean; origin: boolean; rate: boolean; retry: boolean },
): RouteWireResponseHeader[] {
  const out = withExtras(template, opts)
  out.push({ name: 'cache-control', value: 'no-store' })
  return out
}

/**
 * Build the native op program for a route from its config + OK response.
 *
 * Op order mirrors the framework pipeline: parse → IP trust → CORS → rate limit
 * → body validation → security headers → response projection. A preflight CORS
 * request halts 204/403 in the `cors` op; a denied request halts 429 in
 * `rate_limit`; a bad body halts 400/422. The class templates the terminal ops
 * select are built here (without security, which the `security_headers` op
 * merges) so the emitted bytes match the JS path.
 *
 * @param options - Pre-effect / parse / validate config.
 * @param response - The OK response projection (status + headers + body).
 * @returns A {@link RouteWireProgramPlan} ready for `encodeProgram`.
 */
export function buildProgramPlan(
  options: ProgramPlanOptions,
  response: RouteWireResponse,
): RouteWireProgramPlan {
  const requestId = options.requestIdHeader === true
  const corsStatic = buildCorsStaticStrings(options.cors)
  const rateActive = (options.rateLimit?.limit ?? 0) > 0
  const securityEnforced = options.security !== undefined || options.enableSecurityHeaders === true
  const securityEntries = buildBakedSecurityEntries(
    securityEnforced ? (options.security ?? {}) : undefined,
    options.https,
    options.rawSecurityHeaders,
  )
  // Class templates are built WITHOUT security: the `security_headers` op merges
  // the pre-baked list at emission, matching the baked template order.
  const templates = buildBakedHeaderTemplates({
    securityEntries: [],
    cors: options.cors,
    corsAllowMethods: corsStatic?.allowMethodsJoined ?? '',
    corsAllowHeaders: corsStatic?.allowHeadersJoined ?? '',
    corsExposeHeaders: corsStatic?.exposeHeadersJoined ?? '',
    corsMaxAge: corsStatic?.maxAgeString ?? '',
    rateLimitStr: rateActive ? String(options.rateLimit?.limit ?? 0) : '',
  })

  const rateBit = rateActive ? HV_RATE_ACTIVE : 0
  const classes: Partial<Record<number, RouteWireResponse>> = {}

  classes[ROUTE_CLASS.okNoOrigin] = {
    status: response.status,
    headers: withExtras(templates.regular[HV_JSON | rateBit] ?? [], {
      requestId,
      origin: false,
      rate: rateActive,
      retry: false,
    }),
    body: response.body,
  }

  if (corsStatic) {
    classes[ROUTE_CLASS.okWithOrigin] = {
      status: response.status,
      headers: withExtras(templates.regular[HV_JSON | HV_CORS_SIMPLE | rateBit] ?? [], {
        requestId,
        origin: true,
        rate: rateActive,
        retry: false,
      }),
      body: response.body,
    }
    classes[ROUTE_CLASS.preflightOk] = {
      status: 204,
      headers: withExtras(templates.regular[HV_CORS_PREFLIGHT | rateBit] ?? [], {
        requestId,
        origin: true,
        rate: rateActive,
        retry: false,
      }),
      body: EMPTY_BODY,
    }
    classes[ROUTE_CLASS.preflightForbidden] = {
      status: 403,
      headers: withTerminalExtras(templates.regular[HV_JSON | rateBit] ?? [], {
        requestId,
        origin: false,
        rate: rateActive,
        retry: false,
      }),
      body: ERROR_BODIES.cors_preflight_not_allowed ?? EMPTY_BODY,
    }
  }

  if (rateActive) {
    classes[ROUTE_CLASS.rateLimited] = {
      status: 429,
      headers: withTerminalExtras(templates.regular[HV_JSON | rateBit | HV_RATE_LIMITED] ?? [], {
        requestId,
        origin: false,
        rate: true,
        retry: true,
      }),
      body: RATE_LIMIT_BODY_TEMPLATE,
    }
    if (corsStatic) {
      classes[ROUTE_CLASS.rateLimited + 8] = {
        status: 429,
        headers: withTerminalExtras(
          templates.regular[HV_JSON | HV_CORS_SIMPLE | HV_RATE_ACTIVE | HV_RATE_LIMITED] ?? [],
          { requestId, origin: true, rate: true, retry: true },
        ),
        body: RATE_LIMIT_BODY_TEMPLATE,
      }
    }
  }

  classes[ROUTE_CLASS.invalidJson] = {
    status: 400,
    headers: withTerminalExtras(templates.regular[HV_JSON | rateBit] ?? [], {
      requestId,
      origin: false,
      rate: rateActive,
      retry: false,
    }),
    body: ERROR_BODIES.invalid_json ?? EMPTY_BODY,
  }
  classes[ROUTE_CLASS.schemaFailed] = {
    status: 422,
    headers: withTerminalExtras(templates.regular[HV_JSON | rateBit] ?? [], {
      requestId,
      origin: false,
      rate: rateActive,
      retry: false,
    }),
    body: ERROR_BODIES.schema_validation_failed ?? EMPTY_BODY,
  }
  if (corsStatic) {
    classes[ROUTE_CLASS.invalidJson + 8] = {
      status: 400,
      headers: withTerminalExtras(templates.regular[HV_JSON | HV_CORS_SIMPLE | rateBit] ?? [], {
        requestId,
        origin: true,
        rate: rateActive,
        retry: false,
      }),
      body: ERROR_BODIES.invalid_json ?? EMPTY_BODY,
    }
    classes[ROUTE_CLASS.schemaFailed + 8] = {
      status: 422,
      headers: withTerminalExtras(templates.regular[HV_JSON | HV_CORS_SIMPLE | rateBit] ?? [], {
        requestId,
        origin: true,
        rate: rateActive,
        retry: false,
      }),
      body: ERROR_BODIES.schema_validation_failed ?? EMPTY_BODY,
    }
  }

  const consts: Uint8Array[] = []
  const addConst = (bytes: Uint8Array): number => {
    consts.push(bytes)
    return consts.length - 1
  }
  const setIdx = addConst(encodeResponseSet(classes))
  const ops: RouteWireOp[] = []

  if (options.parseQuery) ops.push({ tag: ROUTE_OP.parseQuery, a: 0 })
  if (options.parseCookies) ops.push({ tag: ROUTE_OP.parseCookies, a: 1 })

  const trustMode: 0 | 1 | 2 =
    options.trustProxy === true
      ? 1
      : options.trustedProxies?.networks?.length
        ? 2
        : 0
  if (trustMode !== 0) {
    const cfgIdx = addConst(
      encodeIpTrustConfig({ mode: trustMode, networks: options.trustedProxies?.networks }),
    )
    ops.push({ tag: ROUTE_OP.ipTrust, a: cfgIdx, b: 2 })
  }

  if (corsStatic && options.cors) {
    const cfgIdx = addConst(
      encodeCorsConfig({
        allowOrigin: options.cors.allowOrigin,
        allowMethods: options.cors.allowMethods,
        allowHeaders: options.cors.allowHeaders,
        credentials: options.cors.allowCredentials === true,
      }),
    )
    ops.push({ tag: ROUTE_OP.cors, a: cfgIdx, b: setIdx, c: 3 })
  }

  if (rateActive) {
    const cfgIdx = addConst(
      encodeRateConfig({
        limit: options.rateLimit?.limit ?? 0,
        windowMs: options.rateLimit?.windowMs ?? 60_000,
        maxEntries: options.rateLimit?.maxEntries ?? 100_000,
      }),
    )
    ops.push({ tag: ROUTE_OP.rateLimit, a: cfgIdx, b: setIdx, c: 4 })
  }

  if (options.validateBody?.requireJson) {
    ops.push({ tag: ROUTE_OP.jsonValid, a: 5, b: setIdx, c: 1 })
  }
  if (options.validateBody) {
    const schemaIdx = addConst(options.validateBody.schema)
    ops.push({ tag: ROUTE_OP.schemaValidate, a: schemaIdx, b: setIdx, c: 6 })
  }

  if (securityEnforced && securityEntries.length > 0) {
    const secIdx = addConst(encodeHeaderList(securityEntries))
    ops.push({ tag: ROUTE_OP.securityHeaders, a: secIdx })
  }

  ops.push({ tag: ROUTE_OP.responseProjection, a: setIdx })

  return { consts, ops }
}
