// test/differential/corpus.ts — shared request corpus + option profiles for the
// differential transport-lane harness.
//
// Pure data plus a `Request`/body builder. It deliberately knows NOTHING about
// lanes: `lanes.ts` consumes it and decides how each lane runs a case. Cases
// are adapted from the existing adversarial suites (`smuggling.test.ts`,
// `decode-adversarial.test.ts`, `packed-ingress-adversarial.test.ts`,
// `prototype-pollution.test.ts`, `abort.test.ts`) — the harness re-runs the
// SAME semantics through every lane rather than inventing new ones.

import type { IngressFastOptions } from '../../src/ingress/options'

/** Ingress option profile a case runs under. */
export type CorpusProfile = 'base' | 'schema' | 'cors' | 'bodyGuard'

/**
 * One corpus entry. `lanes`, when present, restricts which lane names may run
 * the case (e.g. the abort case is meaningful only on the route lanes that
 * honor `Request.signal`).
 */
export interface CorpusCase {
  /** Stable id used to correlate the same case across lanes. */
  readonly id: string
  /** Human-readable intent (shown in a divergence report). */
  readonly description: string
  readonly method: string
  /** Absolute target URL. */
  readonly url: string
  readonly headers?: readonly (readonly [string, string])[]
  /** Raw request body text (POST/PUT/PATCH only). */
  readonly body?: string
  /** Option profile; defaults to `base`. */
  readonly profile?: CorpusProfile
  /** When set, only these lane names run the case. */
  readonly lanes?: readonly string[]
  /** Abort `Request.signal` before the lane runs (client disconnect). */
  readonly abort?: boolean
}

const HOST = 'http://localhost:9999'

const JSON_CT: readonly [string, string] = ['content-type', 'application/json']

/** Draft-07 schema requiring an object with a string `name`. */
const NAME_SCHEMA = new TextEncoder().encode(
  JSON.stringify({
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
    additionalProperties: true,
  }),
)

const BASE_OPTIONS: IngressFastOptions = {
  parseCookies: true,
  parseQuery: true,
  https: true,
  emitMetadataJson: true,
  enableBodySizeGuard: true,
  maxBodyBytes: 512,
  requireJsonBody: true,
}

/**
 * Resolve a profile to a FRESH ingress options object.
 *
 * A fresh object per call keeps lane handlers from sharing (and a lane from
 * mutating) the profile. `schema` is the one shared read-only byte buffer.
 */
export function caseOptions(profile: CorpusProfile = 'base'): IngressFastOptions {
  switch (profile) {
    case 'schema':
      return { ...BASE_OPTIONS, schema: NAME_SCHEMA }
    case 'cors':
      return { ...BASE_OPTIONS, cors: { allowOrigin: ['https://app.example.com'] } }
    case 'bodyGuard':
      // Size guard on, JSON validation off: isolates the native/route
      // body-too-large path from `requireJsonBody` (see the corpus comment on
      // `post-oversized`).
      return { ...BASE_OPTIONS, requireJsonBody: false }
    default:
      return { ...BASE_OPTIONS }
  }
}

/** Encode the case body to bytes, or `null` for bodiless methods. */
export function caseBodyBytes(c: CorpusCase): Uint8Array | null {
  if (c.body === undefined || c.method === 'GET' || c.method === 'HEAD') return null
  return new TextEncoder().encode(c.body)
}

/** Build a fresh `Request` for a case (bodies/signals are single-use). */
export function buildRequest(c: CorpusCase): Request {
  const init: RequestInit = { method: c.method }
  if (c.headers !== undefined) {
    init.headers = c.headers.map(([name, value]) => [name, value])
  }
  if (c.abort === true) {
    const controller = new AbortController()
    controller.abort()
    init.signal = controller.signal
  }
  if (c.body !== undefined && c.method !== 'GET' && c.method !== 'HEAD') {
    init.body = c.body
  }
  return new Request(c.url, init)
}

/** Build `n` repeated query pairs plus a malformed tail. */
function manyPairs(n: number): string {
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(`k${i}=v${i}`)
  return parts.join('&')
}

/** A JSON object nested to `depth` array levels. */
function deeplyNested(depth: number): string {
  return `${'['.repeat(depth)}1${']'.repeat(depth)}`
}

/** A body of exactly `bytes` bytes shaped like `{"name":"xxx..."}`. */
function exactBody(bytes: number): string {
  // 9-byte prefix (`{"name":"`) + 2-byte suffix (`"}`).
  return `{"name":"${'x'.repeat(bytes - 11)}"}`
}

/**
 * The differential corpus: valid, invalid and edge requests, re-used across
 * every lane. Coverage categories: empty/oversized bodies, malformed JSON,
 * malformed query / percent-encoding, duplicate + `__proto__` keys, cookies,
 * CORS preflight, schema validation, deep nesting, and client abort.
 */
export const CORPUS: readonly CorpusCase[] = [
  // ── Valid reads / metadata ────────────────────────────────────────────
  {
    id: 'get-root',
    description: 'plain GET /',
    method: 'GET',
    url: `${HOST}/`,
  },
  {
    id: 'get-health',
    description: 'GET a static path',
    method: 'GET',
    url: `${HOST}/health`,
  },
  {
    id: 'get-query',
    description: 'GET with a normal query',
    method: 'GET',
    url: `${HOST}/api/users?page=2&limit=10`,
  },
  {
    id: 'get-query-duplicate',
    description: 'duplicate query key (last-wins)',
    method: 'GET',
    url: `${HOST}/api/users?tag=a&tag=b`,
  },
  {
    id: 'get-query-plus',
    description: 'query + decodes to space',
    method: 'GET',
    url: `${HOST}/api/users?q=a+b`,
  },
  {
    id: 'get-query-encoded',
    description: 'percent-encoded query value',
    method: 'GET',
    url: `${HOST}/api/users?q=a%20b%26c`,
  },
  {
    id: 'get-query-empty',
    description: 'empty query key and empty value',
    method: 'GET',
    url: `${HOST}/api/users?=v&a=`,
  },
  {
    id: 'get-query-unicode',
    description: 'percent-encoded UTF-8 query value',
    method: 'GET',
    url: `${HOST}/api/users?q=%E2%9C%93`,
  },
  {
    id: 'get-query-bad-percent',
    description: 'malformed %ZZ percent-encoding passes through raw',
    method: 'GET',
    url: `${HOST}/api/users?q=%ZZ`,
  },
  {
    id: 'get-query-invalid-utf8',
    description: 'invalid UTF-8 %FF percent-encoding passes through raw',
    method: 'GET',
    url: `${HOST}/api/users?q=%FF`,
  },
  {
    id: 'get-query-encoded-slash',
    description: 'percent-encoded slash in the query',
    method: 'GET',
    url: `${HOST}/api/users?p=%2Fadmin`,
  },
  {
    id: 'get-query-many-pairs',
    description: 'many query pairs',
    method: 'GET',
    url: `${HOST}/api/users?${manyPairs(100)}`,
  },
  {
    id: 'get-query-long',
    description: 'long query value',
    method: 'GET',
    url: `${HOST}/api/users?q=${'x'.repeat(600)}`,
  },
  {
    id: 'get-query-proto',
    description: 'query __proto__ key must stay inert',
    method: 'GET',
    url: `${HOST}/api/users?__proto__=polluted&a=1`,
  },
  {
    id: 'get-metadata',
    description: 'GET emitted metadata path',
    method: 'GET',
    url: `${HOST}/api`,
  },
  {
    id: 'get-dup-header',
    description: 'duplicate request header',
    method: 'GET',
    url: `${HOST}/api/users`,
    headers: [
      ['x-dup', 'a'],
      ['x-dup', 'b'],
    ],
  },
  {
    id: 'get-forwarded',
    description: 'X-Forwarded-For / X-Real-IP present but trust off',
    method: 'GET',
    url: `${HOST}/api/users`,
    headers: [
      ['x-forwarded-for', '203.0.113.9'],
      ['x-real-ip', '203.0.113.10'],
    ],
  },
  {
    id: 'head-root',
    description: 'HEAD request',
    method: 'HEAD',
    url: `${HOST}/`,
  },

  // ── Cookies ───────────────────────────────────────────────────────────
  {
    id: 'get-cookie',
    description: 'two cookies',
    method: 'GET',
    url: `${HOST}/dashboard`,
    headers: [['cookie', 'sid=abc; theme=dark']],
  },
  {
    id: 'get-cookie-quoted',
    description: 'quoted cookie value',
    method: 'GET',
    url: `${HOST}/dashboard`,
    headers: [['cookie', 'a="quoted value"']],
  },
  {
    id: 'get-cookie-empty',
    description: 'empty cookie value',
    method: 'GET',
    url: `${HOST}/dashboard`,
    headers: [['cookie', 'a=; b=2']],
  },
  {
    id: 'get-cookie-proto',
    description: 'cookie __proto__ key must stay inert',
    method: 'GET',
    url: `${HOST}/dashboard`,
    headers: [['cookie', '__proto__=polluted; sid=abc']],
  },

  // ── CORS / preflight ──────────────────────────────────────────────────
  {
    id: 'get-cors-allowed',
    description: 'CORS GET from an allowed origin',
    method: 'GET',
    url: `${HOST}/api/users`,
    headers: [['origin', 'https://app.example.com']],
    profile: 'cors',
  },
  {
    id: 'options-preflight-allowed',
    description: 'allowed CORS preflight',
    method: 'OPTIONS',
    url: `${HOST}/api/users`,
    headers: [
      ['origin', 'https://app.example.com'],
      ['access-control-request-method', 'GET'],
    ],
    profile: 'cors',
  },
  {
    id: 'options-preflight-denied',
    description: 'denied CORS preflight',
    method: 'OPTIONS',
    url: `${HOST}/api/users`,
    headers: [
      ['origin', 'https://evil.example.com'],
      ['access-control-request-method', 'GET'],
    ],
    profile: 'cors',
  },
  {
    id: 'options-plain',
    description: 'non-preflight OPTIONS',
    method: 'OPTIONS',
    url: `${HOST}/api/users`,
  },

  // ── JSON bodies: valid ────────────────────────────────────────────────
  {
    id: 'post-valid-json',
    description: 'valid JSON object body',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"ada"}',
  },
  {
    id: 'post-valid-json-nested',
    description: 'valid nested JSON object body',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"ada","tags":[1,2,3],"meta":{"x":true}}',
  },
  {
    id: 'post-json-proto',
    description: 'body __proto__ key must stay inert',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"__proto__":{"polluted":true},"name":"ada"}',
  },
  {
    id: 'post-json-constructor',
    description: 'body constructor/prototype keys must stay inert',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"constructor":{"prototype":{"polluted":true}}}',
  },
  {
    id: 'post-json-duplicate-keys',
    description: 'duplicate JSON keys (last-wins)',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"a","name":"b"}',
  },
  {
    id: 'post-json-trailing-newline',
    description: 'valid JSON with a trailing newline',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"ada"}\n',
  },
  {
    id: 'post-json-array',
    description: 'valid JSON array body',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '[1,2,3]',
  },
  {
    id: 'post-json-null',
    description: 'valid JSON null body',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: 'null',
  },

  // ── JSON bodies: invalid / edge ───────────────────────────────────────
  {
    id: 'post-bad-json',
    description: 'malformed JSON body',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{ not json',
  },
  {
    id: 'post-empty-body',
    description: 'empty body with a JSON content-type',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '',
  },
  {
    id: 'post-trailing-garbage',
    description: 'valid JSON followed by garbage',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"ada"} trailing',
  },
  {
    id: 'post-json-deep',
    description: 'deeply nested body (past the depth cap)',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: deeplyNested(200),
  },
  {
    id: 'post-oversized',
    description: 'body larger than maxBodyBytes',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: exactBody(600),
    // `bodyGuard` (requireJsonBody off): with requireJsonBody ON the route's
    // null-body re-run after a BODY_TOO_LARGE is itself terminal (400
    // invalid_json), short-circuiting the intended 413 — a pre-existing
    // route-layer behaviour, tracked in the task-7 report, not exercised here.
    profile: 'bodyGuard',
  },
  {
    id: 'post-exact-limit',
    description: 'body exactly at maxBodyBytes (boundary)',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: exactBody(512),
  },

  // ── Schema validation ─────────────────────────────────────────────────
  {
    id: 'schema-valid',
    description: 'body satisfies the configured schema',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":"ada"}',
    profile: 'schema',
  },
  {
    id: 'schema-missing-key',
    description: 'body missing a required schema key',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"age":1}',
    profile: 'schema',
  },
  {
    id: 'schema-wrong-type',
    description: 'body with a schema type mismatch',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [JSON_CT],
    body: '{"name":42}',
    profile: 'schema',
  },

  // ── Known-divergent route-layer behaviours ────────────────────────────
  {
    id: 'post-wrong-content-type',
    description: 'non-JSON content-type (route enforces 415)',
    method: 'POST',
    url: `${HOST}/api/users`,
    headers: [['content-type', 'text/plain']],
    body: '{"name":"ada"}',
  },
  {
    id: 'aborted-get',
    description: 'client already disconnected (route short-circuits 499)',
    method: 'GET',
    url: `${HOST}/api/users`,
    abort: true,
  },
]
