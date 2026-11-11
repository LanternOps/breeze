import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { breakerDecisions, emptyBreakerState, parkInBreaker, updateBreakers } from './breakers.mjs';
import { classifyRun } from './classify.mjs';
import { HOLD_CLASSES, LABELS, LIMITS, MAX_REMOVALS, decide, pageFor, removalsOfHead, restoreDecision, staleReasons, summarizeVerdict } from './decide.mjs';
import { History } from './evidence.mjs';
import { requiredJobIds } from './facts.mjs';
import { REPO_ROOT } from './shepherd.mjs';

// Per-head budgets, holds and circuit breakers (W06b B2, #10750). Pure: every
// test injects `now`.

const ciYml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const requiredJobs = requiredJobIds(ciYml);
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const HEAD = 'c5e2ad9f00000000000000000000000000000000';

const removal = (id, at, over = {}) => ({ pr: 11312, id, at, reason: 'failed_checks', actor: 'operator', beforeCommit: `group-${id}`, ...over });
const removedEv = (r) => ({ type: 'removed', id: r.id, at: r.at, actor: r.actor, reason: r.reason, beforeCommit: r.beforeCommit });
const addedEv = (id, at) => ({ type: 'added', id, at, actor: 'operator' });

function snap(over = {}) {
  return {
    pr: 11312,
    id: 'PR_node',
    state: 'OPEN',
    headSha: HEAD,
    headPushedAt: '2026-11-08T05:00:00Z',
    isFork: false,
    autoMerge: true,
    queue: null,
    labels: [],
    files: [],
    events: [],
    ...over,
  };
}

const verdict = (cls, over = {}) => ({ class: cls, signature: null, testIds: [], failedBoth: [], run: 1, attempt: 1, ...over });
const ops = (d) => d.mutations.map((m) => m.op);

// Classify a recorded fixture and summarize it the way tick.mjs does.
function fixtureVerdict(name, removalAt) {
  const fx = fixture(name);
  const v = classifyRun(fx.facts, { prFiles: new Set(fx.prFiles), history: History.fromSightings([]), repoRoot: REPO_ROOT, pr: fx.source.pr, now: Date.parse(removalAt), requiredJobs });
  return summarizeVerdict(v, fx.facts);
}

test('limits are the plan values', () => {
  assert.deepEqual(LIMITS, { infra: 3, known_flake: 3, suspected_flake: 2, timeout: 1, unknown: 1, real: 0, gate_fault: 0, thin_fault: 0 });
  assert.equal(MAX_REMOVALS, 3);
  assert.deepEqual([...HOLD_CLASSES].sort(), ['gate_fault', 'real', 'thin_fault']);
});

// W05 (#10749): a thin-queue selection fault is never re-queued. It holds on the
// first removal, whatever the auto-merge state, the queue or an open breaker, and
// it pages: the operator decides whether the thin queue stays on.
test('thin_fault holds at once, before auto-merge or a breaker can re-add it, and pages', () => {
  const r = removal('R1', '2026-11-08T06:03:00Z');
  const thinVerdict = verdict('thin_fault', { signature: 'thin_skip_unjustified', testIds: ['shared-1'], failedBoth: ['shared-1'] });
  const breakers = [{ kind: 'main_broken', status: 'confirmed', key: 'shared-1' }];
  for (const s of [snap({ events: [removedEv(r)] }), snap({ events: [removedEv(r)], queue: { state: 'QUEUED', position: 1 } }), snap({ events: [removedEv(r)], autoMerge: false })]) {
    const d = decide({ removal: r, snapshot: s, verdict: thinVerdict, breakers, now: Date.parse(r.at) + MIN });
    assert.deepEqual([d.kind, d.holdReason, d.limit], ['hold', 'thin_fault', 0]);
    assert.ok(!ops(d).includes('enqueue'));
    assert.match(pageFor(d), /^PAGE thin_skip_unjustified: PR 11312 /);
    assert.match(pageFor(d), /gh variable set CI_THIN_QUEUE --body off/);
  }
  const lost = decide({ removal: r, snapshot: snap({ events: [removedEv(r)] }), verdict: verdict('thin_fault', { signature: 'attempt1_selection_missing' }), now: Date.parse(r.at) + MIN });
  assert.equal(lost.holdReason, 'thin_fault');
  assert.match(pageFor(lost), /^PAGE attempt1_selection_missing: PR 11312 /);
  assert.doesNotMatch(pageFor(lost), /--body off/, 'a lost attempt-1 list is not a consumer bug');
  // Nothing else pages, and a stale removal does not either.
  assert.equal(pageFor(decide({ removal: r, snapshot: snap({ events: [removedEv(r)] }), verdict: verdict('real'), now: Date.parse(r.at) + MIN })), null);
  assert.equal(pageFor(decide({ removal: r, snapshot: snap({ events: [removedEv(r)], state: 'CLOSED' }), verdict: thinVerdict, now: Date.parse(r.at) + MIN })), null);
});

test('#11312 sequence: three re-adds are recorded, the fourth removal of the head is held (Review Focus 5)', () => {
  const r1 = removal('R1', '2026-11-08T06:03:00Z');
  const r2 = removal('R2', '2026-11-08T07:08:00Z');
  const r3 = removal('R3', '2026-11-08T08:10:00Z');
  const r4 = removal('R4', '2026-11-08T09:12:00Z');
  const evs = [];
  const step = (r, v, queued) => {
    evs.push(removedEv(r));
    if (queued) evs.push(addedEv(`A-${r.id}`, iso(Date.parse(r.at) + MIN)));
    return decide({ removal: r, snapshot: snap({ events: [...evs], queue: queued ? { state: 'QUEUED', position: 1 } : null }), verdict: v, now: Date.parse(r.at) + 2 * MIN });
  };
  const d1 = step(r1, fixtureVerdict('11312-web3-disjoint', r1.at), true);
  assert.equal(d1.kind, 'record');
  assert.equal(d1.n, 1);
  assert.equal(d1.class, 'suspected_flake');
  assert.deepEqual(ops(d1), ['comment']);
  const d2 = step(r2, fixtureVerdict('11312-runner-lost', r2.at), true);
  assert.equal(d2.kind, 'record');
  assert.equal(d2.n, 2);
  assert.equal(d2.signature, 'runner_lost');
  const d3 = step(r3, verdict('infra', { signature: 'runner_lost' }), true);
  assert.equal(d3.kind, 'record');
  assert.equal(d3.n, 3);
  const d4 = step(r4, verdict('infra', { signature: 'runner_lost' }), true);
  assert.equal(d4.kind, 'hold');
  assert.equal(d4.holdReason, 'retry_exhausted');
  assert.equal(d4.n, 4);
  assert.deepEqual(ops(d4), ['disable_auto_merge', 'dequeue', 'label_add', 'comment']);
  assert.equal(d4.mutations[2].args.name, LABELS.hold);
});

test('real holds in order; gate_fault holds too', () => {
  const r = removal('R1', '2026-11-08T06:03:00Z');
  const s = snap({ events: [removedEv(r)], queue: { state: 'QUEUED', position: 2 } });
  const d = decide({ removal: r, snapshot: s, verdict: verdict('real'), now: Date.parse(r.at) + MIN });
  assert.equal(d.kind, 'hold');
  assert.equal(d.holdReason, 'real');
  assert.deepEqual(ops(d), ['disable_auto_merge', 'dequeue', 'label_add', 'comment']);
  const g = decide({ removal: r, snapshot: snap({ events: [removedEv(r)], autoMerge: false }), verdict: verdict('gate_fault'), now: Date.parse(r.at) + MIN });
  assert.equal(g.holdReason, 'gate_fault');
  assert.deepEqual(ops(g), ['label_add', 'comment'], 'nothing to disable or dequeue');
});

test('noop: a later manual removal, a moved head, a merged or closed PR, the ignore label, a fork, another reason', () => {
  const r = removal('R1', '2026-11-08T06:03:00Z');
  const now = Date.parse(r.at) + MIN;
  const base = [removedEv(r)];
  const noop = (s, rr = r, selfOps = []) => decide({ removal: rr, snapshot: s, verdict: verdict('infra', { signature: 'runner_lost' }), now, selfOps });
  const manual = { type: 'removed', id: 'M', at: '2026-11-08T06:10:00Z', actor: 'operator', reason: 'manual' };
  assert.deepEqual(noop(snap({ events: [...base, manual] })).reasons, ['manual_removal_after']);
  assert.equal(noop(snap({ events: [...base, manual] })).kind, 'noop');
  // The shepherd's own dequeue is a manual removal by the operator login too; it is not human intent.
  const self = [{ pr: 11312, op: 'dequeue', at: '2026-11-08T06:09:30Z' }];
  assert.notEqual(noop(snap({ events: [...base, manual] }), r, self).kind, 'noop');
  assert.deepEqual(noop(snap({ events: base, headPushedAt: '2026-11-08T06:05:00Z' })).reasons, ['head_moved']);
  assert.deepEqual(noop(snap({ events: base, state: 'MERGED' })).reasons, ['pr_merged']);
  assert.deepEqual(noop(snap({ events: base, state: 'CLOSED' })).reasons, ['pr_closed']);
  assert.deepEqual(noop(snap({ events: base, labels: [LABELS.ignore] })).reasons, ['ignore_label']);
  assert.deepEqual(noop(snap({ events: base, isFork: true })).reasons, ['fork']);
  assert.deepEqual(noop(snap({ events: base }), removal('R1', r.at, { reason: 'manual' })).reasons, ['not_failed_checks']);
  assert.deepEqual(staleReasons(r, snap({ events: base }), {}), []);
  // Six hours on, a removal is history: the runner was off or behind.
  assert.deepEqual(decide({ removal: r, snapshot: snap({ events: base }), verdict: verdict('unknown'), now: Date.parse(r.at) + 6 * 3600_000 }).kind, 'requeue');
  assert.deepEqual(decide({ removal: r, snapshot: snap({ events: base }), verdict: verdict('unknown'), now: Date.parse(r.at) + 6 * 3600_000 + 1 }).reasons, ['removal_too_old']);
});

test('unknown re-queues once, then holds', () => {
  const r1 = removal('R1', '2026-11-08T06:00:00Z');
  const r2 = removal('R2', '2026-11-08T07:00:00Z');
  const d1 = decide({ removal: r1, snapshot: snap({ events: [removedEv(r1)], autoMerge: false }), verdict: verdict('unknown'), now: Date.parse(r1.at) + MIN });
  assert.equal(d1.kind, 'requeue');
  assert.deepEqual(ops(d1), ['enqueue', 'comment']);
  const d1b = decide({ removal: r1, snapshot: snap({ events: [removedEv(r1)], autoMerge: true }), verdict: verdict('unknown'), now: Date.parse(r1.at) + MIN });
  assert.equal(d1b.kind, 'record', 'auto-merge on, inside 10 min: GitHub will re-add it');
  const d2 = decide({ removal: r2, snapshot: snap({ events: [removedEv(r1), removedEv(r2)] }), verdict: verdict('unknown'), now: Date.parse(r2.at) + MIN });
  assert.equal(d2.kind, 'hold');
  assert.equal(d2.holdReason, 'retry_exhausted');
});

test('removals of an earlier head do not count against a new head', () => {
  const r0 = removal('R0', '2026-11-08T04:00:00Z');
  const r1 = removal('R1', '2026-11-08T06:00:00Z');
  const s = snap({ events: [removedEv(r0), removedEv(r1)], headPushedAt: '2026-11-08T05:00:00Z' });
  assert.deepEqual(removalsOfHead(s, r1).map((e) => e.id), ['R1']);
  // Head push time unknown: every removal in the window counts (the conservative side).
  const unknown = snap({ events: [removedEv(r0), removedEv(r1)], headPushedAt: null });
  assert.deepEqual(removalsOfHead(unknown, r1).map((e) => e.id), ['R0', 'R1']);
  assert.ok(decide({ removal: r1, snapshot: unknown, verdict: verdict('unknown'), now: Date.parse(r1.at) }).reasons.includes('head_push_time_unknown'));
});

test('the same test failing both attempts in two removals of one head → hold, even as known_flake', () => {
  const id = 'src/a.test.ts > a > b';
  const r1 = removal('R1', '2026-11-08T06:00:00Z');
  const r2 = removal('R2', '2026-11-08T07:00:00Z');
  const prior = [{ pr: 11312, head: HEAD, removalId: 'R1', failedBoth: [id] }];
  const d = decide({
    removal: r2,
    snapshot: snap({ events: [removedEv(r1), removedEv(r2)] }),
    verdict: verdict('known_flake', { failedBoth: [id], testIds: [id] }),
    priorVerdicts: prior,
    now: Date.parse(r2.at) + MIN,
  });
  assert.equal(d.kind, 'hold');
  assert.equal(d.holdReason, 'retry_exhausted');
  assert.ok(d.reasons.some((x) => x.startsWith('failed both attempts twice')));
  // A prior verdict of another head does not count.
  const other = decide({
    removal: r2,
    snapshot: snap({ events: [removedEv(r1), removedEv(r2)] }),
    verdict: verdict('known_flake', { failedBoth: [id], testIds: [id] }),
    priorVerdicts: [{ ...prior[0], head: 'ffff' }],
    now: Date.parse(r2.at) + MIN,
  });
  assert.equal(other.kind, 'record');
});

test('not re-added 10 min after the removal with auto-merge on → requeue with enqueue', () => {
  const r = removal('R1', '2026-11-08T06:00:00Z');
  const d = decide({ removal: r, snapshot: snap({ events: [removedEv(r)], autoMerge: true }), verdict: verdict('infra', { signature: 'runner_lost' }), now: Date.parse(r.at) + 10 * MIN });
  assert.equal(d.kind, 'requeue');
  assert.deepEqual(ops(d), ['enqueue', 'comment']);
});

test('osv burst: the third PR opens the outage breaker, later removals back off, and it clears 20 min after the last match (Review Focus 4)', () => {
  // Removal order (the run's updatedAt is when the queue removed the entry).
  const names = ['osv-504-1', 'osv-504-2', 'osv-504-3', 'osv-504-4', 'osv-504-5', 'osv-504-6', 'osv-504-7']
    .map((n) => ({ n, fx: fixture(n) }))
    .sort((a, b) => Date.parse(a.fx.facts.run.updatedAt) - Date.parse(b.fx.facts.run.updatedAt));
  let state = emptyBreakerState();
  const kinds = [];
  const opened = [];
  let lastAt = 0;
  for (const [i, { n, fx }] of names.entries()) {
    const at = fx.facts.run.updatedAt;
    const r = removal(`R${i}`, at, { pr: fx.source.pr });
    const v = { ...fixtureVerdict(n, at), pr: fx.source.pr, at };
    assert.equal(v.class, 'infra', n);
    assert.equal(v.signature, 'download_5xx', n);
    const now = Date.parse(at) + MIN;
    const up = updateBreakers(state, { verdicts: [v] }, now);
    state = up.state;
    opened.push(...up.opened);
    const d = decide({
      removal: r,
      snapshot: snap({ pr: fx.source.pr, headSha: fx.facts.run.headSha.padEnd(40, '0'), events: [removedEv(r)], autoMerge: true }),
      verdict: v,
      breakers: state.breakers,
      now,
    });
    if (d.kind === 'backoff') state = parkInBreaker(state, d);
    kinds.push(d.kind);
    lastAt = now;
  }
  assert.deepEqual(kinds, ['record', 'record', 'backoff', 'backoff', 'backoff', 'backoff', 'backoff']);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].kind, 'outage');
  assert.equal(opened[0].key, 'download_5xx');
  const outage = state.breakers[0];
  // Each match extends the window to 20 min after that removal.
  const lastRemoval = lastAt - MIN;
  assert.equal(outage.until, iso(lastRemoval + 20 * MIN), 'each match extends the window');
  assert.equal(outage.restore.length, 5);

  // Still inside the window: nothing clears.
  assert.equal(updateBreakers(state, {}, lastRemoval + 19 * MIN).cleared.length, 0);
  const done = updateBreakers(state, {}, lastRemoval + 20 * MIN);
  assert.equal(done.cleared.length, 1);
  assert.equal(done.state.breakers.length, 0);
  const restores = done.cleared[0].restore.map((e) =>
    restoreDecision(e, snap({ pr: e.pr, headSha: e.head, autoMerge: false, labels: [LABELS.backoff] }), done.cleared[0], lastAt + 20 * MIN),
  );
  assert.equal(restores.length, 5);
  for (const d of restores) assert.deepEqual(ops(d), ['enable_auto_merge', 'label_remove', 'comment']);
  // A parked PR whose head moved, or that merged, is not restored.
  const e = done.cleared[0].restore[0];
  assert.equal(restoreDecision(e, snap({ pr: e.pr, headSha: 'f'.repeat(40) }), done.cleared[0], lastAt).kind, 'noop');
  assert.equal(restoreDecision(e, snap({ pr: e.pr, headSha: e.head, state: 'MERGED' }), done.cleared[0], lastAt).kind, 'noop');
});

test('date bomb: three PRs → suspected with one main CI dispatch across ticks; main fails → confirmed + one issue; a green queue run → cleared', () => {
  let state = emptyBreakerState();
  const all = [];
  const verdicts = ['date-bomb-1', 'date-bomb-2', 'date-bomb-3'].map((n) => {
    const fx = fixture(n);
    return { ...fixtureVerdict(n, fx.facts.run.updatedAt), pr: fx.source.pr, at: fx.facts.run.updatedAt };
  });
  for (const v of verdicts) assert.equal(v.failedBoth.length, 1, 'one untouched test failed both attempts');
  const id = verdicts[0].failedBoth[0];
  assert.match(id, /threatDetectionEvidence/);
  let now = Date.parse(verdicts[2].at) + MIN;
  for (const v of verdicts) {
    const up = updateBreakers(state, { verdicts: [v] }, now);
    state = up.state;
    all.push(...breakerDecisions(up, now));
  }
  // The next tick sees a fourth PR on the same test: still one dispatch.
  const up2 = updateBreakers(state, { verdicts: [{ ...verdicts[0], pr: 4242, removalId: 'X' }] }, now + 5 * MIN);
  state = up2.state;
  all.push(...breakerDecisions(up2, now + 5 * MIN));
  const dispatches = all.filter((d) => d.mutations.some((m) => m.op === 'dispatch_main_ci'));
  assert.equal(dispatches.length, 1);
  const mb = state.breakers.find((b) => b.kind === 'main_broken');
  assert.equal(mb.status, 'suspected');
  assert.equal(mb.key, id);

  // A removal of a fourth PR on that test waits for main.
  const r = removal('R9', iso(now + 6 * MIN), { pr: 4243 });
  const wait = decide({ removal: r, snapshot: snap({ pr: 4243, headPushedAt: '2026-10-31T00:00:00Z', events: [removedEv(r)] }), verdict: { ...verdicts[0], pr: 4243 }, breakers: state.breakers, now: now + 6 * MIN });
  assert.equal(wait.kind, 'wait_main');
  assert.ok(ops(wait).includes('label_add'));
  assert.equal(wait.mutations.find((m) => m.op === 'label_add').args.name, LABELS.waitMain);

  // An older main run (before the breaker opened) says nothing.
  now += 30 * MIN;
  const stale = updateBreakers(state, { mainRuns: [{ run: 1, at: iso(Date.parse(mb.openedAt) - MIN), completed: true, failedIds: [] }] }, now);
  assert.equal(stale.state.breakers.find((b) => b.kind === 'main_broken').status, 'suspected');
  const conf = updateBreakers(state, { mainRuns: [{ run: 77, at: iso(Date.parse(mb.openedAt) + MIN), completed: true, failedIds: [id] }] }, now);
  state = conf.state;
  assert.equal(conf.confirmed.length, 1);
  const issues = breakerDecisions(conf, now).filter((d) => d.mutations.some((m) => m.op === 'issue_upsert'));
  assert.equal(issues.length, 1);
  const up = issues[0].mutations.find((m) => m.op === 'issue_upsert').args;
  // The real id quotes an issue number; posted text never references one.
  assert.equal(up.title, `Queue blocked: ${id.replace(/#(?=\d)/g, 'no. ')} fails on main`.slice(0, 250));
  assert.doesNotMatch(up.title + up.body, /#\d|@\w/);
  assert.deepEqual(up.labels, ['ci-red']);
  // A second tick does not upsert again.
  assert.equal(breakerDecisions(updateBreakers(state, {}, now + MIN), now + MIN).length, 0);

  // A queue run that quarantined the id does not clear it; a clean one does.
  const q = updateBreakers(state, { queuePasses: [{ run: 80, at: iso(now + 2 * MIN), quarantined: [id] }] }, now + 3 * MIN);
  assert.equal(q.cleared.length, 0);
  const clear = updateBreakers(state, { queuePasses: [{ run: 81, at: iso(now + 2 * MIN), quarantined: [] }] }, now + 3 * MIN);
  assert.equal(clear.cleared.length, 1);
  assert.equal(clear.state.breakers.length, 0);
});

test('a suspected main_broken whose main run passed the test clears', () => {
  let state = emptyBreakerState();
  const now = Date.parse('2026-11-01T03:00:00Z');
  for (const pr of [1, 2, 3]) state = updateBreakers(state, { verdicts: [verdict('unknown', { pr, at: iso(now - pr * MIN), failedBoth: ['t'], testIds: ['t'] })] }, now).state;
  assert.equal(state.breakers[0].status, 'suspected');
  const up = updateBreakers(state, { mainRuns: [{ run: 5, at: iso(now + MIN), completed: true, failedIds: ['other'] }] }, now + 30 * MIN);
  assert.equal(up.cleared.length, 1);
  assert.equal(up.cleared[0].why, 'main_passed');
});

test('two PRs, or three PRs spread over more than the window, open nothing', () => {
  const t0 = Date.parse('2026-11-08T08:00:00Z');
  let state = emptyBreakerState();
  for (const [pr, off] of [[1, 0], [2, 30], [3, 61]]) {
    state = updateBreakers(state, { verdicts: [verdict('infra', { signature: 'dns', pr, at: iso(t0 + off * MIN) })] }, t0 + off * MIN).state;
  }
  assert.equal(state.breakers.length, 0);
  // Real failures never feed main_broken, whatever failed both attempts.
  for (const pr of [1, 2, 3]) state = updateBreakers(state, { verdicts: [verdict('real', { pr, at: iso(t0), failedBoth: ['t'] })] }, t0).state;
  assert.equal(state.breakers.length, 0);
});
