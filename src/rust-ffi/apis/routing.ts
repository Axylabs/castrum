import type { FfiRuntime } from "../runtime";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RouteMatch {
  routeId: number;
  params: Record<string, string> | null;
}

export type MethodRoutes = Record<string, string[]>;

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function extractParamNames(pattern: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;

  let match: RegExpExecArray | null;

  while ((match = re.exec(pattern)) !== null) {
    let name = match[1] ?? "";

    if (name.startsWith("*")) {
      name = name.slice(1);
    }

    if (name.length > 0) {
      names.push(name);
    }
  }

  return names;
}

interface RawMatchResult {
  out: Uint8Array;
  written: number;
}

/**
 * Single precompiled matchit router.
 *
 * Use one router per HTTP method for framework routing.
 */
export class MatchitRouter {
  private runtime: FfiRuntime;
  private handle: bigint;
  private paramNames: string[][];
  private destroyed = false;

  private pathBuffer: Uint8Array;
  private outBuffer: Uint8Array;

  constructor(runtime: FfiRuntime, patterns: string[]) {
    this.runtime = runtime;

    const bytes = encoder.encode(JSON.stringify(patterns));

    const handle = runtime.symbols.rust_router_create(
      runtime.ptr(bytes),
      bytes.byteLength,
    ) as bigint;

    if (handle === 0n) {
      throw new Error("Failed to create Rust matchit router");
    }

    this.handle = handle;
    this.paramNames = patterns.map((pattern) => extractParamNames(pattern));

    this.pathBuffer = new Uint8Array(8192);
    this.outBuffer = new Uint8Array(4096);
  }

  /**
   * Fastest match.
   *
   * Returns only route ID.
   * Does not extract params.
   */
  matchId(path: string): number | null {
    if (this.destroyed) {
      return null;
    }

    const encoded = encoder.encodeInto(path, this.pathBuffer);

    if (encoded.read === path.length) {
      return this.callMatchId(this.pathBuffer, encoded.written);
    }

    const bytes = encoder.encode(path);
    return this.callMatchId(bytes, bytes.byteLength);
  }

  /**
   * Match route and extract params.
   */
  match(path: string): RouteMatch | null {
    if (this.destroyed) {
      return null;
    }

    const encoded = encoder.encodeInto(path, this.pathBuffer);

    if (encoded.read === path.length) {
      const asciiFastPath = encoded.written === path.length;

      const raw = this.runMatch(this.pathBuffer, encoded.written);

      if (!raw) {
        return null;
      }

      return this.parse(
        raw.out,
        raw.written,
        path,
        this.pathBuffer,
        asciiFastPath,
      );
    }

    const bytes = encoder.encode(path);
    const asciiFastPath = bytes.byteLength === path.length;

    const raw = this.runMatch(bytes, bytes.byteLength);

    if (!raw) {
      return null;
    }

    return this.parse(raw.out, raw.written, path, bytes, asciiFastPath);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.runtime.symbols.rust_router_destroy(this.handle);
    this.destroyed = true;
  }

  private callMatchId(pathBytes: Uint8Array, pathLen: number): number | null {
    const result = toNumber(
      this.runtime.symbols.rust_router_match_id(
        this.handle,
        this.runtime.ptr(pathBytes),
        pathLen,
      ),
    );

    if (result === 0) {
      return null;
    }

    if (result < 0) {
      throw new Error(`Rust rust_router_match_id failed: ${result}`);
    }

    return result - 1;
  }

  private runMatch(
    pathBytes: Uint8Array,
    pathLen: number,
  ): RawMatchResult | null {
    let out = this.outBuffer;

    // Normally runs once.
    // Only retries if the output buffer is too small.
    for (let attempt = 0; attempt < 8; attempt++) {
      const written = toNumber(
        this.runtime.symbols.rust_router_match(
          this.handle,
          this.runtime.ptr(pathBytes),
          pathLen,
          this.runtime.ptr(out),
          out.byteLength,
        ),
      );

      if (written === 0) {
        return null;
      }

      if (written === -2) {
        out = new Uint8Array(out.byteLength * 2);
        continue;
      }

      if (written < 0) {
        throw new Error(`Rust rust_router_match failed: ${written}`);
      }

      if (out !== this.outBuffer) {
        this.outBuffer = out;
      }

      return { out, written };
    }

    throw new Error("Rust rust_router_match output buffer grew too large");
  }

  private parse(
    out: Uint8Array,
    written: number,
    path: string,
    pathBytes: Uint8Array,
    asciiFastPath: boolean,
  ): RouteMatch {
    const view = new DataView(out.buffer, out.byteOffset, written);

    const routeId = view.getUint32(0, true);
    const paramCount = view.getUint8(4);

    if (paramCount === 0) {
      return {
        routeId,
        params: null,
      };
    }

    const names = this.paramNames[routeId] ?? [];
    const params: Record<string, string> = {};

    let pos = 5;

    for (let i = 0; i < paramCount; i++) {
      const paramIndex = view.getUint8(pos);
      pos += 1;

      const start = view.getUint32(pos, true);
      pos += 4;

      const end = view.getUint32(pos, true);
      pos += 4;

      const key = names[paramIndex] ?? `param${paramIndex}`;

      // Fast path for ASCII/percent-encoded URL paths.
      // UTF-8 byte offsets match JS string indices.
      const value = asciiFastPath
        ? path.substring(start, end)
        : decoder.decode(pathBytes.subarray(start, end));

      params[key] = value;
    }

    return {
      routeId,
      params,
    };
  }
}

/**
 * Convenience router for frameworks.
 *
 * Creates one precompiled matchit router per HTTP method.
 */
export class MethodRouter {
  private routers = new Map<string, MatchitRouter>();

  constructor(runtime: FfiRuntime, routes: MethodRoutes) {
    for (const [method, patterns] of Object.entries(routes)) {
      this.routers.set(
        method.toUpperCase(),
        new MatchitRouter(runtime, patterns),
      );
    }
  }

  matchId(method: string, path: string): number | null {
    const router = this.routers.get(method.toUpperCase());
    return router ? router.matchId(path) : null;
  }

  match(method: string, path: string): RouteMatch | null {
    const router = this.routers.get(method.toUpperCase());
    return router ? router.match(path) : null;
  }

  destroy(): void {
    for (const router of this.routers.values()) {
      router.destroy();
    }

    this.routers.clear();
  }
}

export function createRoutingApi(runtime: FfiRuntime) {
  return {
    createRouter(patterns: string[]): MatchitRouter {
      return new MatchitRouter(runtime, patterns);
    },

    createMethodRouter(routes: MethodRoutes): MethodRouter {
      return new MethodRouter(runtime, routes);
    },
  };
}

export type RoutingApi = ReturnType<typeof createRoutingApi>;