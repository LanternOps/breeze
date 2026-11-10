// Repo-wide circuit breakers (W06b B2, #10750). Pure: `now` is injected.
//
// outage       ≥ 3 distinct PRs removed on the same infra signature within
//              60 min. Open for 20 min after the latest match; each new match
//              extends it. Matching removals back off instead of re-queuing.
// main_broken  ≥ 3 distinct PRs whose queue runs failed one untouched test on
//              both attempts within 6 h. Opens `suspected` and asks for one CI
//              run on main. A completed main CI run (any event) created after
//              it opened decides it: the test failed there → `confirmed` (one
//              `ci-red` issue); it did not → cleared. A confirmed breaker
//              clears when a later merge_group run succeeds without
//              quarantining the test, or a human closes its issue. A suspected
//              breaker nothing has decided for 12 h clears as stale, so a
//              missing main run cannot park PRs forever.
//
// BreakerState = { breakers: Breaker[], observations: Observation[] }.
// Breaker = { kind, key, status: 'open'|'suspected'|'confirmed', openedAt,
//   until?, prs: number[], restore: {pr, head, label}[], mainRun?, issue?,
//   confirmedAt? }. A cleared breaker leaves the state; it is returned once in
//   `cleared` with `why`, and its `restore` list is what the tick re-queues.

export const OUTAGE_PRS = 3;
export const OUTAGE_WINDOW_MS = 60 * 60_000;
export const OUTAGE_HOLD_MS = 20 * 60_000;
export const MAIN_BROKEN_PRS = 3;
export const MAIN_BROKEN_WINDOW_MS = 6 * 3600_000;
export const SUSPECTED_STALE_MS = 12 * 3600_000;
const NOT_A_FLAKE_SIGNAL = new Set(['real', 'gate_fault']);
// Test ids are free text: no mention, no issue reference in what is posted.
const neutralKey = (k) => String(k).replace(/@/g, '').replace(/#(?=\d)/g, 'no. ');

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ms = (s) => Date.parse(s);

export const emptyBreakerState = () => ({ breakers: [], observations: [] });

const clone = (state) => structuredClone(state ?? emptyBreakerState());

// verdicts: VerdictSummary[] (decide.mjs), each with `pr` and `at` (the removal).
// mainRuns: [{ run, at, completed, failedIds }] — completed CI runs on main.
// queuePasses: [{ run, at, quarantined }] — successful merge_group CI runs.
// closedIssues: issue numbers a human closed.
export function updateBreakers(prev, { verdicts = [], mainRuns = [], queuePasses = [], closedIssues = [] } = {}, now) {
  const state = clone(prev);
  const opened = [];
  const confirmed = [];
  const cleared = [];
  const find = (kind, key) => state.breakers.find((b) => b.kind === kind && b.key === key);

  for (const v of verdicts) {
    if (v.class === 'infra' && v.signature) state.observations.push({ kind: 'outage', key: v.signature, pr: v.pr, at: v.at });
    if (!NOT_A_FLAKE_SIGNAL.has(v.class)) {
      for (const id of v.failedBoth ?? []) state.observations.push({ kind: 'main_broken', key: id, pr: v.pr, at: v.at });
    }
  }
  const horizon = now - MAIN_BROKEN_WINDOW_MS;
  state.observations = state.observations.filter((o) => ms(o.at) >= horizon);

  const prsWithin = (kind, key, windowMs) =>
    new Set(state.observations.filter((o) => o.kind === kind && o.key === key && ms(o.at) >= now - windowMs && ms(o.at) <= now).map((o) => o.pr));

  // Open or extend on this tick's verdicts.
  for (const v of verdicts) {
    if (v.class === 'infra' && v.signature) {
      const b = find('outage', v.signature);
      if (b) {
        // Extend from the removal, so an old removal processed late (the
        // runner was off) cannot hold the queue for another 20 minutes.
        b.until = iso(Math.max(ms(b.until), Math.min(now, ms(v.at)) + OUTAGE_HOLD_MS));
        if (!b.prs.includes(v.pr)) b.prs.push(v.pr);
      } else {
        const prs = prsWithin('outage', v.signature, OUTAGE_WINDOW_MS);
        if (prs.size >= OUTAGE_PRS) {
          const nb = { kind: 'outage', key: v.signature, status: 'open', openedAt: iso(now), until: iso(now + OUTAGE_HOLD_MS), prs: [...prs], restore: [] };
          state.breakers.push(nb);
          opened.push(nb);
        }
      }
    }
    if (NOT_A_FLAKE_SIGNAL.has(v.class)) continue;
    for (const id of v.failedBoth ?? []) {
      const b = find('main_broken', id);
      if (b) {
        if (!b.prs.includes(v.pr)) b.prs.push(v.pr);
        continue;
      }
      const prs = prsWithin('main_broken', id, MAIN_BROKEN_WINDOW_MS);
      if (prs.size >= MAIN_BROKEN_PRS) {
        const nb = { kind: 'main_broken', key: id, status: 'suspected', openedAt: iso(now), prs: [...prs], restore: [] };
        state.breakers.push(nb);
        opened.push(nb);
      }
    }
  }

  // Timers and evidence.
  const keep = [];
  for (const b of state.breakers) {
    let why = null;
    if (b.kind === 'outage' && now >= ms(b.until)) why = 'outage_window_passed';
    if (b.kind === 'main_broken' && b.status === 'suspected') {
      const run = mainRuns
        .filter((r) => r.completed && ms(r.at) > ms(b.openedAt))
        .sort((a, c) => ms(a.at) - ms(c.at))[0];
      if (run && run.failedIds.includes(b.key)) {
        b.status = 'confirmed';
        b.mainRun = run.run;
        b.confirmedAt = iso(now);
        confirmed.push(b);
      } else if (run) {
        b.mainRun = run.run;
        why = 'main_passed';
      } else if (now - ms(b.openedAt) >= SUSPECTED_STALE_MS) {
        why = 'stale_no_main_run';
      }
    } else if (b.kind === 'main_broken' && b.status === 'confirmed') {
      const pass = queuePasses.find((p) => ms(p.at) > ms(b.confirmedAt ?? b.openedAt) && !(p.quarantined ?? []).includes(b.key));
      if (pass) why = 'queue_passed';
      else if (b.issue && closedIssues.includes(b.issue)) why = 'issue_closed';
    }
    if (why) cleared.push({ ...b, status: 'cleared', why, clearedAt: iso(now) });
    else keep.push(b);
  }
  state.breakers = keep;
  return { state, opened, confirmed, cleared };
}

// The breaker a park decision (backoff / wait_main) matched.
export function breakerFor(breakers, { kind, key }) {
  return breakers.find((b) => b.kind === kind && b.key === key) ?? null;
}

// Record a parked PR so the breaker restores it when it clears.
export function parkInBreaker(prev, decision) {
  const state = clone(prev);
  const b = decision.breaker && breakerFor(state.breakers, decision.breaker);
  if (!b) return state;
  const label = decision.mutations.find((m) => m.op === 'label_add')?.args.name ?? null;
  if (!b.restore.some((e) => e.pr === decision.pr && e.head === decision.head)) b.restore.push({ pr: decision.pr, head: decision.head, label });
  return state;
}

// Remember the issue a confirmed breaker's upsert created or reused.
export function setBreakerIssue(prev, key, issue) {
  const state = clone(prev);
  const b = breakerFor(state.breakers, { kind: 'main_broken', key });
  if (b) b.issue = issue;
  return state;
}

// The breaker-level decisions of one update: one main CI dispatch per newly
// suspected main_broken, one issue upsert per newly confirmed one. Restores
// need a fresh PR snapshot each, so the tick builds them (decide.restoreDecision).
export function breakerDecisions({ opened = [], confirmed = [] }, now) {
  const out = [];
  for (const b of opened) {
    if (b.kind !== 'main_broken') continue;
    out.push({
      actionId: `breaker:main_broken:${b.key}:${b.openedAt}:dispatch`,
      kind: 'dispatch_main',
      pr: null,
      breaker: { kind: b.kind, key: b.key },
      reasons: [`${b.prs.length} PRs failed ${b.key} on both attempts within 6 h`],
      mutations: [{ op: 'dispatch_main_ci', args: { ref: 'main' } }],
      at: iso(now),
    });
  }
  for (const b of confirmed) {
    const key = neutralKey(b.key);
    out.push({
      actionId: `breaker:main_broken:${b.key}:${b.openedAt}:issue`,
      kind: 'main_broken_confirmed',
      pr: null,
      breaker: { kind: b.kind, key: b.key },
      reasons: [`main CI run ${b.mainRun} failed ${b.key}`],
      mutations: [
        {
          op: 'issue_upsert',
          args: {
            title: `Queue blocked: ${key} fails on main`.slice(0, 250),
            labels: ['ci-red'],
            body: [
              `The CI shepherd saw this test fail on both attempts in ${b.prs.length} merge-queue runs within 6 h, and it failed again in CI run ${b.mainRun} on main.`,
              '',
              `Test: \`${key.replace(/`/g, "'")}\``,
              '',
              'PRs that fail on it wait (label `ci-shepherd:wait-main`) until a merge-queue run passes it or this issue is closed.',
            ].join('\n'),
          },
        },
      ],
      at: iso(now),
    });
  }
  return out;
}
