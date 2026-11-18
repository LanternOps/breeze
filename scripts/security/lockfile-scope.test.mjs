import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lockfileScopes, scopeOf } from './lockfile-scope.mjs';

// Production-closure walk of pnpm-lock.yaml (#11137). The dependency audit
// compares base and head findings; without a scope a vulnerable version that
// moves from devDependencies to dependencies looked unchanged.

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      eslint:
        specifier: ^10.0.0
        version: 10.0.0(jiti@2.0.0)
      shared-lib:
        specifier: ^1.0.0
        version: 1.0.0

  apps/api:
    dependencies:
      '@scope/web':
        specifier: ^2.0.0
        version: 2.0.0(react@19.0.0)
      aliased:
        specifier: npm:real@^3.0.0
        version: real@3.0.0
      '@breeze/shared':
        specifier: workspace:*
        version: link:../../packages/shared
    optionalDependencies:
      fsevents:
        specifier: ^2.0.0
        version: 2.3.3
    devDependencies:
      vitest:
        specifier: ^4.0.0
        version: 4.0.0

packages:

  eslint@10.0.0:
    resolution: {integrity: sha512-x}

snapshots:

  eslint@10.0.0(jiti@2.0.0):
    dependencies:
      shared-lib: 1.0.0
      only-dev: 1.0.0

  only-dev@1.0.0: {}

  shared-lib@1.0.0:
    dependencies:
      leaf: 1.0.0

  leaf@1.0.0: {}

  '@scope/web@2.0.0(react@19.0.0)':
    dependencies:
      react: 19.0.0
      leaf: 1.0.0

  react@19.0.0: {}

  real@3.0.0:
    dependencies:
      transitive-of-alias: 1.0.0

  transitive-of-alias@1.0.0: {}

  fsevents@2.3.3:
    optional: true

  vitest@4.0.0:
    dependencies:
      vite-only: 1.0.0

  vite-only@1.0.0: {}

  orphan@9.9.9: {}
`;

test('a package reachable only from devDependencies is dev', () => {
  const s = lockfileScopes(LOCK);
  assert.equal(scopeOf(s, 'eslint', '10.0.0'), 'dev');
  assert.equal(scopeOf(s, 'only-dev', '1.0.0'), 'dev');
  assert.equal(scopeOf(s, 'vitest', '4.0.0'), 'dev');
  assert.equal(scopeOf(s, 'vite-only', '1.0.0'), 'dev');
});

test('a package reachable from dependencies is production, even if dev also reaches it', () => {
  const s = lockfileScopes(LOCK);
  assert.equal(scopeOf(s, '@scope/web', '2.0.0'), 'production');
  assert.equal(scopeOf(s, 'react', '19.0.0'), 'production');
  assert.equal(scopeOf(s, 'leaf', '1.0.0'), 'production'); // via @scope/web AND via dev shared-lib
  assert.equal(scopeOf(s, 'shared-lib', '1.0.0'), 'dev');
});

test('optionalDependencies and npm: aliases are walked as production', () => {
  const s = lockfileScopes(LOCK);
  assert.equal(scopeOf(s, 'fsevents', '2.3.3'), 'production');
  assert.equal(scopeOf(s, 'real', '3.0.0'), 'production');
  assert.equal(scopeOf(s, 'transitive-of-alias', '1.0.0'), 'production');
});

test('a package the walk cannot place (or never saw) is unknown, which consumers treat as production', () => {
  const s = lockfileScopes(LOCK);
  assert.equal(scopeOf(s, 'orphan', '9.9.9'), 'unknown');
  assert.equal(scopeOf(s, 'not-in-lockfile', '1.0.0'), 'unknown');
});

test('an edge into a key that is not a snapshot throws rather than dropping its subtree', () => {
  const bad = LOCK.replace('      react: 19.0.0\n', '      react: 19.0.0\n      ghost: 0.0.1\n');
  assert.throws(() => lockfileScopes(bad), /no snapshot/);
});

test('a file: dependency is followed, so its children are production even when a dev package also reaches them', () => {
  const lock = `importers:

  .:
    dependencies:
      vendored:
        specifier: file:vendor/vendored.tgz
        version: file:vendor/vendored.tgz
    devDependencies:
      tool:
        specifier: ^1.0.0
        version: 1.0.0

snapshots:

  'vendored@file:vendor/vendored.tgz':
    dependencies:
      shared-child: 1.0.0

  tool@1.0.0:
    dependencies:
      shared-child: 1.0.0

  shared-child@1.0.0: {}
`;
  assert.equal(scopeOf(lockfileScopes(lock), 'shared-child', '1.0.0'), 'production');
});

test('a lockfile with no importers or no snapshots throws (cannot walk, fail closed)', () => {
  assert.throws(() => lockfileScopes("lockfileVersion: '9.0'\n"), /importers/);
  assert.throws(() => lockfileScopes('importers:\n\n  .:\n    dependencies:\n      a:\n        version: 1.0.0\n'), /snapshots/);
});
