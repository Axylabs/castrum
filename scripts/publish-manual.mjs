#!/usr/bin/env node
// scripts/publish-manual.mjs
//
// Simple manual release for the `castrum` npm package — no CI / GitHub involved.
//
//   1. (--increment) Bump package.json + create the `v<version>` git tag via
//      `bun pm version`, keeping Cargo.toml / Cargo.lock / CHANGELOG.md in sync.
//   2. Push the git tag (and the current branch) to origin.
//   3. Build the native addon for the current platform (bun run build).
//   4. Publish to npm (npm publish --access public).
//
// Platform note: the tarball ships only the addons you've built locally (just the
// current platform, for now). scripts/prepublish.mjs is told to allow a partial
// platform set via CASTRUM_PUBLISH_ALLOW_PARTIAL=1 so the local publish doesn't
// require every napi.targets artifact. A full multi-platform tarball still comes
// from CI on a v* tag push.
//
// Requirements:
//   - npm logged in (`npm whoami` works) or NPM_TOKEN exported.
//   - With --increment: a clean working tree (bun pm version refuses dirty trees).
//
// The `v<version>` git tag is created (if missing) and pushed automatically.
//
// Usage:
//   bun run publish:manual                       # build + publish current version
//   bun run publish:manual -- --increment patch  # bump + tag + push + publish
//   bun run publish:manual -- --dry-run          # plan only, no changes
//   bun run publish:manual -- --skip-build       # skip the addon build

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const PKG_NAME = pkg.name;
let VERSION = pkg.version;
let TAG = `v${VERSION}`;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SKIP_BUILD = argv.includes("--skip-build");

// --increment <patch|minor|major|...|vX.Y.Z>: bump package.json + create the git
// tag via `bun pm version`, then publish the new version.
function readIncrement() {
  const eq = argv.find((a) => a.startsWith("--increment="));
  if (eq) return eq.slice("--increment=".length);
  const i = argv.indexOf("--increment");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value) fail("--increment requires a value (patch, minor, major, from-git, or an explicit version).");
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

// ── Version bump + tag (--increment) ──────────────────────────────
// `bun pm version` bumps package.json, commits, and tags `v<version>`, but only
// commits package.json — keep Cargo.toml / Cargo.lock / CHANGELOG.md in sync and
// fold them into the same commit (amend) before moving the tag onto it.
function syncCargoToml(version) {
  const file = join(root, "Cargo.toml");
  const text = readFileSync(file, "utf8");
  const next = text.replace(/(\[package\][^[]*?version\s*=\s*")[^"]+(")/, `$1${version}$2`);
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

function ensureTagPushed() {
  // The whole point of this command: make sure the v<version> git tag exists and
  // is pushed. If someone bumped the version by hand and forgot the tag, create
  // it at HEAD automatically.
  try {
    capture("git", ["rev-parse", `refs/tags/${TAG}`]);
  } catch {
    log(`tag ${TAG} does not exist yet — creating it at HEAD`);
    run("git", ["tag", TAG]);
  }
  run("git", ["push", "origin", TAG]);
  // Keep the branch in sync too (no-op when already up to date).
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "HEAD") {
    try {
      run("git", ["push", "origin", branch]);
    } catch {
      console.warn(`publish-manual: WARNING: could not push branch '${branch}'. Push it later: git push origin ${branch}`);
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

function alreadyPublished() {
  try {
    const out = capture(npmCmd, ["view", `${PKG_NAME}@${VERSION}`, "version"]);
    return out.includes(VERSION);
  } catch {
    return false;
  }
}

function publish() {
  log("publishing to npm (npm publish --access public, single-platform)");
  // Allow a partial platform set so a local manual publish doesn't require every
  // napi.targets artifact (see scripts/prepublish.mjs).
  run(npmCmd, ["publish", "--access", "public"], {
    env: { ...process.env, CASTRUM_PUBLISH_ALLOW_PARTIAL: "1" },
  });
}

function preflight() {
  // `bun pm version` refuses dirty trees, so a version bump needs a clean tree.
  if (INCREMENT) {
    const dirty = capture("git", ["status", "--porcelain"]);
    if (dirty) {
      fail(
        "working tree must be clean to bump the version (bun pm version refuses dirty trees).\n" +
          "  Commit or stash your changes first.",
      );
    }
  }

  if (!DRY_RUN) {
    try {
      capture(npmCmd, ["whoami"]);
    } catch {
      fail("npm is not authenticated. Run `npm login` (or export NPM_TOKEN) before publishing.");
    }
  }
}

function main() {
  log(`castrum v${VERSION} manual publish (${DRY_RUN ? "DRY-RUN" : "publish"})`);
  preflight();

  if (INCREMENT) {
    if (DRY_RUN) {
      log(`dry-run: would run \`bun pm version ${INCREMENT}\`, sync Cargo.toml/Cargo.lock/CHANGELOG.md,`);
      log(`tag v<new>, push, build the addon, and npm publish.`);
      log("no changes were made.");
      return;
    }
    bumpVersion(INCREMENT);
  }

  if (!DRY_RUN) ensureTagPushed();
  buildHost();

  if (DRY_RUN) {
    log("dry-run complete — would run: npm publish --access public");
    return;
  }

  if (alreadyPublished()) {
    log(`${PKG_NAME}@${VERSION} is already on the npm registry — skipping npm publish.`);
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
