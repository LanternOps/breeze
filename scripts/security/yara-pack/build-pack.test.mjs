// Self-test for build-pack.sh's fail-closed gates (#6263 W03b): the pack.lock
// version lock (inputs hash + monotonic version vs. a base lock), the Forge tag
// pin and the forge.sha256 format. Each case runs a COPY of the script in a
// throwaway repo layout and mutates the copy; nothing here downloads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK = 'scripts/security/yara-pack';
const tmp = mkdtempSync(join(tmpdir(), 'yara-pack-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function layout() {
  const root = join(tmp, `case-${seq++}`);
  for (const rel of [PACK, 'agent/go.mod', 'agent/go.sum', 'agent/internal/yarascan/yarac/yarac.go']) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  }
  return root;
}
const run = (root, ...args) => spawnSync('bash', [join(root, PACK, 'build-pack.sh'), ...args], { encoding: 'utf8' });
const file = (root, rel) => join(root, rel);
const lockFile = (root) => file(root, `${PACK}/pack.lock`);
function setLock(root, { version, inputs }) {
  let t = readFileSync(lockFile(root), 'utf8');
  if (version !== undefined) t = t.replace(/^version=.*$/m, `version=${version}`);
  if (inputs !== undefined) t = t.replace(/^inputs_sha256=.*$/m, `inputs_sha256=${inputs}`);
  writeFileSync(lockFile(root), t);
}
const lockVersion = (root) => Number(readFileSync(lockFile(root), 'utf8').match(/^version=(\d+)$/m)[1]);
/** Re-seal the lock after an input edit (what a correct PR does). */
function reseal(root, version) {
  const h = run(root, '--print-inputs-hash');
  assert.equal(h.status, 0, h.stderr);
  setLock(root, { inputs: h.stdout.trim(), ...(version !== undefined ? { version } : {}) });
}
function baseLock(root) {
  const p = join(root, 'base-pack.lock');
  writeFileSync(p, readFileSync(lockFile(root)));
  return p;
}

test('the committed lock matches the committed inputs', () => {
  const r = run(layout(), '--check-lock');
  assert.equal(r.status, 0, r.stderr);
});

for (const [label, mutate] of [
  ['denylist.txt changes', (root) => appendFileSync(file(root, `${PACK}/denylist.txt`), 'SOME_RULE  matched /usr/bin/x\n')],
  ['LICENSES.allow changes', (root) => appendFileSync(file(root, `${PACK}/LICENSES.allow`), '# note\n')],
  ['filter.go changes', (root) => appendFileSync(file(root, `${PACK}/filter.go`), '\n// x\n')],
  ['forge.sha256 changes', (root) => writeFileSync(file(root, `${PACK}/forge.sha256`), `${'1'.repeat(64)}  20261011/yara-forge-rules-core.zip\n`)],
  ['the yarac compile policy changes', (root) => appendFileSync(file(root, 'agent/internal/yarascan/yarac/yarac.go'), '\n// policy\n')],
  ['the yaraxwasm engine pin changes', (root) => {
    const p = file(root, 'agent/go.mod');
    const t = readFileSync(p, 'utf8');
    const next = t.replace(/(github\.com\/niallnsec\/yaraxwasm )v[0-9.]+/, '$1v9.9.9');
    assert.notEqual(next, t, 'fixture precondition: agent/go.mod pins yaraxwasm');
    writeFileSync(p, next);
  }],
  ['inputs_sha256 is edited', (root) => setLock(root, { inputs: '0'.repeat(64) })],
]) {
  test(`--check-lock fails when ${label} without re-sealing pack.lock`, () => {
    const root = layout();
    mutate(root);
    const r = run(root, '--check-lock');
    assert.notEqual(r.status, 0, 'must fail closed');
    assert.match(r.stderr, /pack\.lock/);
  });
}

test('an unrelated agent dependency bump does not force a pack bump', () => {
  const root = layout();
  appendFileSync(file(root, 'agent/go.mod'), '\n// unrelated\n');
  const r = run(root, '--check-lock');
  assert.equal(r.status, 0, r.stderr);
});

test('against a base lock: same inputs + same version passes', () => {
  const root = layout();
  const r = run(root, '--check-lock', '--base-lock', baseLock(root));
  assert.equal(r.status, 0, r.stderr);
});

test('against a base lock: changed + re-sealed inputs need a strictly higher version', () => {
  const root = layout();
  const base = baseLock(root);
  appendFileSync(file(root, `${PACK}/denylist.txt`), 'SOME_RULE  matched /usr/bin/x\n');
  reseal(root);
  const same = run(root, '--check-lock', '--base-lock', base);
  assert.notEqual(same.status, 0, 'inputs changed at the same version must fail');
  assert.match(same.stderr, /bump/i);
  reseal(root, lockVersion(root) + 1);
  const bumped = run(root, '--check-lock', '--base-lock', base);
  assert.equal(bumped.status, 0, bumped.stderr);
});

test('against a base lock: a version that goes backwards fails', () => {
  const root = layout();
  setLock(root, { version: 5 });
  const base = baseLock(root);
  setLock(root, { version: 4 });
  const r = run(root, '--check-lock', '--base-lock', base);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /backwards|lower/i);
});

test('a missing base lock file is an error, not a silent skip', () => {
  const r = run(layout(), '--check-lock', '--base-lock', join(tmp, 'nope.lock'));
  assert.notEqual(r.status, 0);
});

test('a Forge tag argument other than the pin is refused before any download', () => {
  const r = run(layout(), '20990101');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not the pinned tag/);
});

test('a malformed forge.sha256 is refused even when the lock is re-sealed', () => {
  const root = layout();
  writeFileSync(file(root, `${PACK}/forge.sha256`), 'not-a-sha  20261004/yara-forge-rules-core.zip\n');
  reseal(root);
  const r = run(root, '--out', join(root, 'out'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /malformed sha256/);
});
