import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseMap, plan } from './run-reader-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = ['apps/api/src/config/turnPeerRestrictions.test.ts', 'apps/api/src/config/redisEvictionPolicyDocs.test.ts'];
const web = 'apps/web/src/components/devices/time/timeSyncDocs.test.ts';
const script = 'scripts/agents/build-agents-md.test.mjs';
test('parseMap ignores comments and blank lines, splitting on whitespace', () => {
  assert.deepEqual(parseMap(`# heading\n\n${script}\t CLAUDE.md # inline\n`), [{ test: script, pattern: 'CLAUDE.md' }]);
});
test('plan groups tests by owning package and node runner with exact arguments', () => {
  assert.deepEqual(plan([...api, web, script], []), [
    { cmd: 'pnpm', args: ['--filter', './apps/api', 'exec', 'vitest', 'run', 'src/config/turnPeerRestrictions.test.ts', 'src/config/redisEvictionPolicyDocs.test.ts'], cwd: root },
    { cmd: 'pnpm', args: ['--filter', './apps/web', 'exec', 'vitest', 'run', 'src/components/devices/time/timeSyncDocs.test.ts'], cwd: root },
    { cmd: 'node', args: ['--test', script], cwd: root },
  ]);
});
test('empty selection runs every distinct mapped reader', () => {
  assert.deepEqual(plan([], [{ test: script }, { test: script }, { test: api[0] }]), plan([script, api[0]], []));
});
test('nothing to run is an error', () => assert.throws(() => plan([], []), /nothing|empty/i));
for (const file of ['apps/api/src/nope.test.ts', '../x.test.ts', 'agent/x_test.go', 'scripts/x.test.ts', 'apps/api/../web/x.test.ts']) {
  test(`invalid or missing reader rejected: ${file}`, () => {
    assert.throws(() => plan([file], []), (error) => error.message.includes(file));
  });
}
function cli({ selection = script, exit = 0, map } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reader-runner-'));
  try {
    mkdirSync(join(dir, '.github/scripts'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(root, '.github/scripts/run-reader-tests.mjs'), join(dir, '.github/scripts/run-reader-tests.mjs'));
    const other = 'scripts/security/check-security-guards.test.mjs';
    for (const file of [script, other]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), '');
    }
    writeFileSync(join(dir, '.github/scripts/path-reader-map.txt'), map ?? `${script} CLAUDE.md\n${script} AGENTS.md\n${other} docs/*\n`);
    writeFileSync(join(dir, 'bin/node'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$CALLS"\nexit "$STUB_EXIT"\n', { mode: 0o755 });
    const calls = join(dir, 'calls');
    const run = spawnSync(process.execPath, [join(dir, '.github/scripts/run-reader-tests.mjs')], {
      encoding: 'utf8', cwd: dir,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, READER_TESTS: selection, CALLS: calls, STUB_EXIT: String(exit) },
    });
    let args = '';
    try { args = readFileSync(calls, 'utf8'); } catch { /* Validation must not start a command. */ }
    return { ...run, args, other };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('CLI invokes node --test for a selected mjs reader', () => {
  const out = cli();
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.args, `--test\n${script}\n`);
});
test('CLI propagates a failed command as exit 1', () => assert.equal(cli({ exit: 3 }).status, 1));
test('CLI empty selection runs all mapped mjs readers once and announces fail-closed', () => {
  const out = cli({ selection: '' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /fail-closed/);
  assert.equal(out.args, `--test\n${script}\n${out.other}\n`);
});
test('CLI validates the whole plan before running and exits 2 on invalid or empty input', () => {
  for (const options of [{ selection: `${script} ../bad.test.ts` }, { selection: '', map: '# empty\n' }]) {
    const out = cli(options);
    assert.equal(out.status, 2, out.stderr);
    assert.equal(out.args, '');
  }
});
