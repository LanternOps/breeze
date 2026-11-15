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
  const r = run(tree(job('      - name: Install\n        run: pnpm install --frozen-lockfile\n')));
  assert.equal(r.status, 0, r.stderr);
});

test('missing lockfile fails closed', () => {
  const r = run(tree(job('      - name: Install\n        working-directory: e2e-tests\n        run: npm ci\n'), { lockfile: false }));
  assert.equal(r.status, 1);
});

test('real repo workflows are pinned', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
