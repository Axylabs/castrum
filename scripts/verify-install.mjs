// scripts/verify-install.mjs — installed-tarball end-to-end check.
//
// The Node smoke suite imports `../../dist/index.js` from the REPO layout, so
// it never exercises the real production scenario: installing castrum from a
// packed tarball and importing it from `node_modules`. This script packs the
// package (single-platform, partial allowed), installs it into a temp consumer
// project, and imports castrum from `node_modules` under plain Node — proving
// the installed-layout loader resolution (dist/ + package-root .node) works.
//
// Run: node scripts/verify-install.mjs   (needs the host addon already built)

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root from THIS script (not process.cwd()), so the script
// works when invoked from any directory.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `npm pack` ships the compiled ESM entry (dist/) — if it hasn't been built the
// installed consumer fails with a confusing MODULE_NOT_FOUND. Fail early with
// the actual prerequisite.
if (!existsSync(join(root, "dist", "index.js"))) {
  console.error(
    "verify-install: dist/ is missing — run `bun run build:js` first " +
      "(the installed-tarball consumer imports castrum/dist/index.js).",
  );
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "castrum-install-"));
try {
  // 1. Pack (partial: only the host-platform .node is present in this repo).
  const packOut = execSync(`npm pack --pack-destination ${JSON.stringify(tmp)} --json`, {
    cwd: root,
    env: { ...process.env, CASTRUM_PUBLISH_ALLOW_PARTIAL: "1" },
    encoding: "utf8",
  });
  const filename = JSON.parse(packOut)[0].filename;
  const tarballPath = join(tmp, filename);

  // 2. Consumer project + install from the tarball.
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  execSync(`npm install --no-save --no-audit --no-fund ${tarballPath}`, {
    cwd: consumer,
    stdio: "pipe",
  });

  // 3. Import from node_modules and smoke-check (loader must resolve the
  //    installed dist/ + package-root .node layout — not the repo layout).
  const smokeFile = join(consumer, "smoke.mjs");
  writeFileSync(
    smokeFile,
    `
import * as c from "castrum";
if (typeof c.rust.crc32 !== "function") throw new Error("crc32 missing");
if (c.rust.crc32(new TextEncoder().encode("hi")) !== 3633523372) throw new Error("crc32 wrong");
if (typeof c.createIngressFast !== "function") throw new Error("createIngressFast missing");
const signer = c.rust.createJwtSigner(new TextEncoder().encode("k"), 3600);
const tok = signer.sign({ sub: "1" }, 1000000);
if (!signer.verify(tok, 1000000)) throw new Error("jwt instance broken");
const srv = c.createIngressServerNode({ port: 0, routes: {} });
await srv.ready;
srv.stop(true);
console.log("INSTALL-OK");
`,
  );
  const out = execSync(`node ${smokeFile}`, { cwd: consumer, encoding: "utf8" });
  if (!out.includes("INSTALL-OK")) {
    throw new Error("installed smoke check did not pass");
  }
  console.log("verify-install: OK — installed tarball imports and runs under Node");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
