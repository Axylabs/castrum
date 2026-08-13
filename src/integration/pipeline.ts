// src/integration/pipeline.ts — framework-agnostic ingress pipeline adapter.
//
// Embeds the pre-baked ingress pipeline as a request stage that ANY Bun
// backend framework can use: Hono middleware, Elysia onRequest, or a plain
// Bun.serve `fetch`. `preprocess` runs the rate-limit / CORS / schema / body
// logic and either short-circuits (terminal) or hands a snapshotted result +
// context to the app's own handler. `handleRequest` is a fetch-compatible
// convenience that serves the terminal response or a rendered OK response.

import {
  createIngressHandler,
  type BakedIngressRuntime,
  type OptimizedIngressHandler,
} from '../ingress/handlers'
import type { BakedContext } from '../ingress/types'
import type { IngressHandlerOptions } from '../ingress/options'
import { readBodyWithLimit } from '../ingress/body'
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_BODY_TIMEOUT_MS } from '../ingress/shared'
import { generateRequestId } from '../shared/request-id'
import { decoder } from '../shared/bytes'
import type { BakedIngressResult } from '../ingress/decode/baked-result'

/** Readonly snapshot of the ingress decision, safe after `run()` returns. */
export interface PipelineResult {
  readonly ok: boolean
  readonly status: number
  readonly errorCode: number
  readonly terminal: boolean
  readonly rateLimited: boolean
  readonly bodyValidJson: boolean
  readonly schemaValid: boolean
  readonly bodyTruncated: boolean
  readonly requestId: string
  /** The raw request body the pipeline saw (read-only; aliases the request body). */
  readonly body: Uint8Array
  /** The ingress metadata JSON body (when `emitMetadataJson` is on), else empty. */
  readonly metadataJson: Uint8Array
}

/** Per-request context threaded into the app's handler. */
export interface PipelineContext {
  readonly requestId: string
  readonly ip: string | undefined
  /** Mutable per-request storage for middleware/user state. */
  readonly locals: Map<string, unknown>
}

export interface PreprocessOutcome {
  /** True when the pipeline short-circuited (error/denied) — serve `response`. */
  readonly terminal: boolean
  readonly response: Response | null
  readonly result: PipelineResult | null
  readonly ctx: PipelineContext
}

export interface CreatePipelineOptions {
  /** Ingress options (same surface as `createIngressHandler`). */
  options?: IngressHandlerOptions
  /** Runtime hooks: onRequest/onResponse/onError, logging, pool sizing. */
  runtime?: BakedIngressRuntime
  /** Body limit for `readBody`/`preprocess`. Default: 1 MiB. */
  maxBodyBytes?: number
  /** Body-read deadline (ms) for `readBody`/`preprocess`. Default: 30s. */
  bodyTimeoutMs?: number
  /**
   * When true (default), `preprocess` reads a request body (guarded) so the
   * result carries it. Set false when the app handler owns the body.
   */
  readBody?: boolean
  /**
   * Optional renderer for the OK (non-terminal) case of `handleRequest`.
   * Defaults to a minimal `{"ok":true,"requestId":...}` JSON body.
   */
  render?: (result: PipelineResult, ctx: PipelineContext) => Response | Promise<Response>
}

export interface IngressPipeline {
  /** The underlying pre-baked handler (custom route factories / responses). */
  readonly ingress: OptimizedIngressHandler
  /** Run the pipeline for a middleware/framework. */
  preprocess(req: Request, ip?: string): Promise<PreprocessOutcome>
  /** Fetch-compatible handler: terminal response or the renderer's response. */
  handleRequest(req: Request, ip?: string): Promise<Response>
  /** Stream-read a request body with the configured limits. */
  readBody(req: Request, maxBytes?: number, timeoutMs?: number): Promise<Uint8Array>
}

function snapshotResult(result: BakedIngressResult, requestId: string): PipelineResult {
  return {
    ok: result.ok,
    status: result.status,
    errorCode: result.errorCode,
    terminal: result.terminal,
    rateLimited: result.rateLimited,
    bodyValidJson: result.bodyValidJson,
    schemaValid: result.schemaValid,
    bodyTruncated: result.bodyTruncated,
    requestId,
    body: result.body,
    metadataJson: result.bodyJson(true) as Uint8Array,
  }
}

/** Build a terminal error response for a body-read failure (413/408/400). */
function bodyErrorResponse(
  ingress: OptimizedIngressHandler,
  req: Request,
  requestId: string,
  err: unknown,
): Response {
  const ctx: BakedContext = {
    requestIdHeader: requestId,
    origin: req.headers.get('origin'),
  }
  const code = (err as { code?: string } | null)?.code
  if (code === 'BODY_TOO_LARGE') {
    return ingress.errorResponse(req, null, 413, 'body_too_large', 'Request body is too large', ctx)
  }
  if (code === 'REQUEST_TIMEOUT') {
    return ingress.errorResponse(
      req,
      null,
      408,
      'request_timeout',
      'Request body read timed out',
      ctx,
    )
  }
  return ingress.errorResponse(req, null, 400, 'bad_request', 'Bad request', ctx)
}

/**
 * Create a framework-agnostic ingress pipeline.
 *
 * @example
 * ```ts
 * // Plain Bun.serve fetch handler
 * const pipeline = createPipeline({ options: { parseCookies: true } });
 * Bun.serve({ port: 3000, fetch: (req) => pipeline.handleRequest(req) });
 *
 * // Hono-style middleware: short-circuit on terminal, else handle the app route
 * app.use("*", async (c, next) => {
 *   const { terminal, response, ctx } = await pipeline.preprocess(c.req.raw);
 *   if (terminal && response) return response;
 *   c.set("ingress", ctx); // pass requestId / locals into the app handler
 *   await next();
 * });
 * ```
 */
export function createPipeline(opts: CreatePipelineOptions = {}): IngressPipeline {
  const ingress = createIngressHandler(opts.options ?? {}, opts.runtime ?? {})
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS
  const readBodyEnabled = opts.readBody !== false
  const render =
    opts.render ??
    ((result: PipelineResult): Response =>
      new Response(JSON.stringify({ ok: true, requestId: result.requestId }), {
        status: result.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }))

  async function preprocess(req: Request, ip?: string): Promise<PreprocessOutcome> {
    const requestId = decoder.decode(generateRequestId())
    const ctx: PipelineContext = { requestId, ip, locals: new Map() }

    let body: Uint8Array | null = null
    if (readBodyEnabled && req.body !== null) {
      try {
        body = await readBodyWithLimit(req, maxBodyBytes, true, bodyTimeoutMs)
      } catch (err) {
        return {
          terminal: true,
          response: bodyErrorResponse(ingress, req, requestId, err),
          result: null,
          ctx,
        }
      }
    }

    return ingress.run<PreprocessOutcome>(req, ip, body, (result, ingressCtx) => {
      if (result.terminal) {
        return {
          terminal: true,
          response: ingress.terminalResponse(req, result, ingressCtx),
          result: null,
          ctx,
        }
      }
      return {
        terminal: false,
        response: null,
        result: snapshotResult(result, requestId),
        ctx,
      }
    })
  }

  async function handleRequest(req: Request, ip?: string): Promise<Response> {
    const outcome = await preprocess(req, ip)
    if (outcome.terminal && outcome.response) {
      return outcome.response
    }
    const result = outcome.result as PipelineResult
    return render(result, outcome.ctx)
  }

  function readBody(
    req: Request,
    maxBytes: number = maxBodyBytes,
    timeoutMs: number = bodyTimeoutMs,
  ): Promise<Uint8Array> {
    return readBodyWithLimit(req, maxBytes, true, timeoutMs)
  }

  return { ingress, preprocess, handleRequest, readBody }
}
