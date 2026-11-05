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
      if (text === null) rmSync(join(cwd, path)); else writeFileSync(join(cwd, path), text);
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
