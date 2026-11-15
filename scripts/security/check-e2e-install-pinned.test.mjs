// Self-test for scripts/security/check-e2e-install-pinned.sh (#11197): a
// floating install of e2e-tests dependencies must fail, `npm ci` must pass,
// and the real repo workflows must currently pass. Runs against scratch trees.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/security/check-e2e-install-pinned.sh');
const tmp = mkdtempSync(join(tmpdir(), 'e2e-install-pinned-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function tree(workflow, { lockfile = true } = {}) {
  const root = join(tmp, `case-${seq++}`);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'e2e-tests'), { recursive: true });
  if (lockfile) writeFileSync(join(root, 'e2e-tests/package-lock.json'), '{}');
  writeFileSync(join(root, '.github/workflows/w.yml'), workflow);
  return root;
}
const run = (root) => spawnSync('bash', [SCRIPT, root], { encoding: 'utf8' });
const job = (step) => `jobs:\n  j:\n    steps:\n      - uses: actions/checkout@abc\n${step}      - name: Next\n        run: echo done\n`;

test('npm ci in e2e-tests passes', () => {
  const r = run(tree(job('      - name: Install\n        working-directory: e2e-tests\n        run: npm ci\n')));
  assert.equal(r.status, 0, r.stderr);
});

for (const cmd of ['pnpm install --ignore-workspace', 'npm install', 'pnpm i', 'yarn install']) {
  test(`floating "${cmd}" in e2e-tests fails`, () => {
    const r = run(tree(job(`      - name: Install\n        working-directory: e2e-tests\n        run: ${cmd}\n`)));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /npm ci/);
  });
}

test('run before working-directory ordering is still caught', () => {
  const r = run(tree(job('      - name: Install\n        run: pnpm install\n        working-directory: e2e-tests\n')));
  assert.equal(r.status, 1);
});

test('cd e2e-tests && floating install fails', () => {
  const r = run(tree(job('      - name: Install\n        run: cd e2e-tests && pnpm install\n')));
  assert.equal(r.status, 1);
});

test('pnpm install --frozen-lockfile at the workspace root is not flagged', () => {
  const r = run(tree(job('      - name: Ok\n        working-directory: e2e-tests\n        run: npm ci\n      - name: Install\n        run: pnpm install --frozen-lockfile\n')));
  assert.equal(r.status, 0, r.stderr);
});

const npmCiStep = '      - name: Ok\n        working-directory: e2e-tests\n        run: npm ci\n';
const withExtra = (extra) => job(npmCiStep + extra);

for (const [name, step] of Object.entries({
  'run: | block': '      - name: I\n        working-directory: e2e-tests\n        run: |\n          pnpm install\n',
  'quoted dir': '      - name: I\n        working-directory: "e2e-tests"\n        run: pnpm install\n',
  './ dir': '      - name: I\n        working-directory: ./e2e-tests\n        run: pnpm install\n',
  'dir with comment': '      - name: I\n        working-directory: e2e-tests # x\n        run: npm install\n',
  'flag before install': '      - name: I\n        working-directory: e2e-tests\n        run: pnpm --ignore-workspace install\n',
  '--dir': '      - name: I\n        run: pnpm --dir e2e-tests install\n',
  '--prefix': '      - name: I\n        run: npm --prefix e2e-tests install\n',
})) {
  test(`bypass shape is caught: ${name}`, () => {
    const r = run(tree(withExtra(step)));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /w\.yml:\d+:/);
  });
}

test('job-level defaults working-directory e2e-tests is caught', () => {
  const wf = 'jobs:\n  j:\n    defaults:\n      run:\n        working-directory: e2e-tests\n    steps:\n      - run: pnpm install\n';
  assert.equal(run(tree(wf)).status, 1);
});

test('floating install in another directory and pnpm exec are not flagged', () => {
  const r = run(tree(withExtra('      - name: W\n        working-directory: apps/web\n        run: pnpm install\n      - name: X\n        run: pnpm --dir e2e-tests exec playwright test\n')));
  assert.equal(r.status, 0, r.stderr);
});

test('composite action with a floating e2e-tests install is caught', () => {
  const root = tree(job(npmCiStep));
  mkdirSync(join(root, '.github/actions/a'), { recursive: true });
  writeFileSync(join(root, '.github/actions/a/action.yml'), 'runs:\n  using: composite\n  steps:\n    - run: npm install\n      working-directory: e2e-tests\n      shell: bash\n');
  assert.equal(run(root).status, 1);
});

test('no e2e-tests step at all fails closed', () => {
  assert.equal(run(tree(job('      - name: A\n        run: echo hi\n'))).status, 1);
});

test('missing lockfile fails closed', () => {
  const r = run(tree(job('      - name: Install\n        working-directory: e2e-tests\n        run: npm ci\n'), { lockfile: false }));
  assert.equal(r.status, 1);
});

test('real repo workflows are pinned', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
