// Self-test for scripts/security/install-osv-scanner.sh (#11367).
//
// Each case runs a COPY of the real installer against a local HTTP server that
// stands in for GitHub: the release-download URL and the REST asset endpoint.
// The server can return HTTP errors, reset the connection, or serve the wrong
// bytes. The only edit to the copy is the pinned SHA-256, rewritten to the
// digest of a fake binary. The installer has no environment knob for the digest,
// so nothing at run time can widen what it accepts.
//
// The script runs through an async spawn. A spawnSync would block this
// process's event loop, and the in-process server could never answer.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REPO_ROOT, 'scripts', 'security', 'install-osv-scanner.sh');
const SOURCE = readFileSync(INSTALLER, 'utf8');

const FAKE = '#!/bin/sh\necho "osv-scanner version: 2.4.0 (test double)"\n';
const TAMPERED = '#!/bin/sh\necho "not the pinned binary"\n';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const tmp = mkdtempSync(join(tmpdir(), 'osv-install-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const PIN_LINE = /^OSV_SCANNER_SHA256=[0-9a-f]{64}$/m;

let seq = 0;
function sandbox() {
  const dir = join(tmp, `case-${++seq}`);
  const bin = join(dir, 'bin');
  const cache = join(dir, 'cache');
  mkdirSync(bin, { recursive: true });
  const matches = SOURCE.match(new RegExp(PIN_LINE.source, 'gm')) ?? [];
  assert.equal(matches.length, 1, 'installer must pin exactly one OSV_SCANNER_SHA256=<64 hex> line');
  const script = join(dir, 'install-osv-scanner.sh');
  writeFileSync(script, SOURCE.replace(PIN_LINE, `OSV_SCANNER_SHA256=${sha256(FAKE)}`));
  return { dir, bin, cache, script, installed: join(bin, 'osv-scanner'), cached: join(cache, 'osv-scanner') };
}

function seedCache(box, body) {
  mkdirSync(box.cache, { recursive: true });
  writeFileSync(box.cached, body);
  chmodSync(box.cached, 0o755);
}

// plan: { release: (n) => behaviour, api: (n) => behaviour }, n = 1-based
// request count for that source. A behaviour is 'ok', 'wrong', 'reset',
// 'redirect' (302 to /cdn/, which serves the good binary, as GitHub's CDN
// redirect does), or an HTTP status code.
async function startServer(plan) {
  const requests = [];
  const counts = { release: 0, api: 0 };
  const server = createServer((req, res) => {
    const source = req.url.startsWith('/release/') ? 'release'
      : req.url.startsWith('/api/') ? 'api'
        : req.url.startsWith('/cdn/') ? 'cdn' : null;
    requests.push({ source, url: req.url, accept: req.headers.accept });
    if (!source) {
      res.writeHead(404).end();
      return;
    }
    const behaviour = source === 'cdn' ? 'ok' : plan[source](++counts[source]);
    if (behaviour === 'redirect') {
      res.writeHead(302, { location: '/cdn/osv-scanner_linux_amd64' }).end();
      return;
    }
    if (behaviour === 'reset') {
      req.socket.destroy();
      return;
    }
    if (behaviour === 'ok' || behaviour === 'wrong') {
      const body = behaviour === 'ok' ? FAKE : TAMPERED;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(behaviour, { 'content-type': 'text/plain' }).end(`status ${behaviour}\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    requests,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const always = (b) => () => b;
const sequence = (...bs) => (n) => bs[Math.min(n, bs.length) - 1];

function run(box, server, extraEnv = {}) {
  const env = {
    ...process.env,
    OSV_SCANNER_RELEASE_URL: `${server.base}/release/osv-scanner_linux_amd64`,
    OSV_SCANNER_API_URL: `${server.base}/api/asset`,
    OSV_SCANNER_INSTALL_DIR: box.bin,
    OSV_SCANNER_CACHE_DIR: box.cache,
    OSV_SCANNER_BACKOFF_BASE: '0',
    ...extraEnv,
  };
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const child = spawn('bash', [box.script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr, output: stdout + stderr, ms: Date.now() - started }));
  });
}

async function withServer(plan, fn) {
  const server = await startServer(plan);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

const errorLines = (output) => output.split('\n').filter((l) => l.startsWith('::error'));

// A directory of executables placed first on PATH, standing in for sudo/curl.
function stubs(box, files) {
  const dir = join(box.dir, 'stubs');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { PATH: `${dir}:${process.env.PATH}` };
}

// Root can write a 0555 directory, so the not-writable branch is unreachable.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a verified cached copy is installed before any download is tried', async () => {
  const box = sandbox();
  seedCache(box, FAKE);
  await withServer({ release: always(504), api: always(504) }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.equal(server.requests.length, 0, `cache hit still hit the network: ${JSON.stringify(server.requests)}`);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
    assert.ok(statSync(box.installed).mode & 0o111, 'installed binary is not executable');
    assert.match(r.stdout, /osv-scanner version: 2\.4\.0 \(test double\)/);
  });
});

test('a release-download 504 falls over to the REST asset endpoint in the same round, then caches the binary', async () => {
  const box = sandbox();
  await withServer({ release: always(504), api: always('ok') }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(server.requests.map((q) => q.source), ['release', 'api']);
    assert.equal(server.requests[1].accept, 'application/octet-stream');
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
    assert.equal(readFileSync(box.cached, 'utf8'), FAKE, 'the verified download was not written to the cache dir');
    assert.match(r.output, /HTTP 504/);
  });
});

test('both sources failing with 5xx is retried in later rounds until one recovers', async () => {
  const box = sandbox();
  await withServer({ release: sequence(504, 502, 'ok'), api: always(503) }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(server.requests.map((q) => q.source), ['release', 'api', 'release', 'api', 'release']);
    assert.match(r.output, /round 1\/6 failed/);
    assert.match(r.output, /round 2\/6 failed/);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
  });
});

test('a connection reset (curl exit 52/56) is retried like a 5xx', async () => {
  const box = sandbox();
  await withServer({ release: sequence('reset', 'ok'), api: always('reset') }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(server.requests.map((q) => q.source), ['release', 'api', 'release']);
    assert.match(r.output, /curl exit (52|56)/);
  });
});

test('a full outage with no cache fails closed after 6 rounds, with one ::error:: line naming the outage', async () => {
  const box = sandbox();
  await withServer({ release: always(504), api: always(504) }, async (server) => {
    const r = await run(box, server);
    assert.notEqual(r.code, 0, r.output);
    assert.equal(server.requests.length, 12, 'expected 6 rounds x 2 sources');
    const errors = errorLines(r.output);
    assert.equal(errors.length, 1, r.output);
    assert.match(errors[0], /osv-scanner v2\.4\.0/);
    assert.match(errors[0], /6 download rounds/);
    assert.match(errors[0], /HTTP 504 from the release download/);
    assert.match(errors[0], /HTTP 504 from the REST asset endpoint/);
    assert.match(errors[0], /no cached copy/);
    assert.match(errors[0], /fails closed/);
    assert.match(errors[0], /Re-run it once GitHub release downloads recover/);
    assert.ok(!existsSync(box.installed), 'something was installed despite the outage');
    assert.ok(!existsSync(box.cached), 'something was cached despite the outage');
  });
});

test('a cached copy with the wrong digest is never installed; it is replaced by a verified download', async () => {
  const box = sandbox();
  seedCache(box, TAMPERED);
  await withServer({ release: always('ok'), api: always(500) }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.equal(server.requests.length, 1);
    assert.match(r.output, /cached osv-scanner does not match the pinned SHA-256/);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
    assert.equal(readFileSync(box.cached, 'utf8'), FAKE);
  });
});

test('a cached copy with the wrong digest plus an outage fails closed without installing it', async () => {
  const box = sandbox();
  seedCache(box, TAMPERED);
  await withServer({ release: always(504), api: always(504) }, async (server) => {
    const r = await run(box, server, { OSV_SCANNER_ATTEMPTS: '2' });
    assert.notEqual(r.code, 0, r.output);
    const errors = errorLines(r.output);
    assert.equal(errors.length, 1, r.output);
    assert.match(errors[0], /cached copy was rejected/);
    assert.ok(!existsSync(box.installed), 'the tampered cached binary was installed');
  });
});

test('a downloaded binary with the wrong digest is never installed or cached', async () => {
  const box = sandbox();
  await withServer({ release: always('wrong'), api: always('wrong') }, async (server) => {
    const r = await run(box, server, { OSV_SCANNER_ATTEMPTS: '2' });
    assert.notEqual(r.code, 0, r.output);
    assert.equal(server.requests.length, 4);
    const errors = errorLines(r.output);
    assert.equal(errors.length, 1, r.output);
    assert.match(errors[0], /SHA-256 mismatch/);
    // A mismatch is not an outage: re-running will not fix a wrong pin or a bad release.
    assert.match(errors[0], /Check the pin and the release before re-running/);
    assert.doesNotMatch(errors[0], /Re-run it once/);
    assert.ok(r.output.includes(sha256(TAMPERED)), 'the observed digest should be logged');
    assert.ok(!existsSync(box.installed));
    assert.ok(!existsSync(box.cached));
  });
});

test('a mismatched release download falls through to a good REST download in the same round', async () => {
  const box = sandbox();
  await withServer({ release: always('wrong'), api: always('ok') }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(server.requests.map((q) => q.source), ['release', 'api']);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
    assert.equal(readFileSync(box.cached, 'utf8'), FAKE, 'the cache must hold the verified REST bytes, not the mismatched release bytes');
  });
});

test('redirects are followed, as GitHub answers both sources with a 302 to its CDN', async () => {
  const box = sandbox();
  await withServer({ release: always('redirect'), api: always(504) }, async (server) => {
    const r = await run(box, server);
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(server.requests.map((q) => q.source), ['release', 'cdn']);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
  });
});

test('a cache dir that cannot be written only warns; the verified download is still installed', async () => {
  const box = sandbox();
  writeFileSync(join(box.dir, 'not-a-dir'), 'x');
  await withServer({ release: always('ok'), api: always(504) }, async (server) => {
    const r = await run(box, server, { OSV_SCANNER_CACHE_DIR: join(box.dir, 'not-a-dir', 'cache') });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /::warning::could not write the verified osv-scanner/);
    assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
  });
});

test('an HTTP status reported as curl exit 56 (HTTP/2) is named as the HTTP status', async () => {
  const box = sandbox();
  const env = stubs(box, { curl: '#!/bin/sh\nprintf 503\nexit 56\n' });
  await withServer({ release: always('ok'), api: always('ok') }, async (server) => {
    const r = await run(box, server, { ...env, OSV_SCANNER_ATTEMPTS: '1' });
    assert.notEqual(r.code, 0, r.output);
    const errors = errorLines(r.output);
    assert.equal(errors.length, 1, r.output);
    assert.match(errors[0], /HTTP 503 from the release download \(curl exit 56\)/);
    assert.match(errors[0], /HTTP 503 from the REST asset endpoint \(curl exit 56\)/);
  });
});

test('an install dir the runner cannot write is installed through sudo', { skip: asRoot && 'running as root' }, async () => {
  const box = sandbox();
  const log = join(box.dir, 'sudo.log');
  // Records the call, then makes the dir writable so the real install can run.
  const env = stubs(box, { sudo: `#!/bin/sh\necho "$*" >> '${log}'\nchmod u+w '${box.bin}'\nexec "$@"\n` });
  chmodSync(box.bin, 0o555);
  try {
    await withServer({ release: always('ok'), api: always(504) }, async (server) => {
      const r = await run(box, server, env);
      assert.equal(r.code, 0, r.output);
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(calls.length, 1, calls.join('\n'));
      assert.match(calls[0], new RegExp(`^install -m 0755 \\S+ ${box.installed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      assert.equal(readFileSync(box.installed, 'utf8'), FAKE);
    });
  } finally {
    chmodSync(box.bin, 0o755);
  }
});

test('a failed install never falls through to an osv-scanner already in the install dir', { skip: asRoot && 'running as root' }, async () => {
  const box = sandbox();
  writeFileSync(box.installed, '#!/bin/sh\necho "STALE osv-scanner"\n');
  chmodSync(box.installed, 0o755);
  const env = stubs(box, { sudo: '#!/bin/sh\nexit 1\n' });
  chmodSync(box.bin, 0o555);
  try {
    await withServer({ release: always('ok'), api: always(504) }, async (server) => {
      const r = await run(box, server, env);
      assert.notEqual(r.code, 0, r.output);
      assert.doesNotMatch(r.output, /STALE/, 'the stale binary ran as if it were the verified one');
      const errors = errorLines(r.output);
      assert.equal(errors.length, 1, r.output);
      assert.match(errors[0], /could not install the verified osv-scanner/);
    });
  } finally {
    chmodSync(box.bin, 0o755);
  }
});

test('the backoff doubles between rounds', async () => {
  const box = sandbox();
  await withServer({ release: always(504), api: always(504) }, async (server) => {
    const r = await run(box, server, { OSV_SCANNER_ATTEMPTS: '3', OSV_SCANNER_BACKOFF_BASE: '1' });
    assert.notEqual(r.code, 0, r.output);
    assert.match(r.output, /round 1\/3 failed .*retrying in 1s/);
    assert.match(r.output, /round 2\/3 failed .*retrying in 2s/);
    assert.doesNotMatch(r.output, /round 3\/3 failed .*retrying/, 'no sleep after the last round');
    // 1s + 2s. A fixed 1s delay would finish in about 2s.
    assert.ok(r.ms >= 3000, `finished in ${r.ms} ms; expected the 1s + 2s backoff`);
  });
});

test('a malformed retry setting is rejected before any download', async () => {
  const box = sandbox();
  await withServer({ release: always('ok'), api: always('ok') }, async (server) => {
    for (const [bad, message] of [
      [{ OSV_SCANNER_ATTEMPTS: '0' }, /OSV_SCANNER_ATTEMPTS must be a positive integer/],
      [{ OSV_SCANNER_ATTEMPTS: 'many' }, /OSV_SCANNER_ATTEMPTS must be a positive integer/],
      [{ OSV_SCANNER_BACKOFF_BASE: '-1' }, /OSV_SCANNER_BACKOFF_BASE must be a non-negative integer/],
    ]) {
      const r = await run(box, server, bad);
      assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.output}`);
      assert.match(r.output, message);
    }
    assert.equal(server.requests.length, 0);
    assert.ok(!existsSync(box.installed));
  });
});

// ---- Pins and cache wiring ---------------------------------------------------

const pinned = (name) => SOURCE.match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1];

test('the installer pins a version, a SHA-256 and the asset id, with the defaults the CI jobs rely on', () => {
  assert.match(pinned('OSV_SCANNER_VERSION') ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(pinned('OSV_SCANNER_SHA256') ?? '', /^[0-9a-f]{64}$/);
  assert.match(pinned('OSV_SCANNER_ASSET_ID') ?? '', /^\d+$/);
  assert.ok(SOURCE.includes('https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64'));
  assert.ok(SOURCE.includes('https://api.github.com/repos/google/osv-scanner/releases/assets/${OSV_SCANNER_ASSET_ID}'));
  assert.match(SOURCE, /^attempts="\$\{OSV_SCANNER_ATTEMPTS:-6\}"$/m);
  assert.match(SOURCE, /^backoff_base="\$\{OSV_SCANNER_BACKOFF_BASE:-4\}"$/m);
  assert.match(SOURCE, /^cache_dir="\$\{OSV_SCANNER_CACHE_DIR:-\$HOME\/\.cache\/osv-scanner\}"$/m);
});

const COMPOSITE = join(REPO_ROOT, '.github', 'actions', 'restore-osv-scanner', 'action.yml');
const SEED = join(REPO_ROOT, '.github', 'workflows', 'ci-cache-seed.yml');

test('the cache key carries the pinned version, and the path is the installer\'s cache dir', () => {
  const key = `osv-scanner-v${pinned('OSV_SCANNER_VERSION')}-\${{ runner.os }}`;
  for (const file of [COMPOSITE, SEED]) {
    const text = readFileSync(file, 'utf8');
    const keys = [...text.matchAll(/^\s+key: (osv-scanner-\S+.*)$/gm)].map((m) => m[1].trim());
    assert.ok(keys.length > 0, `${file} has no osv-scanner cache key`);
    for (const k of keys) assert.equal(k, key, file);
    const paths = [...text.matchAll(/^\s+path: (.+)$/gm)].map((m) => m[1].trim()).filter((p) => p.includes('osv-scanner'));
    assert.ok(paths.length > 0, `${file} has no osv-scanner cache path`);
    for (const p of paths) assert.equal(p, '~/.cache/osv-scanner', file);
  }
});

// A job killed by its timeout prints no ::error:: line, so every place that runs
// the installer must outlast its worst case: every request hitting --max-time,
// plus the full backoff.
test('the step and seed timeouts outlast the installer\'s worst case', () => {
  const maxTime = Number(SOURCE.match(/--max-time (\d+)/)?.[1]);
  const attempts = Number(SOURCE.match(/OSV_SCANNER_ATTEMPTS:-(\d+)/)?.[1]);
  const base = Number(SOURCE.match(/OSV_SCANNER_BACKOFF_BASE:-(\d+)/)?.[1]);
  assert.ok(maxTime > 0 && attempts > 0 && base >= 0);
  const worst = attempts * 2 * maxTime + base * (2 ** (attempts - 1) - 1);
  const installStepTimeout = (file) => {
    const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
    const step = text.match(/- name: Install osv-scanner\n((?: {8}.*\n)+)/)?.[1] ?? '';
    return Number(step.match(/timeout-minutes: (\d+)/)?.[1]);
  };
  for (const file of ['ci.yml', 'security.yml']) {
    assert.ok(installStepTimeout(file) * 60 > worst, `${file}: Install osv-scanner timeout must exceed ${worst}s`);
  }
  const seed = readFileSync(SEED, 'utf8');
  const job = seed.slice(seed.search(/^ {2}seed-osv-scanner:\s*$/m)).match(/^ {4}timeout-minutes: (\d+)$/m);
  assert.ok(job && Number(job[1]) * 60 > worst, `seed-osv-scanner timeout must exceed ${worst}s`);
});

// The restore has to come first: the installer only uses a cached copy that is
// already on disk when it starts.
for (const [file, job] of [['ci.yml', 'security-audit'], ['security.yml', 'npm-audit']]) {
  test(`${file} ${job} restores the cached binary before the installer runs`, () => {
    const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
    const start = text.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
    assert.ok(start >= 0, `${file} has no ${job} job`);
    const rest = text.slice(start + 1);
    const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
    const body = next >= 0 ? rest.slice(0, next) : rest;
    const restoreAt = body.indexOf('uses: ./.github/actions/restore-osv-scanner');
    const installAt = body.indexOf('run: bash scripts/security/install-osv-scanner.sh');
    assert.ok(restoreAt >= 0, `${file} ${job} does not restore the osv-scanner cache`);
    assert.ok(installAt > restoreAt, `${file} ${job} runs the installer before the restore`);
  });
}
