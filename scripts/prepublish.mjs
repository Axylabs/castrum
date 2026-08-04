#!/usr/bin/env node
// scripts/prepublish.mjs
//
// Pre-publish guard for the `castrum` npm package (runs as package.json
// "prepublishOnly" before `npm publish` packs the tarball).
//
// castrum ships ALL platform native addons in a single tarball
// (`castrum.<platform>-<arch>.node`); the loader in `src/native/index.ts`
// selects the right one at runtime. Publishing without every platform would
// produce a package that silently fails to load on the missing platforms, so
// we verify (and fail fast) that an artifact exists for every target declared
// in package.json -> "napi.targets".
//
// The CI publish workflow (see .github/workflows/ci.yml) downloads the
// per-platform addons built by the "build" job into ./artifacts and calls
// `npm publish`; this script stages those files into the package root before
// verifying. Locally, `npm publish` without all artifacts will fail with
// instructions — push a v* tag and let CI build + publish instead.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const binaryName = pkg.napi?.binaryName;
const targets = pkg.napi?.targets ?? [];

if (!binaryName || targets.length === 0) {
  console.error(
    "prepublish: package.json is missing napi.binaryName or napi.targets.",
  );
  process.exit(1);
}

// napi-rs names artifacts `{binaryName}.{platform}-{arch}[-{libc}].node`, but
// package.json "napi.targets" lists full Rust target triples. Map a triple to
// the napi artifact suffix so we look for the file napi actually produces.
function tripleToNapiSuffix(triple) {
  const [archPart] = triple.split("-");
  const arch =
    archPart === "x86_64"
      ? "x64"
      : archPart === "aarch64"
        ? "arm64"
        : archPart === "i686"
          ? "ia32"
          : archPart === "armv7"
            ? "arm"
            : archPart;

  let platform;
  let libc = null;
  if (triple.includes("windows")) {
    platform = "win32";
    libc = triple.includes("msvc") ? "msvc" : "gnu";
  } else if (triple.includes("darwin")) {
    platform = "darwin";
  } else if (triple.includes("linux")) {
    platform = "linux";
    libc = triple.includes("musl") ? "musl" : "gnu";
  } else if (triple.includes("android")) {
    platform = "android";
  } else if (triple.includes("freebsd")) {
    platform = "freebsd";
  } else {
    platform = triple.split("-")[2];
  }

  return libc ? `${platform}-${arch}-${libc}` : `${platform}-${arch}`;
}

// 1. Stage any addons downloaded by CI into ./artifacts.
const artifactsDir = join(root, "artifacts");
if (existsSync(artifactsDir)) {
  for (const file of readdirSync(artifactsDir)) {
    if (file.endsWith(".node")) {
      copyFileSync(join(artifactsDir, file), join(root, file));
      console.log(`prepublish: staged ${file} into package root`);
    }
  }
}

// 2. Verify every napi target has a non-empty artifact in the package root.
const missing = [];
for (const target of targets) {
  const file = `${binaryName}.${tripleToNapiSuffix(target)}.node`;
  const p = join(root, file);
  if (!existsSync(p) || statSync(p).size === 0) {
    missing.push(`${target} (${file})`);
  }
}

if (missing.length > 0) {
  console.error(
    "prepublish: MISSING native addon artifact(s):\n" +
      missing.map((m) => `  - ${m}`).join("\n") +
      "\n\n" +
      "Every platform in package.json \"napi.targets\" must ship in the tarball.\n" +
      "These are built per-platform by the CI \"build\" job and uploaded as\n" +
      "workflow artifacts; the CI \"publish\" job downloads them into ./artifacts\n" +
      "and this script stages + verifies them before publishing.\n" +
      "  - Build only the current platform locally:  bun run build\n" +
      "  - Manual release (downloads CI artifacts): bun run publish:manual\n" +
      "  - Publish all platforms via CI: push a v* tag and let the workflow do it.",
  );
  process.exit(1);
}

console.log(
  `prepublish: OK — all ${targets.length} platform artifact(s) present:\n` +
    targets
      .map((t) => `  - ${binaryName}.${tripleToNapiSuffix(t)}.node`)
      .join("\n"),
);
