import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_PATH, diffLedger, parseLedger } from './server-only-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'server-only-ledger.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'server-only-ledger-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const row = (tag, commit, base = 'v0.118.0', note = 'portal fix') => `${tag}\t${commit}\t${base}\t${note}\n`;

test('the committed ledger is header-only and valid', () => {
  const text = readFileSync(join(HERE, '..', '..', LEDGER_PATH), 'utf8');
  assert.deepEqual(parseLedger(text), []);
  assert.match(text, /always created as a draft/u);
  assert.match(text, /Append-only once the tag exists/u);
});

test('parses well-formed rows and skips comments and blank lines', () => {
  const rows = parseLedger(`# header\n\n${row('v0.118.1', A)}${row('v0.118.2', B, 'v0.118.0', '#7123 portal proposal fix')}`);
  assert.deepEqual(rows.map(({ tag, commit, base, note }) => ({ tag, commit, base, note })), [
    { tag: 'v0.118.1', commit: A, base: 'v0.118.0', note: 'portal fix' },
    { tag: 'v0.118.2', commit: B, base: 'v0.118.0', note: '#7123 portal proposal fix' },
  ]);
});

test('refuses malformed rows', () => {
  const cases = [
    [`v0.118.1\t${A}\tv0.118.0\n`, /four non-empty tab-separated fields/u],
    [`v0.118.1\t${A}\tv0.118.0\tnote\textra\n`, /four non-empty tab-separated fields/u],
    [`v0.118.1 ${A} v0.118.0 note\n`, /four non-empty tab-separated fields/u],
    [row('v0.118.1-rc.1', A), /stable release tag/u],
    [row('0.118.1', A), /stable release tag/u],
    [row('v0.118.01', A), /stable release tag/u],
    [row('v0.118.1', 'A'.repeat(40)), /40-hex/u],
    [row('v0.118.1', A.slice(1)), /40-hex/u],
    [row('v0.118.1', A, 'v0.118.0-rc.1'), /base must be a stable release tag/u],
    [row('v0.118.1', A, 'v0.118.1'), /base must differ/u],
    [`v0.118.1\t${A}\tv0.118.0\t \n`, /four non-empty tab-separated fields/u],
    [`${row('v0.118.1', A)}${row('v0.118.1', B)}`, /duplicate tag/u],
    [`${row('v0.118.1', A)}${row('v0.118.2', A)}`, /duplicate commit/u],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => parseLedger(text), expected, JSON.stringify(text));
  }
});

test('diffLedger reports added, changed and removed rows by tag', () => {
  const before = `${row('v0.118.1', A)}${row('v0.118.2', B)}`;
  const afterText = `${row('v0.118.1', A, 'v0.118.0', 'edited note')}${row('v0.118.3', 'c'.repeat(40))}`;
  const diff = diffLedger(before, afterText);
  assert.deepEqual(diff.added.map((entry) => entry.tag), ['v0.118.3']);
  assert.deepEqual(diff.changed.map((entry) => entry.tag), ['v0.118.1']);
  assert.deepEqual(diff.removed.map((entry) => entry.tag), ['v0.118.2']);
  assert.deepEqual(diffLedger(before, before), { added: [], changed: [], removed: [] });
});

function gitRepo() {
  const repo = mkdtempSync(join(scratch, 'repo-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Ledger Test');
  git('config', 'user.email', 'ledger@example.invalid');
  const commit = (files) => {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), contents);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  return { repo, git, commit };
}

const cli = (repo, ...args) => spawnSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' });

test('CLI row: prints the row, exits 3 when unlisted or when the ledger is absent', () => {
  const { repo, commit } = gitRepo();
  const noLedger = commit({ 'x.txt': 'x\n' });
  const absent = cli(repo, 'row', '--ref', noLedger, '--tag', 'v0.118.1');
  assert.equal(absent.status, 3, absent.stderr);

  const withLedger = commit({ [LEDGER_PATH]: `# h\n${row('v0.118.1', A)}` });
  const listed = cli(repo, 'row', '--ref', withLedger, '--tag', 'v0.118.1');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, row('v0.118.1', A));

  const unlisted = cli(repo, 'row', '--ref', withLedger, '--tag', 'v0.118.2');
  assert.equal(unlisted.status, 3);

  const badRef = cli(repo, 'row', '--ref', 'does-not-exist', '--tag', 'v0.118.1');
  assert.equal(badRef.status, 1, 'an unresolvable ref must fail, never read as "not listed"');
});

test('CLI validate and changed', () => {
  const { repo, commit } = gitRepo();
  const base = commit({ [LEDGER_PATH]: `# h\n${row('v0.118.1', A)}` });
  const head = commit({ [LEDGER_PATH]: `# h\n${row('v0.118.1', A)}${row('v0.118.2', B)}` });
  assert.equal(cli(repo, 'validate', '--ref', head).status, 0);

  const changed = cli(repo, 'changed', '--base-ref', base, '--head-ref', head);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stdout, `added\tv0.118.2\t${B}\tv0.118.0\n`);

  const broken = commit({ [LEDGER_PATH]: `# h\nv0.118.3\tnope\n` });
  const invalid = cli(repo, 'validate', '--ref', broken);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /four non-empty tab-separated fields/u);
});
