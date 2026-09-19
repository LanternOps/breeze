import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { compareLockfiles, mobileClosure, parseLockfile } from './mobile-lockfile-closure.mjs';

const fixture = (mobileVersion, extra = '') => `
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.3

  apps/api:
    dependencies:
      hono:
        specifier: ^4.13.5
        version: 4.13.5

  apps/mobile:
    dependencies:
      '@breeze/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      expo:
        specifier: ~54.0.0
        version: ${mobileVersion}(react@19.1.0)
      react:
        specifier: 19.1.0
        version: 19.1.0
${extra}
packages:

  expo@54.0.12:
    resolution: {integrity: sha512-aaa}
  expo@54.0.13:
    resolution: {integrity: sha512-bbb}
  '@expo/cli@54.0.10':
    resolution: {integrity: sha512-ccc}
  hono@4.13.5:
    resolution: {integrity: sha512-ddd}
  react@19.1.0:
    resolution: {integrity: sha512-eee}
  typescript@5.9.3:
    resolution: {integrity: sha512-fff}

snapshots:

  expo@54.0.12(react@19.1.0):
    dependencies:
      '@expo/cli': 54.0.10
      react: 19.1.0

  expo@54.0.13(react@19.1.0):
    dependencies:
      '@expo/cli': 54.0.10
      react: 19.1.0

  '@expo/cli@54.0.10': {}

  hono@4.13.5: {}

  react@19.1.0: {}

  typescript@5.9.3: {}
`;

test('parses importers and snapshots as nested maps with quoted keys intact', () => {
  const lock = parseLockfile(fixture('54.0.12'));
  assert.equal(lock.importers['apps/mobile'].dependencies.expo.version, '54.0.12(react@19.1.0)');
  assert.equal(lock.importers['apps/mobile'].dependencies['@breeze/shared'].version, 'link:../../packages/shared');
  assert.equal(lock.snapshots['expo@54.0.12(react@19.1.0)'].dependencies['@expo/cli'], '54.0.10');
});

test('walks the mobile importer through snapshots and excludes other importers', () => {
  const { keys, links } = mobileClosure(parseLockfile(fixture('54.0.12')));
  assert.deepEqual([...keys].sort(), ['@expo/cli@54.0.10', 'expo@54.0.12(react@19.1.0)', 'react@19.1.0']);
  assert.deepEqual([...links], ['@breeze/shared=link:../../packages/shared']);
  assert.ok(!keys.has('hono@4.13.5'), 'api-only dependency must not be in the mobile closure');
});

test('an api-only lockfile change reports changed=false', () => {
  const base = fixture('54.0.12');
  const head = base.replace('version: 4.13.5', 'version: 4.14.0').replace('hono@4.13.5', 'hono@4.14.0');
  const result = compareLockfiles(base, head);
  assert.equal(result.changed, false, result.reason);
});

test('a direct mobile bump reports changed=true', () => {
  const result = compareLockfiles(fixture('54.0.12'), fixture('54.0.13'));
  assert.equal(result.changed, true);
  assert.match(result.reason, /expo@54\.0\.13/u);
});

test('a transitive bump under a mobile dependency reports changed=true', () => {
  const base = fixture('54.0.12');
  const head = base.replace("'@expo/cli': 54.0.10\n      react: 19.1.0\n\n  expo@54.0.13", "'@expo/cli': 54.0.11\n      react: 19.1.0\n\n  expo@54.0.13");
  const result = compareLockfiles(base, head);
  assert.equal(result.changed, true, 'transitive @expo/cli change must be detected');
});

test('fails closed when the mobile importer is missing or the file does not parse', () => {
  assert.equal(compareLockfiles(fixture('54.0.12'), 'lockfileVersion: 9\nimporters:\n  .: {}\n').changed, true);
  assert.equal(compareLockfiles('', fixture('54.0.12')).changed, true);
});

test('CLI prints changed= and reason= lines and exits 0 on bad input', () => {
  const out = execFileSync(process.execPath, ['.github/scripts/mobile-lockfile-closure.mjs', '/nonexistent-a', '/nonexistent-b'], { encoding: 'utf8' });
  assert.match(out, /^changed=true\nreason=read error/u);
});

test('real history: an api-only dependency bump on main leaves the mobile closure unchanged', () => {
  // #5846 (pdfkit 0.19→0.20, apps/api only) — the case that used to allocate a macOS runner.
  const show = (rev) => execFileSync('git', ['show', `${rev}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let base;
  try {
    base = show('b597444a0~1');
  } catch {
    return; // shallow clone without that commit: skip silently
  }
  const result = compareLockfiles(base, show('b597444a0'));
  assert.equal(result.changed, false, result.reason);
});

test('real history: a mobile dependabot group bump on main changes the closure', () => {
  // #5282 (mobile group, 4 updates).
  const show = (rev) => execFileSync('git', ['show', `${rev}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let base;
  try {
    base = show('5e837f667~1');
  } catch {
    return;
  }
  const result = compareLockfiles(base, show('5e837f667'));
  assert.equal(result.changed, true, result.reason);
});
