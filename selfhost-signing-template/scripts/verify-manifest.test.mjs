#!/usr/bin/env node
// verify-manifest.test.mjs — self-test for verify-manifest.mjs. Run: node scripts/verify-manifest.test.mjs
//
// Every negative case asserts the REASON (a stderr pattern), not just a
// non-zero exit. Exit-code-only assertions pass for the wrong reason whenever a
// fixture path breaks — a typo'd path exits 1 via an uncaught ENOENT and looks
// identical to a genuine rejection, which is the direction this suite is most
// likely to rot.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'verify-manifest.mjs');
const dir = mkdtempSync(join(tmpdir(), 'verify-manifest-test-'));
let failures = 0;

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}
function expect(label, cond) {
  if (cond) console.log(`PASS ${label}`);
  else {
    console.error(`FAIL ${label}`);
    failures += 1;
  }
}
// Asserts a non-zero exit AND that stderr explains why.
function expectFail(label, result, pattern) {
  const ok = result.status !== 0 && pattern.test(result.stderr);
  if (ok) console.log(`PASS ${label}`);
  else {
    console.error(
      `FAIL ${label} (status=${result.status}, stderr=${JSON.stringify(result.stderr.trim())})`
    );
    failures += 1;
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const keyPath = join(dir, 'key.pub');
writeFileSync(keyPath, `${rawPub}\n`);

// The committed official-release-key.pub is PEM, not raw base64 — exercise the
// branch production actually takes.
const pemKeyPath = join(dir, 'key.pem.pub');
writeFileSync(pemKeyPath, publicKey.export({ format: 'pem', type: 'spki' }));

// A second, unrelated keypair: a valid signature from the WRONG key must not
// verify. Without this, removing the signature check entirely kills only the
// tampered-payload test.
const other = generateKeyPairSync('ed25519');

const asset = Buffer.from('unsigned-binary-bytes');
const assetPath = join(dir, 'breeze-agent-windows-amd64-unsigned.exe');
writeFileSync(assetPath, asset);

const sha = (b) => createHash('sha256').update(b).digest('hex');

const manifest = {
  schemaVersion: 1,
  repository: 'lanternops/breeze',
  release: 'v9.9.9',
  sourceCommit: 'a'.repeat(40),
  assets: [
    {
      name: 'breeze-agent-windows-amd64-unsigned.exe',
      sha256: sha(asset),
      size: asset.length,
      platformTrust: 'none',
      intendedUse: 'signing-input',
    },
    {
      name: 'breeze-agent-linux-amd64',
      sha256: sha(asset),
      size: asset.length,
      platformTrust: 'release-workflow-produced',
    },
    {
      // Same bytes, wrong recorded size: proves the size check is independent
      // of the hash check.
      name: 'breeze-wrong-size',
      sha256: sha(asset),
      size: asset.length + 1,
      platformTrust: 'release-workflow-produced',
    },
  ],
};

// Writes a manifest + a detached signature over its exact bytes.
function writeSigned(name, obj, signer = privateKey) {
  const bytes = Buffer.from(JSON.stringify(obj, null, 2));
  const mPath = join(dir, `${name}.json`);
  const sPath = join(dir, `${name}.json.ed25519`);
  writeFileSync(mPath, bytes);
  writeFileSync(sPath, `${sign(null, bytes, signer).toString('base64')}\n`);
  return { manifestPath: mPath, sigPath: sPath, bytes };
}

const { manifestPath, sigPath, bytes: manifestBytes } = writeSigned('manifest', manifest);

const verifyArgs = (over = {}) => [
  'verify',
  '--manifest', over.manifest ?? manifestPath,
  '--signature', over.signature ?? sigPath,
  '--key', over.key ?? keyPath,
  '--repository', over.repository ?? 'lanternops/breeze',
  '--release', over.release ?? 'v9.9.9',
];

// ---------------------------------------------------------------- verify ----

const okVerify = run(verifyArgs());
expect(
  'verify: valid manifest',
  okVerify.status === 0 && okVerify.stdout.trim() === 'a'.repeat(40)
);

const okPem = run(verifyArgs({ key: pemKeyPath }));
expect(
  'verify: PEM public key accepted (the committed key format)',
  okPem.status === 0 && okPem.stdout.trim() === 'a'.repeat(40)
);

const tamperedPath = join(dir, 'tampered.json');
writeFileSync(tamperedPath, Buffer.concat([manifestBytes, Buffer.from(' ')]));
expectFail(
  'verify: tampered manifest rejected',
  run(verifyArgs({ manifest: tamperedPath })),
  /signature verification FAILED/
);

const wrongKeySigned = writeSigned('wrongkey', manifest, other.privateKey);
expectFail(
  'verify: valid signature from a DIFFERENT key rejected',
  run(verifyArgs({ manifest: wrongKeySigned.manifestPath, signature: wrongKeySigned.sigPath })),
  /signature verification FAILED/
);

const garbageSig = join(dir, 'garbage.ed25519');
writeFileSync(garbageSig, 'bm90LWEtc2lnbmF0dXJl\n');
expectFail(
  'verify: truncated/garbage signature rejected',
  run(verifyArgs({ signature: garbageSig })),
  /signature verification FAILED/
);

// Replay: a genuinely-signed manifest from a DIFFERENT release/repo. The
// signature check cannot catch this — only the two string compares can.
expectFail(
  'verify: correctly-signed manifest for the wrong release rejected (downgrade replay)',
  run(verifyArgs({ release: 'v1.0.0' })),
  /release mismatch/
);
expectFail(
  'verify: correctly-signed manifest for the wrong repository rejected',
  run(verifyArgs({ repository: 'attacker/breeze' })),
  /repository mismatch/
);

const noCommit = { ...manifest };
delete noCommit.sourceCommit;
const noCommitSigned = writeSigned('nocommit', noCommit);
expectFail(
  'verify: missing sourceCommit rejected',
  run(verifyArgs({ manifest: noCommitSigned.manifestPath, signature: noCommitSigned.sigPath })),
  /no valid sourceCommit/
);

// sourceCommit feeds `actions/checkout ref:` — it must be a 40-hex SHA, not
// merely 40 characters, or a mutable ref could be checked out instead.
for (const [label, value] of [
  ['uppercase hex', 'A'.repeat(40)],
  ['39 chars', 'a'.repeat(39)],
  ['branch name padded to 40', 'main'.padEnd(40, '-')],
]) {
  const bad = writeSigned(`commit-${label.replace(/\W+/g, '-')}`, {
    ...manifest,
    sourceCommit: value,
  });
  expectFail(
    `verify: malformed sourceCommit rejected (${label})`,
    run(verifyArgs({ manifest: bad.manifestPath, signature: bad.sigPath })),
    /no valid sourceCommit/
  );
}

const futureSchema = writeSigned('schema2', { ...manifest, schemaVersion: 2 });
expectFail(
  'verify: unknown schemaVersion rejected',
  run(verifyArgs({ manifest: futureSchema.manifestPath, signature: futureSchema.sigPath })),
  /unsupported manifest schemaVersion/
);

expectFail(
  'verify: unknown option rejected',
  run([...verifyArgs(), '--no-really-trust-me']),
  /unknown option/
);

// ----------------------------------------------------------- check-asset ----

const okAsset = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--expect-signing-input']);
expect('check-asset: valid signing input', okAsset.status === 0);

const wrongFile = join(dir, 'wrong.bin');
writeFileSync(wrongFile, 'different-bytes');
expectFail(
  'check-asset: hash mismatch rejected',
  run(['check-asset', '--manifest', manifestPath,
    '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', wrongFile, '--expect-signing-input']),
  /sha256 mismatch/
);

expectFail(
  'check-asset: size mismatch rejected',
  run(['check-asset', '--manifest', manifestPath, '--name', 'breeze-wrong-size', '--file', assetPath]),
  /size mismatch/
);

// The core supply-chain case: an asset present on the release that the signed
// manifest does not cover at all.
expectFail(
  'check-asset: asset absent from the manifest rejected',
  run(['check-asset', '--manifest', manifestPath, '--name', 'ghost.exe', '--file', assetPath]),
  /not present in the signed manifest/
);

expectFail(
  'check-asset: signing input rejected as mirror',
  run(['check-asset', '--manifest', manifestPath,
    '--name', 'breeze-agent-windows-amd64-unsigned.exe', '--file', assetPath, '--forbid-signing-input']),
  /is a signing input, not a distributable asset/
);

// The inverse direction — this is the gate that stops a code-signing
// certificate being applied to a distributable the official release never
// marked as a signing input.
expectFail(
  'check-asset: distributable rejected as signing input',
  run(['check-asset', '--manifest', manifestPath,
    '--name', 'breeze-agent-linux-amd64', '--file', assetPath, '--expect-signing-input']),
  /not marked intendedUse=signing-input/
);

const mirrorOk = run(['check-asset', '--manifest', manifestPath,
  '--name', 'breeze-agent-linux-amd64', '--file', assetPath, '--forbid-signing-input']);
expect('check-asset: distributable mirror accepted', mirrorOk.status === 0);

// A typo in a policy flag must fail loudly. `has()` is an exact match, so
// before unknown-option rejection this exited 0 with the intendedUse gate
// silently disabled — and the three call sites in sign-release.yml pass these
// as literal strings.
expectFail(
  'check-asset: typo’d policy flag rejected (does not silently disable the gate)',
  run(['check-asset', '--manifest', manifestPath,
    '--name', 'breeze-agent-linux-amd64', '--file', assetPath, '--expect-signing-inputs']),
  /unknown option/
);

// ------------------------------------------------- committed key fixture ----

// Proves the verifier can load the key the template actually ships, not just a
// key this test generated in the format it happens to prefer.
const committedKey = join(here, '..', 'official-release-key.pub');
const committedSigned = writeSigned('committed', manifest, other.privateKey);
const committedResult = run(
  verifyArgs({
    manifest: committedSigned.manifestPath,
    signature: committedSigned.sigPath,
    key: committedKey,
  })
);
expect(
  'verify: committed official-release-key.pub parses (rejects on signature, not on key load)',
  committedResult.status !== 0 &&
    /signature verification FAILED/.test(committedResult.stderr) &&
    readFileSync(committedKey, 'utf8').includes('BEGIN PUBLIC KEY')
);

rmSync(dir, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('all verify-manifest tests passed');
