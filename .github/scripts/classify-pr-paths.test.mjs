import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Contract for the docs-only fold-in: `ci.yml` is the ONLY workflow that
// reports `CI Success`. A docs-only PR must skip every code job and still go
// green; anything that weakens the classifier must fail closed (red), never
// open (green with nothing run).

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};
const summary = job('ci-success');
const classify = (paths) =>
  spawnSync('bash', [new URL('./classify-pr-paths.sh', import.meta.url).pathname], {
    encoding: 'utf8',
    input: paths.join('\n') + (paths.length ? '\n' : ''),
  });

test('classifier: docs-only path sets report code=false docs=true', () => {
  for (const paths of [
    ['docs/guide.md'],
    ['apps/docs/src/content/docs/agent.mdx'],
    ['README.md', 'apps/api/README.md', 'docs/x/y.png'],
    ['CHANGELOG.md', 'apps/docs/astro.config.mjs'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'code=false\ndocs=true', paths.join(', '));
  }
});

test('classifier: any non-docs path reports code=true; docs=true only when a docs path is present', () => {
  for (const [paths, expected] of [
    [['apps/api/src/index.ts'], 'code=true\ndocs=false'],
    [['README.md', 'apps/web/src/App.tsx'], 'code=true\ndocs=true'],
    [['docs/guide.md', '.github/workflows/ci.yml'], 'code=true\ndocs=true'],
    [['apps/mobile/docs.md.bak'], 'code=true\ndocs=false'],
    [['packages/shared/src/markdown/render.ts'], 'code=true\ndocs=false'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected, paths.join(', '));
  }
});

test('classifier: an empty file list fails closed to code=true docs=true', () => {
  const run = classify([]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'code=true\ndocs=true');
  assert.match(run.stderr, /fail-closed/u);
});

test('ci.yml is the only CI Success reporter and runs on every PR', () => {
  assert.ok(!existsSync(new URL('../workflows/ci-docs-only.yml', import.meta.url)), 'ci-docs-only.yml must stay deleted');
  assert.ok(!existsSync(new URL('../workflows/docs-ci.yml', import.meta.url)), 'docs-ci.yml must stay deleted');
  assert.match(job('docs-check'), /^    needs: \[changes\]$/mu);
  assert.match(job('docs-check'), /^    if: needs\.changes\.outputs\.docs == 'true'$/mu);
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:\n'));
  assert.doesNotMatch(trigger, /paths(-ignore)?:/u, 'a path filter on ci.yml starves docs-only PRs of CI Success');
  assert.match(job('changes'), /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{PR_NUMBER\}\/files" --paginate/u);
  assert.match(job('changes'), /bash \.github\/scripts\/classify-pr-paths\.sh/u);
  assert.match(job('lint'), /node --test \.github\/scripts\/classify-pr-paths\.test\.mjs/u);
});

test('every code job is gated on the classifier', () => {
  const jobs = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([a-z][\w-]*):$/gmu)].map((m) => m[1]);
  assert.ok(jobs.length > 35, 'job parser is stale');
  const exempt = new Set([
    'changes', // the classifier itself
    'ci-success', // must report on docs-only PRs — that is the whole point
    'main-red-alert', // workflow_dispatch on main only
    'docs-check', // gated on the `docs` output instead — it is the one job a docs-only PR must run
    'build-mobile-ios', // inherits the gate through mobile-native-changes (pinned by mobile-native-ci.test.mjs)
  ]);
  for (const name of jobs) {
    if (exempt.has(name)) continue;
    const body = job(name);
    assert.match(body, /^    needs: \[[^\]]*\bchanges\b[^\]]*\]$/mu, `${name} must list changes in needs:`);
    assert.match(body, /^    if: needs\.changes\.outputs\.code == 'true'$/mu, `${name} must be skipped on a docs-only PR`);
  }
});

// Execute the real summary shell. The bypass may only fire on the literal
// `false` from a SUCCESSFUL classifier; every other shape must stay red.
const summaryScript = summary.split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');
const resultVars = [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((m) => m[1]);
const allOf = (value) => Object.fromEntries(resultVars.map((v) => [v, value]));
const passing = { ...allOf('success'), MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped' };
const docsOnlySkipped = {
  ...allOf('skipped'), CHANGES_RESULT: 'success', MOBILE_NATIVE_REQUIRED: '', DOCS_CHANGED: 'true', DOCS_CHECK_RESULT: 'success',
};

for (const [label, env, passes] of [
  ['code change, all green', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true' }, true],
  ['code change without docs, docs-check skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'false', DOCS_CHECK_RESULT: 'skipped' }, true],
  ['code change, one job red', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TEST_WEB_RESULT: 'failure' }, false],
  ['code change, docs-check red', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', DOCS_CHECK_RESULT: 'failure' }, false],
  ['docs output empty, docs-check skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: '', DOCS_CHECK_RESULT: 'skipped' }, false],
  ['docs-only, every code job skipped, docs-check green', { ...docsOnlySkipped, CODE_CHANGED: 'false' }, true],
  ['docs-only, docs-check red', { ...docsOnlySkipped, CODE_CHANGED: 'false', DOCS_CHECK_RESULT: 'failure' }, false],
  ['docs-only, docs-check unexpectedly skipped', { ...docsOnlySkipped, CODE_CHANGED: 'false', DOCS_CHECK_RESULT: 'skipped' }, false],
  ['classifier emitted nothing, code jobs skipped', { ...docsOnlySkipped, CODE_CHANGED: '' }, false],
  ['classifier failed', { ...docsOnlySkipped, CHANGES_RESULT: 'failure', CODE_CHANGED: '' }, false],
  ['classifier skipped', { ...docsOnlySkipped, CHANGES_RESULT: 'skipped', CODE_CHANGED: '' }, false],
  ['classifier says false but reported failure', { ...docsOnlySkipped, CHANGES_RESULT: 'failure', CODE_CHANGED: 'false' }, false],
  ['classifier output is not a boolean', { ...docsOnlySkipped, CODE_CHANGED: 'no' }, false],
]) {
  test(`CI Success: ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...env },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}
