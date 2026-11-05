// W02b (#10746): the gate's verdict core. Base revision decides, API results are
// the evidence, and nothing from the candidate tree is ever executed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as gate from './ci-gate.mjs';

const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const realCi = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

const temps = [];
after(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'ci-gate-test-')); temps.push(dir); return dir; };

// A real repository: base and head commits, head checked out in the working tree.
function repo(baseFiles, headFiles) {
  const cwd = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci-gate@test.invalid');
  git('config', 'user.name', 'ci-gate test');
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      if (text === null) rmSync(join(cwd, path), { force: true }); else writeFileSync(join(cwd, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const base = commit(baseFiles, 'base');
  const head = commit(headFiles, 'head');
  return { cwd, base, head, io: gate.createGateIO({ cwd, env: { PATH: process.env.PATH } }) };
}

const SCRIPTS = '.github/scripts';
const flagLines = over => {
  const flags = { code: 'true', docs: 'false', agent: 'false', app: 'true', api: 'false', web: 'false', portal: 'false',
    addins: 'false', m365: 'false', rust: 'false', topology_browser: 'false', agent_code: 'false', integration: 'true',
    path_readers: 'false', reader_tests: '', ...over };
  return Object.entries(flags).map(([key, value]) => `${key}=${value}`).join('\n');
};
const fakeClassifier = (over, extra = '') => `#!/usr/bin/env bash\n${extra}\ncat > /dev/null\ncat <<'EOF'\n${flagLines(over)}\nEOF\n`;

// ── B1: base flags ───────────────────────────────────────────────────────

test('baseFlags: the base classifier decides, even when the head edits it', () => {
  const { io, base, head, cwd } = repo(
    { [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({ rust: 'false' }) },
    { [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({ rust: 'true' }), 'apps/helper/x.rs': 'x' },
  );
  // Prove the working tree really holds the head's edited copy.
  assert.match(readFileSync(join(cwd, SCRIPTS, 'classify-pr-paths.sh'), 'utf8'), /rust=true/);
  const out = gate.baseFlags(io, base, head);
  assert.equal(out.flags.rust, 'false');
  assert.deepEqual(out.changed, [`${SCRIPTS}/classify-pr-paths.sh`, 'apps/helper/x.rs']);
});

test('baseFlags: runs a temp copy of the classifier and its three sidecars, all from the base', () => {
  const sidecars = ['qemu-gate-paths.txt', 'integration-floor-paths.txt', 'path-reader-map.txt'];
  const reader = `here="$(dirname "\${BASH_SOURCE[0]}")"\nfor f in ${sidecars.join(' ')}; do grep -q BASE "\${here}/$f" || exit 9; done\ncase "\${here}" in *.github/scripts*) exit 8 ;; esac`;
  const baseFiles = { [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({}, reader) };
  const headFiles = { 'a.txt': 'x' };
  for (const name of sidecars) { baseFiles[`${SCRIPTS}/${name}`] = 'BASE\n'; headFiles[`${SCRIPTS}/${name}`] = 'HEAD\n'; }
  const { io, base, head } = repo(baseFiles, headFiles);
  // A classifier exit would surface as the full-suite flags (api=true); the
  // fake reports api=false only when every sidecar read came from the base copy.
  assert.equal(gate.baseFlags(io, base, head).flags.api, 'false');
});

test('baseFlags: never passes --pull-request, and diffs --no-renames base...head', () => {
  const argv = 'if [[ $# -ne 0 ]]; then exit 7; fi';
  const { io, base, head } = repo(
    { [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({}, argv), 'old-name.txt': 'content\n'.repeat(50) },
    { 'old-name.txt': null, 'new-name.txt': 'content\n'.repeat(50) },
  );
  const out = gate.baseFlags(io, base, head);
  assert.equal(out.flags.api, 'false', 'an argument would have failed the fake and given full-suite flags');
  // A rename shows both paths, so moving a file out of an area still runs that area.
  assert.deepEqual(out.changed.sort(), ['new-name.txt', 'old-name.txt']);
});

test('baseFlags: a classifier failure or no classifier gives the changes job\'s full_suite flags', () => {
  for (const baseFiles of [
    { [`${SCRIPTS}/classify-pr-paths.sh`]: '#!/usr/bin/env bash\nexit 3\n' },
    { [`${SCRIPTS}/classify-pr-paths.sh`]: '#!/usr/bin/env bash\necho not-a-flag\n' },
    { 'unrelated.txt': 'no classifier at this base' },
  ]) {
    const { io, base, head } = repo(baseFiles, { 'a.txt': 'x' });
    assert.deepEqual(gate.baseFlags(io, base, head).flags, gate.FULL_SUITE_FLAGS);
  }
});

test('FULL_SUITE_FLAGS is exactly what the changes job prints in full_suite', () => {
  const printf = realCi.match(/full_suite\(\) \{\n\s+echo "\$1" >&2\n\s+printf '([^']+)'/)?.[1];
  assert.ok(printf, 'full_suite printf not found in ci.yml');
  const real = Object.fromEntries(printf.split('\\n').filter(Boolean).map(line => line.split('=')));
  assert.deepEqual(gate.FULL_SUITE_FLAGS, real);
});

test('baseFlags: policyPaths lists exactly the changed policy paths', () => {
  const { io, base, head } = repo(
    { [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({}) },
    { [`${SCRIPTS}/new.mjs`]: 'x', '.github/workflows/foo.yml': 'x', 'apps/web/a.ts': 'x', 'docs/a.md': 'x',
      'e2e-tests/playwright.topology-worker.config.ts': 'x' },
  );
  assert.deepEqual(gate.baseFlags(io, base, head).policyPaths.sort(), [
    `${SCRIPTS}/new.mjs`, '.github/workflows/foo.yml', 'e2e-tests/playwright.topology-worker.config.ts'].sort());
});

test('baseFlags: a quoted (non-ASCII) policy path is still listed', () => {
  const name = `${SCRIPTS}/café.mjs`;
  const { io, base, head } = repo({ [`${SCRIPTS}/classify-pr-paths.sh`]: fakeClassifier({}) }, { [name]: 'x' });
  const { changed, policyPaths } = gate.baseFlags(io, base, head);
  assert.match(changed[0], /^"/, 'git quotes this path; the classifier sees it as the changes job does');
  assert.equal(policyPaths.length, 1);
});

test('baseFlags: an unreadable revision is base_unreadable, not a flag set', () => {
  const { io, base } = repo({ 'a.txt': 'x' }, { 'b.txt': 'x' });
  assert.throws(() => gate.baseFlags(io, base, 'f'.repeat(40)), err => err.code === 'base_unreadable');
  assert.throws(() => gate.baseFlags(io, 'not-a-sha', base), err => err.code === 'base_unreadable');
});

// ── B1: base aggregator ──────────────────────────────────────────────────

const aggregatorYml = (env, script = 'echo ok', needs = 'changes, lint') => `name: CI\njobs:
  changes:
    runs-on: ubuntu-latest
  lint:
    runs-on: ubuntu-latest
  ci-success:
    name: CI Success
    needs: [${needs}]
    steps:
      - name: Check all jobs passed
        env:
${env.map(line => `          ${line}`).join('\n')}
        run: |
${script.split('\n').map(line => `          ${line}`).join('\n')}

  next-job:
    runs-on: ubuntu-latest
`;

test('extractAggregator on the real ci.yml: needs, env kinds and script start', () => {
  const { env, needs, script } = gate.extractAggregator(realCi);
  const declared = realCi.match(/^  ci-success:\n(?:.*\n)*?    needs: \[([^\]]+)\]/m)[1].split(',').map(s => s.trim());
  assert.deepEqual(needs, declared);
  assert.ok(needs.length > 35, 'needs parser is stale');
  const kinds = new Set(Object.values(env).map(value => value.kind));
  assert.deepEqual([...kinds].sort(), ['changes', 'is_pr', 'output', 'result']);
  assert.deepEqual(env.TEST_API_RESULT, { kind: 'result', job: 'test-api' });
  assert.deepEqual(env.RUST_CHANGED, { kind: 'changes', key: 'rust' });
  assert.deepEqual(env.MOBILE_NATIVE_REQUIRED, { kind: 'output', job: 'mobile-native-changes', key: 'mobile' });
  assert.deepEqual(env.IS_PR, { kind: 'is_pr' });
  assert.match(script, /^STACK_CHANGED=false\n/);
  assert.match(script, /echo "All required jobs passed!"$/);
});

test('extractAggregator stops at the end of the run block', () => {
  const { script, env, needs } = gate.extractAggregator(aggregatorYml(['LINT_RESULT: ${{ needs.lint.result }}'], '# a comment\necho one\n  echo two'));
  assert.equal(script, 'echo one\n  echo two');
  assert.deepEqual(needs, ['changes', 'lint']);
  assert.deepEqual(Object.keys(env), ['LINT_RESULT']);
});

test('extractAggregator rejects anything it cannot map, as aggregator_unparseable', () => {
  const unparseable = text => assert.throws(() => gate.extractAggregator(text), err => err.code === 'aggregator_unparseable', text.slice(0, 80));
  for (const line of ['X: ${{ needs.lint.result || \'success\' }}', 'X: success', 'X: ${{ github.sha }}',
    'X: ${{ needs.lint.outputs }}', 'X: ${{ needs.other.result }}', 'X: ${{ needs.other.outputs.key }}',
    'X: ${{ needs.lint.result }} # comment', '# comment']) {
    unparseable(aggregatorYml([line]));
  }
  unparseable(aggregatorYml(['LINT_RESULT: ${{ needs.lint.result }}'], 'echo "${{ github.sha }}"'));
  unparseable('name: CI\njobs:\n  lint:\n    runs-on: x\n');
  unparseable(realCi.replace('- name: Check all jobs passed', '- name: Renamed step'));
  unparseable(realCi.replace(/^(    needs: )\[path-read-contracts, /m, '$1\n      [path-read-contracts, '));
});

const probeAggregator = script => ({ needs: ['lint', 'mobile'], script, env: {
  LINT_RESULT: { kind: 'result', job: 'lint' }, RUST_CHANGED: { kind: 'changes', key: 'rust' },
  MOBILE_REQUIRED: { kind: 'output', job: 'mobile', key: 'mobile' }, IS_PR: { kind: 'is_pr' } } });
const probeValues = { results: { lint: 'success' }, flags: { rust: 'false' }, outputs: { 'mobile.mobile': 'true' }, isPr: false };

test('runAggregator: the child sees PATH and the mapped values only, never GH_TOKEN', () => {
  const io = gate.createGateIO({ cwd: tempDir(), env: { PATH: process.env.PATH, GH_TOKEN: 'sekret', OTHER: 'x', GITHUB_TOKEN: 'sekret' } });
  const { passed, stdout } = gate.runAggregator(io, probeAggregator('env'), probeValues);
  assert.equal(passed, true);
  assert.doesNotMatch(stdout, /sekret/);
  // bash adds its own bookkeeping variables to its children.
  const names = stdout.trim().split('\n').map(line => line.split('=')[0]).filter(name => !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(name));
  assert.deepEqual(names.sort(), ['IS_PR', 'LINT_RESULT', 'MOBILE_REQUIRED', 'PATH', 'RUST_CHANGED']);
  assert.match(stdout, /^LINT_RESULT=success$/m);
  assert.match(stdout, /^RUST_CHANGED=false$/m);
  assert.match(stdout, /^MOBILE_REQUIRED=true$/m);
  assert.match(stdout, /^IS_PR=false$/m);
});

test('runAggregator: the exit code is the verdict; bash -e semantics match a default run: step', () => {
  const io = gate.createGateIO({ cwd: tempDir(), env: { PATH: process.env.PATH } });
  assert.deepEqual(gate.runAggregator(io, probeAggregator('echo nope\nexit 1'), probeValues), { passed: false, stdout: 'nope\n' });
  assert.equal(gate.runAggregator(io, probeAggregator('false\necho unreachable'), probeValues).passed, false);
  assert.equal(gate.runAggregator(io, probeAggregator('[[ "${IS_PR}" == "true" ]]'), { ...probeValues, isPr: true }).passed, true);
});

test('runAggregator: an unmapped value is empty, which the script fails closed on', () => {
  const io = gate.createGateIO({ cwd: tempDir(), env: { PATH: process.env.PATH } });
  const script = '[[ "${LINT_RESULT}" == "" ]] && [[ "${RUST_CHANGED}" == "" ]] && [[ "${MOBILE_REQUIRED}" == "" ]]';
  assert.equal(gate.runAggregator(io, probeAggregator(script), { results: {}, flags: {}, outputs: {}, isPr: false }).passed, true);
});

// ── B2: job instances and rollup ─────────────────────────────────────────

const api = (...pairs) => pairs.map(([name, conclusion]) => ({ name, conclusion, status: 'completed' }));
const shards = (template, count, conclusion = 'success') =>
  Array.from({ length: count }, (_, i) => [template.replace('${{ matrix.shard }}', String(i + 1)), conclusion]);
const TEST_WEB = 'Test Web (shard ${{ matrix.shard }}/4)';
const rollup = (job, jobs, event = 'merge_group', ci = realCi) => gate.rollup(job, api(...jobs), ci, { event });

test('jobInstances: all five matrices in ci.yml parse, by name and count derived from the file', () => {
  const matrixJobs = Object.entries(gate.workflowJobsOf(realCi)).filter(([, job]) => /^      matrix:$/m.test(job.body)).map(([id]) => id);
  assert.deepEqual(matrixJobs.sort(), ['build-agent', 'build-smoke-images', 'integration-test', 'test-api', 'test-web']);
  const counts = { 'test-api': 8, 'test-web': 4, 'integration-test': 16 };
  for (const id of matrixJobs) {
    const { template, expected } = gate.jobInstances(realCi, id);
    assert.match(template, /\$\{\{ matrix\.\w+ \}\}/, id);
    assert.equal(new Set(expected).size, expected.length, `${id}: expanded names are unique`);
    for (const name of expected) assert.doesNotMatch(name, /\$\{\{/, `${id}: ${name}`);
    if (counts[id]) assert.equal(expected.length, counts[id], id);
  }
  // The include matrices: one expansion per include entry, counted from the file.
  const includes = id => (gate.workflowJobsOf(realCi)[id].body.split(/^      matrix:$/m)[1].match(/^ {10}- /gm) ?? []).length;
  assert.equal(gate.jobInstances(realCi, 'build-agent').expected.length, includes('build-agent'));
  assert.equal(gate.jobInstances(realCi, 'build-smoke-images').expected.length, includes('build-smoke-images'));
  assert.ok(gate.jobInstances(realCi, 'build-smoke-images').expected.includes('Build Smoke Image (web)'));
  assert.ok(gate.jobInstances(realCi, 'test-api').expected.includes('Test API (shard 8/8)'));
});

test('jobInstances: a plain job is its display name, or its id without one; an absent id is null', () => {
  assert.deepEqual(gate.jobInstances(realCi, 'lint'), { template: 'Lint', expected: ['Lint'] });
  assert.deepEqual(gate.jobInstances('name: CI\njobs:\n  bare-job:\n    runs-on: x\n', 'bare-job'), { template: 'bare-job', expected: ['bare-job'] });
  assert.equal(gate.jobInstances(realCi, 'no-such-job'), null);
});

test('jobInstances: an unsupported name or matrix shape fails closed as head_unparseable', () => {
  const bad = [
    'jobs:\n  j:\n    name: J ${{ env.X }}\n',
    'jobs:\n  j:\n    name: J (${{ matrix.n }})\n',
    'jobs:\n  j:\n    name: J\n    strategy:\n      matrix:\n        n: [1, 2]\n',
    'jobs:\n  j:\n    name: J (${{ matrix.n }})\n    strategy:\n      matrix:\n        n: ${{ fromJSON(needs.x.outputs.list) }}\n',
    'jobs:\n  j:\n    name: J (${{ matrix.n }})\n    strategy:\n      matrix:\n        n: [1, 2]\n        m: [3, 4]\n',
    'jobs:\n  j:\n    name: J (${{ matrix.n }})\n    strategy:\n      matrix:\n        n: [1, 2]\n        exclude:\n          - n: 1\n',
    'jobs:\n  j:\n    name: J (${{ matrix.n }})\n    strategy:\n      matrix:\n        n: []\n',
    'jobs:\n  j:\n    name: J (${{ matrix.other }})\n    strategy:\n      matrix:\n        include:\n          - n: 1\n',
  ];
  for (const ci of bad) assert.throws(() => gate.jobInstances(`name: CI\n${ci}`, 'j'), err => err.code === 'head_unparseable', ci);
});

test('rollup: a matrix all green with the full count is success', () => {
  assert.equal(rollup('test-web', shards(TEST_WEB, 4)), 'success');
});

test('rollup: one failed shard is failure, one cancelled shard is cancelled, one absent shard is failure', () => {
  const four = shards(TEST_WEB, 4);
  assert.equal(rollup('test-web', [...four.slice(0, 3), [four[3][0], 'failure']]), 'failure');
  assert.equal(rollup('test-web', [...four.slice(0, 3), [four[3][0], 'cancelled']]), 'cancelled');
  assert.equal(rollup('test-web', [[four[0][0], 'failure'], ...four.slice(1, 3), [four[3][0], 'cancelled']]), 'failure');
  assert.equal(rollup('test-web', four.slice(0, 3)), 'failure');
  assert.equal(rollup('test-web', [...four.slice(0, 3), [four[3][0], 'timed_out']]), 'failure');
  assert.equal(rollup('test-web', [...four.slice(0, 3), [four[3][0], null]]), 'failure');
});

test('rollup: a lone literal template is skipped only when skipped; never evidence that shards passed', () => {
  assert.equal(rollup('test-web', [[TEST_WEB, 'skipped']]), 'skipped');
  assert.equal(rollup('test-web', [[TEST_WEB, 'success']]), 'failure');
  assert.equal(rollup('test-web', [[TEST_WEB, 'failure']]), 'failure');
  assert.equal(rollup('test-web', [[TEST_WEB, 'skipped'], ...shards(TEST_WEB, 4)]), 'failure');
  assert.equal(rollup('build-agent', [['Build Agent (${{ matrix.goos }}/${{ matrix.goarch }})', 'skipped']]), 'skipped');
});

test('rollup: mixed success and skipped shards are failure; a plain job keeps its conclusion', () => {
  const four = shards(TEST_WEB, 4);
  assert.equal(rollup('test-web', [...four.slice(0, 3), [four[3][0], 'skipped']]), 'failure');
  assert.equal(rollup('test-web', shards(TEST_WEB, 4, 'skipped')), 'skipped');
  for (const conclusion of ['success', 'failure', 'cancelled', 'skipped']) assert.equal(rollup('lint', [['Lint', conclusion]]), conclusion);
  assert.equal(rollup('lint', [['Lint', 'neutral']]), 'failure');
});

test('rollup: a job id removed from the head is missing; a display-name change alone still rolls up', () => {
  const deleted = realCi.replace(/^  test-shared:\n/m, '  test-shared-renamed:\n');
  assert.notEqual(deleted, realCi);
  assert.equal(rollup('test-shared', [['Test Shared', 'success']], 'merge_group', deleted), 'missing');
  assert.equal(rollup('test-shared', [], 'merge_group'), 'missing');
  const renamed = realCi.replace(/^(  test-shared:\n    name: )Test Shared$/m, '$1Shared package tests');
  assert.notEqual(renamed, realCi);
  assert.equal(rollup('test-shared', [['Shared package tests', 'success']], 'merge_group', renamed), 'success');
  assert.equal(rollup('test-shared', [['Test Shared', 'success']], 'merge_group', renamed), 'missing');
});

test('rollup: two ids sharing one display name is duplicate_job_name', () => {
  const dup = realCi.replace(/^(  test-shared:\n    name: )Test Shared$/m, '$1Test Viewer');
  assert.notEqual(dup, realCi);
  assert.throws(() => rollup('test-shared', [['Test Viewer', 'success']], 'merge_group', dup), err => err.code === 'duplicate_job_name');
  assert.throws(() => rollup('test-viewer', [['Test Viewer', 'success']], 'merge_group', dup), err => err.code === 'duplicate_job_name');
  // The same name twice in the API's job list is ambiguous too.
  assert.throws(() => rollup('lint', [['Lint', 'success'], ['Lint', 'failure']]), err => err.code === 'duplicate_job_name');
});

test('rollup: no display name in the real ci.yml is shared by two jobs', () => {
  const names = Object.keys(gate.workflowJobsOf(realCi)).flatMap(id => gate.jobInstances(realCi, id).expected);
  assert.deepEqual(names.filter((name, i) => names.indexOf(name) !== i), []);
});

test('rollup: continue-on-error is only ever the PR expression on a ci-success.needs job', () => {
  const { needs } = gate.extractAggregator(realCi);
  const jobs = gate.workflowJobsOf(realCi);
  for (const id of needs) {
    const value = jobs[id].body.match(/^    continue-on-error: (.*)$/m)?.[1];
    assert.ok(value === undefined || value === "${{ github.event_name == 'pull_request' }}", `${id}: ${value}`);
  }
  // On pull_request a failure under that expression is what needs.X.result reports: success.
  const smoke = [['Smoke Test', 'failure']];
  assert.equal(rollup('smoke-test', smoke, 'pull_request'), 'success');
  assert.equal(rollup('smoke-test', smoke, 'merge_group'), 'failure');
  assert.equal(rollup('lint', [['Lint', 'failure']], 'pull_request'), 'failure');
  // Anything else on a needs job throws: its needs.X.result would not match the API conclusion.
  for (const value of ['true', "${{ github.event_name != 'merge_group' }}"]) {
    const edited = realCi.replace(/^(  lint:\n    name: Lint\n)/m, `$1    continue-on-error: ${value}\n`);
    assert.notEqual(edited, realCi);
    assert.throws(() => rollup('lint', [['Lint', 'failure']], 'merge_group', edited), err => err.code === 'continue_on_error_unsupported');
  }
});

// ── B2: MOBILE_NATIVE_REQUIRED, derived from the base filter and closure ─

const lockfile = (apiVersion, mobileVersion) => `lockfileVersion: '9.0'

importers:

  apps/api:
    dependencies:
      hono:
        specifier: ^4.13.0
        version: ${apiVersion}

  apps/mobile:
    dependencies:
      react:
        specifier: ^19.1.0
        version: ${mobileVersion}

packages:

  hono@4.13.5:
    resolution: {integrity: sha512-a}
  hono@4.13.6:
    resolution: {integrity: sha512-b}
  react@19.1.0:
    resolution: {integrity: sha512-c}
  react@19.1.1:
    resolution: {integrity: sha512-d}

snapshots:

  hono@4.13.5: {}
  hono@4.13.6: {}
  react@19.1.0: {}
  react@19.1.1: {}
`;
const closureScript = readFileSync(join(REPO_ROOT, '.github/scripts/mobile-lockfile-closure.mjs'), 'utf8');
const mobileRepo = (head, base = {}) => repo({
  '.github/workflows/ci.yml': realCi, '.github/scripts/mobile-lockfile-closure.mjs': closureScript,
  'pnpm-lock.yaml': lockfile('4.13.5', '19.1.0'), ...base }, head);
const derive = (head, base) => {
  const r = mobileRepo(head, base);
  return gate.deriveMobileRequired(r.io, r.base, r.head, gate.baseFlags(r.io, r.base, r.head).changed);
};

test('deriveMobileRequired: mobile paths and ci.yml are native inputs; packages/shared is not', () => {
  assert.equal(derive({ 'apps/mobile/x.ts': 'x' }), 'true');
  assert.equal(derive({ '.github/workflows/ci.yml': `${realCi}\n# edit\n` }), 'true');
  assert.equal(derive({ 'patches/a.patch': 'x' }), 'true');
  assert.equal(derive({ 'packages/shared/x.ts': 'x' }), 'false');
  assert.equal(derive({ 'apps/mobile-other/x.ts': 'x' }), 'false');
});

test('deriveMobileRequired: a lockfile change counts only when the mobile closure changed', () => {
  assert.equal(derive({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.0') }), 'false');
  assert.equal(derive({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.1') }), 'true');
  assert.equal(derive({ 'package.json': '{}' }), 'false', 'root package.json with an identical lockfile');
});

test('deriveMobileRequired: the closure script and the filter come from the base', () => {
  const lying = '#!/usr/bin/env node\nconsole.log("changed=false");\n';
  // Editing the closure script is itself a native input, whatever the edit says.
  assert.equal(derive({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.1'), '.github/scripts/mobile-lockfile-closure.mjs': lying }), 'true');
  // The base's (lying) script decides, not the truthful copy in the working tree.
  const r = mobileRepo({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.1') }, { '.github/scripts/mobile-lockfile-closure.mjs': lying });
  writeFileSync(join(r.cwd, '.github/scripts/mobile-lockfile-closure.mjs'), closureScript);
  assert.equal(gate.deriveMobileRequired(r.io, r.base, r.head, gate.baseFlags(r.io, r.base, r.head).changed), 'false');
  // A head that drops apps/mobile/** from its own filter does not narrow the base's.
  const narrowed = realCi.replace("              - 'apps/mobile/**'\n", '');
  assert.notEqual(narrowed, realCi);
  assert.equal(derive({ 'apps/mobile/x.ts': 'x', '.github/workflows/ci.yml': narrowed }), 'true');
  assert.equal(derive({ 'apps/mobile/x.ts': 'x' }, { '.github/workflows/ci.yml': narrowed }), 'false');
});

test('deriveMobileRequired: closure failure or an unparseable filter is true (fail closed)', () => {
  assert.equal(derive({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.0') }, { '.github/scripts/mobile-lockfile-closure.mjs': 'process.exit(2)\n' }), 'true');
  assert.equal(derive({ 'pnpm-lock.yaml': lockfile('4.13.6', '19.1.0') }, { '.github/scripts/mobile-lockfile-closure.mjs': null }), 'true');
  assert.equal(derive({ 'pnpm-lock.yaml': null }), 'true');
  for (const edit of [
    ci => ci.replace("              - 'apps/mobile/**'", "              - 'apps/{mobile,other}/**'"),
    ci => ci.replace("              - 'apps/mobile/**'", '              - apps/mobile/**'),
    ci => ci.replace('            lockfile:\n', '            lockfiles:\n'),
    ci => ci.replace("steps.lockfile.outputs.changed == 'true' }}", "steps.lockfile.outputs.changed == 'true' || steps.other.outputs.x == 'true' }}"),
  ]) {
    const baseCi = edit(realCi);
    assert.notEqual(baseCi, realCi);
    assert.equal(derive({ 'packages/shared/x.ts': 'x' }, { '.github/workflows/ci.yml': baseCi }), 'true');
  }
});
