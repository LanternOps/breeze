// W07c (#10751): the "always" list and the related set for overlap-area unit
// suites in the queue. Shadow only: nothing here changes what a job runs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as related from './related-tests.mjs';
import { POLICY_FILES } from './ci-policy.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const read = path => readFileSync(join(REPO_ROOT, path), 'utf8');
const floor = read('.github/scripts/integration-floor-paths.txt').split('\n').map(l => l.split('#')[0].trim()).filter(Boolean);
const fixture = name => JSON.parse(read(`.github/scripts/fixtures/queue-selection/${name}.json`));
const edgesFixture = JSON.parse(read('.github/scripts/fixtures/related-tests/import-edges.json'));

// ── C1: the always list ──────────────────────────────────────────────────────

test('every always-candidate is listed (in unit-always-tests.txt or as a path-reader-map reader)', () => {
  const listed = new Set([...related.loadAlwaysList(read(related.ALWAYS_PATH)), ...related.readerTests(read(related.READER_MAP_PATH))]);
  const candidates = related.scanAlwaysCandidates(REPO_ROOT);
  assert.ok(candidates.length > 100, `the scan found only ${candidates.length} candidates; is it walking the right trees?`);
  const missing = candidates.filter(file => !listed.has(file));
  assert.deepEqual(missing, [], `add these to ${related.ALWAYS_PATH} (they read files or import by a non-literal path, so the import graph cannot see what they depend on):\n${missing.join('\n')}`);
});

test('no stale always entries: every listed file exists and is a test', () => {
  const list = related.loadAlwaysList(read(related.ALWAYS_PATH));
  assert.ok(list.length > 0);
  for (const file of list) {
    assert.ok(existsSync(join(REPO_ROOT, file)), `${related.ALWAYS_PATH} lists ${file}, which does not exist`);
    assert.match(file, /\.test\.(?:ts|tsx|mjs)$/, `${file} is not a test file`);
  }
  assert.equal(new Set(list).size, list.length, 'no duplicate entries');
});

test('the always scan catches every pattern the import graph cannot see, and nothing else', () => {
  for (const source of [
    "const text = readFileSync(path, 'utf8');",
    'const names = readdirSync(dir);',
    "const files = globSync('src/**/*.ts');",
    "import fg from 'fast-glob';",
    "const mods = import.meta.glob('./locales/*.json');",
    'const m = await import(`./tools/${name}`);',
    'const m = await import( modulePath );',
    "const url = new URL('./fixture.json', import.meta.url);",
  ]) assert.equal(related.alwaysCandidate(source), true, source);
  for (const source of [
    "import { x } from './x';",
    "const m = await import('./literal');",
    "vi.mock('./thing', () => ({}));",
    '// readFile is mentioned only in prose',
  ]) assert.equal(related.alwaysCandidate(source), false, source);
});

test('loadAlwaysList ignores comments and blank lines; readerTests reads the first column', () => {
  assert.deepEqual(related.loadAlwaysList('# header\n\napps/web/src/a.test.ts\n  apps/api/src/b.test.ts  # why\n'), ['apps/web/src/a.test.ts', 'apps/api/src/b.test.ts']);
  assert.deepEqual(related.readerTests('# c\napps/api/src/r.test.ts apps/docs/x.mdx\napps/api/src/r.test.ts apps/docs/y.mdx\n'), ['apps/api/src/r.test.ts']);
});

// ── C1: relatedCommand ───────────────────────────────────────────────────────

test('relatedCommand is null (the full area suite) for a vitest config, setup file, manifest, tsconfig or floor change', () => {
  for (const [job, path] of [
    ['test-api', 'apps/api/vitest.config.ts'],
    ['test-web', 'apps/web/vitest.config.ts'],
    ['test-web', 'apps/web/src/__tests__/setup.ts'],
    ['test-api', 'apps/api/src/__tests__/setup.ts'],
    ['test-portal', 'apps/portal/package.json'],
    ['test-web', 'apps/web/tsconfig.json'],
    ['test-api', 'tsconfig.base.json'],
    ['test-api', 'apps/api/migrations/2027-01-01-000000-x.sql'],
    ['test-web', 'packages/shared/src/index.ts'],
  ]) {
    assert.equal(related.relatedCommand(job, ['apps/web/src/lib/x.ts', path], { floor }), null, `${job} ${path}`);
    assert.match(related.relatedPlan(job, [path], { floor }).reason, /^full:/, `${job} ${path}`);
  }
});

test('relatedCommand is null over 300 changed files, and builds argv at exactly 300', () => {
  const many = n => Array.from({ length: n }, (_, i) => `apps/web/src/lib/f${i}.ts`);
  assert.equal(related.relatedCommand('test-web', many(301), { floor }), null);
  assert.equal(related.relatedPlan('test-web', many(301), { floor }).reason, 'full:too_many_files');
  assert.ok(Array.isArray(related.relatedCommand('test-web', many(300), { floor })));
});

test('relatedCommand is null for a job with no literal config, and for no changed files', () => {
  for (const job of ['test-shared', 'test-agent', 'test-office-addin-core', 'not-a-job']) {
    assert.equal(related.relatedCommand(job, ['apps/web/src/lib/x.ts'], { floor }), null, job);
    assert.equal(related.relatedPlan(job, ['apps/web/src/lib/x.ts'], { floor }).reason, 'full:no_config');
  }
  assert.equal(related.relatedPlan('test-web', [], { floor }).reason, 'full:no_changes');
});

test('relatedCommand is null when a changed file is gone or its path could read as a flag', () => {
  const exists = path => path !== 'apps/web/src/lib/gone.ts';
  assert.equal(related.relatedPlan('test-web', ['apps/web/src/lib/gone.ts'], { floor, exists }).reason, 'full:deleted:apps/web/src/lib/gone.ts');
  assert.equal(related.relatedPlan('test-web', ['-x.ts'], { floor }).reason, 'full:unsafe_path:-x.ts');
  assert.equal(related.relatedPlan('test-web', ['apps/web/src/a b.ts'], { floor }).reason, 'full:unsafe_path:apps/web/src/a b.ts');
});

test('relatedCommand argv never puts a file path where vitest reads a positional filter', () => {
  const changed = ['apps/web/src/lib/runAction.ts', 'apps/web/src/components/A.tsx', 'apps/api/src/routes/devices.ts'];
  const argv = related.relatedCommand('test-web', changed, { floor });
  assert.ok(Array.isArray(argv));
  const at = argv.indexOf('related');
  assert.ok(at > 0, 'the vitest subcommand is `related`');
  assert.deepEqual(argv.slice(0, at), ['pnpm', '--filter=@breeze/web', 'exec', 'vitest'], 'nothing but the launcher precedes `related`');
  assert.ok(!argv.includes('run'), 'never `vitest run <files>`: those are substring filters');
  assert.ok(!argv.includes('--'), 'no `--`: cac would move the files out of `related`');
  const files = argv.slice(at + 1, at + 1 + changed.length);
  assert.deepEqual(files, ['src/lib/runAction.ts', 'src/components/A.tsx', '../api/src/routes/devices.ts'], 'files follow `related` directly, relative to the area root');
  assert.ok(argv.slice(at + 1 + changed.length).every(arg => arg.startsWith('--') || arg === 'vitest.config.ts'), 'only flags follow the files');
  assert.ok(argv.includes('--run') && argv.includes('--passWithNoTests'));
  assert.deepEqual(argv.slice(argv.indexOf('--config'), argv.indexOf('--config') + 2), ['--config', 'vitest.config.ts']);
  assert.equal(related.relatedPlan('test-web', changed, { floor }).reason, 'related');
});

test('RELATED_JOBS names real configs and setup files', () => {
  for (const [job, area] of Object.entries(related.RELATED_JOBS)) {
    assert.ok(existsSync(join(REPO_ROOT, area.config)), `${job}: ${area.config}`);
    const config = read(area.config);
    for (const setup of area.setupFiles) {
      assert.ok(existsSync(join(REPO_ROOT, setup)), `${job}: ${setup}`);
      assert.ok(config.includes(setup.slice(area.root.length + 1)), `${job}: ${area.config} does not name ${setup}`);
    }
    assert.equal(JSON.parse(read(`${area.root}/package.json`)).name, area.package, job);
  }
  assert.deepEqual(Object.keys(related.RELATED_JOBS).sort(), ['test-api', 'test-portal', 'test-web']);
});

// ── C2: the related set ──────────────────────────────────────────────────────

for (const name of ['pr-9518-api-unit', 'pr-10023-api-unit']) {
  test(`fixture ${name}: the failing test is inside related(P ∪ Δ) ∪ always ∪ own(P), from recorded import edges`, () => {
    const f = fixture(name), recorded = edgesFixture[name];
    assert.ok(recorded, `fixtures/related-tests/import-edges.json has no ${name}`);
    const changed = [...new Set([...f.P, ...f.delta])];
    const set = related.relatedSet({ changed, edges: recorded.edges, tests: recorded.tests, always: [], own: f.P });
    assert.ok(set.includes(recorded.failing_test), `${recorded.failing_test} not selected`);
    // Not only through own(P): the import graph alone reaches it from Δ.
    const fromDelta = related.relatedSet({ changed: f.delta, edges: recorded.edges, tests: recorded.tests, always: [], own: [] });
    assert.ok(fromDelta.includes(recorded.failing_test), `${recorded.failing_test} is not reachable from Δ by import`);
  });
}

test('the recorded import edges still hold in the tree (each edge is a literal import today)', () => {
  for (const [name, recorded] of Object.entries(edgesFixture)) {
    for (const [from, tos] of Object.entries(recorded.edges)) {
      const live = related.staticImports(REPO_ROOT, from);
      for (const to of tos) assert.ok(live.includes(to), `${name}: ${from} no longer imports ${to}`);
    }
  }
});

test('an always test is included even with no import edge', () => {
  const tests = ['apps/web/src/a.test.ts', 'apps/web/src/b.test.ts', 'apps/web/src/c.test.ts'];
  const set = related.relatedSet({ changed: ['apps/web/src/x.ts'], edges: { 'apps/web/src/a.test.ts': ['apps/web/src/x.ts'] },
    tests, always: ['apps/web/src/b.test.ts', 'apps/api/src/other-area.test.ts'], own: [] });
  assert.deepEqual(set, ['apps/web/src/a.test.ts', 'apps/web/src/b.test.ts']);
});

test('related follows imports transitively, and a changed test selects itself', () => {
  const edges = { 'a.test.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': ['b.ts'], 'd.test.ts': ['e.ts'] };
  const tests = ['a.test.ts', 'd.test.ts', 'f.test.ts'];
  assert.deepEqual(related.relatedSet({ changed: ['c.ts'], edges, tests, always: [], own: [] }), ['a.test.ts']);
  assert.deepEqual(related.relatedSet({ changed: ['f.test.ts'], edges, tests, always: [], own: [] }), ['f.test.ts']);
  assert.deepEqual(related.relatedSet({ changed: [], edges, tests, always: [], own: ['d.test.ts'] }), ['d.test.ts']);
});

test('staticImports resolves relative, @/ and @breeze/shared specifiers to repo paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'related-tests-'));
  try {
    const put = (path, text = '') => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
    put('apps/web/src/lib/x.ts');
    put('apps/web/src/lib/y/index.ts');
    put('packages/shared/src/index.ts');
    put('packages/shared/src/validators/v.ts');
    put('apps/web/src/a.test.ts', [
      "import { x } from './lib/x';",
      "import y from '@/lib/y';",
      "import { s } from '@breeze/shared';",
      "export { v } from '@breeze/shared/validators/v';",
      "const lazy = await import('./lib/x.js');",
      "import 'react';",
    ].join('\n'));
    assert.deepEqual(related.staticImports(dir, 'apps/web/src/a.test.ts'),
      ['apps/web/src/lib/x.ts', 'apps/web/src/lib/y/index.ts', 'packages/shared/src/index.ts', 'packages/shared/src/validators/v.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shadowLine has the planned shape and never lets a value start a workflow command', () => {
  assert.equal(related.shadowLine({ job: 'test-web', wouldRun: 12, total: 1030, reason: 'related', inputs: 'entry', graph: 'static' }),
    'unit-related: job=test-web would_run=12/1030 reason=related inputs=entry graph=static');
  assert.equal(related.shadowLine({ job: 'test-api', wouldRun: null, total: 2470, reason: 'full:floor:apps/api/src/db/x.ts', inputs: 'entry', graph: 'static' }),
    'unit-related: job=test-api would_run=2470/2470 reason=full:floor:apps/api/src/db/x.ts inputs=entry graph=static');
  assert.doesNotMatch(related.shadowLine({ job: 'test-web', wouldRun: 0, total: 1, reason: 'full:deleted:a\n::error::x', inputs: 'entry', graph: 'static' }), /\n/);
});

test('shadow CLI: one unit-related line and exit 0, even when git fails', async () => {
  const lines = [];
  const code = await related.shadowMain(['--job', 'test-web', '--base', 'f'.repeat(40), '--head', 'HEAD'], {
    repoRoot: REPO_ROOT, git: () => { throw Error('fatal: bad object'); }, stdout: line => lines.push(line), stderr: () => {},
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^unit-related: job=test-web would_run=\d+\/\d+ reason=full:error inputs=entry graph=static$/);
});

test('shadow CLI: a related change counts only the tests that reach it', async () => {
  const lines = [];
  await related.shadowMain(['--job', 'test-web', '--base', 'f'.repeat(40), '--head', 'HEAD'], {
    repoRoot: REPO_ROOT, git: () => 'apps/web/src/lib/runAction.ts\n', stdout: line => lines.push(line), stderr: () => {},
  });
  const [, n, total] = lines[0].match(/would_run=(\d+)\/(\d+) reason=related /) ?? [];
  assert.ok(Number(n) > 0 && Number(n) < Number(total), lines[0]);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('the always list and the related module are policy files', () => {
  for (const path of [related.ALWAYS_PATH, '.github/scripts/related-tests.mjs']) assert.ok(POLICY_FILES.includes(path), path);
});

test('lint runs this suite', () => {
  const ci = read('.github/workflows/ci.yml');
  const lint = ci.match(/^  lint:\n([\s\S]*?)(?=^  [a-z][\w-]*:\n)/m)?.[1];
  assert.ok(lint, 'lint job not found');
  assert.match(lint, /^        run: node --test \.github\/scripts\/related-tests\.test\.mjs$/m);
});

for (const [job, label] of [['test-api', 'API'], ['test-web', 'Web']]) {
  test(`${job} logs the related-test shadow on merge_group, shard 1 only, and it cannot fail the job`, () => {
    const ci = read('.github/workflows/ci.yml');
    const body = ci.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n)`, 'm'))?.[1];
    assert.ok(body, `${job} not found`);
    const step = body.match(/^      - name: Related-test shadow \(W07c\)\n((?:        .*\n)+)/m)?.[1];
    assert.ok(step, `${job} has no "Related-test shadow (W07c)" step`);
    assert.match(step, /^        if: github\.event_name == 'merge_group' && matrix\.shard == 1$/m);
    assert.match(step, /^        continue-on-error: true$/m);
    assert.match(step, /^        timeout-minutes: [1-5]$/m);
    assert.match(step, new RegExp(`node \\.github/scripts/related-tests\\.mjs shadow --job ${job} --base "\\$\\{CI_BASE_SHA\\}" --head HEAD`));
    // It runs before the tests, so a hang cannot hold the shard's budget, and never wraps them.
    assert.ok(body.indexOf('Related-test shadow (W07c)') < body.indexOf(`name: Run ${label} tests`));
  });
}
