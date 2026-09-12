import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'attest-macos-pkg.sh');
const TEMPLATE_SCRIPT = join(
  REPO_ROOT,
  'selfhost-signing-template',
  'scripts',
  'attest-macos-pkg.sh',
);
const scratch = mkdtempSync(join(tmpdir(), 'macos-pkg-attestation-test-'));
const pkg = join(scratch, 'fixture.pkg');
const pkgutil = join(scratch, 'pkgutil');
const identity = 'Developer ID Installer: Example Publisher (ABCDE12345)';

writeFileSync(pkg, 'synthetic package fixture\n');
after(() => rmSync(scratch, { recursive: true, force: true }));

function setPkgutil({ output, status = 0 }) {
  writeFileSync(pkgutil, `#!/usr/bin/env bash\nprintf '%s\\n' \"$PKGUTIL_OUTPUT\"\nexit \"$PKGUTIL_STATUS\"\n`);
  chmodSync(pkgutil, 0o755);
  return { PKGUTIL_OUTPUT: output, PKGUTIL_STATUS: String(status) };
}

function run(
  expectedIdentity = identity,
  expectedTeamId = 'ABCDE12345',
  fixture = {},
  script = SCRIPT,
) {
  const env = {
    ...process.env,
    PKGUTIL_BIN: pkgutil,
    ...setPkgutil({
      output: `Package "fixture.pkg":\n   Status: signed by a certificate trusted by macOS\n   Certificate Chain:\n    1. ${identity}\n       SHA256 Fingerprint: 00\n    2. Developer ID Certification Authority`,
      ...fixture,
    }),
  };
  return spawnSync('bash', [script, pkg, 'breeze-agent-darwin-arm64.pkg', expectedIdentity, expectedTeamId], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
}

test('emits publisher-bound manifest attestation for the exact leaf identity and team', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `breeze-agent-darwin-arm64.pkg\tmacos-developer-id-notarization-required\t${identity}\tABCDE12345\n`,
  );
});

test('self-host signing template carries the same publisher verifier', () => {
  assert.equal(readFileSync(TEMPLATE_SCRIPT, 'utf8'), readFileSync(SCRIPT, 'utf8'));
  const result = run(identity, 'ABCDE12345', {}, TEMPLATE_SCRIPT);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `breeze-agent-darwin-arm64.pkg\tmacos-developer-id-notarization-required\t${identity}\tABCDE12345\n`,
  );
});

test('official and self-host workflows bind package publisher metadata into manifests', () => {
  const official = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const selfhost = readFileSync(
    join(REPO_ROOT, 'selfhost-signing-template', '.github', 'workflows', 'sign-release.yml'),
    'utf8',
  );

  for (const workflow of [official, selfhost]) {
    assert.match(workflow, /attest-macos-pkg\.sh/);
    assert.match(workflow, /signingIdentity/);
    assert.match(workflow, /signingTeamId/);
    assert.match(workflow, /APPLE_INSTALLER_IDENTITY/);
    assert.match(workflow, /APPLE_TEAM_ID/);
  }
  assert.match(selfhost, /"edition": "self-host"/);
});

test('rejects a valid package signed by a different installer identity', () => {
  const result = run('Developer ID Installer: Different Publisher (ABCDE12345)');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected package signing identity/);
});

test('rejects an expected identity whose suffix is not the configured team', () => {
  const result = run(identity, 'ZYXWV98765');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not bound to expected team ID/);
});

test('rejects a package signed with a non-installer certificate', () => {
  const applicationIdentity = 'Developer ID Application: Example Publisher (ABCDE12345)';
  const result = run(applicationIdentity, 'ABCDE12345', {
    output: `Package "fixture.pkg":\n    1. ${applicationIdentity}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not bound to expected team ID/);
});

test('rejects pkgutil verification failure', () => {
  const result = run(identity, 'ABCDE12345', { output: 'Status: no signature', status: 1 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pkgutil rejected package signature/);
});

test('rejects malformed output without a leaf certificate', () => {
  const result = run(identity, 'ABCDE12345', { output: 'Status: signed' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain a leaf signing identity/);
});
