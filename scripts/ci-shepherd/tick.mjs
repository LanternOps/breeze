// One shepherd tick: the single writer (W06b B3, #10750).
//
//   1. Lock (`stateDir/lock`; a lock older than 15 min is stale). Budget:
//      min(600, 1500 − calls in the trailing hour).
//   2. Mode from CI_SHEPHERD_MODE (unset/invalid → shadow; off → exit). Out of
//      act mode every read goes through a read-only client and no writer
//      exists, so the tick can only record what it would do.
//   3. Act mode: finish decisions left pending (a crash, a mode flip).
//   4. Each new removal since cursor − 30 min: snapshot, group run, facts,
//      verdict, breakers, decision, apply.
//   5. Ingest flake sightings from CI runs completed since the last tick.
//   6. Sweeps: breakers, stuck queue entries, pending re-adds, parked PRs with
//      a new head, the resume label.
//   7. Save state atomically. A BudgetExceeded keeps the cursor at the first
//      removal it did not finish.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply, readMode } from './apply.mjs';
import { parkInBreaker, updateBreakers } from './breakers.mjs';
import { classifyRun } from './classify.mjs';
import { LABELS, decide, staleReasons, summarizeVerdict } from './decide.mjs';
import { History } from './evidence.mjs';
import { groupRunFor, headPushedAt, prSnapshot, recentRemovals, requiredJobIds, runFacts } from './facts.mjs';
import { acquireLock, appendJsonl, loadState, readJsonl, releaseLock, saveState, tickBudget, writeJsonl } from './state.mjs';
import { actOnBreakers, ingestSightings, sweepBreakers, sweepParked, sweepReadds, sweepResume, sweepStuck } from './sweeps.mjs';
import { createWriter, readOnlyGitHub } from './writer.mjs';

const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const LOOKBACK_MS = 30 * 60_000;
const VERDICT_DAYS = 7;
const SIGHTING_DAYS = 30;
const MAX_REMOVAL_FAILURES = 3;
const MAX_PENDING_TRIES = 5;
// The share of a tick's API budget sightings ingest may use. A completed CI
// run costs several calls (jobs, artifacts, each failed test job's
// annotations and log); one live shadow tick spent its whole 600 on ingest.
export const INGEST_SHARE = 0.4;

// A removal → { decision, summary }. Stale removals (rule 1) are decided
// before any run evidence is read.
async function decideRemoval(t, removal) {
  if (removal.reason !== 'failed_checks') {
    return {
      decision: { actionId: `${removal.pr}:r:${removal.id}`, kind: 'noop', reasons: ['not_failed_checks'], mutations: [], pr: removal.pr, removalId: removal.id, removalAt: removal.at, at: iso(t.now) },
      summary: null,
    };
  }
  const snapshot = await t.snapshot(removal.pr, true);
  const quick = staleReasons(removal, snapshot, { selfOps: t.state.selfOps, now: t.now });
  let summary;
  if (quick.length) {
    summary = { class: 'unknown', signature: null, testIds: [], failedBoth: [], run: null, attempt: null, jobs: [] };
  } else {
    const ref = await groupRunFor(t.gh, { repo: t.repo, pr: removal.pr, removal });
    if (ref) {
      const facts = await runFacts(t.gh, { repo: t.repo, runId: ref.id, ciYml: t.ciYml });
      const verdict = classifyRun(facts, { prFiles: new Set(snapshot.files), history: t.history, repoRoot: t.repoRoot, pr: removal.pr, now: ms(removal.at), requiredJobs: t.requiredJobs });
      summary = summarizeVerdict(verdict, facts);
    } else {
      summary = { class: 'unknown', signature: null, testIds: [], failedBoth: [], run: null, attempt: null, jobs: [], evidence: ['no_group_run'] };
    }
  }
  summary = { ...summary, pr: removal.pr, head: snapshot.headSha, removalId: removal.id, at: removal.at };
  if (!quick.length) {
    const up = updateBreakers(t.state.breakers, { verdicts: [summary] }, t.now);
    t.state.breakers = up.state;
    await actOnBreakers(t, up);
  }
  const priorVerdicts = t.state.verdicts.filter((v) => v.pr === removal.pr && v.head === snapshot.headSha);
  const decision = decide({ removal, snapshot, verdict: summary, priorVerdicts, breakers: t.state.breakers.breakers, now: t.now, selfOps: t.state.selfOps });
  return { decision, summary: quick.length ? null : summary };
}

// Book-keeping a decision needs whatever the mode: re-add checks, parked PRs.
function track(t, d) {
  if (d.kind === 'record') {
    t.state.records.push({ actionId: d.actionId, pr: d.pr, head: d.head, removalId: d.removalId, removalAt: d.removalAt, summary: t.lastSummary });
  }
  if (d.kind === 'hold' || d.kind === 'backoff' || d.kind === 'wait_main') {
    const label = d.mutations.find((m) => m.op === 'label_add')?.args.name ?? LABELS.hold;
    t.state.parked = t.state.parked.filter((p) => p.pr !== d.pr);
    t.state.parked.push({ pr: d.pr, head: d.head, label, at: iso(t.now) });
    if (d.breaker) t.state.breakers = parkInBreaker(t.state.breakers, d);
  }
}

function prune(state, now) {
  const older = (at, days) => now - ms(at) > days * 86_400_000;
  state.verdicts = state.verdicts.filter((v) => !older(v.at, VERDICT_DAYS));
  for (const map of ['seen', 'stuck', 'resumed', 'ingested', 'done']) {
    state[map] = Object.fromEntries(Object.entries(state[map]).filter(([, at]) => !older(at, 2)));
  }
  state.selfOps = state.selfOps.filter((o) => !older(o.at, 1));
}

export async function tick({ gh, repo, stateDir, now = Date.now(), clock = () => Date.now(), exec, repoRoot, log = (l) => process.stdout.write(`${l}\n`) }) {
  const lock = acquireLock(stateDir, now);
  if (!lock.ok) {
    log(`ci-shepherd tick locked (held since ${lock.heldSince})`);
    return { status: 'locked' };
  }
  const state = loadState(stateDir);
  const decisionsPath = join(stateDir, 'decisions.jsonl');
  const sightingsPath = join(stateDir, 'sightings.jsonl');
  const startCalls = gh.calls;
  const summary = { status: 'ok', mode: null, removals: 0, decisions: {}, sweeps: {}, errors: [], budget: 0, calls: 0 };
  const warn = (m) => summary.errors.push(m);
  try {
    const { used, budget } = tickBudget(state, now);
    summary.budget = budget;
    if (budget <= 0) {
      summary.status = 'hourly_budget_spent';
      return summary;
    }
    gh.budget = gh.calls + budget;
    const ro = readOnlyGitHub(gh);
    summary.mode = await readMode(ro, repo, { warn });
    if (summary.mode === 'off') {
      summary.status = 'off';
      return summary;
    }
    const acting = summary.mode === 'act';
    const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const t = {
      gh: acting ? gh : ro,
      repo,
      now,
      state,
      ciYml,
      repoRoot,
      sightingsPath,
      requiredJobs: requiredJobIds(ciYml),
      history: History.fromSightings(readJsonl(sightingsPath).filter((s) => now - ms(s.at) <= 14 * 86_400_000)),
      mode: summary.mode,
      lastSummary: null,
    };
    t.snapshot = async (pr, withFiles = false) => {
      const s = await prSnapshot(t.gh, { repo, pr, withFiles });
      return { ...s, headPushedAt: await headPushedAt(t.gh, { repo, headSha: s.headSha }) };
    };
    t.track = (d) => track(t, d);
    const viewer = acting ? (await gh.rest('GET', 'user')).body?.login : null;
    if (acting && !viewer) throw new Error('cannot read the operator login');
    const writer = acting ? createWriter({ gh, exec, repo }) : null;
    const record = (entry) => appendJsonl(decisionsPath, entry);
    const modeNow = async () => {
      const m = await readMode(ro, repo, { warn });
      if (m !== 'act') {
        // Out of act for the rest of this tick: no writer, read-only reads.
        t.mode = m;
        t.gh = ro;
      }
      return m;
    };

    // apply + act-mode persistence: a decision is pending (saved) before its
    // first write and leaves the list once applied or skipped.
    t.act = async (decision, source) => {
      summary.decisions[decision.kind] = (summary.decisions[decision.kind] ?? 0) + 1;
      const writes = t.mode === 'act' && decision.kind !== 'noop' && decision.mutations.length > 0;
      const key = `${decision.actionId}#${decision.kind}`;
      if (writes && !state.pending.some((p) => p.key === key)) {
        state.pending.push({ key, decision, source, since: iso(now), tries: 0 });
        saveState(stateDir, state);
      }
      const entry = state.pending.find((p) => p.key === key);
      let res;
      try {
        res = await apply(gh, decision, {
          mode: t.mode,
          repo,
          viewer,
          writer: t.mode === 'act' ? writer : null,
          reread: (pr) => t.snapshot(pr),
          modeNow,
          clock,
          selfOps: state.selfOps,
          onSelfOp: (op) => {
            state.selfOps.push(op);
            saveState(stateDir, state);
          },
          record: (e) => record({ ...e, source }),
        });
      } catch (e) {
        if (entry) entry.tries++;
        if (e.name === 'BudgetExceeded') throw e;
        summary.errors.push(`${decision.actionId} ${decision.kind}: ${e.message}`);
        return { status: 'error', reason: e.message };
      }
      if (entry && res.status !== 'partial') state.pending = state.pending.filter((p) => p.key !== key);
      if (res.status === 'partial') summary.status = 'partial';
      return res;
    };

    // 3. Finish what an earlier act tick left.
    if (acting) {
      for (const p of [...state.pending]) {
        if (p.tries >= MAX_PENDING_TRIES) {
          summary.errors.push(`dropped pending ${p.key} after ${p.tries} tries`);
          state.pending = state.pending.filter((x) => x !== p);
          continue;
        }
        await t.act(p.decision, `pending:${p.source}`);
      }
    }

    // 4. New removals.
    const since = iso((state.cursor ? ms(state.cursor) : now) - LOOKBACK_MS);
    const removals = (await recentRemovals(t.gh, { repo, since, maxPages: 3 })).filter((r) => !state.seen[r.id]);
    let firstUnfinished = null;
    for (const removal of removals) {
      try {
        const { decision, summary: s } = await decideRemoval(t, removal);
        t.lastSummary = s;
        if (s) state.verdicts.push(s);
        track(t, decision);
        state.seen[removal.id] = removal.at;
        summary.removals++;
        await t.act(decision, 'removal');
      } catch (e) {
        if (e.name === 'BudgetExceeded') {
          firstUnfinished ??= removal;
          state.cursor = firstUnfinished.at;
          throw e;
        }
        state.failures[removal.id] = (state.failures[removal.id] ?? 0) + 1;
        summary.errors.push(`removal ${removal.id} (PR ${removal.pr}): ${e.message}`);
        if (state.failures[removal.id] >= MAX_REMOVAL_FAILURES) state.seen[removal.id] = removal.at;
        else firstUnfinished ??= removal;
      }
    }
    state.cursor = firstUnfinished ? firstUnfinished.at : iso(now);

    // 5. Sweeps. Breakers read the main-run and queue-run evidence the
    // previous tick's ingest collected.
    const evidence = state.breakerEvidence ?? { mainRuns: [], queuePasses: [] };
    await sweepBreakers(t, evidence);
    state.breakerEvidence = { mainRuns: [], queuePasses: [] };
    await sweepStuck(t);
    await sweepReadds(t);
    await sweepParked(t);
    await sweepResume(t);

    // 6. Sightings last, on what is left of the budget and at most
    // INGEST_SHARE of it: evidence can wait a tick, queue decisions cannot.
    const ingestLimit = Math.min(gh.budget, gh.calls + Math.floor(budget * INGEST_SHARE));
    const ingest = await ingestSightings(t, { callLimit: ingestLimit });
    summary.sweeps.ingested = ingest.runs;
    summary.sweeps.sightings = ingest.sightings;
    if (ingest.deferred) summary.sweeps.ingestDeferred = ingest.deferred;
    state.breakerEvidence = { mainRuns: ingest.mainRuns, queuePasses: ingest.queuePasses };
    return summary;
  } catch (e) {
    if (e.name !== 'BudgetExceeded') throw e;
    summary.status = 'budget_exceeded';
    return summary;
  } finally {
    summary.calls = gh.calls - startCalls;
    if (summary.calls > 0) state.calls.push({ at: iso(now), n: summary.calls });
    prune(state, now);
    saveState(stateDir, state);
    if (ms(state.sightingsPrunedAt ?? 0) < now - 86_400_000) {
      const keep = readJsonl(sightingsPath).filter((s) => now - ms(s.at) <= SIGHTING_DAYS * 86_400_000);
      writeJsonl(sightingsPath, keep);
      state.sightingsPrunedAt = iso(now);
      saveState(stateDir, state);
    }
    releaseLock(stateDir, lock.token);
    log(renderSummary(summary));
  }
}

export function renderSummary(s) {
  const decisions = Object.entries(s.decisions)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  const errs = s.errors.length ? ` errors=${s.errors.length} first_error=${JSON.stringify(s.errors[0]).slice(0, 200)}` : '';
  const deferred = s.sweeps?.ingestDeferred ? ` ingest_deferred=${s.sweeps.ingestDeferred}` : '';
  return `ci-shepherd tick status=${s.status} mode=${s.mode ?? '-'} removals=${s.removals ?? 0} decisions=${decisions || '-'} ingested=${s.sweeps?.ingested ?? 0}${deferred} calls=${s.calls ?? 0}/${s.budget ?? 0}${errs}`;
}
