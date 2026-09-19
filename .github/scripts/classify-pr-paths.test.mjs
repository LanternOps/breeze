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

test('classifier: docs-only path sets report code=false docs=true agent=false app=false topology_browser=false', () => {
  for (const paths of [
    ['docs/guide.md'],
    ['apps/docs/src/content/docs/agent.mdx'],
    ['README.md', 'apps/api/README.md', 'docs/x/y.png'],
    ['CHANGELOG.md', 'apps/docs/astro.config.mjs'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'code=false\ndocs=true\nagent=false\napp=false\napi=false\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false', paths.join(', '));
  }
});

test('classifier: any non-docs path reports code=true; docs=true only when a docs path is present', () => {
  for (const [paths, expected] of [
    [['apps/api/src/index.ts'], 'code=true\ndocs=false\nagent=false\napp=true\napi=true\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false'],
    [['README.md', 'apps/web/src/App.tsx'], 'code=true\ndocs=true\nagent=false\napp=true\napi=true\nweb=true\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false'],
    [['docs/guide.md', '.github/workflows/ci.yml'], 'code=true\ndocs=true\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=true'],
    [['apps/mobile/docs.md.bak'], 'code=true\ndocs=false\nagent=false\napp=true\napi=false\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false'],
    [['packages/shared/src/markdown/render.ts'], 'code=true\ndocs=false\nagent=false\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=false'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), expected, paths.join(', '));
  }
});

test('classifier: an empty file list fails closed to code=true docs=true agent=true app=true topology_browser=true', () => {
  const run = classify([]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'code=true\ndocs=true\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=true');
  assert.match(run.stderr, /fail-closed/u);
});

test('classifier: app output — the CI-plumbing allowlist is app=false, everything else (incl. its explicit exceptions) is app=true', () => {
  for (const [paths, expected] of [
    // Allowlisted tooling paths → app=false
    [['.github/workflows/release.yml'], 'app=false'],
    [['.github/scripts/ci-build-reuse.test.mjs'], 'app=false'],
    [['scripts/release/check-release-lineage.sh'], 'app=false'],
    [['scripts/security/check-npm-audit.sh'], 'app=false'],
    [['.github/release-provenance/candidate-tags.tsv'], 'app=false'],
    [['.github/workflows/release.yml', 'scripts/security/check-npm-audit.sh'], 'app=false'],
    [['docs/guide.md', 'scripts/release/check-release-lineage.sh'], 'app=false'],
    // Explicit exceptions carved OUT of the allowlist → app=true
    [['.github/workflows/ci.yml'], 'app=true'],
    [['.github/scripts/classify-pr-paths.sh'], 'app=true'],
    // prepare-ci-apt-sources.mjs is consumed by rust-check and
    // guided-setup-smoke (both HEAVY jobs, not lint/check-migrations/
    // security-audit), so it must not fast-track past the app gate.
    [['.github/scripts/prepare-ci-apt-sources.mjs'], 'app=true'],
    // check-agent-binary-signatures.sh is consumed by build-agent (a HEAVY
    // job), so it must not fast-track past the app gate either.
    [['scripts/security/check-agent-binary-signatures.sh'], 'app=true'],
    // Anything outside the allowlist, including .github/actions/**
    [['.github/actions/install-chromium/action.yml'], 'app=true'],
    [['package.json'], 'app=true'],
    [['pnpm-lock.yaml'], 'app=true'],
    [['apps/api/src/index.ts'], 'app=true'],
    // Mixed tooling + app → app=true
    [['scripts/release/check-release-lineage.sh', 'apps/web/src/App.tsx'], 'app=true'],
  ]) {
    const run = classify(paths);
    assert.equal(run.status, 0, run.stderr);
    const appLine = run.stdout.trim().split('\n').find((l) => l.startsWith('app='));
    assert.equal(appLine, expected, paths.join(', '));
  }
});

test('classifier: agent output — agent/** and the CI plumbing that gates it are agent=true, everything else agent=false', () => {
  for (const [paths, expected] of [
    [['agent/internal/backup/client.go'], 'agent=true'],
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

// ─── Topology production-browser gate (#6117) ────────────────────────
// `topology-browser-gate` boots a BUILT production web server and runs the
// Chromium topology specs. It is far too heavy for every PR, so it is gated on
// its own classifier output: the topology UI, the shipped CSP/build config that
// governs the module worker, the shared topology contracts, the specs and
// fixtures themselves, and the CI plumbing that decides the gate (ci.yml and
// the classifier — same rule as `agent`).
const topologyLine = (run) => run.stdout.trim().split('\n').find((l) => l.startsWith('topology_browser='));

test('classifier: a topology-browser path reports topology_browser=true (and always code=true app=true)', () => {
  for (const path of [
    'apps/web/src/components/topology/layout.worker.ts',
    'apps/web/src/components/topology/TopologyExplorer.tsx',
    'apps/web/src/middleware.ts',
    'apps/web/astro.config.mjs',
    'apps/web/vite.config.ts',
    'apps/web/package.json',
    'pnpm-lock.yaml',
    'packages/shared/src/validators/topology.ts',
    'packages/shared/src/validators/topologyCollection.ts',
    'packages/shared/src/types/topologyDiagnostics.ts',
    'e2e-tests/playwright.topology-worker.config.ts',
    'e2e-tests/tests/topology-worker.spec.ts',
    'e2e-tests/tests/topology-baseline.spec.ts',
    'e2e-tests/helpers/topologyFixture.ts',
    'e2e-tests/helpers/topologyWorkerFixture.ts',
    'e2e-tests/pages/TopologyPage.ts',
    '.github/workflows/ci.yml',
    '.github/scripts/classify-pr-paths.sh',
  ]) {
    const run = classify([path]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(topologyLine(run), 'topology_browser=true', path);
    // The gate builds and boots the web app: it must never be on for a change
    // the code or app suites skip (ci-success would demand a job whose `if:`
    // could be argued either way).
    assert.match(run.stdout, /^code=true$/mu, path);
    assert.match(run.stdout, /^app=true$/mu, path);
  }
});

test('classifier: unrelated code paths do not trigger the topology browser gate', () => {
  for (const path of [
    'apps/api/src/routes/topology.ts',
    'apps/web/src/components/devices/DeviceDetailPage.tsx',
    'packages/shared/src/utils/topologyHelpers.ts',
    'e2e-tests/tests/devices.spec.ts',
    'e2e-tests/pages/DevicesPage.ts',
    '.github/workflows/security.yml',
    '.github/scripts/ci-build-reuse.test.mjs',
    'agent/internal/discovery/scanner.go',
  ]) {
    const run = classify([path]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(topologyLine(run), 'topology_browser=false', path);
  }
});

test('classifier: a docs file under the topology directory is still docs-only', () => {
  // topology_browser=true must imply code=true: the gate builds and boots the
  // web app, which is meaningless on a PR the code jobs skip entirely.
  const run = classify(['apps/web/src/components/topology/README.md']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'code=false\ndocs=true\nagent=false\napp=false\napi=false\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false');
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
  assert.equal(output, 'code=false\ndocs=true\nagent=false\napp=false\napi=false\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false');
});

test('merge_group: a mixed entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'docs/guide.md': 'a\n', 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nagent=false\napp=true\napi=true\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false');
});

test('merge_group: a code-only entry is classified as code', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'apps/api/src/index.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=false\napp=true\napi=true\nweb=false\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=false');
});

test('merge_group: an agent-only entry is classified as code and agent', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'agent/internal/foo.go': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=false');
});

test('merge_group: a topology-browser entry turns the production-browser gate on', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'apps/web/src/components/topology/layout.worker.ts': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=false\napp=true\napi=true\nweb=true\nportal=false\naddins=false\nm365=false\nrust=false\ntopology_browser=true');
});

test('merge_group: a tooling-only entry is classified as code but not app', () => {
  const { execution, output } = runClassifier(
    { EVENT_NAME: 'merge_group' },
    { seed: { 'scripts/security/check-npm-audit.sh': 'a\n', '.github/workflows/release.yml': 'b\n' } },
  );
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=false\nagent=false\napp=false\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=false');
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
    assert.equal(output, 'code=true\ndocs=true\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=true', JSON.stringify(env));
  }
});

test('merge_group: an empty diff fails closed to the full suite', () => {
  const { execution, output } = runClassifier({ EVENT_NAME: 'merge_group' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.equal(output, 'code=true\ndocs=true\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=true');
});

test('workflow_dispatch and any other event still run the full suite', () => {
  for (const EVENT_NAME of ['workflow_dispatch', 'push', 'schedule']) {
    const { execution, output } = runClassifier({ EVENT_NAME }, { seed: { 'docs/guide.md': 'a\n' } });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
    assert.equal(output, 'code=true\ndocs=true\nagent=true\napp=true\napi=true\nweb=true\nportal=true\naddins=true\nm365=true\nrust=true\ntopology_browser=true', EVENT_NAME);
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
    'topology-browser-gate', // compound gate (code AND topology_browser) — asserted separately below
  ]);
  // These validate CI plumbing itself (the classifier tests, the
  // release-lineage/migration-immutability guards, the supply-chain guards)
  // and must keep running on a tooling-only PR, so they are never gated on
  // `app`. check-migrations is additionally api-gated (a tooling-only change
  // always sets api — pinned in ci-area-gating.test.mjs).
  const codeOnly = new Set(['lint', 'security-audit']);
  // Per-area jobs carry an extra area clause AFTER the code/app gate; the exact
  // per-area `if:` lines are pinned by ci-area-gating.test.mjs. The prefix is
  // still required here, so a docs-only or tooling-only PR still skips them.
  const areaGated = /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.app == 'true' && (needs\.changes\.outputs\.(api|web|portal|addins|m365|rust) == 'true'|\(needs\.changes\.outputs\.api == 'true' \|\| needs\.changes\.outputs\.web == 'true' \|\| needs\.changes\.outputs\.portal == 'true'\))$/mu;
  for (const name of jobs) {
    if (exempt.has(name)) continue;
    const body = job(name);
    assert.match(body, /^    needs: \[[^\]]*\bchanges\b[^\]]*\]$/mu, `${name} must list changes in needs:`);
    if (name === 'check-migrations') {
      // code AND api, never app: it is the release-lineage guard for tooling-only PRs.
      assert.match(body, /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.api == 'true'$/mu, name);
    } else if (areaGated.test(body)) {
      continue;
    } else if (codeOnly.has(name)) {
      assert.match(body, /^    if: needs\.changes\.outputs\.code == 'true'$/mu, `${name} must be skipped on a docs-only PR, and stay code-only (not app-gated)`);
    } else {
      assert.match(
        body,
        /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.app == 'true'$/mu,
        `${name} must be skipped on a docs-only OR tooling-only PR`,
      );
    }
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
    /\{ \[\[ "\$\{AGENT_CHANGED\}" == "true" \]\] && \[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "success" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{AGENT_CHANGED\}" != "true" \]\] && \[\[ "\$\{AGENT_CHANGED\}" != "false" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{AGENT_CHANGED\}" == "false" \]\] && \[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "skipped" \]\]; \}/u,
    'ci-success must assert AGENT_CHANGED true→success, false→skipped, anything else→fail (mirrors MOBILE_NATIVE_REQUIRED)',
  );
  assert.doesNotMatch(
    summary,
    /^\s*\[\[ "\$\{RECOVERY_MEDIA_E2E_RESULT\}" != "success" \]\] \|\| \\$/mu,
    'the old unconditional RECOVERY_MEDIA_E2E_RESULT clause must be replaced by the three-branch pattern',
  );
});

// ─── Topology production-browser gate wiring (#6117) ─────────────────
test('topology-browser-gate is gated on both the code and topology_browser classifier outputs', () => {
  const body = job('topology-browser-gate');
  assert.match(body, /^    needs: \[changes\]$/mu);
  assert.match(
    body,
    /^    if: needs\.changes\.outputs\.code == 'true' && needs\.changes\.outputs\.topology_browser == 'true'$/mu,
    'topology-browser-gate must require BOTH code and topology_browser — it must still be skipped on a docs-only PR',
  );
  assert.match(body, /pnpm --filter @breeze\/web build:prod/u, 'the gate exists to exercise the PRODUCTION bundle');
  assert.match(body, /--config=playwright\.topology-worker\.config\.ts --project=chromium/u);
  // Anchored to a YAML key: the job body regex also captures the NEXT job's
  // leading comment, which mentions continue-on-error in prose.
  assert.doesNotMatch(body, /^\s+continue-on-error:/mu, 'the gate is blocking');
});

test('the changes job exposes a topology_browser output, and every full-suite fallback turns it ON', () => {
  const body = job('changes');
  assert.match(body, /^      topology_browser: \$\{\{ steps\.classify\.outputs\.topology_browser \}\}$/mu);
  // Fail-safe: the non-PR / unresolvable merge-group fallback must turn the gate ON, never off.
  assert.match(body, /printf 'code=true\\ndocs=true\\nagent=true\\napp=true\\napi=true\\nweb=true\\nportal=true\\naddins=true\\nm365=true\\nrust=true\\ntopology_browser=true\\n'/u);
});

test('ci-success asserts topology-browser-gate with the three-branch TOPOLOGY_BROWSER_CHANGED pattern', () => {
  assert.match(summary, /needs: \[[^\]]*\btopology-browser-gate\b[^\]]*\]/u);
  assert.match(summary, /TOPOLOGY_BROWSER_CHANGED: \$\{\{ needs\.changes\.outputs\.topology_browser \}\}/u);
  assert.match(summary, /TOPOLOGY_BROWSER_GATE_RESULT: \$\{\{ needs\.topology-browser-gate\.result \}\}/u);
  assert.match(
    summary,
    /\{ \[\[ "\$\{TOPOLOGY_BROWSER_CHANGED\}" == "true" \]\] && \[\[ "\$\{TOPOLOGY_BROWSER_GATE_RESULT\}" != "success" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{TOPOLOGY_BROWSER_CHANGED\}" != "true" \]\] && \[\[ "\$\{TOPOLOGY_BROWSER_CHANGED\}" != "false" \]\]; \} \|\| \\\n\s*\{ \[\[ "\$\{TOPOLOGY_BROWSER_CHANGED\}" == "false" \]\] && \[\[ "\$\{TOPOLOGY_BROWSER_GATE_RESULT\}" != "skipped" \]\]; \}/u,
    'ci-success must assert TOPOLOGY_BROWSER_CHANGED true→success, false→skipped, anything else→fail (mirrors AGENT_CHANGED)',
  );
});

// ─── Item 2: Test API sharded 8 ways ─────────────────────────────────
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

test('test-api has an 8-way shard matrix', () => {
  const body = job('test-api');
  assert.match(body, /^    name: Test API \(shard \$\{\{ matrix\.shard \}\}\/8\)$/mu);
  assert.match(body, /^    strategy:\n      fail-fast: false\n      matrix:\n        shard: \[1, 2, 3, 4, 5, 6, 7, 8\]$/mu);
  assert.match(body, /^    timeout-minutes: 30$/mu);
});

test('test-api runs the main vitest split with --shard and no bare "--"', () => {
  const step = testApiStep('Run API tests');
  assert.match(step, /run: pnpm --filter=@breeze\/api test:run --shard=\$\{\{ matrix\.shard \}\}\/8$/mu);
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

// ─── Item 3: integration-test sharded 16 ways, no lint/typecheck wait ───
test('ci-success asserts lint/check-migrations/security-audit unconditionally and gates the rest on APP_CHANGED', () => {
  assert.match(summary, /needs: \[[^\]]*\bcheck-migrations\b[^\]]*\]/u, 'ci-success must needs: check-migrations — CHECK_MIGRATIONS_RESULT was previously asserted nowhere');
  assert.match(summary, /APP_CHANGED: \$\{\{ needs\.changes\.outputs\.app \}\}/u);
  assert.match(summary, /CHECK_MIGRATIONS_RESULT: \$\{\{ needs\.check-migrations\.result \}\}/u);
});

test('integration-test has a 16-way shard matrix and does not wait on lint/typecheck', () => {
  const body = job('integration-test');
  assert.match(body, /^    name: Integration Tests \(shard \$\{\{ matrix\.shard \}\}\/16\)$/mu);
  assert.match(body, /^        shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16\]$/mu);
  // The exact match already proves lint/typecheck are absent from the actual
  // `needs:` YAML line (as opposed to a doesNotMatch scan, which would also
  // trip on this test's own explanatory comment mentioning them by name).
  assert.match(body, /^    needs: \[changes\]$/mu, 'integration-test must not needs: lint or typecheck — that added ~8 min to the critical path and a lint failure still fails CI Success via ci-success');
  assert.match(body, /^    timeout-minutes: 40$/mu);
  assert.match(body, /run: pnpm --filter=@breeze\/api test:integration --shard=\$\{\{ matrix\.shard \}\}\/16$/mu);
});

// Execute the real summary shell. The bypass may only fire on the literal
// `false` from a SUCCESSFUL classifier; every other shape must stay red.
const summaryScript = summary.split('        run: |\n')[1]
  .split('\n').filter((line) => line.startsWith('          '))
  .map((line) => line.slice(10)).join('\n');
const resultVars = [...summary.matchAll(/^          (\w+_RESULT):/gmu)].map((m) => m[1]);
const allOf = (value) => Object.fromEntries(resultVars.map((v) => [v, value]));
const passing = {
  ...allOf('success'), MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped', AGENT_CHANGED: 'true', APP_CHANGED: 'true',
  // Every per-area flag true: the per-area tri-state lives in ci-area-gating.test.mjs.
  API_CHANGED: 'true', WEB_CHANGED: 'true', PORTAL_CHANGED: 'true', ADDINS_CHANGED: 'true', M365_CHANGED: 'true', RUST_CHANGED: 'true',
  ...allOf('success'), MOBILE_NATIVE_REQUIRED: 'false', BUILD_MOBILE_IOS_RESULT: 'skipped', AGENT_CHANGED: 'true', APP_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'true',
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
  // ─── TOPOLOGY_BROWSER_CHANGED / topology-browser-gate three-branch gate (#6117) ───
  ['topology gate triggered and green', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'true', TOPOLOGY_BROWSER_GATE_RESULT: 'success' }, true],
  ['topology gate triggered and red', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'true', TOPOLOGY_BROWSER_GATE_RESULT: 'failure' }, false],
  ['topology gate triggered but never ran', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'true', TOPOLOGY_BROWSER_GATE_RESULT: 'skipped' }, false],
  ['topology gate not triggered and correctly skipped', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'false', TOPOLOGY_BROWSER_GATE_RESULT: 'skipped' }, true],
  ['topology gate not triggered but unexpectedly ran', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'false', TOPOLOGY_BROWSER_GATE_RESULT: 'success' }, false],
  ['topology gate red without a classifier signal', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: '', TOPOLOGY_BROWSER_GATE_RESULT: 'failure' }, false],
  ['topology_browser output empty', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: '', TOPOLOGY_BROWSER_GATE_RESULT: 'skipped' }, false],
  ['topology_browser output not a boolean', { ...passing, CODE_CHANGED: 'true', DOCS_CHANGED: 'true', TOPOLOGY_BROWSER_CHANGED: 'maybe', TOPOLOGY_BROWSER_GATE_RESULT: 'skipped' }, false],
]) {
  test(`CI Success: ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...env },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}

// ─── Item 4: APP_CHANGED three-branch gate (tooling-only PRs) ───────────
// LINT_RESULT/CHECK_MIGRATIONS_RESULT/SECURITY_AUDIT_RESULT must stay
// required unconditionally (they validate CI plumbing itself). Every other
// code job is required only when APP_CHANGED == 'true', must be `skipped`
// when APP_CHANGED == 'false', and any other value must fail closed — the
// same three-branch shape as AGENT_CHANGED/MOBILE_NATIVE_REQUIRED above.
// Hardcoded (not derived from resultVars) so these cases still assert real
// behavior before CHECK_MIGRATIONS_RESULT/APP_CHANGED exist in the summary.
const heavyResultVars = [
  'TYPECHECK_RESULT', 'TEST_API_RESULT', 'TEST_M365_GRAPH_READ_EXECUTOR_RESULT',
  'TEST_M365_GRAPH_ACTIONS_EXECUTOR_RESULT', 'TEST_M365_COMMUNICATIONS_EXECUTOR_RESULT',
  'TEST_WEB_RESULT', 'TEST_MOBILE_RESULT', 'MOBILE_NATIVE_CHANGES_RESULT',
  'TEST_PORTAL_RESULT', 'TEST_VIEWER_RESULT', 'TEST_OFFICE_ADDIN_CORE_RESULT',
  'TEST_EXCEL_ADDIN_RESULT', 'TEST_WORD_ADDIN_RESULT', 'TEST_POWERPOINT_ADDIN_RESULT',
  'TEST_OUTLOOK_ADDIN_RESULT', 'BUILD_API_RESULT', 'BUILD_M365_GRAPH_READ_EXECUTOR_RESULT',
  'BUILD_M365_GRAPH_ACTIONS_EXECUTOR_RESULT', 'BUILD_M365_COMMUNICATIONS_EXECUTOR_RESULT',
  'BUILD_WEB_RESULT', 'BUILD_PORTAL_RESULT', 'BUILD_AGENT_RESULT', 'TEST_AGENT_RESULT',
  'TEST_AGENT_WINDOWS_RESULT', 'WINDOWS_RUNTIME_SMOKE_RESULT', 'INTEGRATION_TEST_RESULT',
  'CHECK_MIGRATIONS_NONSUPERUSER_RESULT', 'RUST_CHECK_RESULT',
  'AUTH_BROWSER_TRANSITION_BROWSER_CONTRACT_RESULT',
];
const toolingOnlyPassing = {
  ...allOf('skipped'), // everything defaults to skipped for a tooling-only PR...
  ...Object.fromEntries(['LINT_RESULT', 'CHECK_MIGRATIONS_RESULT', 'SECURITY_AUDIT_RESULT'].map((v) => [v, 'success'])),
  CHANGES_RESULT: 'success',
  CODE_CHANGED: 'true',
  APP_CHANGED: 'false',
  AGENT_CHANGED: 'false',
  TOPOLOGY_BROWSER_CHANGED: 'false',
  DOCS_CHANGED: 'false',
  DOCS_CHECK_RESULT: 'skipped',
  MOBILE_NATIVE_REQUIRED: '',
  BUILD_MOBILE_IOS_RESULT: 'skipped',
};
const appPassing = { ...passing, APP_CHANGED: 'true' };

for (const [label, env, passes] of [
  ['tooling-only PR, every heavy job correctly skipped', { ...toolingOnlyPassing }, true],
  ['tooling-only PR, lint red', { ...toolingOnlyPassing, LINT_RESULT: 'failure' }, false],
  ['tooling-only PR, check-migrations red', { ...toolingOnlyPassing, CHECK_MIGRATIONS_RESULT: 'failure' }, false],
  ['tooling-only PR, security-audit red', { ...toolingOnlyPassing, SECURITY_AUDIT_RESULT: 'failure' }, false],
  ['app change, all heavy jobs green', { ...appPassing }, true],
  // check-migrations is NOT blocking for an application PR (unchanged policy: it
  // is one of ciSuccessGatingContract's KNOWN GAP jobs). It is blocking only on
  // the tooling-only path, where it is the sole validation of the release guards.
  ['app change, check-migrations red: not blocking for an application PR', { ...appPassing, CHECK_MIGRATIONS_RESULT: 'failure' }, true],
  ['tooling-only PR, a smoke job ran instead of skipping', { ...toolingOnlyPassing, SMOKE_TEST_RESULT: 'success' }, false],
  ['tooling-only PR, workspace-runtime ran instead of skipping', { ...toolingOnlyPassing, WORKSPACE_RUNTIME_RESULT: 'failure' }, false],
  ['APP_CHANGED empty', { ...appPassing, APP_CHANGED: '' }, false],
  ['APP_CHANGED not a boolean', { ...appPassing, APP_CHANGED: 'maybe' }, false],
]) {
  test(`CI Success (app-gate): ${label}`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...env },
    });
    assert.equal(execution.status, passes ? 0 : 1, execution.stdout + execution.stderr);
  });
}

// A tooling-only PR where a single heavy job unexpectedly ran (success) or
// failed must still fail closed — its `if:` should have skipped it.
for (const resultVar of ['TEST_WEB_RESULT', 'BUILD_AGENT_RESULT', 'INTEGRATION_TEST_RESULT']) {
  test(`CI Success (app-gate): tooling-only PR, ${resultVar} unexpectedly ran (success)`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...toolingOnlyPassing, [resultVar]: 'success' },
    });
    assert.equal(execution.status, 1, execution.stdout + execution.stderr);
  });
  test(`CI Success (app-gate): tooling-only PR, ${resultVar} red`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...toolingOnlyPassing, [resultVar]: 'failure' },
    });
    assert.equal(execution.status, 1, execution.stdout + execution.stderr);
  });
}

// app=true with one heavy job unexpectedly skipped must fail closed.
for (const resultVar of heavyResultVars) {
  test(`CI Success (app-gate): app change, ${resultVar} unexpectedly skipped`, () => {
    const execution = spawnSync('bash', ['-e', '-c', summaryScript], {
      encoding: 'utf8',
      env: { ...process.env, IS_PR: 'true', ...appPassing, [resultVar]: 'skipped' },
    });
    assert.equal(execution.status, 1, execution.stdout + execution.stderr);
  });
}

// ---- Independent review of #6178 (2026-09-17) --------------------------------
// Tooling files that a HEAVY (app-gated) job executes must never be fast-tracked,
// or editing them alone stops the only job that exercises them — in the PR run
// AND the merge-queue entry, which classifies identically.
for (const path of [
  // guided-setup-smoke copies and runs it (scripts/smoke-guided-setup.sh).
  'scripts/release/verify-release-images.sh',
  // mobile-native-changes' paths-filter lists it to trigger the native iOS build.
  '.github/scripts/mobile-native-ci.test.mjs',
  // its drift test (agent/cmd/breeze-backup/ci_gate_test.go) runs in test-agent.
  '.github/scripts/qemu-gate-paths.txt',
]) {
  test(`classifier: ${path} is executed by a heavy job, so it is an app change`, () => {
    const r = classify([path]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^app=true$/m);
  });
}

test('every explicit app=true carve-out in the classifier is still referenced by something heavy', () => {
  // A carve-out that no longer corresponds to a real consumer is dead weight; one that
  // is missing is a silent skip. Pin the known set so both directions are a conscious edit.
  const script = readFileSync(new URL('./classify-pr-paths.sh', import.meta.url), 'utf8');
  for (const carved of [
    '.github/workflows/ci.yml',
    '.github/scripts/classify-pr-paths.sh',
    '.github/scripts/prepare-ci-apt-sources.mjs',
    '.github/scripts/mobile-native-ci.test.mjs',
    '.github/scripts/qemu-gate-paths.txt',
    'scripts/security/check-agent-binary-signatures.sh',
    'scripts/release/verify-release-images.sh',
  ]) {
    assert.ok(script.includes(`    ${carved}) app=true ;;`), `missing carve-out for ${carved}`);
  }
  const smoke = readFileSync(new URL('../../scripts/smoke-guided-setup.sh', import.meta.url), 'utf8');
  assert.ok(smoke.includes('scripts/release/verify-release-images.sh'));
});

test('the tooling-only path still validates workflow files: lint runs the workflow-security suite', () => {
  // Other workflow files are fast-tracked (app=false). The only blocking validation of
  // them must therefore live in a job that runs on `code` alone. security.yml also runs
  // this suite, but it does not report `CI Success`, so it cannot block a merge.
  const lint = job('lint');
  assert.match(lint, /^    if: needs\.changes\.outputs\.code == 'true'$/m);
  assert.match(lint, /run: pnpm test:workflow-security$/m);
});

// ---- QEMU gate narrowed to the backup/recovery dependency set --------------
// The Recovery media E2E job builds exactly two Go commands (breeze-backup and
// breeze-recovery-fakeserver) and the recovery-media/ scripts. Only the
// packages those commands import can change its outcome. The set is pinned in
// qemu-gate-paths.txt (the classifier runs in a sparse checkout with no Go
// toolchain, so it cannot compute it) and agent/cmd/breeze-backup/ci_gate_test.go
// recomputes it with `go list -deps` and fails when the pinned file drifts.
const qemuGatePaths = readFileSync(new URL('./qemu-gate-paths.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('qemu gate list: non-empty, repo-relative agent paths, directories end with /', () => {
  assert.ok(qemuGatePaths.length >= 10, 'suspiciously short gate list');
  for (const p of qemuGatePaths) {
    assert.match(p, /^agent\/[A-Za-z0-9_./-]+$/, p);
    assert.ok(!p.includes('..'), p);
  }
  for (const must of ['agent/cmd/breeze-backup/', 'agent/cmd/breeze-recovery-fakeserver/', 'agent/internal/backup/', 'agent/internal/recoveryconsole/', 'agent/recovery-media/', 'agent/go.mod', 'agent/go.sum']) {
    assert.ok(qemuGatePaths.includes(must), `gate list must contain ${must}`);
  }
});

test('classifier: agent output follows the pinned QEMU dependency set, not all of agent/', () => {
  for (const [paths, expected] of [
    [['agent/internal/backup/client.go'], 'agent=true'],
    [['agent/cmd/breeze-backup/main.go'], 'agent=true'],
    [['agent/internal/recoveryconsole/console.go'], 'agent=true'],
    [['agent/recovery-media/build.sh'], 'agent=true'],
    [['agent/recovery-media/e2e/run-qemu.sh'], 'agent=true'],
    [['agent/go.sum'], 'agent=true'],
    [['agent/go.mod'], 'agent=true'],
    // Nested under a gated directory still counts.
    [['agent/internal/backup/sub/deep.go'], 'agent=true'],
    // Agent code the recovery media never links: SNMP, heartbeat, remote desktop, PAM.
    [['agent/internal/snmppoll/poller.go'], 'agent=false'],
    [['agent/internal/heartbeat/heartbeat.go'], 'agent=false'],
    [['agent/internal/remote/session.go'], 'agent=false'],
    [['agent/cmd/breeze-agent/main.go'], 'agent=false'],
    [['agent/Makefile'], 'agent=false'],
    // A prefix that merely LOOKS like a gated dir must not match.
    [['agent/internal/backupipc-extra/x.go'], 'agent=false'],
    [['agent/internal/backup2/x.go'], 'agent=false'],
    // The list itself is CI plumbing for this gate.
    [['.github/scripts/qemu-gate-paths.txt'], 'agent=true'],
  ]) {
    const r = classify(paths);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${expected}$`, 'm'), `${paths.join(',')} → ${r.stdout}`);
  }
});

test('classifier: a missing or empty QEMU gate list fails closed to agent=true', () => {
  const script = readFileSync(new URL('./classify-pr-paths.sh', import.meta.url), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'qemu-gate-'));
  const copy = join(dir, 'classify-pr-paths.sh');
  writeFileSync(copy, script);
  // Without the list, ANY agent/ path must run the job — including one that the
  // pinned list would have excluded. A non-agent path is still agent=false: it
  // never could have affected the job, list or no list.
  const snmp = spawnSync('bash', [copy], { encoding: 'utf8', input: 'agent/internal/snmppoll/poller.go\n' });
  assert.equal(snmp.status, 0, snmp.stderr);
  assert.match(snmp.stdout, /^agent=true$/m, 'no gate list: every agent/ change must run the job');
  assert.match(snmp.stderr, /qemu-gate-paths/);
  const web = spawnSync('bash', [copy], { encoding: 'utf8', input: 'apps/web/src/x.ts\n' });
  assert.match(web.stdout, /^agent=false$/m);
  // An empty list (comments only) is the same as a missing one.
  writeFileSync(join(dir, 'qemu-gate-paths.txt'), '# nothing pinned\n');
  const empty = spawnSync('bash', [copy], { encoding: 'utf8', input: 'agent/internal/snmppoll/poller.go\n' });
  assert.match(empty.stdout, /^agent=true$/m, 'empty gate list must fail closed');
});

test('docs-check runs the customer-PII guard: it scans docs, so a docs-only PR must not bypass it', () => {
  // 2026-09-18: #6187 (docs-only) landed example addresses that
  // scripts/security/check-customer-pii.sh rejects. The guard ran only in
  // security-audit, which a docs-only PR skips, so main went red for every code
  // PR that followed. Every job that a docs-only PR skips must not be the sole
  // home of a check whose inputs are docs.
  const docsCheck = job('docs-check');
  assert.match(docsCheck, /run: bash scripts\/security\/check-customer-pii\.sh$/m);
  // It must run BEFORE the expensive astro check/build so a hit fails fast.
  assert.ok(docsCheck.indexOf('check-customer-pii.sh') < docsCheck.indexOf('pnpm --filter @breeze/docs check'));
});

