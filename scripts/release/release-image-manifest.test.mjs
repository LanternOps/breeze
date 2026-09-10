import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import {
  REQUIRED_RELEASE_IMAGES,
  collectReleaseImageMetadata,
  verifyReleaseImageManifest,
} from './release-image-manifest.mjs';

const scratch = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const sourceCommit = 'a'.repeat(40);
const repository = 'LanternOps/breeze';

function images() {
  return REQUIRED_RELEASE_IMAGES.map((name, index) => ({
    name,
    repository: `ghcr.io/lanternops/breeze/${name}`,
    digest: digest(String((index + 1) % 10)),
  }));
}

function signedManifest(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    repository,
    release: 'v1.2.3',
    sourceCommit,
    assets: [],
    images: images(),
    ...overrides,
  })}\n`);
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKeys: rawKey,
  };
}

function verifyFixture(fixture, requiredImages = images().slice(0, 4)) {
  return verifyReleaseImageManifest({
    manifestBytes: fixture.manifest,
    signatureBytes: fixture.signature,
    publicKeys: fixture.publicKeys,
    expectedRepository: 'lanternops/breeze',
    expectedRelease: 'v1.2.3',
    requiredImages,
  });
}

test('accepts exact required repository and digest bindings under a trusted Ed25519 signature', () => {
  assert.equal(verifyFixture(signedManifest()).images.length, 7);
});

test('rejects manifest tampering and an untrusted signing key', () => {
  const fixture = signedManifest();
  const tampered = Buffer.from(fixture.manifest.toString().replace(digest('1'), digest('9')));
  assert.throws(() => verifyFixture({ ...fixture, manifest: tampered }), /signature verification failed/u);
  assert.throws(() => verifyFixture({ ...fixture, publicKeys: signedManifest().publicKeys }), /signature verification failed/u);
});

test('rejects a configured digest substitution even when the manifest is validly signed', () => {
  const required = images().slice(0, 4);
  required[0] = { ...required[0], digest: digest('f') };
  assert.throws(() => verifyFixture(signedManifest(), required), /does not match/u);
});

test('rejects wrong release, repository, schema, missing images, and duplicate images', () => {
  const cases = [
    [{ release: 'v9.9.9' }, /release mismatch/u],
    [{ repository: 'attacker/breeze' }, /repository mismatch/u],
    [{ schemaVersion: 2 }, /schemaVersion must be 1/u],
    [{ images: images().slice(1) }, /signed release image set mismatch/u],
    [{ images: [...images(), images()[0]] }, /duplicate signed image name api/u],
  ];
  for (const [overrides, expected] of cases) assert.throws(() => verifyFixture(signedManifest(overrides)), expected);
});

test('collector requires exactly one current-source metadata record for every release image', () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-image-metadata-'));
  scratch.push(directory);
  mkdirSync(directory, { recursive: true });
  for (const image of images()) {
    writeFileSync(join(directory, `${image.name}.json`), JSON.stringify({ ...image, sourceCommit }));
  }
  assert.deepEqual(collectReleaseImageMetadata({ directory, sourceCommit }), [...images()].sort((a, b) => a.name.localeCompare(b.name)));

  writeFileSync(join(directory, 'api.json'), JSON.stringify({ ...images()[0], sourceCommit: 'b'.repeat(40) }));
  assert.throws(() => collectReleaseImageMetadata({ directory, sourceCommit }), /sourceCommit does not match/u);
});

test('collector rejects missing, extra, duplicate, malformed, and invalid repository metadata', () => {
  for (const mutation of ['missing', 'extra', 'duplicate', 'malformed', 'repository']) {
    const directory = mkdtempSync(join(tmpdir(), `release-image-${mutation}-`));
    scratch.push(directory);
    const records = images().map((image) => ({ ...image, sourceCommit }));
    if (mutation === 'missing') records.pop();
    if (mutation === 'extra') records.push({ name: 'extra', repository: 'ghcr.io/lanternops/breeze/extra', digest: digest('e'), sourceCommit });
    if (mutation === 'duplicate') records[1] = { ...records[1], name: records[0].name };
    if (mutation === 'repository') records[0] = { ...records[0], repository: 'https://attacker.invalid/api' };
    records.forEach((record, index) => writeFileSync(join(directory, `${index}.json`), JSON.stringify(record)));
    if (mutation === 'malformed') writeFileSync(join(directory, '0.json'), '{');
    assert.throws(() => collectReleaseImageMetadata({ directory, sourceCommit }));
  }
});
