// src/native/loader.ts — Native addon path resolution + lazy loading.
//
// Importing this module does NOT dlopen the addon; `getAddon()` /
// `lazyAddon()` trigger loading exactly once on first use. This keeps
// `import castrum` as cheap as possible on Bun.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { NativeAddon } from "./types";

const require = createRequire(import.meta.url);

function resolveAddonPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const platform = process.platform;
  const arch = process.arch;

  // napi-rs artifact naming: castrum.<platform>-<arch>[-<libc>].node
  // e.g. linux-x64-gnu, linux-x64-musl, win32-x64-msvc, darwin-arm64.
  const libcVariants =
    platform === "win32"
      ? ["msvc", "gnu"]
      : platform === "linux"
        ? ["gnu", "musl"]
        : [""];

  const names = libcVariants.map(
    (libc) => `castrum.${platform}-${arch}${libc ? `-${libc}` : ""}.node`,
  );
  names.push("castrum.node");

  const candidates: string[] = [];

  // Explicit override (napi-rs convention + castrum/legacy aliases). May be a
  // direct file path or a directory that contains the .node artifact.
  const envOverride =
    process.env.CASTRUM_NATIVE_LIBRARY_PATH ??
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH ??
    process.env.RUST_BENCH_NATIVE_LIBRARY_PATH;

  if (envOverride) {
    if (existsSync(envOverride)) {
      candidates.push(envOverride);
    }
    for (const name of names) {
      candidates.push(join(envOverride, name));
    }
  }

  // Candidate roots cover BOTH layouts:
  //   - source layout (Bun, raw TS): <pkg>/src/native → <pkg> via ".."/"../.."
  //   - bundled layout (Node, dist/): <pkg>/dist → <pkg> via ".."
  const roots = [
    __dirname, // <pkg>/dist (bundled) or <pkg>/src/native
    join(__dirname, ".."), // <pkg> when bundled into <pkg>/dist
    join(__dirname, "..", ".."), // <pkg> when running from <pkg>/src/native
  ];

  for (const root of roots) {
    for (const name of names) {
      candidates.push(join(root, name));
    }
  }

  // Local dev fallback: <pkg>/target/release.
  candidates.push(join(__dirname, "..", "..", "target", "release"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find castrum native addon.\n` +
      `Run: bun run build\n` +
      `Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

let cachedPath: string | undefined;

/** Resolve the addon file path exactly once (lazy). */
export function getAddonPath(): string {
  cachedPath ??= resolveAddonPath();
  return cachedPath;
}

let cachedAddon: NativeAddon | undefined;

/**
 * Load the native addon exactly once, lazily.
 *
 * The first call triggers loading (see {@link getAddonPath} for resolution).
 */
export function getAddon(): NativeAddon {
  if (cachedAddon === undefined) {
    const addonPath = getAddonPath();
    let loaded: NativeAddon;
    try {
      loaded = require(addonPath);
    } catch (err) {
      const cause = err instanceof Error ? `\n  Underlying cause: ${err.message}` : "";
      throw new Error(
        `Failed to load castrum native addon from:\n  ${addonPath}\n` +
          `The addon exists but could not be loaded (ABI mismatch, missing system ` +
          `libraries, or a corrupt/partial artifact).\n` +
          `Run: bun run build\n` +
          `If the problem persists, verify the binary was built for this platform/CPU.` +
          cause,
      );
    }

    if (process.env.CASTRUM_DEBUG || process.env.RUST_BENCH_DEBUG) {
      console.log("Native addon loaded from:", addonPath);
      console.log("Exported keys:", Object.keys(loaded).sort());
    }

    cachedAddon = loaded;
  }
  return cachedAddon;
}

/**
 * A lazily-loading proxy over the native addon.
 *
 * Use this in modules that only touch the addon at call time (e.g. the FFI
 * wrappers) so that importing them does not dlopen the addon until the first
 * real native call. All existing `addon.X` / `new addon.Y(...)` call sites
 * keep working unchanged.
 */
export function lazyAddon<T extends object>(loader: () => T): T {
  let loaded: T | undefined;
  return new Proxy({} as T, {
    get(_target, prop: string | symbol) {
      loaded ??= loader();
      return Reflect.get(loaded, prop);
    },
  });
}
