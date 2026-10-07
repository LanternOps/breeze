import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPolicy, matchPaths } from './release-path-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI = join(HERE, 'release-path-policy.mjs');
const binaryPolicy = loadPolicy(readFileSync(join(HERE, 'binary-affecting-paths.txt'), 'utf8'));
const agentFacingPolicy = loadPolicy(readFileSync(join(HERE, 'agent-facing-paths.txt'), 'utf8'));

const protectedPath = (path) => matchPaths(binaryPolicy, [path]).length === 1;

test('comments, blank lines and inline comments are ignored', () => {
  const rules = loadPolicy('# header\n\nagent/**   # the agent\n  \n!agent/keep.txt\n');
  assert.equal(rules.length, 2);
  assert.deepEqual(matchPaths(rules, ['agent/go.mod', 'agent/keep.txt', 'apps/api/x.ts']), ['agent/go.mod']);
});

test('`**` matches any depth and `*` stays within one segment', () => {
  const rules = loadPolicy('agent/**\n.github/workflows/release*.yml\napps/api/src/routes/backup/bmr*.ts\n');
  assert.deepEqual(matchPaths(rules, [
    'agent/go.mod',
    'agent/internal/deep/file.go',
    'agent',
    '.github/workflows/release.yml',
    '.github/workflows/release-promotion.yml',
    '.github/workflows/nested/release.yml',
    'apps/api/src/routes/backup/bmr.ts',
    'apps/api/src/routes/backup/bmrTokens.ts',
    'apps/api/src/routes/backup/bmr/x.ts',
  ]), [
    'agent/go.mod',
    'agent/internal/deep/file.go',
    '.github/workflows/release.yml',
    '.github/workflows/release-promotion.yml',
    'apps/api/src/routes/backup/bmr.ts',
    'apps/api/src/routes/backup/bmrTokens.ts',
  ]);
});

test('patterns are anchored at the repository root', () => {
  assert.ok(protectedPath('tsconfig.json'));
  assert.ok(!protectedPath('apps/api/tsconfig.json'));
  assert.ok(protectedPath('package.json'));
  assert.ok(!protectedPath('apps/api/package.json'));
  assert.ok(protectedPath('docker-compose.yml'));
  assert.ok(protectedPath('docker-compose.test.yml'));
  assert.ok(protectedPath('docker-compose.override.yml.dev'));
  assert.ok(protectedPath('deploy/docker-compose.prod.yml'), 'deploy/** covers the prod compose file');
  assert.ok(protectedPath('deploy/.env.example'));
});

test('the ledger negation exempts only the server-only ledger', () => {
  assert.ok(!protectedPath('.github/release-provenance/server-only-tags.tsv'));
  assert.ok(protectedPath('.github/release-provenance/candidate-tags.tsv'));
  assert.ok(protectedPath('.github/release-provenance/side-branch-tags.tsv'));
  assert.ok(protectedPath('.github/release-provenance/sslcom-tls-rsa-root-ca-2022.pem'));
});

test('by design: .github/scripts is protected wholesale; the root .env.example is exempt', () => {
  assert.ok(protectedPath('.github/scripts/check-workflow-security.mjs'));
  assert.ok(protectedPath('.github/scripts/anything/new.sh'));
  assert.ok(!protectedPath('.env.example'));
  // ...but it carries the release-manifest trust anchor, so every change is
  // listed for the required agent-facing review (and the guard separately
  // refuses any change to the key lines themselves).
  assert.deepEqual(matchPaths(agentFacingPolicy, ['.env.example', 'apps/api/.env.example']), ['.env.example']);
});

test('the protected set covers every binary and machinery class from the design', () => {
  for (const path of [
    'agent/go.mod',
    'agent/installer/breeze.wxs',
    'agent/recovery-media/build.sh',
    'apps/agent/internal/x.go',
    'apps/viewer/src-tauri/Cargo.lock',
    'apps/helper/src/main.tsx',
    'docker/Dockerfile.binaries',
    'scripts/release/check-release-lineage.sh',
    'scripts/security/check-agent-binary-signatures.sh',
    'scripts/guided-setup.sh',
    '.github/workflows/release.yml',
    '.github/workflows/release-promotion.yml',
    '.github/workflows/promote-release-images.yml',
    '.github/actions/setup/action.yml',
    'selfhost-signing-template/README.md',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.node-version',
    '.nvmrc',
    'patches/some-package.patch',
    'turbo.json',
  ]) {
    assert.ok(protectedPath(path), `${path} must force a full release`);
  }
});

test('ordinary server paths are not protected', () => {
  for (const path of [
    'apps/api/src/routes/devices.ts',
    'apps/api/migrations/2026-10-01-000000-x.sql',
    'apps/web/src/components/X.tsx',
    'apps/portal/src/pages/index.astro',
    'apps/m365-graph-read-executor/src/index.ts',
    'apps/api/Dockerfile',
    'docker/Dockerfile.api',
    'docs/runbooks/x.md',
    '.github/workflows/ci.yml',
    'scripts/prod/deploy.sh',
  ]) {
    assert.ok(!protectedPath(path), `${path} must not force a full release`);
  }
});

test('last matching rule wins, so a later re-exclusion restores the match', () => {
  const rules = loadPolicy('a/**\n!a/b.txt\na/b.txt\n');
  assert.deepEqual(matchPaths(rules, ['a/b.txt']), ['a/b.txt']);
});

test('literal regex metacharacters and spaces are matched literally', () => {
  const rules = loadPolicy('docs/a+b (1).md\n');
  assert.deepEqual(matchPaths(rules, ['docs/a+b (1).md', 'docs/aab (1).md']), ['docs/a+b (1).md']);
});

test('malformed patterns fail closed', () => {
  assert.throws(() => loadPolicy('/agent/**\n'), /repository-relative/u);
  assert.throws(() => loadPolicy('!\n'), /empty/u);
  assert.throws(() => loadPolicy('agent/../x\n'), /repository-relative/u);
});

test('every agent-facing pattern names at least one tracked file', () => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split('\0').filter(Boolean);
  for (const rule of agentFacingPolicy) {
    assert.ok(
      matchPaths([rule], files).length > 0,
      `agent-facing pattern ${rule.pattern} matches no tracked file — the list has drifted`,
    );
  }
});

test('CLI reads NUL- or newline-separated paths and prints the matches', () => {
  const policy = join(HERE, 'binary-affecting-paths.txt');
  const nul = spawnSync('node', [CLI, 'match', '--policy', policy], {
    input: 'apps/api/x.ts\0agent/with space.go\0.env.example\0',
    encoding: 'utf8',
  });
  assert.equal(nul.status, 0, nul.stderr);
  assert.equal(nul.stdout, 'agent/with space.go\n');

  const lines = spawnSync('node', [CLI, 'match', '--policy', policy], {
    input: 'pnpm-lock.yaml\napps/web/y.tsx\n',
    encoding: 'utf8',
  });
  assert.equal(lines.status, 0, lines.stderr);
  assert.equal(lines.stdout, 'pnpm-lock.yaml\n');

  const usage = spawnSync('node', [CLI, 'match'], { input: '', encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
});

test('CLI always ends with a completion trailer on stderr, even with zero matches', () => {
  const policy = join(HERE, 'binary-affecting-paths.txt');
  const some = spawnSync('node', [CLI, 'match', '--policy', policy], {
    input: 'apps/api/x.ts\0agent/go.mod\0apps/web/y.tsx\0',
    encoding: 'utf8',
  });
  assert.equal(some.status, 0, some.stderr);
  assert.equal(some.stderr, '# matched=1 of 3\n');

  const none = spawnSync('node', [CLI, 'match', '--policy', policy], { input: '', encoding: 'utf8' });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');
  assert.equal(none.stderr, '# matched=0 of 0\n', 'an empty change set must still be distinguishable from "did not run"');
});

test('CLI still runs when invoked through a symlinked directory (fails closed, never silently exits 0)', () => {
  const linkParent = mkdtempSync(join(tmpdir(), 'policy-link-'));
  try {
    const link = join(linkParent, 'release');
    symlinkSync(HERE, link);
    const result = spawnSync('node', [join(link, 'release-path-policy.mjs'), 'match', '--policy', join(link, 'binary-affecting-paths.txt')], {
      input: 'agent/go.mod\n',
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'agent/go.mod\n');
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
  }
});
