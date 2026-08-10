#!/usr/bin/env node
// verify-manifest.test.mjs — self-test for verify-manifest.mjs. Run: node scripts/verify-manifest.test.mjs
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-manifest.mjs');
const dir = mkdtempSync(join(tmpdir(), 'verify-manifest-test-'));
let failures = 0;

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}
function expect(label, cond) {
  if (cond) console.log(`PASS ${label}`);
  else { console.error(`FAIL ${label}`); failures += 1; }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const keyPath = join(dir, 'key.pub');
writeFileSync(keyPath, `${rawPub}\n`);

const asset = Buffer.from('unsigned-binary-bytes');
const assetPath = join(dir, 'breeze-agent-windows-amd64-unsigned.exe');
writeFileSync(assetPath, asset);

const manifest = {
  schemaVersion: 1,
  repository: 'lanternops/breeze',
  release: 'v9.9.9',
  sourceCommit: 'a'.repeat(40),
  assets: [
    {
      name: 'breeze-agent-windows-amd64-unsigned.exe',
      sha256: createHash('sha256').update(asset).digest('hex'),
      size: asset.length,
      platformTrust: 'none',
      intendedUse: 'signing-input',
    },
    {
      name: 'breeze-agent-linux-amd64',
      sha256: createHash('sha256').update(asset).digest('hex'),
      size: asset.length,
      platformTrust: 'release-workflow-produced',
    },
  ],
};
const manifestPath = join(dir, 'manifest.json');
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(manifestPath, manifestBytes);
const sigPath = join(dir, 'manifest.json.ed25519');
writeFileSync(sigPath, sign(null, manifestBytes, privateKey).toString('base64') + '\n');

const okVerify = run(['verify', '--manifest', manifestPath, '--signature', sigPath,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: valid manifest', okVerify.status === 0 && okVerify.stdout.trim() === 'a'.repeat(40));

const tamperedPath = join(dir, 'tampered.json');
writeFileSync(tamperedPath, Buffer.concat([manifestBytes, Buffer.from(' ')]));
const badVerify = run(['verify', '--manifest', tamperedPath, '--signature', sigPath,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: tampered manifest rejected', badVerify.status !== 0);

const noCommit = { ...manifest };
delete noCommit.sourceCommit;
const noCommitBytes = Buffer.from(JSON.stringify(noCommit, null, 2));
const noCommitPath = join(dir, 'nocommit.json');
writeFileSync(noCommitPath, noCommitBytes);
writeFileSync(`${noCommitPath}.ed25519`, sign(null, noCommitBytes, privateKey).toString('base64'));
const noCommitVerify = run(['verify', '--manifest', noCommitPath, '--signature', `${noCommitPath}.ed25519`,
  '--key', keyPath, '--repository', 'lanternops/breeze', '--release', 'v9.9.9']);
expect('verify: missing sourceCommit rejected', noCommitVerify.status !== 0);

const okAsset = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--expect-signing-input']);
expect('check-asset: valid signing input', okAsset.status === 0);

const wrongFile = join(dir, 'wrong.bin');
writeFileSync(wrongFile, 'different-bytes');
const badAsset = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', wrongFile, '--expect-signing-input']);
expect('check-asset: hash mismatch rejected', badAsset.status !== 0);

const mirrorRejected = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--forbid-signing-input']);
expect('check-asset: signing input rejected as mirror', mirrorRejected.status !== 0);

const mirrorOk = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-linux-amd64', '--file', assetPath, '--forbid-signing-input']);
expect('check-asset: distributable mirror accepted', mirrorOk.status === 0);

rmSync(dir, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('all verify-manifest tests passed');
