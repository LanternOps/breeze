import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { afterEach } from 'node:test';

import { REQUIRED_RELEASE_IMAGES } from './release-image-manifest.mjs';

const script = resolve('scripts/release/verify-release-images.sh');
const scratch = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const digest = (index) => `sha256:${String(index).repeat(64)}`;
function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'verify-release-images-'));
  scratch.push(directory);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const images = REQUIRED_RELEASE_IMAGES.map((name, index) => ({
    digest: digest((index + 1) % 10),
    name,
    repository: `ghcr.io/lanternops/breeze/${name}`,
  }));
  const object = {
    assets: [],
    images,
    release: 'v1.2.3',
    repository: 'LanternOps/breeze',
    schemaVersion: 1,
    sourceCommit: 'a'.repeat(40),
    ...overrides,
  };
  const manifest = `${JSON.stringify(object, null, 2)}\n`;
  const manifestPath = join(directory, 'manifest.json');
  const signaturePath = join(directory, 'manifest.ed25519');
  writeFileSync(manifestPath, manifest);
  writeFileSync(signaturePath, `${sign(null, Buffer.from(manifest), privateKey).toString('base64')}\n`);
  return {
    directory,
    manifestPath,
    signaturePath,
    images,
    key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
}

function run(value, extra = [], env = {}) {
  const openssl = process.platform === 'darwin'
    ? '/opt/homebrew/opt/openssl@3/bin/openssl'
    : 'openssl';
  return spawnSync('bash', [script,
    '--manifest', value.manifestPath,
    '--signature', value.signaturePath,
    '--expected-repository', 'LanternOps/breeze',
    '--expected-release', 'v1.2.3',
    ...extra,
  ], { encoding: 'utf8', env: { ...process.env, BREEZE_OPENSSL_BIN: openssl, RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: value.key, ...env } });
}

test('verifies signature and exact tuple, then emits only digest-pinned core refs', () => {
  const value = fixture();
  const output = join(value.directory, 'images.env');
  const api = value.images.find((image) => image.name === 'api');
  const result = run(value, ['--require', `api=${api.repository}@${api.digest}`, '--emit-env', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(output), result.stderr);
  const emitted = readFileSync(output, 'utf8');
  assert.match(emitted, /^BREEZE_API_IMAGE_REF=ghcr[.]io\/lanternops\/breeze\/api@sha256:/mu);
  assert.equal(emitted.trim().split('\n').length, 4);
  assert.doesNotMatch(emitted, /\/(?:api|web|portal|binaries):/u);
});

test('rejects tampering, wrong key, tuple substitution, and missing image', () => {
  const tampered = fixture();
  writeFileSync(tampered.manifestPath, readFileSync(tampered.manifestPath, 'utf8').replace(digest(1), digest(9)));
  assert.notEqual(run(tampered).status, 0);

  const wrongKey = fixture();
  assert.notEqual(run(wrongKey, [], { RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: fixture().key }).status, 0);

  const substituted = fixture();
  assert.notEqual(run(substituted, ['--require', `api=ghcr.io/lanternops/breeze/api@${digest(9)}`]).status, 0);

  const missingImages = fixture({ images: fixture().images.slice(1) });
  assert.notEqual(run(missingImages).status, 0);
});

test('accepts a configured rotation key after a non-matching key', () => {
  const value = fixture();
  const other = fixture();
  const result = run(value, [], { RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: `${other.key},${value.key}` });
  assert.equal(result.status, 0, result.stderr);
});
