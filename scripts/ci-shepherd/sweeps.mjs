// The tick's sweeps (W06b B3, #10750). Each takes the tick context `t`
// (tick.mjs): `t.gh` (read-only outside act mode), `t.repo`, `t.now`,
// `t.mode`, `t.state`, `t.snapshot(pr)`, `t.act(decision, source)`,
// `t.track(decision)`, `t.error(message)`, and, for ingest, `t.ciYml`,
// `t.repoRoot`, `t.sightingsPath`.
//
// Book-keeping that suppresses a repeat ("this resume was handled", "this
// stuck run was re-queued") is keyed by mode and set only once the decision
// was applied, skipped as stale, or recorded in shadow. So a shadow tick never
// uses up the act tick that follows a switch to act, and a failed write is
// tried again. One item failing (other than the API budget) is reported and
// does not stop the rest of its sweep.
import { breakerDecisions, setBreakerIssue, updateBreakers } from './breakers.mjs';
import { LABELS, decide, newHeadDecision, restoreDecision, resumeDecision, stuckDecision, READD_GRACE_MS } from './decide.mjs';
import { attemptsOf, ingestRun } from './evidence.mjs';
import { groupRunBySha, jobNames, mergeQueueEntries, runFacts } from './facts.mjs';
import { appendJsonl } from './state.mjs';

const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const STUCK_MIN_AGE_MS = 10 * 60_000;
export const STUCK_SETTLE_MS = 2 * 60_000;
const RECORD_MAX_AGE_MS = 24 * 3600_000;
const PARKED_MAX_AGE_MS = 14 * 86_400_000;
const INGEST_LOOKBACK_MS = 6 * 3600_000;
const INGEST_PAGES = 3;
// Calls one run's facts can take when only retry-shard jobs are read: the run,
// its jobs, the artifact list, and a few reports, annotations and logs.
export const INGEST_RUN_RESERVE = 12;

// The decision reached a final state for this mode.
export const settled = (res) => res.status === 'applied' || res.status === 'skipped' || res.status === 'shadow';
const doneKey = (t, id) => `${t.mode}:${id}`;

const dropPark = (t, pr) => {
  t.state.parked = t.state.parked.filter((p) => p.pr !== pr);
};

// Per-item isolation: an item's error is reported and the sweep goes on; the
// API budget stops it. `fn(item)` returns true to keep the item in `list`'s
// successor (items not reached, or that failed, are kept too).
async function sweepList(t, what, list, fn) {
  const keep = [];
  for (const [i, item] of list.entries()) {
    try {
      if (await fn(item)) keep.push(item);
    } catch (e) {
      keep.push(item);
      if (e.name === 'BudgetExceeded') {
        keep.push(...list.slice(i + 1));
        e.kept = keep;
        throw e;
      }
      t.error(`${what}: ${e.message}`);
    }
  }
  return keep;
}

async function keepOnBudget(promise, assign) {
  try {
    assign(await promise);
  } catch (e) {
    if (e.kept) assign(e.kept);
    throw e;
  }
}

// Breaker-level decisions run once each per mode; an issue upsert remembers
// its issue (the breaker then also clears when a human closes it).
export async function actOnBreakers(t, up) {
  for (const d of breakerDecisions(up, t.now)) {
    if (t.state.done[doneKey(t, d.actionId)]) continue;
    const res = await t.act(d, 'breaker');
    if (settled(res)) t.state.done[doneKey(t, d.actionId)] = iso(t.now);
    if (res.issue) t.state.breakers = setBreakerIssue(t.state.breakers, d.breaker.key, res.issue);
  }
}

// Restore every PR a cleared breaker parked. Cleared breakers wait in
// `state.clearedBreakers` (saved) until each restore has settled, wherever
// they cleared (the breaker sweep, or a removal's breaker update).
export async function restoreCleared(t) {
  const out = [];
  const list = t.state.clearedBreakers ?? [];
  for (const [i, b] of list.entries()) {
    try {
      const left = await sweepList(t, `restore after ${b.kind} ${b.key}`, b.restore, async (entry) => {
        const res = await t.act(restoreDecision(entry, await t.snapshot(entry.pr), b, t.now), 'sweep:restore');
        if (!settled(res)) return true;
        if (t.mode === 'act') dropPark(t, entry.pr);
        return false;
      });
      if (left.length) out.push({ ...b, restore: left });
    } catch (e) {
      out.push({ ...b, restore: e.kept ?? b.restore }, ...list.slice(i + 1));
      t.state.clearedBreakers = out;
      throw e;
    }
  }
  t.state.clearedBreakers = out;
}

// Timers, main-run evidence, green queue runs, closed issues.
export async function sweepBreakers(t, { mainRuns = [], queuePasses = [] } = {}) {
  const closedIssues = [];
  await sweepList(
    t,
    'breaker issue',
    t.state.breakers.breakers.filter((b) => b.kind === 'main_broken' && b.issue),
    async (b) => {
      const res = await t.gh.rest('GET', `repos/${t.repo}/issues/${b.issue}`);
      if (res.status !== 200) throw new Error(`issue ${b.issue} read failed (${res.status})`);
      if (res.body.state === 'closed') closedIssues.push(b.issue);
    },
  );
  const up = updateBreakers(t.state.breakers, { mainRuns, queuePasses, closedIssues }, t.now);
  t.state.breakers = up.state;
  t.state.clearedBreakers = [...(t.state.clearedBreakers ?? []), ...up.cleared];
  await actOnBreakers(t, up);
  await restoreCleared(t);
}

// ci_success_missing: a queue entry whose CI run completed with no CI Success
// job would wait for the queue timeout.
export async function sweepStuck(t) {
  await sweepList(t, 'stuck entry', await mergeQueueEntries(t.gh, { repo: t.repo }), async (e) => {
    if (!e.groupSha || !e.enqueuedAt || t.now - ms(e.enqueuedAt) < STUCK_MIN_AGE_MS) return;
    const run = await groupRunBySha(t.gh, { repo: t.repo, groupSha: e.groupSha });
    if (!run || run.status !== 'completed' || t.now - ms(run.updatedAt) < STUCK_SETTLE_MS) return;
    const key = doneKey(t, `${run.id}:${run.attempt}`);
    if (t.state.stuck[key]) return;
    const { names, complete } = await jobNames(t.gh, { repo: t.repo, runId: run.id });
    if (!complete || names.includes('CI Success')) return;
    const snap = await t.snapshot(e.pr);
    const countKey = `${snap.pr}:${snap.headSha}`;
    const d = stuckDecision({ snapshot: snap, run, priorStuck: t.state.stuckCount[countKey] ?? 0, now: t.now });
    const res = await t.act(d, 'sweep:ci_success_missing');
    if (!settled(res)) return;
    t.state.stuck[key] = iso(t.now);
    // Shadow keeps no counts: what it would have done did not happen.
    if (res.status === 'applied') {
      if (d.kind === 'requeue_stuck') t.state.stuckCount[countKey] = (t.state.stuckCount[countKey] ?? 0) + 1;
      if (d.kind === 'hold') t.state.stuckHolds[countKey] = (t.state.stuckHolds[countKey] ?? 0) + 1;
    }
    if (d.kind === 'hold') t.track(d);
  });
}

// A `record` whose PR is still open on the same head and not back in the
// queue 10 min after the removal is decided again with the current time.
export async function sweepReadds(t) {
  await keepOnBudget(
    sweepList(t, 're-add check', t.state.records, async (rec) => {
      if (t.now - ms(rec.removalAt) < READD_GRACE_MS) return true;
      if (t.now - ms(rec.removalAt) > RECORD_MAX_AGE_MS) return false;
      const snap = await t.snapshot(rec.pr);
      if (snap.queue || snap.state !== 'OPEN' || snap.headSha !== rec.head) return false;
      const removal = { pr: rec.pr, id: rec.removalId, at: rec.removalAt, reason: 'failed_checks' };
      const priorVerdicts = t.state.verdicts.filter((v) => v.pr === rec.pr && v.head === rec.head);
      const d = decide({ removal, snapshot: snap, verdict: rec.summary, priorVerdicts, breakers: t.state.breakers.breakers, now: t.now, selfOps: t.state.selfOps });
      if (d.kind === 'record') return true;
      t.track(d);
      return !settled(await t.act(d, 'sweep:readd'));
    }),
    (kept) => {
      t.state.records = kept;
    },
  );
}

// Parked PRs: a new head removes the shepherd labels; a closed or merged PR is
// forgotten.
export async function sweepParked(t) {
  await keepOnBudget(
    sweepList(t, 'parked PR', t.state.parked, async (p) => {
      if (t.now - ms(p.at) > PARKED_MAX_AGE_MS) return false;
      const snap = await t.snapshot(p.pr);
      if (snap.state !== 'OPEN') return false;
      if (snap.headSha === p.head) return true;
      return !settled(await t.act(newHeadDecision(p, snap, t.now), 'sweep:new_head'));
    }),
    (kept) => {
      t.state.parked = kept;
    },
  );
}

// The `ci-shepherd:resume` label releases a hold, once per head, budget
// position and stuck-hold count (so a shadow tick does not log it again every
// five minutes, and a second hold can be resumed again).
export async function sweepResume(t) {
  const res = await t.gh.rest('GET', `repos/${t.repo}/issues?labels=${encodeURIComponent(LABELS.resume)}&state=open&per_page=100`);
  if (res.status !== 200) throw new Error(`resume label listing: ${res.status}`);
  await sweepList(
    t,
    'resume',
    res.body.filter((item) => item.pull_request),
    async (item) => {
      const snap = await t.snapshot(item.number);
      if (snap.state !== 'OPEN' || snap.isFork) return;
      const d = resumeDecision(snap, t.now, { holds: t.state.stuckHolds[`${snap.pr}:${snap.headSha}`] ?? 0 });
      const key = doneKey(t, d.actionId);
      if (t.state.resumed[key]) return;
      const r = await t.act(d, 'sweep:resume');
      if (!settled(r)) return;
      t.state.resumed[key] = iso(t.now);
      if (t.mode === 'act') dropPark(t, snap.pr);
    },
  );
}

// Sightings from CI runs completed since the ingest cursor (same-repo runs
// only: a fork's evidence is not ours). Also collects what the breakers need
// into `state.breakerEvidence`, run by run: completed main runs and their
// failing ids, and green merge_group runs with the ids they quarantined. The
// cursor moves past a run once it is in, or once it failed to read (reported:
// one unreadable run must not block every later one).
export async function ingestSightings(t, { callLimit = Infinity } = {}) {
  const since = t.state.ingestCursor ?? iso(t.now - 30 * 60_000);
  const created = iso(ms(since) - INGEST_LOOKBACK_MS);
  const runs = [];
  for (let page = 1; page <= INGEST_PAGES; page++) {
    const q = new URLSearchParams({ status: 'completed', created: `>=${created}`, per_page: '100', page: String(page) });
    const res = await t.gh.rest('GET', `repos/${t.repo}/actions/workflows/ci.yml/runs?${q}`);
    if (res.status !== 200) throw new Error(`run listing: ${res.status}`);
    runs.push(...res.body.workflow_runs);
    if (res.body.workflow_runs.length < 100) break;
    if (page === INGEST_PAGES) t.error(`ingest: the run listing hit ${INGEST_PAGES * 100} runs; older completed runs may be missed`);
  }
  const fresh = runs
    .filter((r) => ms(r.updated_at) > ms(since) && r.head_repository?.full_name?.toLowerCase() === t.repo.toLowerCase() && !t.state.ingested[`${r.id}:${r.run_attempt}`])
    .sort((a, b) => ms(a.updated_at) - ms(b.updated_at));
  const evidence = (t.state.breakerEvidence ??= { mainRuns: [], queuePasses: [] });
  let count = 0;
  let done = 0;
  for (const r of fresh) {
    // Stop before a run that could not finish inside the limit; the cursor
    // stays before it and the next tick starts there.
    if (t.gh.calls + INGEST_RUN_RESERVE > callLimit) break;
    let facts = null;
    try {
      facts = await runFacts(t.gh, { repo: t.repo, runId: r.id, ciYml: t.ciYml, withGate: false, labelledOnly: true });
    } catch (e) {
      if (e.name === 'BudgetExceeded') break;
      t.error(`ingest: run ${r.id} skipped: ${e.message}`);
    }
    if (facts) {
      const sightings = ingestRun(facts, { repo: t.repo, repoRoot: t.repoRoot });
      for (const s of sightings) appendJsonl(t.sightingsPath, s);
      count += sightings.length;
      if (facts.run.headBranch === 'main' && facts.run.event !== 'merge_group' && facts.run.event !== 'pull_request') {
        const failedIds = new Set();
        for (const job of facts.jobs) {
          const a = attemptsOf(job);
          for (const id of [...(a?.first?.failures ?? []), ...(a?.second?.failures ?? [])]) failedIds.add(id);
        }
        evidence.mainRuns.push({ run: r.id, at: r.created_at, completed: true, failedIds: [...failedIds] });
      }
      if (facts.run.event === 'merge_group' && r.conclusion === 'success') {
        const quarantined = facts.jobs.flatMap((j) => (j.report?.quarantined ?? []).map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean));
        evidence.queuePasses.push({ run: r.id, at: r.updated_at, quarantined });
      }
    }
    t.state.ingested[`${r.id}:${r.run_attempt}`] = iso(t.now);
    t.state.ingestCursor = r.updated_at;
    done++;
  }
  return { runs: done, deferred: fresh.length - done, sightings: count };
}
