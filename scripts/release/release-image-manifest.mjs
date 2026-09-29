#!/usr/bin/env node

import { createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/u;
const IMAGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/u;
const IMAGE_REPOSITORY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)+$/u;
const RAW_ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_MANIFEST_BYTES = 1024 * 1024;

export const REQUIRED_RELEASE_IMAGES = Object.freeze([
  'api',
  'web',
  'portal',
  'binaries',
  'm365-graph-read-executor',
  'm365-graph-actions-executor',
  'm365-communications-executor',
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateImage(image, label = 'image') {
  if (!isPlainObject(image)) fail(`${label} must be an object`);
  if (!IMAGE_NAME_RE.test(image.name ?? '')) fail(`${label}.name is invalid`);
  if (!IMAGE_REPOSITORY_RE.test(image.repository ?? '')) fail(`${label}.repository is invalid`);
  if (image.repository !== image.repository.toLowerCase()) fail(`${label}.repository must be lowercase`);
  if (!DIGEST_RE.test(image.digest ?? '')) fail(`${label}.digest must be an exact sha256 digest`);
  return { name: image.name, repository: image.repository, digest: image.digest };
}

export const RELEASE_KINDS = Object.freeze(['full', 'server-only']);
const STABLE_TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
// Only the binaries-init image may be carried forward from a full release by a
// server-only release; every other image is rebuilt from the release commit.
const CARRIABLE_IMAGES = Object.freeze(['binaries']);

function isCarriedRecord(metadata) {
  return 'carriedFromRelease' in metadata || 'carriedFromSourceCommit' in metadata;
}

// Collects the per-image metadata records the release jobs uploaded. A record
// carrying `carriedFromRelease` is accepted only for a server-only release,
// only for the binaries image, and only when its sourceCommit is truthfully the
// base release's commit. Every other record must match the release commit.
export function collectReleaseImageSet({ directory, sourceCommit, releaseKind = 'full', carriedSourceCommit }) {
  if (!SOURCE_COMMIT_RE.test(sourceCommit ?? '')) fail('source commit is invalid');
  if (!RELEASE_KINDS.includes(releaseKind)) fail(`release kind is invalid: ${releaseKind}`);
  if (releaseKind === 'server-only' && !SOURCE_COMMIT_RE.test(carriedSourceCommit ?? '')) {
    fail('carried source commit is invalid');
  }
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length !== REQUIRED_RELEASE_IMAGES.length) {
    fail(`expected ${REQUIRED_RELEASE_IMAGES.length} image metadata files, found ${files.length}`);
  }

  const images = [];
  const carried = [];
  const names = new Set();
  const repositories = new Set();
  for (const file of files) {
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    } catch (error) {
      fail(`${file}: invalid JSON (${error.message})`);
    }
    if (!isPlainObject(metadata)) fail(`${file}: metadata must be an object`);
    const image = validateImage(metadata, file);
    if (isCarriedRecord(metadata)) {
      if (releaseKind !== 'server-only') {
        fail(`${file}: carried image record for ${image.name} is only allowed in a server-only release`);
      }
      if (!CARRIABLE_IMAGES.includes(image.name)) fail(`${file}: only the binaries image may be carried, not ${image.name}`);
      if (!STABLE_TAG_RE.test(metadata.carriedFromRelease ?? '')) fail(`${file}: carriedFromRelease must be a stable release tag`);
      if (
        metadata.sourceCommit !== carriedSourceCommit
        || metadata.carriedFromSourceCommit !== carriedSourceCommit
      ) {
        fail(`${file}: carried binaries sourceCommit must be the base commit ${carriedSourceCommit}`);
      }
      carried.push({
        ...image,
        fromRelease: metadata.carriedFromRelease,
        fromSourceCommit: metadata.carriedFromSourceCommit,
      });
    } else if (metadata.sourceCommit !== sourceCommit) {
      fail(`${file}: sourceCommit does not match the signed release commit`);
    }
    if (names.has(image.name)) fail(`${file}: duplicate image name ${image.name}`);
    if (repositories.has(image.repository)) fail(`${file}: duplicate image repository ${image.repository}`);
    names.add(image.name);
    repositories.add(image.repository);
    images.push(image);
  }

  const missing = REQUIRED_RELEASE_IMAGES.filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !REQUIRED_RELEASE_IMAGES.includes(name));
  if (missing.length || extra.length) {
    fail(`release image set mismatch; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }
  if (releaseKind === 'server-only' && !carried.some((entry) => entry.name === 'binaries')) {
    fail('a server-only release must carry the binaries image from its base release');
  }
  return {
    images: images.sort((left, right) => left.name.localeCompare(right.name)),
    carried: carried.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

// Full-release contract (unchanged): refuses any carried record.
export function collectReleaseImageMetadata({ directory, sourceCommit }) {
  return collectReleaseImageSet({ directory, sourceCommit, releaseKind: 'full' }).images;
}

function publicKeyFromConfiguredValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN PUBLIC KEY-----')) {
    return createPublicKey(trimmed);
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) {
    return createPublicKey({
      key: Buffer.concat([RAW_ED25519_SPKI_PREFIX, decoded]),
      format: 'der',
      type: 'spki',
    });
  }
  return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
}

function verifySignature(manifestBytes, signatureBytes, configuredKeys) {
  if (manifestBytes.length > MAX_MANIFEST_BYTES) fail('release manifest exceeds 1 MiB');
  const signatureText = signatureBytes.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signatureText)) fail('release manifest signature is not base64');
  const signature = Buffer.from(signatureText, 'base64');
  if (signature.length !== 64) fail('release manifest signature is not an Ed25519 signature');

  const keys = configuredKeys.split(',').map((value) => value.trim()).filter(Boolean);
  if (keys.length === 0) fail('no release manifest public key is configured');
  for (const configuredKey of keys) {
    try {
      if (verify(null, manifestBytes, publicKeyFromConfiguredValue(configuredKey), signature)) return;
    } catch {
      // Try the remaining configured rotation keys. A malformed set still fails closed.
    }
  }
  fail('release manifest signature verification failed');
}

// Validates the additive server-only fields. Absent releaseKind means a full
// release (every manifest signed before the server-only lane existed).
function validateReleaseKind(manifest, byName) {
  const releaseKind = manifest.releaseKind ?? 'full';
  if (!RELEASE_KINDS.includes(releaseKind)) fail('release manifest releaseKind is invalid');
  if (releaseKind === 'full') {
    for (const key of ['binariesRelease', 'binariesSourceCommit', 'carriedImages']) {
      if (key in manifest) fail(`a full release must not carry ${key}`);
    }
    return { releaseKind };
  }

  if (!STABLE_TAG_RE.test(manifest.binariesRelease ?? '')) fail('binariesRelease must be a stable release tag');
  if (manifest.binariesRelease === manifest.release) fail('binariesRelease must differ from release');
  if (!SOURCE_COMMIT_RE.test(manifest.binariesSourceCommit ?? '')) fail('binariesSourceCommit is invalid');
  if (!Array.isArray(manifest.carriedImages) || manifest.carriedImages.length === 0) {
    fail('carriedImages must list the carried binaries image');
  }
  const carriedImages = [];
  const carriedNames = new Set();
  for (const [index, entry] of manifest.carriedImages.entries()) {
    const image = validateImage(entry, `carriedImages[${index}]`);
    if (!CARRIABLE_IMAGES.includes(image.name)) fail(`only the binaries image may be carried, not ${image.name}`);
    if (carriedNames.has(image.name)) fail(`carriedImages lists ${image.name} twice`);
    carriedNames.add(image.name);
    const signed = byName.get(image.name);
    if (!signed || signed.repository !== image.repository || signed.digest !== image.digest) {
      fail(`carriedImages[${index}] does not match images[] for ${image.name}`);
    }
    if (entry.fromRelease !== manifest.binariesRelease || entry.fromSourceCommit !== manifest.binariesSourceCommit) {
      fail(`carriedImages[${index}] provenance does not match binariesRelease/binariesSourceCommit`);
    }
    carriedImages.push({ ...image, fromRelease: entry.fromRelease, fromSourceCommit: entry.fromSourceCommit });
  }
  if (!carriedNames.has('binaries')) fail('carriedImages must list the carried binaries image');
  return {
    releaseKind,
    binariesRelease: manifest.binariesRelease,
    binariesSourceCommit: manifest.binariesSourceCommit,
    carriedImages,
  };
}

export function verifyReleaseImageManifest({
  manifestBytes,
  signatureBytes,
  publicKeys,
  expectedRepository,
  expectedRelease,
  requiredImages,
  requireKind = 'any',
}) {
  if (requireKind !== 'any' && !RELEASE_KINDS.includes(requireKind)) fail(`invalid required release kind: ${requireKind}`);
  verifySignature(manifestBytes, signatureBytes, publicKeys);

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail(`release manifest is invalid JSON (${error.message})`);
  }
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1) fail('release manifest schemaVersion must be 1');
  if ((manifest.repository ?? '').toLowerCase() !== expectedRepository.toLowerCase()) {
    fail('release manifest repository mismatch');
  }
  if (manifest.release !== expectedRelease) fail('release manifest release mismatch');
  if (!SOURCE_COMMIT_RE.test(manifest.sourceCommit ?? '')) fail('release manifest sourceCommit is invalid');
  if (!Array.isArray(manifest.images)) fail('release manifest images must be an array');

  const byName = new Map();
  const repositories = new Set();
  for (const [index, candidate] of manifest.images.entries()) {
    const image = validateImage(candidate, `images[${index}]`);
    if (byName.has(image.name)) fail(`duplicate signed image name ${image.name}`);
    if (repositories.has(image.repository)) fail(`duplicate signed image repository ${image.repository}`);
    byName.set(image.name, image);
    repositories.add(image.repository);
  }

  const signedNames = new Set(byName.keys());
  const missing = REQUIRED_RELEASE_IMAGES.filter((name) => !signedNames.has(name));
  const extra = [...signedNames].filter((name) => !REQUIRED_RELEASE_IMAGES.includes(name));
  if (missing.length || extra.length) {
    fail(`signed release image set mismatch; missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`);
  }

  const kind = validateReleaseKind(manifest, byName);
  if (requireKind !== 'any' && kind.releaseKind !== requireKind) {
    fail(`release manifest has release kind ${kind.releaseKind}, expected ${requireKind}`);
  }

  for (const required of requiredImages) {
    const actual = byName.get(required.name);
    if (!actual) fail(`signed release manifest is missing required image ${required.name}`);
    if (actual.repository !== required.repository || actual.digest !== required.digest) {
      fail(`configured ${required.name} image does not match the signed release manifest`);
    }
  }
  return {
    release: manifest.release,
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    images: [...byName.values()],
    assets: Array.isArray(manifest.assets) ? manifest.assets : [],
    ...kind,
  };
}

function parseOptions(args) {
  const result = { requiredImages: [] };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key.startsWith('--') || value === undefined) fail(`missing value for ${key}`);
    index += 1;
    if (key === '--require-image') {
      const match = /^([^=]+)=(.+)@(sha256:[0-9a-f]{64})$/u.exec(value);
      if (!match) fail(`invalid --require-image value ${value}`);
      result.requiredImages.push({ name: match[1], repository: match[2], digest: match[3] });
    } else {
      result[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    }
  }
  return result;
}

function runCli(argv) {
  const [command, ...args] = argv;
  const options = parseOptions(args);
  if (command === 'record') {
    const image = validateImage(options);
    if (!SOURCE_COMMIT_RE.test(options.sourceCommit ?? '')) fail('source commit is invalid');
    const record = { ...image, sourceCommit: options.sourceCommit };
    const carried = [options.carriedFromRelease, options.carriedFromSourceCommit];
    if (carried.some((value) => value !== undefined)) {
      // A carried record's sourceCommit is truthfully the base commit it was
      // built from — never the server-only release commit.
      if (!STABLE_TAG_RE.test(options.carriedFromRelease ?? '')) fail('--carried-from-release must be a stable release tag');
      if (options.carriedFromSourceCommit !== options.sourceCommit) {
        fail('--carried-from-source-commit must equal --source-commit (the base commit)');
      }
      record.carriedFromRelease = options.carriedFromRelease;
      record.carriedFromSourceCommit = options.carriedFromSourceCommit;
    }
    writeFileSync(options.output, `${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  if (command === 'collect') {
    const releaseKind = options.releaseKind ?? 'full';
    if (releaseKind === 'server-only' && !options.carriedOutput) {
      fail('--carried-output is required for a server-only release (carry provenance must be preserved)');
    }
    const { images, carried } = collectReleaseImageSet({
      directory: options.directory,
      sourceCommit: options.sourceCommit,
      releaseKind,
      carriedSourceCommit: options.carriedSourceCommit,
    });
    writeFileSync(options.output, `${JSON.stringify(images, null, 2)}\n`);
    if (options.carriedOutput) writeFileSync(options.carriedOutput, `${JSON.stringify(carried, null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const verified = verifyReleaseImageManifest({
      manifestBytes: readFileSync(options.manifest),
      signatureBytes: readFileSync(options.signature),
      publicKeys: process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS ?? '',
      expectedRepository: options.expectedRepository,
      expectedRelease: options.expectedRelease,
      requiredImages: options.requiredImages,
      requireKind: options.requireKind ?? 'any',
    });
    if (options.output) writeFileSync(options.output, `${JSON.stringify(verified, null, 2)}\n`);
    process.stdout.write(`Verified ${options.requiredImages.length} signed release images from ${verified.sourceCommit}\n`);
    process.stdout.write(verified.releaseKind === 'server-only'
      ? `Release kind: server-only release ${verified.release} pairs with binaries ${verified.binariesRelease} (${verified.binariesSourceCommit})\n`
      : `Release kind: full\n`);
    return;
  }
  fail('usage: release-image-manifest.mjs <record|collect|verify> ...');
}

// Compare real paths: the guard runs these helpers from a temporary directory
// that may sit behind a symlink (/var -> /private/var on macOS). A plain URL
// comparison would then silently skip the CLI and exit 0 with no output.
function invokedAsCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
