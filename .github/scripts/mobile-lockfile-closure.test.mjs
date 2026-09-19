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
    optionalDependencies:
      sharp:
        specifier: ^0.34.0
        version: 0.34.2
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
    optionalDependencies:
      fsevents: 2.3.3
      ip: neoip@3.1.0

  expo@54.0.13(react@19.1.0):
    dependencies:
      '@expo/cli': 54.0.10
      react: 19.1.0

  '@expo/cli@54.0.10': {}

  sharp@0.34.2: {}

  fsevents@2.3.3:
    optional: true

  neoip@3.1.0: {}

  hono@4.13.5: {}

  react@19.1.0: {}

  typescript@5.9.3: {}
`;

test('parses importers and snapshots as nested maps with quoted keys intact', () => {
  const lock = parseLockfile(fixture('54.0.12'));
  assert.equal(lock.importers['apps/mobile'].dependencies.expo.version, '54.0.12(react@19.1.0)');
  assert.equal(lock.importers['apps/mobile'].dependencies['@breeze/shared'].version, 'link:../../packages/shared');
  assert.equal(lock.snapshots['expo@54.0.12(react@19.1.0)'].dependencies['@expo/cli'], '54.0.10');
  assert.deepEqual(lock.snapshots['react@19.1.0'], {}, 'inline `{}` is an empty map, not the string "{}"');
});

test('walks the mobile importer through snapshots and excludes other importers', () => {
  const { keys, links } = mobileClosure(parseLockfile(fixture('54.0.12')));
  assert.deepEqual([...keys].sort(), ['@expo/cli@54.0.10', 'expo@54.0.12(react@19.1.0)', 'fsevents@2.3.3', 'neoip@3.1.0', 'react@19.1.0', 'sharp@0.34.2']);
  assert.ok(!keys.has('ip@neoip@3.1.0'), 'an aliased dependency resolves to the aliased snapshot key');
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
  // Only the FIRST snapshot (expo@54.0.12, the one the importer resolves to) changes.
  const head = base.replace("'@expo/cli': 54.0.10\n      react: 19.1.0\n    optionalDependencies:", "'@expo/cli': 54.0.11\n      react: 19.1.0\n    optionalDependencies:");
  assert.notEqual(base, head);
  const result = compareLockfiles(base, head);
  assert.equal(result.changed, true, 'transitive @expo/cli change must be detected');
});

test('a bump reachable only through optionalDependencies reports changed=true', () => {
  const base = fixture('54.0.12');
  const importerLevel = base.replace('version: 0.34.2', 'version: 0.34.3').replace('sharp@0.34.2: {}', 'sharp@0.34.3: {}');
  assert.equal(compareLockfiles(base, importerLevel).changed, true, 'importer optionalDependencies must be walked');
  const snapshotLevel = base.replace('fsevents: 2.3.3\n', 'fsevents: 2.3.4\n');
  assert.equal(compareLockfiles(base, snapshotLevel).changed, true, 'snapshot optionalDependencies must be walked');
});

test('moving a dependency between groups at the same version reports changed=false', () => {
  const base = fixture('54.0.12');
  const head = base.replace("      react:\n        specifier: 19.1.0\n        version: 19.1.0\n    optionalDependencies:", "    devDependencies:\n      react:\n        specifier: 19.1.0\n        version: 19.1.0\n    optionalDependencies:");
  assert.notEqual(base, head);
  assert.equal(compareLockfiles(base, head).changed, false);
});

test('a workspace link target change reports changed=true', () => {
  const base = fixture('54.0.12');
  const head = base.replace('link:../../packages/shared', 'link:../../packages/shared-native');
  assert.equal(compareLockfiles(base, head).changed, true);
});

test('fails closed when the mobile importer is missing or the file does not parse', () => {
  assert.equal(compareLockfiles(fixture('54.0.12'), 'lockfileVersion: 9\nimporters:\n  .: {}\n').changed, true);
  assert.equal(compareLockfiles('', fixture('54.0.12')).changed, true);
});

test('fails closed on structural drift: unsupported lockfileVersion, empty snapshots, non-map groups, missing snapshot entry', () => {
  const good = fixture('54.0.12');
  const v10 = good.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'");
  assert.equal(compareLockfiles(v10, v10).changed, true, 'unknown major must not be trusted even when both sides agree');
  assert.match(compareLockfiles(v10, v10).reason, /lockfileVersion/u);
  const noSnapshots = good.slice(0, good.indexOf('snapshots:'));
  assert.equal(compareLockfiles(noSnapshots, noSnapshots).changed, true);
  const missingEntry = good.replace("  '@expo/cli@54.0.10': {}\n", '');
  assert.equal(compareLockfiles(good, missingEntry).changed, true, 'a reachable key with no snapshot entry must fail closed');
  assert.match(compareLockfiles(good, missingEntry).reason, /no snapshots entry for reachable key @expo\/cli@54\.0\.10/u);
  const scalarGroup = good.replace('    dependencies:\n      \'@breeze/shared\':', '    dependencies: oops\n      \'@breeze/shared\':');
  assert.equal(compareLockfiles(good, scalarGroup).changed, true);
});

test('CLI prints changed= and reason= lines and exits 0 on bad input', () => {
  const out = execFileSync(process.execPath, ['.github/scripts/mobile-lockfile-closure.mjs', '/nonexistent-a', '/nonexistent-b'], { encoding: 'utf8' });
  assert.match(out, /^changed=true\nreason=read error/u);
});

// Real-history cases. The synthetic fixtures above are what gate CI; these
// two run only where the commits are reachable (a full local clone — the lint
// job checks out at depth 1) and are skipped VISIBLY there, never silently.
const showLock = (rev) => execFileSync('git', ['show', `${rev}:pnpm-lock.yaml`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const historyReachable = (rev) => { try { showLock(rev); return true; } catch { return false; } };

test('real history: an api-only dependency bump on main leaves the mobile closure unchanged', (t) => {
  // #5846 (pdfkit 0.19→0.20, apps/api only) — the case that used to allocate a macOS runner.
  if (!historyReachable('b597444a0~1')) return t.skip('commit b597444a0~1 not reachable (shallow checkout)');
  const result = compareLockfiles(showLock('b597444a0~1'), showLock('b597444a0'));
  assert.equal(result.changed, false, result.reason);
});

test('real history: a mobile dependabot group bump on main changes the closure', (t) => {
  // #5282 (mobile group, 4 updates).
  if (!historyReachable('5e837f667~1')) return t.skip('commit 5e837f667~1 not reachable (shallow checkout)');
  const result = compareLockfiles(showLock('5e837f667~1'), showLock('5e837f667'));
  assert.equal(result.changed, true, result.reason);
});
