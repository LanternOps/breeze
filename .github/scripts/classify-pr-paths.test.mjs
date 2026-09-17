import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.equal(run.stdout.trim(), 'code=false\ndocs=true\nrecovery_media=false', paths.join(', '));
  }
});

test('classifier: any non-docs path reports code=true; docs=true only when a docs path is present', () => {
  for (const [paths, expected] of [
    [['apps/api/src/index.ts'], 'code=true\ndocs=false\nrecovery_media=false'],
    [['README.md', 'apps/web/src/App.tsx'], 'code=true\ndocs=true\nrecovery_media=false'],
    [['docs/guide.md', '.github/workflows/ci.yml'], 'code=true\ndocs=true\nrecovery_media=true'],
    [['apps/mobile/docs.md.bak'], 'code=true\ndocs=false\nrecovery_media=false'],
    [['packages/shared/src/markdown/render.ts'], 'code=true\ndocs=false\nrecovery_media=false'],
    // The recovery-media E2E builds breeze-backup from the agent module, so any
    // agent path (Go, go.sum, Makefile, live-build config) re-arms it; a docs
    // file under agent/ does not, and neither does the classifier script itself
    // being read here — only ci.yml and the classifier re-arm it from .github.
    [['agent/internal/backup/bmr/rebuild.go'], 'code=true\ndocs=false\nrecovery_media=true'],
    [['agent/go.sum'], 'code=true\ndocs=false\nrecovery_media=true'],
    [['agent/recovery-media/build.sh'], 'code=true\ndocs=false\nrecovery_media=true'],
    [['.github/scripts/classify-pr-paths.sh'], 'code=true\ndocs=false\nrecovery_media=true'],
    [['agent/README.md', 'apps/api/src/index.ts'], 'code=true\ndocs=true\nrecovery_media=false'],
    [['.github/workflows/release.yml'], 'code=true\ndocs=false\nrecovery_media=false'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected, paths.join(', '));
  }
});

test('classifier: an empty file list fails closed to code=true docs=true', () => {
  const run = classify([]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'code=true\ndocs=true\nrecovery_media=true');
  assert.match(run.stderr, /fail-closed/u);
});

// ─── merge_group classification ──────────────────────────────────────
// The queue used to run the full ~70-job matrix for every entry, docs-only
// ones included, which is pure waste against the concurrency cap. The SAME
// classifier now runs under `merge_group`, driven by a real `git diff` of
// base_sha...head_sha. It must fail SAFE: anything unresolvable runs the full
// suite (code=true), never a docs bypass.

// Pull the classify step's shell out of the `changes` job and execute it for
// real, the same way the ci-success summary is executed below.
const classifyScript = job('changes').split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');

const runClassifier = (env, { seed } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'classify-mg-'));
  try {
    mkdirSync(join(dir, '.github/scripts'), { recursive: true });
    copyFileSync(new URL('./classify-pr-paths.sh', import.meta.url), join(dir, '.github/scripts/classify-pr-paths.sh'));
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.com');
    git('config', 'user.name', 'CI');
    const commit = (files) => {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'c');
      return git('rev-parse', 'HEAD');
    };
    const shas = { base: commit({ 'seed.txt': 'seed\n' }) };
    if (seed) shas.head = commit(seed);
    const outputFile = join(dir, 'gh-output');
    writeFileSync(outputFile, '');
    const execution = spawnSync('bash', ['-c', classifyScript], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: 'LanternOps/breeze',
        BASE_SHA: env.BASE_SHA === undefined ? shas.base : env.BASE_SHA,
        HEAD_SHA: env.HEAD_SHA === undefined ? (shas.head ?? shas.base) : env.HEAD_SHA,
        ...env,
        EVENT_NAME: env.EVENT_NAME,
      },
    });
    return { execution, output: readFileSync(outputFile, 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('merge_group: a docs-only entry is classified docs-only', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'docs/guide.md': 'a\n', 'apps/docs/src/content/docs/agent.mdx': 'b\n', 'README.md': 'c\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=false\ndocs=true\nrecovery_media=false');
});

test('merge_group: a mixed entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'docs/guide.md': 'a\n', 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nrecovery_media=false');
});

test('merge_group: a code-only entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nrecovery_media=false');
});

test('merge_group: an unresolvable base sha fails safe to the full suite', () => {
  for (const env of [
    { EVENT_NAME: 'merge_group', BASE_SHA: '' },
    { EVENT_NAME: 'merge_group', HEAD_SHA: '' },
    { EVENT_NAME: 'merge_group', BASE_SHA: '0000000000000000000000000000000000000000' },
    { EVENT_NAME: 'merge_group', HEAD_SHA: 'refs/heads/does-not-exist' },
  ]) {
    const { execution, output } = runClassifier(env, { seed: { 'docs/guide.md': 'a\n' } });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    assert.equal(output, 'code=true\ndocs=true\nrecovery_media=true', JSON.stringify(env));
  }
});

test('merge_group: an empty diff fails closed to the full suite', () => {
  const { execution, output } = runClassifier({ EVENT_NAME: 'merge_group' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nrecovery_media=true');
});

test('workflow_dispatch and any other event still run the full suite', () => {
  for (const EVENT_NAME of ['workflow_dispatch', 'push', 'schedule']) {
    const { execution, output } = runClassifier({ EVENT_NAME }, { seed: { 'docs/guide.md': 'a\n' } });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    assert.equal(output, 'code=true\ndocs=true\nrecovery_media=true', EVENT_NAME);
  }
});

test('the changes job checks out enough history to diff a merge-group entry', () => {
  const body = job('changes');
  assert.match(body, /fetch-depth: \$\{\{ github\.event_name == 'merge_group' && '0' \|\| '1' \}\}/u);
  assert.match(body, /BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
  assert.match(body, /HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/u);
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
    'recovery-media-e2e', // gated on the narrower `recovery_media` output instead (pinned below)
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
const passing = { ...allOf('success'), MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped', RECOVERY_MEDIA_REQUIRED: 'true' };
const docsOnlySkipped = {
  ...allOf('skipped'), CHANGES_RESULT: 'success', MOBILE_NATIVE_REQUIRED: '', RECOVERY_MEDIA_REQUIRED: '', DOCS_CHANGED: 'true', DOCS_CHECK_RESULT: 'success',
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
  ['agent untouched, recovery-media E2E skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', RECOVERY_MEDIA_REQUIRED: 'false', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, true],
  ['agent touched, recovery-media E2E skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', RECOVERY_MEDIA_REQUIRED: 'true', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, false],
  ['agent touched, recovery-media E2E red', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', RECOVERY_MEDIA_REQUIRED: 'true', RECOVERY_MEDIA_E2E_RESULT: 'failure' }, false],
  ['recovery-media gate output empty, E2E skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', RECOVERY_MEDIA_REQUIRED: '', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, false],
  ['recovery-media gate output not a boolean', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', RECOVERY_MEDIA_REQUIRED: 'maybe' }, false],
]) {
  test(`CI Success: ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...env },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}

// ─── recovery-media E2E gate ─────────────────────────────────────────
// The QEMU job builds a Debian live ISO and boots it twice (~30 min, the
// single most expensive job after the integration shards). It only exercises
// breeze-backup and the recovery-media tree, both inside the agent module, so
// it is gated on the classifier's narrower `recovery_media` output: any
// agent/** path, ci.yml, or the classifier itself. ci-success mirrors the
// mobile-native contract — required when `true`, must be skipped when
// `false`, red on anything else.
test('recovery-media-e2e is gated on the recovery_media output and asserted by ci-success', () => {
  const body = job('recovery-media-e2e');
  assert.match(body, /^    needs: \[changes\]$/mu);
  assert.match(body, /^    if: needs\.changes\.outputs\.recovery_media == 'true'$/mu);
  assert.match(job('changes'), /^      recovery_media: \$\{\{ steps\.classify\.outputs\.recovery_media \}\}$/mu);
  assert.match(job('changes'), /printf 'code=true\\ndocs=true\\nrecovery_media=true\\n'/u);
  assert.match(summary, /^          RECOVERY_MEDIA_REQUIRED: \$\{\{ needs\.changes\.outputs\.recovery_media \}\}$/mu);
});
