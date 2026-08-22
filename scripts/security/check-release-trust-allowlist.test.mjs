import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiAllowlistNames,
  compareTrustSets,
  pipelineUnsignedNames,
  splitTopLevel,
} from './check-release-trust-allowlist.mjs';

/**
 * The guard parses two hand-written declarations, and its own parser has already
 * had one bug (a naive split on `|` sheared `^breeze-(agent` off as a bogus
 * alternative and made the whole check UNPARSEABLE). These tests pin the parser
 * and the comparator so a future edit cannot quietly reduce the guard to
 * something that always passes.
 */

const collect = () => {
  const problems = [];
  return { fail: (code, message) => problems.push({ code, message }), problems };
};

// Verbatim shape of the declaration in .github/workflows/release.yml.
const RELEASE_FIXTURE = `
          AGENT_FAMILY_WINDOWS_RE = re.compile(
              r"^breeze-agent\\.msi$"
              r"|^breeze-(agent|backup|watchdog|user-helper)-windows-amd64\\.exe$"
          )
`;

// Verbatim shape of the declaration in apps/api/src/services/releaseAssetTrust.ts.
const TRUST_FIXTURE = `
const SELF_HOST_UNSIGNED_ASSET_NAMES: ReadonlySet<string> = new Set([
  'breeze-agent.msi',
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
]);
`;

const EXPECTED = [
  'breeze-agent.msi',
  'breeze-agent-windows-amd64.exe',
  'breeze-backup-windows-amd64.exe',
  'breeze-watchdog-windows-amd64.exe',
  'breeze-user-helper-windows-amd64.exe',
];

test('splitTopLevel does not split inside a component group', () => {
  // The original bug: this must be 2 alternatives, not 5.
  const parts = splitTopLevel('^a$|^b-(x|y|z)-c$');
  assert.deepEqual(parts, ['^a$', '^b-(x|y|z)-c$']);
});

test('splitTopLevel respects escaped characters', () => {
  assert.deepEqual(splitTopLevel('^a\\.b$|^c$'), ['^a\\.b$', '^c$']);
});

test('pipeline regex expands to exactly the five agent-family assets', () => {
  const { fail, problems } = collect();
  const names = pipelineUnsignedNames(RELEASE_FIXTURE, fail);
  assert.deepEqual(problems, []);
  assert.deepEqual([...names].sort(), [...EXPECTED].sort());
});

test('API allowlist parses to exactly the five agent-family assets', () => {
  const { fail, problems } = collect();
  const names = apiAllowlistNames(TRUST_FIXTURE, fail);
  assert.deepEqual(problems, []);
  assert.deepEqual([...names].sort(), [...EXPECTED].sort());
});

test('the real declarations agree (no drift)', () => {
  const { fail } = collect();
  const pipeline = pipelineUnsignedNames(RELEASE_FIXTURE, fail);
  const api = apiAllowlistNames(TRUST_FIXTURE, fail);
  assert.deepEqual(compareTrustSets(pipeline, api), []);
});

test('reproduces the #3504 outage: pipeline unsigned, allowlist has only the msi', () => {
  const { fail } = collect();
  const pipeline = pipelineUnsignedNames(RELEASE_FIXTURE, fail);
  const api = new Set(['breeze-agent.msi']);

  const problems = compareTrustSets(pipeline, api);
  assert.equal(problems.length, 4, 'all four unsigned exes must be reported');
  assert.ok(problems.every((p) => p.code === 'MISSING_FROM_ALLOWLIST'));
  assert.deepEqual(
    problems.map((p) => p.message.split('\n')[0]).sort(),
    [
      'breeze-agent-windows-amd64.exe',
      'breeze-backup-windows-amd64.exe',
      'breeze-user-helper-windows-amd64.exe',
      'breeze-watchdog-windows-amd64.exe',
    ]
  );
});

test('catches a trust exception wider than the pipeline needs', () => {
  const { fail } = collect();
  const api = apiAllowlistNames(TRUST_FIXTURE, fail);
  // Pipeline signs user-helper again, allowlist still exempts it.
  const pipeline = new Set(EXPECTED.filter((n) => n !== 'breeze-user-helper-windows-amd64.exe'));

  const problems = compareTrustSets(pipeline, api);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'MISSING_FROM_PIPELINE');
  assert.match(problems[0].message, /^breeze-user-helper-windows-amd64\.exe/);
});

test('refuses to let the viewer or helper MSI become unsigned', () => {
  for (const leaked of ['breeze-viewer-windows.msi', 'breeze-helper-windows.msi']) {
    const set = new Set([...EXPECTED, leaked]);
    const problems = compareTrustSets(set, set);
    assert.ok(
      problems.some((p) => p.code === 'VIEWER_MUST_STAY_SIGNED' && p.message.startsWith(leaked)),
      `${leaked} leaking into the unsigned set must be rejected`
    );
  }
});

test('fails closed when a declaration cannot be parsed', () => {
  for (const [label, fn, src] of [
    ['pipeline', pipelineUnsignedNames, 'nothing resembling the declaration'],
    ['api', apiAllowlistNames, 'nothing resembling the declaration'],
  ]) {
    const { fail, problems } = collect();
    const result = fn(src, fail);
    assert.equal(result, null, `${label} must return null rather than an empty set`);
    assert.equal(problems[0].code, 'UNPARSEABLE');
  }
});

test('an empty allowlist is UNPARSEABLE, never a silent pass', () => {
  const { fail, problems } = collect();
  const result = apiAllowlistNames(
    'const SELF_HOST_UNSIGNED_ASSET_NAMES: ReadonlySet<string> = new Set([]);',
    fail
  );
  assert.equal(result, null);
  assert.equal(problems[0].code, 'UNPARSEABLE');
});
