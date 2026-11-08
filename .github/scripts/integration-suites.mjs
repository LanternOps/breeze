// W07b1 (#10751): named integration suites. The map, its loader, and what a
// change selects. Nothing reads this yet to change what runs: W07b2 logs the
// selection on PR runs (shadow), and enforcement is a later, separate PR.
//
// integration-suites.txt, one rule per line (`#` comments):
//   suite <name> tests <glob>     the integration tests the suite owns
//   suite <name> sources <glob>   the API sources whose change selects it
// Globs are repo-relative with bash semantics, as in path-reader-map.txt: `*`
// crosses `/`, `?` is one character, `[...]` / `[!...]` a class. A test belongs
// to the first suite in file order whose `tests` glob matches it, else to
// `core`, which always runs. `core` may own tests but never sources.
//
// Fail-open: a floor path, or a changed path that could reach the integration
// suite but is matched by no `sources` glob, selects every suite.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export const SUITE_MAP_PATH = '.github/scripts/integration-suites.txt';
export const FLOOR_PATH = '.github/scripts/integration-floor-paths.txt';
export const CORE = 'core';

export class SuiteMapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SuiteMapError';
  }
}

export function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) throw new SuiteMapError(`unclosed [ in ${glob}`);
      let body = glob.slice(i + 1, end);
      const negate = body.startsWith('!');
      if (negate) body = body.slice(1);
      if (!/^(?:[A-Za-z0-9._-]|[A-Za-z0-9]-[A-Za-z0-9])+$/.test(body)) throw new SuiteMapError(`unsupported class [${glob.slice(i + 1, end)}] in ${glob}`);
      re += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function loadSuiteMap(text) {
  const rules = [];
  const seen = new Set();
  const testGlobs = new Map();
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const where = `${SUITE_MAP_PATH}:${i + 1}`;
    const m = line.match(/^suite\s+(\S+)\s+(tests|sources)\s+(\S+)$/);
    if (!m) throw new SuiteMapError(`${where}: expected "suite <name> tests|sources <glob>", got "${line}"`);
    const [, suite, kind, glob] = m;
    if (!NAME.test(suite) || suite === 'all') throw new SuiteMapError(`${where}: invalid suite name "${suite}"`);
    if (suite === CORE && kind === 'sources') throw new SuiteMapError(`${where}: core always runs, so it owns no sources`);
    const key = `${suite} ${kind} ${glob}`;
    if (seen.has(key)) throw new SuiteMapError(`${where}: duplicate rule "${key}"`);
    seen.add(key);
    if (kind === 'tests') {
      if (testGlobs.has(glob)) throw new SuiteMapError(`${where}: tests glob ${glob} is already owned by ${testGlobs.get(glob)}`);
      testGlobs.set(glob, suite);
    }
    rules.push({ suite, kind, glob, re: globRegex(glob), line: i + 1 });
  });
  const suites = [...new Set(rules.map(r => r.suite))];
  return { rules, suites };
}

export function suiteOfTest(map, file) {
  return map.rules.find(r => r.kind === 'tests' && r.re.test(file))?.suite ?? CORE;
}

export function sourceOwners(map, file) {
  return [...new Set(map.rules.filter(r => r.kind === 'sources' && r.re.test(file)).map(r => r.suite))];
}

// integration-floor-paths.txt: a trailing `/` is a prefix, anything else exact.
export function loadFloor(text) {
  return String(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}
export const floorHit = (floor, path) => floor.some(e => (e.endsWith('/') ? path.startsWith(e) : path === e));

// Paths the integration suite cannot read: the PR classifier's integration=false
// set (classify-pr-paths.sh --pull-request; parity pinned in the test), plus API
// unit tests. Package manifests are never neutral.
const MANIFEST = /(?:^|\/)(?:package\.json|\.npmrc|\.nvmrc|\.node-version)$/;
const UNREACHABLE = /^(?:docs\/|apps\/docs\/|agent\/|apps\/(?:web|portal|viewer|helper|mobile|excel-addin|word-addin|powerpoint-addin|outlook-addin|m365-graph-read-executor|m365-graph-actions-executor|m365-communications-executor)\/|Cargo\.|rust-toolchain)|\.mdx?$/;
const API_UNIT_TEST = /^apps\/api\/.*\.test\.[cm]?[jt]sx?$/;
const INTEGRATION_TEST = /\.integration\.test\.ts$|^apps\/api\/src\/__tests__\/integration\//;

export function neutralPath(path) {
  if (MANIFEST.test(path)) return false;
  if (UNREACHABLE.test(path)) return true;
  return API_UNIT_TEST.test(path) && !INTEGRATION_TEST.test(path);
}

// { suites: 'all' | string[], reason }. A floor path or an unmapped reachable
// path selects 'all'; otherwise the owning suites of every change plus core.
export function suitesForChange(map, changed, { floor = [] } = {}) {
  const floorPath = changed.find(p => floorHit(floor, p));
  if (floorPath) return { suites: 'all', reason: `floor:${floorPath}` };
  const selected = new Set([CORE]);
  for (const path of changed) {
    if (INTEGRATION_TEST.test(path)) { selected.add(suiteOfTest(map, path)); continue; }
    if (neutralPath(path)) continue;
    const owners = sourceOwners(map, path);
    if (!owners.length) return { suites: 'all', reason: `unmapped:${path}` };
    for (const s of owners) selected.add(s);
  }
  const order = [CORE, ...map.suites.filter(s => s !== CORE)];
  return { suites: order.filter(s => selected.has(s)), reason: 'mapped' };
}

// ── Import evidence ─────────────────────────────────────────────────────────

const IMPORT = /(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.$])import\s+['"]([^'"]+)['"]/g;

function resolveImport(repoRoot, fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = `apps/api/src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else return null;
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const abs = join(repoRoot, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

// The repo paths under apps/api/src a file imports by string literal (static,
// re-export, side-effect, and literal dynamic `import('…')`). Direct imports
// only: the API's import graph is one component through db/index.ts, so a
// transitive closure would put every test in core.
export function directApiImports(repoRoot, file) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const out = new Set();
  for (const m of source.matchAll(IMPORT)) {
    const resolved = resolveImport(repoRoot, file, m[1] ?? m[2] ?? m[3]);
    if (resolved?.startsWith('apps/api/src/')) out.add(resolved);
  }
  return [...out].sort();
}
