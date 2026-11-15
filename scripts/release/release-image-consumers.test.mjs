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

// #11870: the binaries image cannot carry release-artifact-manifest.json (the
// signed manifest names that image's own digest), so BINARY_SOURCE=local had no
// pair at the volume root. Setup already downloads and verifies the pair to pin
// the images; it now keeps the verified copy in <work-dir>/release-manifest and
// places it at the root of the binaries volume before the stack starts.
const PAIR = ['release-artifact-manifest.json', 'release-artifact-manifest.json.ed25519'];

// A fake `docker` whose `compose … run … binaries-init -c SCRIPT` executes
// SCRIPT against a directory standing in for the binaries volume (/target),
// with the run's stdin passed through, so a test sees what actually lands in
// the volume. It models a named binaries volume on a host where Docker cannot
// bind-mount an extra host path (SELinux labels, snap Docker, an unshared
// Docker Desktop folder, a remote DOCKER_HOST): a run with -v fails. failRun: 'all' fails every run, 'copy' every run that copies a file
// in from stdin, 'manifest' only the run that copies the manifest itself (told
// apart from the signature's by the ".ed25519" in its script). Scripts run under
// umask 077, so a file the script does not chmod is not world-readable.
function fakeDockerWithVolume(workDir, { failRun = '' } = {}) {
  const bin = join(workDir, 'fake-bin');
  mkdirSync(bin);
  const log = join(workDir, 'docker.log');
  const volume = join(workDir, 'fake-binaries-volume');
  mkdirSync(volume);
  executable(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
if [[ "$1" == inspect ]]; then echo healthy; exit 0; fi
if [[ "$1" == compose && " $* " == *" run "* ]]; then
  args=("$@")
  for arg in "\${args[@]}"; do
    if [[ "$arg" == -v || "$arg" == --volume || "$arg" == --volume=* ]]; then
      echo "fake docker: host bind mounts are not available on this host" >&2
      exit 125
    fi
  done
  script="\${args[\${#args[@]}-1]}"
  case "${failRun}" in
    all) exit 1 ;;
    copy) [[ "$script" == *"cat >"* ]] && exit 1 ;;
    manifest) [[ "$script" == *"cat >"* && "$script" != *ed25519* ]] && exit 1 ;;
  esac
  script="\${script//\\/target/${volume}}"
  umask 077
  sh -c "\${script}"
  exit $?
fi
exit 0
`);
  return { PATH: `${bin}:${process.env.PATH}`, log, volume };
}

function readPair(directory) {
  return PAIR.map((name) => (existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8') : null));
}

function stagePair(directory, label) {
  mkdirSync(directory, { recursive: true });
  for (const name of PAIR) writeFileSync(join(directory, name), `${label} ${name}\n`);
}

test('guided --upgrade places the verified manifest pair in the binaries volume before starting', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);

  const signed = readPair(fixture.directory);
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), signed, 'setup keeps the verified pair');
  assert.deepEqual(readPair(docker.volume), signed, 'the verified pair lands at the binaries volume root');
  for (const name of PAIR) {
    assert.equal(statSync(join(docker.volume, name)).mode & 0o777, 0o644, `${name} is readable by the API user`);
    assert.equal(statSync(join(workDir, 'release-manifest', name)).mode & 0o777, 0o644, `kept ${name} is world-readable`);
  }
  assert.equal(statSync(join(workDir, 'release-manifest')).mode & 0o777, 0o755, 'a remapped Docker daemon can read the kept directory');
  const calls = readFileSync(docker.log, 'utf8').split('\n');
  const run = calls.findIndex((line) => / run --rm --no-deps -T .* binaries-init /u.test(line));
  const up = calls.findIndex((line) => /^compose .* up -d$/u.test(line));
  assert.ok(run !== -1 && up > run, `expected the pair to be placed before up -d, got:\n${calls.join('\n')}`);
  assert.ok(calls.filter((line) => / run /u.test(line)).every((line) => !/ (-v|--volume)[ =]/u.test(line)), 'no host bind mount');
  assert.match(result.stdout, /Placed the verified release manifest pair/u);
  assert.doesNotMatch(result.stdout + result.stderr, /Removed|Replaced/u, 'an empty volume had no pair to remove');
});

test('guided --upgrade replaces the previous release pair in the volume', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'previous');
  stagePair(docker.volume, 'previous');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), readPair(fixture.directory));
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), readPair(fixture.directory));
  assert.deepEqual(
    readdirSync(workDir).filter((name) => name.startsWith('release-manifest.')),
    [],
    'no staging copy is left next to the kept pair',
  );
  assert.deepEqual(readdirSync(docker.volume).sort(), [...PAIR].sort(), 'no temp file is left in the volume');
  assert.match(result.stdout, /Replaced the release manifest pair this script placed for the previous release/u);
  assert.doesNotMatch(result.stderr, /did not stage/u);
});

test('guided --upgrade says so when it replaces a pair it did not stage', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'previous');
  stagePair(docker.volume, 'placed by hand');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), readPair(fixture.directory));
  assert.match(result.stderr, /Replaced a release manifest pair in the binaries volume that this script did not stage/u);
});

test('guided --upgrade never places a pair that failed verification', () => {
  const fixture = signedFixture();
  const manifestPath = join(fixture.directory, 'release-artifact-manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(digest('1'), digest('9')));
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'running');
  stagePair(docker.volume, 'running');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.notEqual(result.status, 0, 'a tampered inventory must fail the upgrade');
  const running = PAIR.map((name) => `running ${name}\n`);
  assert.deepEqual(readPair(docker.volume), running, 'the volume keeps the running release pair');
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), running);
  assert.ok(!existsSync(docker.log) || !/ run /u.test(readFileSync(docker.log, 'utf8')), 'nothing is copied into the volume');
});

test('guided --upgrade --no-up keeps the verified pair and prints how to place it', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '--no-up', '-y']);
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), readPair(fixture.directory));
  assert.match(result.stdout, /run --rm --no-deps -T .*binaries-init/u, 'prints the placement command');

  // The printed commands work where a host path cannot be mounted.
  const docker = fakeDockerWithVolume(workDir);
  const printed = result.stdout.split('\n').filter((line) => / run --rm --no-deps -T .*binaries-init/u.test(line));
  assert.equal(printed.length, 2, `one command per file:\n${printed.join('\n')}`);
  for (const line of printed) {
    const run = spawnSync('bash', ['-c', line.trim()], { cwd: workDir, encoding: 'utf8', env: { ...process.env, PATH: docker.PATH } });
    assert.equal(run.status, 0, `${line}\n${run.stdout}\n${run.stderr}`);
  }
  assert.deepEqual(readPair(docker.volume), readPair(fixture.directory), 'the printed commands place the pair');
});

// A server-only release carries a previous full release's binaries image, and
// its own manifest lists no binaries. The pair that describes what is in the
// volume is the carried release's, verified against the same key and bound to
// the binaries digest the server-only manifest pinned.
function serverOnlyFixture({ tamperBase = false, baseBinariesDigest, baseServerOnly = false, baseOmitsReleaseKind = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-consumer-server-only-'));
  scratch.push(root);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const images = REQUIRED_RELEASE_IMAGES.map((name, index) => ({
    digest: digest(String((index + 1) % 10)),
    name,
    repository: `ghcr.io/lanternops/breeze/${name}`,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const write = (release, body) => {
    const directory = join(root, release);
    mkdirSync(directory);
    const manifest = `${JSON.stringify(body, null, 2)}\n`;
    writeFileSync(join(directory, PAIR[0]), manifest);
    writeFileSync(join(directory, PAIR[1]), `${sign(null, Buffer.from(manifest), privateKey).toString('base64')}\n`);
    return directory;
  };
  const baseImages = baseBinariesDigest
    ? images.map((image) => (image.name === 'binaries' ? { ...image, digest: baseBinariesDigest } : image))
    : images;
  const baseDirectory = write('v1.2.3', baseServerOnly
    ? {
      assets: [], binariesRelease: 'v1.2.2', binariesSourceCommit: 'a'.repeat(40),
      images: baseImages, release: 'v1.2.3', releaseKind: 'server-only', repository: 'LanternOps/breeze',
      schemaVersion: 1, sourceCommit: 'b'.repeat(40),
    }
    : {
      assets: [{ name: 'breeze-agent.msi', sha256: 'b'.repeat(64), size: 1 }],
      images: baseImages, release: 'v1.2.3', ...(baseOmitsReleaseKind ? {} : { releaseKind: 'full' }),
      repository: 'LanternOps/breeze', schemaVersion: 1, sourceCommit: 'b'.repeat(40),
    });
  const serverImages = images.map((image) => (image.name === 'binaries' ? image : { ...image, digest: digest('8') }));
  const directory = write('v1.2.4', {
    assets: [], binariesRelease: 'v1.2.3', binariesSourceCommit: 'b'.repeat(40),
    images: serverImages, release: 'v1.2.4', releaseKind: 'server-only', repository: 'LanternOps/breeze',
    schemaVersion: 1, sourceCommit: 'c'.repeat(40),
  });
  if (tamperBase) {
    const path = join(baseDirectory, PAIR[0]);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"v1.2.3"', '"v1.2.9"'));
  }
  return {
    directory,
    baseDirectory,
    images: serverImages,
    key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
  };
}

test('guided --upgrade to a server-only release places the carried binaries release pair', () => {
  const fixture = serverOnlyFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `upgrade failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(envValue(workDir, 'BREEZE_VERSION'), '1.2.4');
  assert.deepEqual(readPair(docker.volume), readPair(fixture.baseDirectory), 'the carried release pair describes the volume');
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), readPair(fixture.baseDirectory));
});

test('guided --upgrade to a server-only release places nothing when the carried pair fails verification', () => {
  const fixture = serverOnlyFixture({ tamperBase: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'stale');
  stagePair(docker.volume, 'stale');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `the server images still verified:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /release manifest pair/iu);
  assert.deepEqual(readPair(docker.volume), [null, null], 'a stale pair is removed rather than left to mismatch the new release');
  assert.equal(existsSync(join(workDir, 'release-manifest')), false);
  assert.match(result.stdout, /Removed the release manifest pair this script placed for the previous release from the binaries volume/u);
  assert.doesNotMatch(result.stderr, /did not stage/u);
});

test('guided --upgrade says so when it removes a pair it did not stage', () => {
  const fixture = serverOnlyFixture({ tamperBase: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'stale');
  stagePair(docker.volume, 'placed by hand');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), [null, null]);
  assert.match(result.stderr, /Removed a release manifest pair from the binaries volume that this script did not stage/u);
});

test('guided --upgrade to a server-only release refuses a carried pair that is not a full release', () => {
  // Validly signed, right tag, same binaries digest, but itself server-only: it
  // lists no binaries, so local registration would refuse every one of them.
  const fixture = serverOnlyFixture({ baseServerOnly: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(join(workDir, 'release-manifest'), 'stale');
  stagePair(docker.volume, 'stale');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `the server images still verified:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /releaseKind 'server-only', not 'full'/u);
  assert.deepEqual(readPair(docker.volume), [null, null], 'no pair from a non-full release is placed');
  assert.equal(existsSync(join(workDir, 'release-manifest')), false);
});

test('guided --upgrade to a server-only release does not reuse a kept carried pair that is not a full release', () => {
  const fixture = serverOnlyFixture({ baseServerOnly: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  mkdirSync(join(workDir, 'release-manifest'));
  for (const name of PAIR) writeFileSync(join(workDir, 'release-manifest', name), readFileSync(join(fixture.baseDirectory, name)));

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /keeping it/u);
  assert.deepEqual(readPair(docker.volume), [null, null]);
  assert.equal(existsSync(join(workDir, 'release-manifest')), false);
});

test('guided setup places the manifest pair before the first docker compose up', () => {
  const text = readFileSync(join(repoRoot, 'scripts/guided-setup.sh'), 'utf8');
  const body = text.slice(text.indexOf('start_stack() {'));
  const place = body.indexOf('place_release_manifest_pair_in_binaries_volume');
  const up = body.indexOf('if ! compose up -d; then');
  assert.ok(place !== -1 && up !== -1 && place < up, 'start_stack places the pair before compose up -d');
});

function runFreshResolver(fixture, workDir) {
  const program = `
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    source "${join(repoRoot, 'scripts/guided-setup.sh')}"
    ENV_FILE="${join(workDir, '.env')}"
    RELEASE_MANIFEST_PAIR_DIR="${join(workDir, 'release-manifest')}"
    RELEASE_IMAGE_VERIFIER_FILE="${join(repoRoot, 'scripts/release/verify-release-images.sh')}"
    BREEZE_SETUP_RELEASE_DOWNLOAD_BASE="file://${fixture.directory}"
    SELECTED_BREEZE_VERSION=1.2.3
    configure_release_image_refs
  `;
  const openssl = process.platform === 'darwin' ? '/opt/homebrew/opt/openssl@3/bin/openssl' : 'openssl';
  return spawnSync('bash', ['-c', program], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, BREEZE_OPENSSL_BIN: openssl, BREEZE_SETUP_GITHUB_REPO: 'LanternOps/breeze' },
  });
}

function freshWorkDir(fixture) {
  const workDir = mkdtempSync(join(tmpdir(), 'guided-fresh-'));
  scratch.push(workDir);
  writeFileSync(join(workDir, '.env'), `BREEZE_VERSION=1.2.3\nRELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${fixture.key}\n`);
  return workDir;
}

test('guided resolver keeps the verified pair on a fresh install', () => {
  const fixture = signedFixture();
  const workDir = freshWorkDir(fixture);

  const result = runFreshResolver(fixture, workDir);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), readPair(fixture.directory));
});

test('guided resolver keeps no pair when the inventory fails verification', () => {
  const fixture = signedFixture();
  const manifestPath = join(fixture.directory, 'release-artifact-manifest.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(digest('1'), digest('9')));
  const workDir = freshWorkDir(fixture);

  const result = runFreshResolver(fixture, workDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verification failed/u);
  assert.equal(existsSync(join(workDir, 'release-manifest')), false, 'an unverified pair is never kept');
});

test('guided --upgrade to a server-only release refuses a carried pair that lists another binaries image', () => {
  // Validly signed, right release, but its binaries digest is not the one the
  // server-only manifest pinned: it does not describe the volume.
  const fixture = serverOnlyFixture({ baseBinariesDigest: digest('7') });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(docker.volume, 'stale');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /does not match the signed release manifest/u);
  assert.deepEqual(readPair(docker.volume), [null, null]);
  assert.equal(existsSync(join(workDir, 'release-manifest')), false);
});

test('guided --upgrade to a server-only release keeps an already-kept carried pair when the download fails', () => {
  const fixture = serverOnlyFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  mkdirSync(join(workDir, 'release-manifest'));
  for (const name of PAIR) writeFileSync(join(workDir, 'release-manifest', name), readFileSync(join(fixture.baseDirectory, name)));
  const carried = readPair(fixture.baseDirectory);
  for (const name of PAIR) rmSync(join(fixture.baseDirectory, name)); // the carried release cannot be downloaded

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), carried);
  assert.deepEqual(readPair(docker.volume), carried);
});

test('guided --upgrade keeps the running pair when the .env swap fails after verification', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  stagePair(join(workDir, 'release-manifest'), 'running');
  const program = `
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    source "${join(repoRoot, 'scripts/guided-setup.sh')}"
    YES_MODE=true
    ENV_FILE="${join(workDir, '.env')}"
    RELEASE_MANIFEST_PAIR_DIR="${join(workDir, 'release-manifest')}"
    RELEASE_IMAGE_VERIFIER_FILE="${join(workDir, 'scripts/release/verify-release-images.sh')}"
    BREEZE_SETUP_RELEASE_DOWNLOAD_BASE="file://${fixture.directory}"
    backup_file() { fail "injected backup failure"; }
    stage_upgraded_env 1.2.3
  `;
  const openssl = process.platform === 'darwin' ? '/opt/homebrew/opt/openssl@3/bin/openssl' : 'openssl';
  const result = spawnSync('bash', ['-c', program], {
    cwd: workDir,
    encoding: 'utf8',
    env: { ...process.env, BREEZE_OPENSSL_BIN: openssl, BREEZE_SETUP_GITHUB_REPO: 'LanternOps/breeze' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected backup failure/u, `the failure is the injected one:\n${result.stderr}`);
  assert.deepEqual(readPair(join(workDir, 'release-manifest')), PAIR.map((name) => `running ${name}\n`));
});

test('guided --upgrade --dry-run copies nothing into the volume', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y', '--dry-run'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[dry-run\] Would run: .* run --rm --no-deps -T /u);
  assert.doesNotMatch(result.stdout, /Placed the verified release manifest pair/u);
  assert.deepEqual(readdirSync(docker.volume), []);
  assert.ok(!existsSync(docker.log) || !/ run /u.test(readFileSync(docker.log, 'utf8')), 'docker compose run never executes');
});

test('guided --upgrade removes the older pair, prints the copy commands, and still starts when the copy fails', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir, { failRun: 'copy' });
  stagePair(join(workDir, 'release-manifest'), 'previous');
  stagePair(docker.volume, 'previous');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Could not copy the release manifest pair/u);
  assert.deepEqual(readPair(docker.volume), [null, null], 'new binaries never sit beside the previous release pair');
  assert.match(result.stdout, /Removed the release manifest pair this script placed for the previous release from the binaries volume/u);
  for (const name of PAIR) {
    assert.match(
      result.stderr,
      new RegExp(`run --rm --no-deps -T --entrypoint sh binaries-init -c '[^']+' < \\S+/release-manifest/${name.replaceAll('.', '\\.')}$`, 'mu'),
      `prints a stdin copy command for ${name}`,
    );
  }
  assert.doesNotMatch(result.stderr, /\/release-manifest:ro/u, 'the printed command needs no host mount');
  assert.match(readFileSync(docker.log, 'utf8'), /up -d/u, 'the stack still starts');
});

test('guided --upgrade removes a half-copied pair when the manifest copy fails', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir, { failRun: 'manifest' });

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Could not copy the release manifest pair/u);
  assert.deepEqual(readdirSync(docker.volume), [], 'neither the new signature nor a temp file is left');
  assert.match(result.stdout + result.stderr, /Removed a release manifest signature with no manifest beside it from the binaries volume/u);
});

test('guided --upgrade warns with the commands when neither the copy nor the removal runs', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir, { failRun: 'all' });

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Could not copy the release manifest pair/u);
  assert.match(result.stderr, /Could not remove the release manifest pair from the binaries volume either/u);
  assert.match(result.stderr, /binaries-init -c '[^']+' < \S+\/release-manifest\/release-artifact-manifest\.json$/mu);
  assert.match(readFileSync(docker.log, 'utf8'), /up -d/u, 'the stack still starts');
});

test('an unverified release drops a kept pair so it is never placed', () => {
  const fixture = signedFixture();
  const workDir = freshWorkDir(fixture);
  stagePair(join(workDir, 'release-manifest'), 'earlier');
  const program = `
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    source "${join(repoRoot, 'scripts/guided-setup.sh')}"
    ENV_FILE="${join(workDir, '.env')}"
    RELEASE_MANIFEST_PAIR_DIR="${join(workDir, 'release-manifest')}"
    ALLOW_UNVERIFIED_RELEASE=true
    SELECTED_BREEZE_VERSION=0.100.0
    configure_release_image_refs
    release_manifest_pair_place_command_for_display
  `;
  const result = spawnSync('bash', ['-c', program], { cwd: workDir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(workDir, 'release-manifest')), false);
  assert.match(result.stdout, /binaries-init -c 'set -eu; m=\/target\/release-artifact-manifest\.json;[^']* rm -f "\$m" "\$s"/u, 'the printed step removes a pair');
});

test('every "pair is missing" message points at a docs heading that exists', () => {
  const url = 'https://docs.breezermm.com/deploy/binaries/#release-manifest-pair';
  const stores = readFileSync(join(repoRoot, 'apps/api/src/services/binaryStores.ts'), 'utf8');
  assert.ok(stores.includes(`'${url}'`), 'RELEASE_MANIFEST_PAIR_DOCS_URL');
  assert.ok(readFileSync(join(repoRoot, 'scripts/guided-setup.sh'), 'utf8').includes(url), 'guided-setup.sh warning');
  const docs = readFileSync(join(repoRoot, 'apps/docs/src/content/docs/deploy/binaries.mdx'), 'utf8');
  assert.match(docs, /^## Release Manifest Pair$/mu, 'the heading Starlight slugs to #release-manifest-pair');
});

test('the manual docs run the same stdin copy and remove steps guided setup runs', () => {
  const program = `
    export BREEZE_GUIDED_SETUP_LIBRARY_ONLY=true
    source "${join(repoRoot, 'scripts/guided-setup.sh')}"
    release_manifest_pair_file_place_script release-artifact-manifest.json.ed25519; echo
    release_manifest_pair_file_place_script release-artifact-manifest.json; echo
    printf '%s\\n' "$RELEASE_MANIFEST_PAIR_REMOVE_SCRIPT"
  `;
  const result = spawnSync('bash', ['-c', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const scripts = result.stdout.trim().split('\n');
  assert.equal(scripts.length, 3);
  const docs = readFileSync(join(repoRoot, 'apps/docs/src/content/docs/deploy/binaries.mdx'), 'utf8');
  for (const script of scripts) {
    assert.ok(!script.includes("'"), `a single-quotable script: ${script}`);
    assert.ok(docs.includes(`-c '${script}'`), `binaries.mdx runs: ${script}`);
  }
  assert.doesNotMatch(docs, /\/release-manifest:ro/u, 'the documented copy needs no host bind mount');
});

test('guided --upgrade logs nothing extra when the volume already holds this release pair', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  mkdirSync(join(workDir, 'release-manifest'));
  for (const name of PAIR) {
    writeFileSync(join(workDir, 'release-manifest', name), readFileSync(join(fixture.directory, name)));
    writeFileSync(join(docker.volume, name), readFileSync(join(fixture.directory, name)));
  }

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), readPair(fixture.directory));
  assert.doesNotMatch(result.stdout + result.stderr, /Replaced|Removed|did not stage|could not tell/u);
});

test('guided --upgrade warns when it replaces a manifest it cannot read', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  stagePair(docker.volume, 'unreadable');
  chmodSync(join(docker.volume, PAIR[0]), 0o000);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), readPair(fixture.directory), 'the unreadable manifest is still replaced');
  assert.match(result.stderr, /Replaced a release manifest pair in the binaries volume that this script could not tell/u);
});

test('guided --upgrade fails the copy loudly when a directory sits where the manifest goes', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDockerWithVolume(workDir);
  mkdirSync(join(docker.volume, PAIR[0]));

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Placed the verified release manifest pair/u);
  assert.match(result.stderr, /Could not copy the release manifest pair/u);
  assert.match(result.stderr, /Could not remove the release manifest pair from the binaries volume either/u);
  assert.equal(existsSync(join(docker.volume, PAIR[0], `.${PAIR[0]}.tmp`)), false, 'nothing was moved into the directory');
});

test('the remove step also clears temp files an interrupted copy left in the volume', () => {
  const fixture = serverOnlyFixture({ tamperBase: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);
  for (const name of PAIR) writeFileSync(join(docker.volume, `.${name}.tmp`), 'partial\n');

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readdirSync(docker.volume), []);
});

test('guided --upgrade to a server-only release places a carried pair whose manifest has no releaseKind', () => {
  // Manifests written before releaseKind existed are full releases.
  const fixture = serverOnlyFixture({ baseOmitsReleaseKind: true });
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.3']);
  const docker = fakeDockerWithVolume(workDir);

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.4', '-y'], { PATH: docker.PATH });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readPair(docker.volume), readPair(fixture.baseDirectory));
});

test('the pull-failure message chains the stdin copy commands into one runnable line', () => {
  const fixture = signedFixture();
  const workDir = upgradeWorkDir(fixture, ['BREEZE_VERSION=1.2.2']);
  const docker = fakeDocker(workDir, { failPull: true });

  const result = runUpgrade(fixture, workDir, ['--upgrade', '1.2.3', '-y'], { PATH: docker.PATH });
  assert.notEqual(result.status, 0);
  const line = result.stderr.split('\n').find((l) => l.includes('Fix registry access, then run:'));
  assert.ok(line, result.stderr);
  assert.match(
    line,
    / pull && \S.* binaries-init -c '[^']+' < \S+\/release-artifact-manifest\.json\.ed25519 && \S.* binaries-init -c '[^']+' < \S+\/release-artifact-manifest\.json && \S.* up -d$/u,
  );
});
