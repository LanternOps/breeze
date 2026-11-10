// What to do about one merge-queue removal (W06b B2, #10750). Pure: `now` is
// injected and nothing here reads or writes GitHub.
//
// Rules, first match wins:
//   1. noop    — not a failed_checks removal; the PR is not open; the head
//                moved since; a human removed it by hand afterwards; the
//                `ci-shepherd:ignore` label; a fork.
//   2. backoff / wait_main — the removal matches an open breaker (breakers.mjs).
//   3. hold    — class real or gate_fault; or retry_exhausted: this head's
//                failed_checks removals (GitHub's own auto-merge re-adds
//                included) exceed the class limit or MAX_REMOVALS, or one test
//                failed both attempts in two removals of this head.
//   4. re-queue — `record` when GitHub already re-added it, or will (auto-merge
//                on, under 10 min since the removal); else `requeue`.
//
// The head at removal time. A RemovedFromMergeQueueEvent's `beforeCommit` is
// the merge-group commit, not the PR head (verified in W06a), so "which head
// was removed" is answered by time instead: the snapshot carries
// `headPushedAt`, when the current head first got a CI run. A removal before
// that belongs to an older head. When it is unknown (null), every removal in
// the timeline window counts against the current head — the side that holds
// sooner, never later.
import { attemptsOf } from './evidence.mjs';
import { actionId } from './markers.mjs';

export const LIMITS = Object.freeze({ infra: 3, known_flake: 3, suspected_flake: 2, timeout: 1, unknown: 1, real: 0, gate_fault: 0 });
export const MAX_REMOVALS = 3;
export const READD_GRACE_MS = 10 * 60_000;
// A `manual` removal by the operator login within this long after the
// shepherd recorded its own dequeue is that dequeue, not human intent.
export const SELF_OP_WINDOW_MS = 5 * 60_000;

export const LABELS = Object.freeze({
  hold: 'ci-shepherd:hold',
  backoff: 'ci-shepherd:backoff',
  waitMain: 'ci-shepherd:wait-main',
  ignore: 'ci-shepherd:ignore',
  resume: 'ci-shepherd:resume',
  probe: 'ci-shepherd:probe',
});
export const PARK_LABELS = [LABELS.hold, LABELS.backoff, LABELS.waitMain];

const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const TOUCHED = /^touched by the PR: (.*)$/;

// VerdictSummary — what decide and the breakers need from a RunVerdict, small
// enough to keep 7 days of in state.json: { class, signature, testIds,
// failedBoth, run, attempt, jobs }. `failedBoth` lists untouched test ids that
// failed on both attempts of a job (from the schema-2 report, else the log).
export function summarizeVerdict(verdict, facts = null) {
  const touched = new Set();
  for (const j of verdict.jobs ?? []) for (const e of j.evidence ?? []) TOUCHED.exec(e) && touched.add(TOUCHED.exec(e)[1]);
  const failedBoth = new Set();
  const judged = new Map((verdict.jobs ?? []).map((j) => [j.job, j.class]));
  for (const job of facts?.jobs ?? []) {
    const cls = judged.get(job.name);
    if (!cls || cls === 'real' || cls === 'gate_fault') continue;
    const a = attemptsOf(job);
    if (!a?.first || !a?.second) continue;
    const second = new Set(a.second.failures);
    for (const id of a.first.failures) if (second.has(id) && !touched.has(id)) failedBoth.add(id);
  }
  return {
    class: verdict.class,
    signature: verdict.signature ?? null,
    testIds: [...(verdict.testIds ?? [])].slice(0, 50),
    failedBoth: [...failedBoth].slice(0, 50),
    run: facts?.run?.id ?? null,
    attempt: facts?.run?.attempt ?? null,
    jobs: (verdict.jobs ?? []).map((j) => ({ job: j.job, class: j.class, signature: j.signature ?? null })).slice(0, 20),
  };
}

export function isSelfRemoval(ev, pr, selfOps = []) {
  if (ev.type !== 'removed' || ev.reason !== 'manual') return false;
  return selfOps.some((o) => o.pr === pr && o.op === 'dequeue' && ms(ev.at) >= ms(o.at) - 1000 && ms(ev.at) - ms(o.at) <= SELF_OP_WINDOW_MS);
}

// failed_checks removals of the PR's current head up to and including this one.
export function removalsOfHead(snapshot, removal) {
  const since = snapshot.headPushedAt ? ms(snapshot.headPushedAt) : -Infinity;
  const list = snapshot.events.filter((e) => e.type === 'removed' && e.reason === 'failed_checks' && ms(e.at) >= since && ms(e.at) <= ms(removal.at));
  if (!list.some((e) => e.id === removal.id) && ms(removal.at) >= since) list.push({ type: 'removed', ...removal });
  return list.sort((a, b) => ms(a.at) - ms(b.at));
}

// Rule 1. Also used by apply.mjs to re-check a decision against fresh state.
export function staleReasons(removal, snapshot, { selfOps = [] } = {}) {
  const out = [];
  if (removal.reason !== 'failed_checks') out.push('not_failed_checks');
  if (snapshot.state !== 'OPEN') out.push(`pr_${String(snapshot.state).toLowerCase()}`);
  if (snapshot.headPushedAt && ms(snapshot.headPushedAt) > ms(removal.at)) out.push('head_moved');
  if (snapshot.events.some((e) => e.type === 'removed' && e.reason === 'manual' && ms(e.at) > ms(removal.at) && !isSelfRemoval(e, snapshot.pr, selfOps))) {
    out.push('manual_removal_after');
  }
  if (snapshot.labels.includes(LABELS.ignore)) out.push('ignore_label');
  if (snapshot.isFork) out.push('fork');
  return out;
}

const parkOps = (snapshot, label) => [
  ...(snapshot.autoMerge ? [{ op: 'disable_auto_merge', args: {} }] : []),
  ...(snapshot.queue ? [{ op: 'dequeue', args: {} }] : []),
  { op: 'label_add', args: { name: label } },
  { op: 'comment', args: {} },
];

// Decision = { actionId, kind, holdReason?, reasons, mutations, pr, head,
//   removalId, removalAt, run, attempt, class, signature, n, limit, at,
//   breaker?, expect }. `expect` is what apply re-checks before writing.
export function decide({ removal, snapshot, verdict, priorVerdicts = [], breakers = [], now, selfOps = [] }) {
  const n = removalsOfHead(snapshot, removal).length;
  const limit = Math.min(LIMITS[verdict.class] ?? 0, MAX_REMOVALS);
  const base = {
    actionId: actionId({ pr: snapshot.pr, headSha: snapshot.headSha, runId: verdict.run ?? null, runAttempt: verdict.attempt ?? 1, removalId: removal.id }),
    pr: snapshot.pr,
    head: snapshot.headSha,
    removalId: removal.id,
    removalAt: removal.at,
    run: verdict.run ?? null,
    attempt: verdict.attempt ?? null,
    class: verdict.class,
    signature: verdict.signature ?? null,
    n,
    limit,
    at: iso(now),
    expect: { state: 'OPEN', head: snapshot.headSha, removalId: removal.id },
  };
  const make = (kind, reasons, mutations = [], extra = {}) => ({ ...base, kind, reasons, mutations, ...extra });
  const notes = snapshot.headPushedAt ? [] : ['head_push_time_unknown'];

  const stale = staleReasons(removal, snapshot, { selfOps });
  if (stale.length) return make('noop', stale);

  // 2. Breakers.
  const ids = new Set([...(verdict.failedBoth ?? []), ...(verdict.testIds ?? [])]);
  const outage = breakers.find((b) => b.kind === 'outage' && b.status === 'open' && verdict.class === 'infra' && b.key === verdict.signature);
  if (outage) {
    return make('backoff', [...notes, `outage breaker open on ${outage.key} until ${outage.until}`], parkOps(snapshot, LABELS.backoff), {
      breaker: { kind: 'outage', key: outage.key },
    });
  }
  const broken =
    verdict.class !== 'real' && verdict.class !== 'gate_fault'
      ? breakers.find((b) => b.kind === 'main_broken' && (b.status === 'suspected' || b.status === 'confirmed') && ids.has(b.key))
      : null;
  if (broken) {
    return make('wait_main', [...notes, `main_broken breaker ${broken.status} on ${broken.key}`], parkOps(snapshot, LABELS.waitMain), {
      breaker: { kind: 'main_broken', key: broken.key },
    });
  }

  // 3. Holds.
  if (verdict.class === 'real' || verdict.class === 'gate_fault') {
    return make('hold', [...notes, `class ${verdict.class}`], parkOps(snapshot, LABELS.hold), { holdReason: verdict.class });
  }
  if (n > limit) {
    return make('hold', [...notes, `removal ${n} of this head; ${verdict.class} allows ${limit}`], parkOps(snapshot, LABELS.hold), { holdReason: 'retry_exhausted' });
  }
  const both = new Set(verdict.failedBoth ?? []);
  const repeat = priorVerdicts
    .filter((p) => p.pr === snapshot.pr && p.head === snapshot.headSha && p.removalId !== removal.id)
    .flatMap((p) => (p.failedBoth ?? []).filter((id) => both.has(id)));
  if (repeat.length) {
    return make('hold', [...notes, `failed both attempts twice on this head: ${repeat[0]}`], parkOps(snapshot, LABELS.hold), { holdReason: 'retry_exhausted' });
  }

  // 4. Re-queue.
  const why = [...notes, `removal ${n} of ${limit} allowed for ${verdict.class}`];
  if (snapshot.queue) return make('record', [...why, 'already back in the queue'], [{ op: 'comment', args: {} }]);
  if (snapshot.autoMerge && now - ms(removal.at) < READD_GRACE_MS) {
    return make('record', [...why, 'auto-merge is on; GitHub re-adds it'], [{ op: 'comment', args: {} }]);
  }
  return make('requeue', why, [
    { op: 'enqueue', args: {} },
    { op: 'comment', args: {} },
  ]);
}

// A parked PR whose breaker cleared: back to the queue if it is still open on
// the head that was parked.
export function restoreDecision(entry, snapshot, breaker, now) {
  const base = {
    actionId: `${entry.pr}:${String(entry.head).slice(0, 12)}:restore:${breaker.kind}:${breaker.openedAt}`,
    pr: entry.pr,
    head: entry.head,
    class: null,
    signature: null,
    at: iso(now),
    breaker: { kind: breaker.kind, key: breaker.key },
    expect: { state: 'OPEN', head: entry.head },
  };
  if (snapshot.state !== 'OPEN' || snapshot.headSha !== entry.head) {
    return { ...base, kind: 'noop', reasons: [snapshot.state !== 'OPEN' ? `pr_${String(snapshot.state).toLowerCase()}` : 'head_moved'], mutations: [] };
  }
  const label = entry.label ?? (breaker.kind === 'outage' ? LABELS.backoff : LABELS.waitMain);
  return {
    ...base,
    kind: 'restore',
    reasons: [`${breaker.kind} breaker on ${breaker.key} cleared (${breaker.why ?? 'cleared'})`],
    mutations: [
      { op: 'enable_auto_merge', args: {} },
      { op: 'label_remove', args: { name: label } },
      { op: 'comment', args: {} },
    ],
  };
}
