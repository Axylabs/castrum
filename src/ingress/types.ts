// src/ingress/types.ts — Public API types for the ingress module.
//
// Shared by the sync/async factories in ./index.ts and the result/context
// helpers in ./context.ts, so the implementation modules never need to import
// the public barrel.

import type { IngressFastOptions } from "./options";

/** Public ingress options (extends the fast-path options). */
export interface IngressOptions extends IngressFastOptions {
  enableRequestIds?: boolean;
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
export interface IngressHandler {
  (req: Request, ip?: string): Promise<IngressContext>;
}
