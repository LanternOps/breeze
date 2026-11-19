// W07c (#10751): import-graph narrowing of the queue's overlap-area unit suites.
// SHADOW ONLY. Nothing here changes what a job runs: the pinned gate logs the
// reason a related run would or would not apply (queue-selection.mjs,
// `unit_related`), and the test-api / test-web merge_group step logs how many
// tests it would run (`shadow`, below). Enforcement is its own PR, after >= 2
// weeks of shadow with 0 real misses.
//
// The gate imports this module (through queue-selection.mjs) from a sparse
// `.github/scripts` checkout with no install: node builtins only, and no repo
// read at module load.
//
// Scope is the queue only. PR runs keep each touched area's full unit suite:
// the thin queue's safety rests on PR runs being thorough (spec §2-3, OD-4).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALWAYS_PATH = '.github/scripts/unit-always-tests.txt';
export const READER_MAP_PATH = '.github/scripts/path-reader-map.txt';
export const FLOOR_PATH = '.github/scripts/integration-floor-paths.txt';
export const MAX_RELATED_FILES = 300;

// The unit jobs `vitest related` can narrow: one literal config each. Every
// other unit job has no entry here, so it always runs its full suite.
export const RELATED_JOBS = Object.freeze({
  'test-api': Object.freeze({ root: 'apps/api', package: '@breeze/api', config: 'apps/api/vitest.config.ts',
    setupFiles: Object.freeze(['apps/api/src/__tests__/setup.ts']), tests: /^apps\/api\/(?:src|scripts)\/.*\.test\.ts$/ }),
  'test-web': Object.freeze({ root: 'apps/web', package: '@breeze/web', config: 'apps/web/vitest.config.ts',
    setupFiles: Object.freeze(['apps/web/src/__tests__/setup.ts']), tests: /^apps\/web\/src\/.*\.test\.tsx?$/ }),
  'test-portal': Object.freeze({ root: 'apps/portal', package: '@breeze/portal', config: 'apps/portal/vitest.config.ts',
    setupFiles: Object.freeze(['apps/portal/src/__tests__/setup.ts']), tests: /^apps\/portal\/src\/.*\.test\.tsx?$/ }),
});

// ── The always list ──────────────────────────────────────────────────────────

const lines = text => String(text).split('\n').map(line => line.replace(/#.*$/, '').trim()).filter(Boolean);
export const loadAlwaysList = text => lines(text);
// path-reader-map.txt: `<reader test> <path it reads>`. Its readers already run
// whenever what they read changes, so they need no always entry.
export const readerTests = text => [...new Set(lines(text).map(line => line.split(/\s+/)[0]))];

// What the import graph cannot see: file reads, globbing, non-literal dynamic
// imports, and URLs resolved against the test's own location.
const ALWAYS_PATTERNS = [
  /readFileSync|readdirSync|globSync|fast-glob|import\.meta\.glob/,
  /import\(\s*`/,
  /import\(\s*[a-zA-Z_]/,
  /new URL\([^)]*import\.meta\.url/,
];
export const alwaysCandidate = source => ALWAYS_PATTERNS.some(re => re.test(source));

const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.astro', 'coverage']);
function walk(repoRoot, dir, out) {
  let entries;
  try { entries = readdirSync(join(repoRoot, dir), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(repoRoot, path, out); }
    else if (entry.isFile()) out.push(path);
  }
}
function sourceRoots(repoRoot) {
  const packages = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/src`);
  return ['apps/api/src', 'apps/web/src', 'apps/portal/src', ...packages].filter(dir => existsSync(join(repoRoot, dir)));
}

// The unit tests under apps/{api,web,portal}/src and packages/*/src whose
// dependencies the import graph cannot see. Sorted repo paths.
export function scanAlwaysCandidates(repoRoot) {
  const files = [];
  for (const dir of sourceRoots(repoRoot)) walk(repoRoot, dir, files);
  return files.filter(file => TEST_FILE.test(file) && alwaysCandidate(readFileSync(join(repoRoot, file), 'utf8'))).sort();
}

// ── What a related run would be ──────────────────────────────────────────────

const lineCommentFloor = text => lines(text);
const floorHit = (floor, path) => floor.some(rule => (rule.endsWith('/') ? path.startsWith(rule) : path === rule));
const MANIFEST = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/;
// A repo path that cannot read as a flag or leave the repository. Brackets and
// parentheses are fine (Astro routes): argv never meets a shell.
const SAFE_PATH = /^(?!-)[^\s\0-\x1f]+$/;

// { argv: string[] | null, reason: 'related' | 'full:<why>' }. argv is the
// command a job would run instead of its full suite; null means the full suite.
// `floor` is integration-floor-paths.txt as a list; `exists` (optional) says
// whether a changed path is in the tree: a deleted file has no place in the
// graph, so the tests that imported it could not be found.
export function relatedPlan(job, changed, { floor = [], exists } = {}) {
  const area = Object.hasOwn(RELATED_JOBS, job) ? RELATED_JOBS[job] : null;
  const full = why => ({ argv: null, reason: `full:${why}` });
  if (!area) return full('no_config');
  const files = [...new Set(changed.map(String))];
  if (!files.length) return full('no_changes');
  if (files.length > MAX_RELATED_FILES) return full('too_many_files');
  for (const path of files) {
    if (!SAFE_PATH.test(path) || path.split('/').includes('..') || path.startsWith('/')) return full(`unsafe_path:${path}`);
    if (floorHit(floor, path)) return full(`floor:${path}`);
    if (path === area.config || /^vitest\.config\.[cm]?[jt]s$/.test(posix.relative(area.root, path))) return full(`config:${path}`);
    if (area.setupFiles.includes(path)) return full(`setup:${path}`);
    if (MANIFEST.test(path)) return full(`manifest:${path}`);
    if (exists && !exists(path)) return full(`deleted:${path}`);
  }
  // Files come straight after `related`, relative to the area root (vitest
  // resolves them there); only flags follow. Never `vitest run <files>`: those
  // are substring filters (docs/agents/testing.md).
  const argv = ['pnpm', `--filter=${area.package}`, 'exec', 'vitest', 'related',
    ...files.map(path => posix.relative(area.root, path)), '--run', '--passWithNoTests', '--config', 'vitest.config.ts'];
  return { argv, reason: 'related' };
}
export const relatedCommand = (job, changed, options) => relatedPlan(job, changed, options).argv;

// The tests a related run selects: every test whose import closure reaches a
// changed file, every changed test, the always list and own(P), limited to
// `tests` (the area's suite). `edges` maps a file to the files it imports.
export function relatedSet({ changed, edges, tests, always = [], own = [] }) {
  const graph = edges instanceof Map ? edges : new Map(Object.entries(edges));
  const reverse = new Map();
  for (const [from, tos] of graph) for (const to of tos) {
    if (!reverse.has(to)) reverse.set(to, []);
    reverse.get(to).push(from);
  }
  const reached = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const importer of reverse.get(queue.pop()) ?? []) {
      if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
    }
  }
  const pick = new Set([...always, ...own]);
  return tests.filter(test => reached.has(test) || pick.has(test));
}

// ── A static import graph (shadow counting only) ─────────────────────────────
//
// `vitest related` builds its graph by transforming every test: on apps/api it
// took 220 s and 13.6 GB RSS (2026-11-18, 5,347 specs), too much for a log line
// on the queue's critical path. The shadow count uses literal imports instead,
// and says so (graph=static). It misses what vitest's resolver adds (package
// exports, aliases beyond @/ and @breeze/shared), so it can only undercount.

const IMPORT = /(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.$])import\s+['"]([^'"]+)['"]|(?:^|[^\w.$])require\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

function resolveSpecifier(repoRoot, from, spec, isFile) {
  let base;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith('@/')) {
    const app = from.match(/^(apps\/[^/]+)\//)?.[1];
    if (!app) return null;
    base = `${app}/src/${spec.slice(2)}`;
  } else if (spec === '@breeze/shared' || spec.startsWith('@breeze/shared/')) base = `packages/shared/src${spec.slice('@breeze/shared'.length)}`;
  else return null;
  const stripped = base.replace(/\.(?:js|mjs|cjs)$/, '');
  for (const candidate of [...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => stripped + ext)]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

// The repo paths `file` imports by string literal (static, re-export,
// side-effect, literal dynamic import, require), resolved to files.
export function staticImports(repoRoot, file, { isFile } = {}) {
  const exists = isFile ?? (path => { try { return statSync(join(repoRoot, path)).isFile(); } catch { return false; } });
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const out = new Set();
  for (const m of source.matchAll(IMPORT)) {
    const resolved = resolveSpecifier(repoRoot, file, m[1] ?? m[2] ?? m[3] ?? m[4], exists);
    if (resolved) out.add(resolved);
  }
  return [...out].sort();
}

const SOURCE = /\.(?:ts|tsx|mts|js|mjs)$/;
// Direct import edges over the job's area and the shared package.
export function staticImportGraph(repoRoot, job) {
  const area = RELATED_JOBS[job];
  const files = [];
  for (const dir of [`${area.root}/src`, `${area.root}/scripts`, 'packages/shared/src']) walk(repoRoot, dir, files);
  const sources = files.filter(file => SOURCE.test(file));
  const known = new Set(files);
  const isFile = path => known.has(path);
  const edges = new Map(sources.map(file => [file, staticImports(repoRoot, file, { isFile })]));
  return { edges, tests: sources.filter(file => area.tests.test(file) && !/\.integration\.test\.|\/__tests__\/integration\//.test(file)).sort() };
}

// ── The shadow line ──────────────────────────────────────────────────────────

const oneLine = value => String(value).replace(/[\r\n]+/g, ' ').replaceAll('::', ': :');
export function shadowLine({ job, wouldRun, total, reason, inputs, graph }) {
  const n = reason === 'related' && Number.isSafeInteger(wouldRun) ? wouldRun : total;
  return `unit-related: job=${oneLine(job)} would_run=${n}/${total} reason=${oneLine(reason)} inputs=${oneLine(inputs)} graph=${oneLine(graph)}`;
}

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const defaultGit = repoRoot => args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

// node .github/scripts/related-tests.mjs shadow --job <job> --base <sha> --head <rev>
// Changed files are the queue entry's own diff (base..head): the test job has
// no record of the PR run's base, so Δ is not an input here (the gate's line
// logs p and delta). One unit-related line; always exit 0. It runs nothing.
export async function shadowMain(args, deps = {}) {
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const stdout = deps.stdout ?? (line => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`));
  const git = deps.git ?? defaultGit(repoRoot);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) opts[String(args[i]).replace(/^--/, '')] = args[i + 1];
  const job = String(opts.job ?? '');
  let total = 0, wouldRun = null, reason = 'full:error';
  try {
    if (!Object.hasOwn(RELATED_JOBS, job)) throw Error(`no related config for job ${JSON.stringify(job)}`);
    const { edges, tests } = staticImportGraph(repoRoot, job);
    total = tests.length;
    if (!/^[a-f\d]{40}$/i.test(opts.base ?? '') || !/^[\w./-]+$/.test(opts.head ?? '')) throw Error('--base <sha> --head <rev> are required');
    const changed = String(git(['diff', '--name-only', '--no-renames', opts.base, opts.head])).split('\n').map(s => s.trim()).filter(Boolean);
    const floor = lineCommentFloor(readFileSync(join(repoRoot, FLOOR_PATH), 'utf8'));
    const plan = relatedPlan(job, changed, { floor, exists: path => existsSync(join(repoRoot, path)) });
    reason = plan.reason;
    if (plan.argv) {
      const always = loadAlwaysList(readFileSync(join(repoRoot, ALWAYS_PATH), 'utf8'));
      wouldRun = relatedSet({ changed, edges, tests, always, own: changed }).length;
    }
  } catch (error) {
    reason = 'full:error';
    try { stderr(`related-tests: ${oneLine(error?.message ?? error)}`); } catch { /* the line below still says full */ }
  }
  try { stdout(shadowLine({ job, wouldRun, total, reason, inputs: 'entry', graph: 'static' })); } catch { /* a log line only */ }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'shadow') shadowMain(process.argv.slice(3)).then(code => { process.exitCode = code; }, () => { process.exitCode = 0; });
  else {
    process.stderr.write('usage: related-tests.mjs shadow --job <test-api|test-web|test-portal> --base <sha> --head <rev>\n');
    process.exitCode = 2;
  }
}
