// Self-test for scripts/security/check-npm-audit.sh and its reviewed
// exceptions file (scripts/security/npm-audit-exceptions.json).
//
// Each case builds a throwaway repo layout (the gate resolves the lockfile and
// the exceptions file relative to its own location), puts a fake osv-scanner
// first on PATH that prints a fixture report, and runs a COPY of the real gate
// script. That way the suppression and expiry rules are exercised end to end
// through the same bash + jq the CI job runs, not a re-implementation of them.
//
// Dates are computed from the real UTC clock because the gate reads the real
// clock; there is deliberately no "pretend today is X" knob in the gate, since
// any such knob would also be a way to bypass expiry.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'security', 'check-npm-audit.sh');

const tmp = mkdtempSync(join(tmpdir(), 'npm-audit-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A UTC calendar day relative to today, as YYYY-MM-DD.
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const FORGE_ID = 'GHSA-86w9-cpqp-85rv';

const finding = (name, id, severity = 'HIGH', version = '1.4.0') => ({
  package: { name, version, ecosystem: 'npm' },
  vulnerabilities: [{ id, database_specific: { severity } }],
});

const report = (...packages) => ({
  results: [{ source: { path: 'pnpm-lock.yaml', type: 'lockfile' }, packages }],
});

const CLEAN = report();

const entry = (overrides = {}) => ({
  id: FORGE_ID,
  package: 'node-forge',
  reason: 'dev tooling only, no fixed release. Tracking: #1234',
  expires: day(10),
  ...overrides,
});

let caseNo = 0;

// Runs a copy of the gate against `osvReport`. `exceptions` is an object
// (serialised), a raw string (written verbatim), or undefined (no file).
function runGate({ osvReport, exceptions }) {
  const root = join(tmp, `case-${caseNo++}`);
  const sec = join(root, 'scripts', 'security');
  const bin = join(root, 'bin');
  mkdirSync(sec, { recursive: true });
  mkdirSync(bin, { recursive: true });

  copyFileSync(GATE, join(sec, 'check-npm-audit.sh'));
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  if (exceptions !== undefined) {
    writeFileSync(
      join(sec, 'npm-audit-exceptions.json'),
      typeof exceptions === 'string' ? exceptions : JSON.stringify(exceptions, null, 2),
    );
  }

  const reportPath = join(root, 'osv-report.json');
  writeFileSync(reportPath, JSON.stringify(osvReport));
  // Like the real scanner: print the JSON report, exit non-zero on any finding.
  const fake = join(bin, 'osv-scanner');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\ncat '${reportPath}'\n[ "$(jq '[.results[]?.packages[]?.vulnerabilities[]?] | length' '${reportPath}')" -eq 0 ]\n`,
  );
  chmodSync(fake, 0o755);

  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  delete env.AUDIT_THRESHOLD;
  return spawnSync('bash', [join(sec, 'check-npm-audit.sh')], { cwd: root, env, encoding: 'utf8' });
}

const out = (res) => `exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;

// --- core suppression and expiry behaviours ----------------------------------

test('an exact id + package match is suppressed and the gate passes', () => {
  const res = runGate({
    osvReport: report(finding('node-forge', FORGE_ID)),
    exceptions: { exceptions: [entry()] },
  });
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, new RegExp(`node-forge@1\\.4\\.0 ${FORGE_ID} \\(excepted\\)`), out(res));
});

test('the same advisory id on a different package is NOT suppressed', () => {
  const res = runGate({
    osvReport: report(finding('not-forge', FORGE_ID)),
    exceptions: { exceptions: [entry()] },
  });
  assert.equal(res.status, 1, out(res));
  assert.match(res.stderr, /found 1 advisory/, out(res));
});

test('an expired entry hard-fails even when the advisory no longer appears', () => {
  const res = runGate({
    osvReport: CLEAN,
    exceptions: { exceptions: [entry({ expires: day(-1) })] },
  });
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout + res.stderr, new RegExp(`EXPIRED ${FORGE_ID} on node-forge`), out(res));
});

test('an expired or out-of-policy entry suppresses nothing', () => {
  // The run fails on the bad entry either way; this pins that the advisory is
  // ALSO still counted as blocking, so the log never presents it as excepted.
  for (const expires of [day(-1), day(31)]) {
    const res = runGate({
      osvReport: report(finding('node-forge', FORGE_ID)),
      exceptions: { exceptions: [entry({ expires })] },
    });
    assert.equal(res.status, 1, out(res));
    assert.doesNotMatch(res.stdout, /\(excepted\)/, out(res));
    assert.match(res.stderr, /found 1 unexcepted advisory/, out(res));
  }
});

test('every active exception is printed on every run, matched or not', () => {
  const second = entry({ id: 'GHSA-aaaa-bbbb-cccc', package: '@scope/other', reason: 'other. Tracking: #99' });
  for (const osvReport of [report(finding('node-forge', FORGE_ID)), CLEAN]) {
    const res = runGate({ osvReport, exceptions: { exceptions: [entry(), second] } });
    assert.equal(res.status, 0, out(res));
    assert.ok(
      res.stdout.includes(`ACTIVE ${FORGE_ID} on node-forge, expires ${day(10)}: dev tooling only, no fixed release. Tracking: #1234`),
      out(res),
    );
    assert.ok(res.stdout.includes('ACTIVE GHSA-aaaa-bbbb-cccc on @scope/other'), out(res));
  }
});

test('an unknown HIGH still fails while another advisory is excepted', () => {
  // Same package, different id: the exception covers one advisory, not the package.
  const samePkg = runGate({
    osvReport: report(finding('node-forge', FORGE_ID), finding('node-forge', 'GHSA-zzzz-yyyy-xxxx')),
    exceptions: { exceptions: [entry()] },
  });
  assert.equal(samePkg.status, 1, out(samePkg));
  assert.match(samePkg.stderr, /found 1 advisory/, out(samePkg));

  // Unrelated package entirely.
  const other = runGate({
    osvReport: report(finding('node-forge', FORGE_ID), finding('lodash', 'GHSA-1111-2222-3333', 'CRITICAL')),
    exceptions: { exceptions: [entry()] },
  });
  assert.equal(other.status, 1, out(other));
  assert.match(other.stderr, /found 1 advisory/, out(other));
});

test('matching is exact: superstrings, prefixes and aliases never match', () => {
  // Each finding is a near miss of the entry (node-forge / FORGE_ID): a
  // superstring, a truncation, or a case change, in both directions. A
  // startswith/contains/regex/case-folding regression in the gate's matcher
  // lets at least one of them through and turns this red.
  const nearMisses = [
    finding('node-forge-extra', FORGE_ID), // entry package is a prefix of it
    finding('@scope/node-forge', FORGE_ID), // entry package is a suffix of it
    finding('node', FORGE_ID), // it is a prefix of the entry package
    finding('node-forge', `${FORGE_ID}-x`), // entry id is a prefix of it
    finding('node-forge', 'GHSA-86w9'), // it is a prefix of the entry id
    finding('node-forge', 'GHSA-86W9-CPQP-85RV'), // differs only in case
  ];
  for (const f of nearMisses) {
    const res = runGate({ osvReport: report(f), exceptions: { exceptions: [entry()] } });
    assert.equal(res.status, 1, `${f.package.name} ${f.vulnerabilities[0].id} must not be excepted\n${out(res)}`);
  }

  // The entry id appears only as an alias of a different primary id.
  const aliased = finding('node-forge', 'CVE-2026-85393');
  aliased.vulnerabilities[0].aliases = [FORGE_ID];
  const res = runGate({ osvReport: report(aliased), exceptions: { exceptions: [entry()] } });
  assert.equal(res.status, 1, `alias must not be excepted\n${out(res)}`);
});

// --- boundaries and fail-closed parsing --------------------------------------

test('an entry is honoured through its expires date (inclusive)', () => {
  const res = runGate({
    osvReport: report(finding('node-forge', FORGE_ID)),
    exceptions: { exceptions: [entry({ expires: day(0) })] },
  });
  assert.equal(res.status, 0, out(res));
});

test('an expiry more than 30 days out is refused', () => {
  const ok = runGate({
    osvReport: report(finding('node-forge', FORGE_ID)),
    exceptions: { exceptions: [entry({ expires: day(30) })] },
  });
  assert.equal(ok.status, 0, out(ok));

  const tooFar = runGate({
    osvReport: report(finding('node-forge', FORGE_ID)),
    exceptions: { exceptions: [entry({ expires: day(31) })] },
  });
  assert.equal(tooFar.status, 1, out(tooFar));
  assert.match(tooFar.stdout + tooFar.stderr, /more than 30 days out/, out(tooFar));
});

test('an unmatched active exception warns that it may be stale', () => {
  const res = runGate({ osvReport: CLEAN, exceptions: { exceptions: [entry()] } });
  assert.equal(res.status, 0, out(res));
  assert.match(res.stdout, new RegExp(`WARN exception ${FORGE_ID} on node-forge matched no advisory`), out(res));
});

test('an empty exceptions list still blocks every HIGH', () => {
  const res = runGate({
    osvReport: report(finding('node-forge', FORGE_ID)),
    exceptions: { exceptions: [] },
  });
  assert.equal(res.status, 1, out(res));
  assert.match(res.stdout, /\(none\)/, out(res));
});

const malformed = [
  ['invalid JSON', '{ "exceptions": [ '],
  ['exceptions not an array', { exceptions: {} }],
  ['missing reason', { exceptions: [entry({ reason: undefined })] }],
  ['blank package', { exceptions: [entry({ package: '  ' })] }],
  ['package with whitespace', { exceptions: [entry({ package: 'node-forge ' })] }],
  ['reason without a tracking issue', { exceptions: [entry({ reason: 'trust me' })] }],
  ['impossible date', { exceptions: [entry({ expires: '2026-02-31' })] }],
  ['non-ISO date', { exceptions: [entry({ expires: '10/31/2026' })] }],
  ['duplicate id + package', { exceptions: [entry(), entry({ reason: 'again. Tracking: #1' })] }],
];

for (const [label, exceptions] of malformed) {
  test(`a malformed exceptions file fails closed: ${label}`, () => {
    const res = runGate({ osvReport: report(finding('node-forge', FORGE_ID)), exceptions });
    assert.equal(res.status, 1, out(res));
    assert.match(res.stderr, /npm-audit-exceptions\.json/, out(res));
  });
}

test('a missing exceptions file fails closed', () => {
  const res = runGate({ osvReport: CLEAN, exceptions: undefined });
  assert.equal(res.status, 1, out(res));
  assert.match(res.stderr, /npm-audit-exceptions\.json not found/, out(res));
});
