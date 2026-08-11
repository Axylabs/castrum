// src/rust-ffi/scalar/factories.ts — Compiled-once instance factories + rayon runtime.
//
// Every `create*` here constructs a compiled-once native instance (key / schema
// / template precompiled at construction) plus the rayon thread-pool controls.

import { asNumber } from "../options";
import type { RustClientContext } from "../context";
import type {
  HmacSignerInstance,
  SchemaValidatorInstance,
  TemplateRendererInstance,
  FormParserInstance,
  MediaTypeParserInstance,
  MediaTypeMatcherInstance,
  ConditionalRequestInstance,
  AcceptNegotiatorInstance,
  Base64CodecInstance,
  CookieSignerInstance,
  CsrfProtectorInstance,
  UrlBuilderInstance,
  JwtSignerInstance,
  AeadCipherInstance,
  Argon2HasherInstance,
  RateLimiterInstance,
  PasswordHashOptions,
} from "../../native";

/** Compiled-once factory + runtime-control methods (`Pick<RustScalar, ...>`). */
export function buildFactories(ctx: RustClientContext) {
  const { addon } = ctx;

  return {
    createSchemaValidator(schema: Uint8Array): SchemaValidatorInstance {
      return new addon.SchemaValidator(schema);
    },
    createHmacSigner(key: Uint8Array): HmacSignerInstance {
      return new addon.HmacSigner(key);
    },
    createTemplateRenderer(source: string): TemplateRendererInstance {
      return new addon.TemplateRenderer(source);
    },
    createFormParser(capacity?: number): FormParserInstance {
      return new addon.FormParser(capacity);
    },
    createMediaTypeParser(): MediaTypeParserInstance {
      return new addon.MediaTypeParser();
    },
    createConditionalRequest(
      etagValue: Uint8Array,
      lastModifiedSecs?: number,
    ): ConditionalRequestInstance {
      return new addon.ConditionalRequest(etagValue, lastModifiedSecs ?? undefined);
    },
    createAcceptNegotiator(supported: string[]): AcceptNegotiatorInstance {
      return new addon.AcceptNegotiator(supported);
    },
    createBase64Codec(urlSafe?: boolean, padding?: boolean): Base64CodecInstance {
      return new addon.Base64Codec(urlSafe ?? undefined, padding ?? undefined);
    },
    createCookieSigner(secret: Uint8Array): CookieSignerInstance {
      return new addon.CookieSigner(secret);
    },
    createCsrfProtector(secret: Uint8Array): CsrfProtectorInstance {
      return new addon.CsrfProtector(secret);
    },
    createUrlBuilder(base: Uint8Array): UrlBuilderInstance {
      return new addon.UrlBuilder(base);
    },
    createJwtSigner(
      secret: Uint8Array,
      ttlSeconds?: number,
    ): JwtSignerInstance {
      return new addon.JwtSigner(secret, ttlSeconds ?? undefined);
    },
    createAeadCipher(
      key: Uint8Array,
      algorithm?: string,
    ): AeadCipherInstance {
      return new addon.AeadCipher(key, algorithm ?? undefined);
    },
    createArgon2Hasher(
      options?: PasswordHashOptions | null,
    ): Argon2HasherInstance {
      return new addon.Argon2Hasher(options ?? undefined);
    },
    createMediaTypeMatcher(expected: Uint8Array): MediaTypeMatcherInstance {
      return new addon.MediaTypeMatcher(expected);
    },
    createRateLimiter(
      limit: number,
      windowMs: number,
      maxEntries?: number | null,
    ): RateLimiterInstance {
      return new addon.RateLimiter(limit, windowMs, maxEntries ?? undefined);
    },
    initThreadPool(threads?: number): void {
      // Explicit user call also establishes the pool state locally.
      ctx.markPoolInitialized();
      if (threads !== undefined) ctx.setPendingThreads(threads);
      addon.initThreadPool(threads);
    },
    rayonNumThreads(): number {
      return asNumber(addon.rayonNumThreads() as unknown);
    },
  };
}
