#!/usr/bin/env node
// verify-manifest.mjs — verify the official Breeze release-artifact-manifest
// (raw Ed25519, base64 signature) and check downloaded assets against it.
// Pure node:crypto so it runs identically on ubuntu/windows/macos runners and
// matches the verifier the Breeze API itself uses.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function loadPublicKey(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (text.includes('BEGIN PUBLIC KEY')) return createPublicKey(text);
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 32) {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, decoded]),
      format: 'der',
      type: 'spki',
    });
  }
  return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
function has(name) {
  return process.argv.includes(name);
}
function die(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const cmd = process.argv[2];

// Reject unrecognised flags. `has()` is an exact match, so a typo such as
// --expect-signing-inputs would silently disable the intendedUse policy and
// exit 0 — the gate would be gone with every job still green. Callers pass
// these as literal strings from shell (download-verified-asset.sh forwards $4
// verbatim), so a typo is a live risk, not a hypothetical one.
const KNOWN_FLAGS = {
  verify: ['--manifest', '--signature', '--key', '--repository', '--release'],
  'check-asset': [
    '--manifest',
    '--name',
    '--file',
    '--expect-signing-input',
    '--forbid-signing-input',
  ],
};
const VALUE_FLAGS = new Set([
  '--manifest',
  '--signature',
  '--key',
  '--repository',
  '--release',
  '--name',
  '--file',
]);
if (KNOWN_FLAGS[cmd]) {
  const allowed = new Set(KNOWN_FLAGS[cmd]);
  for (let i = 3; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    // Skip a value that happens to look like a flag (e.g. --name --weird).
    if (VALUE_FLAGS.has(process.argv[i - 1])) continue;
    if (!allowed.has(token)) {
      die(`unknown option ${token} for '${cmd}' (known: ${KNOWN_FLAGS[cmd].join(', ')})`);
    }
  }
}

if (cmd === 'verify') {
  const manifestPath = arg('--manifest');
  const sigPath = arg('--signature');
  const keyPath = arg('--key');
  const repository = arg('--repository');
  const release = arg('--release');
  if (!manifestPath || !sigPath || !keyPath || !repository || !release) {
    die('verify: --manifest, --signature, --key, --repository, --release are all required');
  }
  const manifestBytes = readFileSync(manifestPath);
  const signature = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');
  const key = loadPublicKey(keyPath);
  if (!edVerify(null, manifestBytes, key, signature)) {
    die('release manifest Ed25519 signature verification FAILED — refusing to continue');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  // The Breeze API requires schemaVersion === 1. A future schema could give
  // intendedUse/platformTrust different meanings, and this verifier would
  // apply schema-1 rules to it without noticing.
  if (manifest.schemaVersion !== 1) {
    die(`unsupported manifest schemaVersion: ${manifest.schemaVersion} (this verifier understands 1)`);
  }
  if (manifest.repository !== repository) {
    die(`manifest repository mismatch: expected ${repository}, got ${manifest.repository}`);
  }
  if (manifest.release !== release) {
    die(`manifest release mismatch: expected ${release}, got ${manifest.release}`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? '')) {
    die('manifest has no valid sourceCommit — this Breeze release predates BYO-signing support (need a release with the unsigned asset set)');
  }
  process.stdout.write(`${manifest.sourceCommit}\n`);
} else if (cmd === 'check-asset') {
  const manifestPath = arg('--manifest');
  const name = arg('--name');
  const file = arg('--file');
  if (!manifestPath || !name || !file) {
    die('check-asset: --manifest, --name, --file are all required');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = (manifest.assets ?? []).find((a) => a.name === name);
  if (!entry) die(`asset ${name} is not present in the signed manifest`);
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.sha256) {
    die(`sha256 mismatch for ${name}: manifest=${entry.sha256} actual=${sha256}`);
  }
  if (bytes.length !== entry.size) {
    die(`size mismatch for ${name}: manifest=${entry.size} actual=${bytes.length}`);
  }
  if (has('--expect-signing-input') && entry.intendedUse !== 'signing-input') {
    die(`${name} is not marked intendedUse=signing-input — refusing to treat a distributable asset as a signing input`);
  }
  if (has('--forbid-signing-input') && entry.intendedUse === 'signing-input') {
    die(`${name} is a signing input, not a distributable asset — refusing to mirror it`);
  }
  console.log(`ok ${name} sha256=${sha256} size=${bytes.length}`);
} else {
  die(`unknown command: ${cmd} (expected 'verify' or 'check-asset')`);
}
