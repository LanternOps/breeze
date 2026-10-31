import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exceptionProblems, findingKey, findingsTable, newFindings, normalize } from './new-findings.mjs';

// Dependency-audit gate for CI Success (W1, #10744). `security-audit` scans the
// base and the head lockfile with check-npm-audit.sh --findings-json and blocks
// only on blocking findings the head adds, so an advisory published overnight
// against a package already on main no longer ejects every queued PR.

const SCRIPT = fileURLToPath(new URL('./new-findings.mjs', import.meta.url));
const FIXTURES = new URL('./fixtures/new-findings/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

// Captured from the real gate (osv-scanner 2.6.0 against this repo's
// pnpm-lock.yaml, AUDIT_THRESHOLD=LOW so the sub-HIGH advisories block too):
// two blocking findings, two suppressed by reviewed exceptions.
const OSV = fixture('osv-findings.json');

const f = (pkg, version, id, ecosystem = 'npm') => ({ id, pkg, version, ecosystem });

// A minimal --findings-json document around the given gate findings.
const doc = (findings, problems = []) => ({
  schema: 1,
  tool: 'osv-scanner',
  lockfile: 'pnpm-lock.yaml',
  exceptionsFile: 'scripts/security/npm-audit-exceptions.json',
  threshold: 'HIGH',
  today: '2026-10-30',
  scannedPackages: 3,
  lockfilePackages: 3,
  findings: findings.map((x) => ({
    package: x.pkg,
    version: x.version,
    ecosystem: x.ecosystem,
    id: x.id,
    severity: x.severity ?? 'HIGH',
    excepted: x.excepted ?? false,
    blocking: x.blocking ?? true,
  })),
  exceptionProblems: problems,
});

// ── normalize ────────────────────────────────────────────────────────────

test("normalize('osv'): the captured gate output yields exactly its blocking findings", () => {
  assert.deepEqual(normalize('osv', OSV), [
    f('deepmerge', '4.3.1', 'GHSA-gcqx-w48m-w2h4'),
    f('qs', '6.16.0', 'GHSA-6pq8-jhm2-2vcw'),
  ]);
});

test("normalize('osv'): excepted and below-threshold findings are not blocking, so never compared", () => {
  const keys = normalize('osv', OSV).map((x) => x.pkg);
  // Both are in the captured report, marked excepted by a reviewed entry.
  assert.ok(OSV.findings.some((x) => x.package === 'zod' && x.excepted));
  assert.ok(!keys.includes('zod') && !keys.includes('node-forge'));
});

test("normalize('osv'): a finding listed twice is reported once", () => {
  const one = f('lodash', '4.17.20', 'GHSA-aaaa-bbbb-cccc');
  assert.deepEqual(normalize('osv', doc([one, one])), [one]);
});

test('normalize: anything but a well-formed findings document throws (fail closed)', () => {
  const bad = [
    null,
    [],
    {},
    { ...OSV, schema: 2 },
    { ...OSV, findings: undefined },
    { ...OSV, findings: {} },
    { ...OSV, exceptionProblems: undefined },
    { ...OSV, findings: [{ ...OSV.findings[0], blocking: 'yes' }] },
    { ...OSV, findings: [{ ...OSV.findings[0], id: '' }] },
    { ...OSV, findings: [{ ...OSV.findings[0], version: 4 }] },
    { ...OSV, findings: [{ ...OSV.findings[0], package: undefined }] },
  ];
  for (const json of bad) assert.throws(() => normalize('osv', json), undefined, JSON.stringify(json)?.slice(0, 80));
  assert.throws(() => normalize('trivy', OSV), /tool/);
});

// ── newFindings ──────────────────────────────────────────────────────────

const A = f('zod', '3.25.76', 'GHSA-mrhx-c7xc-m3w5');
const B = f('qs', '6.16.0', 'GHSA-6pq8-jhm2-2vcw');

test('newFindings: identical base and head → nothing new', () => {
  assert.deepEqual(newFindings([A, B], [A, B]), []);
  assert.deepEqual(newFindings([], []), []);
});

test('newFindings: an advisory the head adds is new', () => {
  assert.deepEqual(newFindings([A], [A, B]), [B]);
});

test('newFindings: the same id on the same package at a different version is new', () => {
  const bumped = { ...A, version: '3.25.77' };
  assert.deepEqual(newFindings([A], [bumped]), [bumped]);
});

test('newFindings: the same id on another package, or another ecosystem, is new', () => {
  const otherPkg = { ...A, pkg: 'zod-mini' };
  const otherEco = { ...A, ecosystem: 'Go' };
  assert.deepEqual(newFindings([A], [otherPkg, otherEco]), [otherPkg, otherEco]);
});

test('newFindings: an advisory removed in head is not reported', () => {
  assert.deepEqual(newFindings([A, B], [A]), []);
  assert.deepEqual(newFindings([A, B], []), []);
});

test('findingKey is ecosystem|pkg|version|id', () => {
  assert.equal(findingKey(A), 'npm|zod|3.25.76|GHSA-mrhx-c7xc-m3w5');
});

// ── exceptionProblems / findingsTable ────────────────────────────────────

const EXPIRED = { id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge', expires: '2026-10-29', status: 'EXPIRED' };

test('exceptionProblems: returns the expired / out-of-policy entries of a document', () => {
  assert.deepEqual(exceptionProblems(doc([], [EXPIRED])), [EXPIRED]);
  assert.deepEqual(exceptionProblems(OSV), []);
  assert.throws(() => exceptionProblems(doc([], [{ ...EXPIRED, status: 'ACTIVE' }])));
});

test('findingsTable: lists blocking findings and exception problems as markdown', () => {
  const table = findingsTable(doc([{ ...B, severity: 'CRITICAL' }, { ...A, blocking: false, excepted: true }], [EXPIRED]));
  assert.match(table, /\| qs \| 6\.16\.0 \| GHSA-6pq8-jhm2-2vcw \| CRITICAL \|/);
  assert.doesNotMatch(table, /zod/);
  assert.match(table, /EXPIRED.*GHSA-86w9-cpqp-85rv.*node-forge/);
});

// ── CLI ──────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'new-findings-'));
let n = 0;
const file = (json) => {
  const p = join(tmp, `doc-${n++}.json`);
  writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json));
  return p;
};
const cli = (...args) => {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
};
const out = (r) => `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

test('CLI: a finding on both base and head is a warning and exits 0', () => {
  const r = cli('--base', file(doc([A])), '--head', file(doc([A])));
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /::warning title=Advisory already on base::.*zod@3\.25\.76 GHSA-mrhx-c7xc-m3w5/, out(r));
  assert.match(r.stdout, /0 new/, out(r));
});

test('CLI: a finding only on head is an error and exits 1', () => {
  const r = cli('--base', file(doc([A])), '--head', file(doc([A, B])));
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /::error title=New advisory::.*qs@6\.16\.0 GHSA-6pq8-jhm2-2vcw/, out(r));
  assert.match(r.stdout, /1 new/, out(r));
});

test('CLI: an expired exception warns unless the change touched the exceptions file', () => {
  const base = file(doc([], [EXPIRED]));
  const head = file(doc([], [EXPIRED]));
  const untouched = cli('--base', base, '--head', head);
  assert.equal(untouched.status, 0, out(untouched));
  assert.match(untouched.stdout, /::warning title=Exception out of policy::.*GHSA-86w9-cpqp-85rv on node-forge/, out(untouched));

  const touched = cli('--base', base, '--head', head, '--exceptions-touched');
  assert.equal(touched.status, 1, out(touched));
  assert.match(touched.stdout, /::error title=Exception out of policy::.*GHSA-86w9-cpqp-85rv on node-forge/, out(touched));
});

test('CLI: an unreadable or malformed document exits 2 (never a pass)', () => {
  const good = file(doc([A]));
  for (const args of [
    ['--base', good, '--head', join(tmp, 'missing.json')],
    ['--base', file('{ not json'), '--head', good],
    ['--base', good, '--head', file({ schema: 1 })],
    ['--base', good],
    ['--head', good, '--base'],
    ['--base', good, '--head', good, '--bogus'],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(' ')}\n${out(r)}`);
  }
});

test('CLI: --table prints the finding table of one document', () => {
  const r = cli('--table', file(doc([B])));
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /\| qs \| 6\.16\.0 \| GHSA-6pq8-jhm2-2vcw \|/, out(r));
});

test('CLI: writes a step summary when GITHUB_STEP_SUMMARY is set', () => {
  const summary = join(tmp, 'summary.md');
  writeFileSync(summary, '');
  const r = spawnSync(process.execPath, [SCRIPT, '--base', file(doc([A])), '--head', file(doc([A, B]))], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(r.status, 1, out(r));
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /New on this change/);
  assert.match(md, /qs/);
  assert.match(md, /Already on base/);
  assert.match(md, /zod/);
});

test('findingsTable: a backslash before a pipe cannot unescape the pipe', () => {
  const table = findingsTable({ schema: 1, findings: [{ id: 'GHSA-x', package: 'a\\|b', version: '1.0.0', ecosystem: 'npm', severity: 'HIGH', excepted: false, blocking: true }], exceptionProblems: [] });
  assert.match(table, /\| a\\\\\\\|b \| 1\.0\.0 \|/);
});
