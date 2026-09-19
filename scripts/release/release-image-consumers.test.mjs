import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { afterEach } from 'node:test';

import { REQUIRED_RELEASE_IMAGES } from './release-image-manifest.mjs';

const repoRoot = resolve('.');
const scratch = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const digest = (digit) => `sha256:${digit.repeat(64)}`;

function signedFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'release-consumer-fixture-'));
  scratch.push(directory);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const images = REQUIRED_RELEASE_IMAGES.map((name, index) => ({
    digest: digest(String((index + 1) % 10)),
    name,
    repository: `ghcr.io/lanternops/breeze/${name}`,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const manifest = `${JSON.stringify({
    assets: [], images, release: 'v1.2.3', repository: 'LanternOps/breeze',
    schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  }, null, 2)}\n`;
  writeFileSync(join(directory, 'release-artifact-manifest.json'), manifest);
  writeFileSync(
    join(directory, 'release-artifact-manifest.json.ed25519'),
    `${sign(null, Buffer.from(manifest), privateKey).toString('base64')}\n`,
  );
  return {
    directory,
    images,
    key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
}

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function productionEnv(path, fixture, apiDigest = digest('9')) {
  const values = {
    BREEZE_DOMAIN: 'synthetic.invalid',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
    BREEZE_VERSION: '1.2.3',
    BREEZE_API_IMAGE_DIGEST: apiDigest,
    BREEZE_WEB_IMAGE_DIGEST: fixture.images.find((image) => image.name === 'web').digest,
    BREEZE_PORTAL_IMAGE_DIGEST: fixture.images.find((image) => image.name === 'portal').digest,
    BREEZE_BINARIES_IMAGE_DIGEST: fixture.images.find((image) => image.name === 'binaries').digest,
    CADDY_IMAGE_REF: `caddy@${digest('1')}`,
    CLOUDFLARED_IMAGE_REF: `cloudflared@${digest('2')}`,
    REDIS_IMAGE_REF: `redis@${digest('3')}`,
    COTURN_IMAGE_REF: `coturn@${digest('4')}`,
    BILLING_IMAGE_REF: `billing@${digest('5')}`,
    REDIS_PASSWORD: 'synthetic', JWT_SECRET: 'synthetic', AGENT_ENROLLMENT_SECRET: 'synthetic',
    APP_ENCRYPTION_KEY: 'synthetic', MFA_ENCRYPTION_KEY: 'synthetic', ENROLLMENT_KEY_PEPPER: 'synthetic',
    MFA_RECOVERY_CODE_PEPPER: 'synthetic', RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: fixture.key,
    PUBLIC_API_URL: 'https://synthetic.invalid/api/v1', REMOTE_ACCESS_ADMISSION_MODE: 'closed',
    REMOTE_WS_AUTH_MODE: 'post_upgrade', REMOTE_WS_REDIS_TOPOLOGY: 'standalone-single-primary',
    REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT: '2026-01-01T00:00:00Z',
    REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT: '2026-01-01T00:00:00Z',
  };
  writeFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

test('strict deploy rejects a substituted signed digest before Compose config, pull, migration, or start', () => {
  const fixture = signedFixture();
  const bin = join(fixture.directory, 'bin');
  const envFile = join(fixture.directory, 'deploy.env');
  const dockerLog = join(fixture.directory, 'docker.log');
  const pnpmLog = join(fixture.directory, 'pnpm.log');
  mkdirSync(bin);
  executable(join(bin, 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dockerLog}"\n[[ "$*" == "compose version" ]]\n`);
  executable(join(bin, 'curl'), `#!/usr/bin/env bash\nout=""\nurl=""\nwhile [[ $# -gt 0 ]]; do case "$1" in --output) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done\ncp "${fixture.directory}/\${url##*/}" "$out"\n`);
  executable(join(bin, 'pnpm'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${pnpmLog}"\nexit 97\n`);
  productionEnv(envFile, fixture);

  const result = spawnSync('bash', [join(repoRoot, 'scripts/prod/deploy.sh'), envFile], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ENABLE_MONITORING: 'false', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0, 'digest substitution must fail');
  assert.match(result.stderr, /does not match the signed release manifest/u);
  assert.equal(readFileSync(dockerLog, 'utf8').trim(), 'compose version');
  assert.equal(existsSync(pnpmLog), false, 'migration command must not run');
});

test('guided resolver rejects a tampered inventory before changing image refs', () => {
  const fixture = signedFixture();
  const envFile = join(fixture.directory, '.env');
  writeFileSync(envFile, [
    'BREEZE_VERSION=1.2.3',
    `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${fixture.key}`,
    'BREEZE_API_IMAGE_REF=sentinel',
    'BREEZE_WEB_IMAGE_REF=sentinel',
    'BREEZE_PORTAL_IMAGE_REF=sentinel',
    'BREEZE_BINARIES_IMAGE_REF=sentinel',
    '',
  ].join('\n'));
  const manifestPath = join(fixture.directory, 'release-artifact-manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(digest('1'), digest('9')));

  const program = `
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    source "${join(repoRoot, 'scripts/guided-setup.sh')}"
    ENV_FILE="${envFile}"
    RELEASE_IMAGE_VERIFIER_FILE="${join(repoRoot, 'scripts/release/verify-release-images.sh')}"
    BREEZE_SETUP_RELEASE_DOWNLOAD_BASE="file://${fixture.directory}"
    configure_signed_release_image_refs
  `;
  const openssl = process.platform === 'darwin' ? '/opt/homebrew/opt/openssl@3/bin/openssl' : 'openssl';
  const result = spawnSync('bash', ['-c', program], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: { ...process.env, BREEZE_OPENSSL_BIN: openssl },
  });
  assert.notEqual(result.status, 0, 'tampered guided manifest must fail');
  assert.match(result.stderr, /verification failed/u);
  assert.match(readFileSync(envFile, 'utf8'), /BREEZE_API_IMAGE_REF=sentinel/u);
});

test('guided setup resolves signed images before any start-stack path', () => {
  const text = readFileSync(join(repoRoot, 'scripts/guided-setup.sh'), 'utf8');
  const configure = text.indexOf('  configure_signed_release_image_refs\n');
  const start = text.indexOf('  if start_stack; then');
  assert.ok(configure !== -1 && start !== -1 && configure < start);
});
