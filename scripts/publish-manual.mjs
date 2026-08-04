#!/usr/bin/env node
// scripts/publish-manual.mjs
//
// Manual release pipeline for the `castrum` npm package.
//
// castrum ships ALL platform native addons in a single tarball
// (`castrum.<platform>-<arch>.node`); publishing requires every platform
// artifact to be present (see scripts/prepublish.mjs). CI builds the per-
// platform addons on `v*` tag pushes and uploads them as `addon-*` workflow
// artifacts (.github/workflows/ci.yml -> "build" job).
//
// This script lets you publish a release by hand:
//   1. Builds the host addon locally          (bun run build)
//   2. Downloads the CI-built addons for the  (gh run download)
//      current `v<version>` tag
//   3. Stages + verifies every platform       (same checks as prepublish)
//   4. Publishes to npm                       (npm publish --access public)
//
// It is NOT an escape hatch from the "all platforms required" rule — step 3
// still fails fast if any target is missing. You still need CI to have built
// the tag (i.e. a successful `build` job for it) or the download step fails.
//
// Requirements:
//   - Clean checkout of the exact `v<version>` tag (git tag == package.json
//     version). Use --allow-dirty to skip the cleanliness check.
//   - GitHub CLI `gh` installed + authenticated (for the artifact download).
//   - npm logged in (`npm whoami` works) or NPM_TOKEN exported.
//
// Usage:
//   bun run publish:manual                  # full flow
//   bun run publish:manual -- --dry-run     # build + download + verify, no publish
//   bun run publish:manual -- --skip-build  # skip the host addon build

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const BINARY_NAME = pkg.napi?.binaryName;
const TARGETS = pkg.napi?.targets ?? [];
const ARTIFACTS_DIR = join(root, "artifacts");
const WORKFLOW = "ci.yml";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SKIP_BUILD = argv.includes("--skip-build");
const ALLOW_DIRTY = argv.includes("--allow-dirty");

// Windows shims `.cmd` — execFileSync needs the exact executable name.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function log(msg) {
  console.log(`publish-manual: ${msg}`);
}

function fail(msg) {
  console.error(`\npublish-manual: ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

// Mirrors the mapping in scripts/prepublish.mjs: a Rust target triple from
// package.json "napi.targets" -> the napi artifact suffix used in filenames.
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

function expectedArtifacts() {
  return TARGETS.map((t) => `${BINARY_NAME}.${tripleToNapiSuffix(t)}.node`);
}

// `gh run download` extracts each artifact into its own subdirectory
// (e.g. artifacts/addon-x86_64-unknown-linux-gnu/castrum.linux-x64-gnu.node),
// but scripts/prepublish.mjs only reads *.node that are DIRECT children of
// ./artifacts. Move every nested *.node up one level and drop the folders.
function flattenArtifacts(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    for (const file of readdirSync(sub)) {
      if (!file.endsWith(".node")) continue;
      const dest = join(dir, file);
      if (!existsSync(dest)) {
        copyFileSync(join(sub, file), dest);
        log(`staged ${join(entry.name, file)} -> artifacts/${file}`);
      }
    }
    rmSync(sub, { recursive: true, force: true });
  }
}

function verifyArtifacts() {
  return expectedArtifacts().filter((file) => {
    const p = join(ARTIFACTS_DIR, file);
    return !existsSync(p) || statSync(p).size === 0;
  });
}

function preflight() {
  if (!BINARY_NAME || TARGETS.length === 0) {
    fail("package.json is missing napi.binaryName or napi.targets.");
  }

  // Git: must sit on the exact `v<version>` tag so the CI-built addons match
  // the code being published.
  let currentTag = "";
  try {
    currentTag = capture("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    /* no exact tag on HEAD */
  }
  if (currentTag !== TAG) {
    fail(
      `expected HEAD to be on tag ${TAG} (package.json version ${VERSION}), found ${currentTag || "(no tag)"}.\n` +
        `  Push the tag first so CI builds the addons, then re-run:\n` +
        `    git tag ${TAG} && git push origin ${TAG}`,
    );
  }

  if (!ALLOW_DIRTY) {
    const dirty = capture("git", ["status", "--porcelain"]);
    if (dirty) {
      fail(
        "working tree is not clean (manual publishes must come from the exact tag commit).\n" +
          "  Commit or stash your changes, or pass --allow-dirty to skip this check.",
      );
    }
  }

  try {
    capture("gh", ["--version"]);
  } catch {
    fail(
      "GitHub CLI `gh` was not found. Install it (https://cli.github.com) and run `gh auth login`.",
    );
  }

  if (!DRY_RUN) {
    try {
      capture(npmCmd, ["whoami"]);
    } catch {
      fail("npm is not authenticated. Run `npm login` (or export NPM_TOKEN) before publishing.");
    }
  }
}

function buildHost() {
  if (SKIP_BUILD) {
    log("skipping host addon build (--skip-build)");
    return;
  }
  run("bun", ["run", "build"]);
}

// Find the most recent successful push run on the current tag; that run's
// "build" job uploaded the addon-* artifacts we download.
function findTagRun() {
  const json = capture("gh", [
    "run",
    "list",
    "--workflow",
    WORKFLOW,
    "--limit",
    "25",
    "--json",
    "databaseId,headBranch,event,status,conclusion,headSha,createdAt",
  ]);
  const runs = JSON.parse(json);
  const forTag = runs.filter((r) => r.headBranch === TAG && r.event === "push");

  if (forTag.length === 0) {
    fail(
      `no CI run found for tag ${TAG} (workflow ${WORKFLOW}).\n` +
        `  Push the tag first so the CI "build" job uploads the addon artifacts:\n` +
        `    git tag ${TAG} && git push origin ${TAG}\n` +
        `  then wait for the "build" job to finish and re-run this command.`,
    );
  }

  const ok = forTag.find((r) => r.conclusion === "success");
  if (!ok) {
    const latest = forTag[0];
    fail(
      `latest CI run for ${TAG} has status=${latest.status} conclusion=${latest.conclusion}.\n` +
        `  The "build" job must succeed before addon artifacts exist. Check: gh run view ${latest.databaseId}`,
    );
  }
  return ok;
}

function downloadArtifacts(runInfo) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  log(`downloading addon-* artifacts from CI run ${runInfo.databaseId}`);
  run("gh", [
    "run",
    "download",
    String(runInfo.databaseId),
    "--pattern",
    "addon-*",
    "--dir",
    ARTIFACTS_DIR,
  ]);
  flattenArtifacts(ARTIFACTS_DIR);

  // Sanity check: the published code is the local tree, so warn if it drifts
  // from the commit CI built.
  try {
    const head = capture("git", ["rev-parse", "HEAD"]);
    if (runInfo.headSha && head !== runInfo.headSha) {
      console.warn(
        `publish-manual: WARNING: local HEAD (${head.slice(0, 12)}) differs from the CI run commit (${runInfo.headSha.slice(0, 12)}).` +
          ` The published TS/JS code will be your local tree, not the tag commit.`,
      );
    }
  } catch {
    /* git unavailable — skip the sanity check */
  }
}

function publish() {
  log("publishing to npm (npm publish --access public)");
  run(npmCmd, ["publish", "--access", "public"]);
}

function main() {
  log(`castrum v${VERSION} manual release (${DRY_RUN ? "DRY-RUN" : "publish"})`);
  log(`targets: ${TARGETS.length} — ${TARGETS.join(", ")}`);

  preflight();
  buildHost();

  const runInfo = findTagRun();
  downloadArtifacts(runInfo);

  const missing = verifyArtifacts();
  if (missing.length > 0) {
    console.error(
      `\npublish-manual: MISSING native addon artifact(s) after download:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n  Expected in ${ARTIFACTS_DIR}.`,
    );
    process.exit(1);
  }
  log(`all ${TARGETS.length} platform artifact(s) present`);

  if (DRY_RUN) {
    log("dry-run complete — would run: npm publish --access public");
    return;
  }

  publish();
  log(`done — castrum@${VERSION} is live on npm.`);
}

try {
  main();
} catch (err) {
  console.error(`\npublish-manual: ${err.message}`);
  process.exit(1);
}
