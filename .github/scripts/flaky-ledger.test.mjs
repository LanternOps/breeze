import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { activeEntries, activeQuarantine, changedFiles, failureTouched, isQuarantined, loadBaseLedger, validateLedger } from './flaky-ledger.mjs';

// Flaky-test ledger (W1, #10744). A test listed in .github/flaky-tests.json —
// read from the BASE commit, never from the PR's head — may fail both retry
// attempts without failing the job, but only while the PR does not touch the
// test (or its sibling source). Anything unknown fails closed: no quarantine.

const REPO_ROOT = new URL('../../', import.meta.url);

const entry = (over = {}) => ({
  id: 'src/services/foo.test.ts > foo > is flaky',
  runner: 'vitest-api',
  file: 'apps/api/src/services/foo.test.ts',
  issue: 10744,
  added: '2026-10-30',
  expires: '2026-11-29',
  ...over,
});

// ── validateLedger ───────────────────────────────────────────────────────

test('validateLedger: accepts a valid entry and an empty ledger', () => {
  assert.deepEqual(validateLedger([entry()]), []);
  assert.deepEqual(validateLedger([]), []);
});

test('validateLedger: rejects a non-array ledger', () => {
  assert.notDeepEqual(validateLedger({}), []);
  assert.notDeepEqual(validateLedger(null), []);
});

test('validateLedger: rejects a missing issue, and issue <= 0', () => {
  const { issue: _drop, ...noIssue } = entry();
  assert.match(validateLedger([noIssue]).join('\n'), /issue/);
  assert.match(validateLedger([entry({ issue: 0 })]).join('\n'), /issue/);
  assert.match(validateLedger([entry({ issue: '10744' })]).join('\n'), /issue/);
});

test('validateLedger: rejects every other missing field', () => {
  for (const field of ['id', 'runner', 'file', 'added', 'expires']) {
    const e = entry();
    delete e[field];
    assert.match(validateLedger([e]).join('\n'), new RegExp(field), field);
  }
});

test('validateLedger: rejects an unknown runner', () => {
  assert.match(validateLedger([entry({ runner: 'jest' })]).join('\n'), /runner/);
});

test('validateLedger: expires must be after added and at most 30 days after it', () => {
  assert.deepEqual(validateLedger([entry({ added: '2026-10-30', expires: '2026-11-29' })]), []); // 30 days
  assert.match(validateLedger([entry({ added: '2026-10-30', expires: '2026-11-30' })]).join('\n'), /30 days/); // 31
  assert.match(validateLedger([entry({ added: '2026-10-30', expires: '2026-10-30' })]).join('\n'), /after/);
  assert.match(validateLedger([entry({ added: '2026-10-30', expires: '2026-10-01' })]).join('\n'), /after/);
});

test('validateLedger: rejects malformed or impossible dates', () => {
  assert.match(validateLedger([entry({ added: '2026-10-3' })]).join('\n'), /added/);
  assert.match(validateLedger([entry({ expires: '2026-02-30' })]).join('\n'), /expires/);
});

test('validateLedger: ids are unique per runner (the same id under two runners is fine)', () => {
  assert.match(validateLedger([entry(), entry({ issue: 1 })]).join('\n'), /duplicate/);
  assert.deepEqual(validateLedger([entry(), entry({ runner: 'vitest-integration' })]), []);
});

test('validateLedger: a go id names a top-level test (quarantine granularity), never a subtest or a package', () => {
  const go = (id) => entry({ id, runner: 'go', file: 'agent/internal/x/x_test.go' });
  assert.deepEqual(validateLedger([go('github.com/breeze-rmm/agent/internal/x.TestFlaky')]), []);
  assert.match(validateLedger([go('github.com/breeze-rmm/agent/internal/x.TestFlaky/sub')]).join('\n'), /top-level/);
  assert.match(validateLedger([go('github.com/breeze-rmm/agent/internal/x')]).join('\n'), /top-level/);
});

test('validateLedger: a vitest id names one test — never a failed-suite or file-level id', () => {
  const suite = 'src/services/foo.test.ts [ src/services/foo.test.ts ]';
  assert.match(validateLedger([entry({ id: suite })]).join('\n'), /single test/);
  assert.match(validateLedger([entry({ id: 'src/services/foo.test.ts' })]).join('\n'), /single test/);
  // A test name may itself end in brackets.
  assert.deepEqual(validateLedger([entry({ id: 'src/services/foo.test.ts > foo > handles [a]' })]), []);
});

test('validateLedger: a vitest entry\'s file is its package prefix + the id\'s file', () => {
  assert.match(validateLedger([entry({ file: 'apps/web/src/services/foo.test.ts' })]).join('\n'), /file/);
  assert.deepEqual(validateLedger([entry({ runner: 'vitest-web', file: 'apps/web/src/services/foo.test.ts' })]), []);
});

test('validateLedger: covers is optional, an array of non-empty repo-relative paths', () => {
  assert.deepEqual(validateLedger([entry({ covers: ['apps/api/src/services/billing/', 'apps/api/src/db/schema/x.ts'] })]), []);
  for (const covers of ['apps/api/src', [], [''], ['/abs/path'], ['apps/../etc'], [3]]) {
    assert.match(validateLedger([entry({ covers })]).join('\n'), /covers/, JSON.stringify(covers));
  }
});

test('the committed .github/flaky-tests.json is a valid ledger', () => {
  const ledger = JSON.parse(readFileSync(new URL('.github/flaky-tests.json', REPO_ROOT), 'utf8'));
  assert.deepEqual(validateLedger(ledger), []);
});

// ── activeQuarantine ─────────────────────────────────────────────────────

test('activeQuarantine: ids for that runner while today <= expires; an entry that expired yesterday is dropped', () => {
  const ledger = [
    entry({ id: 'live', expires: '2026-11-15' }),
    entry({ id: 'last-day', expires: '2026-11-10' }),
    entry({ id: 'expired', expires: '2026-11-09' }),
    entry({ id: 'web', runner: 'vitest-web' }),
  ];
  assert.deepEqual(activeQuarantine(ledger, 'vitest-api', '2026-11-10'), new Set(['live', 'last-day']));
  assert.deepEqual(activeQuarantine(ledger, 'vitest-web', '2026-11-10'), new Set(['web']));
  assert.deepEqual(activeQuarantine(ledger, 'go', '2026-11-10'), new Set());
});

test('activeQuarantine: an entry whose added is after today is not active (no stretched window)', () => {
  const ledger = [entry({ id: 'future', added: '2026-11-11', expires: '2026-12-01' }), entry({ id: 'today', added: '2026-11-10' })];
  assert.deepEqual(activeQuarantine(ledger, 'vitest-api', '2026-11-10'), new Set(['today']));
  assert.deepEqual(activeEntries(ledger, 'vitest-api', '2026-11-10').map((e) => e.id), ['today']);
});

// ── git: base ledger + changed files ─────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// origin: base commit B (ledger with entry `base-id`), head commit H touching
// a.ts and rewriting the ledger to `head-id`. clone: a depth-1 clone of H —
// the shape actions/checkout leaves — so B is absent until fetched.
function fixtureRepos() {
  const root = mkdtempSync(join(tmpdir(), 'flaky-ledger-'));
  const origin = join(root, 'origin');
  mkdirSync(join(origin, '.github'), { recursive: true });
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 'ci@example.com');
  git(origin, 'config', 'user.name', 'ci');
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  writeFileSync(join(origin, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(origin, 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(origin, '.github/flaky-tests.json'), JSON.stringify([entry({ id: 'src/services/foo.test.ts > base-id' })]));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  const baseSha = git(origin, 'rev-parse', 'HEAD');
  writeFileSync(join(origin, 'a.ts'), 'export const a = 2;\n');
  git(origin, 'commit', '-q', '-am', 'touch a');
  writeFileSync(join(origin, '.github/flaky-tests.json'), JSON.stringify([entry({ id: 'src/services/foo.test.ts > head-id' })]));
  git(origin, 'commit', '-q', '-am', 'head edits the ledger');
  const clone = join(root, 'clone');
  git(root, 'clone', '-q', '--depth=1', pathToFileURL(origin).href, clone);
  return { origin, clone, baseSha };
}

test('loadBaseLedger: no base sha → [] (fail closed)', () => {
  assert.deepEqual(loadBaseLedger({ baseSha: undefined, repoRoot: process.cwd() }), []);
  assert.deepEqual(loadBaseLedger({ baseSha: '', repoRoot: process.cwd() }), []);
});

test('loadBaseLedger / changedFiles: base not fetched → [] / null (fail closed)', () => {
  const { clone, baseSha } = fixtureRepos();
  assert.deepEqual(loadBaseLedger({ baseSha, repoRoot: clone }), []);
  assert.equal(changedFiles({ baseSha, repoRoot: clone }), null);
});

test('loadBaseLedger: reads the ledger at BASE, never the head copy', () => {
  const { clone, baseSha } = fixtureRepos();
  git(clone, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', baseSha);
  assert.deepEqual(loadBaseLedger({ baseSha, repoRoot: clone }).map((e) => e.id), ['src/services/foo.test.ts > base-id']);
});

test('loadBaseLedger: a ledger absent at base → []', () => {
  const { origin, baseSha } = fixtureRepos();
  git(origin, 'rm', '-q', '.github/flaky-tests.json');
  git(origin, 'commit', '-q', '-m', 'drop ledger');
  const noLedger = git(origin, 'rev-parse', 'HEAD');
  assert.notEqual(noLedger, baseSha);
  assert.deepEqual(loadBaseLedger({ baseSha: noLedger, repoRoot: origin }), []);
});

test('loadBaseLedger: an invalid ledger at base → [] (fail closed)', () => {
  const { origin } = fixtureRepos();
  writeFileSync(join(origin, '.github/flaky-tests.json'), JSON.stringify([entry({ issue: 0 })]));
  git(origin, 'commit', '-q', '-am', 'bad ledger');
  assert.deepEqual(loadBaseLedger({ baseSha: git(origin, 'rev-parse', 'HEAD'), repoRoot: origin }), []);
});

test('loadBaseLedger / changedFiles: a base that is not a sha → [] / null', () => {
  const { clone } = fixtureRepos();
  assert.deepEqual(loadBaseLedger({ baseSha: '--output=/tmp/x', repoRoot: clone }), []);
  assert.equal(changedFiles({ baseSha: 'HEAD', repoRoot: clone }), null);
});

test('changedFiles: two-dot diff against a shallow-fetched base', () => {
  const { clone, baseSha } = fixtureRepos();
  git(clone, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', baseSha);
  assert.deepEqual(changedFiles({ baseSha, repoRoot: clone }), new Set(['a.ts', '.github/flaky-tests.json']));
});

test('changedFiles: no base sha → null', () => {
  assert.equal(changedFiles({ baseSha: undefined, repoRoot: process.cwd() }), null);
});

// ── failureTouched / isQuarantined ───────────────────────────────────────

const vt = (file) => ({ id: `${file} > t`, file, pkg: null });
const API = { prefix: 'apps/api/' };

test('failureTouched (vitest): package-relative file is prefixed to repo-relative', () => {
  const f = vt('src/services/foo.test.ts');
  assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.test.ts']), API), true);
  assert.equal(failureTouched(f, new Set(['src/services/foo.test.ts']), API), false);
  assert.equal(failureTouched(f, new Set(['apps/web/src/services/foo.test.ts']), API), false);
});

test('failureTouched (vitest): the sibling source of foo.test.ts counts, any extension', () => {
  const f = vt('src/services/foo.test.ts');
  assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.ts']), API), true);
  assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.tsx']), API), true);
  assert.equal(failureTouched(f, new Set(['apps/api/src/services/foobar.ts']), API), false);
  // __tests__/foo.test.ts covers ../foo.ts too.
  const g = vt('src/lib/__tests__/foo.test.tsx');
  assert.equal(failureTouched(g, new Set(['apps/api/src/lib/foo.tsx']), API), true);
  assert.equal(failureTouched(g, new Set(['apps/api/src/lib/__tests__/foo.ts']), API), true);
});

test('failureTouched (vitest): a multi-part suffix chain still maps to the source (fail closed)', () => {
  for (const name of ['foo.integration.test.ts', 'foo.contract.test.ts', 'foo.e2e.spec.ts', 'foo.rls.integration.test.ts']) {
    const f = vt(`src/services/${name}`);
    assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.ts']), API), true, name);
    assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.service.ts']), API), true, name);
    assert.equal(failureTouched(f, new Set(['apps/api/src/services/food.ts']), API), false, name);
  }
});

// vitest-integration: an integration test exercises far more than a sibling,
// so without `covers` any non-test change under apps/api/src/ touches it.
const INT = { prefix: 'apps/api/', sourceRoot: 'apps/api/src/' };
const it_ = vt('src/__tests__/integration/billing.integration.test.ts');

test('failureTouched (vitest-integration): any changed non-test file under apps/api/src/ touches it', () => {
  assert.equal(failureTouched(it_, new Set(['apps/api/src/services/unrelated.ts']), INT), true);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/__tests__/integration/setup.ts']), INT), true);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/routes/other.test.ts', 'apps/web/src/x.ts', 'docs/a.md']), INT), false);
  assert.equal(failureTouched(it_, new Set([`apps/api/${it_.file}`]), INT), true);
});

test('failureTouched (vitest-integration): a declared covers list is used instead (plus the test file)', () => {
  const paths = { ...INT, covers: new Map([[it_.id, ['apps/api/src/services/billing/', 'apps/api/src/db/schema/invoices.ts']]]) };
  assert.equal(failureTouched(it_, new Set(['apps/api/src/services/unrelated.ts']), paths), false);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/services/billing/x.ts']), paths), true);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/services/billing']), paths), true);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/services/billingx.ts']), paths), false);
  assert.equal(failureTouched(it_, new Set(['apps/api/src/db/schema/invoices.ts']), paths), true);
  assert.equal(failureTouched(it_, new Set([`apps/api/${it_.file}`]), paths), true);
});

test('failureTouched: covers on a unit/go entry only adds paths (never narrows the sibling/package rule)', () => {
  const f = vt('src/services/foo.test.ts');
  const paths = { ...API, covers: new Map([[f.id, ['apps/api/src/lib/']]]) };
  assert.equal(failureTouched(f, new Set(['apps/api/src/lib/a.ts']), paths), true);
  assert.equal(failureTouched(f, new Set(['apps/api/src/services/foo.ts']), paths), true);
});

const GO = { goModule: 'github.com/breeze-rmm/agent', goDir: 'agent' };
const gt = (pkg, test) => ({ id: test ? `${pkg}.${test}` : pkg, file: null, pkg });

test('failureTouched (go): import path → repo dir; any changed file under it touches the package', () => {
  const f = gt('github.com/breeze-rmm/agent/internal/x', 'TestA');
  assert.equal(failureTouched(f, new Set(['agent/internal/x/x.go']), GO), true);
  assert.equal(failureTouched(f, new Set(['agent/internal/x/sub/y.go']), GO), true);
  assert.equal(failureTouched(f, new Set(['agent/internal/xy/x.go', 'apps/api/x.ts']), GO), false);
  assert.equal(failureTouched(gt('github.com/breeze-rmm/agent', 'TestRoot'), new Set(['agent/main.go']), GO), true);
});

test('failureTouched (go): a package outside the module cannot be mapped → touched (blocks)', () => {
  assert.equal(failureTouched(gt('example.com/other/x', 'TestA'), new Set(), GO), true);
  assert.equal(failureTouched(gt('github.com/breeze-rmm/agent/x', 'TestA'), new Set(), {}), true);
});

test('isQuarantined: vitest matches the exact id', () => {
  const q = new Set(['src/a.test.ts > t']);
  assert.equal(isQuarantined(vt('src/a.test.ts'), q), true);
  assert.equal(isQuarantined({ id: 'src/a.test.ts > t2', file: 'src/a.test.ts', pkg: null }, q), false);
});

test('isQuarantined (go): a quarantined top-level test covers its subtests; a package failure never', () => {
  const pkg = 'github.com/breeze-rmm/agent/internal/x';
  const q = new Set([`${pkg}.TestX`]);
  assert.equal(isQuarantined(gt(pkg, 'TestX'), q), true);
  assert.equal(isQuarantined(gt(pkg, 'TestX/sub/deeper'), q), true);
  assert.equal(isQuarantined(gt(pkg, 'TestXY'), q), false);
  assert.equal(isQuarantined(gt(pkg, 'TestY/sub'), q), false);
  assert.equal(isQuarantined(gt(pkg), new Set([pkg])), false);
});
