// src/ingress/shared.ts — Constants and types shared by BOTH ingress paths
// (the fast packed-input path and the pre-baked handler path).
//
// Binary-layout constants read from Rust live in ./constants.ts (the single
// numeric source of truth). This module holds the JS-level constants and types
// that both ingress paths rely on, so neither path needs to depend on the
// other's implementation module.

/** Default maximum request body size in bytes. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Maps HTTP methods to the native Ingress method-kind enum. */
export const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};

/** Which request headers to extract into the packed input. */
export interface HeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}
