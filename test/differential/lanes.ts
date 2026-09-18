// test/differential/lanes.ts — lane registry + `runLane` for the differential
// transport-lane harness.
//
// A lane runs the SAME corpus through one transport/shape and normalizes each
// response to a comparable `NormalizedCase`. Comparison is then a pure diff of
// the chosen fields, so a harness bug shows up as an explicit divergence
// instead of a silent pass.
//
// In-process lanes (the controller ruling keeps cross-runtime OUT of scope —
// `bun run test:node` owns Bun-vs-Node):
//   - `fast`      : `createIngressFast` (path 1, `{"error":{...}}` wire format)
//   - `baked`     : `createIngressHandler` routes with `copyBody: true`
//                   (path 2, `{"ok":false,"error":{...}}` wire format)
//   - `zero-copy` : the same baked routes with `copyBody: false`
//
// `fast` vs `baked` DO NOT share a wire format, so they are compared on
// SEMANTIC fields only (status + ok/error code) — never raw bytes. `baked` vs
// `zero-copy` share the format and are compared byte-for-byte (after redacting
// the per-request `requestId`).
//
// The `ffi`/`napi` transport lane is PROCESS-GLOBAL (`getBunFFI` binds once and
// caches; `CASTRUM_FFI_MODE` is read at that bind), so it cannot be switched
// in-process. It is implemented as a SUBPROCESS lane (`transport-runner.ts`)
// rather than faked; `transportAvailable()` reports whether the in-process
// bun:ffi transport is live.

import { decoder } from '../../src/shared/bytes'
import { errorCodeName } from '../../src/ingress/errors'
import { ffiBufferMode } from '../../src/native/ffi'
import { createIngressFast } from '../../src/ingress/fast'
import {
  createIngressHandler,
  jsonWriteHandler,
  optionsHandler,
  readHandler,
} from '../../src/ingress/handlers'
import {
  buildResponseContext,
  headersForResult,
  type ResponseBuildContext,
} from '../../src/ingress/headers/fast-templates'
import type { IngressFastHandler, IngressFastOptions } from '../../src/ingress/options'
import { buildTerminalResponse } from '../../src/ingress/response/terminal'
import type { OptimizedIngressHandler } from '../../src/ingress/types'
import {
  buildRequest,
  caseBodyBytes,
  caseOptions,
  type CorpusCase,
  type CorpusProfile,
} from './corpus'

/** Every lane the harness can run. */
export type LaneName = 'fast' | 'baked' | 'zero-copy' | 'transport-ffi' | 'transport-napi'

/** Fields a lane result exposes for comparison. */
export type ComparableField = 'status' | 'ok' | 'errorCode' | 'headers' | 'body'

/** The semantic subset used where two lanes intentionally differ in shape. */
export const SEMANTIC_FIELDS: readonly ComparableField[] = ['status', 'ok', 'errorCode']

/** The full field set used where two lanes SHOULD be byte-identical. */
export const FULL_FIELDS: readonly ComparableField[] = [
  'status',
  'ok',
  'errorCode',
  'headers',
  'body',
]

/** One normalized response, comparable across lanes. */
export interface NormalizedCase {
  readonly id: string
  readonly status: number
  /** `true` = success, `false` = rejection, `null` = no opinion (499 abort). */
  readonly ok: boolean | null
  /** Canonical error code, or `null` on success. */
  readonly errorCode: string | null
  /** Lowercased response headers. */
  readonly headers: Readonly<Record<string, string>>
  /** Response body text with the volatile `requestId` redacted. */
  readonly body: string
}

/** The normalized result of running a whole corpus through one lane. */
export interface LaneResult {
  readonly lane: LaneName
  readonly cases: readonly NormalizedCase[]
}

/** Optional test-only injection point (used by the divergence self-test). */
export interface RunLaneOptions {
  /**
   * Transform the lane result before it is returned. The divergence self-test
   * uses this to perturb one lane in-memory; the shipped lanes never set it.
   */
  readonly mutate?: (result: LaneResult) => LaneResult
}

/** A single field-level divergence between two lane results. */
export interface LaneDiff {
  readonly id: string
  readonly field: ComparableField | 'presence'
  readonly a: unknown
  readonly b: unknown
}

const FIXED_REQUEST_ID = '0000000000000000'
const IP = '127.0.0.1'

/**
 * Canonicalize the error-code strings the two wire formats use for the same
 * native error code. The fast template emits `errorCodeName` (`internal`,
 * `schema_validation`, `cors_preflight`); the baked static error bodies use
 * more verbose names (`internal_error`, `schema_validation_failed`,
 * `cors_preflight_not_allowed`). Normalizing both to the fast spelling lets
 * `fast`/`baked` be compared semantically.
 */
const ERROR_CODE_ALIASES: Readonly<Record<string, string>> = {
  internal_error: 'internal',
  schema_validation_failed: 'schema_validation',
  cors_preflight_not_allowed: 'cors_preflight',
}

/** Map a raw error-code string to its canonical semantic name. */
export function canonicalErrorCode(code: string | null): string | null {
  if (code === null) return null
  return ERROR_CODE_ALIASES[code] ?? code
}

/**
 * Derive the semantic `ok`/`errorCode` from a response status.
 *
 * `499` is the route-layer client-abort short-circuit: it carries no JSON
 * opinion, so both fields are `null`. Any other 2xx/3xx is success (whatever
 * the raw native verdict was — e.g. an allowed preflight is a terminal native
 * result but not an error); any >=400 is a rejection.
 */
export function semanticOutcome(
  status: number,
  code: string | null,
): { ok: boolean | null; errorCode: string | null } {
  if (status === 499) return { ok: null, errorCode: null }
  if (status >= 400) return { ok: false, errorCode: code }
  return { ok: true, errorCode: null }
}

/** Redact the per-request `requestId` so otherwise-identical bodies compare. */
export function redactRequestId(text: string): string {
  return text.replace(/"requestId":"[^"]*"/g, '"requestId":"<rid>"')
}

/** Lowercased `Record` of a `Headers` instance. */
function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/** Deterministic value encoding for header-record comparison. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`
}

/** Structural equality for normalized fields. */
function fieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return stable(a) === stable(b)
}

/**
 * Diff two lane results over `fields`. Empty result = the lanes agree.
 */
export function diffLaneResults(
  a: LaneResult,
  b: LaneResult,
  fields: readonly ComparableField[],
): LaneDiff[] {
  const diffs: LaneDiff[] = []
  const byId = new Map(b.cases.map((c) => [c.id, c]))
  for (const ca of a.cases) {
    const cb = byId.get(ca.id)
    if (cb === undefined) {
      diffs.push({ id: ca.id, field: 'presence', a: 'present', b: 'missing' })
      continue
    }
    for (const field of fields) {
      if (!fieldEqual(ca[field], cb[field])) {
        diffs.push({ id: ca.id, field, a: ca[field], b: cb[field] })
      }
    }
  }
  // Cases present only in `b`.
  const aIds = new Set(a.cases.map((c) => c.id))
  for (const cb of b.cases) {
    if (!aIds.has(cb.id)) {
      diffs.push({ id: cb.id, field: 'presence', a: 'missing', b: 'present' })
    }
  }
  return diffs
}

/** Human-readable divergence report. */
export function formatLaneDiffs(diffs: readonly LaneDiff[]): string {
  return diffs.map((d) => `${d.id}.${d.field}: ${stable(d.a)} !== ${stable(d.b)}`).join('; ')
}

/** Throw with every divergence when two lanes disagree over `fields`. */
export function assertLanesAgree(
  a: LaneResult,
  b: LaneResult,
  fields: readonly ComparableField[],
  label = `${a.lane} vs ${b.lane}`,
): void {
  const diffs = diffLaneResults(a, b, fields)
  if (diffs.length > 0) {
    throw new Error(`${label} diverged on ${diffs.length} field(s): ${formatLaneDiffs(diffs)}`)
  }
}

// ── Fast lane (path 1, direct packed-input pipeline) ────────────────────

interface FastCapture {
  status: number
  rawErrorCode: string | null
  response: Response | null
  headers: Headers
  bodyJson: Uint8Array
}

async function runFastLane(corpus: readonly CorpusCase[]): Promise<LaneResult> {
  const handlers = new Map<CorpusProfile, IngressFastHandler>()
  const contexts = new Map<CorpusProfile, ResponseBuildContext>()

  const handlerFor = (profile: CorpusProfile): IngressFastHandler => {
    let handler = handlers.get(profile)
    if (handler === undefined) {
      handler = createIngressFast(caseOptions(profile))
      handlers.set(profile, handler)
    }
    return handler
  }
  const contextFor = (profile: CorpusProfile): ResponseBuildContext => {
    let ctx = contexts.get(profile)
    if (ctx === undefined) {
      ctx = buildResponseContext(caseOptions(profile))
      contexts.set(profile, ctx)
    }
    return ctx
  }

  const cases: NormalizedCase[] = []
  for (const c of corpus) {
    if (c.lanes !== undefined && !c.lanes.includes('fast')) continue
    const profile = c.profile ?? 'base'
    const handler = handlerFor(profile)
    const responseCtx = contextFor(profile)
    const req = buildRequest(c)
    const body = caseBodyBytes(c)

    let captured: FastCapture | null = null
    handler.run(req, IP, body, FIXED_REQUEST_ID, (result) => {
      const response = buildTerminalResponse(responseCtx, result, req, FIXED_REQUEST_ID)
      const status = response?.status ?? result.status
      captured = {
        status,
        rawErrorCode: result.ok ? null : canonicalErrorCode(errorCodeName(result.errorCode)),
        response,
        headers: response?.headers ?? headersForResult(responseCtx, result, req, FIXED_REQUEST_ID),
        bodyJson: result.bodyJson().slice(),
      }
      return null
    })
    const cap = captured as FastCapture | null
    if (cap === null) {
      throw new Error(`fast lane captured no result for case '${c.id}'`)
    }
    const text = cap.response !== null ? await cap.response.text() : decoder.decode(cap.bodyJson)
    const outcome = semanticOutcome(cap.status, cap.rawErrorCode)
    cases.push({
      id: c.id,
      status: cap.status,
      ok: outcome.ok,
      errorCode: outcome.errorCode,
      headers: headerRecord(cap.headers),
      body: redactRequestId(text),
    })
  }
  return { lane: 'fast', cases }
}

// ── Baked route lanes (path 2; copy vs zero-copy) ───────────────────────

type RouteFn = (req: Request, srv?: unknown) => Response | Promise<Response>

function pickRoute(
  handler: OptimizedIngressHandler,
  method: string,
  copyBody: boolean,
  maxBodyBytes: number | undefined,
): RouteFn {
  const upper = method.toUpperCase()
  if (upper === 'OPTIONS') return optionsHandler(handler)
  if (upper === 'POST' || upper === 'PUT' || upper === 'PATCH') {
    return jsonWriteHandler(handler, { copyBody, maxBodyBytes })
  }
  return readHandler(handler, { copyBody })
}

function normalizeBakedResponse(id: string, res: Response, text: string): NormalizedCase {
  let rawCode: string | null = null
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed.error as { code?: unknown } | undefined
      if (error !== undefined && typeof error.code === 'string') {
        rawCode = canonicalErrorCode(error.code)
      }
    } catch {
      // Non-JSON body (204 preflight, 499 abort) — no semantic JSON opinion.
    }
  }
  const outcome = semanticOutcome(res.status, rawCode)
  return {
    id,
    status: res.status,
    ok: outcome.ok,
    errorCode: outcome.errorCode,
    headers: headerRecord(res.headers),
    body: redactRequestId(text),
  }
}

async function runRouteLane(
  lane: 'baked' | 'zero-copy',
  corpus: readonly CorpusCase[],
): Promise<LaneResult> {
  const copyBody = lane === 'baked'
  const handlers = new Map<CorpusProfile, OptimizedIngressHandler>()
  const optionsByProfile = new Map<CorpusProfile, IngressFastOptions>()

  const handlerFor = (profile: CorpusProfile): OptimizedIngressHandler => {
    let handler = handlers.get(profile)
    if (handler === undefined) {
      handler = createIngressHandler(caseOptions(profile))
      handlers.set(profile, handler)
    }
    return handler
  }
  const optionsFor = (profile: CorpusProfile): IngressFastOptions => {
    let opts = optionsByProfile.get(profile)
    if (opts === undefined) {
      opts = caseOptions(profile)
      optionsByProfile.set(profile, opts)
    }
    return opts
  }

  const cases: NormalizedCase[] = []
  for (const c of corpus) {
    if (c.lanes !== undefined && !c.lanes.includes(lane)) continue
    const profile = c.profile ?? 'base'
    const handler = handlerFor(profile)
    const opts = optionsFor(profile)
    const req = buildRequest(c)
    const route = pickRoute(handler, req.method, copyBody, opts.maxBodyBytes)
    const res = await route(req)
    const text = await res.text()
    cases.push(normalizeBakedResponse(c.id, res, text))
  }
  return { lane, cases }
}

// ── Transport lane (subprocess; process-global CASTRUM_FFI_MODE) ────────

const TRANSPORT_RUNNER = new URL('./transport-runner.ts', import.meta.url)
const REPO_ROOT = new URL('../../', import.meta.url)

/**
 * Whether the in-process `bun:ffi` transport is live. When `false` (Node, or a
 * forced/failed napi fallback) the ffi/napi transport lane is skipped — there
 * is no second transport to compare against.
 */
export function transportAvailable(): boolean {
  return ffiBufferMode() !== null
}

function runTransportLane(mode: 'ffi' | 'napi'): LaneResult {
  if (typeof Bun === 'undefined' || typeof Bun.spawnSync !== 'function') {
    throw new Error('transport lane requires Bun.spawnSync')
  }
  const proc = Bun.spawnSync({
    cmd: [process.execPath, TRANSPORT_RUNNER.pathname],
    cwd: REPO_ROOT.pathname,
    env: { ...process.env, CASTRUM_FFI_MODE: mode },
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `transport lane '${mode}' subprocess exited ${proc.exitCode}: ${proc.stderr.toString()}`,
    )
  }
  const parsed = JSON.parse(proc.stdout.toString()) as LaneResult
  return { lane: `transport-${mode}`, cases: parsed.cases }
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Run a whole corpus through one lane and return its normalized result.
 *
 * @param name - Lane to run.
 * @param corpus - Cases to run (already filtered to those the lane supports).
 * @param opts - Test-only injection point (divergence self-test).
 */
export async function runLane(
  name: LaneName,
  corpus: readonly CorpusCase[],
  opts: RunLaneOptions = {},
): Promise<LaneResult> {
  let result: LaneResult
  switch (name) {
    case 'fast':
      result = await runFastLane(corpus)
      break
    case 'baked':
    case 'zero-copy':
      result = await runRouteLane(name, corpus)
      break
    case 'transport-ffi':
      result = runTransportLane('ffi')
      break
    case 'transport-napi':
      result = runTransportLane('napi')
      break
  }
  return opts.mutate === undefined ? result : opts.mutate(result)
}
