// scripts/check-clean.ts — machine checks for the repo's code conventions.
//
// Run: `bun run check:clean` (or `bun scripts/check-clean.ts [--todos]`).
// Exits non-zero on the first failing category. All checks are additive —
// none change behavior; they exist to keep the documented conventions from
// silently drifting (the way the parity/wiring/proven tests pin the wire).
//
// Enforces:
//   1. Module headers — every file under `src/` (and `index.ts`) opens with a
//      `// …` header comment (the `// src/... — purpose` convention).
//   2. Runtime seam — no `typeof Bun` runtime check outside
//      `src/runtime/detect.ts` in shipped code. `src/bench/` + `src/baseline/`
//      are bench-only and exempt.
//   3. Purity boundary — PURE modules (`src/shared/packed/wire.ts`,
//      `src/shared/{bytes,codec,request-id,trace,uuid}.ts`,
//      `src/ingress/{decode,headers,response}/**`) must not import from
//      `src/native/` or `src/shared/buffer-pool.ts`. A PURE module that needs
//      the addon must take the resolved fn as a parameter instead.
//   4. FFI symbol count — docs must not carry the stale `castrum_*` counts
//      (75/78 symbols, 67/70 direct); the real count is 79 (71 direct + 4 + 4).
//   5. No dangling doc links — markdown links to `docs/*.md` / root `*.md`
//      must resolve to a real file.
//   --todos — additionally fail on TODO/FIXME/HACK markers in `src/`.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SCRIPT_DIR = import.meta.dir
const ROOT = join(SCRIPT_DIR, '..')

const problems: string[] = []

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, join(rel, entry.name)))
    } else {
      out.push(join(rel, entry.name))
    }
  }
  return out
}

const skipDirs = new Set(['node_modules', '.git', 'target', 'dist', 'results', 'artifacts'])

function walkSkipping(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue
      out.push(...walkSkipping(full, join(rel, entry.name)))
    } else {
      out.push(join(rel, entry.name))
    }
  }
  return out
}

const rel = (p: string): string => p.replace(/\\/g, '/')
const srcFiles = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'))
const shipped = srcFiles.filter((f) => !f.startsWith('bench/') && !f.startsWith('baseline/'))

// ── 1. Module headers ──────────────────────────────────────────────────────
console.log('check:clean — module headers')
function checkHeader(filePath: string, label: string): void {
  const text = readFileSync(filePath, 'utf8')
  const firstLine = text.split('\n').find((l) => l.trim() !== '') ?? ''
  if (!firstLine.trim().startsWith('//')) {
    problems.push(`missing module header: ${label}`)
  }
}
for (const f of srcFiles) checkHeader(join(ROOT, 'src', f), f)
checkHeader(join(ROOT, 'index.ts'), 'index.ts')

// ── 2. Runtime seam ────────────────────────────────────────────────────────
console.log('check:clean — runtime seam (typeof Bun)')
const runtimeCheck = /typeof\s*(?:globalThis\s*\.\s*)?Bun\s*[=!]==?/
for (const f of shipped) {
  if (f === 'runtime/detect.ts') continue
  const text = readFileSync(join(ROOT, 'src', f), 'utf8')
  if (runtimeCheck.test(text)) {
    problems.push(`runtime seam violation in ${f}: direct \`typeof Bun\` check — use src/runtime/detect.ts`)
  }
}

// ── 3. Purity boundary ─────────────────────────────────────────────────────
console.log('check:clean — purity boundary')
const PURE_FILES = [
  'shared/packed/wire.ts',
  'shared/bytes.ts',
  'shared/codec.ts',
  'shared/request-id.ts',
  'shared/trace.ts',
  'shared/uuid.ts',
]
const PURE_DIRS = ['ingress/decode', 'ingress/headers', 'ingress/response']
const pureFiles = [
  ...PURE_FILES,
  ...srcFiles.filter((f) => PURE_DIRS.some((d) => f.startsWith(`${d}/`))),
]
const nativeImport = /from\s+['"][^'"]*native['"]|from\s+['"][^'"]*buffer-pool['"]/
for (const f of pureFiles) {
  const text = readFileSync(join(ROOT, 'src', f), 'utf8')
  for (const line of text.split('\n')) {
    // Type-only imports never touch the dlopen layer — the purity rule is
    // about RUNTIME imports (getAddon / buffer-pool).
    if (/^\s*import\s+type\b/.test(line)) continue
    if (nativeImport.test(line)) {
      problems.push(`purity violation in ${f}: imports the native layer — inject the fn instead`)
      break
    }
  }
}

// ── 4. FFI symbol count in docs ────────────────────────────────────────────
console.log('check:clean — FFI symbol count in docs')
const countDocs = [
  'AGENTS.md',
  'docs/ARCHITECTURE.md',
  'docs/REPO_MAP.md',
  'docs/CASE_STUDY.md',
  'docs/FFI_BUN_GUIDE.md',
]
const staleCount = /7[58]\s*(?:`)?castrum|6[70]\s*direct/
for (const d of countDocs) {
  const text = readFileSync(join(ROOT, d), 'utf8')
  if (staleCount.test(text)) {
    problems.push(`stale FFI symbol count in ${d} (should read 79 / 71 direct)`)
  }
}

// ── 5. Dangling doc links ──────────────────────────────────────────────────
console.log('check:clean — dangling doc links')
const mdFiles = walkSkipping(ROOT).filter((f) => f.endsWith('.md'))
const linkRe = /\[[^\]]*\]\(([^)]+)\)/g
for (const f of mdFiles) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  linkRe.lastIndex = 0
  for (let m = linkRe.exec(text); m !== null; m = linkRe.exec(text)) {
    const raw = m[1].split('#')[0].split('?')[0].trim()
    if (raw === '' || raw.startsWith('http') || raw.startsWith('mailto:') || raw.startsWith('#')) continue
    const resolved = rel(join(dirname(f), raw))
    if (!existsSync(join(ROOT, resolved))) {
      problems.push(`dangling link in ${f}: ${m[1]}`)
    }
  }
}

// ── 6. TODO/FIXME (optional) ───────────────────────────────────────────────
if (process.argv.includes('--todos')) {
  console.log('check:clean — TODO/FIXME/HACK scan')
  for (const f of shipped) {
    const text = readFileSync(join(ROOT, 'src', f), 'utf8')
    if (/\b(TODO|FIXME|HACK)\b/.test(text)) {
      problems.push(`TODO/FIXME/HACK in ${f}`)
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`\ncheck:clean — ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('\ncheck:clean — all checks passed ✓')
