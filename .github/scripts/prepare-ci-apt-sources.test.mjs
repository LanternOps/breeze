import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filterSource, prepareSources } from './prepare-ci-apt-sources.mjs';

const chrome = 'https://dl.google.com/linux/chrome-stable/deb/';
const distro = 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main\n';
const stanza = 'Types: deb deb-src\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n .\n fixture-key\n -----END PGP PUBLIC KEY BLOCK-----\n';
function temporary(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-apt-sources-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function fixtures(root, files) {
  const source = path.join(root, 'input with spaces $literal');
  const output = path.join(root, 'output');
  mkdirSync(path.join(source, 'sources.list.d'), { recursive: true });
  mkdirSync(output);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(source, name), content);
  return { source, output };
}

test('legacy mixed file removes only exact Chrome entry, preserving options and comments', () => {
  const unrelated = `deb https://dl.google.com/linux/earth/deb stable main\ndeb https://dl.google.com.example.com/linux/chrome-stable/deb stable main\n`;
  const comment = `# deb ${chrome} stable main\n`;
  const result = filterSource('vendor.list', `${comment}${distro}deb [arch=amd64 signed-by=/keys/chrome.gpg] ${chrome} stable main\n${unrelated}`);
  assert.equal(result.text, comment + distro + unrelated);
  assert.equal(result.excluded, 1);
  assert.equal(result.retained, 3);
});

test('conventional Chrome URL and deb-src excluded; other path, port and credentials retained', () => {
  for (const uri of ['http://dl.google.com/linux/chrome/deb', chrome]) {
    assert.equal(filterSource('chrome.list', `deb-src ${uri} stable main\n`).text, '');
  }
  for (const uri of ['https://dl.google.com:8443/linux/chrome/deb', 'https://user@dl.google.com/linux/chrome/deb', 'https://dl.google.com/linux/chrome-beta/deb']) {
    const input = `deb ${uri} stable main\n`;
    assert.equal(filterSource('vendor.list', input).text, input);
  }
});

test('deb822 retains unrelated stanza and inline Signed-By bytes exactly', () => {
  const input = `${stanza}\nTypes: deb\nURIs: ${chrome}\nSuites: stable\nComponents: main\nSigned-By: /keys/chrome.gpg\n`;
  const result = filterSource('vendors.sources', input);
  assert.equal(result.text, stanza + '\n');
  assert.equal(result.excluded, 1);
  assert.equal(result.retained, 1);
});

test('mixed deb822 URI stanza rejects explicitly, including folded URI field', () => {
  for (const separator of [' ', '\n ']) {
    assert.throws(() => filterSource('mixed.sources', `Types: deb\nURIs: ${chrome}${separator}https://archive.ubuntu.com/ubuntu\nSuites: stable\n`), /Mixed Chrome and unrelated/);
  }
});

test('disabled stanza and unrelated multi-URI Signed-By configuration are unchanged', () => {
  const disabled = `Enabled: no\nTypes: deb\nURIs: ${chrome}\nSuites: stable\n`;
  assert.equal(filterSource('disabled.sources', disabled).text, disabled);
  const input = stanza.replace('URIs: https://archive.ubuntu.com/ubuntu', 'URIs: https://archive.ubuntu.com/ubuntu\n https://security.ubuntu.com/ubuntu');
  assert.equal(filterSource('ubuntu.sources', input).text, input);
});

test('malformed active entries fail closed instead of dropping source/trust fields', () => {
  for (const input of ['deb [signed-by=/broken https://archive.ubuntu.com noble main\n', 'unexpected entry\n']) {
    assert.throws(() => filterSource('bad.list', input), /Unrecognized/);
  }
  for (const input of ['Types: deb\nURIs: one\nURIs: two\n', 'Types: deb\nSuites: stable\n', ' orphan\n']) {
    assert.throws(() => filterSource('bad.sources', input));
  }
});

test('isolated configuration is idempotent and original files never change', () => temporary((root) => {
  const files = { 'sources.list': distro, 'sources.list.d/mixed.sources': `${stanza}\nTypes: deb\nURIs: ${chrome}\nSuites: stable\n`, 'sources.list.d/ignored.list.save': 'not an enabled source' };
  const { source, output } = fixtures(root, files);
  assert.deepEqual(prepareSources(source, output), { files: 2, excluded: 1 });
  for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(path.join(source, name), 'utf8'), text);
  assert.equal(existsSync(path.join(output, 'sources.list.d/ignored.list.save')), false);
  const next = path.join(root, 'next'); mkdirSync(next);
  assert.deepEqual(prepareSources(output, next), { files: 2, excluded: 0 });
  for (const name of ['sources.list', 'sources.list.d/mixed.sources']) assert.equal(readFileSync(path.join(output, name), 'utf8'), readFileSync(path.join(next, name), 'utf8'));
}));

test('ambiguous or empty source set publishes nothing and refuses reused output', () => temporary((root) => {
  const { source, output } = fixtures(root, { 'sources.list': `deb ${chrome} stable main\n` });
  assert.throws(() => prepareSources(source, output), /No active non-Chrome/);
  assert.deepEqual(readdirSync(output), []);
  writeFileSync(path.join(source, 'sources.list'), distro);
  writeFileSync(path.join(source, 'sources.list.d/mixed.sources'), `Types: deb\nURIs: ${chrome} https://other.example/apt\n`);
  assert.throws(() => prepareSources(source, output), /Mixed/);
  assert.deepEqual(readdirSync(output), []);
  assert.throws(() => prepareSources(source, source), /separate/);
  writeFileSync(path.join(output, 'sentinel'), 'keep');
  assert.throws(() => prepareSources(source, output), /empty/);
  assert.equal(readFileSync(path.join(output, 'sentinel'), 'utf8'), 'keep');
}));

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const job = (name) => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, 'm'))[1];
function dependencyScript(name) {
  const body = job(name);
  const step = name === 'rust-check' ? body.slice(body.indexOf('      - name: Install Tauri')) : body.slice(body.indexOf('      - name: Install socat'));
  return step.split('        run: |\n')[1].split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
}

for (const name of ['rust-check', 'guided-setup-smoke']) {
  for (const failurePhase of ['none', 'update', 'install']) {
    const fail = failurePhase !== 'none';
    test(`${name}: real dependency shell retains apt verification options, exit status and cleanup (${failurePhase})`, () => temporary((root) => {
      const { source } = fixtures(root, { 'sources.list': distro + `deb ${chrome} stable main\n` });
      const bin = path.join(root, 'bin'); mkdirSync(bin);
      const calls = path.join(root, 'calls');
      const stubs = {
        sudo: 'exec "$@"',
        timeout: 'while [[ "$1" == --* ]]; do shift; done; shift; exec "$@"',
        sed: 'exit 0', // The pre-existing mirror rewrite must not touch host files.
        sleep: 'exit 0', dpkg: 'exit 0',
        'apt-get': `printf '%s\\n' "$*" >> "$CALLS"\nif [[ "$*" != *Dir::Etc::sourcelist=* || "$*" != *Dir::Etc::sourceparts=* ]]; then exit 91; fi\nfor arg in "$@"; do\n if [[ "$arg" == Dir::Etc::sourcelist=* ]]; then\n  config="\u0024{arg#*=}"; printf '%s\\n' "$config" > "$CONFIG_CAPTURE"\n  [[ -f "$config" ]] || exit 92\n  if grep -q chrome "$config"; then exit 93; fi\n  grep -q signed-by "$config" || exit 94\n fi\ndone\n[[ "$1" == "$APT_FAIL_PHASE" ]] && exit 100\nexit 0`,
      };
      for (const [file, text] of Object.entries(stubs)) { const f = path.join(bin, file); writeFileSync(f, '#!/bin/bash\n' + text + '\n'); chmodSync(f, 0o755); }
      const script = dependencyScript(name).replace('/etc/apt "$CI_APT_DIR"', '"$FIXTURE_APT_SOURCE" "$CI_APT_DIR"');
      const result = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', cwd: new URL('../../', import.meta.url), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, CONFIG_CAPTURE: path.join(root, 'config'), APT_FAIL_PHASE: failurePhase, FIXTURE_APT_SOURCE: source } });
      assert.equal(result.status, fail ? (name === 'rust-check' ? 1 : 100) : 0, result.stdout + result.stderr);
      const recorded = readFileSync(calls, 'utf8').trim().split('\n');
      assert.equal(recorded.length, fail ? (name === 'rust-check' ? 3 : 1) * (failurePhase === 'install' ? 2 : 1) : 2);
      assert.ok(recorded.every((line) => !/allow-unauthenticated|trusted=yes|AllowInsecure|Check-Valid-Until=false/u.test(line)));
      const config = readFileSync(path.join(root, 'config'), 'utf8').trim();
      assert.equal(existsSync(path.dirname(config)), false, 'temporary source configuration must be cleaned on both exits');
      assert.equal(readFileSync(path.join(source, 'sources.list'), 'utf8'), distro + `deb ${chrome} stable main\n`);
    }));
  }
}
