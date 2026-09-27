// Server-only guard: tag/row/base refusals and base-tree execution.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  BOOTSTRAP,
  CANDIDATES,
  Fixture,
  LEDGER,
  SIDE_BRANCH,
  assertRefused,
  nextFixtureNumber,
  run,
  scratch,
} from './__fixtures__/server-only-guard.mjs';

// ── Refusals: tag, row and base ────────────────────────────────────────────
test('refuses when the declared base is not the computed base', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit, 'v0.117.0');
  assertRefused(fx.guard('v0.118.1', commit), /not the last full release .*computed 'v0\.118\.0'/u);
});

test('refuses a base that is itself a server-only release', () => {
  const fx = new Fixture();
  const first = fx.commit({ 'apps/api/src/fix.ts': 'fix 1\n' });
  fx.addRow('v0.118.1', first);
  fx.git('tag', 'v0.118.1', first);
  const second = fx.commit({ 'apps/api/src/fix.ts': 'fix 2\n' });
  fx.addRow('v0.118.2', second, 'v0.118.1');
  assertRefused(fx.guard('v0.118.2', second), /itself a server-only release/u);
});

test('refuses a base that is not an ancestor of the release commit', () => {
  const fx = new Fixture();
  fx.git('switch', '-q', '-c', 'side', 'v0.118.0');
  fx.commit({ 'apps/api/src/side.ts': 'side\n' });
  fx.git('tag', 'v0.119.0');
  fx.git('switch', '-q', 'main');
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.119.1', commit, 'v0.119.0');
  assertRefused(fx.guard('v0.119.1', commit), /is not an ancestor/u);
});

test('refuses a commit that is not reachable from main', () => {
  const fx = new Fixture();
  fx.git('switch', '-q', '-c', 'side');
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.git('switch', '-q', 'main');
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /not reachable from 'main'/u);
});

test('refuses a prerelease tag', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1-rc.1', commit);
  assertRefused(fx.guard('v0.118.1-rc.1', commit), /stable release tag/u);
});

test('refuses a tag that is not the globally highest stable version', () => {
  const fx = new Fixture();
  fx.git('switch', '-q', '-c', 'next-line', 'v0.118.0');
  fx.commit({ 'apps/api/src/next.ts': 'next\n' });
  fx.git('tag', 'v0.119.0');
  fx.git('switch', '-q', 'main');
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.2', commit);
  assertRefused(fx.guard('v0.118.2', commit), /not the globally highest stable version \(v0\.119\.0 exists\)/u);
});

test('refuses a tag that is also listed in another provenance ledger', () => {
  for (const other of [CANDIDATES, SIDE_BRANCH]) {
    const fx = new Fixture();
    const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
    fx.commit({ [other]: `# header\nv0.118.1\t${commit}\tnote\n` }, 'other ledger');
    fx.addRow('v0.118.1', commit);
    assertRefused(fx.guard('v0.118.1', commit), /exactly one provenance ledger/u);
  }
});

test('refuses a malformed ledger row', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.commit({ [LEDGER]: `# header\nv0.118.1\t${commit}\tv0.118.0\n` }, 'three fields');
  assertRefused(fx.guard('v0.118.1', commit), /ledger .* is invalid/u);
});

test('refuses when the row commit differs from the release commit', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  const other = fx.commit({ 'apps/api/src/fix.ts': 'fix 2\n' });
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', other), /names commit/u);
});

test('refuses an existing tag that points somewhere other than the row commit', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.git('tag', 'v0.118.1', fx.base);
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /tag 'v0\.118\.1' points at/u);
});

test('refuses a shallow clone', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit);
  const shallow = join(scratch, `shallow-${nextFixtureNumber()}`);
  assert.equal(run(scratch, 'git', ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${fx.repo}`, shallow]).status, 0);
  run(shallow, 'git', ['fetch', '-q', '--depth', '1', 'origin', '+refs/tags/*:refs/tags/*']);
  const result = run(shallow, 'bash', [BOOTSTRAP, '--tag', 'v0.118.1', '--commit', commit,
    '--ledger-ref', 'origin/main', '--main-ref', 'origin/main']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /shallow repository/u);
});

test('refuses a base whose tree predates server-only support', () => {
  const fx = new Fixture({ baseHasGuard: false });
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /predates server-only support/u);
});

// ── Base execution: the candidate cannot weaken its own guard ───────────────
test('bootstrap refuses a candidate that rewrites its own guard to exit 0', () => {
  const fx = new Fixture();
  const commit = fx.commit({
    'scripts/release/check-server-only-eligibility.sh': '#!/usr/bin/env bash\nexit 0\n',
    'agent/x.go': 'package main\n',
  });
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /release machinery changed since v0\.118\.0/u);
});

test('bootstrap refuses a candidate that weakens only its policy file', () => {
  const fx = new Fixture();
  const weakened = fx.read('scripts/release/binary-affecting-paths.txt').replace(/^agent\/\*\*.*$/mu, '');
  const commit = fx.commit({ 'scripts/release/binary-affecting-paths.txt': weakened, 'agent/x.go': 'package main\n' });
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /release machinery changed/u);
});

test('the guard reads its policy from its own (base) tree, not the candidate tree', () => {
  const fx = new Fixture();
  const weakened = fx.read('scripts/release/binary-affecting-paths.txt').replace(/^agent\/\*\*.*$/mu, '');
  assert.doesNotMatch(weakened, /^agent\/\*\*/mu, 'fixture must actually drop agent/**');
  const commit = fx.commit({ 'scripts/release/binary-affecting-paths.txt': weakened, 'agent/x.go': 'package main\n' });
  fx.addRow('v0.118.1', commit);

  // Extract the BASE guard exactly as the bootstrap does and run it directly,
  // bypassing the bootstrap's self-check.
  const baseTree = mkdtempSync(join(scratch, 'base-tree-'));
  const archive = run(fx.repo, 'bash', ['-c', `git archive v0.118.0 scripts/release | tar -x -C "${baseTree}"`]);
  assert.equal(archive.status, 0, archive.stderr);
  const result = run(fx.repo, 'bash', [join(baseTree, 'scripts/release/check-server-only-eligibility.sh'),
    '--repo', fx.repo, '--tag', 'v0.118.1', '--commit', commit, '--declared-base', 'v0.118.0',
    '--main-ref', 'main', '--ledger-ref', 'main']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^ {2}agent\/x\.go$/mu, 'the base policy (with agent/**) must be the one applied');
});
