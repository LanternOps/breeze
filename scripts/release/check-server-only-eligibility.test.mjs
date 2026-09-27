// Server-only guard: one refusal per protected path class.
// Helpers: __fixtures__/server-only-guard.mjs.
import assert from 'node:assert/strict';

import test from 'node:test';

import { CANDIDATES, Fixture, assertRefused } from './__fixtures__/server-only-guard.mjs';

// ── Refusals: one case per protected path class ────────────────────────────
for (const [label, path] of [
  ['agent source', 'agent/x.go'],
  ['Viewer lockfile', 'apps/viewer/src-tauri/Cargo.lock'],
  ['Helper source', 'apps/helper/src/main.tsx'],
  ['binaries Dockerfile', 'docker/Dockerfile.binaries'],
  ['release workflow', '.github/workflows/release.yml'],
  ['promotion workflow', '.github/workflows/promote-release-images.yml'],
  ['.github/scripts (by design: protected wholesale)', '.github/scripts/new-helper.mjs'],
  ['.github/actions', '.github/actions/setup/action.yml'],
  ['release scripts', 'scripts/release/anything.sh'],
  ['guided setup', 'scripts/guided-setup.sh'],
  ['root compose', 'docker-compose.yml'],
  ['compose override template', 'docker-compose.override.yml.dev'],
  ['deploy templates', 'deploy/.env.example'],
  ['candidate ledger', CANDIDATES],
  ['BYO signing template', 'selfhost-signing-template/README.md'],
  ['pnpm lockfile', 'pnpm-lock.yaml'],
  ['root package manifest', 'package.json'],
  ['Node toolchain pin', '.node-version'],
  ['dependency patch', 'patches/x.patch'],
]) {
  test(`refuses a change to ${label} (${path})`, () => {
    const fx = new Fixture();
    const commit = fx.commit({ 'apps/api/src/fix.ts': 'fix\n', [path]: `changed ${path}\n` });
    fx.addRow('v0.118.1', commit);
    const result = fx.guard('v0.118.1', commit);
    assertRefused(result, /cut a full release/u);
    if (!path.startsWith('scripts/release/') && !path.startsWith('.github/workflows/release')
      && !path.startsWith('.github/workflows/promote-') && path !== CANDIDATES) {
      assert.match(result.stderr, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
  });
}

test('refuses a rename that moves a file OUT of a protected directory', () => {
  const fx = new Fixture();
  fx.git('mv', 'agent/main.go', 'apps/api/src/main.go');
  fx.git('commit', '-q', '-m', 'move');
  const commit = fx.git('rev-parse', 'HEAD');
  fx.addRow('v0.118.1', commit);
  assertRefused(fx.guard('v0.118.1', commit), /agent\/main\.go/u);
});
