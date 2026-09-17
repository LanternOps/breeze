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

test('classifier: docs-only path sets report code=false docs=true agent=false', () => {
  for (const paths of [
    ['docs/guide.md'],
    ['apps/docs/src/content/docs/agent.mdx'],
    ['README.md', 'apps/api/README.md', 'docs/x/y.png'],
    ['CHANGELOG.md', 'apps/docs/astro.config.mjs'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'code=false\ndocs=true\nagent=false', paths.join(', '));
  }
});

test('classifier: any non-docs path reports code=true; docs=true only when a docs path is present', () => {
  for (const [paths, expected] of [
    [['apps/api/src/index.ts'], 'code=true\ndocs=false\nagent=false'],
    [['README.md', 'apps/web/src/App.tsx'], 'code=true\ndocs=true\nagent=false'],
    [['docs/guide.md', '.github/workflows/ci.yml'], 'code=true\ndocs=true\nagent=true'],
    [['apps/mobile/docs.md.bak'], 'code=true\ndocs=false\nagent=false'],
    [['packages/shared/src/markdown/render.ts'], 'code=true\ndocs=false\nagent=false'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected, paths.join(', '));
  }
});

test('classifier: an empty file list fails closed to code=true docs=true agent=true', () => {
  const run = classify([]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'code=true\ndocs=true\nagent=true');
  assert.match(run.stderr, /fail-closed/u);
});

test('classifier: agent output — agent/** and the CI plumbing that gates it are agent=true, everything else agent=false', () => {
  for (const [paths, expected] of [
    [['agent/internal/discovery/scanner.go'], 'agent=true'],
    [['agent/go.mod'], 'agent=true'],
    [['.github/workflows/ci.yml'], 'agent=true'],
    [['.github/scripts/classify-pr-paths.sh'], 'agent=true'],
    [['apps/web/src/App.tsx'], 'agent=false'],
    [['apps/api/src/index.ts', 'apps/web/src/App.tsx'], 'agent=false'],
    [['docs/guide.md'], 'agent=false'],
    [['agentless-thing/foo.ts'], 'agent=false'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    const agentLine = run.stdout.trim().split('\n').find((l) => l.startsWith('agent='));
    assert.equal(agentLine, expected, paths.join(', '));
  }
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
  assert.equal(output, 'code=false\ndocs=true\nagent=false');
});

test('merge_group: a mixed entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'docs/guide.md': 'a\n', 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nagent=false');
});

test('merge_group: a code-only entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=false');
});

test('merge_group: an agent-only entry is classified as code and agent', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'agent/internal/foo.go': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=true');
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
    assert.equal(output, 'code=true\ndocs=true\nagent=true', JSON.stringify(env));
  }
});

test('merge_group: an empty diff fails closed to the full suite', () => {
  const { execution, output } = runClassifier({ EVENT_NAME: 'merge_group' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nagent=true');
});

test('workflow_dispatch and any other event still run the full suite', () => {
  for (const EVENT_NAME of ['workflow_dispatch', 'push', 'schedule']) {
    const { execution, output } = runClassifier({ EVENT_NAME }, { seed: { 'docs/guide.md': 'a\n' } });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    assert.equal(output, 'code=true\ndocs=true\nagent=true', EVENT_NAME);
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
    'recovery-media-e2e', // compound gate (code AND agent) — asserted separately below
  ]);
  for (const name of jobs) {
    if (exempt.has(name)) continue;
    const body = job(name);
    assert.match(body, /^    needs: \[[^\]]*\bchanges\b[^\]]*\]$/mu, `${name} must list changes in needs:`);
    assert.match(body, /^    if: needs\.changes\.outputs\.code == 'true'$/mu, `${name} must be skipped on a docs-only PR`);
  }
});

test('recovery-media-e2e is gated on both the code and agent classifier outputs', () => {
  const body = job('recovery-media-e2e');
  assert.match(body, /^    needs: \[[^\]]*\bchanges\b[^\]]*\]$/mu);
  assert.match(
    body,
    /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.agent == 'true'$/mu,
    'recovery-media-e2e must require BOTH code and agent — it must still be skipped on a docs-only PR',
  );
});

test('the changes job exposes an agent output from the classifier', () => {
  const body = job('changes');
  assert.match(body, /^      agent: \$\{\{ steps\.classify\.outputs\.agent \}\}$/mu);
});

test('ci-success asserts recovery-media-e2e with the three-branch AGENT_CHANGED pattern', () => {
  assert.match(summary, /AGENT_CHANGED: \$\{\{ needs\.changes\.outputs\.agent \}\}/u);
  assert.match(
    summary,
    /\{ \[\[ "\$\{AGENT_CHANGED\}" == "true" \]\] && \[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "success" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{AGENT_CHANGED\}" != "true" \]\] && \[\[ "\$\{AGENT_CHANGED\}" != "false" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{AGENT_CHANGED\}" == "false" \]\] && \[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "skipped" \]\]; \} \|\|/u,
    'ci-success must assert AGENT_CHANGED true→success, false→skipped, anything else→fail (mirrors MOBILE_NATIVE_REQUIRED)',
  );
  assert.doesNotMatch(
    summary,
    /^\s*\[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "success" \]\] \|\| \\$/mu,
    'the old unconditional RECOVERY_MEDIA_E2E_RESULT clause must be replaced by the three-branch pattern',
  );
});

// ─── Item 2: Test API sharded 4 ways ─────────────────────────────────
// ~2470 vitest files import-time dominated, ~26-34 min unsharded. Only the
// main `test:run` invocation is actually split; every other named step in
// this job (extension-sdk, ee/workspace, tz, load-static, compat fixture,
// site-scope/integration-suite coverage, rls) is a single-DB-independent
// contract check that must run exactly once, so it is pinned to shard 1.

const testApiStep = (name) => {
  const body = job('test-api');
  const match = body.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)(?=\\n      - name:|\\n\\n  [a-z]|$)`, 'u'));
  assert.ok(match, `Missing test-api step "${name}"`);
  return match[1];
};

test('test-api has a 4-way shard matrix', () => {
  const body = job('test-api');
  assert.match(body, /^    name: Test API \(shard \$\{\{ matrix\.shard \}\}\/4\)$/mu);
  assert.match(body, /^    strategy:\n      fail-fast: false\n      matrix:\n        shard: \[1, 2, 3, 4\]$/mu);
  assert.match(body, /^    timeout-minutes: 30$/mu);
});

test('test-api runs the main vitest split with --shard and no bare "--"', () => {
  const step = testApiStep('Run API tests');
  assert.match(step, /run: pnpm --filter=@breeze\/api test:run --shard=\$\{\{ matrix\.shard \}\}\/4$/mu);
  assert.doesNotMatch(step, /pnpm --filter=@breeze\/api test:run -- /u, 'a bare "--" makes pnpm forward it literally and vitest silently ignores --shard');
});

test('test-api pins every non-sharded step to shard 1', () => {
  for (const name of [
    'Test extension SDK',
    'Type-check extension SDK',
    'Test workspace \\(ee\\)',
    'Type-check workspace \\(ee\\)',
    'Run API tests \\(auth/SSO, pinned non-UTC TZ\\)',
    'Run load-test static contract tests',
    'Gate SDK v1 compatibility fixture',
    'Run site-scope coverage contract test',
    'Run integration-suite coverage contract test',
    'Run RLS session-context contract test',
  ]) {
    const step = testApiStep(name);
    assert.match(step, /^        if: matrix\.shard == 1$/mu, `${name} must be pinned to shard 1`);
  }
});

test('test-api setup steps run on every shard (no shard-1 guard)', () => {
  for (const name of ['Checkout', 'Setup pnpm', 'Setup Node\\.js', 'Install dependencies']) {
    const step = testApiStep(name);
    assert.doesNotMatch(step, /if: matrix\.shard == 1/u, `${name} must run on every shard`);
  }
});

// ─── Item 3: integration-test sharded 8 ways, no lint/typecheck wait ────
test('integration-test has an 8-way shard matrix and does not wait on lint/typecheck', () => {
  const body = job('integration-test');
  assert.match(body, /^    name: Integration Tests \(shard \$\{\{ matrix\.shard \}\}\/8\)$/mu);
  assert.match(body, /^        shard: \[1, 2, 3, 4, 5, 6, 7, 8\]$/mu);
  // The exact match already proves lint/typecheck are absent from the actual
  // `needs:` YAML line (as opposed to a doesNotMatch scan, which would also
  // trip on this test's own explanatory comment mentioning them by name).
  assert.match(body, /^    needs: \[changes\]$/mu, 'integration-test must not needs: lint or typecheck — that added ~8 min to the critical path and a lint failure still fails CI Success via ci-success');
  assert.match(body, /^    timeout-minutes: 40$/mu);
  assert.match(body, /run: pnpm --filter=@breeze\/api test:integration --shard=\$\{\{ matrix\.shard \}\}\/8$/mu);
});

// Execute the real summary shell. The bypass may only fire on the literal
// `false` from a SUCCESSFUL classifier; every other shape must stay red.
const summaryScript = summary.split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');
const resultVars = [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((m) => m[1]);
const allOf = (value) => Object.fromEntries(resultVars.map((v) => [v, value]));
const passing = {
  ...allOf('success'), MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped', AGENT_CHANGED: 'true',
};
const docsOnlySkipped = {
  ...allOf('skipped'), CHANGES_RESULT: 'success', MOBILE_NATIVE_REQUIRED: '', AGENT_CHANGED: '', DOCS_CHANGED: 'true', DOCS_CHECK_RESULT: 'success',
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
  // ─── AGENT_CHANGED / recovery-media-e2e three-branch gate ───────────
  ['agent changed, recovery-media-e2e green', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'true', RECOVERY_MEDIA_E2E_RESULT: 'success' }, true],
  ['agent changed, recovery-media-e2e red', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'true', RECOVERY_MEDIA_E2E_RESULT: 'failure' }, false],
  ['agent changed, recovery-media-e2e unexpectedly skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'true', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, false],
  ['agent not changed, recovery-media-e2e correctly skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'false', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, true],
  ['agent not changed, recovery-media-e2e unexpectedly ran', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'false', RECOVERY_MEDIA_E2E_RESULT: 'success' }, false],
  ['agent_changed output empty', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: '', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, false],
  ['agent_changed output not a boolean', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', AGENT_CHANGED: 'maybe', RECOVERY_MEDIA_E2E_RESULT: 'skipped' }, false],
]) {
  test(`CI Success: ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...env },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}
