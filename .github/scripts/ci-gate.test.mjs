// W02b (#10746): the gate's verdict core. Base revision decides, API results are
// the evidence, and nothing from the candidate tree is ever executed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as gate from './ci-gate.mjs';
import { evaluateIf, policyDigest } from './queue-selection.mjs';
import * as queueSelection from './queue-selection.mjs';

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
  assert.deepEqual(policyPaths, [name]);
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
    'X: ${{ needs.lint.outputs }}', 'X: ${{ needs.lint.outputs.key }}', 'X: ${{ needs.other.result }}', 'X: ${{ needs.other.outputs.key }}',
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
  // Counts come from the file: an inline list's length, or one per include entry.
  const matrixBlock = id => gate.workflowJobsOf(realCi)[id].body.split(/^      matrix:$/m)[1];
  const count = id => {
    const inline = matrixBlock(id).match(/^ {8}\w+: \[([^\]]*)\]$/m);
    return inline ? inline[1].split(',').length : (matrixBlock(id).match(/^ {10}- /gm) ?? []).length;
  };
  for (const id of matrixJobs) {
    const { template, expected } = gate.jobInstances(realCi, id);
    assert.match(template, /\$\{\{ matrix\.\w+ \}\}/, id);
    assert.ok(count(id) > 1, `${id}: matrix count parsed from the file`);
    assert.equal(expected.length, count(id), id);
    assert.equal(new Set(expected).size, expected.length, `${id}: expanded names are unique`);
    for (const name of expected) assert.doesNotMatch(name, /\$\{\{/, `${id}: ${name}`);
  }
  // Spot-check the expansion itself against a shard name the API reports.
  const shards = gate.jobInstances(realCi, 'test-api').expected;
  assert.equal(shards.at(-1), `Test API (shard ${shards.length}/${shards.length})`);
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

// ── B3: verdict over fixtures recorded from real queue runs ──────────────

const FIXTURE_DIR = join(REPO_ROOT, '.github/scripts/fixtures/ci-gate');
const fixtureNames = readdirSync(FIXTURE_DIR).filter(name => name.endsWith('.json')).sort();
const fixtures = Object.fromEntries(fixtureNames.map(name => [name.replace(/\.json$/, ''), JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))]));
const snapshot = name => readFileSync(join(FIXTURE_DIR, name), 'utf8');
// The test-only edits a fixture may ask for on its head ci.yml.
const applyHeadEdit = (ci, edit) => {
  if (!edit) return ci;
  const [from, to] = edit.rename_job;
  const out = ci.replace(new RegExp(`^  ${from}:$`, 'm'), `  ${to}:`);
  assert.notEqual(out, ci, `head edit ${from} did not apply`);
  return out;
};
const contextOf = (f, over = {}) => ({
  flags: f.flags, mobile: f.mobile, event: 'merge_group',
  aggregator: gate.extractAggregator(snapshot(f.base_ci)), headCi: applyHeadEdit(snapshot(f.head_ci), f.head_ci_edit), ...over });
const judgeIo = gate.createGateIO({ cwd: REPO_ROOT, env: { PATH: process.env.PATH } });
const judge = (f, jobs = f.jobs, over = {}) => gate.judge(judgeIo, contextOf(f, over), jobs);
const setJobs = (jobs, pattern, conclusion) => jobs.map(job => pattern.test(job.name) ? { ...job, conclusion } : job);

test('fixtures: the directory holds exactly the eight recorded and derived shapes', () => {
  assert.deepEqual(Object.keys(fixtures).sort(), ['classifier-narrowing', 'docs-only', 'doctored-classifier', 'doctored-needs',
    'failed-shard', 'path-gated-rust-false', 'required-job-deleted', 'tooling-only']);
  for (const [name, f] of Object.entries(fixtures)) {
    for (const key of ['changed', 'flags', 'mobile', 'jobs', 'ci_success', 'base_ci', 'head_ci', 'source', 'expect']) assert.ok(key in f, `${name}.${key}`);
    assert.ok(Number.isSafeInteger(f.source.run_id), `${name}: recorded from a real run`);
    // A recorded fixture's expectation is what CI Success said; a derived one says how it was derived.
    if (!f.source.derived) assert.equal(f.expect.verdict, f.ci_success === 'success' ? 'pass' : 'fail', name);
    else assert.ok(f.source.derived.length > 20, `${name}: describe the mutation`);
  }
});

test('fixtures: every snapshot is a lossless trim of a real ci.yml', () => {
  for (const f of Object.values(fixtures)) for (const name of [f.base_ci, f.head_ci]) assert.equal(gate.trimWorkflow(snapshot(name)), snapshot(name), name);
  // Trimming keeps everything the gate reads.
  const trimmed = gate.trimWorkflow(realCi);
  assert.ok(trimmed.length < realCi.length / 3);
  assert.deepEqual(gate.extractAggregator(trimmed), gate.extractAggregator(realCi));
  for (const id of Object.keys(gate.workflowJobsOf(realCi))) {
    assert.deepEqual(gate.jobInstances(trimmed, id), gate.jobInstances(realCi, id), id);
    const coe = ci => gate.workflowJobsOf(ci)[id].body.match(/^    continue-on-error: (.*)$/m)?.[1];
    assert.equal(coe(trimmed), coe(realCi), id);
  }
  assert.match(gate.workflowJobsOf(trimmed)['mobile-native-changes'].body, /filters: \|/);
});

test('fixtures: each verdict matches its expectation and names the job it blames', () => {
  for (const [name, f] of Object.entries(fixtures)) {
    const out = judge(f);
    assert.equal(out.verdict, f.expect.verdict, `${name}: ${out.reason}`);
    if (f.expect.reason) assert.match(out.reason, new RegExp(f.expect.reason), name);
  }
});

test('path-gated-rust-false: Rust Check skipped passes; the same entry with Rust Check success fails', () => {
  const f = fixtures['path-gated-rust-false'];
  assert.equal(f.flags.rust, 'false');
  assert.equal(f.jobs.find(job => job.name === 'Rust Check (Tauri apps)').conclusion, 'skipped');
  assert.equal(judge(f).verdict, 'pass');
  const ran = judge(f, setJobs(f.jobs, /^Rust Check \(Tauri apps\)$/, 'success'));
  assert.equal(ran.verdict, 'fail');
  assert.match(ran.reason, /rust-check/);
});

test('docs: docs=false with a successful Docs Check stays green, because that rule is not three-branch', () => {
  const f = fixtures['path-gated-rust-false'];
  assert.equal(f.flags.code, 'true');
  assert.equal(judge(f, setJobs(f.jobs, /^Docs Check$/, 'success'), { flags: { ...f.flags, docs: 'false' } }).verdict, 'pass');
  assert.equal(fixtures['docs-only'].flags.code, 'false');
});

test('classifier-narrowing: a classifier edit gets every area from the base and passes with all jobs run', () => {
  const f = fixtures['classifier-narrowing'];
  assert.ok(f.changed.includes('.github/scripts/classify-pr-paths.sh'));
  for (const area of ['api', 'web', 'portal', 'addins', 'm365', 'rust', 'agent_code']) assert.equal(f.flags[area], 'true', area);
});

test('verdict: end to end in a repository with the real classifier and ci.yml', () => {
  const files = { '.github/workflows/ci.yml': realCi, 'pnpm-lock.yaml': lockfile('4.13.5', '19.1.0'),
    '.github/scripts/mobile-lockfile-closure.mjs': closureScript };
  for (const name of ['classify-pr-paths.sh', 'qemu-gate-paths.txt', 'integration-floor-paths.txt', 'path-reader-map.txt']) {
    files[`.github/scripts/${name}`] = readFileSync(join(REPO_ROOT, '.github/scripts', name), 'utf8');
  }
  const r = repo(files, { 'docs/guide.md': '# x\n' });
  // Every needs job skipped under its literal name, except the two a docs-only entry runs.
  const { needs } = gate.extractAggregator(realCi);
  const jobs = needs.map(id => ({ name: gate.jobInstances(realCi, id).template,
    conclusion: ['changes', 'docs-check'].includes(id) ? 'success' : 'skipped' }));
  const out = gate.verdict(r.io, { baseSha: r.base, headSha: r.head, apiJobs: jobs, event: 'merge_group' });
  assert.equal(out.verdict, 'pass', out.reason);
  assert.equal(out.flags.code, 'false');
  assert.deepEqual(out.policyPaths, []);
  assert.equal(Object.keys(out.results).length, needs.length);
  const red = gate.verdict(r.io, { baseSha: r.base, headSha: r.head, apiJobs: setJobs(jobs, /^Docs Check$/, 'failure'), event: 'merge_group' });
  assert.deepEqual([red.verdict, red.reason], ['fail', 'required_jobs_failed:docs-check']);
});

test('verdict: a gate error is a fail with its reason, never a throw', () => {
  const r = repo({ 'a.txt': 'x' }, { 'b.txt': 'y' });
  const out = gate.verdict(r.io, { baseSha: r.base, headSha: r.head, apiJobs: [], event: 'merge_group' });
  assert.deepEqual([out.verdict, out.reason], ['fail', 'base_unreadable']);
  const bad = gate.verdict(r.io, { baseSha: 'nope', headSha: r.head, apiJobs: [], event: 'merge_group' });
  assert.deepEqual([bad.verdict, bad.reason], ['fail', 'base_unreadable']);
});

// ── B3: replay against a fake Actions API ────────────────────────────────

const GREEN = fixtures['path-gated-rust-false'];
const RED = fixtures['failed-shard'];
const sha = n => n.toString(16).padStart(40, 'a');
function fakeReplay(samples, { unfetchable = new Set(), oracle = {}, apiDown = new Set(), seen = [] } = {}) {
  const runs = samples.map((s, i) => ({ id: 1000 + i, event: 'merge_group', path: '.github/workflows/ci.yml', status: 'completed',
    conclusion: s.cancelled ? 'cancelled' : s.fixture.ci_success, run_attempt: 1, head_sha: sha(2 * i + 1),
    head_branch: `gh-readonly-queue/main/pr-${500 + i}-${sha(2 * i + 2)}` }));
  const calls = [];
  const io = {
    gh: args => {
      calls.push(args.join(' '));
      const endpoint = args[1];
      let match;
      if ((match = endpoint.match(/workflows\/ci\.yml\/runs\?.*page=(\d+)/))) {
        const page = Number(match[1]);
        return JSON.stringify({ total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) });
      }
      if ((match = endpoint.match(/runs\/(\d+)\/jobs/))) {
        const index = Number(match[1]) - 1000;
        if (apiDown.has(index)) throw Error('gh: Server Error (HTTP 502)');
        const s = samples[index];
        // Two pages, as --paginate --slurp returns them for more than per_page jobs.
        const all = [...s.jobs, { name: 'CI Success', conclusion: s.fixture.ci_success }];
        const half = Math.ceil(all.length / 2);
        return JSON.stringify([{ total_count: all.length, jobs: all.slice(0, half) }, { total_count: all.length, jobs: all.slice(half) }]);
      }
      if ((match = endpoint.match(/runs\/(\d+)\/artifacts/))) {
        const found = oracle[Number(match[1]) - 1000];
        return JSON.stringify([{ total_count: found ? 1 : 0, artifacts: found ? [{ name: 'ci-needs-oracle-attempt-1', expired: false }] : [] }]);
      }
      if (args[0] === 'run' && args[1] === 'download') {
        const dir = args[args.indexOf('--dir') + 1];
        const value = oracle[Number(args[2]) - 1000];
        writeFileSync(join(dir, 'ci-needs-oracle.json'), typeof value === 'string' ? value : JSON.stringify(value));
        return '';
      }
      throw Error(`unexpected gh ${args.join(' ')}`);
    },
    git: args => {
      if (args.some(arg => unfetchable.has(arg) || unfetchable.has(arg.replace('^{commit}', '')))) throw Object.assign(Error('missing'), { status: 128 });
      return '';
    },
    temp: () => tempDir(), remove: () => {}, read: path => readFileSync(path, 'utf8'), exists: () => true,
    runIsolated: judgeIo.runIsolated, stdout: () => {}, stderr: () => {},
  };
  // prepare is replaced; everything after it (rollup, aggregator, controls) is real.
  const prepare = (_, { baseSha, headSha, event }) => {
    const index = runs.findIndex(run => run.head_sha === headSha);
    seen.push({ index, baseSha, headSha, event });
    const s = samples[index];
    if (s.throws) throw new gate.GateError(s.throws);
    return { ...contextOf(s.fixture), ...s.over };
  };
  return { io, calls, runs, run: opts => gate.replay(io, { repository: 'o/r', limit: 50, minEvaluated: 15, widenTo: 200, prepare, ...opts }) };
}
const sample = (fixture, over = {}) => ({ fixture, jobs: fixture.jobs, ...over });

test('replay: green and red samples agree with CI Success, every control goes red', () => {
  const { run } = fakeReplay([...Array.from({ length: 16 }, () => sample(GREEN)), sample(RED), sample(fixtures['docs-only'])]);
  const out = run();
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.equal(out.evaluated, 18);
  assert.equal(out.red, 1);
  assert.equal(out.disagreements.length, 0);
  assert.equal(out.controlFailures.length, 0);
  assert.ok(out.controlsRun >= 17 * 3 - 1, `controls run: ${out.controlsRun}`);
});

test('replay: too few evaluated fails; cancelled runs are excluded; unfetchable heads are counted, not failed', () => {
  const samples = [...Array.from({ length: 14 }, () => sample(GREEN)), sample(RED), sample(GREEN, { cancelled: true }), sample(GREEN)];
  const { run, runs } = fakeReplay(samples, { unfetchable: new Set([sha(31)]) });
  assert.equal(runs[15].head_sha, sha(31));
  const out = run();
  assert.equal(out.evaluated, 16);
  assert.equal(out.unfetchable, 0, 'the cancelled run is excluded before any fetch');
  const short = fakeReplay(samples.slice(0, 14).concat(sample(RED)), { unfetchable: new Set([sha(1)]) }).run();
  assert.equal(short.evaluated, 14);
  assert.equal(short.unfetchable, 1);
  assert.equal(short.ok, false);
  assert.match(short.problems.join(), /evaluated 14 < 15/);
});

test('replay: no red sample fails, after widening past the limit to find one', () => {
  const greens = Array.from({ length: 60 }, () => sample(GREEN));
  const none = fakeReplay(greens).run({ limit: 20 });
  assert.equal(none.ok, false);
  assert.match(none.problems.join(), /no red sample/);
  assert.equal(none.evaluated, 20, 'past the limit only red runs are evaluated');
  const widened = fakeReplay([...greens, sample(RED)]).run({ limit: 20 });
  assert.equal(widened.ok, true, JSON.stringify(widened.problems));
  assert.equal(widened.red, 1);
  const beyond = fakeReplay([...Array.from({ length: 210 }, () => sample(GREEN)), sample(RED)]).run({ limit: 20 });
  assert.equal(beyond.red, 0, 'the search stops at widenTo');
});

test('replay: a verdict that disagrees with CI Success fails the replay', () => {
  const lying = sample(GREEN, { jobs: setJobs(GREEN.jobs, /^Lint$/, 'failure') });
  const out = fakeReplay([...Array.from({ length: 15 }, () => sample(GREEN)), sample(RED), lying]).run();
  assert.equal(out.ok, false);
  assert.equal(out.disagreements.length, 1);
  assert.equal(out.disagreements[0].recorded, 'success');
  assert.match(out.disagreements[0].reason, /lint/);
});

test('replay: a control that stays green fails the replay', () => {
  // The base script still parses for targets, but can no longer see anything.
  const aggregator = contextOf(GREEN).aggregator;
  const blind = sample(GREEN, { over: { aggregator: { ...aggregator, script: `exit 0\n${aggregator.script}` } } });
  const out = fakeReplay([...Array.from({ length: 15 }, () => sample(GREEN)), sample(RED), blind]).run();
  assert.equal(out.ok, false);
  assert.deepEqual(out.controlFailures.map(c => c.control).sort(), ['missing', 'three_branch', 'unconditional_failure']);
});

test('replay: base comes from the queue branch, head from head_sha, jobs from every page', () => {
  const seen = [];
  const { run, runs } = fakeReplay([...Array.from({ length: 15 }, () => sample(GREEN)), sample(RED)], { seen });
  const out = run();
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.equal(seen.length, 16);
  for (const { index, baseSha, headSha, event } of seen) {
    assert.equal(baseSha, runs[index].head_branch.split('-').at(-1));
    assert.equal(headSha, runs[index].head_sha);
    assert.equal(event, 'merge_group');
  }
  // Had the second page been dropped, CI Success (last) would be missing and the run excluded.
  assert.equal(out.excluded, 0);
  const odd = fakeReplay([sample(GREEN)]);
  odd.runs[0].head_branch = 'gh-readonly-queue/main/not-a-queue-ref';
  assert.equal(odd.run({ minEvaluated: 0 }).excluded, 1);
});

test('replay: a red sample agrees only when the verdict blames a job, not when the gate errored', () => {
  const errored = sample(RED, { throws: 'head_unparseable' });
  const out = fakeReplay([...Array.from({ length: 15 }, () => sample(GREEN)), errored]).run();
  assert.equal(out.ok, false);
  assert.deepEqual(out.disagreements.map(d => [d.recorded, d.reason]), [['failure', 'head_unparseable']]);
});

test('replay: the three-branch control must run at least once', () => {
  // Same bash semantics, but the control parser no longer recognises the rule.
  const aggregator = contextOf(GREEN).aggregator;
  const hidden = { ...aggregator, script: aggregator.script.replaceAll('== "false" ]] && [[', '== "false"  ]] && [[') };
  const out = fakeReplay([...Array.from({ length: 15 }, () => sample(GREEN, { over: { aggregator: hidden } })), sample(RED)]).run();
  assert.equal(out.disagreements.length, 0);
  assert.equal(out.ok, false);
  assert.match(out.problems.join(), /three_branch control never ran/);
});

test('replay: an oracle that exists but cannot be read is a problem, not a silent skip', () => {
  const samples = [...Array.from({ length: 15 }, () => sample(GREEN)), sample(RED), sample(GREEN)];
  const out = fakeReplay(samples, { oracle: { 16: '{"truncated":' } }).run();
  assert.equal(out.oracleUnreadable, 1);
  assert.equal(out.ok, false);
});

test('replay: API errors on more than a tenth of the runs fail the replay', () => {
  const samples = [...Array.from({ length: 19 }, () => sample(GREEN)), sample(RED)];
  const few = fakeReplay(samples, { apiDown: new Set([3]) }).run();
  assert.equal(few.apiErrors, 1);
  assert.equal(few.ok, true, JSON.stringify(few.problems));
  const many = fakeReplay(samples, { apiDown: new Set([3, 4, 5]) }).run();
  assert.equal(many.ok, false);
  assert.match(many.problems.join(), /API errors on 3 of 20/);
});

test('verdict: end to end, a candidate that drops a job from its own ci-success and skips it fails', () => {
  const files = { '.github/workflows/ci.yml': realCi, 'pnpm-lock.yaml': lockfile('4.13.5', '19.1.0'),
    '.github/scripts/mobile-lockfile-closure.mjs': closureScript };
  for (const name of ['classify-pr-paths.sh', 'qemu-gate-paths.txt', 'integration-floor-paths.txt', 'path-reader-map.txt']) {
    files[`.github/scripts/${name}`] = readFileSync(join(REPO_ROOT, '.github/scripts', name), 'utf8');
  }
  const doctored = realCi.replace(/^(    needs: \[.*), test-shared(,.*\])$/m, '$1$2').replace(/^ {10}TEST_SHARED_RESULT: .*\n/m, '')
    .replace(/^ {13}\[\[ "\$\{TEST_SHARED_RESULT\}" != "success" \]\] \|\| \\\n/m, '');
  assert.equal(gate.extractAggregator(doctored).needs.includes('test-shared'), false);
  const r = repo(files, { '.github/workflows/ci.yml': doctored });
  // Each job runs as its classifier condition says under the base flags, except
  // the one the candidate dropped. Conditions the evaluator cannot read run.
  const { needs } = gate.extractAggregator(realCi);
  const { flags } = gate.baseFlags(r.io, r.base, r.head);
  const runs = id => {
    const condition = gate.workflowJobsOf(realCi)[id].condition;
    try { return !condition || evaluateIf(condition, flags); } catch { return true; }
  };
  const jobs = needs.flatMap(id => {
    const { template, expected } = gate.jobInstances(realCi, id);
    if (id === 'test-shared') return [{ name: template, conclusion: 'skipped' }];
    return runs(id) ? expected.map(name => ({ name, conclusion: 'success' })) : [{ name: template, conclusion: 'skipped' }];
  });
  const base = gate.verdict(r.io, { baseSha: r.base, headSha: r.head, apiJobs: jobs, event: 'merge_group' });
  assert.equal(base.flags.api, 'true');
  assert.deepEqual(base.policyPaths, ['.github/workflows/ci.yml']);
  assert.deepEqual([base.verdict, base.reason], ['fail', 'required_jobs_failed:test-shared']);
  // Control: the same jobs with test-shared run pass.
  const ran = jobs.map(job => job.name === 'Test Shared' ? { ...job, conclusion: 'success' } : job);
  assert.equal(gate.verdict(r.io, { baseSha: r.base, headSha: r.head, apiJobs: ran, event: 'merge_group' }).verdict, 'pass');
});

test('replay: the three-branch control is parsed from the base script, not hardcoded', () => {
  const f = GREEN;
  const targets = gate.controlTargets(contextOf(f).aggregator, f.flags);
  assert.equal(targets.unconditional, 'lint');
  assert.ok(targets.threeBranch, 'a code entry with a false flag has a three-branch target');
  assert.equal(f.flags[contextOf(f).aggregator.env[targets.threeBranch.flagVar].key], 'false');
  const docs = fixtures['docs-only'];
  const docsTargets = gate.controlTargets(contextOf(docs).aggregator, docs.flags);
  assert.equal(docsTargets.unconditional, 'changes');
  // On a docs-only entry only the top-level rules are live.
  assert.ok(!docsTargets.threeBranch || docsTargets.threeBranch.flagVar === 'PATH_READERS_CHANGED');
  const renamed = { ...contextOf(f).aggregator, script: contextOf(f).aggregator.script.replaceAll('RUST_CHANGED', 'RUST_AREA'),
    env: Object.fromEntries(Object.entries(contextOf(f).aggregator.env).map(([k, v]) => [k === 'RUST_CHANGED' ? 'RUST_AREA' : k, v])) };
  assert.ok(gate.controlTargets(renamed, f.flags).threeBranch);
});

// ── B4: the needs oracle and the dispatch-only replay job ────────────────

const ciJob = id => gate.workflowJobsOf(realCi)[id]?.body ?? assert.fail(`no ${id} job`);
const stepsOf = body => body.split(/^      - (?=name: )/m).slice(1);

test('ci-success: the first step writes the oracle from an env var and cannot fail CI Success', () => {
  const [oracle, upload, check] = stepsOf(ciJob('ci-success'));
  assert.match(oracle, /^name: Record needs oracle \(W02, advisory\)\n/);
  assert.match(oracle, /^        continue-on-error: true$/m);
  // continue-on-error does not bound how long a step can hold up the required check.
  for (const step of [oracle, upload]) assert.match(step, /^        timeout-minutes: [1-5]$/m);
  assert.match(oracle, /^          NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}$/m);
  assert.match(oracle, /^        run: printf '%s\\n' "\$\{NEEDS_JSON\}" > ci-needs-oracle\.json$/m);
  assert.doesNotMatch(oracle, /\$\{\{[^}]*\}\}[^\n]*>|run:[^\n]*\$\{\{/, 'needs reaches the shell only through env');
  assert.match(upload, /^name: Upload needs oracle \(W02, advisory\)\n/);
  assert.match(upload, /^        if: \$\{\{ !cancelled\(\) \}\}$/m);
  assert.match(upload, /^        continue-on-error: true$/m);
  assert.match(upload, /^        uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+$/m);
  assert.match(upload, /^          name: ci-needs-oracle-attempt-\$\{\{ github\.run_attempt \}\}$/m);
  assert.match(upload, /^          path: ci-needs-oracle\.json$/m);
  assert.match(upload, /^          retention-days: 7$/m);
  assert.match(check, /^name: Check all jobs passed\n/);
});

test('ci-success: the Check all jobs passed run block is unchanged by the oracle', () => {
  const { script } = gate.extractAggregator(realCi);
  const lines = script.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['STACK_CHANGED=false', 'case " ${API_CHANGED} ${WEB_CHANGED} ${PORTAL_CHANGED} " in',
    '  *" true "*) STACK_CHANGED=true ;;', 'esac']);
  assert.deepEqual(lines.slice(-3), ['  exit 1', 'fi', 'echo "All required jobs passed!"']);
});

test('ci-gate-replay: dispatch-only, read-only, full history, never in ci-success needs', () => {
  const body = ciJob('ci-gate-replay');
  assert.match(body, /^    if: github\.event_name == 'workflow_dispatch'$/m);
  assert.doesNotMatch(body, /^    needs:/m);
  assert.match(body, /^    timeout-minutes: 30$/m);
  assert.match(body, /^    permissions:\n      contents: read\n      actions: read\n    steps:$/m);
  assert.match(body, /^          fetch-depth: 0$/m);
  assert.match(body, /^          persist-credentials: false$/m);
  assert.match(body, /^          sparse-checkout: \|\n            \.github\/scripts\n            \.github\/workflows\n          sparse-checkout-cone-mode: false$/m);
  assert.match(body, /^        run: node \.github\/scripts\/ci-gate\.mjs replay$/m);
  assert.doesNotMatch(body, /continue-on-error|secrets\./);
  assert.ok(!gate.extractAggregator(realCi).needs.includes('ci-gate-replay'));
});

test('lint registers the gate suite', () => {
  assert.match(ciJob('lint'), /^        run: node --test \.github\/scripts\/ci-gate\.test\.mjs$/m);
});

test('replay: the oracle is compared, and a difference is reported as a disagreement', () => {
  const needsOf = f => Object.fromEntries(Object.entries(judge(f).results).map(([job, result]) =>
    [job, { result, outputs: job === 'mobile-native-changes' ? { mobile: f.mobile } : {} }]));
  const good = needsOf(GREEN);
  assert.equal(good['mobile-native-changes'].result, 'success');
  const samples = [...Array.from({ length: 15 }, () => sample(GREEN)), sample(RED), sample(GREEN), sample(GREEN), sample(GREEN)];
  const oracle = {
    16: good,
    17: { ...good, 'test-shared': { result: 'skipped', outputs: {} } },
    18: { ...good, 'mobile-native-changes': { result: 'success', outputs: { mobile: 'true' } } },
  };
  const out = fakeReplay(samples, { oracle }).run();
  assert.equal(out.oracleCompared, 3);
  assert.deepEqual(out.disagreements.map(d => [d.kind, d.job, d.oracle, d.gate]), [
    ['oracle', 'test-shared', 'skipped', 'success'], ['oracle', 'mobile', 'true', 'false']]);
  assert.equal(out.ok, false);
  assert.equal(fakeReplay(samples, { oracle: { 16: good } }).run().ok, true);
});

test('compareOracle: a needs job absent from the oracle is a difference; the mobile output only when the job ran', () => {
  const results = { lint: 'success', 'mobile-native-changes': 'skipped' };
  assert.deepEqual(gate.compareOracle({ 'mobile-native-changes': { result: 'skipped', outputs: {} } }, results, 'false'),
    [{ job: 'lint', oracle: null, gate: 'success' }]);
});

// ── C1: waiting for the candidate's CI run ───────────────────────────────

const MIN = 60_000;
const REPO = 'LanternOps/breeze';
const HEAD_SHA = 'c'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const WORKFLOW_SHA = 'f'.repeat(40);
const QUEUE_REF = `refs/heads/gh-readonly-queue/main/pr-1-${BASE_SHA}`;
const ciRun = over => ({ id: 77, path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: HEAD_SHA,
  status: 'in_progress', conclusion: null, run_attempt: 1, ...over });
const ciSuccessJob = (status, conclusion = null) => ({ name: 'CI Success', status, conclusion });

// A fake clock and a fake Actions API. `state(elapsedMs)` says what the API
// shows at that moment, or throws to simulate an outage.
function waitIo(state) {
  let now = 1_000_000_000;
  const start = now;
  const calls = [];
  return {
    calls,
    elapsed: () => now - start,
    now: () => now,
    sleep: ms => { now += ms; },
    gh(args) {
      calls.push(args);
      const shown = state(now - start);
      if (/\/jobs\?/.test(args[1])) return JSON.stringify([{ jobs: shown.jobs ?? [] }]);
      return JSON.stringify(shown.raw ?? { workflow_runs: shown.runs ?? [] });
    },
  };
}
const wait = (io, over = {}) => gate.waitForCi(io, { repository: REPO, headSha: HEAD_SHA, headRef: QUEUE_REF, ...over });

test('waitForCi: only the ci.yml merge_group run for the exact head counts', () => {
  const others = [ciRun({ id: 1, path: '.github/workflows/ci-copy.yml', status: 'completed', conclusion: 'success' }),
    ciRun({ id: 2, event: 'pull_request', status: 'completed', conclusion: 'success' }),
    ciRun({ id: 3, head_sha: 'd'.repeat(40), status: 'completed', conclusion: 'success' })];
  const decoys = waitIo(() => ({ runs: others }));
  assert.deepEqual(wait(decoys).reason, 'ci_run_missing');

  const io = waitIo(() => ({ runs: [...others, ciRun({ status: 'completed', conclusion: 'success' })], jobs: [ciSuccessJob('completed', 'success')] }));
  const out = wait(io);
  assert.equal(out.run.id, 77);
  assert.deepEqual(out.jobs.map(job => job.name), ['CI Success']);
  assert.ok(io.calls[0][1].includes(`head_sha=${HEAD_SHA}`), io.calls[0][1]);
  assert.ok(io.calls[0][1].includes('actions/workflows/ci.yml/runs'), io.calls[0][1]);
});

test('waitForCi: of two runs for one head, the newest governs', () => {
  const io = waitIo(() => ({ runs: [ciRun({ id: 5, status: 'completed', conclusion: 'failure' }), ciRun({ id: 9, status: 'completed', conclusion: 'success' })] }));
  assert.equal(wait(io).run.id, 9);
});

test('waitForCi: stops when CI Success has completed, whatever its conclusion, and not before', () => {
  for (const conclusion of ['success', 'failure', 'skipped']) {
    // Another job finishing must not end the wait, or the verdict judges a partial list.
    const lint = { name: 'Lint', status: 'completed', conclusion: 'success' };
    const io = waitIo(elapsed => ({ runs: [ciRun()], jobs: [lint, elapsed < 10 * MIN ? ciSuccessJob('in_progress') : ciSuccessJob('completed', conclusion)] }));
    const out = wait(io);
    assert.equal(out.run.status, 'in_progress');
    assert.equal(out.jobs[1].conclusion, conclusion);
    assert.equal(io.elapsed(), 10 * MIN);
  }
});

test('waitForCi: stops when the run has completed, even with no CI Success job', () => {
  const io = waitIo(elapsed => elapsed < 3 * MIN ? { runs: [ciRun()] } : { runs: [ciRun({ status: 'completed', conclusion: 'failure' })], jobs: [] });
  const out = wait(io);
  assert.equal(out.run.conclusion, 'failure');
  assert.deepEqual(out.jobs, []);
  assert.equal(io.elapsed(), 3 * MIN);
});

test('waitForCi: no run past 15 minutes is ci_run_missing; one that appears at 14 is followed', () => {
  const never = waitIo(() => ({ runs: [] }));
  assert.equal(wait(never).reason, 'ci_run_missing');
  assert.equal(never.elapsed(), 15 * MIN);
  const late = waitIo(elapsed => elapsed < 14 * MIN ? { runs: [] } : { runs: [ciRun({ status: 'completed', conclusion: 'success' })] });
  assert.equal(wait(late).run.id, 77);
});

test('waitForCi: the 140 minute deadline ends a run that never finishes', () => {
  const io = waitIo(() => ({ runs: [ciRun()], jobs: [ciSuccessJob('queued')] }));
  assert.equal(wait(io).reason, 'deadline');
  assert.equal(io.elapsed(), 140 * MIN);
});

test('waitForCi: a cancelled run is ci_cancelled at once and names the run', () => {
  const io = waitIo(() => ({ runs: [ciRun({ status: 'completed', conclusion: 'cancelled' })], jobs: [ciSuccessJob('completed', 'success')] }));
  const out = wait(io);
  assert.equal(out.reason, 'ci_cancelled');
  assert.equal(out.run.id, 77);
  assert.equal(io.elapsed(), 0);
});

test('waitForCi: an outage shorter than the tolerance is survived, 15 consecutive minutes is api_error', () => {
  const down = elapsed => { if (elapsed < 14 * MIN) throw Error('HTTP 502'); return { runs: [ciRun({ status: 'completed', conclusion: 'success' })] }; };
  assert.equal(wait(waitIo(down)).run.id, 77);

  const io = waitIo(() => { throw Error('HTTP 502'); });
  assert.equal(wait(io).reason, 'api_error');
  // One poll is 60 s plus the 15 s of ghJson's retries, so 15 minutes is reached within 75 s.
  assert.ok(io.elapsed() >= 15 * MIN && io.elapsed() <= 16.25 * MIN, String(io.elapsed()));
});

test('waitForCi: api_error carries the real cause from stderr, not just the failed command', () => {
  const io = waitIo(() => { throw Object.assign(Error('Command failed: gh api repos/x\ngh: API rate limit exceeded (HTTP 403)'), { stderr: 'gh: API rate limit exceeded (HTTP 403)\n' }); });
  const out = wait(io);
  assert.equal(out.reason, 'api_error');
  assert.match(out.detail, /API rate limit exceeded \(HTTP 403\)/);
});

test('waitForCi: a bug is not reported as an outage', () => {
  const io = waitIo(() => ({ raw: { workflow_runs: [null] } }));
  assert.throws(() => wait(io), TypeError);
  assert.equal(io.elapsed(), 0);
});

test('runJobs: a page with no job list is an API problem, not zero jobs that blame the candidate', () => {
  const io = waitIo(() => ({}));
  io.gh = () => JSON.stringify([{ jobs: [{ name: 'Lint', conclusion: 'success', status: 'completed' }] }, { message: 'Server Error' }]);
  assert.throws(() => gate.runJobs(io, REPO, 1), error => error.code === 'api_error');
});

test('waitForCi: the outage window counts consecutive failures, so a good poll resets it', () => {
  // Down for 10 of every 11 minutes, for long past the tolerance. Never 15 in a row.
  const io = waitIo(elapsed => {
    if (elapsed > 60 * MIN) return { runs: [ciRun({ status: 'completed', conclusion: 'success' })] };
    if (elapsed % (11 * MIN) < 10 * MIN) throw Error('HTTP 503');
    return { runs: [ciRun()], jobs: [] };
  });
  assert.equal(wait(io).run.conclusion, 'success');
});

test('waitForCi: a failing jobs read and a malformed run list count as the API being down', () => {
  const jobsDown = waitIo(() => ({ runs: [ciRun()] }));
  const gh = jobsDown.gh;
  jobsDown.gh = args => { if (/\/jobs\?/.test(args[1])) throw Error('HTTP 500'); return gh(args); };
  assert.equal(wait(jobsDown).reason, 'api_error');
  // A body with no list is not "no run yet", which would blame the candidate.
  const malformed = waitIo(() => ({ raw: { message: 'Server Error' } }));
  assert.equal(wait(malformed).reason, 'api_error');
});

// ── C1: verify ───────────────────────────────────────────────────────────

const verifyEnv = over => ({ GITHUB_EVENT_NAME: 'merge_group', GITHUB_REPOSITORY: REPO, GITHUB_WORKFLOW_SHA: WORKFLOW_SHA,
  GITHUB_WORKFLOW_REF: 'LanternOps/breeze/.github/workflows/ci-gate.yml@refs/heads/main', GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '2',
  BASE_SHA, HEAD_SHA, HEAD_REF: QUEUE_REF, GITHUB_STEP_SUMMARY: 'summary.md', ...over });
const passing = over => ({ verdict: 'pass', reason: 'required_jobs_passed', flags: { code: 'true', rust: 'false' }, policyPaths: [],
  results: { lint: 'success' }, mobile: 'false', stdout: '', ...over });

function verifyIo({ git = () => '', oracle } = {}) {
  const out = [], err = [], files = new Map(), gitCalls = [];
  let clock = 1_000_000_000; // a wait that is not stubbed out still ends
  return { out, err, files, gitCalls,
    all: () => [...out, ...err],
    now: () => clock, sleep(ms) { clock += ms; },
    stdout: text => out.push(text), stderr: text => err.push(text),
    git(args) { gitCalls.push(args); return git(args); },
    temp: () => 'tmp', remove: path => files.delete(path),
    read: path => { if (!files.has(path)) throw Error(`no ${path}`); return files.get(path); },
    write: (path, text) => files.set(path, text),
    append: (path, text) => files.set(path, (files.get(path) ?? '') + text),
    gh(args) {
      if (args[0] === 'run') {
        if (oracle instanceof Error) throw oracle;
        files.set(join(args[args.indexOf('--dir') + 1], 'ci-needs-oracle.json'), JSON.stringify(oracle));
        return '';
      }
      const name = args[1].match(/name=([\w-]+)/)?.[1];
      return JSON.stringify([{ artifacts: oracle === undefined ? [] : [{ name, expired: false }] }]);
    },
  };
}
const finished = () => ({ run: ciRun({ status: 'completed', conclusion: 'success', run_attempt: 3 }), jobs: [ciSuccessJob('completed', 'success')] });
const runVerify = (io, { env, waitFor = finished, decide = () => passing() } = {}) =>
  gate.verify(io, verifyEnv(env), { waitForCi: waitFor, verdict: decide });
const gateLines = io => io.all().filter(line => /^ci-gate:/.test(line));

test('verify: exactly one ci-gate line, with every field in order, and exit 0 on pass', () => {
  const io = verifyIo();
  assert.equal(runVerify(io), 0);
  assert.deepEqual(gateLines(io), [`ci-gate: verdict=pass reason=required_jobs_passed event=merge_group base=${BASE_SHA} head=${HEAD_SHA} ` +
    'ci_run=77 attempt=3 policy_paths=[] flags={"code":"true","rust":"false"} oracle=absent']);
});

test('verify: exits non-zero on every verdict other than pass', () => {
  const io = verifyIo();
  assert.equal(runVerify(io, { decide: () => passing({ verdict: 'fail', reason: 'required_jobs_failed:lint', stdout: 'lint failed\n' }) }), 1);
  assert.match(gateLines(io)[0], /^ci-gate: verdict=fail reason=required_jobs_failed:lint /);
  assert.equal(gateLines(io).length, 1);
  assert.ok(io.all().includes('ci-gate-script: lint failed'), 'the base script says why');
  assert.equal(runVerify(verifyIo(), { decide: () => passing({ verdict: 'maybe' }) }), 1);
});

test('verify: an exception in the core is verdict=fail reason=error, not a bare stack', () => {
  for (const [name, deps] of [
    ['verdict', { decide() { throw Error('boom in core\nsecond line'); } }],
    ['wait', { waitFor() { throw Error('boom in wait'); } }],
  ]) {
    const io = verifyIo();
    assert.equal(runVerify(io, deps), 1, name);
    assert.equal(gateLines(io).length, 1, name);
    assert.match(gateLines(io)[0], /^ci-gate: verdict=fail reason=error event=merge_group /, name);
    assert.ok(io.all().some(line => line.includes('boom in')), `${name}: the cause is logged`);
    assert.ok(io.all().every(line => !line.includes('\n')), `${name}: one line each`);
  }
});

test('verify: a GateError from the core keeps its own reason', () => {
  const io = verifyIo();
  assert.equal(runVerify(io, { decide() { throw new gate.GateError('aggregator_exec', 'spawn failed'); } }), 1);
  assert.match(gateLines(io)[0], /verdict=fail reason=aggregator_exec /);
});

test('verify: pins itself by ancestry, before waiting for anything', () => {
  const io = verifyIo({ git: args => { if (args[0] === 'merge-base') throw Error('exit 1'); return ''; } });
  let waited = false;
  assert.equal(runVerify(io, { waitFor() { waited = true; return finished(); } }), 1);
  assert.equal(waited, false);
  assert.match(gateLines(io)[0], /^ci-gate: verdict=fail reason=not_pinned /);
  const ancestry = io.gitCalls.find(args => args[0] === 'merge-base');
  assert.deepEqual(ancestry, ['merge-base', '--is-ancestor', WORKFLOW_SHA, 'origin/main']);
  // An unusable sha cannot be ancestry-checked at all.
  const bad = verifyIo();
  assert.equal(runVerify(bad, { env: { GITHUB_WORKFLOW_SHA: '' } }), 1);
  assert.match(gateLines(bad)[0], /reason=not_pinned /);
});

test('verify: not_pinned says whether the answer was no or the check could not run', () => {
  const failing = error => verifyIo({ git: args => { if (args[0] === 'merge-base' || (error.fetchToo && args[0] === 'fetch')) throw error; return ''; } });
  const details = io => io.all().filter(line => line.startsWith('ci-gate-detail:')).join('\n');

  const no = failing(Object.assign(Error('Command failed'), { status: 1 }));
  assert.equal(runVerify(no), 1);
  assert.match(details(no), /not an ancestor of origin\/main/);

  const cannot = failing(Object.assign(Error('Command failed'), { status: 128, stderr: "fatal: Not a valid object name origin/main\n", fetchToo: true }));
  assert.equal(runVerify(cannot), 1);
  assert.match(gateLines(cannot)[0], /reason=not_pinned /);
  assert.match(details(cannot), /ancestry check failed: fatal: Not a valid object name origin\/main/);
  assert.match(details(cannot), /fetching main failed/);
});

test('verify: an unfetchable candidate commit logs which one and why', () => {
  const io = verifyIo({ git: args => {
    if (args[0] === 'cat-file' && args[2].startsWith(HEAD_SHA)) throw Error('absent');
    if (args[0] === 'fetch' && args.includes(HEAD_SHA)) throw Object.assign(Error('Command failed'), { stderr: 'fatal: remote error: upload-pack: not our ref\n' });
    return '';
  } });
  assert.equal(runVerify(io), 1);
  assert.match(gateLines(io)[0], /reason=base_unreadable /);
  const detail = io.all().find(line => line.startsWith('ci-gate-detail:'));
  assert.ok(detail.includes(`head ${HEAD_SHA}`), detail);
  assert.match(detail, /upload-pack: not our ref/);
});

test('verify: time spent fetching comes off the wait, so a verdict line always lands before the job timeout', () => {
  const io = verifyIo();
  const git = io.git;
  io.git = args => { io.sleep(10 * MIN); return git(args); }; // fetch main, merge-base, two cat-files
  let deadlineMs;
  runVerify(io, { waitFor(_, input) { deadlineMs = input.deadlineMs; return finished(); } });
  assert.equal(deadlineMs, 100 * MIN);
  // Past the deadline already: no poll, and a line saying so.
  const late = waitIo(() => assert.fail('must not poll'));
  assert.equal(wait(late, { deadlineMs: -1 }).reason, 'deadline');
});

test('verify: logs GITHUB_WORKFLOW_REF verbatim and never judges its shape', () => {
  for (const ref of ['LanternOps/breeze/.github/workflows/ci-gate.yml@refs/heads/main', 'something/unexpected@sha-or-whatever', '']) {
    const io = verifyIo();
    assert.equal(runVerify(io, { env: { GITHUB_WORKFLOW_REF: ref } }), 0, ref);
    const identity = io.all().filter(line => line.startsWith('ci-gate-identity:'));
    assert.equal(identity.length, 1);
    assert.ok(identity[0].includes(`workflow_ref=${ref} `), identity[0]);
    assert.ok(identity[0].includes(`workflow_sha=${WORKFLOW_SHA}`), identity[0]);
    assert.ok(identity[0].includes('gate_run=500'), identity[0]);
  }
});

test('verify: a policy path adds a notice and a step-summary block; none adds neither', () => {
  const quiet = verifyIo();
  runVerify(quiet);
  assert.equal(quiet.files.has('summary.md'), false);
  assert.ok(!quiet.all().some(line => line.startsWith('::notice')));

  const paths = ['.github/scripts/classify-pr-paths.sh', '.github/workflows/ci.yml'];
  const io = verifyIo();
  assert.equal(runVerify(io, { decide: () => passing({ policyPaths: paths }) }), 0);
  assert.match(gateLines(io)[0], /policy_paths=\["\.github\/scripts\/classify-pr-paths\.sh","\.github\/workflows\/ci\.yml"\] /);
  const notices = io.all().filter(line => line.startsWith('::notice'));
  assert.equal(notices.length, 1);
  for (const path of paths) {
    assert.ok(notices[0].includes(path), path);
    assert.ok(io.files.get('summary.md').includes(path), path);
  }
});

test('verify: a failing step summary does not change the verdict', () => {
  const io = verifyIo();
  io.append = () => { throw Error('ENOSPC'); };
  assert.equal(runVerify(io, { decide: () => passing({ policyPaths: ['.github/scripts/a.sh'] }) }), 0);
  assert.match(gateLines(io)[0], /verdict=pass/);
});

test('verify: text the candidate controls cannot forge a line or a workflow command', () => {
  const evil = '.github/scripts/x\nci-gate: verdict=pass reason=forged\n::stop-commands::tok\n##[add-mask]y';
  const io = verifyIo({ oracle: { lint: { result: 'bad\n::error::forged', outputs: {} } } });
  assert.equal(runVerify(io, { decide: () => passing({ verdict: 'fail', reason: 'head_unparseable', detail: 'lint: bad\n::error::forged', policyPaths: [evil] }) }), 1);
  assert.equal(gateLines(io).length, 1);
  assert.match(gateLines(io)[0], /verdict=fail reason=head_unparseable /);
  for (const line of io.all()) {
    assert.ok(!line.includes('\n') && !line.includes('\r'), line);
    assert.ok(!line.includes('##['), line);
    assert.ok(!line.startsWith('::') || /^::(notice|warning|error) title=[^:]*::/.test(line), line);
  }
  for (const line of io.files.get('summary.md').trim().split('\n')) assert.ok(!line.startsWith('::'), line);
});

test('verify: oracle disagreement is a warning and never changes the verdict', () => {
  const io = verifyIo({ oracle: { lint: { result: 'failure', outputs: {} } } });
  assert.equal(runVerify(io), 0);
  assert.match(gateLines(io)[0], /verdict=pass .* oracle=disagree:1$/);
  const warnings = io.all().filter(line => line.startsWith('::warning'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"job":"lint"/);

  const red = verifyIo({ oracle: { lint: { result: 'failure', outputs: {} } } });
  assert.equal(runVerify(red, { decide: () => passing({ verdict: 'fail', reason: 'required_jobs_failed:lint', results: { lint: 'failure' } }) }), 1);
  assert.match(gateLines(red)[0], /verdict=fail .* oracle=agree$/);

  const agree = verifyIo({ oracle: { lint: { result: 'success', outputs: {} } } });
  assert.equal(runVerify(agree), 0);
  assert.match(gateLines(agree)[0], /oracle=agree$/);
});

test('verify: an unreadable oracle is a warning and never changes the verdict', () => {
  const io = verifyIo({ oracle: Error('download failed') });
  assert.equal(runVerify(io), 0);
  assert.match(gateLines(io)[0], /verdict=pass .* oracle=unreadable$/);
  assert.ok(io.all().some(line => line.startsWith('::warning')));
});

test('verify: the oracle is read for the attempt that was judged', () => {
  const io = verifyIo({ oracle: { lint: { result: 'success', outputs: {} } } });
  const seen = [];
  const gh = io.gh;
  io.gh = args => { seen.push(args.join(' ')); return gh(args); };
  runVerify(io);
  assert.ok(seen.some(call => call.includes('artifacts?name=ci-needs-oracle-attempt-3')), seen.join('\n'));
  assert.ok(seen.some(call => call.includes('run download 77') && call.includes('--name ci-needs-oracle-attempt-3')), seen.join('\n'));
});

test('verify: a timing reason from the wait is the verdict, and no verdict is computed', () => {
  for (const out of [{ reason: 'ci_run_missing' }, { reason: 'deadline' }, { reason: 'api_error' }, { reason: 'ci_cancelled', run: ciRun({ id: 88, run_attempt: 2 }) }]) {
    const io = verifyIo();
    let decided = false;
    assert.equal(runVerify(io, { waitFor: () => out, decide() { decided = true; return passing(); } }), 1, out.reason);
    assert.equal(decided, false, out.reason);
    assert.match(gateLines(io)[0], new RegExp(`^ci-gate: verdict=fail reason=${out.reason} `));
    if (out.run) assert.match(gateLines(io)[0], / ci_run=88 attempt=2 /);
    else assert.match(gateLines(io)[0], / ci_run=none attempt=none /);
  }
});

test('verify: only merge_group is judged', () => {
  const io = verifyIo();
  assert.equal(runVerify(io, { env: { GITHUB_EVENT_NAME: 'pull_request' } }), 1);
  assert.match(gateLines(io)[0], /^ci-gate: verdict=fail reason=wrong_event event=pull_request /);
});

test('verify: the verdict is asked about the exact queue shas and the jobs from the wait', () => {
  const io = verifyIo();
  let asked;
  runVerify(io, { decide(_, input) { asked = input; return passing(); } });
  assert.deepEqual([asked.baseSha, asked.headSha, asked.event, asked.apiJobs.map(job => job.name)], [BASE_SHA, HEAD_SHA, 'merge_group', ['CI Success']]);
});

// ── C1: the git paths, in real repositories ──────────────────────────────

// origin has main (W), and candidate commits main never had; a clone of main
// alone is what the gate's checkout of workflow_sha guarantees.
function gateRemote(baseFiles, headFiles) {
  const origin = repo({ 'gate.txt': 'pinned\n' }, baseFiles);
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const inOrigin = (...args) => run(origin.cwd, ...args);
  inOrigin('config', 'uploadpack.allowAnySHA1InWant', 'true');
  inOrigin('checkout', '-q', '-B', 'candidate');
  inOrigin('branch', '-f', 'main', origin.base);
  const workflowSha = origin.base;
  const baseSha = origin.head;
  for (const [path, text] of Object.entries(headFiles)) {
    mkdirSync(dirname(join(origin.cwd, path)), { recursive: true });
    writeFileSync(join(origin.cwd, path), text);
  }
  inOrigin('add', '-A');
  inOrigin('commit', '-q', '--allow-empty', '-m', 'candidate head');
  const headSha = inOrigin('rev-parse', 'HEAD');
  const clone = tempDir();
  execFileSync('git', ['clone', '-q', '--single-branch', '--branch', 'main', '--no-tags', `file://${origin.cwd}`, clone], { stdio: 'ignore' });
  const io = gate.createGateIO({ cwd: clone, env: { PATH: process.env.PATH } });
  io.sleep = () => {};
  const lines = [];
  io.stdout = text => lines.push(text);
  io.stderr = text => lines.push(text);
  const has = sha => { try { run(clone, 'cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; } };
  return { origin: origin.cwd, clone, io, lines, workflowSha, baseSha, headSha, has, inOrigin };
}
const realPolicyFiles = () => {
  const files = { '.github/workflows/ci.yml': realCi, 'pnpm-lock.yaml': lockfile('4.13.5', '19.1.0'), '.github/scripts/mobile-lockfile-closure.mjs': closureScript };
  for (const name of ['classify-pr-paths.sh', 'qemu-gate-paths.txt', 'integration-floor-paths.txt', 'path-reader-map.txt']) {
    files[`.github/scripts/${name}`] = readFileSync(join(REPO_ROOT, '.github/scripts', name), 'utf8');
  }
  return files;
};
const docsOnlyJobs = () => gate.extractAggregator(realCi).needs.map(id => ({ name: gate.jobInstances(realCi, id).template,
  conclusion: ['changes', 'docs-check'].includes(id) ? 'success' : 'skipped', status: 'completed' }));
// The Actions API a real entry would see: its run is done, its jobs are listed.
const fakeActions = (io, headSha, jobs) => {
  io.gh = args => {
    if (/\/jobs\?/.test(args[1] ?? '')) return JSON.stringify([{ jobs: [...jobs, ciSuccessJob('completed', 'success')] }]);
    if (/\/artifacts\?/.test(args[1] ?? '')) return JSON.stringify([{ artifacts: [] }]);
    return JSON.stringify({ workflow_runs: [ciRun({ head_sha: headSha, status: 'completed', conclusion: 'success' })] });
  };
};
const remoteEnv = (r, over) => verifyEnv({ GITHUB_WORKFLOW_SHA: r.workflowSha, BASE_SHA: r.baseSha, HEAD_SHA: r.headSha, GITHUB_STEP_SUMMARY: '', ...over });
const lineOf = r => r.lines.filter(line => /^ci-gate:/.test(line));

test('verify: end to end, it fetches the candidate commits itself and judges them', () => {
  const r = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
  assert.equal(r.has(r.baseSha) || r.has(r.headSha), false, 'candidate commits must start out absent');
  fakeActions(r.io, r.headSha, docsOnlyJobs());
  assert.equal(gate.verify(r.io, remoteEnv(r)), 0, r.lines.join('\n'));
  assert.ok(r.has(r.baseSha) && r.has(r.headSha));
  assert.equal(lineOf(r).length, 1);
  assert.match(lineOf(r)[0], /^ci-gate: verdict=pass reason=required_jobs_passed event=merge_group /);
  assert.match(lineOf(r)[0], /"code":"false"/);
});

test('verify: end to end, a failed required job goes red and is named', () => {
  const r = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
  fakeActions(r.io, r.headSha, setJobs(docsOnlyJobs(), /^Docs Check$/, 'failure'));
  assert.equal(gate.verify(r.io, remoteEnv(r)), 1);
  assert.match(lineOf(r)[0], /^ci-gate: verdict=fail reason=required_jobs_failed:docs-check /);
});

test('verify: end to end, a workflow sha that is not on main is not_pinned', () => {
  const r = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
  fakeActions(r.io, r.headSha, docsOnlyJobs());
  // The candidate's own copy: it would be the head, or the merge ref.
  r.io.git(['fetch', '--no-tags', '--quiet', 'origin', r.headSha]);
  assert.equal(gate.verify(r.io, remoteEnv(r, { GITHUB_WORKFLOW_SHA: r.headSha })), 1);
  assert.match(lineOf(r)[0], /reason=not_pinned /);
});

test('verify: main that moved past the checkout still pins; the fetch is its own', () => {
  const r = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
  fakeActions(r.io, r.headSha, docsOnlyJobs());
  // The gate ran from a newer main than this clone's origin/main knows.
  r.inOrigin('branch', '-f', 'main', r.baseSha);
  r.io.git(['fetch', '--no-tags', '--quiet', 'origin', r.baseSha]);
  assert.equal(gate.verify(r.io, remoteEnv(r, { GITHUB_WORKFLOW_SHA: r.baseSha })), 0, r.lines.join('\n'));
});

test('verify: a fetch that cannot find a candidate commit is base_unreadable, not a crash', () => {
  for (const which of ['BASE_SHA', 'HEAD_SHA']) {
    const r = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
    fakeActions(r.io, r.headSha, docsOnlyJobs());
    let waited = false;
    const code = gate.verify(r.io, remoteEnv(r, { [which]: 'e'.repeat(40) }), { waitForCi() { waited = true; return finished(); } });
    assert.equal(code, 1, which);
    assert.equal(waited, false, which);
    assert.equal(lineOf(r).length, 1, which);
    assert.match(lineOf(r)[0], /^ci-gate: verdict=fail reason=base_unreadable /, which);
  }
  const garbled = gateRemote(realPolicyFiles(), { 'docs/guide.md': '# x\n' });
  assert.equal(gate.verify(garbled.io, remoteEnv(garbled, { HEAD_SHA: 'not-a-sha\n::error::x' })), 1);
  assert.match(lineOf(garbled)[0], /reason=base_unreadable/);
  assert.ok(garbled.lines.every(line => !line.includes('\n')));
});

// ── C1: anchor ───────────────────────────────────────────────────────────

const ANCHOR_KEYS = ['schema', 'head_sha', 'merge_sha', 'base_sha', 'pr_number', 'run_id', 'run_attempt', 'created_at', 'files', 'files_source', 'policy_digest', 'policy_in_files'];

// The merge commit GitHub makes for a pull_request event: M^1 is the base, M^2 the head.
function anchorRemote(headFiles, baseFiles = { 'src/a.ts': 'a\n' }) {
  const r = gateRemote(baseFiles, headFiles);
  const tree = r.inOrigin('rev-parse', `${r.headSha}^{tree}`);
  const merge = r.inOrigin('commit-tree', tree, '-p', r.baseSha, '-p', r.headSha, '-m', 'merge');
  r.inOrigin('update-ref', 'refs/pull/7/merge', merge);
  r.env = over => ({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: REPO, GITHUB_WORKFLOW_SHA: r.workflowSha,
    GITHUB_WORKFLOW_REF: 'LanternOps/breeze/.github/workflows/ci-gate.yml@refs/heads/main', GITHUB_SHA: merge, PR_HEAD_SHA: r.headSha,
    PR_NUMBER: '7', GITHUB_RUN_ID: '900', GITHUB_RUN_ATTEMPT: '2', ...over });
  r.merge = merge;
  r.written = () => { try { return JSON.parse(readFileSync(join(r.clone, gate.ANCHOR_FILE), 'utf8')); } catch { return null; } };
  return r;
}

test('anchor: on a real merge commit, every field is right and the commit was fetched by sha', () => {
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  assert.equal(r.has(r.merge), false, 'the merge commit must start out absent');
  r.io.now = () => Date.UTC(2026, 10, 5, 12, 0, 0);
  assert.equal(gate.anchor(r.io, r.env()), 0, r.lines.join('\n'));
  const a = r.written();
  assert.deepEqual(Object.keys(a), ANCHOR_KEYS);
  assert.deepEqual([a.schema, a.head_sha, a.merge_sha, a.base_sha, a.pr_number, a.run_id, a.run_attempt, a.created_at, a.files, a.files_source, a.policy_in_files],
    [1, r.headSha, r.merge, r.baseSha, 7, 900, 2, '2026-11-05T12:00:00.000Z', ['src/b.ts'], 'merge-commit', false]);
  // The same digest W4's record uses, so W05 can compare the two.
  assert.equal(a.policy_digest, policyDigest(r.io, r.baseSha));
  assert.match(a.policy_digest, /^[a-f\d]{64}$/);
  assert.equal(lineOf(r).length, 1);
  assert.match(lineOf(r)[0], new RegExp(`^ci-gate: verdict=pass reason=anchor_written event=pull_request base=${r.baseSha} head=${r.headSha} ci_run=none attempt=none policy_paths=\\[\\] flags=null oracle=none$`));
  assert.ok(r.lines.some(line => line.startsWith('ci-gate-identity:') && line.includes('workflow_ref=LanternOps/breeze/.github/workflows/ci-gate.yml@refs/heads/main ')));
});

test('anchor: files are the diff from M to its first parent, not from the head', () => {
  // A base that moved after the head branched: M^1 is not the head's parent.
  const r = gateRemote({ 'src/a.ts': 'a\n' }, { 'src/b.ts': 'b\n' });
  r.inOrigin('checkout', '-q', '-b', 'moved', r.baseSha);
  writeFileSync(join(r.origin, 'src/moved.ts'), 'm\n');
  r.inOrigin('add', '-A');
  r.inOrigin('commit', '-q', '-m', 'base moved');
  const movedBase = r.inOrigin('rev-parse', 'HEAD');
  writeFileSync(join(r.origin, 'src/b.ts'), 'b\n');
  r.inOrigin('add', '-A');
  const merge = r.inOrigin('commit-tree', r.inOrigin('write-tree'), '-p', movedBase, '-p', r.headSha, '-m', 'merge');
  r.inOrigin('update-ref', 'refs/pull/8/merge', merge);
  assert.equal(gate.anchor(r.io, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge, PR_HEAD_SHA: r.headSha, PR_NUMBER: '8', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' }), 0, r.lines.join('\n'));
  const a = JSON.parse(readFileSync(join(r.clone, gate.ANCHOR_FILE), 'utf8'));
  assert.equal(a.base_sha, movedBase);
  assert.deepEqual(a.files, ['src/b.ts']);
});

test('anchor: a policy path sets policy_in_files and nulls the digest', () => {
  const r = anchorRemote({ '.github/scripts/classify-pr-paths.sh': '#!/bin/sh\n', 'src/b.ts': 'b\n' });
  assert.equal(gate.anchor(r.io, r.env()), 0, r.lines.join('\n'));
  const a = r.written();
  assert.equal(a.policy_in_files, true);
  assert.equal(a.policy_digest, null);
  assert.match(lineOf(r)[0], /policy_paths=\["\.github\/scripts\/classify-pr-paths\.sh"\]/);
});

test('anchor: a quoted (non-ASCII) policy path still counts as a policy path', () => {
  const r = anchorRemote({ '.github/scripts/café.mjs': 'x\n' });
  assert.equal(gate.anchor(r.io, r.env()), 0, r.lines.join('\n'));
  const a = r.written();
  assert.equal(a.policy_in_files, true);
  assert.equal(a.policy_digest, null);
});

test('anchor: M^2 not being the head writes nothing and exits 0 with a stderr reason', () => {
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  const errors = [];
  r.io.stderr = text => { errors.push(text); r.lines.push(text); };
  assert.equal(gate.anchor(r.io, r.env({ PR_HEAD_SHA: 'd'.repeat(40) })), 0);
  assert.equal(r.written(), null);
  assert.match(lineOf(r)[0], /^ci-gate: verdict=pass reason=merge_head_mismatch /);
  assert.ok(errors.some(line => line.includes('merge_head_mismatch')), errors.join('\n'));
  assert.ok(errors.some(line => line.includes(`M^2=${r.headSha}`) && line.includes(`expected ${'d'.repeat(40)}`)), errors.join('\n'));
});

test('anchor: an unusable input is named, and a failed fetch says why', () => {
  for (const [over, name] of [[{ PR_NUMBER: '' }, 'PR_NUMBER'], [{ PR_HEAD_SHA: 'x' }, 'PR_HEAD_SHA'], [{ GITHUB_SHA: 'x' }, 'GITHUB_SHA'], [{ GITHUB_RUN_ID: 'x' }, 'GITHUB_RUN_ID'], [{ GITHUB_RUN_ATTEMPT: '' }, 'GITHUB_RUN_ATTEMPT'], [{ GITHUB_EVENT_NAME: 'merge_group' }, 'GITHUB_EVENT_NAME']]) {
    const r = anchorRemote({ 'src/b.ts': 'b\n' });
    gate.anchor(r.io, r.env(over));
    assert.ok(r.lines.some(line => line.startsWith('ci-gate-detail:') && line.includes(name)), `${name}:\n${r.lines.join('\n')}`);
  }
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  gate.anchor(r.io, r.env({ GITHUB_SHA: 'e'.repeat(40) }));
  assert.ok(r.lines.some(line => line.startsWith('ci-gate-detail:') && /base_unreadable .*(fatal|error)/i.test(line)), r.lines.join('\n'));
});

test('anchor: a single-parent commit is not a merge commit; nothing is written', () => {
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  r.io.git(['fetch', '--no-tags', '--quiet', 'origin', r.headSha]);
  assert.equal(gate.anchor(r.io, r.env({ GITHUB_SHA: r.headSha })), 0);
  assert.equal(r.written(), null);
  assert.match(lineOf(r)[0], /reason=merge_head_mismatch /);
});

test('anchor: a failed fetch is base_unreadable, exits 0, and writes nothing', () => {
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  assert.equal(gate.anchor(r.io, r.env({ GITHUB_SHA: 'e'.repeat(40) })), 0);
  assert.equal(r.written(), null);
  assert.equal(lineOf(r).length, 1);
  assert.match(lineOf(r)[0], /^ci-gate: verdict=pass reason=base_unreadable /);
});

test('anchor: an unusable input or an exception exits 0 with exactly one line and no anchor', () => {
  for (const over of [{ PR_NUMBER: '' }, { PR_HEAD_SHA: '' }, { GITHUB_SHA: 'not-a-sha' }, { GITHUB_RUN_ID: 'x' }, { GITHUB_EVENT_NAME: 'merge_group' }]) {
    const r = anchorRemote({ 'src/b.ts': 'b\n' });
    assert.equal(gate.anchor(r.io, r.env(over)), 0, JSON.stringify(over));
    assert.equal(r.written(), null, JSON.stringify(over));
    assert.equal(lineOf(r).length, 1, JSON.stringify(over));
    assert.match(lineOf(r)[0], /^ci-gate: verdict=pass reason=anchor_invalid_input /, JSON.stringify(over));
  }
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  r.io.write = () => { throw Error('disk full'); };
  assert.equal(gate.anchor(r.io, r.env()), 0);
  assert.equal(r.written(), null);
  assert.equal(lineOf(r).length, 1);
  assert.match(lineOf(r)[0], /^ci-gate: verdict=pass reason=anchor_error /);
  assert.ok(r.lines.some(line => line.includes('disk full')));
});

test('anchor: an earlier anchor file is never left to be uploaded', () => {
  const r = anchorRemote({ 'src/b.ts': 'b\n' });
  writeFileSync(join(r.clone, gate.ANCHOR_FILE), '{"stale":true}\n');
  assert.equal(gate.anchor(r.io, r.env({ PR_HEAD_SHA: 'd'.repeat(40) })), 0);
  assert.equal(r.written(), null);
});

// ── C2: the workflow and the script agree ────────────────────────────────

const GATE_YML_PATH = join(REPO_ROOT, '.github/workflows/ci-gate.yml');
const gateYml = () => readFileSync(GATE_YML_PATH, 'utf8');
const gateStep = name => gateYml().split(/^      - (?=name: )/m).find(step => step.startsWith(`name: ${name}\n`)) ?? assert.fail(`no ${name} step`);

test('ci-gate.yml: every env name verify and anchor read is set by its step, from event data', () => {
  const verifyStep = gateStep('Judge the queue entry');
  for (const [name, value] of Object.entries({ BASE_SHA: 'merge_group.base_sha', HEAD_SHA: 'merge_group.head_sha', HEAD_REF: 'merge_group.head_ref' })) {
    assert.match(verifyStep, new RegExp(`^          ${name}: \\$\\{\\{ github\\.event\\.${value.replace('.', '\\.')} \\}\\}$`, 'm'), name);
  }
  const anchorStep = gateStep('Record the PR anchor');
  assert.match(anchorStep, /^          PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m);
  assert.match(anchorStep, /^          PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}$/m);
  // The rest are the runner's own variables, which a step cannot be denied.
  const source = readFileSync(join(REPO_ROOT, '.github/scripts/ci-gate.mjs'), 'utf8');
  const read = new Set([...source.matchAll(/env\.([A-Z_]+)/g)].map(match => match[1]));
  const set = new Set([...gateYml().matchAll(/^          ([A-Z_]+): /gm)].map(match => match[1]));
  for (const name of read) assert.ok(set.has(name) || name === 'PATH' || name.startsWith('GITHUB_'), `${name} is read but never set`);
  assert.ok(read.has('BASE_SHA') && read.has('PR_HEAD_SHA'), 'the scan must see the event names');
});

test('ci-gate.yml: uploads exactly the file anchor writes, per attempt, for 7 days, never failing when absent', () => {
  const upload = gateStep('Upload the PR anchor');
  assert.match(upload, new RegExp(`^          path: ${gate.ANCHOR_FILE.replace('.', '\\.')}$`, 'm'));
  assert.match(upload, /^          name: ci-gate-anchor-attempt-\$\{\{ github\.run_attempt \}\}$/m);
  assert.match(upload, /^          retention-days: 7$/m);
  assert.match(upload, /^          if-no-files-found: ignore$/m);
});

test('ci-gate.yml: pinned actions match the ones ci.yml uses', () => {
  for (const action of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']) {
    const pin = gateYml().match(new RegExp(`uses: (${action}@[a-f\\d]{40}) # v\\d+`))?.[1];
    assert.ok(pin, action);
    assert.ok(realCi.includes(pin), `${pin} is not the pin ci.yml uses`);
  }
  assert.match(gateStep('Setup Node.js'), new RegExp(`node-version: '${realCi.match(/node-version: '(22\.[\d.]+)'/)[1].replace(/\./g, '\\.')}'`));
});

test('ci-gate.yml is a policy path, so a change to it never thins its own queue run', async () => {
  const { POLICY_FILES, isPolicyPath } = await import('./ci-policy.mjs');
  assert.ok(POLICY_FILES.includes('.github/workflows/ci-gate.yml'));
  assert.ok(isPolicyPath('.github/workflows/ci-gate.yml'));
});

// ── C3: the runbook ──────────────────────────────────────────────────────

test('docs: both agent docs describe CI Gate, and the rollback order is pinned', () => {
  const merge = readFileSync(join(REPO_ROOT, 'docs/agents/merge-and-deploy.md'), 'utf8');
  const testing = readFileSync(join(REPO_ROOT, 'docs/agents/testing.md'), 'utf8');
  assert.match(merge, /CI Gate/);
  assert.match(testing, /CI Gate/);
  assert.match(merge, /^### CI Gate rollback$/m);

  const rollback = merge.slice(merge.indexOf('### CI Gate rollback')).split(/^#{2,3} /m)[1];
  const ruleset = rollback.search(/ruleset to \*\*Evaluate\*\* or \*\*Disabled\*\*/);
  const confirm = rollback.indexOf('gh api repos/LanternOps/breeze/rules/branches/main');
  const code = rollback.search(/only then/i);
  assert.ok(ruleset >= 0, 'the owner turns the ruleset off');
  assert.ok(confirm > ruleset, 'then confirms it');
  assert.ok(code > confirm, 'and only then touches the workflow');

  for (const claim of [/does not prove tests ran honestly/i, /drop it from `ci-success`/i, /later PR/i, /green replay run/i, /blocks its own fix/i]) {
    assert.match(merge, claim);
  }
  // Rollback must work from a clean machine in an incident: no local file from G1.
  assert.doesNotMatch(rollback, /\/tmp\//);
  // GitHub omits evaluate and disabled rulesets from this endpoint, so empty is the confirmation.
  assert.match(rollback, /empty list/);
  assert.match(merge, /only under Active/);
});

test('docs: every reason the gate can log is in the runbook table', () => {
  const merge = readFileSync(join(REPO_ROOT, 'docs/agents/merge-and-deploy.md'), 'utf8');
  const table = merge.slice(merge.indexOf('**Reading a run.**'), merge.indexOf('**Changing the gate.**'));
  const source = readFileSync(join(REPO_ROOT, '.github/scripts/ci-gate.mjs'), 'utf8');
  const emitted = new Set([...source.matchAll(/reason: '(\w+)'/g), ...source.matchAll(/GateError\('(\w+)'/g), ...source.matchAll(/ciAt\(\w+, '(\w+)'\)/g)].map(match => match[1]));
  for (const cliOnly of ['usage', 'not_recordable']) emitted.delete(cliOnly); // record-fixture only; never in a gate run
  assert.ok(emitted.has('not_pinned') && emitted.has('anchor_written') && emitted.has('head_unreadable'), 'the scan must see the reasons');
  for (const reason of emitted) assert.ok(table.includes(`\`${reason}\``), `${reason} is not in the runbook`);
  assert.ok(table.includes('`required_jobs_failed`'), 'the bare form, when no job can be blamed');
});

test('runCLI: verify and anchor are subcommands, and an unknown one is still a usage error', () => {
  const io = verifyIo({ git: args => { if (args[0] === 'merge-base') throw Error('no'); return ''; } });
  assert.equal(gate.runCLI(io, ['verify'], verifyEnv()), 1);
  assert.match(gateLines(io)[0], /reason=not_pinned/);
  const a = verifyIo();
  assert.equal(gate.runCLI(a, ['anchor'], { GITHUB_EVENT_NAME: 'pull_request' }), 0);
  assert.match(gateLines(a)[0], /verdict=pass reason=anchor_invalid_input/);
  assert.throws(() => gate.runCLI(verifyIo(), ['nope'], {}), /verify.*anchor/s);
});

// ── W02d: trusted PR evidence, in shadow ─────────────────────────────────

const GATE_PATH = '.github/workflows/ci-gate.yml';
const CI_PATH = '.github/workflows/ci.yml';
// Values seen on real runs at E2, as fixture data only. The code derives the
// identity from the workflow list; nothing in it knows these numbers.
const LISTED_GATE_ID = 408750167;
const RULESET_GATE_ID = 409546478;
const LISTED = [{ id: LISTED_GATE_ID, path: GATE_PATH }, { id: 223405554, path: CI_PATH }];
const PINNED_REF = `${REPO}/${GATE_PATH}@refs/heads/main`;

const pinnedRun = over => ({ id: 900, path: GATE_PATH, event: 'pull_request', head_sha: HEAD_SHA, workflow_id: RULESET_GATE_ID,
  run_attempt: 1, status: 'completed', conclusion: 'success', created_at: '2026-11-06T16:30:04Z', ...over });
const identityOf = over => ({ workflow_ref: PINNED_REF, workflow_sha: WORKFLOW_SHA, gate_run: 900, gate_attempt: 1, ...over });
const pinFacts = over => ({ repository: REPO, head: HEAD_SHA, attempt: 1, workflows: LISTED, identity: identityOf(), workflowOnMain: true, ...over });

test('pinnedRunFailure: a ruleset run with its identity line is the pinned gate', () => {
  assert.equal(gate.pinnedRunFailure(pinnedRun(), pinFacts()), null);
});

const NOT_PINNED = [
  ['a candidate-copy run: the id GitHub lists for that path', pinnedRun({ workflow_id: LISTED_GATE_ID }), {}, /listed/],
  ['a run whose id is listed under any other path', pinnedRun({ workflow_id: 223405554 }), {}, /listed/],
  ['a same-named workflow at another path', pinnedRun({ path: '.github/workflows/ci-gate-2.yml' }), {}, /path/],
  ['a path with a ref suffix', pinnedRun({ path: `${GATE_PATH}@refs/heads/main` }), {}, /path/],
  ['an event other than pull_request', pinnedRun({ event: 'merge_group' }), {}, /event/],
  ['another head', pinnedRun({ head_sha: BASE_SHA }), {}, /head/],
  ['no workflow_id at all', pinnedRun({ workflow_id: undefined }), {}, /workflow_id/],
  ['a workflow list with no entry for the gate path', pinnedRun(), { workflows: [{ id: 223405554, path: CI_PATH }] }, /no listed workflow/],
  ['an empty workflow list', pinnedRun(), { workflows: [] }, /no listed workflow/],
  ['no identity line', pinnedRun(), { identity: null }, /identity/],
  ['an identity line naming a branch, not main', pinnedRun(), { identity: identityOf({ workflow_ref: `${REPO}/${GATE_PATH}@refs/heads/feature` }) }, /workflow_ref/],
  ['an identity line naming a pull ref', pinnedRun(), { identity: identityOf({ workflow_ref: `${REPO}/${GATE_PATH}@refs/pull/7/merge` }) }, /workflow_ref/],
  ['an identity line from another repository', pinnedRun(), { identity: identityOf({ workflow_ref: `other/repo/${GATE_PATH}@refs/heads/main` }) }, /workflow_ref/],
  ['an identity line from another run', pinnedRun(), { identity: identityOf({ gate_run: 901 }) }, /gate_run/],
  ['an identity line from another attempt', pinnedRun(), { attempt: 2 }, /gate_attempt/],
  ['a workflow sha that is not on main', pinnedRun(), { workflowOnMain: false }, /not on main/],
];
for (const [name, run, facts, why] of NOT_PINNED) {
  test(`pinnedRunFailure: rejects ${name}`, () => assert.match(gate.pinnedRunFailure(run, pinFacts(facts)) ?? 'accepted', why));
}

test('pinnedRunFailure: a candidate copy cannot talk its way in with a forged identity line', () => {
  const forged = identityOf({ workflow_ref: PINNED_REF });
  assert.match(gate.pinnedRunFailure(pinnedRun({ workflow_id: LISTED_GATE_ID }), pinFacts({ identity: forged })), /listed/);
});

test('parseIdentity: the one line logIdentity writes, timestamped as the logs endpoint returns it', () => {
  const line = `ci-gate-identity: workflow_ref=${PINNED_REF} workflow_sha=${WORKFLOW_SHA} gate_run=900 gate_attempt=2`;
  const parsed = identityOf({ gate_attempt: 2 });
  assert.deepEqual(gate.parseIdentity(`2026-11-06T16:30:13.0Z ${line}\n2026-11-06T16:30:14.0Z other\n`), parsed);
  assert.equal(gate.parseIdentity('2026-11-06T16:30:13.0Z other\n'), null);
  assert.equal(gate.parseIdentity(`2026-11-06T16:30:13.0Z ${line}\n2026-11-06T16:30:14.0Z ${line}\n`), null, 'two lines are not an identity');
  assert.equal(gate.parseIdentity(`2026-11-06T16:30:13.0Z x ${line}\n`), null, 'quoted inside another line');
  assert.equal(gate.parseIdentity(`2026-11-06T16:30:13.0Z ${line} extra\n`), null);
});

// A small base policy, so the rules under test stay readable. PR_ONLY_IF exits
// non-zero unless the script sees IS_PR=true; integration is demanded by flag.
const tinyCi = `name: CI
jobs:
  changes:
    name: Detect
    runs-on: ubuntu-latest
  lint:
    name: Lint
    runs-on: ubuntu-latest
  integration-test:
    name: Integration
    runs-on: ubuntu-latest
  ci-success:
    name: CI Success
    needs: [changes, lint, integration-test]
    steps:
      - name: Check all jobs passed
        env:
          CHANGES_RESULT: \${{ needs.changes.result }}
          LINT_RESULT: \${{ needs.lint.result }}
          INT_RESULT: \${{ needs.integration-test.result }}
          INT: \${{ needs.changes.outputs.integration }}
          IS_PR: \${{ github.event_name == 'pull_request' }}
        run: |
          [[ "\${IS_PR}" == "true" ]] || exit 3
          [[ "\${LINT_RESULT}" == "success" ]] || exit 4
          if [[ "\${INT}" == "true" ]]; then [[ "\${INT_RESULT}" == "success" ]] || exit 5; else [[ "\${INT_RESULT}" == "skipped" ]] || exit 6; fi
`;
// `--pull-request` is the only thing that path-gates integration, as in the real classifier.
const prGatedClassifier = `#!/usr/bin/env bash
cat > /dev/null
integration=true
[[ "\${1:-}" == "--pull-request" ]] && integration=false
printf 'code=true\\ndocs=false\\nagent=false\\napp=true\\napi=false\\nweb=false\\nportal=false\\naddins=false\\nm365=false\\nrust=false\\ntopology_browser=false\\nagent_code=false\\nintegration=%s\\npath_readers=false\\nreader_tests=\\n' "$integration"
`;
const tinyPolicy = () => ({ [CI_PATH]: tinyCi, [`${SCRIPTS}/classify-pr-paths.sh`]: prGatedClassifier });
const prJobs = over => api(['Detect', 'success'], ['Lint', 'success'], ['Integration', 'skipped'], ...(over ?? []));

// A real repository for the commits, a fake Actions API for the runs.
function trustRig({ baseFiles = tinyPolicy(), headFiles = { 'src/a.ts': 'a\n' } } = {}) {
  const r = anchorRemote(headFiles, baseFiles);
  r.io.repository = REPO;
  const state = { workflows: LISTED, runs: [], artifacts: {}, files: {}, jobIds: {}, logs: {}, jobs: {}, calls: [], downloads: [] };
  let nextJob = 5000;
  r.io.gh = args => {
    state.calls.push(args);
    if (args[0] === 'run' && args[1] === 'download') {
      const name = args[args.indexOf('--name') + 1];
      state.downloads.push(`${args[2]}/${name}`);
      for (const [file, text] of Object.entries(state.files[`${args[2]}/${name}`] ?? {})) writeFileSync(join(args[args.indexOf('--dir') + 1], file), text);
      return '';
    }
    const endpoint = args.find(arg => arg.startsWith('repos/'));
    let m;
    if (/\/actions\/workflows\?/.test(endpoint)) return JSON.stringify([{ workflows: state.workflows }]);
    if (/\/actions\/runs\?/.test(endpoint)) return JSON.stringify([{ total_count: state.runs.length, workflow_runs: state.runs }]);
    if ((m = endpoint.match(/\/actions\/runs\/(\d+)\/artifacts/))) return JSON.stringify([{ artifacts: state.artifacts[m[1]] ?? [] }]);
    if ((m = endpoint.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/))) {
      const key = `${m[1]}/${m[2]}`;
      state.jobIds[key] ??= nextJob++;
      return JSON.stringify([{ jobs: [{ id: state.jobIds[key], name: 'CI Gate' }] }]);
    }
    if ((m = endpoint.match(/\/actions\/jobs\/(\d+)\/logs/))) {
      const key = Object.keys(state.jobIds).find(k => state.jobIds[k] === Number(m[1]));
      return state.logs[key] ?? '';
    }
    if ((m = endpoint.match(/\/actions\/runs\/(\d+)\/jobs\?(.*)$/))) {
      const attempts = state.jobs[m[1]] ?? [];
      // filter=latest is the jobs of the latest attempt; anything else lists every attempt's.
      return JSON.stringify([{ jobs: /filter=latest/.test(m[2]) ? attempts.at(-1) ?? [] : attempts.flat() }]);
    }
    throw Error(`unexpected gh ${args.join(' ')}`);
  };
  const anchorOf = over => ({ schema: 1, head_sha: r.headSha, merge_sha: r.merge, base_sha: r.baseSha, pr_number: 7, run_id: 900, run_attempt: 1,
    created_at: '2026-11-06T16:30:16.000Z', files: ['src/a.ts'], files_source: 'merge-commit', policy_digest: 'd'.repeat(64), policy_in_files: false, ...over });
  // One pinned gate run, its identity line, and its anchor artifact.
  r.addAnchor = ({ id = 900, attempt = 1, run = {}, anchor = {}, expired = false, identity } = {}) => {
    state.runs.push(pinnedRun({ id, head_sha: r.headSha, run_attempt: attempt, ...run }));
    const name = `ci-gate-anchor-attempt-${attempt}`;
    (state.artifacts[id] ??= []).push({ name, expired });
    state.files[`${id}/${name}`] = { [gate.ANCHOR_FILE]: JSON.stringify(anchorOf({ run_id: id, run_attempt: attempt, ...anchor })) };
    state.logs[`${id}/${attempt}`] = identity ?? `2026-11-06T16:30:13.0Z ci-gate-identity: workflow_ref=${PINNED_REF} workflow_sha=${r.workflowSha} gate_run=${id} gate_attempt=${attempt}\n`;
    state.jobIds[`${id}/${attempt}`] ??= nextJob++;
  };
  r.addCi = ({ id = 800, attempts = [prJobs()], run = {} } = {}) => {
    state.runs.push({ id, path: CI_PATH, event: 'pull_request', head_sha: r.headSha, workflow_id: 223405554, run_attempt: attempts.length,
      status: 'completed', conclusion: 'success', created_at: '2026-11-06T16:30:04Z', pull_requests: [{ number: 7 }], ...run });
    state.jobs[id] = attempts;
  };
  r.state = state;
  r.trust = (stats = {}) => gate.trustedRecord(r.io, { head: r.headSha, pr: 7 }, stats);
  return r;
}
const rigWithEvidence = options => { const r = trustRig(options); r.addAnchor(); r.addCi(); return r; };

test('trustedRecord: a pinned anchor and a verified run give a record in W4\'s schema', () => {
  const r = rigWithEvidence();
  const record = r.trust();
  assert.deepEqual(Object.keys(record).sort(), ['base_sha', 'created_at', 'files', 'files_source', 'head_sha', 'merge_sha', 'non_gating_jobs', 'policy_digest',
    'policy_in_files', 'pr_number', 'run_attempt', 'run_id', 'schema', 'selection', 'suites_passed'].sort());
  assert.equal(queueSelection.validateRecord(record, r.headSha), record);
  assert.equal(queueSelection.pickRecord([record], r.headSha), record);
  assert.deepEqual([record.base_sha, record.head_sha, record.merge_sha, record.pr_number, record.run_id, record.run_attempt, record.suites_passed, record.policy_in_files],
    [r.baseSha, r.headSha, r.merge, 7, 800, 1, true, false]);
  assert.deepEqual(record.files, ['src/a.ts']);
  assert.equal(record.policy_digest, 'd'.repeat(64));
  assert.deepEqual(Object.keys(record.selection), queueSelection.CLASSIFIER_KEYS);
  assert.equal(record.selection.integration, 'false', 'the classifier ran with --pull-request');
});

test('trustedRecord: an anchor from a candidate-copy run is anchor_not_pinned, and is never downloaded', () => {
  const r = trustRig();
  r.addAnchor({ run: { workflow_id: LISTED_GATE_ID } });
  r.addCi();
  const stats = {};
  assert.deepEqual(r.trust(stats).reason, 'anchor_not_pinned');
  assert.deepEqual(r.state.downloads, []);
  assert.equal(stats.not_pinned.length, 1);
  assert.match(stats.not_pinned[0].why, /listed/);
});

test('trustedRecord: an identity line naming another ref is anchor_not_pinned', () => {
  const r = trustRig();
  r.addAnchor({ identity: `2026-11-06T16:30:13.0Z ci-gate-identity: workflow_ref=${REPO}/${GATE_PATH}@refs/heads/fork workflow_sha=${'f'.repeat(40)} gate_run=900 gate_attempt=1\n` });
  r.addCi();
  assert.equal(r.trust().reason, 'anchor_not_pinned');
});

test('trustedRecord: a workflow sha not on main is anchor_not_pinned', () => {
  const r = trustRig();
  r.addAnchor({ identity: `2026-11-06T16:30:13.0Z ci-gate-identity: workflow_ref=${PINNED_REF} workflow_sha=${r.headSha} gate_run=900 gate_attempt=1\n` });
  r.addCi();
  r.io.git(['fetch', '--no-tags', '--quiet', 'origin', r.headSha]);
  assert.equal(r.trust().reason, 'anchor_not_pinned');
});

test('trustedRecord: a candidate-copy anchor beside a pinned one adds nothing', () => {
  const r = trustRig();
  r.addAnchor({ id: 901 });
  r.addAnchor({ id: 500, run: { workflow_id: LISTED_GATE_ID }, anchor: { base_sha: 'a'.repeat(40), files: ['forged.ts'] } });
  r.addCi();
  const record = r.trust();
  assert.equal(record.base_sha, r.baseSha);
  assert.deepEqual(record.files, ['src/a.ts']);
  assert.deepEqual(r.state.downloads, ['901/ci-gate-anchor-attempt-1']);
});

test('trustedRecord: a same-named run at another path is not looked at, which is no_anchor', () => {
  const r = trustRig();
  r.addAnchor({ run: { path: '.github/workflows/ci-gate-2.yml', name: 'CI Gate' } });
  r.addCi();
  assert.equal(r.trust().reason, 'no_anchor');
  assert.deepEqual(r.state.downloads, []);
});

test('trustedRecord: two anchors for one head give the oldest base and the union of files', () => {
  const r = trustRig();
  const newerBase = r.inOrigin('commit-tree', `${r.baseSha}^{tree}`, '-p', r.baseSha, '-m', 'main moved');
  // Listed newest first, as the API does: the rule must not depend on the order.
  r.addAnchor({ id: 902, anchor: { base_sha: newerBase, files: ['src/a.ts', 'src/b.ts'], policy_digest: 'e'.repeat(64) } });
  r.addAnchor({ id: 901, anchor: { files: ['src/a.ts', 'src/c.ts'] } });
  r.addCi();
  const record = r.trust();
  assert.equal(record.base_sha, r.baseSha);
  assert.deepEqual([...record.files].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(record.policy_digest, 'd'.repeat(64), 'the digest belongs to the oldest base');
});

test('trustedRecord: a policy path in any anchor is anchor_policy_in_p', () => {
  const r = trustRig();
  r.addAnchor({ id: 901 });
  r.addAnchor({ id: 902, anchor: { policy_in_files: true, policy_digest: null, files: ['.github/workflows/foo.yml'] } });
  r.addCi();
  assert.equal(r.trust().reason, 'anchor_policy_in_p');
});

test('trustedRecord: no anchor at all, or only an expired one, is no_anchor', () => {
  const none = trustRig();
  none.addCi();
  assert.equal(none.trust().reason, 'no_anchor');
  const expired = trustRig();
  expired.addAnchor({ expired: true });
  expired.addCi();
  assert.equal(expired.trust().reason, 'no_anchor');
  assert.deepEqual(expired.state.downloads, []);
});

const BAD_ANCHORS = [
  ['another head', r => ({ head_sha: r.baseSha })],
  ['another PR', () => ({ pr_number: 8 })],
  ['another run', () => ({ run_id: 901 })],
  ['another attempt', () => ({ run_attempt: 2 })],
  ['another schema', () => ({ schema: 2 })],
  ['a base that is not a sha', () => ({ base_sha: 'main' })],
  ['a merge that is not a sha', () => ({ merge_sha: null })],
  ['files that are not a list of strings', () => ({ files: 'src/a.ts' })],
  ['a files_source other than merge-commit', () => ({ files_source: 'api' })],
  ['a digest missing with no policy path', () => ({ policy_digest: null })],
  ['policy_in_files that is not a boolean', () => ({ policy_in_files: 'false' })],
];
for (const [name, bad] of BAD_ANCHORS) {
  test(`trustedRecord: an anchor with ${name} is rejected, which is no_anchor`, () => {
    const r = trustRig();
    r.addAnchor({ anchor: bad(r) });
    r.addCi();
    const stats = {};
    assert.equal(r.trust(stats).reason, 'no_anchor');
    assert.equal(stats.rejected.length, 1);
  });
}

test('trustedRecord: an artifact whose file is not JSON is rejected, not a crash', () => {
  const r = trustRig();
  r.addAnchor();
  r.state.files['900/ci-gate-anchor-attempt-1'] = { [gate.ANCHOR_FILE]: '{' };
  r.addCi();
  assert.equal(r.trust().reason, 'no_anchor');
});

test('suites_passed: true needs IS_PR=true, the base classifier and --pull-request', () => {
  // Integration ran and passed: under --pull-request the flag is false, so the
  // three-branch rule rejects it. Without --pull-request it would have passed.
  const ran = trustRig();
  ran.addAnchor();
  ran.addCi({ attempts: [api(['Detect', 'success'], ['Lint', 'success'], ['Integration', 'success'])] });
  assert.equal(ran.trust().reason, 'no_verified_pr_run');
  // Integration skipped: passes only because --pull-request gated it.
  assert.equal(rigWithEvidence().trust().suites_passed, true);
});

test('suites_passed: the classifier and script come from base_sha, never from the merge or the head', () => {
  const editedCi = tinyCi.replace('[[ "${LINT_RESULT}" == "success" ]] || exit 4', 'true');
  const r = trustRig({ headFiles: { 'src/a.ts': 'a\n', [CI_PATH]: editedCi, [`${SCRIPTS}/classify-pr-paths.sh`]: `#!/usr/bin/env bash\nexit 0\n` } });
  r.addAnchor();
  r.addCi({ attempts: [api(['Detect', 'success'], ['Lint', 'failure'], ['Integration', 'skipped'])] });
  assert.equal(r.trust().reason, 'no_verified_pr_run', 'the candidate script waved a failed Lint through');
});

test('suites_passed: the base classifier sets the flags, though the merge commit edits it to say otherwise', () => {
  // The merge's classifier demands integration; the base's gates it off, so a skipped Integration passes.
  const demanding = prGatedClassifier.replace('integration=false', 'integration=true');
  const r = trustRig({ headFiles: { 'src/a.ts': 'a\n', [`${SCRIPTS}/classify-pr-paths.sh`]: demanding } });
  r.addAnchor();
  r.addCi();
  const record = r.trust();
  assert.equal(record.suites_passed, true);
  assert.equal(record.selection.integration, 'false');
});

test('suites_passed: job display names come from the merge commit, which is the ci.yml that ran', () => {
  const renamed = tinyCi.replace('name: Lint', 'name: Lint (renamed)');
  const r = trustRig({ headFiles: { 'src/a.ts': 'a\n', [CI_PATH]: renamed } });
  r.addAnchor();
  r.addCi({ attempts: [api(['Detect', 'success'], ['Lint (renamed)', 'success'], ['Integration', 'skipped'])] });
  assert.equal(r.trust().suites_passed, true);
});

test('suites_passed: a job id removed by the candidate is a failed verification', () => {
  const removed = tinyCi.replace('  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n', '').replace('needs: [changes, lint, integration-test]', 'needs: [changes, integration-test]');
  const r = trustRig({ headFiles: { 'src/a.ts': 'a\n', [CI_PATH]: removed } });
  r.addAnchor();
  r.addCi({ attempts: [api(['Detect', 'success'], ['Integration', 'skipped'])] });
  assert.equal(r.trust().reason, 'no_verified_pr_run');
});

test('suites_passed: a forged provenance.json has no effect, and is never read', () => {
  const forged = JSON.stringify({ schema: 1, head_sha: 'x', suites_passed: true, files: [], files_source: 'merge-commit', base_sha: 'a'.repeat(40) });
  // It cannot make a failed run pass.
  const red = trustRig();
  red.addAnchor();
  red.addCi({ attempts: [prJobs([['Other', 'skipped']]).map(job => job.name === 'Lint' ? { ...job, conclusion: 'failure' } : job)] });
  red.state.artifacts[800] = [{ name: 'ci-provenance-attempt-1', expired: false }];
  red.state.files['800/ci-provenance-attempt-1'] = { 'provenance.json': forged };
  assert.equal(red.trust().reason, 'no_verified_pr_run');
  assert.deepEqual(red.state.downloads, ['900/ci-gate-anchor-attempt-1']);
  // It cannot narrow a passing one either.
  const green = rigWithEvidence();
  green.state.artifacts[800] = [{ name: 'ci-provenance-attempt-1', expired: false }];
  green.state.files['800/ci-provenance-attempt-1'] = { 'provenance.json': forged };
  assert.deepEqual(green.trust().files, ['src/a.ts']);
  assert.deepEqual(green.state.downloads, ['900/ci-gate-anchor-attempt-1']);
});

test('partial re-run: the latest attempt rules, in both directions', () => {
  const failedThenFixed = [api(['Detect', 'success'], ['Lint', 'failure'], ['Integration', 'skipped']), prJobs()];
  const fixed = trustRig();
  fixed.addAnchor();
  fixed.addCi({ attempts: failedThenFixed });
  const record = fixed.trust();
  assert.equal(record.suites_passed, true);
  assert.equal(record.run_attempt, 2);
  const jobCalls = fixed.state.calls.flat().filter(arg => /\/runs\/800\/jobs/.test(arg));
  assert.ok(jobCalls.length && jobCalls.every(arg => /filter=latest/.test(arg)), jobCalls.join());

  const passedThenBroke = [prJobs(), api(['Detect', 'success'], ['Lint', 'failure'], ['Integration', 'skipped'])];
  const broke = trustRig();
  broke.addAnchor();
  broke.addCi({ attempts: passedThenBroke });
  assert.equal(broke.trust().reason, 'no_verified_pr_run');
});

test('no_verified_pr_run: no CI run, or only runs that are not the pull_request ci.yml', () => {
  const none = trustRig();
  none.addAnchor();
  assert.equal(none.trust().reason, 'no_verified_pr_run');
  const others = trustRig();
  others.addAnchor();
  others.addCi({ id: 801, run: { event: 'merge_group' } });
  others.addCi({ id: 802, run: { path: '.github/workflows/ci-copy.yml' } });
  others.addCi({ id: 803, run: { head_sha: others.baseSha } });
  assert.equal(others.trust().reason, 'no_verified_pr_run');
});

test('no_verified_pr_run: a run for this head on another PR is not this PR\'s evidence; a fork run with no PR list is', () => {
  const other = trustRig();
  other.addAnchor();
  other.addCi({ run: { pull_requests: [{ number: 8 }] } });
  assert.equal(other.trust().reason, 'no_verified_pr_run');
  const fork = trustRig();
  fork.addAnchor();
  fork.addCi({ run: { pull_requests: [] } });
  assert.equal(fork.trust().suites_passed, true);
});

test('no_verified_pr_run: the newest run decides; an older green run does not rescue a newer red one', () => {
  const r = trustRig();
  r.addAnchor();
  r.addCi({ id: 801 });
  r.addCi({ id: 802, attempts: [api(['Detect', 'success'], ['Lint', 'failure'], ['Integration', 'skipped'])] });
  assert.equal(r.trust().reason, 'no_verified_pr_run');
  const newerGreen = trustRig();
  newerGreen.addAnchor();
  newerGreen.addCi({ id: 801, attempts: [api(['Detect', 'success'], ['Lint', 'failure'], ['Integration', 'skipped'])] });
  newerGreen.addCi({ id: 802 });
  assert.equal(newerGreen.trust().run_id, 802);
});

test('no_verified_pr_run: a run still going is not evidence, even with green jobs so far', () => {
  const r = trustRig();
  r.addAnchor();
  r.addCi({ run: { status: 'in_progress', conclusion: null } });
  assert.equal(r.trust().reason, 'no_verified_pr_run');
});

test('no_verified_pr_run: an anchor made after the run tested something else, so its base would not err old', () => {
  const r = trustRig();
  r.addAnchor({ run: { created_at: '2026-11-06T18:00:00Z' } });
  r.addCi({ run: { created_at: '2026-11-06T16:30:04Z' } });
  const stats = {};
  assert.equal(r.trust(stats).reason, 'no_verified_pr_run');
  assert.match(stats.verification, /anchor/);
  // The same event's two runs are created moments apart, either way round.
  const same = trustRig();
  same.addAnchor({ run: { created_at: '2026-11-06T16:30:09Z' } });
  same.addCi({ run: { created_at: '2026-11-06T16:30:04Z' } });
  assert.equal(same.trust().suites_passed, true);
});

test('no_verified_pr_run: a base that cannot be fetched is a failed verification, not a crash', () => {
  const r = trustRig();
  r.addAnchor({ anchor: { base_sha: 'a'.repeat(40) } });
  r.addCi();
  const stats = {};
  assert.equal(r.trust(stats).reason, 'no_verified_pr_run');
  assert.match(stats.verification, /cannot fetch/);
});

test('trustedRecord: an Actions API failure throws, so the shadow says error rather than a reason about the PR', () => {
  const r = rigWithEvidence();
  const gh = r.io.gh;
  r.io.sleep = () => {};
  r.io.gh = args => { if (args.some(arg => /\/actions\/workflows\?/.test(arg))) throw Error('HTTP 502'); return gh(args); };
  assert.throws(() => r.trust(), error => error.code === 'api_error');
});

test('trustedRecord: reads a job log with the flag new gh requires, and without it on a gh that lacks it', () => {
  const r = rigWithEvidence();
  const gh = r.io.gh;
  const seen = [];
  r.io.gh = args => {
    if (/\/logs$/.test(args.find(arg => arg.startsWith('repos/')) ?? '')) {
      seen.push(args.includes('--allow-escape-sequences'));
      if (args.includes('--allow-escape-sequences')) throw Error('unknown flag: --allow-escape-sequences');
    }
    return gh(args);
  };
  assert.equal(r.trust().suites_passed, true);
  assert.deepEqual(seen, [true, false]);
});

test('trustedRecord: a log that cannot be read at all is an API failure, not a pass', () => {
  const r = rigWithEvidence();
  const gh = r.io.gh;
  r.io.gh = args => { if (/\/logs$/.test(args.find(arg => arg.startsWith('repos/')) ?? '')) throw Error('HTTP 410'); return gh(args); };
  assert.throws(() => r.trust(), error => error.code === 'api_error');
});

test('trustedRecord: an invalid repository, head or PR throws before any API call', () => {
  const r = trustRig();
  r.io.repository = 'nope';
  assert.throws(() => r.trust(), error => error.code === 'invalid_repository');
  assert.equal(r.state.calls.length, 0);
  r.io.repository = REPO;
  assert.throws(() => gate.trustedRecord(r.io, { head: 'main', pr: 7 }));
  assert.throws(() => gate.trustedRecord(r.io, { head: r.headSha, pr: 0 }));
  assert.equal(r.state.calls.length, 0);
});

test('trustedRecord: more runs for a head than the API will list is not treated as a complete list', () => {
  const r = rigWithEvidence();
  const gh = r.io.gh;
  r.io.sleep = () => {};
  r.io.gh = args => {
    if (args.some(arg => /\/actions\/runs\?/.test(arg))) return JSON.stringify([{ total_count: 1001, workflow_runs: [] }]);
    return gh(args);
  };
  assert.throws(() => r.trust(), error => error.code === 'api_error');
});

// ── The base-revision io ─────────────────────────────────────────────────

test('baseRevisionIO: read and exists answer from the base, whatever the working tree holds', () => {
  const { io, base, cwd } = repo({ 'policy.txt': 'base\n', 'gone.txt': 'base\n' }, { 'policy.txt': 'head\n', 'gone.txt': null, 'new.txt': 'head\n' });
  assert.equal(readFileSync(join(cwd, 'policy.txt'), 'utf8'), 'head\n');
  const baseIo = gate.baseRevisionIO(io, base);
  assert.equal(baseIo.read('policy.txt'), 'base\n');
  assert.equal(baseIo.read('gone.txt'), 'base\n');
  assert.equal(baseIo.exists('policy.txt'), true);
  assert.equal(baseIo.exists('gone.txt'), true);
  assert.equal(baseIo.exists('new.txt'), false);
  assert.equal(baseIo.blob('policy.txt'), execFileSync('git', ['rev-parse', `${base}:policy.txt`], { cwd, encoding: 'utf8' }).trim());
});

test('baseRevisionIO: runs only the base classifier, from a temp copy, with no token in its environment', () => {
  const probe = `#!/usr/bin/env bash\ncat > /dev/null\n[[ -z "\${GH_TOKEN:-}" ]] || exit 7\nprintf 'code=base\\nargs=%s\\n' "$*"\n`;
  const { base, cwd } = repo({ [`${SCRIPTS}/classify-pr-paths.sh`]: probe }, { [`${SCRIPTS}/classify-pr-paths.sh`]: `#!/usr/bin/env bash\necho code=head\n` });
  const io = gate.createGateIO({ cwd, env: { PATH: process.env.PATH, GH_TOKEN: 'secret' } });
  const baseIo = gate.baseRevisionIO(io, base);
  assert.match(baseIo.exec('bash', [`${SCRIPTS}/classify-pr-paths.sh`], 'a\n'), /^code=base\nargs=\n$/);
  assert.match(baseIo.exec('bash', [`${SCRIPTS}/classify-pr-paths.sh`, '--pull-request'], 'a\n'), /args=--pull-request/);
  assert.throws(() => baseIo.exec('bash', ['evil.sh'], ''), /refuses/);
  assert.throws(() => baseIo.exec('node', [`${SCRIPTS}/classify-pr-paths.sh`], ''), /refuses/);
});

test('baseRevisionIO: the PR head comes from refs/pull, which needs no pull-requests permission', () => {
  const r = trustRig();
  r.inOrigin('update-ref', 'refs/pull/7/head', r.headSha);
  const baseIo = gate.baseRevisionIO(r.io, r.baseSha);
  assert.equal(baseIo.prHead(7), r.headSha);
  assert.equal(baseIo.prHead(8), '', 'no such PR');
  assert.throws(() => baseIo.prHead('7 --upload-pack=x'));
});

// ── The shadow line in verify ────────────────────────────────────────────

const selectionLines = io => io.all().filter(line => /^ci-gate-selection:/.test(line));
const SHADOW_OUT = { mode: 'shadow', reason: '', pr: 7, head: HEAD_SHA, B: BASE_SHA, p: ['a.ts'], thin_jobs: ['lint'], full_jobs: ['lint', 'test-api'], would_skip: ['test-api'] };

test('verify: logs one ci-gate-selection line, asked about the queue shas with the verdict\'s own flags', () => {
  const io = verifyIo();
  const asked = [];
  const code = gate.verify(io, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: (_, env, flags) => { asked.push([env.BASE_SHA, env.HEAD_SHA, flags]); return SHADOW_OUT; } });
  assert.equal(code, 0);
  assert.deepEqual(asked, [[BASE_SHA, HEAD_SHA, { code: 'true', rust: 'false' }]]);
  assert.equal(gateLines(io).length, 1);
  const lines = selectionLines(io);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ci-gate-selection: mode=shadow reason= pr=7 /);
  assert.match(lines[0], /would_skip=\["test-api"\]/);
  assert.ok(io.out.indexOf(gateLines(io)[0]) < io.out.indexOf(lines[0]), 'the verdict line lands first');
});

test('verify: the selection line carries the same fields as the candidate-side queue-selection line', () => {
  const io = verifyIo();
  gate.verify(io, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: () => SHADOW_OUT });
  const keys = [...selectionLines(io)[0].matchAll(/ (\w+)=/g)].map(match => match[1]);
  assert.deepEqual(keys, ['mode', 'reason', ...queueSelection.SHADOW_FIELDS]);
});

test('verify: an exception in the selection leaves the verdict untouched, both ways', () => {
  const boom = () => { throw Error('selection blew up'); };
  const pass = verifyIo();
  assert.equal(gate.verify(pass, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: boom }), 0);
  assert.match(gateLines(pass)[0], /verdict=pass reason=required_jobs_passed/);
  assert.equal(gateLines(pass).length, 1);
  assert.match(selectionLines(pass)[0], /^ci-gate-selection: mode=full reason=error /);
  assert.match(selectionLines(pass)[0], /selection blew up/);

  const fail = verifyIo();
  const red = () => passing({ verdict: 'fail', reason: 'required_jobs_failed:lint' });
  assert.equal(gate.verify(fail, verifyEnv(), { waitForCi: finished, verdict: red, selection: boom }), 1);
  assert.match(gateLines(fail)[0], /verdict=fail reason=required_jobs_failed:lint/);
});

test('verify: a selection that says thin cannot make a red entry green, nor full a green one red', () => {
  const red = verifyIo();
  assert.equal(gate.verify(red, verifyEnv(), { waitForCi: finished, verdict: () => passing({ verdict: 'fail', reason: 'required_jobs_failed:lint' }), selection: () => SHADOW_OUT }), 1);
  const green = verifyIo();
  assert.equal(gate.verify(green, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: () => ({ mode: 'full', reason: 'no_anchor' }) }), 0);
  assert.match(selectionLines(green)[0], /mode=full reason=no_anchor/);
});

test('verify: a failing stdout for the selection line does not change the exit code', () => {
  const io = verifyIo();
  const stdout = io.stdout;
  io.stdout = text => { if (/^ci-gate-selection:/.test(text)) throw Error('EPIPE'); stdout(text); };
  assert.equal(gate.verify(io, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: () => SHADOW_OUT }), 0);
});

test('verify: no flags means no selection is computed, and the line says so', () => {
  const noVerdict = verifyIo();
  const called = [];
  const selection = () => { called.push(1); return SHADOW_OUT; };
  assert.equal(gate.verify(noVerdict, verifyEnv(), { waitForCi: () => ({ reason: 'ci_cancelled' }), verdict: () => passing(), selection }), 1);
  assert.match(selectionLines(noVerdict)[0], /^ci-gate-selection: mode=full reason=no_base_flags /);
  const noFlags = verifyIo();
  assert.equal(gate.verify(noFlags, verifyEnv(), { waitForCi: finished, verdict: () => ({ verdict: 'fail', reason: 'base_unreadable', flags: null }), selection }), 1);
  assert.match(selectionLines(noFlags)[0], /reason=no_base_flags/);
  assert.deepEqual(called, []);
});

test('verify: paths in the selection line cannot start a line or carry a workflow command', () => {
  const io = verifyIo();
  gate.verify(io, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: () => ({ ...SHADOW_OUT, p: ['a\n::error::forged', '##[error]forged'], error: 'x\n::warning::y' }) });
  assert.equal(selectionLines(io).length, 1);
  assert.deepEqual(io.all().filter(line => /^(::|##\[)/.test(line)), []);
  assert.ok(!selectionLines(io)[0].includes('##['));
  assert.ok(!selectionLines(io)[0].includes('\n'));
});

test('verify: the selection is given a time limit that ends before the job timeout, and it is lifted after', () => {
  const io = verifyIo();
  const limits = [];
  io.limitTime = at => limits.push(at);
  const start = io.now();
  gate.verify(io, verifyEnv(), { waitForCi: finished, verdict: () => passing(), selection: () => SHADOW_OUT });
  assert.equal(limits[0] - start, 3 * MIN, 'three minutes, from a verify that had plenty left');
  assert.equal(limits.at(-1), Infinity);

  const late = verifyIo();
  const lateLimits = [];
  late.limitTime = at => lateLimits.push(at);
  const lateStart = late.now();
  const slowWait = () => { late.sleep(141 * MIN); return finished(); };
  gate.verify(late, verifyEnv(), { waitForCi: slowWait, verdict: () => passing(), selection: () => SHADOW_OUT });
  assert.equal(lateLimits[0] - lateStart, 143 * MIN, 'never past the point the job would time out');
});

test('limitTime: bounds every child and sleep on the gate io, and an unlimited io is unchanged', () => {
  const cwd = tempDir();
  const io = gate.createGateIO({ cwd, env: { PATH: process.env.PATH } });
  const started = Date.now();
  io.limitTime(Date.now() + 200);
  assert.throws(() => io.exec('sleep', ['30']));
  assert.ok(Date.now() - started < 10_000, 'the limit bounded the child');
  io.limitTime(Date.now() - 1);
  assert.throws(() => io.git(['--version']), error => error.code === 'selection_time_limit');
  assert.throws(() => io.runIsolated('true', []), error => error.code === 'selection_time_limit');
  const beforeSleep = Date.now();
  io.sleep(30_000);
  assert.ok(Date.now() - beforeSleep < 5_000, 'sleep is bounded too');
  io.limitTime(Infinity);
  assert.match(io.git(['--version']), /git version/);
  assert.equal(io.runIsolated('true', []), '');
});

// One PR head H on base B, one queue entry E squashed from it, all real commits.
function queueEntryRig({ headFiles = { 'docs/guide.md': '# x\n' }, baseFiles } = {}) {
  const r = trustRig({ baseFiles: baseFiles ?? { ...realPolicyFiles(), ...selectionPolicyFiles() }, headFiles });
  const entry = r.inOrigin('commit-tree', `${r.headSha}^{tree}`, '-p', r.baseSha, '-m', 'squash');
  r.inOrigin('update-ref', 'refs/pull/7/head', r.headSha);
  r.inOrigin('update-ref', 'refs/queue/entry', entry);
  r.entry = entry;
  r.lines.length = 0;
  const trustGh = r.io.gh;
  r.io.gh = args => {
    const endpoint = args.find(arg => arg.startsWith('repos/')) ?? '';
    if (endpoint.includes('actions/workflows/ci.yml/runs')) return JSON.stringify({ workflow_runs: [ciRun({ head_sha: entry, status: 'completed', conclusion: 'success' })] });
    if (/\/runs\/77\/jobs/.test(endpoint)) return JSON.stringify([{ jobs: [...docsOnlyJobs(), ciSuccessJob('completed', 'success')] }]);
    if (/\/runs\/77\/artifacts/.test(endpoint)) return JSON.stringify([{ artifacts: [] }]);
    return trustGh(args);
  };
  r.verifyEnv = over => verifyEnv({ GITHUB_WORKFLOW_SHA: r.workflowSha, BASE_SHA: r.baseSha, HEAD_SHA: entry, HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-7-${r.baseSha}`, GITHUB_STEP_SUMMARY: '', ...over });
  return r;
}
const selectionPolicyFiles = () => {
  const files = {};
  for (const path of ['apps/api/vitest.integration.config.ts', 'e2e-tests/playwright.config.ts', ...[...realCi.matchAll(/--config=([\w.-]+)/g)].map(match => `e2e-tests/${match[1]}`)]) {
    try { files[path] = readFileSync(join(REPO_ROOT, path), 'utf8'); } catch { /* not a config this ci.yml uses */ }
  }
  return files;
};
const fieldOf = (line, key) => JSON.parse(line.match(new RegExp(` ${key}=(.*?)(?= \\w+=|$)`))[1]);

test('verify: end to end, real commits and a pinned anchor give a thin selection in shadow', () => {
  const r = queueEntryRig();
  const digest = queueSelection.policyDigest(gate.createGateIO({ cwd: r.origin, env: { PATH: process.env.PATH } }), r.baseSha);
  r.addAnchor({ anchor: { files: ['docs/guide.md'], policy_digest: digest } });
  r.addCi({ attempts: [docsOnlyJobs()] });
  assert.equal(gate.verify(r.io, r.verifyEnv()), 0, r.lines.join('\n'));
  assert.match(lineOf(r)[0], /verdict=pass reason=required_jobs_passed/);
  const lines = r.lines.filter(line => /^ci-gate-selection:/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ci-gate-selection: mode=shadow reason= /, lines[0]);
  assert.equal(fieldOf(lines[0], 'head'), r.headSha);
  assert.equal(fieldOf(lines[0], 'B'), r.baseSha);
  assert.deepEqual(fieldOf(lines[0], 'p'), ['docs/guide.md']);
});

test('verify: end to end, the reads are the base revision\'s, though the checkout is the gate\'s own', () => {
  const r = queueEntryRig();
  const digest = queueSelection.policyDigest(gate.createGateIO({ cwd: r.origin, env: { PATH: process.env.PATH } }), r.baseSha);
  r.addAnchor({ anchor: { files: ['docs/guide.md'], policy_digest: digest } });
  r.addCi({ attempts: [docsOnlyJobs()] });
  // The clone is checked out at the pinned workflow sha, with no policy files at all.
  assert.throws(() => readFileSync(join(r.clone, CI_PATH)));
  gate.verify(r.io, r.verifyEnv());
  assert.match(r.lines.find(line => /^ci-gate-selection:/.test(line)), /mode=shadow/);
});

for (const [reason, setup] of [
  ['no_anchor', r => r.addCi({ attempts: [docsOnlyJobs()] })],
  ['anchor_not_pinned', r => { r.addAnchor({ run: { workflow_id: LISTED_GATE_ID } }); r.addCi({ attempts: [docsOnlyJobs()] }); }],
  ['anchor_policy_in_p', r => { r.addAnchor({ anchor: { policy_in_files: true, policy_digest: null, files: [CI_PATH] } }); r.addCi({ attempts: [docsOnlyJobs()] }); }],
  ['no_verified_pr_run', r => r.addAnchor({ anchor: { files: ['docs/guide.md'] } })],
]) {
  test(`verify: end to end, ${reason} is mode=full, thin equals full, and the verdict stands`, () => {
    const r = queueEntryRig();
    setup(r);
    assert.equal(gate.verify(r.io, r.verifyEnv()), 0, r.lines.join('\n'));
    const line = r.lines.find(text => /^ci-gate-selection:/.test(text));
    assert.match(line, new RegExp(`^ci-gate-selection: mode=full reason=${reason} `));
    assert.deepEqual(fieldOf(line, 'thin_jobs'), fieldOf(line, 'full_jobs'));
    assert.match(lineOf(r)[0], /verdict=pass reason=required_jobs_passed/);
  });
}

test('verify: end to end, the Actions API failing in the selection leaves the verdict, and logs error', () => {
  const r = queueEntryRig();
  r.io.sleep = () => {};
  const gh = r.io.gh;
  r.io.gh = args => { if (args.some(arg => /\/actions\/workflows\?/.test(arg))) throw Error('HTTP 502'); return gh(args); };
  assert.equal(gate.verify(r.io, r.verifyEnv()), 0, r.lines.join('\n'));
  assert.match(r.lines.find(text => /^ci-gate-selection:/.test(text)), /mode=full reason=error /);
});

// ── The candidate-side shadow is untouched ───────────────────────────────

test('queue_shadow in ci.yml is byte-identical', () => {
  const start = realCi.indexOf('      - name: Queue selection shadow\n');
  const end = realCi.indexOf('\n  # ─── Docs check', start);
  assert.ok(start > 0 && end > start);
  assert.equal(realCi.slice(start, end), `      - name: Queue selection shadow
        id: queue_shadow
        if: github.event_name == 'merge_group'
        continue-on-error: true
        timeout-minutes: 5
        run: |
          node .github/scripts/queue-selection.mjs shadow
        env:
          GH_TOKEN: \${{ github.token }}
          EVENT_NAME: \${{ github.event_name }}
          HEAD_REF: \${{ github.event.merge_group.head_ref }}
          BASE_SHA: \${{ github.event.merge_group.base_sha }}
          HEAD_SHA: \${{ github.event.merge_group.head_sha }}
          FULL_SELECTION: \${{ toJSON(steps.classify.outputs) }}
`);
});

test('verify: no trust code runs in the candidate-side shadow CLI', () => {
  const source = readFileSync(join(REPO_ROOT, '.github/scripts/queue-selection.mjs'), 'utf8');
  assert.ok(!/recordSource\s*[:=]/.test(source), 'queue-selection.mjs never sets a source; only the gate injects one');
  assert.ok(!/ci-gate/.test(source), 'and it does not import the gate');
});

test('docs: the runbook explains the selection line and that it never changes a verdict', () => {
  const merge = readFileSync(join(REPO_ROOT, 'docs/agents/merge-and-deploy.md'), 'utf8');
  assert.match(merge, /`ci-gate-selection: /);
  assert.match(merge, /never changes? a verdict/);
  for (const reason of ['no_anchor', 'anchor_not_pinned', 'anchor_policy_in_p', 'no_verified_pr_run', 'no_base_flags']) {
    assert.ok(merge.includes(`\`${reason}\``), `${reason} is not in the runbook`);
  }
});
