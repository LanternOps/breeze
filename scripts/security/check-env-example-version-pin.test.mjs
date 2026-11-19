// Self-test for scripts/security/check-env-example-version-pin.sh. The script
// promises: GHCR unreachable -> WARN + exit 0 (a registry outage must not turn
// a build red); published -> OK; GHCR reachable but tag missing -> exit 1.
// Uses a stub `curl` on PATH so no network is needed, plus one real-curl case
// that points HTTPS_PROXY at a closed port.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/security/check-env-example-version-pin.sh');
const tmp = mkdtempSync(join(tmpdir(), 'env-pin-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// STUB_MODE: unreachable (token fetch fails) | published | missing (portal 404s)
writeFileSync(
  join(tmp, 'curl'),
  `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/token?"* ]]; then
  [[ "$STUB_MODE" == unreachable ]] && exit 6
  printf '{"token":"stub"}'
  exit 0
fi
if [[ "$STUB_MODE" == missing && "$args" == *"/portal/manifests/"* ]]; then
  printf '404'; exit 22
fi
printf '200'
`,
);
chmodSync(join(tmp, 'curl'), 0o755);

const run = (mode) =>
  spawnSync('bash', [SCRIPT, '9.9.9'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, STUB_MODE: mode },
  });

test('GHCR unreachable: exit 0 with a WARN naming the registry', () => {
  const r = run('unreachable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN: .*ghcr\.io/);
});

test('published for every repo: exit 0 and OK', () => {
  const r = run('published');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK: BREEZE_VERSION=9\.9\.9 is published/);
});

test('reachable but tag missing: exit 1 naming the repo', () => {
  const r = run('missing');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing: portal/);
});

test('real curl via dead proxy: exit 0 with WARN (not a bare exit 1)', () => {
  const r = spawnSync('bash', [SCRIPT, '9.9.9'], {
    encoding: 'utf8',
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN/);
});
