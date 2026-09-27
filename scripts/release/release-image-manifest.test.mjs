import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_RELEASE_IMAGES,
  collectReleaseImageMetadata,
  collectReleaseImageSet,
  verifyReleaseImageManifest,
} from './release-image-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// ── Server-only releases: release kind, carried binaries, provenance ─────────
const baseCommit = 'b'.repeat(40);

function serverOnlyFields(overrides = {}) {
  const binaries = images().find((image) => image.name === 'binaries');
  return {
    releaseKind: 'server-only',
    binariesRelease: 'v1.2.0',
    binariesSourceCommit: baseCommit,
    carriedImages: [{ ...binaries, fromRelease: 'v1.2.0', fromSourceCommit: baseCommit }],
    ...overrides,
  };
}

function verifyKind(fixture, requireKind) {
  return verifyReleaseImageManifest({
    manifestBytes: fixture.manifest,
    signatureBytes: fixture.signature,
    publicKeys: fixture.publicKeys,
    expectedRepository: 'lanternops/breeze',
    expectedRelease: 'v1.2.3',
    requiredImages: [],
    requireKind,
  });
}

test('an absent releaseKind is a full release; an explicit full release verifies unchanged', () => {
  assert.equal(verifyKind(signedManifest(), 'full').releaseKind, 'full');
  assert.equal(verifyKind(signedManifest({ releaseKind: 'full' }), 'full').releaseKind, 'full');
  assert.equal(verifyKind(signedManifest({ releaseKind: 'full' }), 'any').releaseKind, 'full');
  assert.equal(verifyFixture(signedManifest({ releaseKind: 'full' })).images.length, 7);
});

test('a server-only manifest verifies and exposes its binaries pairing', () => {
  const verified = verifyKind(signedManifest(serverOnlyFields()), 'server-only');
  assert.equal(verified.releaseKind, 'server-only');
  assert.equal(verified.binariesRelease, 'v1.2.0');
  assert.equal(verified.binariesSourceCommit, baseCommit);
  assert.equal(verified.carriedImages.length, 1);
  // Existing callers that do not ask for a kind still accept it.
  assert.equal(verifyFixture(signedManifest(serverOnlyFields())).images.length, 7);
});

test('--require-kind refuses the other kind', () => {
  assert.throws(() => verifyKind(signedManifest(serverOnlyFields()), 'full'), /release kind server-only, expected full/u);
  assert.throws(() => verifyKind(signedManifest(), 'server-only'), /release kind full, expected server-only/u);
  assert.throws(() => verifyKind(signedManifest(), 'partial'), /invalid required release kind/u);
});

test('refuses malformed server-only and full kind fields', () => {
  const binaries = images().find((image) => image.name === 'binaries');
  const cases = [
    [{ releaseKind: 'agent-only' }, /releaseKind is invalid/u],
    [serverOnlyFields({ binariesRelease: undefined }), /binariesRelease must be a stable release tag/u],
    [serverOnlyFields({ binariesRelease: 'v1.2.0-rc.1' }), /binariesRelease must be a stable release tag/u],
    [serverOnlyFields({ binariesRelease: 'v1.2.3' }), /binariesRelease must differ from release/u],
    [serverOnlyFields({ binariesSourceCommit: 'nope' }), /binariesSourceCommit is invalid/u],
    [serverOnlyFields({ carriedImages: [] }), /carriedImages must list the carried binaries image/u],
    [serverOnlyFields({ carriedImages: [{ ...binaries, digest: digest('f'), fromRelease: 'v1.2.0', fromSourceCommit: baseCommit }] }), /carriedImages\[0\] does not match images/u],
    [serverOnlyFields({ carriedImages: [{ ...binaries, fromRelease: 'v1.1.0', fromSourceCommit: baseCommit }] }), /carriedImages\[0\] provenance does not match/u],
    [serverOnlyFields({ carriedImages: [{ ...images()[0], fromRelease: 'v1.2.0', fromSourceCommit: baseCommit }] }), /only the binaries image may be carried/u],
    [{ releaseKind: 'full', binariesRelease: 'v1.2.0' }, /full release must not carry/u],
    [{ carriedImages: [] }, /full release must not carry/u],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => verifyKind(signedManifest(overrides), 'any'), expected, JSON.stringify(overrides));
  }
});

function metadataDirectory(records) {
  const directory = mkdtempSync(join(tmpdir(), 'release-image-carried-'));
  scratch.push(directory);
  records.forEach((record) => writeFileSync(join(directory, `${record.name}.json`), JSON.stringify(record)));
  return directory;
}

function carriedRecords({ carriedName = 'binaries', recordCommit = baseCommit, fromCommit = baseCommit } = {}) {
  return images().map((image) => (image.name === carriedName
    ? { ...image, sourceCommit: recordCommit, carriedFromRelease: 'v1.2.0', carriedFromSourceCommit: fromCommit }
    : { ...image, sourceCommit }));
}

test('collector preserves carried-binaries provenance for a server-only release', () => {
  const directory = metadataDirectory(carriedRecords());
  const collected = collectReleaseImageSet({ directory, sourceCommit, releaseKind: 'server-only', carriedSourceCommit: baseCommit });
  assert.equal(collected.images.length, 7);
  assert.ok(collected.images.every((image) => Object.keys(image).sort().join(',') === 'digest,name,repository'),
    'images[] entries keep their exact shape');
  const binaries = images().find((image) => image.name === 'binaries');
  assert.deepEqual(collected.carried, [{
    name: 'binaries',
    repository: binaries.repository,
    digest: binaries.digest,
    fromRelease: 'v1.2.0',
    fromSourceCommit: baseCommit,
  }]);
});

test('collector refuses carried records outside the server-only binaries rule', () => {
  const cases = [
    [carriedRecords(), 'full', undefined, /carried image record .* is only allowed in a server-only release/u],
    [carriedRecords({ carriedName: 'api' }), 'server-only', baseCommit, /only the binaries image may be carried/u],
    [carriedRecords({ recordCommit: sourceCommit }), 'server-only', baseCommit, /carried binaries sourceCommit must be the base commit/u],
    [carriedRecords({ fromCommit: 'c'.repeat(40) }), 'server-only', baseCommit, /carried binaries sourceCommit must be the base commit/u],
    [carriedRecords(), 'server-only', 'c'.repeat(40), /carried binaries sourceCommit must be the base commit/u],
    [carriedRecords(), 'server-only', undefined, /carried source commit is invalid/u],
    [images().map((image) => ({ ...image, sourceCommit })), 'server-only', baseCommit, /server-only release must carry the binaries image/u],
    [carriedRecords(), 'partial', baseCommit, /release kind is invalid/u],
  ];
  for (const [records, releaseKind, carriedSourceCommit, expected] of cases) {
    const directory = metadataDirectory(records);
    assert.throws(
      () => collectReleaseImageSet({ directory, sourceCommit, releaseKind, carriedSourceCommit }),
      expected,
      `${releaseKind} ${carriedSourceCommit}`,
    );
  }
});

test('collectReleaseImageMetadata keeps its full-release contract', () => {
  const directory = metadataDirectory(carriedRecords());
  assert.throws(() => collectReleaseImageMetadata({ directory, sourceCommit }), /only allowed in a server-only release/u);
});

test('CLI: record writes carried provenance, collect writes the carried list, verify prints the kind', () => {
  const work = mkdtempSync(join(tmpdir(), 'release-image-cli-'));
  scratch.push(work);
  const cli = (...args) => spawnSync('node', [join(HERE, 'release-image-manifest.mjs'), ...args], { encoding: 'utf8', env: { ...process.env } });
  const binaries = images().find((image) => image.name === 'binaries');

  const recorded = cli('record', '--name', 'binaries', '--repository', binaries.repository, '--digest', binaries.digest,
    '--source-commit', baseCommit, '--carried-from-release', 'v1.2.0', '--carried-from-source-commit', baseCommit,
    '--output', join(work, 'binaries.json'));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'binaries.json'), 'utf8')), {
    ...binaries, sourceCommit: baseCommit, carriedFromRelease: 'v1.2.0', carriedFromSourceCommit: baseCommit,
  });
  const halfCarried = cli('record', '--name', 'binaries', '--repository', binaries.repository, '--digest', binaries.digest,
    '--source-commit', baseCommit, '--carried-from-release', 'v1.2.0', '--output', join(work, 'x.json'));
  assert.notEqual(halfCarried.status, 0);

  for (const image of images().filter((entry) => entry.name !== 'binaries')) {
    writeFileSync(join(work, `${image.name}.json`), JSON.stringify({ ...image, sourceCommit }));
  }
  const collected = cli('collect', '--directory', work, '--source-commit', sourceCommit, '--release-kind', 'server-only',
    '--carried-source-commit', baseCommit, '--carried-output', join(work, 'carried.out'), '--output', join(work, 'images.out'));
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(JSON.parse(readFileSync(join(work, 'images.out'), 'utf8')).length, 7);
  assert.equal(JSON.parse(readFileSync(join(work, 'carried.out'), 'utf8'))[0].fromRelease, 'v1.2.0');

  const withoutCarriedOutput = cli('collect', '--directory', work, '--source-commit', sourceCommit, '--release-kind', 'server-only',
    '--carried-source-commit', baseCommit, '--output', join(work, 'images2.out'));
  assert.notEqual(withoutCarriedOutput.status, 0, 'server-only collect must not silently drop carry provenance');

  const fixture = signedManifest(serverOnlyFields());
  writeFileSync(join(work, 'm.json'), fixture.manifest);
  writeFileSync(join(work, 'm.json.ed25519'), fixture.signature);
  const verified = spawnSync('node', [join(HERE, 'release-image-manifest.mjs'), 'verify', '--manifest', join(work, 'm.json'),
    '--signature', join(work, 'm.json.ed25519'), '--expected-repository', repository, '--expected-release', 'v1.2.3',
    '--require-kind', 'server-only', '--output', join(work, 'identity.json')], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: fixture.publicKeys },
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /server-only release v1\.2\.3 pairs with binaries v1\.2\.0/u);
  const identity = JSON.parse(readFileSync(join(work, 'identity.json'), 'utf8'));
  assert.equal(identity.releaseKind, 'server-only');
  assert.equal(identity.sourceCommit, sourceCommit);
  assert.ok(Array.isArray(identity.assets));
});
