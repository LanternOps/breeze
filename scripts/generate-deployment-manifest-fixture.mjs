#!/usr/bin/env node
// Regenerates agent/internal/updater/testdata/deployment_signed_manifest.json —
// the cross-language trust-chain golden fixture. Deterministic: fixed Ed25519
// seed + deterministic RFC 8032 signatures, so re-running is a no-op unless the
// normalized-manifest shape changes (in which case BOTH sides of the contract
// must move together; see releaseTrustChain.e2e.test.ts and
// deployment_trustchain_test.go).
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_ID = 'deploy-fixture-trustchain';
const REPO = 'acme/breeze-selfhost-signing';
const VERSION = '9.9.9';

const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(SEED_HEX, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const publicKeyB64 = spki.subarray(spki.length - 32).toString('base64');

const checksum = createHash('sha256').update('trust-chain-fixture-binary').digest('hex');

const targets = [
  { goos: 'linux', platform: 'linux', arch: 'amd64', ext: '' },
  { goos: 'linux', platform: 'linux', arch: 'arm64', ext: '' },
  { goos: 'darwin', platform: 'macos', arch: 'amd64', ext: '' },
  { goos: 'darwin', platform: 'macos', arch: 'arm64', ext: '' },
  { goos: 'windows', platform: 'windows', arch: 'amd64', ext: '.exe' },
];

const entries = targets.map((t) => {
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/breeze-agent-${t.goos}-${t.arch}${t.ext}`;
  // EXACT key order of binarySync.applyDeploymentSigning's normalized manifest.
  const manifest = JSON.stringify({
    version: VERSION,
    component: 'agent',
    platform: t.platform,
    arch: t.arch,
    url,
    checksum,
    size: 4096,
  });
  return {
    platform: t.platform,
    arch: t.arch,
    url,
    checksum,
    manifest,
    signatureB64: sign(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64'),
  };
});

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agent/internal/updater/testdata/deployment_signed_manifest.json',
);
writeFileSync(out, JSON.stringify({ keyId: KEY_ID, publicKeyB64, entries }, null, 2) + '\n');
console.log(`wrote ${out}`);
