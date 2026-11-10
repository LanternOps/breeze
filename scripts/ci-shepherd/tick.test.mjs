import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, readMode } from './apply.mjs';
import { LABELS, decide, summarizeVerdict } from './decide.mjs';
import { createWorld } from './fake-world.mjs';
import { headPushedAt, prSnapshot } from './facts.mjs';
import { createGitHub } from './github.mjs';
import { parseMarkers } from './markers.mjs';
import { probe } from './probe.mjs';
import { REPO_ROOT } from './shepherd.mjs';
import { readJsonl } from './state.mjs';
import { tick } from './tick.mjs';
import { ShadowWriteBlocked, createWriter, readOnlyGitHub } from './writer.mjs';

// The single writer (W06b B3, #10750): shadow mode, idempotency, crash and
// mode-flip recovery, stale decisions, locks, budgets and the sweeps — against
// a stateful fake of the GitHub API.

const REPO = 'LanternOps/breeze';
const T0 = Date.parse('2026-11-08T12:00:00Z');
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const RUNNER_LOST = { name: 'Integration Tests (shard 11/16)', step: 'Run integration tests', annotations: ['The hosted runner lost communication with the server.'] };
const UNKNOWN = { name: 'Security Audit', step: 'Run audit', annotations: [] };

const tmpState = () => mkdtempSync(join(tmpdir(), 'ci-shepherd-state-'));

function setup({ mode = null } = {}) {
  const world = createWorld({ mode, now: T0 });
  const gh = createGitHub({ token: 'test', fetchImpl: world.fetchImpl, budget: 100_000 });
  const stateDir = mkdtempSync(join(tmpdir(), 'ci-shepherd-tick-'));
  const run = (over = {}) => tick({ gh, repo: REPO, stateDir, now: world.clock, clock: () => world.clock, exec: world.exec, repoRoot: REPO_ROOT, log: () => {}, ...over });
  const decisions = () => readJsonl(join(stateDir, 'decisions.jsonl'));
  const state = () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
  const writesOf = (op, pr) => world.writes.filter((x) => x.op === op && (pr === undefined || x.pr === pr));
  return { world, gh, stateDir, run, decisions, state, writesOf };
}

// PR 107: in the queue 40 min, its CI run completed 10 min ago with no CI
// Success job (the stuck-entry sweep's case).
function stuckPr(env) {
  const { world } = env;
  world.addPr(107, { queue: { state: 'QUEUED', position: 2, enqueuedAt: iso(T0 - 40 * MIN), groupSha: 'feed'.repeat(10) } });
  world.runs.push({
    id: 7007,
    run_attempt: 1,
    head_sha: 'feed'.repeat(10),
    head_branch: `gh-readonly-queue/main/pr-107-${'c'.repeat(40)}`,
    head_repository: { full_name: REPO },
    event: 'merge_group',
    status: 'completed',
    conclusion: 'failure',
    path: '.github/workflows/ci.yml',
    created_at: iso(T0 - 40 * MIN),
    updated_at: iso(T0 - 10 * MIN),
    pull_requests: [],
    jobs: [{ id: 70071, name: 'Lint', run_attempt: 1, conclusion: 'success', started_at: iso(T0 - 39 * MIN), completed_at: iso(T0 - 30 * MIN), steps: [], annotations: [], log: null }],
  });
}

// A world where every kind of write would be due: a real failure (hold), an
// unknown with auto-merge off (requeue), three PRs on one infra signature
// (the outage breaker → backoff), a resume label, and a stuck queue entry.
function busyWorld(env) {
  const { world } = env;
  world.addPr(101, { queue: { state: 'QUEUED', position: 1, enqueuedAt: iso(T0 - 2 * MIN) } });
  world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
  world.prs.get(101).queue = { state: 'QUEUED', position: 1, enqueuedAt: iso(T0 - 2 * MIN) };
  world.addPr(102, { autoMerge: false });
  world.removeFailed(102, { at: iso(T0 - 9 * MIN), job: UNKNOWN });
  for (const [n, off] of [[103, 8], [104, 7], [105, 6]]) {
    world.addPr(n);
    world.removeFailed(n, { at: iso(T0 - off * MIN), job: RUNNER_LOST });
  }
  world.addPr(106, { labels: [LABELS.hold, LABELS.resume], autoMerge: false });
  stuckPr(env);
}

test('shadow makes no write call, and records what it would do (one line per removal)', async () => {
  for (const mode of [null, 'shadow']) {
    const env = setup({ mode });
    busyWorld(env);
    const summary = await env.run();
    // Nothing reached GitHub but reads: REST GETs and GraphQL queries.
    for (const c of env.world.calls) {
      assert.ok(c.method === 'GET' || (c.path === '/graphql' && !c.mutation), `write-capable call in shadow: ${c.method} ${c.path}`);
    }
    assert.deepEqual(env.world.writeCalls(), []);
    assert.deepEqual(env.world.execs, [], 'no gh CLI call');
    assert.deepEqual(env.world.writes, []);
    assert.equal(summary.mode, 'shadow', `mode ${mode}`);
    assert.equal(summary.status, 'ok', JSON.stringify(summary.errors));
    // Every removal has exactly one recorded decision, and the decisions are
    // ones that would write: the test is not passing because nothing was due.
    const lines = env.decisions();
    const byRemoval = lines.filter((l) => l.source === 'removal');
    assert.equal(byRemoval.length, 5);
    assert.equal(new Set(byRemoval.map((l) => l.removalId)).size, 5);
    for (const l of lines) assert.equal(l.status, 'shadow');
    const kinds = Object.fromEntries(byRemoval.map((l) => [l.pr, l.kind]));
    assert.deepEqual(kinds, { 101: 'hold', 102: 'requeue', 103: 'record', 104: 'record', 105: 'backoff' });
    const ops = new Set(lines.flatMap((l) => l.mutations.map((m) => m.op)));
    for (const op of ['disable_auto_merge', 'dequeue', 'label_add', 'enqueue', 'label_remove', 'enable_auto_merge', 'comment']) assert.ok(ops.has(op), `would ${op}`);
    assert.ok(lines.some((l) => l.kind === 'resume' && l.pr === 106));
    assert.ok(lines.some((l) => l.kind === 'requeue_stuck' && l.pr === 107));
    // A second shadow tick adds nothing for the same removals and the same resume label.
    await env.run();
    assert.equal(env.decisions().filter((l) => l.source === 'removal').length, 5);
    assert.equal(env.decisions().filter((l) => l.kind === 'resume').length, 1);
    assert.deepEqual(env.world.writeCalls(), []);
  }
});

test('the read-only client refuses writes before they reach the network; a writer refuses it', async () => {
  const world = createWorld();
  const ro = readOnlyGitHub(createGitHub({ token: 't', fetchImpl: world.fetchImpl }));
  assert.throws(() => ro.rest('POST', 'repos/o/r/issues/1/comments', { body: 'x' }), ShadowWriteBlocked);
  assert.throws(() => ro.rest('DELETE', 'repos/o/r/issues/1/labels/x'), ShadowWriteBlocked);
  assert.throws(() => ro.graphql('mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }', {}), ShadowWriteBlocked);
  assert.equal(world.calls.length, 0);
  assert.throws(() => createWriter({ gh: ro, repo: REPO }), /read-only/);
});

test('act: two ticks over one removal give one comment and one mutation set', async () => {
  const env = setup({ mode: 'act' });
  env.world.addPr(101);
  env.world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
  env.world.reAdd(101, iso(T0 - 9 * MIN));
  const s1 = await env.run();
  assert.equal(s1.status, 'ok', JSON.stringify(s1.errors));
  await env.run();
  env.world.clock += 5 * MIN;
  await env.run();
  assert.equal(env.writesOf('comment_post', 101).length, 1);
  assert.equal(env.writesOf('disable_auto_merge', 101).length, 1);
  assert.equal(env.writesOf('dequeue', 101).length, 1);
  assert.equal(env.writesOf('label_add', 101).length, 1);
  assert.equal(env.writesOf('comment_edit', 101).length, 1);
  const pr = env.world.prs.get(101);
  assert.deepEqual(pr.labels, [LABELS.hold]);
  assert.equal(pr.autoMerge, false);
  assert.equal(pr.queue, null);
  const [m] = parseMarkers(pr.comments, { viewer: 'operator' });
  assert.equal(m.status, 'done');
  assert.equal(m.decision, 'hold');
  assert.equal(m.hold_reason, 'real');
  // The shepherd's own dequeue (a manual removal by the operator login) was
  // decided as noop, not taken for human intent or a new failure.
  assert.equal(env.state().pending.length, 0);
});

test('act: a crash after the first mutation is completed by the next tick, with no second marker', async () => {
  const env = setup({ mode: 'act' });
  env.world.addPr(101);
  env.world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
  env.world.reAdd(101, iso(T0 - 9 * MIN));
  env.world.failOnce('dequeue');
  const s1 = await env.run();
  assert.equal(env.writesOf('disable_auto_merge').length, 1);
  assert.equal(env.writesOf('dequeue').length, 0);
  assert.ok(s1.errors.some((e) => /dequeue|502|GraphQL/i.test(e)), JSON.stringify(s1.errors));
  assert.equal(env.state().pending.length, 1);
  await env.run();
  assert.equal(env.writesOf('comment_post').length, 1, 'one marker comment');
  assert.equal(env.writesOf('disable_auto_merge').length, 1);
  assert.equal(env.writesOf('dequeue').length, 1);
  assert.equal(env.writesOf('label_add').length, 1);
  assert.equal(env.writesOf('comment_edit').length, 1);
  assert.equal(parseMarkers(env.world.prs.get(101).comments, { viewer: 'operator' })[0].status, 'done');
  assert.equal(env.state().pending.length, 0);
});

test('act: a stale decision is skipped with no write (head moved, later manual removal, merged)', async () => {
  for (const change of ['head', 'manual', 'merged']) {
    const world = createWorld({ mode: 'act', now: T0 });
    const gh = createGitHub({ token: 't', fetchImpl: world.fetchImpl });
    world.addPr(101);
    const r = world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
    const snapshot = async (pr) => {
      const s = await prSnapshot(gh, { repo: REPO, pr, withFiles: false });
      return { ...s, headPushedAt: await headPushedAt(gh, { repo: REPO, headSha: s.headSha }) };
    };
    const snap = await snapshot(101);
    const removal = { pr: 101, id: r.id, at: r.at, reason: 'failed_checks' };
    const d = decide({ removal, snapshot: snap, verdict: { class: 'real', run: r.runId, attempt: 1, testIds: [], failedBoth: [] }, now: T0 });
    assert.equal(d.kind, 'hold');
    const pr = world.prs.get(101);
    if (change === 'head') Object.assign(pr, { headSha: 'f'.repeat(40), headPushedAt: iso(T0 - MIN) });
    if (change === 'manual') pr.events.push({ __typename: 'RemovedFromMergeQueueEvent', id: 'M1', createdAt: iso(T0 - MIN), reason: 'manual', actor: { login: 'operator' }, beforeCommit: null });
    if (change === 'merged') pr.state = 'MERGED';
    const res = await apply(gh, d, {
      mode: 'act',
      repo: REPO,
      viewer: 'operator',
      writer: createWriter({ gh, exec: world.exec, repo: REPO }),
      reread: snapshot,
      modeNow: async () => 'act',
      clock: () => T0,
      selfOps: [],
    });
    assert.equal(res.status, 'skipped', change);
    assert.equal(res.reason, { head: 'head_moved', manual: 'manual_removal_after', merged: 'pr_merged' }[change]);
    assert.deepEqual(world.writeCalls(), [], change);
    assert.deepEqual(world.execs, [], change);
  }
});

test('act: the mode flipping to shadow mid-apply stops with partial; the next act tick completes it', async () => {
  const env = setup();
  let reads = 0;
  env.world.mode = () => (++reads === 4 ? 'shadow' : 'act');
  env.world.addPr(101);
  env.world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
  env.world.reAdd(101, iso(T0 - 9 * MIN));
  env.world.addPr(102);
  const later = env.world.removeFailed(102, { at: iso(T0 - 8 * MIN) });
  const s1 = await env.run();
  assert.equal(s1.status, 'partial');
  assert.equal(env.writesOf('disable_auto_merge').length, 1);
  assert.equal(env.writesOf('dequeue').length, 0, 'stopped before the next mutation');
  assert.equal(env.state().seen[later.id], undefined, 'a removal after the flip is left for the next act tick, not consumed in shadow');
  const s2 = await env.run();
  assert.equal(s2.mode, 'act');
  assert.equal(env.writesOf('comment_post', 101).length, 1);
  assert.equal(env.writesOf('dequeue', 101).length, 1);
  assert.equal(env.writesOf('label_add', 101).length, 1);
  assert.equal(env.writesOf('comment_edit', 101).length, 1);
  assert.equal(env.writesOf('label_add', 102).length, 1, 'the removal left over is decided in act');
});

test('an invalid or unreadable mode value means shadow', async () => {
  for (const value of ['ACT', 'yes', ' ', 'act-now']) {
    const world = createWorld({ mode: value });
    const warnings = [];
    assert.equal(await readMode(createGitHub({ token: 't', fetchImpl: world.fetchImpl }), REPO, { warn: (w) => warnings.push(w) }), 'shadow', value);
    assert.equal(warnings.length, 1);
  }
  const broken = createGitHub({ token: 't', fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(await readMode(broken, REPO), 'shadow');
  const env = setup({ mode: 'yes' });
  busyWorld(env);
  const s = await env.run();
  assert.equal(s.mode, 'shadow');
  assert.deepEqual(env.world.writeCalls(), []);
  const off = setup({ mode: 'off' });
  busyWorld(off);
  assert.equal((await off.run()).status, 'off');
  assert.equal(off.world.calls.length, 1, 'off reads the mode and stops');
});

test('a fresh lock exits as locked with no API call; a 15-min-old lock is taken', async () => {
  const env = setup();
  writeFileSync(join(env.stateDir, 'lock'), JSON.stringify({ token: 'other', at: iso(T0 - 14 * MIN) }));
  assert.equal((await env.run()).status, 'locked');
  assert.equal(env.world.calls.length, 0);
  writeFileSync(join(env.stateDir, 'lock'), JSON.stringify({ token: 'other', at: iso(T0 - 15 * MIN) }));
  assert.equal((await env.run()).status, 'ok');
  assert.throws(() => readFileSync(join(env.stateDir, 'lock')), /ENOENT/, 'released');
});

test('hourly budget: 1,450 calls in the trailing hour leave 50; 1,500 leave none', async () => {
  const env = setup();
  writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ calls: [{ at: iso(T0 - 30 * MIN), n: 1450 }, { at: iso(T0 - 61 * MIN), n: 900 }] }));
  const s = await env.run();
  assert.equal(s.budget, 50);
  assert.ok(s.calls <= 50);
  writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ calls: [{ at: iso(T0 - 30 * MIN), n: 1500 }] }));
  const before = env.world.calls.length;
  const spent = await env.run();
  assert.equal(spent.status, 'hourly_budget_spent');
  assert.equal(env.world.calls.length, before);
});

test('budget exceeded mid-tick: the cursor is not advanced past the unprocessed removal', async () => {
  const env = setup();
  for (const [n, off] of [[201, 9], [202, 8], [203, 7]]) {
    env.world.addPr(n);
    env.world.removeFailed(n, { at: iso(T0 - off * MIN) });
  }
  writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ calls: [{ at: iso(T0 - 10 * MIN), n: 1500 - 14 }] }));
  const s1 = await env.run();
  assert.equal(s1.status, 'budget_exceeded');
  const st = env.state();
  const seen = new Set(Object.keys(st.seen));
  const all = [201, 202, 203].map((n) => env.world.prs.get(n).events[0]);
  const unseen = all.filter((e) => !seen.has(e.id));
  assert.ok(unseen.length > 0, 'the budget ran out before every removal was decided');
  for (const e of unseen) assert.ok(Date.parse(e.createdAt) >= Date.parse(st.cursor), `cursor ${st.cursor} passed ${e.createdAt}`);
  // With budget again, the next tick decides the rest, each removal once.
  writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ ...st, calls: [] }));
  await env.run();
  const byRemoval = env.decisions().filter((l) => l.source === 'removal');
  assert.deepEqual(byRemoval.map((l) => l.pr).sort(), [201, 202, 203]);
});

test('sightings ingest runs last on a capped share: a flood of completed runs never starves removals or sweeps', async () => {
  const env = setup();
  busyWorld(env);
  for (let i = 0; i < 60; i++) {
    env.world.runs.push({
      id: 50_000 + i,
      run_attempt: 1,
      head_sha: `${String(i).padStart(4, '0')}${'d'.repeat(36)}`,
      head_branch: `feature-${i}`,
      head_repository: { full_name: REPO },
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
      path: '.github/workflows/ci.yml',
      created_at: iso(T0 - 25 * MIN),
      updated_at: iso(T0 - 20 * MIN + i * 1000),
      pull_requests: [],
      jobs: [{ id: 60_000 + i, name: 'Integration Tests (shard 11/16)', run_attempt: 1, conclusion: 'failure', started_at: iso(T0 - 24 * MIN), completed_at: iso(T0 - 20 * MIN), steps: [{ name: 'Run integration tests', conclusion: 'failure' }], annotations: [], log: null }],
    });
  }
  writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ calls: [{ at: iso(T0 - 30 * MIN), n: 1500 - 200 }] }));
  const s = await env.run();
  assert.equal(s.status, 'ok', JSON.stringify(s.errors));
  assert.equal(s.removals, 5);
  assert.ok(env.decisions().some((l) => l.kind === 'resume'), 'sweeps ran');
  assert.ok(env.decisions().some((l) => l.kind === 'requeue_stuck'), 'sweeps ran');
  assert.ok(s.sweeps.ingestDeferred > 0, 'ingest stopped at its share');
  assert.ok(s.calls <= 200);
  const cursor = env.state().ingestCursor;
  const deferred = env.world.runs.filter((r) => r.event === 'pull_request' && !env.state().ingested[`${r.id}:1`]);
  for (const r of deferred) assert.ok(Date.parse(r.updated_at) > Date.parse(cursor), 'the cursor stays before every deferred run');
  // Later ticks drain the rest.
  for (let k = 0; k < 8; k++) {
    writeFileSync(join(env.stateDir, 'state.json'), JSON.stringify({ ...env.state(), calls: [] }));
    env.world.clock += 5 * MIN;
    await env.run();
  }
  assert.equal(env.world.runs.filter((r) => r.event === 'pull_request' && !env.state().ingested[`${r.id}:1`]).length, 0);
});

test('ci_success_missing sweep: dequeues and enqueues once; counts against the infra budget', async () => {
  const env = setup({ mode: 'act' });
  busyWorld(env);
  await env.run();
  await env.run();
  assert.equal(env.writesOf('dequeue', 107).length, 1);
  assert.equal(env.writesOf('enqueue', 107).length, 1);
  assert.equal(env.writesOf('comment_post', 107).length, 1);

  // The same head already had three failed_checks removals: a stuck entry is the fourth → hold.
  const env2 = setup({ mode: 'act' });
  busyWorld(env2);
  const pr = env2.world.prs.get(107);
  for (const k of [1, 2, 3]) {
    pr.events.unshift({ __typename: 'RemovedFromMergeQueueEvent', id: `OLD${k}`, createdAt: iso(T0 - (5 - k) * 60 * MIN), reason: 'failed_checks', actor: { login: 'operator' }, beforeCommit: { oid: `g${k}` } });
  }
  pr.headPushedAt = iso(T0 - 6 * 60 * MIN);
  await env2.run();
  assert.equal(env2.writesOf('enqueue', 107).length, 0);
  assert.ok(env2.world.prs.get(107).labels.includes(LABELS.hold));
});

test('pending re-add sweep: a record not back 10 min after the removal is enqueued once; one back in the queue is left alone', async () => {
  const env = setup({ mode: 'act' });
  env.world.addPr(301);
  env.world.removeFailed(301, { at: iso(T0 - 5 * MIN), job: RUNNER_LOST });
  env.world.addPr(302);
  env.world.removeFailed(302, { at: iso(T0 - 5 * MIN), job: RUNNER_LOST });
  await env.run();
  assert.equal(env.writesOf('enqueue').length, 0, 'inside the grace period: GitHub re-adds');
  env.world.reAdd(302, iso(T0 - 3 * MIN));
  env.world.clock = T0 + 6 * MIN;
  await env.run();
  env.world.clock = T0 + 11 * MIN;
  await env.run();
  assert.equal(env.writesOf('enqueue', 301).length, 1);
  assert.equal(env.writesOf('enqueue', 302).length, 0);
  const markers = parseMarkers(env.world.prs.get(301).comments, { viewer: 'operator' });
  assert.equal(markers.length, 1, 'the requeue supersedes the record under the same action id');
  assert.equal(markers[0].decision, 'requeue');
  assert.equal(markers[0].status, 'done');
});

test('summarizeVerdict keeps only untouched ids that failed both attempts', () => {
  const facts = {
    run: { id: 9, attempt: 1 },
    jobs: [
      { name: 'A', logAttempts: [{ failures: ['x', 'y'] }, { failures: ['x'] }], report: null },
      { name: 'B', logAttempts: [{ failures: ['z'] }, { failures: ['z'] }], report: null },
    ],
  };
  const verdict = {
    class: 'real',
    jobs: [
      { job: 'A', class: 'unknown', evidence: [] },
      { job: 'B', class: 'real', evidence: ['touched by the PR: z'] },
    ],
    testIds: ['x', 'z'],
  };
  assert.deepEqual(summarizeVerdict(verdict, facts).failedBoth, ['x']);
});

test('probe refuses outside act mode or without the probe label, and runs hold then resume in act', async () => {
  const shadow = createWorld({ mode: 'shadow' });
  shadow.addPr(401, { labels: [LABELS.probe] });
  const r1 = await probe({ gh: createGitHub({ token: 't', fetchImpl: shadow.fetchImpl }), repo: REPO, pr: 401, exec: shadow.exec, stateDir: tmpState(), now: T0, clock: () => T0 });
  assert.equal(r1.status, 'refused');
  assert.deepEqual(shadow.writeCalls(), []);
  const nolabel = createWorld({ mode: 'act' });
  nolabel.addPr(401);
  const r2 = await probe({ gh: createGitHub({ token: 't', fetchImpl: nolabel.fetchImpl }), repo: REPO, pr: 401, exec: nolabel.exec, stateDir: tmpState(), now: T0, clock: () => T0 });
  assert.equal(r2.status, 'refused');
  assert.deepEqual(nolabel.writeCalls(), []);
  const act = createWorld({ mode: 'act' });
  act.addPr(401, { labels: [LABELS.probe], queue: { state: 'QUEUED', position: 1 } });
  const r3 = await probe({ gh: createGitHub({ token: 't', fetchImpl: act.fetchImpl }), repo: REPO, pr: 401, exec: act.exec, stateDir: tmpState(), now: T0, clock: () => T0 });
  assert.equal(r3.status, 'applied', JSON.stringify(r3));
  assert.deepEqual(
    act.writes.map((w) => w.op),
    ['comment_post', 'disable_auto_merge', 'dequeue', 'label_add', 'comment_edit', 'comment_post', 'label_remove', 'enqueue', 'comment_edit'],
  );
});

test('CLI: tick runs one shadow tick through main; probe without --pr exits 2 before any call', async () => {
  const { main } = await import('./shepherd.mjs');
  const env = setup();
  busyWorld(env);
  const lines = [];
  const code = await main(['tick', '--state-dir', env.stateDir], { makeGitHub: () => env.gh, exec: env.world.exec, now: () => T0, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.match(lines.at(-1), /^ci-shepherd tick status=ok mode=shadow removals=5 /);
  assert.deepEqual(env.world.writeCalls(), []);
  let made = 0;
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['probe'], { makeGitHub: () => made++ }), 2);
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(made, 0);
});

// ── Review follow-ups ────────────────────────────────────────────────────

const holdWorld = (env, n = 101) => {
  env.world.addPr(n);
  const r = env.world.removeFailed(n, { at: iso(T0 - 10 * MIN) });
  env.world.reAdd(n, iso(T0 - 9 * MIN));
  return r;
};

test('act: a crash after a successful dequeue resumes, not skipped as a human removal', async () => {
  const env = setup({ mode: 'act' });
  holdWorld(env);
  env.world.failOnce('label_add');
  await env.run();
  assert.equal(env.writesOf('dequeue').length, 1);
  assert.equal(env.writesOf('label_add').length, 0);
  // GitHub logged the dequeue as a manual removal, stamped 30 s before the
  // shepherd's own clock (server skew): still the shepherd's own.
  const ev = env.world.prs.get(101).events.at(-1);
  assert.equal(ev.reason, 'manual');
  ev.createdAt = iso(T0 - 30_000);
  await env.run();
  assert.equal(env.writesOf('label_add').length, 1);
  assert.equal(env.writesOf('comment_post').length, 1);
  assert.equal(parseMarkers(env.world.prs.get(101).comments, { viewer: 'operator' })[0].status, 'done');
});

test('a marker on the second page of comments is found: no duplicate comment', async () => {
  const env = setup({ mode: 'act' });
  holdWorld(env);
  const pr = env.world.prs.get(101);
  for (let i = 0; i < 150; i++) pr.comments.push({ id: 90_000 + i, author: 'someone', body: `comment ${i}` });
  env.world.failOnce('dequeue');
  await env.run();
  assert.ok(pr.comments.findIndex((c) => c.author === 'operator') >= 100, 'the marker sits on page 2');
  await env.run();
  assert.equal(env.writesOf('comment_post').length, 1);
  assert.equal(env.writesOf('dequeue').length, 1);
});

test('shadow then act: a resume label seen in shadow is still applied once act starts', async () => {
  const env = setup({ mode: 'shadow' });
  env.world.addPr(106, { labels: [LABELS.hold, LABELS.resume], autoMerge: false });
  await env.run();
  assert.ok(env.decisions().some((l) => l.kind === 'resume' && l.status === 'shadow'));
  env.world.mode = 'act';
  env.world.clock += 5 * MIN;
  await env.run();
  assert.equal(env.writesOf('label_remove', 106).length, 2, 'hold and resume labels removed');
  assert.equal(env.writesOf('enqueue', 106).length, 1);
  assert.deepEqual(env.world.prs.get(106).labels, []);
});

test('act: outage backs off the third PR; a breaker that expires inside a later removal still restores it', async () => {
  const env = setup({ mode: 'act' });
  for (const [n, off] of [[103, 8], [104, 7], [105, 6]]) {
    env.world.addPr(n);
    env.world.removeFailed(n, { at: iso(T0 - off * MIN), job: RUNNER_LOST });
  }
  await env.run();
  const pr = env.world.prs.get(105);
  assert.ok(pr.labels.includes(LABELS.backoff));
  assert.equal(pr.autoMerge, false);
  // 25 min later a real failure on another PR is decided first in the tick:
  // its breaker update expires the outage. The parked PR is restored anyway.
  env.world.clock = T0 + 25 * MIN;
  env.world.addPr(110);
  env.world.removeFailed(110, { at: iso(T0 + 24 * MIN) });
  await env.run();
  assert.equal(env.writesOf('enqueue', 105).length, 1);
  assert.ok(!pr.labels.includes(LABELS.backoff));
  assert.equal(env.state().clearedBreakers.length, 0);
});

test('apply: a newer removal supersedes the decision; skipped with no write', async () => {
  const world = createWorld({ mode: 'act', now: T0 });
  const gh = createGitHub({ token: 't', fetchImpl: world.fetchImpl });
  world.addPr(101);
  const r = world.removeFailed(101, { at: iso(T0 - 10 * MIN) });
  const snapshot = async (pr) => {
    const s = await prSnapshot(gh, { repo: REPO, pr, withFiles: false });
    return { ...s, headPushedAt: await headPushedAt(gh, { repo: REPO, headSha: s.headSha }) };
  };
  const d = decide({ removal: { pr: 101, id: r.id, at: r.at, reason: 'failed_checks' }, snapshot: await snapshot(101), verdict: { class: 'unknown', run: r.runId, attempt: 1 }, now: T0 });
  world.removeFailed(101, { at: iso(T0 - 2 * MIN) });
  const res = await apply(gh, d, { mode: 'act', repo: REPO, viewer: 'operator', writer: createWriter({ gh, exec: world.exec, repo: REPO }), reread: snapshot, modeNow: async () => 'act', clock: () => T0, selfOps: [] });
  assert.deepEqual(res, { status: 'skipped', reason: 'newer_removal' });
  assert.deepEqual(world.writeCalls(), []);
  assert.deepEqual(world.execs, []);
});

test('act: a pending decision that keeps failing is abandoned after 5 tries, with a decisions.jsonl line', async () => {
  const env = setup({ mode: 'act' });
  holdWorld(env);
  for (let i = 0; i < 10; i++) env.world.failOnce('comment_post');
  for (let i = 0; i < 6; i++) {
    await env.run();
    env.world.clock += MIN;
  }
  assert.equal(env.state().pending.length, 0);
  const abandoned = env.decisions().filter((l) => l.status === 'abandoned');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].pr, 101);
  assert.equal(env.decisions().filter((l) => l.status === 'error').length, 5);
});

test('act: a stuck re-queue whose enqueue failed after the dequeue is completed by the next tick', async () => {
  const env = setup({ mode: 'act' });
  stuckPr(env);
  env.world.failOnce('enqueue');
  await env.run();
  assert.equal(env.writesOf('dequeue', 107).length, 1);
  assert.equal(env.writesOf('enqueue', 107).length, 0);
  await env.run();
  assert.equal(env.writesOf('enqueue', 107).length, 1);
  assert.equal(env.writesOf('comment_post', 107).length, 1);
});

test('act: a held PR that gets a new head loses its shepherd labels', async () => {
  const env = setup({ mode: 'act' });
  holdWorld(env);
  await env.run();
  const pr = env.world.prs.get(101);
  assert.deepEqual(pr.labels, [LABELS.hold]);
  Object.assign(pr, { headSha: 'e'.repeat(40), headPushedAt: iso(T0 + MIN) });
  env.world.clock = T0 + 5 * MIN;
  await env.run();
  assert.deepEqual(pr.labels, []);
  assert.ok(parseMarkers(pr.comments, { viewer: 'operator' }).some((m) => m.decision === 'resume_new_head' && m.status === 'done'));
  assert.equal(env.state().parked.length, 0);
});

test('ingest skips fork runs: no sightings, no evidence read', async () => {
  const env = setup();
  env.world.runs.push({
    id: 8008,
    run_attempt: 1,
    head_sha: 'f0'.repeat(20),
    head_branch: 'fork-branch',
    head_repository: { full_name: 'someone/breeze' },
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    path: '.github/workflows/ci.yml',
    created_at: iso(T0 - 20 * MIN),
    updated_at: iso(T0 - 15 * MIN),
    pull_requests: [],
    jobs: [{ id: 80081, name: 'Integration Tests (shard 11/16)', run_attempt: 1, conclusion: 'failure', started_at: iso(T0 - 19 * MIN), completed_at: iso(T0 - 15 * MIN), steps: [], annotations: [], log: 'FAIL src/a.test.ts > a > b' }],
  });
  const s = await env.run();
  assert.equal(s.sweeps.ingested ?? 0, 0);
  assert.ok(!env.world.calls.some((c) => /\/actions\/runs\/8008/.test(c.path)), 'the fork run was never read');
});

test('a failing sweep is reported and the others still run; a failing tick reports status=error as its last line', async () => {
  const env = setup();
  busyWorld(env);
  env.world.failingGets.push([/\/issues\?labels=ci-shepherd%3Aresume/, 500]);
  const s = await env.run();
  assert.equal(s.status, 'degraded');
  assert.ok(s.errors.some((e) => /resume label/.test(e)));
  assert.ok(env.decisions().some((l) => l.kind === 'requeue_stuck'), 'the stuck sweep ran');
  assert.ok(s.sweeps.ingested > 0, 'ingest ran');

  const env2 = setup();
  busyWorld(env2);
  env2.world.failRemovals = true;
  const lines = [];
  const s2 = await env2.run({ log: (l) => lines.push(l) });
  assert.equal(s2.status, 'error');
  assert.match(lines.at(-1), /^ci-shepherd tick status=error .*first_error="tick failed: /);
  const { main } = await import('./shepherd.mjs');
  assert.equal(await main(['tick', '--state-dir', env2.stateDir], { makeGitHub: () => env2.gh, exec: env2.world.exec, now: () => T0, log: () => {} }), 1);
});

test('an unreadable mode variable consumes nothing: status mode_unreadable', async () => {
  const env = setup({ mode: 'HTTP_500' });
  busyWorld(env);
  const s = await env.run();
  assert.equal(s.status, 'mode_unreadable');
  assert.deepEqual(env.state().seen, {});
  assert.equal(env.decisions().length, 0);
});

test('a corrupt state.json is kept aside and reported', async () => {
  const env = setup();
  writeFileSync(join(env.stateDir, 'state.json'), '{"cursor": ');
  const s = await env.run();
  assert.equal(s.status, 'degraded');
  assert.ok(s.errors.some((e) => /state\.json did not parse/.test(e)));
});

test('writer: issue upsert reuses an open issue with the same title; the main CI dispatch is one gh call', async () => {
  const world = createWorld({ mode: 'act' });
  const w = createWriter({ gh: createGitHub({ token: 't', fetchImpl: world.fetchImpl }), exec: world.exec, repo: REPO });
  const a = await w.issueUpsert({ title: 'Queue blocked: x fails on main', body: 'b', labels: ['ci-red'] });
  const b = await w.issueUpsert({ title: 'Queue blocked: x fails on main', body: 'b', labels: ['ci-red'] });
  assert.equal(a, b);
  assert.equal(world.writes.filter((x) => x.op === 'issue_create').length, 1);
  await w.dispatchMainCi();
  assert.deepEqual(world.execs.at(-1), ['workflow', 'run', 'CI', '--ref', 'main', '-R', REPO]);
});
