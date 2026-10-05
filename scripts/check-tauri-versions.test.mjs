import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-tauri-versions.mjs');
const repoRoot = join(here, '..');
const roots = [];
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function cargoLock(crates) {
  return ['version = 4', '', ...Object.entries(crates).flatMap(([name, version]) => [
    '[[package]]', `name = "${name}"`, `version = "${version}"`, '',
  ])].join('\n');
}

function importer(app, deps) {
  return [`  apps/${app}:`, '    dependencies:', ...Object.entries(deps).flatMap(([name, version]) => [
    `      '${name}':`, `        specifier: ^${version}`, `        version: ${version}`,
  ])].join('\n');
}

function fixture(apps) {
  const root = mkdtempSync(join(tmpdir(), 'tauri-versions-'));
  roots.push(root);
  const importers = [];
  for (const [app, { crates, npm }] of Object.entries(apps)) {
    mkdirSync(join(root, 'apps', app, 'src-tauri'), { recursive: true });
    writeFileSync(join(root, 'apps', app, 'src-tauri', 'Cargo.lock'), cargoLock(crates));
    importers.push(importer(app, npm));
  }
  writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n${importers.join('\n\n')}\n\npackages:\n`);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
}

test('passes when crate and npm minors match (patch may differ)', () => {
  const root = fixture({ helper: { crates: { tauri: '2.12.0', 'tauri-plugin-shell': '2.3.6' }, npm: { '@tauri-apps/api': '2.12.1', '@tauri-apps/plugin-shell': '2.3.2' } } });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
});

test('fails when tauri crate minor differs from @tauri-apps/api', () => {
  const root = fixture({ helper: { crates: { tauri: '2.12.0' }, npm: { '@tauri-apps/api': '2.11.0' } } });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/helper.*tauri 2\.12\.0.*@tauri-apps\/api 2\.11\.0/);
});

test('fails when a plugin crate minor differs from its npm package', () => {
  const root = fixture({ viewer: { crates: { tauri: '2.11.6', 'tauri-plugin-deep-link': '2.5.0' }, npm: { '@tauri-apps/api': '2.11.0', '@tauri-apps/plugin-deep-link': '2.4.10' } } });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tauri-plugin-deep-link 2\.5\.0.*@tauri-apps\/plugin-deep-link 2\.4\.10/);
});

test('ignores plugin crates with no npm counterpart', () => {
  const root = fixture({ viewer: { crates: { tauri: '2.11.6', 'tauri-plugin-updater': '2.12.0' }, npm: { '@tauri-apps/api': '2.11.0' } } });
  assert.equal(run(root).status, 0);
});

test('fails when an app has the tauri crate but no @tauri-apps/api in the lockfile', () => {
  const root = fixture({ helper: { crates: { tauri: '2.12.0' }, npm: {} } });
  assert.equal(run(root).status, 1);
});

test('the real repo is consistent', () => {
  const r = run(repoRoot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /apps\/helper/);
  assert.match(r.stdout, /apps\/viewer/);
});
