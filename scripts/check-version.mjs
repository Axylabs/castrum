#!/usr/bin/env node
/**
 * Version-consistency check: package.json ↔ Cargo.toml ↔ CHANGELOG.
 *
 * The npm package (`castrum`), the Rust crate, and the changelog must agree on
 * the current version so a `v*` tag push and `publish:manual` never ship a
 * mismatch. Fails (exit 1) on drift.
 *
 * Usage: `bun run check:version` (also wired into CI).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read a top-level `key = "value"` from a Cargo.toml [section]. */
function cargoField(section, key) {
  const text = readFileSync(join(root, "Cargo.toml"), "utf8");
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (inSection && trimmed.startsWith(`${key} = `)) {
      const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
      if (match) return match[2];
    }
  }
  throw new Error(`Could not find [${section}] ${key} in Cargo.toml`);
}

function fail(msg) {
  console.error(`check:version — FAIL: ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageVersion = pkg.version;
const cargoVersion = cargoField("package", "version");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

console.log(`package.json version : ${packageVersion}`);
console.log(`Cargo.toml version   : ${cargoVersion}`);

if (packageVersion !== cargoVersion) {
  fail(
    `package.json version (${packageVersion}) != Cargo.toml version (${cargoVersion}). ` +
      `Run \`bun run publish:manual --increment <patch|minor|major>\` to sync them.`,
  );
}

if (!/^## \[Unreleased\]/m.test(changelog)) {
  fail("CHANGELOG.md is missing a `## [Unreleased]` section.");
}

// Escape regex metacharacters: a version like `0.8.0` must not match `0x8a0`.
const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^## \\[${escapedVersion}\\]`, "m").test(changelog)) {
  fail(
    `CHANGELOG.md is missing a \`## [${packageVersion}]\` released section ` +
      `matching package.json. Add a changelog entry for the current version.`,
  );
}

console.log(`CHANGELOG [Unreleased]: present`);
console.log(`CHANGELOG [${packageVersion}]: present`);
console.log("check:version — OK");
