#!/usr/bin/env node

import { createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export function collectReleaseImageMetadata({ directory, sourceCommit }) {
  if (!SOURCE_COMMIT_RE.test(sourceCommit ?? '')) fail('source commit is invalid');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length !== REQUIRED_RELEASE_IMAGES.length) {
    fail(`expected ${REQUIRED_RELEASE_IMAGES.length} image metadata files, found ${files.length}`);
  }

  const images = [];
  const names = new Set();
  const repositories = new Set();
  for (const file of files) {
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    } catch (error) {
      fail(`${file}: invalid JSON (${error.message})`);
    }
    if (!isPlainObject(metadata) || metadata.sourceCommit !== sourceCommit) {
      fail(`${file}: sourceCommit does not match the signed release commit`);
    }
    const image = validateImage(metadata, file);
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
  return images.sort((left, right) => left.name.localeCompare(right.name));
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

export function verifyReleaseImageManifest({
  manifestBytes,
  signatureBytes,
  publicKeys,
  expectedRepository,
  expectedRelease,
  requiredImages,
}) {
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

  for (const required of requiredImages) {
    const actual = byName.get(required.name);
    if (!actual) fail(`signed release manifest is missing required image ${required.name}`);
    if (actual.repository !== required.repository || actual.digest !== required.digest) {
      fail(`configured ${required.name} image does not match the signed release manifest`);
    }
  }
  return { sourceCommit: manifest.sourceCommit, images: [...byName.values()] };
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
    writeFileSync(options.output, `${JSON.stringify({ ...image, sourceCommit: options.sourceCommit }, null, 2)}\n`);
    return;
  }
  if (command === 'collect') {
    const images = collectReleaseImageMetadata(options);
    writeFileSync(options.output, `${JSON.stringify(images, null, 2)}\n`);
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
    });
    process.stdout.write(`Verified ${options.requiredImages.length} signed release images from ${verified.sourceCommit}\n`);
    return;
  }
  fail('usage: release-image-manifest.mjs <record|collect|verify> ...');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
