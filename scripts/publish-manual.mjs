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
//   1. (--increment) Bumps package.json + creates the `v<version>` git tag via
//      `bun pm version`, keeps Cargo.toml / Cargo.lock / CHANGELOG.md in sync,
//      and pushes the tag so CI builds the per-platform addons.
//   2. Builds the host addon locally          (bun run build)
//   3. Waits for the CI "build" job to finish (unless --no-wait)
//   4. Downloads the CI-built addons for the  (gh run download)
//      current `v<version>` tag
//   5. Stages + verifies every platform       (same checks as prepublish)
//   6. Publishes to npm                       (npm publish --access public)
//
// It is NOT an escape hatch from the "all platforms required" rule — step 5
// still fails fast if any target is missing. You still need CI to have built
// the tag (i.e. a successful `build` job for it) or the download step fails.
//
// Requirements:
//   - GitHub CLI `gh` installed + authenticated (for artifact download/wait).
//   - npm logged in (`npm whoami` works) or NPM_TOKEN exported.
//   - With --increment: a clean working tree (bun pm version refuses dirty trees).
//   - Without --increment: a clean checkout of the exact `v<version>` tag.
//
// Usage:
//   bun run publish:manual                              # publish current tag
//   bun run publish:manual -- --increment patch         # bump + tag + push + publish
//   bun run publish:manual -- --increment minor -- --dry-run   # plan only, no changes
//   bun run publish:manual -- --increment minor -- --no-wait   # push tag, stop before CI
//   bun run publish:manual -- --skip-build              # skip the host addon build

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const PKG_NAME = pkg.name;
let VERSION = pkg.version;
let TAG = `v${VERSION}`;
const BINARY_NAME = pkg.napi?.binaryName;
const TARGETS = pkg.napi?.targets ?? [];
const ARTIFACTS_DIR = join(root, "artifacts");
const WORKFLOW = "ci.yml";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SKIP_BUILD = argv.includes("--skip-build");
const ALLOW_DIRTY = argv.includes("--allow-dirty");
const NO_WAIT = argv.includes("--no-wait");

// --increment <patch|minor|major|...|vX.Y.Z>: bump package.json + create the git
// tag via `bun pm version`, then push it so CI builds the per-platform addons.
function readIncrement() {
  const eq = argv.find((a) => a.startsWith("--increment="));
  if (eq) return eq.slice("--increment=".length);
  const i = argv.indexOf("--increment");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value) {
    fail("--increment requires a value (patch, minor, major, from-git, or an explicit version).");
  }
  return value;
}
const INCREMENT = readIncrement();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Version bump + tag (--increment) ──────────────────────────────
// `bun pm version` bumps package.json, commits, and tags `v<version>`, but only
// commits package.json — so keep Cargo.toml / Cargo.lock / CHANGELOG.md in sync
// and fold them into the same commit (amend) before moving the tag onto it.
function syncCargoToml(version) {
  const file = join(root, "Cargo.toml");
  const text = readFileSync(file, "utf8");
  const next = text.replace(/(\[package\][^\[]*?version\s*=\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text) fail(`could not find the [package] version in ${file}`);
  writeFileSync(file, next);
  log(`Cargo.toml version -> ${version}`);
}

function syncCargoLock(version) {
  const file = join(root, "Cargo.lock");
  const text = readFileSync(file, "utf8");
  const next = text.replace(/(name = "castrum"\nversion = ")[^"]+(")/, `$1${version}$2`);
  if (next === text) fail(`could not find the castrum version in ${file}`);
  writeFileSync(file, next);
  log(`Cargo.lock version -> ${version}`);
}

function syncChangelog(version) {
  const file = join(root, "CHANGELOG.md");
  const text = readFileSync(file, "utf8");
  const marker = "## [Unreleased]";
  if (!text.includes(marker)) {
    console.warn(`publish-manual: WARNING: ${file} has no "${marker}" section — skipping changelog update.`);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  // The Unreleased body becomes the new release section; a fresh (empty)
  // Unreleased heading is placed back at the top.
  const next = text.replace(marker, `${marker}\n\n## [${version}] — ${date}`);
  writeFileSync(file, next);
  log(`CHANGELOG.md -> new "## [${version}] — ${date}" section`);
}

function bumpVersion(increment) {
  log(`bumping version with: bun pm version ${increment}`);
  run("bun", ["pm", "version", increment]); // bumps package.json, commits, tags vX

  const next = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (next === VERSION) fail("bun pm version did not change the version — nothing to release.");
  log(`version bumped: ${VERSION} -> ${next}`);
  VERSION = next;
  TAG = `v${VERSION}`;

  syncCargoToml(VERSION);
  syncCargoLock(VERSION);
  syncChangelog(VERSION);

  run("git", ["add", "package.json", "Cargo.toml", "Cargo.lock", "CHANGELOG.md", "bun.lock"]);
  run("git", ["commit", "--amend", "--no-edit"]);
  run("git", ["tag", "-f", TAG]);
  log(`tag ${TAG} -> ${capture("git", ["rev-parse", "--short", "HEAD"])}`);
}

function pushTag() {
  log(`pushing tag ${TAG} (this triggers the CI "build" job)`);
  run("git", ["push", "origin", TAG]);
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  log(`the version commit is on '${branch}' locally — push the branch too when ready: git push origin ${branch}`);
}

// Poll for the CI run created by the tag push, then wait for every "Build *"
// job to complete. The build job is watched specifically (not the whole run) so
// a failed/unconfigured publish job can't mask a successful addon build.
async function pollForRun() {
  for (let i = 0; i < 30; i += 1) {
    const json = capture("gh", [
      "run",
      "list",
      "--event",
      "push",
      "--limit",
      "25",
      "--json",
      "databaseId,status,headBranch,event",
    ]);
    // `gh run list --workflow <file>` resolves the workflow against the default
    // branch and can 404 (e.g. on private repos / token access); filter runs
    // ourselves so we don't depend on that lookup.
    const runs = JSON.parse(json).filter(
      (r) => r.headBranch === TAG && r.event === "push",
    );
    if (runs.length > 0) return String(runs[0].databaseId);
    log(`waiting for a CI run on ${TAG} to appear...`);
    await sleep(10_000);
  }
  fail(`no CI run appeared for tag ${TAG} after pushing — check: gh run list`);
}

async function waitForBuild() {
  const runId = await pollForRun();
  log(`CI run ${runId} started — waiting for the "Build" job (--no-wait to skip)`);
  const timeoutMs = 45 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const view = JSON.parse(capture("gh", ["run", "view", runId, "--json", "status,jobs"]));
    const builds = view.jobs.filter((j) => j.name.startsWith("Build"));
    const completed = builds.filter((j) => j.status === "completed");
    if (builds.length > 0 && completed.length === builds.length) {
      const failed = completed.filter((j) => j.conclusion !== "success");
      if (failed.length > 0) {
        fail(`CI build failed: ${failed.map((j) => `${j.name} (${j.conclusion})`).join(", ")}`);
      }
      log("CI build job succeeded — all platform addons are ready.");
      return;
    }
    await sleep(15_000);
  }
  fail(`timed out after ${Math.round(timeoutMs / 60000)}m waiting for the CI build job. Re-run without --increment once it finishes.`);
}

function alreadyPublished() {
  // The tag push may have already triggered CI's auto-publish job; don't fail
  // on a redundant manual publish of the same version.
  try {
    const out = capture(npmCmd, ["view", `${PKG_NAME}@${VERSION}`, "version"]);
    return out.includes(VERSION);
  } catch {
    return false;
  }
}

function ghRepoHint() {
  try {
    const url = capture("git", ["remote", "get-url", "origin"]);
    const m = url.match(/([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    /* no origin remote */
  }
  return "your repository";
}

function checkGhAccess() {
  try {
    capture("gh", ["run", "list", "--limit", "1", "--json", "databaseId"]);
  } catch (err) {
    const detail = String(err.message || err).split("\n")[0];
    fail(
      `GitHub CLI \`gh\` could not list workflow runs for ${ghRepoHint()}.\n` +
        `  Authenticate and make sure your account has access to the repo:\n` +
        `    gh auth login\n    gh repo view ${ghRepoHint()}\n` +
        `  Underlying error: ${detail}`,
    );
  }
}

function preflight() {
  if (!BINARY_NAME || TARGETS.length === 0) {
    fail("package.json is missing napi.binaryName or napi.targets.");
  }

  if (INCREMENT) {
    // `bun pm version` refuses dirty trees, and the version commit must be
    // clean — so --allow-dirty does not apply to a version bump.
    const dirty = capture("git", ["status", "--porcelain"]);
    if (dirty) {
      fail(
        "working tree must be clean to bump the version (bun pm version refuses dirty trees).\n" +
          "  Commit or stash your changes first.",
      );
    }
  } else {
    // No bump: we must be sitting on the exact `v<version>` tag so the CI-built
    // addons match the code being published.
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
          `  Run with --increment to bump + tag + push automatically, or push the tag manually:\n` +
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
  }

  try {
    capture("gh", ["--version"]);
  } catch {
    fail(
      "GitHub CLI `gh` was not found. Install it (https://cli.github.com) and run `gh auth login`.",
    );
  }
  checkGhAccess();

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
  if (ok) return ok;

  // Overall run conclusion isn't "success" — but that may just mean the CI
  // `publish` job failed (e.g. no NPM_TOKEN). Accept the latest run as long as
  // every "Build *" job actually succeeded, since that's what produced addons.
  const latest = forTag[0];
  try {
    const view = JSON.parse(capture("gh", ["run", "view", String(latest.databaseId), "--json", "jobs"]));
    const builds = view.jobs.filter((j) => j.name.startsWith("Build"));
    const done = builds.filter((j) => j.status === "completed");
    if (
      builds.length > 0 &&
      done.length === builds.length &&
      done.every((j) => j.conclusion === "success")
    ) {
      return latest;
    }
  } catch {
    /* gh view failed — fall through to the error below */
  }

  fail(
    `latest CI run for ${TAG} has status=${latest.status} conclusion=${latest.conclusion}.\n` +
      `  The "build" job must succeed before addon artifacts exist. Check: gh run view ${latest.databaseId}`,
  );
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

async function main() {
  log(`castrum v${VERSION} manual release (${DRY_RUN ? "DRY-RUN" : "publish"})`);
  log(`targets: ${TARGETS.length} — ${TARGETS.join(", ")}`);

  preflight();

  if (INCREMENT) {
    if (DRY_RUN) {
      log(`dry-run: would run \`bun pm version ${INCREMENT}\`, sync Cargo.toml/Cargo.lock/CHANGELOG.md,`);
      log("tag v<new>, push the tag, wait for CI, download the addons, and npm publish.");
      log("no changes were made.");
      return;
    }
    bumpVersion(INCREMENT); // bun pm version + sync + amend + tag
    pushTag(); // triggers the CI addon builds
    if (NO_WAIT) {
      log(`tag ${TAG} pushed. CI is building the addons; once the "build" job succeeds,`);
      log("re-run: bun run publish:manual");
      return;
    }
    await waitForBuild();
  }

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

  if (alreadyPublished()) {
    log(`${PKG_NAME}@${VERSION} is already on the npm registry (likely published by CI) — skipping npm publish.`);
    return;
  }

  publish();
  log(`done — castrum@${VERSION} is live on npm.`);
}

try {
  await main();
} catch (err) {
  console.error(`\npublish-manual: ${err.message}`);
  process.exit(1);
}
