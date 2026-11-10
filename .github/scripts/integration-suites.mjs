// W07b1 (#10751): named integration suites. The map, its loader, and what a
// change selects. W07b2: PR runs compute the selection (`select`, below) and
// the integration sequencer logs what it would run (`runSelection`), but runs
// every file until ENFORCE_PR_SUITES is flipped by its own PR.
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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUITE_MAP_PATH = '.github/scripts/integration-suites.txt';
export const FLOOR_PATH = '.github/scripts/integration-floor-paths.txt';
export const CORE = 'core';
const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));

// W07b2: PR runs compute and log the selection; nothing is skipped while this
// is false. It is flipped by its own PR after Gate B-enforce (>= 2 weeks of
// shadow, 0 real misses, selected/total median <= 0.5), so enforcement is
// reviewed policy, never a variable a run can set.
export const ENFORCE_PR_SUITES = false;

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

// ── W07b2: the PR run's selection ───────────────────────────────────────────

// `select`'s core. Throws on no paths or an unusable map or floor; the CLI
// turns any throw into `all`.
export function selectSuites({ changed, mapText, floorText }) {
  const paths = [...new Set(changed.map(p => String(p).trim()).filter(Boolean))];
  if (!paths.length) throw new Error('no changed paths to select from');
  if (typeof floorText !== 'string') throw new Error(`${FLOOR_PATH} could not be read`);
  return suitesForChange(loadSuiteMap(mapText), paths, { floor: loadFloor(floorText) });
}

const SUITES_VALUE = /^(?:all|[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*)$/;

// What the integration sequencer applies, from the integration-test job's env
// (`suites` = BREEZE_INTEGRATION_SUITES, `mode` = BREEZE_INTEGRATION_SUITES_MODE)
// and the map text. Never throws: anything unusable selects 'all', with a
// `warning` saying why. `mode` is 'enforce' only when ENFORCE_PR_SUITES and the
// env both say so; otherwise 'shadow' (compute and log, run everything).
export function runSelection({ suites, mode, mapText, mapError, enforce = ENFORCE_PR_SUITES } = {}) {
  const effective = enforce === true && mode === 'enforce' ? 'enforce' : 'shadow';
  const all = warning => ({ mode: effective, suites: 'all', suiteOf: () => CORE, warning });
  if (typeof mapText !== 'string') return all(`suite map unusable: ${SUITE_MAP_PATH} could not be read (${mapError ?? 'missing'})`);
  let map;
  try { map = loadSuiteMap(mapText); } catch (error) { return all(`suite map unusable: ${error.message}`); }
  const suiteOf = file => suiteOfTest(map, file);
  const raw = String(suites ?? '').trim();
  if (!raw) return all('BREEZE_INTEGRATION_SUITES is unset or empty');
  if (!SUITES_VALUE.test(raw)) return all(`malformed BREEZE_INTEGRATION_SUITES ${JSON.stringify(raw)}`);
  if (raw === 'all') return { mode: effective, suites: 'all', suiteOf };
  const names = raw.split(',');
  const unknown = names.find(n => n !== CORE && !map.suites.includes(n));
  if (unknown) return all(`unknown suite "${unknown}" in BREEZE_INTEGRATION_SUITES`);
  const order = [CORE, ...map.suites.filter(s => s !== CORE)];
  return { mode: effective, suites: order.filter(s => s === CORE || names.includes(s)), suiteOf };
}

const escapeData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function parseSelectArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--base' && flag !== '--head') throw new Error(`unknown argument ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a revision`);
    opts[flag.slice(2)] = value;
  }
  if (opts.head !== undefined && opts.base === undefined) throw new Error('--head needs --base');
  return opts;
}

function changedPaths({ base, head = 'HEAD' }) {
  if (base === undefined) return readFileSync(0, 'utf8').split('\n');
  try {
    return execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }).split('\n');
  } catch (error) {
    throw new Error(`git diff ${base}...${head} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

// node .github/scripts/integration-suites.mjs select [--base <rev> [--head <rev>]]
// Changed paths come from stdin, one per line (the changes job pipes the PR
// files API list, the same list the classifier gates `integration` on: a PR
// checkout there is shallow), or from `git diff <base>...<head>` in the cwd.
// Prints `all` or a comma list on stdout and the reason on stderr. Never
// fails: any error prints `all` and a ::warning, because fail-open means full.
function selectMain(args) {
  let value = 'all';
  try {
    const changed = changedPaths(parseSelectArgs(args));
    const read = path => readFileSync(join(REPO_ROOT, path), 'utf8');
    const out = selectSuites({ changed, mapText: read(SUITE_MAP_PATH), floorText: read(FLOOR_PATH) });
    value = out.suites === 'all' ? 'all' : out.suites.join(',');
    const count = new Set(changed.map(p => p.trim()).filter(Boolean)).size;
    process.stderr.write(`integration-suites: select suites=${value} reason=${out.reason} changed=${count}\n`);
  } catch (error) {
    value = 'all';
    process.stderr.write(`::warning title=Integration suites::${escapeData(`selecting every suite: ${error.message}`)}\n`);
  }
  process.stdout.write(`${value}\n`);
}

// ── Import evidence ─────────────────────────────────────────────────────────

const IMPORT = /(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.$])import\s+['"]([^'"]+)['"]/g;

function resolveImport(repoRoot, fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = `apps/api/src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  else return null;
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}.mjs`,
    `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
    const abs = join(repoRoot, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return undefined;
}

// The repo paths under apps/api/src a file imports by string literal (static,
// re-export, side-effect, and literal dynamic `import('…')`). Direct imports
// only: the API's import graph is one component through db/index.ts, so a
// transitive closure would put every test in core.
// A relative or `@/` specifier that resolves to no file is pushed onto
// `unresolved` (when given) rather than silently dropped.
export function directApiImports(repoRoot, file, { unresolved } = {}) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const out = new Set();
  for (const m of source.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const resolved = resolveImport(repoRoot, file, spec);
    if (resolved === undefined) unresolved?.push(`${file} → ${spec}`);
    else if (resolved?.startsWith('apps/api/src/')) out.add(resolved);
  }
  return [...out].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'select') selectMain(process.argv.slice(3));
  else {
    process.stderr.write('usage: integration-suites.mjs select [--base <rev> [--head <rev>]]  (changed paths on stdin without --base)\n');
    process.exitCode = 2;
  }
}
