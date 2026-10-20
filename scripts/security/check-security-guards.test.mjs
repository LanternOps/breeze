// Self-test for two Security Scanning guards that must fail CLOSED (#8283):
//   - scripts/security/check-go-version-pins.sh  (a deleted pin must not pass)
//   - scripts/security/run-govulncheck.sh        (an empty scan must not pass)
//
// Each case builds a throwaway repo layout (both scripts resolve everything
// relative to their own location), runs a COPY of the real script, and mutates
// the scratch copy. The real files are never touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'security-guards-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const scratch = () => {
  const dir = join(tmp, `case-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const copyIn = (root, rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
};

// ---------------------------------------------------------------- pin check
const PIN_SCRIPT = 'scripts/security/check-go-version-pins.sh';
const PIN_FILES = [
  PIN_SCRIPT,
  'agent/go.mod',
  '.github/workflows',
  'apps/docs/src/content/docs/agents/building.mdx',
  'apps/docs/src/content/docs/getting-started/prerequisites.mdx',
  // #6263 W03a: the API images build breeze-yarac from agent/ sources.
  'apps/api/Dockerfile',
  'docker/Dockerfile.api',
  // #6263 W03b: the built-in YARA pack filter is its own Go module.
  'scripts/security/yara-pack/go.mod',
];

function pinLayout() {
  const root = scratch();
  for (const rel of PIN_FILES) copyIn(root, rel);
  return root;
}
const runPins = (root) =>
  spawnSync('bash', [join(root, PIN_SCRIPT)], { encoding: 'utf8' });

// Remove every line matching `re` from a scratch workflow file.
function stripLines(root, workflow, re) {
  const p = join(root, '.github/workflows', workflow);
  const before = readFileSync(p, 'utf8');
  const stripped = before.split('\n').filter((l) => !re.test(l)).join('\n');
  assert.notEqual(stripped, before, `fixture precondition: ${workflow} had no line matching ${re}`);
  writeFileSync(p, stripped);
}

test('pin check passes on an unmodified copy of the repo', () => {
  const r = runPins(pinLayout());
  assert.equal(r.status, 0, r.stderr);
});

for (const wf of ['ci.yml', 'security.yml', 'release.yml', 'dev-build-agent.yml', 'yara-pack.yml']) {
  test(`pin check fails when ${wf} loses its GO_VERSION declaration`, () => {
    const root = pinLayout();
    stripLines(root, wf, /^\s*GO_VERSION:/);
    const r = runPins(root);
    assert.notEqual(r.status, 0, 'deleted GO_VERSION must not pass');
    assert.match(r.stderr, new RegExp(`${wf.replace('.', '\\.')} declares no GO_VERSION`));
  });
}

// Rewrite a scratch copy of a repo file (not only workflows).
function rewriteFile(root, rel, re, replacement) {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const changed = before.replace(re, replacement);
  assert.notEqual(changed, before, `fixture precondition: ${rel} had no text matching ${re}`);
  writeFileSync(p, changed);
}

test('pin check fails when a Dockerfile golang stage drifts from agent/go.mod', () => {
  const root = pinLayout();
  rewriteFile(root, 'apps/api/Dockerfile', /golang:\d+\.\d+\.\d+-alpine@/, 'golang:1.25.12-alpine@');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /apps\/api\/Dockerfile golang:1\.25\.12 !=/);
});

test('pin check fails when a Dockerfile golang stage loses its digest pin', () => {
  const root = pinLayout();
  rewriteFile(root, 'docker/Dockerfile.api', /(golang:\d+\.\d+\.\d+-alpine)@sha256:[0-9a-f]{64}/, '$1');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /docker\/Dockerfile\.api golang stage is not a digest-pinned/);
});

test('pin check fails when a Dockerfile loses its golang stage entirely', () => {
  const root = pinLayout();
  rewriteFile(root, 'apps/api/Dockerfile', /^FROM .*golang:.*$/m, 'FROM scratch AS yarac');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /apps\/api\/Dockerfile has no golang build stage/);
});

test('pin check fails when the YARA pack go.mod drifts from agent/go.mod', () => {
  const root = pinLayout();
  rewriteFile(root, 'scripts/security/yara-pack/go.mod', /^go \d+\.\d+\.\d+$/m, 'go 1.25.12');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /scripts\/security\/yara-pack\/go\.mod go 1\.25\.12 !=/);
});

test('pin check fails when the YARA pack go.mod loses its go directive', () => {
  const root = pinLayout();
  rewriteFile(root, 'scripts/security/yara-pack/go.mod', /^go \d+\.\d+\.\d+$/m, '');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /scripts\/security\/yara-pack\/go\.mod has no fully-qualified/);
});

test('pin check fails when codeql.yml loses its literal go-version', () => {
  const root = pinLayout();
  stripLines(root, 'codeql.yml', /^\s*go-version:/);
  const r = runPins(root);
  assert.notEqual(r.status, 0, 'deleted codeql go-version must not pass');
  assert.match(r.stderr, /codeql\.yml declares no literal go-version/);
});

// Replace a matching line's text in a scratch workflow file.
function rewrite(root, workflow, re, replacement) {
  const p = join(root, '.github/workflows', workflow);
  const before = readFileSync(p, 'utf8');
  const changed = before.replace(re, replacement);
  assert.notEqual(changed, before, `fixture precondition: ${workflow} had no text matching ${re}`);
  writeFileSync(p, changed);
}

test('pin check fails when a GO_VERSION drifts from agent/go.mod', () => {
  const root = pinLayout();
  rewrite(root, 'release.yml', /^(\s*GO_VERSION:\s*)'[^']+'/m, "$1'1.25.12'");
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /release\.yml GO_VERSION=1\.25\.12 !=/);
});

test('pin check fails when codeql.yml literal go-version drifts', () => {
  const root = pinLayout();
  rewrite(root, 'codeql.yml', /^(\s*go-version:\s*)'[^']+'/m, "$1'1.25.12'");
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /codeql\.yml hard-codes go-version: 1\.25\.12/);
});

test('pin check fails when codeql.yml go-version is only a template', () => {
  const root = pinLayout();
  rewrite(root, 'codeql.yml', /^(\s*go-version:\s*)'[^']+'/m, '$1${{ env.GO_VERSION }}');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /codeql\.yml declares no literal go-version/);
});

test('pin check fails when a go-version template does not read env.GO_VERSION', () => {
  const root = pinLayout();
  rewrite(root, 'ci.yml', /go-version: \$\{\{ env\.GO_VERSION \}\}/, 'go-version: ${{ env.GOVERSION }}');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ci\.yml go-version templates something other than/);
});

test('pin check fails on a two-part go directive in agent/go.mod', () => {
  const root = pinLayout();
  writeFileSync(join(root, 'agent/go.mod'), 'module x\n\ngo 1.26\n');
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fully-qualified/);
});

test('pin check fails when a required workflow file is missing', () => {
  const root = pinLayout();
  rmSync(join(root, '.github/workflows/release.yml'));
  const r = runPins(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /release\.yml/);
});

// ------------------------------------------------------------- govulncheck
const VULN_SCRIPT = 'scripts/security/run-govulncheck.sh';

// Layout with a fake `govulncheck` on PATH that prints `output` and exits `code`.
function vulnLayout(output, code = 0) {
  const root = scratch();
  copyIn(root, VULN_SCRIPT);
  writeFileSync(join(root, 'scripts/security/govulncheck-allowlist.txt'), '# empty\n');
  mkdirSync(join(root, 'agent'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const payload = join(root, 'payload.json');
  writeFileSync(payload, output);
  writeFileSync(join(bin, 'govulncheck'), `#!/usr/bin/env bash\ncat "${payload}"\nexit ${code}\n`);
  chmodSync(join(bin, 'govulncheck'), 0o755);
  return { root, bin };
}
const runVuln = ({ root, bin }) =>
  spawnSync('bash', [join(root, VULN_SCRIPT)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });

const CONFIG = JSON.stringify({ config: { protocol_version: 'v1.0.0', scanner_name: 'govulncheck' } });
const FINDING = JSON.stringify({
  finding: { osv: 'GO-2099-0001', trace: [{ package: 'x', function: 'F' }, { package: 'agent', function: 'G' }] },
});

test('govulncheck wrapper fails on exit-0 empty output', () => {
  const r = runVuln(vulnLayout(''));
  assert.notEqual(r.status, 0, 'empty output must not read as a clean scan');
  assert.match(r.stderr, /produced no output/);
  assert.doesNotMatch(r.stdout, /no unallowlisted/);
});

test('govulncheck wrapper fails on output with no config record', () => {
  const r = runVuln(vulnLayout('{"progress":{"message":"hi"}}\n'));
  assert.notEqual(r.status, 0, 'output without a config record must not pass');
  assert.match(r.stderr, /no config record/);
  assert.doesNotMatch(r.stdout, /no unallowlisted/);
});

test('govulncheck wrapper fails on output that is not JSON', () => {
  const r = runVuln(vulnLayout('govulncheck: not json\n'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no config record/);
  assert.doesNotMatch(r.stdout, /no unallowlisted/);
});

test('govulncheck wrapper passes a real-shaped clean scan', () => {
  const r = runVuln(vulnLayout(`${CONFIG}\n`));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no unallowlisted/);
});

test('govulncheck wrapper still fails an unallowlisted symbol-level finding', () => {
  const r = runVuln(vulnLayout(`${CONFIG}\n${FINDING}\n`));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GO-2099-0001/);
});

test('govulncheck wrapper honors the allowlist and warns on stale entries', () => {
  const l = vulnLayout(`${CONFIG}\n${FINDING}\n`);
  writeFileSync(
    join(l.root, 'scripts/security/govulncheck-allowlist.txt'),
    'GO-2099-0001\nGO-2099-9999\n',
  );
  const r = runVuln(l);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ALLOWLISTED GO-2099-0001/);
  assert.match(r.stdout, /WARN stale allowlist entry GO-2099-9999/);
});

test('govulncheck wrapper ignores a finding with no symbol-level trace', () => {
  const pkgOnly = JSON.stringify({ finding: { osv: 'GO-2099-0002', trace: [{ package: 'x' }] } });
  const r = runVuln(vulnLayout(`${CONFIG}\n${pkgOnly}\n`));
  assert.equal(r.status, 0, r.stderr);
});

test('govulncheck wrapper propagates a non-zero govulncheck exit', () => {
  const r = runVuln(vulnLayout(`${CONFIG}\n`, 3));
  assert.notEqual(r.status, 0);
});

test('fixture precondition: scripts exist in the real repo', () => {
  assert.ok(existsSync(join(REPO_ROOT, PIN_SCRIPT)));
  assert.ok(existsSync(join(REPO_ROOT, VULN_SCRIPT)));
});
