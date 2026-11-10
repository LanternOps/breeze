// The tick's sweeps (W06b B3, #10750). Each takes the tick context `t`
// (tick.mjs): `t.gh` (read-only outside act mode), `t.repo`, `t.now`,
// `t.state`, `t.snapshot(pr)`, `t.act(decision, source)`, and, for ingest,
// `t.ciYml`, `t.repoRoot`, `t.sightingsPath`.
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

const dropPark = (t, pr) => {
  t.state.parked = t.state.parked.filter((p) => p.pr !== pr);
};

// Breaker-level decisions run once each; an issue upsert remembers its issue.
export async function actOnBreakers(t, up) {
  for (const d of breakerDecisions(up, t.now)) {
    if (t.state.done[d.actionId]) continue;
    const res = await t.act(d, 'breaker');
    if (res.status === 'applied' || res.status === 'shadow') t.state.done[d.actionId] = iso(t.now);
    if (res.issue) t.state.breakers = setBreakerIssue(t.state.breakers, d.breaker.key, res.issue);
  }
}

// Timers, main-run evidence, green queue runs, closed issues; then restore
// every PR a cleared breaker parked.
export async function sweepBreakers(t, { mainRuns = [], queuePasses = [] } = {}) {
  const closedIssues = [];
  for (const b of t.state.breakers.breakers) {
    if (b.kind !== 'main_broken' || !b.issue) continue;
    const res = await t.gh.rest('GET', `repos/${t.repo}/issues/${b.issue}`);
    if (res.status === 200 && res.body.state === 'closed') closedIssues.push(b.issue);
  }
  const up = updateBreakers(t.state.breakers, { mainRuns, queuePasses, closedIssues }, t.now);
  t.state.breakers = up.state;
  await actOnBreakers(t, up);
  for (const b of up.cleared) {
    for (const entry of b.restore) {
      const snap = await t.snapshot(entry.pr);
      await t.act(restoreDecision(entry, snap, b, t.now), 'sweep:restore');
      dropPark(t, entry.pr);
    }
  }
}

// ci_success_missing: a queue entry whose CI run completed with no CI Success
// job would wait for the queue timeout.
export async function sweepStuck(t) {
  for (const e of await mergeQueueEntries(t.gh, { repo: t.repo })) {
    if (!e.groupSha || !e.enqueuedAt || t.now - ms(e.enqueuedAt) < STUCK_MIN_AGE_MS) continue;
    const run = await groupRunBySha(t.gh, { repo: t.repo, groupSha: e.groupSha });
    if (!run || run.status !== 'completed' || t.now - ms(run.updatedAt) < STUCK_SETTLE_MS) continue;
    const key = `${run.id}:${run.attempt}`;
    if (t.state.stuck[key]) continue;
    const { names, complete } = await jobNames(t.gh, { repo: t.repo, runId: run.id });
    if (!complete || names.includes('CI Success')) continue;
    const snap = await t.snapshot(e.pr);
    const countKey = `${snap.pr}:${snap.headSha}`;
    const d = stuckDecision({ snapshot: snap, run, priorStuck: t.state.stuckCount[countKey] ?? 0, now: t.now });
    t.state.stuck[key] = iso(t.now);
    if (d.kind === 'requeue_stuck') t.state.stuckCount[countKey] = (t.state.stuckCount[countKey] ?? 0) + 1;
    if (d.kind === 'hold') t.state.parked.push({ pr: d.pr, head: d.head, label: LABELS.hold, at: iso(t.now) });
    await t.act(d, 'sweep:ci_success_missing');
  }
}

// A `record` whose PR is still open on the same head and not back in the
// queue 10 min after the removal is decided again with the current time.
export async function sweepReadds(t) {
  const keep = [];
  for (const rec of t.state.records) {
    if (t.now - ms(rec.removalAt) < READD_GRACE_MS) {
      keep.push(rec);
      continue;
    }
    if (t.now - ms(rec.removalAt) > RECORD_MAX_AGE_MS) continue;
    const snap = await t.snapshot(rec.pr);
    if (snap.queue || snap.state !== 'OPEN' || snap.headSha !== rec.head) continue;
    const removal = { pr: rec.pr, id: rec.removalId, at: rec.removalAt, reason: 'failed_checks' };
    const priorVerdicts = t.state.verdicts.filter((v) => v.pr === rec.pr && v.head === rec.head);
    const d = decide({ removal, snapshot: snap, verdict: rec.summary, priorVerdicts, breakers: t.state.breakers.breakers, now: t.now, selfOps: t.state.selfOps });
    if (d.kind === 'record') {
      keep.push(rec);
      continue;
    }
    t.track(d);
    await t.act(d, 'sweep:readd');
  }
  t.state.records = keep;
}

// Parked PRs: a new head removes the shepherd labels; a closed or merged PR is
// forgotten.
export async function sweepParked(t) {
  const keep = [];
  for (const p of t.state.parked) {
    if (t.now - ms(p.at) > PARKED_MAX_AGE_MS) continue;
    const snap = await t.snapshot(p.pr);
    if (snap.state !== 'OPEN') continue;
    if (snap.headSha === p.head) {
      keep.push(p);
      continue;
    }
    await t.act(newHeadDecision(p, snap, t.now), 'sweep:new_head');
  }
  t.state.parked = keep;
}

// The `ci-shepherd:resume` label releases a hold (once per head and budget
// position, so a shadow tick does not log it again every five minutes).
export async function sweepResume(t) {
  const res = await t.gh.rest('GET', `repos/${t.repo}/issues?labels=${encodeURIComponent(LABELS.resume)}&state=open&per_page=100`);
  if (res.status !== 200) throw new Error(`resume label listing: ${res.status}`);
  for (const item of res.body) {
    if (!item.pull_request) continue;
    const snap = await t.snapshot(item.number);
    if (snap.state !== 'OPEN' || snap.isFork) continue;
    const d = resumeDecision(snap, t.now);
    if (t.state.resumed[d.actionId]) continue;
    t.state.resumed[d.actionId] = iso(t.now);
    await t.act(d, 'sweep:resume');
    dropPark(t, snap.pr);
  }
}

// Sightings from CI runs completed since the ingest cursor (same-repo runs
// only: a fork's evidence is not ours). Also returns what the breakers need:
// completed main runs and their failing ids, and green merge_group runs with
// the ids they quarantined. The cursor moves past a run only once it is in.
export async function ingestSightings(t) {
  const since = t.state.ingestCursor ?? iso(t.now - 30 * 60_000);
  const created = iso(ms(since) - INGEST_LOOKBACK_MS);
  const runs = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ status: 'completed', created: `>=${created}`, per_page: '100', page: String(page) });
    const res = await t.gh.rest('GET', `repos/${t.repo}/actions/workflows/ci.yml/runs?${q}`);
    if (res.status !== 200) throw new Error(`run listing: ${res.status}`);
    runs.push(...res.body.workflow_runs);
    if (res.body.workflow_runs.length < 100) break;
  }
  const fresh = runs
    .filter((r) => ms(r.updated_at) > ms(since) && r.head_repository?.full_name?.toLowerCase() === t.repo.toLowerCase() && !t.state.ingested[`${r.id}:${r.run_attempt}`])
    .sort((a, b) => ms(a.updated_at) - ms(b.updated_at));
  const mainRuns = [];
  const queuePasses = [];
  let count = 0;
  for (const r of fresh) {
    const facts = await runFacts(t.gh, { repo: t.repo, runId: r.id, ciYml: t.ciYml, withGate: false });
    const sightings = ingestRun(facts, { repo: t.repo, repoRoot: t.repoRoot });
    for (const s of sightings) appendJsonl(t.sightingsPath, s);
    count += sightings.length;
    if (facts.run.headBranch === 'main' && facts.run.event !== 'merge_group' && facts.run.event !== 'pull_request') {
      const failedIds = new Set();
      for (const job of facts.jobs) {
        const a = attemptsOf(job);
        for (const id of [...(a?.first?.failures ?? []), ...(a?.second?.failures ?? [])]) failedIds.add(id);
      }
      mainRuns.push({ run: r.id, at: r.created_at, completed: true, failedIds: [...failedIds] });
    }
    if (facts.run.event === 'merge_group' && r.conclusion === 'success') {
      const quarantined = facts.jobs.flatMap((j) => (j.report?.quarantined ?? []).map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean));
      queuePasses.push({ run: r.id, at: r.updated_at, quarantined });
    }
    t.state.ingested[`${r.id}:${r.run_attempt}`] = iso(t.now);
    t.state.ingestCursor = r.updated_at;
  }
  return { runs: fresh.length, sightings: count, mainRuns, queuePasses };
}
