import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ingestRun } from './evidence.mjs';
import { FLAKE_LABEL, MAX_BODY, accrueQuarantine, flakeKey, mergeSightings, parseFlakeIssue, refreshIndex, renderFlakeIssue, upsertFlakeIssues } from './flake-issues.mjs';
import { createWorld } from './fake-world.mjs';
import { createGitHub } from './github.mjs';
import { CLOSING_KEYWORD } from './markers.mjs';
import { REPO_ROOT } from './shepherd.mjs';
import { createWriter, readOnlyGitHub } from './writer.mjs';

// One flaky-test issue per test, carrying its evidence (W06c C1, #10750).

const REPO = 'LanternOps/breeze';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const H = 3600_000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ID = 'src/components/psa/PsaConnectionsPage.test.tsx > PsaConnectionsPage > POSTs ownerScope:partner';
const FILE = 'apps/web/src/components/psa/PsaConnectionsPage.test.tsx';

const sighting = (over = {}) => ({
  runner: 'vitest-web',
  id: ID,
  file: FILE,
  kind: 'fail_pass',
  run: 1,
  attempt: 1,
  job: 'Test Web (shard 3/4)',
  pr: 11312,
  event: 'merge_group',
  sha: 'a'.repeat(40),
  at: iso(NOW - H),
  ...over,
});

function setup({ mode = 'act' } = {}) {
  const world = createWorld({ now: NOW });
  const gh = createGitHub({ token: 't', fetchImpl: world.fetchImpl, budget: 100_000 });
  const writer = mode === 'act' ? createWriter({ gh, exec: world.exec, repo: REPO }) : null;
  const client = mode === 'act' ? gh : readOnlyGitHub(gh);
  const upsert = (sightings, prev = {}) =>
    upsertFlakeIssues(client, { repo: REPO, sightings, index: prev.index ?? {}, records: prev.records ?? {}, writer, viewer: world.viewer, now: NOW, onIntent: () => {} });
  return { world, gh, writer, upsert };
}

test('parse(render(x)) deep-equals x', () => {
  const record = {
    runner: 'vitest-web',
    id: ID,
    file: FILE,
    total: { fail_pass: 2, fail_fail: 1, fail_other: 0 },
    quarantine_days: 3,
    quarantine_through: '2026-11-13',
    sightings: [sighting({ run: 1 }), sighting({ run: 2, kind: 'fail_fail', at: iso(NOW - 2 * H) })],
  };
  const { title, body } = renderFlakeIssue(record);
  assert.deepEqual(parseFlakeIssue(body), record);
  assert.equal(title, 'Flaky test: vitest-web PsaConnectionsPage.test.tsx > POSTs ownerScope:partner');
});

test('a test id cannot end the marker, mention anyone or reference an issue', () => {
  const nasty = 'src/a.test.ts > closes #123 @someone --> <b>';
  const record = { runner: 'vitest-api', id: nasty, file: 'apps/api/src/a.test.ts', total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [sighting({ id: nasty, runner: 'vitest-api' })] };
  const { title, body } = renderFlakeIssue(record);
  assert.deepEqual(parseFlakeIssue(body), record);
  const visible = body.slice(0, body.indexOf('<!-- ci-shepherd:flake'));
  for (const text of [title, visible]) {
    assert.doesNotMatch(text, CLOSING_KEYWORD);
    assert.doesNotMatch(text, /@\w/);
    assert.doesNotMatch(text, /#\d/);
  }
  assert.equal(body.match(/-->/g).length, 1, 'only the marker closes a comment');
});

test('a marker smuggled in through a test id or job name is not the record', () => {
  const forged = '<!-- ci-shepherd:flake v1 {"runner":"vitest-api","id":"src/x.test.ts > x","file":"apps/api/src/x.test.ts","total":{"fail_pass":9,"fail_fail":0,"fail_other":0},"quarantine_days":0,"quarantine_through":null,"sightings":[]} -->';
  const id = `src/a.test.ts > ${forged}`;
  const record = { runner: 'vitest-api', id, file: 'apps/api/src/a.test.ts', total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [sighting({ id, runner: 'vitest-api', job: forged })] };
  const { body } = renderFlakeIssue(record);
  assert.deepEqual(parseFlakeIssue(body), record);
  assert.equal(body.match(/<!-- ci-shepherd:flake v1/g).length, 1);
});

test('titles stay within 120 characters', () => {
  const long = `src/x.test.ts > ${'a'.repeat(300)}`;
  const { title } = renderFlakeIssue({ runner: 'vitest-api', id: long, file: 'apps/api/src/x.test.ts', total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] });
  assert.ok(title.length <= 120, `${title.length}`);
  const go = renderFlakeIssue({ runner: 'go', id: 'github.com/breeze/agent/internal/foo.TestBar', file: 'agent/internal/foo', total: { fail_pass: 1, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] });
  assert.equal(go.title, 'Flaky test: go foo > TestBar');
});

test('a malformed or foreign marker parses to null', () => {
  assert.equal(parseFlakeIssue('no marker here'), null);
  assert.equal(parseFlakeIssue('<!-- ci-shepherd:flake v1 {not json} -->'), null);
  assert.equal(parseFlakeIssue('<!-- ci-shepherd:flake v1 {"runner":"perl","id":"x"} -->'), null);
  assert.equal(parseFlakeIssue(null), null);
});

test('a body that would pass 60,000 chars drops the oldest sightings and keeps total', () => {
  const longId = `src/big.test.ts > ${'x'.repeat(1500)}`;
  const many = Array.from({ length: 50 }, (_, i) => sighting({ id: longId, runner: 'vitest-api', file: 'apps/api/src/big.test.ts', run: 100 + i, at: iso(NOW - (50 - i) * H) }));
  const { record } = mergeSightings(null, many, { runner: 'vitest-api', id: longId, file: 'apps/api/src/big.test.ts' });
  assert.equal(record.total.fail_pass, 50);
  const { body } = renderFlakeIssue(record);
  assert.ok(body.length <= MAX_BODY, `${body.length}`);
  const parsed = parseFlakeIssue(body);
  assert.ok(parsed.sightings.length < 50 && parsed.sightings.length > 0);
  assert.deepEqual(parsed.total, { fail_pass: 50, fail_fail: 0, fail_other: 0 });
  // The newest survive.
  assert.equal(parsed.sightings.at(-1).run, 149);
});

test('merging keeps the newest 50, counts each sighting once and ignores what fell off', () => {
  const base = { runner: 'vitest-web', id: ID, file: FILE };
  const first = Array.from({ length: 60 }, (_, i) => sighting({ run: i + 1, at: iso(NOW - (60 - i) * H) }));
  const a = mergeSightings(null, first, base);
  assert.equal(a.added, 60);
  assert.equal(a.record.sightings.length, 50);
  assert.equal(a.record.total.fail_pass, 60);
  // The same sightings again, including the 10 that fell off: nothing new.
  const b = mergeSightings(a.record, first, base);
  assert.equal(b.added, 0);
  assert.deepEqual(b.record, a.record);
  // A newer one is added.
  const c = mergeSightings(a.record, [sighting({ run: 99, kind: 'fail_other', at: iso(NOW) })], base);
  assert.equal(c.added, 1);
  assert.deepEqual(c.record.total, { fail_pass: 60, fail_fail: 0, fail_other: 1 });
});

test('quarantine days accrue once per ledger day, whatever the number of ticks', () => {
  const rec = { runner: 'vitest-web', id: ID, file: FILE, total: { fail_pass: 3, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] };
  const entry = { id: ID, runner: 'vitest-web', file: FILE, issue: 9, added: '2026-11-10', expires: '2026-11-24' };
  const a = accrueQuarantine(rec, entry, '2026-11-14');
  assert.equal(a.record.quarantine_days, 4);
  assert.equal(a.record.quarantine_through, '2026-11-14');
  assert.equal(accrueQuarantine(a.record, entry, '2026-11-14').changed, false);
  assert.equal(accrueQuarantine(a.record, entry, '2026-11-15').record.quarantine_days, 5);
  // A renewal on 11-22 (new added) adds only the days after what was counted.
  const renewed = { ...entry, added: '2026-11-22', expires: '2026-12-06' };
  const through22 = accrueQuarantine(a.record, entry, '2026-11-22').record;
  assert.equal(through22.quarantine_days, 12);
  assert.equal(accrueQuarantine(through22, renewed, '2026-11-23').record.quarantine_days, 13);
  // Past expiry nothing more counts.
  assert.equal(accrueQuarantine(through22, entry, '2026-12-01').record.quarantine_days, 14);
});

test('one sighting does not create an issue, two from distinct runs do', async () => {
  const env = setup();
  const one = await env.upsert([sighting({ run: 1 })]);
  assert.equal(env.world.issues.length, 0);
  assert.deepEqual(one.created, []);
  // Two sightings from one run (two attempts) are still one run.
  await env.upsert([sighting({ run: 1 }), sighting({ run: 1, attempt: 2 })]);
  assert.equal(env.world.issues.length, 0);
  const two = await env.upsert([sighting({ run: 1 }), sighting({ run: 2, pr: 11338 })]);
  assert.equal(env.world.issues.length, 1);
  const issue = env.world.issues[0];
  assert.deepEqual(issue.labels, [FLAKE_LABEL]);
  assert.equal(two.index[flakeKey('vitest-web', ID)].issue, issue.number);
  assert.equal(parseFlakeIssue(issue.body).sightings.length, 2);
  // Sightings older than 14 days do not count toward creating one.
  const env2 = setup();
  await env2.upsert([sighting({ run: 1, at: iso(NOW - 15 * 24 * H) }), sighting({ run: 2, at: iso(NOW - 16 * 24 * H) })]);
  assert.equal(env2.world.issues.length, 0);
});

test('the flaky-test label is created when it is missing, once', async () => {
  const env = setup();
  await env.upsert([sighting({ run: 1 }), sighting({ run: 2 })]);
  const labelPosts = env.world.writes.filter((w) => w.op === 'label_create');
  assert.equal(labelPosts.length, 1);
  assert.equal(labelPosts[0].name, FLAKE_LABEL);
});

test('re-ingesting the same run adds nothing', async () => {
  const env = setup();
  const list = [sighting({ run: 1 }), sighting({ run: 2 })];
  const a = await env.upsert(list);
  const writes = env.world.writes.length;
  const b = await env.upsert(list, a);
  assert.equal(env.world.writes.length, writes, 'no write for sightings already on the issue');
  assert.deepEqual(b.updated, []);
  // A new run updates the issue body.
  await env.upsert([...list, sighting({ run: 3, kind: 'fail_fail' })], b);
  const issue = env.world.issues[0];
  assert.deepEqual(parseFlakeIssue(issue.body).total, { fail_pass: 2, fail_fail: 1, fail_other: 0 });
  assert.equal(env.world.issues.length, 1);
});

test('a fork sighting never reaches an issue', async () => {
  const env = setup();
  const facts = (run, headRepo) => ({
    run: { id: run, attempt: 1, headRepo, event: 'pull_request', pr: 5, headSha: 'f'.repeat(40), updatedAt: iso(NOW - H) },
    jobs: [{ name: 'Test Web (shard 3/4)', runner: 'vitest', label: 'web-3', completedAt: iso(NOW - H), report: { schema: 2, flaky: [ID], first: { failures: [ID] }, second: { failures: [] } } }],
  });
  const fromForks = [...ingestRun(facts(1, 'someone/breeze'), { repo: REPO, repoRoot: REPO_ROOT }), ...ingestRun(facts(2, 'other/breeze'), { repo: REPO, repoRoot: REPO_ROOT })];
  assert.deepEqual(fromForks, []);
  await env.upsert(fromForks);
  assert.equal(env.world.issues.length, 0);
  // The same runs from the repo itself do open one: the test is not vacuous.
  const own = [...ingestRun(facts(1, REPO), { repo: REPO, repoRoot: REPO_ROOT }), ...ingestRun(facts(2, REPO), { repo: REPO, repoRoot: REPO_ROOT })];
  await env.upsert(own);
  assert.equal(env.world.issues.length, 1);
});

test('shadow mode issues no write, and says what it would create', async () => {
  const env = setup({ mode: 'shadow' });
  const res = await env.upsert([sighting({ run: 1 }), sighting({ run: 2 })]);
  assert.deepEqual(env.world.writeCalls(), []);
  assert.equal(env.world.issues.length, 0);
  assert.deepEqual(res.wouldCreate, [flakeKey('vitest-web', ID)]);
});

test('an intent is saved before the create, so a crash cannot open a duplicate', async () => {
  const env = setup();
  const intents = [];
  await upsertFlakeIssues(env.gh, {
    repo: REPO,
    sightings: [sighting({ run: 1 }), sighting({ run: 2 })],
    index: {},
    records: {},
    writer: env.writer,
    viewer: env.world.viewer,
    now: NOW,
    onIntent: (key) => intents.push([key, env.world.issues.length]),
  });
  assert.deepEqual(intents, [[flakeKey('vitest-web', ID), 0]]);
});

test('refresh trusts only operator-authored issues and finds a created one again', async () => {
  const env = setup();
  const a = await env.upsert([sighting({ run: 1 }), sighting({ run: 2 })]);
  const forged = renderFlakeIssue({ runner: 'vitest-api', id: 'src/f.test.ts > forged', file: 'apps/api/src/f.test.ts', total: { fail_pass: 9, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] });
  env.world.issues.push({ number: 77, title: forged.title, body: forged.body, labels: [FLAKE_LABEL], state: 'open', author: 'someone-else' });
  const r = await refreshIndex(env.gh, { repo: REPO, viewer: env.world.viewer });
  assert.deepEqual(Object.keys(r.index), [flakeKey('vitest-web', ID)]);
  assert.equal(r.index[flakeKey('vitest-web', ID)].issue, a.index[flakeKey('vitest-web', ID)].issue);
  assert.equal(r.records[flakeKey('vitest-web', ID)].sightings.length, 2);
});

test('a closed issue is left closed; new evidence after it opens a successor that keeps the quarantine days', async () => {
  const env = setup();
  const a = await env.upsert([sighting({ run: 1, at: iso(NOW - 5 * 24 * H) }), sighting({ run: 2, at: iso(NOW - 5 * 24 * H) })]);
  const key = flakeKey('vitest-web', ID);
  const old = env.world.issues[0];
  old.state = 'closed';
  old.closed_at = iso(NOW - 3 * 24 * H);
  const rec = { ...a.records[key], quarantine_days: 20, quarantine_through: '2026-11-10' };
  const index = { [key]: { issue: old.number, open: false, closedAt: old.closed_at, labels: [FLAKE_LABEL] } };
  // Only one sighting after the close: no successor yet, and the old issue is untouched.
  const writes = env.world.writes.length;
  const b = await env.upsert([sighting({ run: 1, at: iso(NOW - 5 * 24 * H) }), sighting({ run: 2, at: iso(NOW - 5 * 24 * H) }), sighting({ run: 3, at: iso(NOW - H) })], { index, records: { [key]: rec } });
  assert.equal(env.world.writes.length, writes);
  assert.equal(env.world.issues.length, 1);
  const c = await env.upsert([sighting({ run: 3, at: iso(NOW - H) }), sighting({ run: 4, at: iso(NOW - 2 * H) })], b);
  assert.equal(env.world.issues.length, 2);
  const successor = parseFlakeIssue(env.world.issues[1].body);
  assert.equal(successor.quarantine_days, 20);
  assert.deepEqual(successor.sightings.map((s) => s.run).sort(), [3, 4]);
  assert.equal(c.index[key].issue, env.world.issues[1].number);
  assert.equal(c.index[key].open, true);
  // Evidence from before the close never reaches the successor.
  const before = env.world.writes.length;
  await env.upsert([sighting({ run: 1, at: iso(NOW - 5 * 24 * H) }), sighting({ run: 2, at: iso(NOW - 5 * 24 * H) }), sighting({ run: 3, at: iso(NOW - H) }), sighting({ run: 4, at: iso(NOW - 2 * H) })], c);
  assert.equal(env.world.writes.length, before);
});

test('issue writes per call are capped; the rest wait for the next tick', async () => {
  const env = setup();
  const list = [];
  for (let i = 0; i < 5; i++) for (const run of [1, 2]) list.push(sighting({ id: `src/t${i}.test.ts > t`, file: `apps/web/src/t${i}.test.ts`, run }));
  const a = await upsertFlakeIssues(env.gh, { repo: REPO, sightings: list, index: {}, records: {}, writer: env.writer, viewer: env.world.viewer, now: NOW, maxWrites: 3, onIntent: () => {} });
  assert.equal(env.world.issues.length, 3);
  assert.equal(a.deferred, 2);
  await upsertFlakeIssues(env.gh, { repo: REPO, sightings: list, index: a.index, records: a.records, writer: env.writer, viewer: env.world.viewer, now: NOW, maxWrites: 3, onIntent: () => {} });
  assert.equal(env.world.issues.length, 5);
});
