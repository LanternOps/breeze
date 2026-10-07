// Server-only guard: acceptance, --online base verification, PR ledger check.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ENV_EXAMPLE,
  Fixture,
  HERE,
  LEDGER,
  assertEligible,
  assertRefused,
  ledgerChange,
  onlineFixture,
  onlineStub,
  run,
  scratch,
} from './__fixtures__/server-only-guard.mjs';

// ── Acceptance ─────────────────────────────────────────────────────────────
test('accepts a server-only change set and reports the pairing', () => {
  const fx = new Fixture();
  const commit = fx.commit({
    'apps/api/src/fix.ts': 'fix\n',
    'apps/web/src/y.tsx': 'export {};\n',
    'apps/api/migrations/2026-10-01-000000-fix.sql': 'SELECT 1;\n',
  });
  fx.addRow('v0.118.1', commit);
  const result = fx.guard('v0.118.1', commit);
  assertEligible(result);
  assert.deepEqual(result.report, {
    tag: 'v0.118.1',
    commit,
    base: 'v0.118.0',
    baseSha: fx.base,
    binariesVersion: '0.118.0',
    changedPathCount: 3,
    online: false,
    agentFacing: [],
  });
  assert.match(result.stdout, /agent-facing server changes: none/u);
});

test('by design: a root .env.example change that leaves the trust anchor alone is eligible and listed for review', () => {
  const fx = new Fixture();
  const commit = fx.commit({
    '.env.example': `# a documented server var\nNEW_SERVER_VAR=\n${ENV_EXAMPLE}# RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: comment-only mention\n`,
    'apps/api/src/fix.ts': 'fix\n',
  });
  fx.addRow('v0.118.1', commit);
  const result = fx.guard('v0.118.1', commit);
  assertEligible(result);
  assert.deepEqual(result.report.agentFacing, ['.env.example']);
});

test('agent-facing server changes are accepted and listed for required review', () => {
  const fx = new Fixture();
  const commit = fx.commit({
    'apps/api/src/services/installerBuilder.ts': 'export {};\n',
    'apps/api/src/routes/agents/heartbeat.ts': 'export {};\n',
  });
  fx.addRow('v0.118.1', commit);
  const result = fx.guard('v0.118.1', commit);
  assertEligible(result);
  assert.deepEqual(result.report.agentFacing, [
    'apps/api/src/routes/agents/heartbeat.ts',
    'apps/api/src/services/installerBuilder.ts',
  ]);
  assert.match(result.stdout, /required review[\s\S]*installerBuilder\.ts/u);
});

test('chained hotfix: both rows use the last full release; the ledger change itself is exempt', () => {
  const fx = new Fixture();
  const first = fx.commit({ 'apps/api/src/fix.ts': 'fix 1\n' });
  fx.addRow('v0.118.1', first);
  fx.git('tag', 'v0.118.1', first);
  assertEligible(fx.guard('v0.118.1', first));

  const second = fx.commit({ 'apps/api/src/fix.ts': 'fix 2\n' });
  fx.addRow('v0.118.2', second);
  const result = fx.guard('v0.118.2', second);
  assertEligible(result);
  assert.equal(result.report.base, 'v0.118.0');
  // base..second includes the v0.118.1 ledger commit; the negation exempts it.
  assert.ok(result.report.changedPathCount >= 2);
});

test('an unlisted tag exits 3 (full release), including when the ledger is absent', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  const unlisted = fx.guard('v0.118.1', commit);
  assert.equal(unlisted.status, 3, unlisted.output);
  assert.match(unlisted.stdout, /not listed/u);

  fx.commit({ [LEDGER]: null }, 'drop ledger');
  const absent = fx.guard('v0.118.1', commit);
  assert.equal(absent.status, 3, absent.output);
});

test('an unresolvable ledger ref is an error, never "not listed"', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  const result = fx.guard('v0.118.1', commit, { ledgerRef: 'origin/does-not-exist' });
  assert.equal(result.status, 1, result.output);
});

test('--online accepts a published, signed full base built from the base tag commit', () => {
  for (const releaseKind of [undefined, 'full']) {
    const { fx, commit } = onlineFixture();
    const stub = onlineStub(fx, { releaseKind });
    const result = fx.guard('v0.118.1', commit, stub);
    assertEligible(result);
    assert.equal(result.report.online, true);
  }
});

test('--online refuses a draft or prerelease base', () => {
  for (const state of [{ draft: true }, { prerelease: true }]) {
    const { fx, commit } = onlineFixture();
    assertRefused(fx.guard('v0.118.1', commit, onlineStub(fx, state)), /must be published and stable/u);
  }
});

test('--online refuses a base whose signed manifest is itself server-only', () => {
  const { fx, commit } = onlineFixture();
  assertRefused(
    fx.guard('v0.118.1', commit, onlineStub(fx, { releaseKind: 'server-only' })),
    /does not verify as a full release/u,
  );
});

test('--online refuses a base manifest built from another commit', () => {
  const { fx, commit } = onlineFixture();
  assertRefused(
    fx.guard('v0.118.1', commit, onlineStub(fx, { sourceCommit: 'c'.repeat(40) })),
    /names sourceCommit c{40}/u,
  );
});

test('--online refuses a manifest signed by an untrusted key', () => {
  const { fx, commit } = onlineFixture();
  const stub = onlineStub(fx);
  const other = onlineStub(fx);
  assertRefused(
    fx.guard('v0.118.1', commit, { ...stub, env: { ...stub.env, RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: other.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS } }),
    /does not verify/u,
  );
});

test('ledger PR check: a new eligible row passes and publishes its agent-facing list', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/services/binarySource.ts': 'export {};\n' });
  const before = fx.git('rev-parse', 'HEAD');
  fx.addRow('v0.118.1', commit);
  const result = ledgerChange(fx, before);
  assert.equal(result.status, 0, result.output);
  assert.match(result.summary, /Agent-facing server changes — required review/u);
  assert.match(result.summary, /apps\/api\/src\/services\/binarySource\.ts/u);
});

test('ledger PR check: a new ineligible row fails the PR', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'agent/x.go': 'package main\n' });
  const before = fx.git('rev-parse', 'HEAD');
  fx.addRow('v0.118.1', commit);
  const result = ledgerChange(fx, before);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /cut a full release/u);
});

test('ledger PR check: rows are append-only once their tag exists', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit, 'v0.118.0', 'original note');
  fx.git('tag', 'v0.118.1', commit);
  const tagged = fx.git('rev-parse', 'HEAD');

  fx.commit({ [LEDGER]: fx.read(LEDGER).replace('original note', 'edited note') }, 'edit');
  const edited = ledgerChange(fx, tagged);
  assert.notEqual(edited.status, 0, edited.output);
  assert.match(edited.output, /append-only/u);

  fx.git('reset', '-q', '--hard', tagged);
  fx.commit({ [LEDGER]: '# header\n' }, 'remove');
  const removed = ledgerChange(fx, tagged);
  assert.notEqual(removed.status, 0, removed.output);
  assert.match(removed.output, /append-only/u);
});

test('ledger PR check: refuses an added row whose tag already exists', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.git('tag', 'v0.118.1', commit);
  const before = fx.git('rev-parse', 'HEAD');
  fx.addRow('v0.118.1', commit);
  const result = ledgerChange(fx, before);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /::error::server-only ledger row for v0\.118\.1 was added, but v0\.118\.1 already exists; rows must be added before the tag is pushed/u);
  assert.doesNotMatch(result.output, /ELIGIBLE/u, 'the guard must not run for a row refused up front');
});

test('ledger PR check: a row for a tag that was never pushed may be removed', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  fx.addRow('v0.118.1', commit);
  const listed = fx.git('rev-parse', 'HEAD');
  fx.commit({ [LEDGER]: '# header\n' }, 'withdraw');
  const result = ledgerChange(fx, listed);
  assert.equal(result.status, 0, result.output);
});

test('ledger PR check: an unchanged ledger is a no-op', () => {
  const fx = new Fixture();
  const head = fx.git('rev-parse', 'HEAD');
  const result = ledgerChange(fx, head);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /no server-only ledger changes/u);
});

// A runner whose NODE_OPTIONS makes node print something after a helper's
// completion trailer must not permanently refuse every server-only release.
function lateStderrNodeOptions() {
  const preload = join(scratch, `late-stderr-${process.pid}.cjs`);
  writeFileSync(preload, "process.on('exit', () => process.stderr.write('(node:1) Warning: printed after everything else\\n'));\n");
  return { NODE_OPTIONS: `--require ${preload}` };
}

test('the guard and the ledger PR check ignore the runner NODE_OPTIONS', () => {
  const fx = new Fixture();
  const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n' });
  const before = fx.git('rev-parse', 'HEAD');
  fx.addRow('v0.118.1', commit);
  const env = lateStderrNodeOptions();
  assertEligible(fx.guard('v0.118.1', commit, { env }));
  const result = ledgerChange(fx, before, 'main', { env });
  assert.equal(result.status, 0, result.output);
});

test('every node helper in the guard and the ledger PR check runs without NODE_OPTIONS or warnings', () => {
  for (const file of ['check-server-only-eligibility.sh', 'check-server-only-ledger-change.sh']) {
    const text = readFileSync(join(HERE, file), 'utf8');
    assert.match(text, /^run_node\(\) \{ env -u NODE_OPTIONS node --no-warnings "\$@"; \}$/mu, `${file} must define run_node`);
    for (const [index, line] of text.split('\n').entries()) {
      if (/^\s*#/u.test(line) || /^run_node\(\)/u.test(line)) continue;
      assert.doesNotMatch(line, /(?:^|[\s(|!$])node\s/u, `${file}:${index + 1} calls node directly: ${line.trim()}`);
    }
  }
});

test('the committed bootstrap and guard are executable shell with strict modes', () => {
  for (const file of ['run-server-only-guard.sh', 'check-server-only-eligibility.sh', 'check-server-only-ledger-change.sh']) {
    const text = readFileSync(join(HERE, file), 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env bash\n/u, file);
    assert.match(text, /^set -[eu]*o pipefail$/mu, file);
    const syntax = run(HERE, 'bash', ['-n', join(HERE, file)]);
    assert.equal(syntax.status, 0, `${file}: ${syntax.stderr}`);
  }
});
