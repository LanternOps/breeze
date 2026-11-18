import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// End-to-end test of ci.yml security-audit's decision tree (W1, #10744):
// .github/scripts/security-audit-compare.sh runs the REAL
// check-npm-audit.sh on the head and (when the head fails) on the base, then
// .github/scripts/new-findings.mjs. Each case is a real git repo in tmp with a
// base commit and a head commit, and a fake osv-scanner whose advisory
// database is keyed by name@version — so "an advisory published against a
// package already on base" is modelled exactly: both lockfiles list it.

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const COPY = [
  '.github/scripts/security-audit-compare.sh',
  '.github/scripts/new-findings.mjs',
  'scripts/security/check-npm-audit.sh',
];

const tmp = mkdtempSync(join(tmpdir(), 'security-audit-compare-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Fake osv-scanner: one report entry per `name@version:` lockfile key, with
// the advisories $VULN_DB lists for it. Exits 1 on any finding, like the real
// one; SCANNER_EXIT forces a status (a tooling failure).
const BIN = join(tmp, 'bin');
mkdirSync(BIN);
writeFileSync(
  join(BIN, 'fake-osv.mjs'),
  `import { readFileSync } from 'node:fs';
const lock = process.argv.find((a) => a.startsWith('--lockfile=')).slice('--lockfile='.length);
const db = JSON.parse(readFileSync(process.env.VULN_DB, 'utf8'));
let n = 0;
const packages = [...readFileSync(lock, 'utf8').matchAll(/^  ([^ ].*)@([^@:]+):$/gm)].map(([, name, version]) => {
  const ids = db[name + '@' + version] ?? [];
  n += ids.length;
  return { package: { name, version, ecosystem: 'npm' }, vulnerabilities: ids.map((id) => ({ id, database_specific: { severity: 'HIGH' } })) };
});
console.log(JSON.stringify({ results: [{ source: { path: lock }, packages }] }));
process.exit(n ? 1 : 0);
`,
);
writeFileSync(
  join(BIN, 'osv-scanner'),
  `#!/usr/bin/env bash\nif [ -n "\${SCANNER_EXIT:-}" ]; then echo '{"results":[]}'; exit "$SCANNER_EXIT"; fi\nexec '${process.execPath}' '${join(BIN, 'fake-osv.mjs')}' "$@"\n`,
);
chmodSync(join(BIN, 'osv-scanner'), 0o755);

// A `git` whose `diff` always fails, everything else delegated.
const BROKEN_DIFF = join(tmp, 'broken-diff-bin');
mkdirSync(BROKEN_DIFF);
writeFileSync(join(BROKEN_DIFF, 'git'), `#!/usr/bin/env bash\nif [ "$1" = diff ]; then echo 'fatal: simulated' >&2; exit 128; fi\nexec '${REAL_GIT}' "$@"\n`);
chmodSync(join(BROKEN_DIFF, 'git'), 0o755);

const lock = (pkgs) =>
  `lockfileVersion: '9.0'\n\npackages:\n\n${pkgs.map((p) => `  ${p}:\n    resolution: {integrity: sha512-x}\n`).join('\n')}`;
const NONE = { exceptions: [] };
const expired = (reason = 'x. Tracking: #1') => ({ exceptions: [{ id: 'GHSA-old', package: 'gone', reason, expires: day(-1) }] });

let caseNo = 0;
function run({ base, head, vulns = {}, baseSha = 'base', scannerExit, brokenDiff = false }) {
  const root = join(tmp, `case-${caseNo++}`);
  for (const f of COPY) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    copyFileSync(join(REPO, f), join(root, f));
  }
  const git = (...args) => {
    const r = spawnSync(REAL_GIT, args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = ({ pkgs, exceptions }) => {
    writeFileSync(join(root, 'pnpm-lock.yaml'), lock(pkgs));
    writeFileSync(join(root, 'scripts/security/npm-audit-exceptions.json'), `${JSON.stringify(exceptions, null, 2)}\n`);
  };
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  write(base);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  write(head);
  git('add', '-A');
  git('commit', '-qm', 'head', '--allow-empty');

  writeFileSync(join(root, 'vulns.json'), JSON.stringify(vulns));
  mkdirSync(join(root, 'runner-temp'));
  const env = {
    ...process.env,
    PATH: [brokenDiff ? BROKEN_DIFF : null, BIN, process.env.PATH].filter(Boolean).join(delimiter),
    VULN_DB: join(root, 'vulns.json'),
    RUNNER_TEMP: join(root, 'runner-temp'),
    GITHUB_EVENT_NAME: 'pull_request',
    CI_BASE_SHA: baseSha === 'base' ? sha : baseSha,
  };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.AUDIT_THRESHOLD;
  delete env.SCANNER_EXIT;
  if (scannerExit !== undefined) env.SCANNER_EXIT = String(scannerExit);
  const r = spawnSync('bash', [join(root, '.github/scripts/security-audit-compare.sh')], { cwd: root, env, encoding: 'utf8' });
  r.all = `${r.stdout}\n${r.stderr}`;
  return r;
}
const out = (r) => `exit ${r.status}\n${r.all}`;
const BASE_SCAN = /Dependency audit at base/;

const ZOD = 'zod@3.25.76';
const onBoth = { pkgs: ['a@1.0.0', ZOD], exceptions: NONE };

test('head passes → pass, and the base is never scanned', () => {
  const r = run({ base: { pkgs: ['a@1.0.0'], exceptions: NONE }, head: { pkgs: ['a@1.0.0', 'b@1.0.0'], exceptions: NONE } });
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(r.all, BASE_SCAN, out(r));
});

test('an advisory already on base → pass, with a warning and a notice', () => {
  const r = run({ base: onBoth, head: { pkgs: ['a@1.0.0', ZOD, 'c@1.0.0'], exceptions: NONE }, vulns: { [ZOD]: ['GHSA-mrhx'] } });
  assert.equal(r.status, 0, out(r));
  assert.match(r.all, /::warning title=Advisory already on base::zod@3\.25\.76 GHSA-mrhx/, out(r));
  assert.match(r.all, /::notice title=Dependency audit::.*already on base/, out(r));
});

test('an advisory the head adds → blocks', () => {
  const r = run({
    base: { pkgs: ['a@1.0.0'], exceptions: NONE },
    head: { pkgs: ['a@1.0.0', 'evil@1.0.0'], exceptions: NONE },
    vulns: { 'evil@1.0.0': ['GHSA-new'] },
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::error title=New advisory::evil@1\.0\.0 GHSA-new/, out(r));
  assert.doesNotMatch(r.all, /::notice title=Dependency audit::.*already on base/, out(r));
});

test('the same advisory at a bumped version → blocks', () => {
  const r = run({
    base: onBoth,
    head: { pkgs: ['a@1.0.0', 'zod@3.25.77'], exceptions: NONE },
    vulns: { [ZOD]: ['GHSA-mrhx'], 'zod@3.25.77': ['GHSA-mrhx'] },
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::error title=New advisory::zod@3\.25\.77/, out(r));
});

test('head scan integrity failure → blocks, whatever the base says', () => {
  const r = run({ base: onBoth, head: onBoth, vulns: { [ZOD]: ['GHSA-mrhx'] }, scannerExit: 2 });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::error title=Dependency audit failed::/, out(r));
  assert.doesNotMatch(r.all, BASE_SCAN, out(r));
});

test('head fails and there is no base sha → blocks on everything', () => {
  const r = run({ base: onBoth, head: onBoth, vulns: { [ZOD]: ['GHSA-mrhx'] }, baseSha: '' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /No base commit/, out(r));
  assert.doesNotMatch(r.all, BASE_SCAN, out(r));
});

test('head fails and the base commit is not present → blocks on everything', () => {
  const r = run({ base: onBoth, head: onBoth, vulns: { [ZOD]: ['GHSA-mrhx'] }, baseSha: '0123456789abcdef0123456789abcdef01234567' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::warning title=Audit comparison disabled::Could not read/, out(r));
});

test('head fails and the base scan is unusable → blocks on everything', () => {
  // A base lockfile with no package entries fails the gate's integrity check.
  const r = run({ base: { pkgs: [], exceptions: NONE }, head: onBoth, vulns: { [ZOD]: ['GHSA-mrhx'] } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::warning title=Audit comparison disabled::The base scan failed/, out(r));
});

test('an expired exception in an untouched exceptions file → warning only', () => {
  const r = run({ base: { pkgs: ['a@1.0.0'], exceptions: expired() }, head: { pkgs: ['a@1.0.0', 'c@1.0.0'], exceptions: expired() } });
  assert.equal(r.status, 0, out(r));
  assert.match(r.all, /::warning title=Exception out of policy::EXPIRED exception GHSA-old on gone/, out(r));
});

test('an expired exception in an exceptions file the change edits → blocks', () => {
  const r = run({ base: { pkgs: ['a@1.0.0'], exceptions: expired() }, head: { pkgs: ['a@1.0.0'], exceptions: expired('y. Tracking: #2') } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /::error title=Exception out of policy::EXPIRED exception GHSA-old on gone/, out(r));
});

test('a failed diff of the exceptions file → treated as touched (blocks)', () => {
  // Same exceptions file on base and head: only the failed diff can make it
  // count as edited.
  const r = run({
    base: { pkgs: ['a@1.0.0'], exceptions: expired() },
    head: { pkgs: ['a@1.0.0', 'c@1.0.0'], exceptions: expired() },
    brokenDiff: true,
  });
  assert.equal(r.status, 1, out(r));
  assert.match(r.all, /Could not diff .*treating it as edited/, out(r));
  assert.match(r.all, /::error title=Exception out of policy::/, out(r));
});
