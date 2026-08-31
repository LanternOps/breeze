import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-migration-immutability.sh');
const tempRoots = [];

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix = 'migration-immutability-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, contents) {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function commit(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function initRepo() {
  const repo = tempDir();
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Migration Guard Test');
  git(repo, 'config', 'user.email', 'migration-guard@example.com');
  write(repo, 'apps/api/migrations/2026-01-01-base.sql', 'SELECT 1;\n');
  write(repo, 'apps/api/src/db/autoMigrate.ts', 'export const CHECKSUM_RECONCILIATIONS = {};\n');
  commit(repo, 'base migration');
  return repo;
}

function tag(repo, name, { annotated = false } = {}) {
  if (annotated) git(repo, 'tag', '-a', name, '-m', name);
  else git(repo, 'tag', name);
  return git(repo, 'rev-parse', `${name}^{commit}`);
}

function candidateLedger(repo, rows) {
  write(
    repo,
    '.github/release-provenance/candidate-tags.tsv',
    `# tag\tcommit\tintegration ref\tnote\n${rows.join('\n')}\n`,
  );
}

function sideBranchLedger(repo, rows) {
  write(
    repo,
    '.github/release-provenance/side-branch-tags.tsv',
    `# tag\tmain equivalent\tnote\n${rows.join('\n')}\n`,
  );
}

function runGuard(repo, ...args) {
  const result = spawnSync('bash', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  return {
    ...result,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function expectOk(result) {
  assert.equal(result.status, 0, result.output);
}

function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, pattern);
}

function addRegisteredCandidate(repo, { tagName = 'v1.1.0-rc.1' } = {}) {
  git(repo, 'branch', 'candidate');
  git(repo, 'switch', 'candidate');
  write(repo, 'apps/api/migrations/2026-01-02-candidate.sql', 'SELECT 2;\n');
  commit(repo, 'candidate migration');
  const sha = tag(repo, tagName);
  git(repo, 'switch', 'main');
  candidateLedger(repo, [`${tagName}\t${sha}\tissue/test\tfixture candidate`]);
  commit(repo, 'register candidate');
  return sha;
}

test('selects the highest ancestor and excludes an exact higher candidate', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  addRegisteredCandidate(repo);

  const result = runGuard(repo);

  expectOk(result);
  assert.match(result.output, /primary baseline v1\.0\.0/);
  assert.match(result.output, /candidate v1\.1\.0-rc\.1/);
});

test('does not treat candidate-only migrations as deletions from main', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  addRegisteredCandidate(repo);

  const result = runGuard(repo);

  expectOk(result);
  assert.doesNotMatch(result.output, /2026-01-02-candidate\.sql.*deleted/);
});

test('rejects edits, deletions, and renames against their ancestral baseline', () => {
  const repo = initRepo();
  write(repo, 'apps/api/migrations/2026-01-02-delete.sql', 'SELECT 2;\n');
  write(repo, 'apps/api/migrations/2026-01-03-rename.sql', 'SELECT 3;\n');
  commit(repo, 'more shipped migrations');
  tag(repo, 'v1.0.0');
  write(repo, 'apps/api/migrations/2026-01-01-base.sql', 'SELECT 10;\n');
  rmSync(join(repo, 'apps/api/migrations/2026-01-02-delete.sql'));
  git(repo, 'mv', 'apps/api/migrations/2026-01-03-rename.sql', 'apps/api/migrations/2026-01-03-renamed.sql');

  const result = runGuard(repo);

  expectFailure(result, /v1\.0\.0/);
  assert.match(result.output, /M 2026-01-01-base\.sql/);
  assert.match(result.output, /D 2026-01-02-delete\.sql/);
  assert.match(result.output, /D 2026-01-03-rename\.sql/);
});

test('preserves exact checksum reconciliation for an edited shipped migration', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  write(repo, 'apps/api/migrations/2026-01-01-base.sql', 'SELECT 10;\n');
  write(
    repo,
    'apps/api/src/db/autoMigrate.ts',
    "export const CHECKSUM_RECONCILIATIONS = { '2026-01-01-base.sql': { from: 'old', to: 'new' } };\n",
  );

  const result = runGuard(repo);

  expectOk(result);
  assert.match(result.output, /ALLOWED  M 2026-01-01-base\.sql/);
});

test('candidate descendants select the candidate tag and freeze its migrations', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  addRegisteredCandidate(repo);
  git(repo, 'switch', 'candidate');
  write(repo, 'apps/api/migrations/2026-01-02-candidate.sql', 'SELECT 20;\n');

  const result = runGuard(repo);

  expectFailure(result, /v1\.1\.0-rc\.1/);
  assert.match(result.output, /M 2026-01-02-candidate\.sql/);
});

test('rejects an unregistered higher tag', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  git(repo, 'switch', '-c', 'unknown-release');
  write(repo, 'apps/api/migrations/2026-01-02-unknown.sql', 'SELECT 2;\n');
  commit(repo, 'unknown release');
  tag(repo, 'v1.1.0-rc.1');
  git(repo, 'switch', 'main');

  expectFailure(runGuard(repo), /unclassified higher release tag 'v1\.1\.0-rc\.1'/);
});

test('rejects a candidate registry SHA mismatch', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  const candidateSha = addRegisteredCandidate(repo);
  const wrongSha = `${candidateSha.slice(0, -1)}${candidateSha.endsWith('0') ? '1' : '0'}`;
  candidateLedger(repo, [`v1.1.0-rc.1\t${wrongSha}\tissue/test\twrong fixture SHA`]);

  expectFailure(runGuard(repo), /candidate registry SHA mismatch.*v1\.1\.0-rc\.1/);
});

function setupSideBranchBaseline() {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  git(repo, 'switch', '-c', 'hotfix');
  write(repo, 'apps/api/migrations/2026-01-02-hotfix.sql', 'SELECT 2;\n');
  commit(repo, 'side release');
  tag(repo, 'v1.1.0');
  git(repo, 'switch', 'main');
  write(repo, 'apps/api/migrations/2026-01-02-hotfix.sql', 'SELECT 2;\n');
  const equivalentSha = commit(repo, 'main equivalent');
  sideBranchLedger(repo, [`v1.1.0\t${equivalentSha}\tfixture hotfix`]);
  commit(repo, 'register side release');
  return { repo, equivalentSha };
}

test('adds a higher stable side-branch baseline when its equivalent is reachable', () => {
  const { repo } = setupSideBranchBaseline();

  const result = runGuard(repo);

  expectOk(result);
  assert.match(result.output, /additional side-branch baseline v1\.1\.0/);
});

test('an applicable side-branch baseline detects mutation and deletion', () => {
  const { repo } = setupSideBranchBaseline();
  write(repo, 'apps/api/migrations/2026-01-02-hotfix.sql', 'SELECT 20;\n');

  const result = runGuard(repo);

  expectFailure(result, /v1\.1\.0/);
  assert.match(result.output, /M 2026-01-02-hotfix\.sql/);
});

test('rejects a side-branch record whose equivalent is stale', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  git(repo, 'switch', '-c', 'hotfix');
  write(repo, 'apps/api/migrations/2026-01-02-hotfix.sql', 'SELECT 2;\n');
  const staleSha = commit(repo, 'unmerged side commit');
  tag(repo, 'v1.1.0');
  git(repo, 'switch', 'main');
  sideBranchLedger(repo, [`v1.1.0\t${staleSha}\tstale fixture`]);
  commit(repo, 'register stale side release');

  expectFailure(runGuard(repo), /recorded equivalent.*v1\.1\.0.*not reachable/);
});

test('skips when no releases exist', () => {
  const repo = initRepo();
  const result = runGuard(repo);
  expectOk(result);
  assert.match(result.output, /no v\* release tag found; skipping/);
});

test('fails when tags exist but none is reachable from the checked lineage', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  git(repo, 'switch', '--orphan', 'unrelated');
  write(repo, 'apps/api/migrations/2026-02-01-unrelated.sql', 'SELECT 2;\n');
  write(repo, 'apps/api/src/db/autoMigrate.ts', 'export const CHECKSUM_RECONCILIATIONS = {};\n');
  commit(repo, 'unrelated lineage');

  expectFailure(runGuard(repo), /no reachable release baseline/);
});

test('an explicit base remains deterministic despite higher unrelated tags', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0');
  git(repo, 'switch', '-c', 'other');
  write(repo, 'apps/api/migrations/2026-01-02-other.sql', 'SELECT 2;\n');
  commit(repo, 'other release');
  tag(repo, 'v9.0.0');
  git(repo, 'switch', 'main');

  const result = runGuard(repo, 'v1.0.0');

  expectOk(result);
  assert.match(result.output, /against v1\.0\.0/);
});

test('SemVer precedence selects a stable release over its prerelease', () => {
  const repo = initRepo();
  tag(repo, 'v1.1.0-rc.3');
  write(repo, 'apps/api/migrations/2026-01-02-stable.sql', 'SELECT 2;\n');
  commit(repo, 'stable release');
  tag(repo, 'v1.1.0');

  const result = runGuard(repo);

  expectOk(result);
  assert.match(result.output, /primary baseline v1\.1\.0(?:\s|$)/);
});

test('SemVer precedence handles hyphenated prerelease identifiers', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0-alpha.1');
  write(repo, 'apps/api/migrations/2026-01-02-alpha-hyphen.sql', 'SELECT 2;\n');
  commit(repo, 'hyphenated prerelease');
  tag(repo, 'v1.0.0-alpha-1');
  write(repo, 'apps/api/migrations/2026-01-02-alpha-hyphen.sql', 'SELECT 20;\n');

  const result = runGuard(repo);

  expectFailure(result, /v1\.0\.0-alpha-1/);
  assert.match(result.output, /primary baseline v1\.0\.0-alpha-1/);
  assert.match(result.output, /M 2026-01-02-alpha-hyphen\.sql/);
});

test('automatic mode rejects leading-zero SemVer identifiers', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0-01');

  expectFailure(runGuard(repo), /invalid.*SemVer|leading zero/i);
});

test('peels an annotated primary tag and reports it on mutation', () => {
  const repo = initRepo();
  tag(repo, 'v1.0.0', { annotated: true });
  write(repo, 'apps/api/migrations/2026-01-01-base.sql', 'SELECT 10;\n');

  const result = runGuard(repo);

  expectFailure(result, /v1\.0\.0/);
  assert.match(result.output, /M 2026-01-01-base\.sql/);
});

test('checks behind-mainline before excluding a retained candidate row', () => {
  const seed = initRepo();
  tag(seed, 'v1.0.0');
  git(seed, 'switch', '-c', 'candidate');
  write(seed, 'apps/api/migrations/2026-01-02-candidate.sql', 'SELECT 2;\n');
  const candidateSha = commit(seed, 'candidate release');
  tag(seed, 'v1.1.0-rc.1');
  git(seed, 'switch', 'main');
  candidateLedger(seed, [`v1.1.0-rc.1\t${candidateSha}\tissue/test\tretained candidate`]);
  const staleSha = commit(seed, 'retain candidate record');
  git(seed, 'branch', 'stale', staleSha);
  git(seed, 'merge', '--no-ff', 'candidate', '-m', 'merge candidate to main');

  const bare = tempDir('migration-immutability-origin-');
  git(bare, 'init', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(seed, 'remote', 'add', 'origin', pathToFileURL(bare).href);
  git(seed, 'push', '--all', 'origin');
  git(seed, 'push', '--tags', 'origin');
  const clone = tempDir('migration-immutability-clone-');
  git(dirname(clone), 'clone', pathToFileURL(bare).href, clone);
  git(clone, 'switch', '--track', 'origin/stale');

  const result = runGuard(clone);

  expectFailure(result, /behind mainline release 'v1\.1\.0-rc\.1'/);
  assert.doesNotMatch(result.output, /excluding.*candidate/);
});

test('fails closed in a shallow file URL clone before selecting a baseline', () => {
  const seed = initRepo();
  tag(seed, 'v1.0.0');
  write(seed, 'apps/api/migrations/2026-01-02-later.sql', 'SELECT 2;\n');
  commit(seed, 'later main commit');
  const bare = tempDir('migration-immutability-shallow-origin-');
  git(bare, 'init', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(seed, 'remote', 'add', 'origin', pathToFileURL(bare).href);
  git(seed, 'push', '--all', 'origin');
  git(seed, 'push', '--tags', 'origin');
  const clone = tempDir('migration-immutability-shallow-clone-');
  git(dirname(clone), 'clone', '--depth=1', pathToFileURL(bare).href, clone);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');

  expectFailure(runGuard(clone), /shallow repository cannot prove migration release ancestry/);
});
