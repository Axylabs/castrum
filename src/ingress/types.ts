// src/ingress/types.ts — Public API types for the ingress module.
//
// Shared by the sync/async factories in ./index.ts and the result/context
// helpers in ./context.ts, so the implementation modules never need to import
// the public barrel.

import type { IngressFastOptions } from "./options";
import type { BakedIngressResult } from "./decode/baked-result";

/** Public ingress options (extends the fast-path options). */
export interface IngressOptions extends IngressFastOptions {
  enableRequestIds?: boolean;
  /**
   * Invoked before a request is processed (for tracing/context hooks).
   * Only used by the async `createIngress` path.
   */
  onRequest?: (req: Request, requestId: string, ip: string | undefined) => void;
  /**
   * Invoked after a terminal context (and its `Response`) is produced, for
   * metrics/logging hooks. Only used by the async `createIngress` path.
   */
  onResponse?: (
    req: Request,
    result: IngressContext,
    status: number,
    requestId: string,
  ) => void;
}

/**
 * Readonly structural view of a decoded ingress result.
 *
 * Note: the exported `FastIngressResult` class is the zero-alloc implementation;
 * this interface is the readonly view used by the public sync/async handlers.
 */
export interface IngressResult {
  readonly status: number;
  readonly verdict: number;
  readonly flags: number;
  readonly errorCode: number;
  readonly terminal: boolean;
  readonly ok: boolean;
  readonly https: boolean;
  readonly trustedProxy: boolean;
  readonly hasCookies: boolean;
  readonly hasQuery: boolean;
  readonly bodyValidJson: boolean;
  readonly schemaValid: boolean;
  readonly corsAllowed: boolean;
  readonly isPreflight: boolean;
  readonly rateLimited: boolean;
  readonly rateLimit: number;
  readonly rateRemaining: number;
  readonly rateResetMs: number;
  readonly retryAfterMs: number;
  readonly body: Uint8Array;
  readonly headerVariant: number;
  readonly requestId: string;
  readonly bodyTruncated: boolean;

  cookiesJson(): string;
  queryJson(): string;
  bodyJson(): Uint8Array;
}

/** A result plus the terminal Response computed for it. */
export interface IngressContext extends IngressResult {
  response: Response | null;
}

/**
 * Synchronous ingress handler.
 *
 * The callback runs on the zero-alloc result object and MUST be synchronous:
 * returning a Promise (or any thenable) throws. The result is invalidated after
 * `run()` returns, so capture the fields you need inside the callback (or use
 * the async {@link IngressHandler} which snapshots for you).
 */
export interface SyncIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    requestId: string,
    fn: (result: IngressResult) => T,
  ): T;
}

/** Async ingress handler (wraps {@link SyncIngressHandler} with body reading). */
export type IngressHandler = (req: Request, ip?: string) => Promise<IngressContext>;

// ── Pre-baked (handlers.ts) shared types ────────────────────────────
// These live here (not in ./handlers.ts) so the route factories in
// ./routes/* can import them without a type-only cycle back into the factory
// module that aggregates them. `handlers.ts` re-exports them for back-compat.

/** Mutable per-request context threaded through the pre-baked handler run. */
export interface BakedContext {
  /** The request-id string (null when `emitRequestIdHeader` is off). */
  requestIdHeader: string | null;
  /** The `Origin` request header when CORS extraction is enabled. */
  origin: string | null;
}

/**
 * An optimized ingress handler. `run()` is the zero-alloc pipeline entry
 * point; the response-builder methods are pre-baked and bound to this
 * handler's configuration, so consumers can build custom routes without
 * touching header templates or error bodies.
 */
export interface OptimizedIngressHandler {
  run<T>(
    req: Request,
    ip: string | undefined,
    body: Uint8Array | null,
    fn: (result: BakedIngressResult, ctx: BakedContext) => T,
  ): T;

  responseHeaders(
    variant: number,
    requestIdHeader: string | null,
    origin: string | null,
    rateRemaining?: number,
    rateResetSecs?: number,
    retryAfterSecs?: number,
  ): [string, string][];

  terminalHeaders(
    variant: number,
    ctx: BakedContext,
    result: BakedIngressResult | null,
  ): [string, string][];

  terminalResponse(
    req: Request,
    result: BakedIngressResult,
    ctx: BakedContext,
  ): Response | null;

  errorResponse(
    req: Request,
    result: BakedIngressResult | null,
    status: number,
    code: string,
    message: string,
    ctx: BakedContext,
  ): Response;

  internalErrorResponse(ctx: BakedContext, result?: BakedIngressResult): Response;

  withContentType(
    headers: ReadonlyArray<[string, string]>,
    contentType: string,
  ): [string, string][];

  /**
   * Build a zero-copy `Response` whose body is the request's pooled output
   * slice. The pooled buffer is returned to its pool once the body has been
   * consumed (stream closed) or the request aborted. Use when `copyBody` is
   * `false`; otherwise a copied body is released eagerly at the end of `run()`.
   */
  zeroCopyResponse(
    result: BakedIngressResult,
    ctx: BakedContext,
    init: ResponseInit,
  ): Response;
}
