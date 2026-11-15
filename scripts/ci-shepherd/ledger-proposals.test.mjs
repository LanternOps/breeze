import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { LEDGER_PATH, validateLedger } from '../../.github/scripts/flaky-ledger.mjs';
import { proposeLedger, quarantineEligibility } from './ledger-proposals.mjs';
import { REPO_ROOT } from './shepherd.mjs';

// Deterministic flaky-ledger proposals (W06c C2, #10750). This is the one W06
// path that can weaken a gate, so every rule has a case that holds it closed.

const TODAY = '2026-11-14';
const ID = 'src/components/psa/PsaConnectionsPage.test.tsx > PsaConnectionsPage > POSTs ownerScope:partner';
const FILE = 'apps/web/src/components/psa/PsaConnectionsPage.test.tsx';
const day = (d, h = 12) => `${d}T${String(h).padStart(2, '0')}:00:00Z`;
const exists = () => true;

let runN = 1;
const s = (over = {}) => ({ runner: 'vitest-web', id: ID, file: FILE, kind: 'fail_pass', run: runN++, attempt: 1, job: 'Test Web (shard 3/4)', pr: 11312, event: 'pull_request', sha: 'a'.repeat(40), at: day('2026-11-13'), ...over });
const record = (sightings, over = {}) => ({ runner: 'vitest-web', id: ID, file: FILE, issue: 900, quarantine_days: 0, sightings, ...over });
// Three sightings in 7 days, two PRs, one in the merge queue: an add.
const addable = () => [s({ pr: 1 }), s({ pr: 2, kind: 'fail_other' }), s({ pr: 2, event: 'merge_group', at: day('2026-11-12') })];
const entry = (over = {}) => ({ id: ID, runner: 'vitest-web', file: FILE, issue: 900, added: '2026-11-01', expires: '2026-11-15', ...over });
const propose = (over = {}) => proposeLedger({ ledger: [], records: [], breakers: [], today: TODAY, fileExists: exists, ...over });

function assertValid(p) {
  assert.deepEqual(validateLedger(p.next), []);
  const sorted = [...p.next].sort((a, b) => (a.runner === b.runner ? (a.id < b.id ? -1 : 1) : a.runner < b.runner ? -1 : 1));
  assert.deepEqual(p.next, sorted, 'next is sorted by (runner, id)');
}

test('add: 3 sightings in 7 days from 2 PRs, one threatening the queue → a 14-day entry', () => {
  const p = propose({ records: [record(addable())] });
  assert.deepEqual(p.add, [{ id: ID, runner: 'vitest-web', file: FILE, issue: 900, added: TODAY, expires: '2026-11-28' }]);
  assert.deepEqual(p.next, p.add);
  assert.ok(!('covers' in p.add[0]), 'covers is never auto-added');
  assertValid(p);
});

test('add: fail_fail on a PR run counts as threatening the queue', () => {
  const p = propose({ records: [record([s({ pr: 1 }), s({ pr: 2, kind: 'fail_fail' }), s({ pr: 1, kind: 'fail_pass' })])] });
  assert.equal(p.add.length, 1);
});

test('no add: fewer than 3 sightings in 7 days, or older ones only', () => {
  assert.equal(propose({ records: [record(addable().slice(0, 2))] }).add.length, 0);
  const old = addable().map((x) => ({ ...x, at: day('2026-11-07') }));
  assert.equal(propose({ records: [record(old)] }).add.length, 0);
  // 11-08 is the 7th day back (11-08 … 11-14): still inside.
  const edge = addable().map((x) => ({ ...x, at: day('2026-11-08') }));
  assert.equal(propose({ records: [record(edge)] }).add.length, 1);
});

test("no add: one PR's sightings only (PR-less main runs do not count as a second PR)", () => {
  const onePr = [s({ pr: 1 }), s({ pr: 1, kind: 'fail_other' }), s({ pr: 1, event: 'merge_group' }), s({ pr: null, event: 'push' })];
  assert.equal(propose({ records: [record(onePr)] }).add.length, 0);
});

test('no add: nothing threatened the queue (no fail_fail, no merge_group)', () => {
  const p = propose({ records: [record([s({ pr: 1 }), s({ pr: 2 }), s({ pr: 3, kind: 'fail_other' })])] });
  assert.equal(p.add.length, 0);
});

test('no add: it never passed on a retry (every sighting failed both attempts)', () => {
  const det = [s({ pr: 1, kind: 'fail_fail' }), s({ pr: 2, kind: 'fail_fail' }), s({ pr: 3, kind: 'fail_fail', event: 'merge_group' })];
  assert.equal(propose({ records: [record(det)] }).add.length, 0);
});

test('no add: a suspected or confirmed main_broken breaker names it; an outage breaker does not block', () => {
  for (const status of ['suspected', 'confirmed']) {
    const p = propose({ records: [record(addable())], breakers: [{ kind: 'main_broken', key: ID, status, openedAt: day(TODAY), prs: [1, 2, 3], restore: [] }] });
    assert.equal(p.add.length, 0, status);
  }
  const other = propose({ records: [record(addable())], breakers: [{ kind: 'outage', key: 'runner_lost', status: 'open', openedAt: day(TODAY), prs: [], restore: [] }] });
  assert.equal(other.add.length, 1);
});

test('no add: the file is gone at main, the record has no file, or the id is not a single test', () => {
  assert.equal(propose({ records: [record(addable())], fileExists: () => false }).add.length, 0);
  assert.equal(propose({ records: [record(addable(), { file: null })] }).add.length, 0);
  const goSub = 'github.com/breeze/agent/internal/foo.TestBar/sub';
  const goRec = record(addable().map((x) => ({ ...x, runner: 'go', id: goSub, file: 'agent/internal/foo' })), { runner: 'go', id: goSub, file: 'agent/internal/foo' });
  const p = propose({ records: [goRec] });
  assert.equal(p.add.length, 0);
  assertValid(p);
});

test('no add without an open issue: it waits for one', () => {
  const p = propose({ records: [record(addable(), { issue: null })] });
  assert.equal(p.add.length, 0);
  assert.deepEqual(p.waitingIssue, [`vitest-web|${ID}`]);
});

test('the 60-day cap: no add at 60 days, and a late add is cut to what is left', () => {
  const capped = propose({ records: [record(addable(), { quarantine_days: 60 })] });
  assert.equal(capped.add.length, 0);
  assert.deepEqual(capped.fixRequired, [`vitest-web|${ID}`]);
  const late = propose({ records: [record(addable(), { quarantine_days: 55 })] });
  assert.equal(late.add[0].expires, '2026-11-19');
  assertValid(late);
});

test('renew: expiring within 3 days, fresh flake evidence, room under the cap → a new 14-day entry', () => {
  const p = propose({ ledger: [entry({ expires: '2026-11-17' })], records: [record([s({ kind: 'fail_pass' })], { quarantine_days: 13 })] });
  assert.deepEqual(p.renew, [entry({ added: TODAY, expires: '2026-11-28' })]);
  assert.deepEqual(p.next, p.renew);
  assertValid(p);
});

test('no renew: not expiring yet, only fail_fail evidence, a closed issue, or a main_broken breaker', () => {
  const r = (sightings, over) => record(sightings, { quarantine_days: 13, ...over });
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-18' })], records: [r([s()])] }).renew.length, 0, 'four days out');
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-17' })], records: [r([s({ kind: 'fail_fail' })])] }).renew.length, 0, 'fail_fail only');
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-17' })], records: [r([s()], { issue: null })] }).renew.length, 0, 'no open issue');
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-17' })], records: [] }).renew.length, 0, 'no record');
  const broken = [{ kind: 'main_broken', key: ID, status: 'confirmed', openedAt: day(TODAY), prs: [], restore: [] }];
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-17' })], records: [r([s()])], breakers: broken }).renew.length, 0, 'breaker');
});

test('the cap: a renewal past 60 days is fixRequired instead, and the entry is kept until it expires', () => {
  const p = propose({ ledger: [entry({ expires: '2026-11-17' })], records: [record([s()], { quarantine_days: 47 })] });
  assert.equal(p.renew.length, 0);
  assert.deepEqual(p.fixRequired, [`vitest-web|${ID}`]);
  assert.deepEqual(p.next, [entry({ expires: '2026-11-17' })]);
  // At exactly 60 it still renews.
  assert.equal(propose({ ledger: [entry({ expires: '2026-11-17' })], records: [record([s()], { quarantine_days: 46 })] }).renew.length, 1);
});

test('remove: past expiry', () => {
  const p = propose({ ledger: [entry({ expires: '2026-11-13' })], records: [record([s()])] });
  assert.deepEqual(p.remove, [entry({ expires: '2026-11-13' })]);
  assert.deepEqual(p.next, []);
  // On its expiry day it is still active.
  assert.equal(propose({ ledger: [entry({ expires: TODAY })], records: [record([s()])] }).remove.length, 0);
});

test('remove: no sightings for 14 days, once the evidence covers those 14 days', () => {
  const long = entry({ added: '2026-10-20', expires: '2026-11-19' });
  const quiet = record([s({ at: day('2026-10-30') })]);
  assert.equal(propose({ ledger: [long], records: [quiet] }).remove.length, 1);
  assert.equal(propose({ ledger: [long], records: [] }).remove.length, 1, 'no record at all');
  // One sighting inside the 14 days keeps it.
  assert.equal(propose({ ledger: [long], records: [record([s({ at: day('2026-11-01') })])] }).remove.length, 0);
  // Evidence collected for less than 14 days cannot prove silence.
  assert.equal(propose({ ledger: [long], records: [quiet], evidenceSince: day('2026-11-05') }).remove.length, 0);
  // An entry added less than 14 days ago is not silent yet.
  assert.equal(propose({ ledger: [entry({ added: '2026-11-05', expires: '2026-11-19' })], records: [] }).remove.length, 0);
});

test('an invalid result throws instead of proposing it', () => {
  const bad = { id: 'not a test id', runner: 'vitest-web', file: 'x', issue: 1, added: '2026-11-10', expires: '2026-11-20' };
  assert.throws(() => propose({ ledger: [bad] }), /invalid/);
});

test('the committed ledger passes through unchanged with no records', () => {
  const ledger = JSON.parse(readFileSync(join(REPO_ROOT, LEDGER_PATH), 'utf8'));
  const p = propose({ ledger });
  assert.deepEqual(p.next, ledger);
  assert.deepEqual([p.add, p.renew, p.remove, p.fixRequired], [[], [], [], []]);
});

test('every proposal validates, entries keep their own fields, and the evidence is reported', () => {
  const other = { id: 'src/z.test.ts > z', runner: 'vitest-api', file: 'apps/api/src/z.test.ts', issue: 5, added: '2026-11-10', expires: '2026-11-24', covers: ['apps/api/src/z'] };
  const p = propose({ ledger: [other, entry({ expires: '2026-11-16' })], records: [record(addable(), { quarantine_days: 10 })] });
  assertValid(p);
  assert.deepEqual(p.renew.map((e) => e.expires), ['2026-11-28']);
  assert.ok(p.next.some((e) => e.id === other.id && e.covers), 'a hand-written entry is kept as is');
  assert.equal(p.evidence[`vitest-web|${ID}`].sightings7, 3);
});

// Must-fix: tenancy, RLS, contract and other protected tests never reach an
// auto-merging ledger PR, whatever the evidence.
const PROTECTED = [
  { runner: 'vitest-integration', id: 'src/services/devices.integration.test.ts > devices > lists', file: 'apps/api/src/services/devices.integration.test.ts' },
  { runner: 'vitest-api', id: 'src/routes/devices.contract.test.ts > devices > shape', file: 'apps/api/src/routes/devices.contract.test.ts' },
  { runner: 'vitest-api', id: 'src/__tests__/devices.test.ts > devices > x', file: 'apps/api/src/__tests__/devices.test.ts' },
  { runner: 'vitest-api', id: 'src/db/rlsCoverage.test.ts > rls > x', file: 'apps/api/src/db/rlsCoverage.test.ts' },
  { runner: 'vitest-api', id: 'src/services/tenantExport.test.ts > t > x', file: 'apps/api/src/services/tenantExport.test.ts' },
  { runner: 'vitest-web', id: 'src/lib/Auth.test.tsx > a > x', file: 'apps/web/src/lib/Auth.test.tsx' },
  { runner: 'vitest-api', id: 'src/security/headers.test.ts > s > x', file: 'apps/api/src/security/headers.test.ts' },
  { runner: 'vitest-api', id: 'src/db/migrationRlsScope.test.ts > m > x', file: 'apps/api/src/db/migrationRlsScope.test.ts' },
  { runner: 'vitest-api', id: 'src/services/billingSync.test.ts > b > x', file: 'apps/api/src/services/billingSync.test.ts' },
  { runner: 'vitest-api', id: 'src/services/orgCascade.test.ts > c > x', file: 'apps/api/src/services/orgCascade.test.ts' },
  { runner: 'go', id: 'github.com/breeze-rmm/agent/internal/auth.TestToken', file: 'agent/internal/auth' },
];

test('quarantineEligibility: the protected set, and an ordinary test is eligible', () => {
  for (const t of PROTECTED) {
    const e = quarantineEligibility(t);
    assert.equal(e.eligible, false, t.id);
    assert.ok(e.reasons.length > 0, t.id);
  }
  assert.deepEqual(quarantineEligibility({ runner: 'vitest-web', id: ID, file: FILE }), { eligible: true, reasons: [] });
});

test('a protected test is never added or renewed, under any evidence; it is reported instead', () => {
  // Every corroboration rule holds, many times over.
  const strong = (t) => [1, 2, 3, 4].flatMap((pr) => [s({ ...t, pr }), s({ ...t, pr, kind: 'fail_fail', event: 'merge_group' }), s({ ...t, pr, kind: 'fail_other' })]);
  const records = PROTECTED.map((t) => ({ ...t, issue: 900, quarantine_days: 0, sightings: strong(t) }));
  const p = propose({ records });
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.next, []);
  assert.equal(p.protected.length, PROTECTED.length);
  // A protected entry a human put in the ledger is kept as written, never renewed.
  const t = PROTECTED[0];
  const handAdded = { id: t.id, runner: t.runner, file: t.file, issue: 900, added: '2026-11-01', expires: '2026-11-15' };
  const q = propose({ ledger: [handAdded], records: [{ ...t, issue: 900, quarantine_days: 0, sightings: strong(t) }] });
  assert.deepEqual(q.renew, []);
  assert.deepEqual(q.next, [handAdded]);
  assertValid(q);
  // The control: the same evidence on an ordinary test is an add.
  assert.equal(propose({ records: [record(strong({}))] }).add.length, 1);
});
