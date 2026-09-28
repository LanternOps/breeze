import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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

// #7024: `guided-setup.sh --upgrade` is the upgrade path for digest-pinned
// installs. A bare `docker compose pull` re-fetches the SAME digests, and a
// hand-edited BREEZE_VERSION leaves the old digests running. --upgrade must
// resolve the new digests through the same fail-closed signed-inventory path
// as a fresh install and rewrite BREEZE_VERSION together with them.
const zeroRef = (name) => `ghcr.io/lanternops/breeze/${name}@sha256:${'0'.repeat(64)}`;

function upgradeWorkDir(fixture, envLines) {
  const workDir = mkdtempSync(join(tmpdir(), 'guided-upgrade-'));
  scratch.push(workDir);
  writeFileSync(join(workDir, 'docker-compose.yml'), 'services: {}\n');
  mkdirSync(join(workDir, 'scripts/release'), { recursive: true });
  writeFileSync(
    join(workDir, 'scripts/release/verify-release-images.sh'),
    readFileSync(join(repoRoot, 'scripts/release/verify-release-images.sh')),
  );
  writeFileSync(join(workDir, '.env'), [
    `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${fixture.key}`,
    `BREEZE_API_IMAGE_REF=${zeroRef('api')}`,
    `BREEZE_WEB_IMAGE_REF=${zeroRef('web')}`,
    `BREEZE_PORTAL_IMAGE_REF=${zeroRef('portal')}`,
    `BREEZE_BINARIES_IMAGE_REF=${zeroRef('binaries')}`,
    'POSTGRES_PASSWORD=keep-me',
    QUOTED_SECRET_LINE,
    ...envLines,
    '',
  ].join('\n'), { mode: 0o600 });
  return workDir;
}

// A quoted value with every character the dotenv writer escapes; the upgrade
// rewrites five keys and must carry this line through byte-for-byte.
const QUOTED_SECRET_LINE = `SMTP_PASSWORD='p@ss "word" #1 $HOME \\n'`;

function runUpgrade(fixture, workDir, args, extraEnv = {}) {
  const openssl = process.platform === 'darwin' ? '/opt/homebrew/opt/openssl@3/bin/openssl' : 'openssl';
  return spawnSync('bash', [join(repoRoot, 'scripts/guided-setup.sh'), '--work-dir', workDir, ...args], {
    cwd: workDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BREEZE_OPENSSL_BIN: openssl,
      BREEZE_SETUP_RELEASE_DOWNLOAD_BASE: `file://${fixture.directory}`,
      BREEZE_SETUP_GITHUB_REPO: 'LanternOps/breeze',
      ...extraEnv,
    },
  });
}

// A fake `docker` on PATH: logs every call, reports breeze-api healthy, and on
// `compose … pull` records the BREEZE_VERSION .env holds at that moment.
function fakeDocker(workDir, { failPull = false } = {}) {
  const bin = join(workDir, 'fake-bin');
  mkdirSync(bin);
  const log = join(workDir, 'docker.log');
  executable(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == inspect ]]; then echo healthy; exit 0; fi
if [[ "$1" == compose && " $* " == *" pull "* ]]; then
  grep '^BREEZE_VERSION=' "${join(workDir, '.env')}" >> "${log}"
  ${failPull ? 'exit 1' : 'exit 0'}
fi
exit 0
`);
  return { PATH: `${bin}:${process.env.PATH}`, log };
}

function envValue(workDir, key) {
  const line = readFileSync(join(workDir, '.env'), 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

const strayEnvFiles = (workDir) => readdirSync(workDir).filter((name) => name.startsWith('.env.') && !name.startsWith('.env.bak.'));

test('guided --upgrade rewrites BREEZE_VERSION and all four digests together from the signed inventory', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const before = readFileSync(join(workDir, '.env'), 'utf8');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--no-up', '-y']);
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);

  assert.equal(envValue(workDir, 'BREEZE_VERSION'), '1.2.3');
  for (const name of ['api', 'web', 'portal', 'binaries']) {
    const image = fixture.images.find((candidate) => candidate.name === name);
    assert.equal(envValue(workDir, `BREEZE_${name.toUpperCase()}_IMAGE_REF`), `${image.repository}@${image.digest}`);
  }
  assert.equal(envValue(workDir, 'POSTGRES_PASSWORD'), 'keep-me', 'unrelated settings survive the rewrite');
  assert.ok(
    readFileSync(join(workDir, '.env'), 'utf8').split('\n').includes(QUOTED_SECRET_LINE),
    'a quoted secret with special characters survives byte-for-byte',
  );

  const backups = readdirSync(workDir).filter((name) => name.startsWith('.env.bak.'));
  assert.equal(backups.length, 1, 'the previous .env is backed up before it is replaced');
  assert.equal(readFileSync(join(workDir, backups[0]), 'utf8'), before);
  assert.equal(statSync(join(workDir, '.env')).mode & 0o777, 0o600);
  assert.deepEqual(strayEnvFiles(workDir), [], 'no staged or temp copy is left behind');
  assert.match(result.stdout, /v1\.2\.3\/docker-compose\.yml/u, 'points the operator at the target compose template');
});

test('guided --upgrade re-pins digests when BREEZE_VERSION was already bumped by hand', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--no-up', '-y']);
  assert.equal(result.status, 0, `re-pin failed:\n${result.stdout}\n${result.stderr}`);
  const api = fixture.images.find((candidate) => candidate.name === 'api');
  assert.equal(envValue(workDir, 'BREEZE_API_IMAGE_REF'), `${api.repository}@${api.digest}`);
});

test('guided --upgrade leaves .env untouched when the signed inventory fails verification', () => {
  const fixture = signedFixture();
  const manifestPath = join(fixture.directory, 'release-artifact-manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(digest('1'), digest('9')));
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const before = readFileSync(join(workDir, '.env'), 'utf8');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--no-up', '-y']);
  assert.notEqual(result.status, 0, 'a tampered inventory must fail the upgrade');
  assert.match(result.stderr, /verification failed/u);
  assert.equal(readFileSync(join(workDir, '.env'), 'utf8'), before, 'BREEZE_VERSION and digests must not move');
  assert.deepEqual(readdirSync(workDir).filter((name) => name.startsWith('.env.')), [], 'no backup or staged copy is left behind');
});

test('guided --upgrade with no version resolves the latest GitHub release', () => {
  const fixture = signedFixture();
  const api = join(fixture.directory, 'github-api');
  mkdirSync(join(api, 'repos/LanternOps/breeze/releases'), { recursive: true });
  writeFileSync(join(api, 'repos/LanternOps/breeze/releases/latest'), '{\n  "tag_name": "v1.2.3",\n  "name": "v1.2.3"\n}\n');
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '-y', '--no-up'], { BREEZE_SETUP_GITHUB_API: `file://${api}` });
  assert.equal(result.status, 0, `latest lookup failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(envValue(workDir, 'BREEZE_VERSION'), '1.2.3');
  assert.match(result.stdout, /Target release:\s+1\.2\.3/u);
});

test('guided --upgrade pulls and restarts only after .env pins the verified release', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDocker(workDir);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);
  const calls = readFileSync(docker.log, 'utf8').split('\n');
  const pull = calls.findIndex((line) => /^compose .* pull$/u.test(line));
  const up = calls.findIndex((line) => /^compose .* up -d$/u.test(line));
  assert.ok(pull !== -1 && up > pull, `expected compose pull then up -d, got:\n${calls.join('\n')}`);
  assert.equal(calls[pull + 1], 'BREEZE_VERSION=1.2.3', 'images are pulled after .env was rewritten');
  assert.match(calls[pull], new RegExp(`--env-file ${join(workDir, '.env').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} pull$`, 'u'));
  assert.ok(calls.some((line) => line.startsWith('inspect ')), 'waits for API health');
  assert.match(result.stdout, /Breeze upgraded to 1\.2\.3/u);
});

test('guided --upgrade fails loudly when the pull fails, naming the pinned release', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDocker(workDir, { failPull: true });

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docker compose pull failed; .* now pins 1\.2\.3/u);
  assert.doesNotMatch(readFileSync(docker.log, 'utf8'), /up -d/u, 'never starts after a failed pull');
});

test('guided --upgrade refuses a downgrade unless --allow-downgrade is passed', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.3.0']);
  const before = readFileSync(join(workDir, '.env'), 'utf8');

  const refused = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--no-up', '-y']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /downgrade/u);
  assert.equal(readFileSync(join(workDir, '.env'), 'utf8'), before);

  const forced = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--allow-downgrade', '--no-up', '-y']);
  assert.equal(forced.status, 0, `forced downgrade failed:\n${forced.stdout}\n${forced.stderr}`);
  assert.equal(envValue(workDir, 'BREEZE_VERSION'), '1.2.3');
});
