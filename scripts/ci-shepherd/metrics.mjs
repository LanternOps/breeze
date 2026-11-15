// Weekly CI throughput metrics (W06d, #10750). The spec's "Metrics" table,
// measured for one ISO week (Mon 00:00Z to Sun 24:00Z) and posted as one
// comment on the issue `CI throughput — weekly metrics`.
//
// weekMetrics only reads. postWeekly reads through `gh` and writes only
// through the tick's writer (act mode); without one it returns what it would
// post. weeklyMetrics is the tick's hook: on the first act-mode tick after
// Monday 13:00Z it posts the previous week, once.
//
// Every row says how much of its data it saw:
//   exact        every run, job or PR of the week was read;
//   sampled 1/k  every k-th was read, to stay inside the API budget; a value
//                scaled up from the sample carries a leading ≈;
//   unavailable  the data could not be read in full (a listing over GitHub's
//                1,000-result cap, a failed read, the budget ran out, or the
//                shepherd was not in act mode that week). No value is shown:
//                a partial count would read as a real one.
import { join } from 'node:path';

import { classifyRun } from './classify.mjs';
import { History } from './evidence.mjs';
import { groupRunFor, headPushedAt, prSnapshot, requiredJobIds, runFacts } from './facts.mjs';
import { readJsonl } from './state.mjs';

export const METRICS_TITLE = 'CI throughput — weekly metrics';
export const METRICS_LABEL = 'ci-metrics';
export const DEFAULT_API_BUDGET = 4000;
// PR runs are read up to about this many; past it every k-th.
export const PR_RUN_SAMPLE_MAX = 300;
export const WAIT_LIMIT_S = 300;
// A re-add this soon after the removal, under a shepherd requeue or record,
// is the shepherd's (or GitHub's auto-merge it recorded), not a human's.
export const COVER_WINDOW_MS = 15 * 60_000;
// The tick posts at or after Monday 13:00Z.
export const POST_AFTER_MS = 13 * 3600_000;
// The tick leaves the metrics to a later tick when less than this is left
// (the listings and the queue event scan alone take some 60-100 calls).
export const MIN_TICK_BUDGET = 300;
// After a failed attempt, or one whose reads failed, the next waits this long.
export const RETRY_MS = 3600_000;
// A week whose reads keep failing is posted anyway (its rows unavailable)
// after this many hourly attempts, rather than never.
export const MAX_DEGRADED_TRIES = 6;
// Wall-clock limit on one metrics run inside a tick. GitHub served about
// 3 s a call on a live run (job listings are large), and the tick's lock
// goes stale after 15 minutes.
export const TICK_TIME_LIMIT_MS = 8 * 60_000;
// What one missing classification may cost: the PR, its group run, the run's
// jobs, artifacts, reports, annotations and logs.
export const CLASSIFY_COST = 25;
export const FLAKE_CLASSES = Object.freeze(['infra', 'known_flake', 'suspected_flake', 'timeout']);

const DAY = 86_400_000;
const LIST_PAGES = 10; // GitHub serves at most 1,000 results of a filtered run search
const SCAN_PAGES = 40;
const TIMELINE_LAST = 50;
const PR_EVENT_PAGES = 5;
// A heavy PR's queue events are read from this long before the week, so the
// add behind a Monday merge is usually among them.
const EVENT_LOOKBACK_MS = 2 * DAY;
const JOB_PAGES = 5;
const ISSUE_PAGES = 3;
const COMMENT_PAGES = 10;
const MAX_LISTED_PRS = 30;
// Past this share of undetermined merged PRs, the latency row is unavailable.
const MAX_UNDETERMINED_SHARE = 0.2;

const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Baselines and targets verbatim from the spec (week of 10-21).
export const ROWS = Object.freeze([
  { key: 'queue_ttg', name: 'Queue run time-to-green p50 / p90', baseline: '24.8 / 44.1 min', target: '< 8 / < 20 min' },
  { key: 'queue_latency', name: 'Queue latency p50 / p90 (new)', baseline: 'not measured', target: 'none set' },
  { key: 'pr_ttg', name: 'PR run time-to-green p50 / p90', baseline: '26.3 / 60.4 min', target: '< 20 / < 35 min' },
  { key: 'queue_flaky', name: 'Queue failures that were flake/infra/external', baseline: '57 of 71', target: '< 10' },
  { key: 'runner_hours', name: 'Queue runner-hours / week', baseline: '5,485 h', target: '−70%' },
  { key: 'linux_wait', name: 'Linux jobs waiting > 5 min for a runner', baseline: '22.9%', target: '< 5%' },
  { key: 'real_caught', name: 'Real interactions caught (must not drop)', baseline: '5 PRs / 8 days', target: 'same catches, all in thin selection' },
  { key: 'human_readds', name: 'Re-enqueues needing a human', baseline: 'not measured', target: '~0' },
]);

// ── Weeks and percentiles ────────────────────────────────────────────────

const toMs = (date) => (date instanceof Date ? date.getTime() : typeof date === 'string' ? ms(date) : date);
const mondayOf = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
};

// 'YYYY-Www': the ISO 8601 week (weeks start Monday; week 1 holds the year's
// first Thursday).
export function isoWeek(date) {
  const t = toMs(date);
  if (!Number.isFinite(t)) throw new Error(`isoWeek: bad date ${date}`);
  const monday = mondayOf(t);
  const year = new Date(monday + 3 * DAY).getUTCFullYear();
  const week = Math.round((monday - mondayOf(Date.UTC(year, 0, 4))) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// { start, end } in ms: Monday 00:00Z and the next Monday 00:00Z (exclusive).
export function weekBounds(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(week));
  if (!m) throw new Error(`weekBounds: ${JSON.stringify(String(week)).slice(0, 40)} is not YYYY-Www`);
  const start = mondayOf(Date.UTC(Number(m[1]), 0, 4)) + (Number(m[2]) - 1) * 7 * DAY;
  if (Number(m[2]) < 1 || isoWeek(start) !== week) throw new Error(`weekBounds: ${week} does not exist`);
  return { start, end: start + 7 * DAY };
}

// The week the tick owes a post for at `now`, or null before Monday 13:00Z.
export function dueWeek(now) {
  const monday = mondayOf(now);
  return now >= monday + POST_AFTER_MS ? isoWeek(monday - DAY) : null;
}

// Nearest rank: the smallest value with at least p% of values at or below it.
export function percentile(values, p) {
  if (!(p > 0 && p <= 100)) throw new Error(`percentile: p must be in (0, 100], got ${p}`);
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.ceil((p / 100) * v.length) - 1];
}

// ── Reads, inside a call budget ──────────────────────────────────────────

// The metrics' own share of the budget, and a wall-clock limit: they stop
// before either, never throw at it.
function meter(gh, apiBudget, { deadline = Infinity, clock = Date.now } = {}) {
  const limit = Math.min(gh.calls + Math.max(0, apiBudget), gh.budget ?? Infinity);
  return { can: (n = 1) => gh.calls + n <= limit && clock() < deadline, left: () => Math.max(0, limit - gh.calls) };
}

const runsPath = (repo, q) => `repos/${repo}/actions/workflows/ci.yml/runs?${q}`;
const dayQuery = (event, status, from, to, page) => {
  const q = new URLSearchParams({ event, created: `${iso(from)}..${iso(to - 1000)}`, per_page: '100', page: String(page) });
  if (status) q.set('status', status);
  return q;
};
const createdIn = (r, start, end) => ms(r.created_at) >= start && ms(r.created_at) < end;
const uniqueRuns = (runs) => [...new Map(runs.map((r) => [r.id, r])).values()];

// Every CI run of `event` created in [start, end), one UTC day per query.
// `complete` is false past a day's 1,000-result cap, on a failed read, or when
// the budget ran out.
async function listRuns(gh, m, { repo, start, end, event, status = null, onError }) {
  const runs = [];
  for (let d = start; d < end; d += DAY) {
    for (let page = 1; page <= LIST_PAGES; page++) {
      if (!m.can()) {
        onError(`${event} run listing: the API budget or time limit ran out`);
        return { runs: [], complete: false };
      }
      const res = await gh.rest('GET', runsPath(repo, dayQuery(event, status, d, Math.min(d + DAY, end), page)));
      if (res.status !== 200) {
        onError(`${event} run listing: ${res.status}`);
        return { runs: [], complete: false };
      }
      if (page === 1 && (res.body.total_count ?? 0) > LIST_PAGES * 100) {
        onError(`${event} run listing: ${res.body.total_count} runs on ${iso(d).slice(0, 10)}, over the 1,000-result cap`);
        return { runs: [], complete: false };
      }
      const list = res.body.workflow_runs ?? [];
      runs.push(...list);
      if (list.length < 100) break;
    }
  }
  return { runs: uniqueRuns(runs).filter((r) => createdIn(r, start, end)), complete: true };
}

// Every k-th run (by position in each day's listing) of `event`/`status`,
// k chosen so about `max` runs are read and the pages fit `budget`.
// `k` is null when the listing could not be read.
async function sampleRuns(gh, m, { repo, start, end, event, status, max, budget, onError }) {
  const days = [];
  for (let d = start; d < end; d += DAY) {
    if (!m.can()) {
      onError(`${event} run listing: the API budget or time limit ran out`);
      return { runs: [], k: null };
    }
    const to = Math.min(d + DAY, end);
    const res = await gh.rest('GET', runsPath(repo, dayQuery(event, status, d, to, 1)));
    if (res.status !== 200) {
      onError(`${event} run listing: ${res.status}`);
      return { runs: [], k: null };
    }
    const total = res.body.total_count ?? 0;
    if (total > LIST_PAGES * 100) {
      onError(`${event} run listing: ${total} runs on ${iso(d).slice(0, 10)}, over the 1,000-result cap`);
      return { runs: [], k: null };
    }
    days.push({ d, to, total, pages: new Map([[1, res.body.workflow_runs ?? []]]) });
  }
  const total = days.reduce((n, day) => n + day.total, 0);
  const picks = (day, k) => Array.from({ length: Math.ceil(day.total / k) }, (_, j) => j * k);
  const pagesFor = (day, k) => new Set(picks(day, k).map((i) => Math.floor(i / 100) + 1).filter((p) => p > 1));
  const cost = (k) => days.reduce((n, day) => n + pagesFor(day, k).size, 0);
  const room = Math.min(budget, m.left());
  let k = Math.max(1, Math.ceil(total / max));
  while (cost(k) > room) k *= 2;
  const runs = [];
  for (const day of days) {
    for (const page of pagesFor(day, k)) {
      if (!m.can()) {
        onError(`${event} run listing: the API budget or time limit ran out`);
        return { runs: [], k: null };
      }
      const res = await gh.rest('GET', runsPath(repo, dayQuery(event, status, day.d, day.to, page)));
      if (res.status !== 200) {
        onError(`${event} run listing: ${res.status}`);
        return { runs: [], k: null };
      }
      day.pages.set(page, res.body.workflow_runs ?? []);
    }
    for (const i of picks(day, k)) {
      const r = day.pages.get(Math.floor(i / 100) + 1)?.[i % 100];
      if (r) runs.push(r);
    }
  }
  return { runs: uniqueRuns(runs).filter((r) => createdIn(r, start, end)), k };
}

const EVENT_FIELDS = `
  __typename
  ... on AddedToMergeQueueEvent { id createdAt }
  ... on RemovedFromMergeQueueEvent { id createdAt reason }`;

const SCAN_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        updatedAt
        mergedAt
        headRefOid
        isCrossRepository
        timelineItems(last: ${TIMELINE_LAST}, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { ${EVENT_FIELDS} }
        }
      }
    }
  }
}`;

const PR_EVENTS_QUERY = `query($owner: String!, $name: String!, $n: Int!, $after: String, $since: DateTime!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      timelineItems(first: 100, after: $after, since: $since, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes { ${EVENT_FIELDS} }
      }
    }
  }
}`;

const queueEvent = (ev) => (ev.__typename === 'AddedToMergeQueueEvent' ? { type: 'added', id: ev.id, at: ev.createdAt } : { type: 'removed', id: ev.id, at: ev.createdAt, reason: ev.reason ?? null });
const byTime = (a, b) => ms(a.at) - ms(b.at);

// Every queue event of one PR since `since`: { events } or { error }. For a
// PR whose queue events outrun the scan's last 50 (an auto-merge loop
// re-adding itself all week).
async function prQueueEvents(gh, m, { repo, pr, since }) {
  const [owner, name] = repo.split('/');
  const events = [];
  let after = null;
  for (let page = 0; page < PR_EVENT_PAGES; page++) {
    if (!m.can()) return { error: 'the API budget or time limit ran out' };
    const conn = (await gh.graphql(PR_EVENTS_QUERY, { owner, name, n: pr, after, since: iso(since) }))?.repository?.pullRequest?.timelineItems;
    if (!conn) return { error: 'no timeline in the answer' };
    events.push(...conn.nodes.map(queueEvent));
    if (!conn.pageInfo.hasNextPage) return { events: events.sort(byTime) };
    after = conn.pageInfo.endCursor;
  }
  return { error: `more than ${PR_EVENT_PAGES * 100} queue events since ${iso(since)}` };
}

// Queue events of every PR updated since `start` (a queue event bumps a PR's
// updatedAt): [{ pr, mergedAt, headSha, isFork, events, eventsFrom }],
// events oldest first. `eventsFrom` is null when every queue event of the PR
// was read, else the time from which they all were. A PR with more queue
// events than the scan reads, the oldest read inside the week, is read again
// on its own from EVENT_LOOKBACK_MS before the week. `complete` is false when
// the pages or budget ran out first, or that second read did not fit.
async function scanQueueEvents(gh, m, { repo, start, onError }) {
  const [owner, name] = repo.split('/');
  const prs = [];
  let after = null;
  for (let page = 0; page < SCAN_PAGES; page++) {
    if (!m.can()) {
      onError('queue event scan: the API budget or time limit ran out');
      return { prs, complete: false };
    }
    let conn;
    try {
      conn = (await gh.graphql(SCAN_QUERY, { owner, name, after }))?.repository?.pullRequests;
    } catch (e) {
      if (e.name === 'BudgetExceeded') throw e;
      onError(`queue event scan: ${e.message}`);
      return { prs, complete: false };
    }
    if (!conn) {
      onError('queue event scan: no pullRequests in the answer');
      return { prs, complete: false };
    }
    for (const p of conn.nodes) {
      // hasPreviousPage, not totalCount: with itemTypes, GitHub's totalCount
      // counts more than the nodes it serves (20 for 6 events, seen live).
      const items = p.timelineItems ?? { nodes: [], pageInfo: { hasPreviousPage: false } };
      let events = items.nodes.map(queueEvent).sort(byTime);
      let eventsFrom = null;
      if (items.pageInfo?.hasPreviousPage && events.length) {
        eventsFrom = ms(events[0].at);
        if (eventsFrom >= start) {
          const since = start - EVENT_LOOKBACK_MS;
          let all;
          try {
            all = await prQueueEvents(gh, m, { repo, pr: p.number, since });
          } catch (e) {
            if (e.name === 'BudgetExceeded') throw e;
            all = { error: e.message };
          }
          if (all.error) {
            onError(`queue event scan: PR ${p.number}: ${all.error}`);
            return { prs, complete: false };
          }
          events = all.events;
          eventsFrom = since;
        }
      }
      prs.push({ pr: p.number, mergedAt: p.mergedAt ?? null, headSha: p.headRefOid, isFork: Boolean(p.isCrossRepository), events, eventsFrom });
    }
    const oldest = conn.nodes.at(-1)?.updatedAt;
    if (!conn.pageInfo.hasNextPage || !oldest || ms(oldest) < start) return { prs, complete: true };
    after = conn.pageInfo.endCursor;
  }
  onError(`queue event scan: stopped at ${SCAN_PAGES} pages`);
  return { prs, complete: false };
}

// ── Formatting ───────────────────────────────────────────────────────────

const minutes = (x) => (x / 60_000).toFixed(1);
const pair = (vals, unit) => `${minutes(percentile(vals, 50))} / ${minutes(percentile(vals, 90))} ${unit}`;
const coverageOf = (k) => (k > 1 ? `sampled 1/${k}` : 'exact');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const prList = (prs) => {
  const list = [...prs].sort((a, b) => a - b);
  const shown = list.slice(0, MAX_LISTED_PRS).map((n) => `PR ${n}`).join(', ');
  return list.length > MAX_LISTED_PRS ? `${shown} and ${list.length - MAX_LISTED_PRS} more` : shown;
};

// ── The rows ─────────────────────────────────────────────────────────────

const ttg = (runs) => runs.map((r) => ms(r.updated_at) - ms(r.run_started_at ?? r.created_at)).filter((x) => Number.isFinite(x) && x >= 0);

// Per PR merged in the week through the queue: its merged head's first add
// to the queue → its `merged` removal (or mergedAt). The merged head's
// arrival is its first non-queue CI run (headPushedAt): one call per PR.
async function queueLatency(gh, m, { repo, prs, start, end, budget, onError }) {
  const merged = prs.filter((p) => p.mergedAt && ms(p.mergedAt) >= start && ms(p.mergedAt) < end && p.events.some((e) => e.type === 'added'));
  const k = Math.max(1, Math.ceil(merged.length / Math.max(1, Math.min(budget, m.left()))));
  const values = [];
  let undetermined = 0;
  for (let i = 0; i < merged.length; i += k) {
    const p = merged[i];
    if (!m.can()) {
      onError('queue latency: the API budget or time limit ran out');
      return { k: null };
    }
    let pushed = null;
    try {
      pushed = await headPushedAt(gh, { repo, headSha: p.headSha });
    } catch (e) {
      if (e.name === 'BudgetExceeded') throw e;
      onError(`queue latency: PR ${p.pr} head arrival not read: ${e.message}`);
    }
    // Events before `eventsFrom` were not read: an earlier add may hide there.
    const unread = pushed && p.eventsFrom !== null && ms(pushed) < p.eventsFrom;
    const first = pushed && !unread && p.events.find((e) => e.type === 'added' && ms(e.at) >= ms(pushed));
    const done = p.events.filter((e) => e.type === 'removed' && e.reason === 'merged').at(-1)?.at ?? p.mergedAt;
    if (!first || ms(done) < ms(first.at)) {
      undetermined++;
      continue;
    }
    values.push(ms(done) - ms(first.at));
  }
  return { k, values, undetermined, total: merged.length };
}

// The class of each failed_checks removal of the week: from the decisions
// log, else classified now (every k-th, inside `budget`). A fork's run is
// never read: it counts as unknown.
async function removalClasses(gh, m, { removals, log, budget, classifyRemoval, onError }) {
  const logged = new Map();
  for (const e of log) {
    if (!e || typeof e !== 'object' || !e.removalId || e.kind === 'noop' || typeof e.class !== 'string') continue;
    const prev = logged.get(e.removalId);
    if (!prev || ms(e.at) >= ms(prev.at)) logged.set(e.removalId, e);
  }
  const out = [];
  const missing = [];
  for (const r of removals) {
    const e = logged.get(r.id);
    if (e) out.push({ ...r, class: e.class, real: e.kind === 'hold' && e.holdReason === 'real', weight: 1 });
    else if (r.isFork) out.push({ ...r, class: 'unknown', real: false, weight: 1 });
    else missing.push(r);
  }
  if (!missing.length) return { list: out, k: 1 };
  if (!classifyRemoval) {
    onError('queue failures: no ci.yml to classify unlogged removals with');
    return { list: out, k: null };
  }
  const affordable = Math.floor(Math.min(budget, m.left()) / CLASSIFY_COST);
  if (affordable < 1) {
    onError(`queue failures: no budget to classify ${missing.length} unlogged removals`);
    return { list: out, k: null };
  }
  const k = Math.ceil(missing.length / affordable);
  const picked = [];
  for (let i = 0; i < missing.length; i += k) picked.push(missing[i]);
  // Each sampled removal stands for missing/picked of them (not k: ceil
  // leaves fewer than missing/k picks), so the weights sum to `missing`.
  const weight = missing.length / picked.length;
  let failed = 0;
  for (const r of picked) {
    if (!m.can(CLASSIFY_COST)) {
      onError('queue failures: the API budget or time limit ran out while classifying');
      return { list: out, k: null };
    }
    try {
      const cls = (await classifyRemoval(gh, r)) ?? 'unknown';
      out.push({ ...r, class: cls, real: cls === 'real', weight });
    } catch (e) {
      if (e.name === 'BudgetExceeded') throw e;
      // Not a class: counted apart, never as unknown (which reads as a measurement).
      failed++;
      onError(`queue failures: PR ${r.pr} removal not classified: ${e.message}`);
    }
  }
  return { list: out, k, failed: failed * weight };
}

// A removal's class from its group run, as the tick would have classified it
// (the PR's files as they are now). No group run → unknown.
export const runClassifier =
  ({ repo, ciYml, repoRoot, history }) =>
  async (gh, r) => {
    const snapshot = await prSnapshot(gh, { repo, pr: r.pr, withFiles: true });
    const ref = await groupRunFor(gh, { repo, pr: r.pr, removal: r });
    if (!ref) return 'unknown';
    const facts = await runFacts(gh, { repo, runId: ref.id, ciYml });
    return classifyRun(facts, { prFiles: new Set(snapshot.files), history, repoRoot, pr: r.pr, now: ms(r.at), requiredJobs: requiredJobIds(ciYml) }).class;
  };

// Σ job durations and the Linux runner waits, from every k-th merge_group run.
// The first run's job count (filter=all: every attempt) sizes k, with a
// margin for re-run attempts.
async function jobStats(gh, m, { repo, runs, budget }) {
  if (!runs.length) return { k: 1, seconds: 0, linux: 0, waited: 0 };
  const jobsPage = (run, page) => gh.rest('GET', `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
  if (!m.can()) return { k: null, error: 'jobs: the API budget or time limit ran out' };
  const first = await jobsPage(runs[0], 1);
  if (first.status !== 200) return { k: null, error: `jobs of run ${runs[0].id}: ${first.status}` };
  const perRun = 1.5 * Math.max(1, Math.ceil((first.body.total_count ?? 0) / 100));
  const room = Math.min(budget, m.left() + 1);
  const k = Math.max(1, Math.ceil((runs.length * perRun) / Math.max(1, room)));
  let seconds = 0;
  let linux = 0;
  let waited = 0;
  let sampled = 0;
  for (let i = 0; i < runs.length; i += k) {
    sampled++;
    for (let page = 1; page <= JOB_PAGES; page++) {
      let res = i === 0 && page === 1 ? first : null;
      if (!res) {
        if (!m.can()) return { k: null, error: 'jobs: the API budget or time limit ran out' };
        res = await jobsPage(runs[i], page);
      }
      if (res.status !== 200) return { k: null, error: `jobs of run ${runs[i].id}: ${res.status}` };
      const jobs = res.body.jobs ?? [];
      for (const j of jobs) {
        const took = ms(j.completed_at) - ms(j.started_at);
        if (Number.isFinite(took) && took > 0) seconds += took / 1000;
        const ubuntu = (j.labels ?? []).some((l) => typeof l === 'string' && l.startsWith('ubuntu-'));
        const wait = ms(j.started_at) - ms(j.created_at);
        if (ubuntu && j.conclusion !== 'skipped' && Number.isFinite(wait)) {
          linux++;
          if (wait > WAIT_LIMIT_S * 1000) waited++;
        }
      }
      if (jobs.length < 100) break;
      if (page === JOB_PAGES) return { k: null, error: `jobs of run ${runs[i].id}: over ${JOB_PAGES * 100}` };
    }
  }
  // Scaled by runs/sampled, not k: ceil(runs/k) runs were read.
  return { k, seconds: (seconds * runs.length) / sampled, linux, waited };
}

// Re-adds after a failed_checks removal of the same head that no act-mode
// shepherd requeue or record covered within 15 min, plus act-mode resume
// releases. Same head: the PR's current head arrived (headPushedAt) before
// the removal. Arrived between the removal and the re-add: the author pushed,
// not counted. Arrived after the re-add: cannot tell, listed as undetermined.
// Available only when every same-repo removal of the week has an act-mode
// decision: a removal decided in shadow (or not at all) has no shepherd
// requeue to cover its re-add, which would then read as a human's.
async function humanReadds(gh, m, { repo, removals, prs, log, start, end, onError }) {
  const inWeek = (at) => ms(at) >= start && ms(at) < end;
  const act = log.filter((e) => e && e.mode === 'act' && typeof e.at === 'string');
  if (!act.some((e) => inWeek(e.at))) return { available: false };
  const decided = new Set(act.map((e) => e.removalId).filter(Boolean));
  if (removals.some((r) => !r.isFork && !decided.has(r.id))) return { available: false };
  const byPr = new Map(prs.map((p) => [p.pr, p]));
  const pushedOf = new Map();
  const humans = new Set();
  let count = 0;
  let undetermined = 0;
  for (const r of removals) {
    if (r.isFork) continue;
    const readd = byPr.get(r.pr).events.find((e) => e.type === 'added' && ms(e.at) > ms(r.at));
    if (!readd) continue;
    const covered = act.some((e) => e.removalId === r.id && (e.kind === 'requeue' || e.kind === 'record') && e.status === 'applied' && ms(e.at) <= ms(r.at) + COVER_WINDOW_MS);
    if (covered) continue;
    if (!pushedOf.has(r.pr)) {
      if (!m.can()) {
        onError('human re-adds: the API budget or time limit ran out');
        return { available: false };
      }
      let pushed = null;
      try {
        pushed = await headPushedAt(gh, { repo, headSha: byPr.get(r.pr).headSha });
      } catch (e) {
        if (e.name === 'BudgetExceeded') throw e;
        onError(`human re-adds: PR ${r.pr} head arrival not read: ${e.message}`);
      }
      pushedOf.set(r.pr, pushed);
    }
    const pushed = pushedOf.get(r.pr);
    if (pushed && ms(pushed) <= ms(r.at)) {
      count++;
      humans.add(r.pr);
    } else if (!pushed || ms(pushed) > ms(readd.at)) {
      undetermined++;
    }
  }
  const resumes = new Set(act.filter((e) => e.kind === 'resume' && e.status === 'applied' && inWeek(e.at)).map((e) => e.actionId));
  return { available: true, count: count + resumes.size, readds: count, resumes: resumes.size, prs: humans, undetermined };
}

// MetricRow[] = { name, value, baseline, target, coverage } in ROWS order.
// `decisionsLog`: the parsed decisions.jsonl. `ciYml`, `repoRoot` and
// `history` (a History) classify removals the log has no class for; without
// `ciYml` they are left out and the row is unavailable. `onError(message)`
// hears every read that made a row unavailable. `classifyRemoval(gh,
// removal) → class` replaces the run classifier (tests). `deadline` (ms,
// against `clock`): no read starts after it.
export async function weekMetrics(gh, { repo, week, decisionsLog = [], apiBudget = DEFAULT_API_BUDGET, ciYml = null, repoRoot = null, history = History.fromSightings([]), classifyRemoval = ciYml ? runClassifier({ repo, ciYml, repoRoot, history }) : null, onError = () => {}, deadline = Infinity, clock = Date.now }) {
  const { start, end } = weekBounds(week);
  const m = meter(gh, apiBudget, { deadline, clock });
  const rows = Object.fromEntries(ROWS.map((r) => [r.key, { name: r.name, value: '—', baseline: r.baseline, target: r.target, coverage: 'unavailable' }]));
  const set = (key, value, coverage) => Object.assign(rows[key], { value, coverage });
  const log = Array.isArray(decisionsLog) ? decisionsLog : [];

  // 1. Queue runs (every status: the runner-hours read them all).
  const queue = await listRuns(gh, m, { repo, start, end, event: 'merge_group', onError });
  if (queue.complete) {
    const green = ttg(queue.runs.filter((r) => r.conclusion === 'success'));
    set('queue_ttg', green.length ? `${pair(green, 'min')} (${plural(green.length, 'run')})` : 'no green runs', 'exact');
  }
  // 3. PR runs, sampled.
  const pr = await sampleRuns(gh, m, { repo, start, end, event: 'pull_request', status: 'success', max: PR_RUN_SAMPLE_MAX, budget: Math.floor(m.left() * 0.1), onError });
  if (pr.k !== null) {
    const vals = ttg(pr.runs);
    set('pr_ttg', vals.length ? `${pair(vals, 'min')} (${plural(vals.length, 'run')}${pr.k > 1 ? ' read' : ''})` : 'no green runs', coverageOf(pr.k));
  }
  // The queue events behind rows 2, 4, 7 and 8.
  const scan = await scanQueueEvents(gh, m, { repo, start, onError });
  const removals = scan.complete
    ? scan.prs.flatMap((p) => p.events.filter((e) => e.type === 'removed' && e.reason === 'failed_checks' && ms(e.at) >= start && ms(e.at) < end).map((e) => ({ ...e, pr: p.pr, isFork: p.isFork })))
    : [];
  // 2. Queue latency.
  if (scan.complete) {
    const lat = await queueLatency(gh, m, { repo, prs: scan.prs, start, end, budget: Math.floor(m.left() * 0.25), onError });
    const read = lat.k === null ? 0 : lat.values.length + lat.undetermined;
    if (lat.k !== null && lat.undetermined > MAX_UNDETERMINED_SHARE * read) {
      // Dropping that many would bias the percentiles.
      onError(`queue latency: ${lat.undetermined} of ${read} merged PRs undetermined`);
    } else if (lat.k !== null) {
      const tail = lat.undetermined ? `; ${lat.undetermined} undetermined` : '';
      const n = lat.values.length;
      set('queue_latency', n ? `${pair(lat.values, 'min')} (${plural(n, 'merged PR')}${lat.k > 1 ? ' read' : ''}${tail})` : 'no merged PRs', coverageOf(lat.k));
    }
  }
  // 4 and 7. Removal classes.
  if (scan.complete) {
    const cls = await removalClasses(gh, m, { removals, log, budget: Math.floor(m.left() * 0.4), classifyRemoval, onError });
    if (cls.k !== null) {
      const by = {};
      for (const r of cls.list) by[r.class] = (by[r.class] ?? 0) + r.weight;
      const approx = cls.k > 1 ? '≈' : '';
      const num = (n) => `${approx}${Math.round(n)}`;
      const flaky = FLAKE_CLASSES.reduce((n, c) => n + (by[c] ?? 0), 0);
      const parts = Object.entries(by)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([c, n]) => `${c} ${num(n)}`);
      if (cls.failed) parts.push(`${num(cls.failed)} not classified`);
      set('queue_flaky', removals.length ? `${num(flaky)} of ${removals.length} (${parts.join(', ')})` : '0 of 0', coverageOf(cls.k));
      // Sampled: the PRs read are a lower bound on the week's.
      const real = new Set(cls.list.filter((r) => r.real).map((r) => r.pr));
      const atLeast = cls.k > 1 ? 'at least ' : '';
      set('real_caught', real.size ? `${atLeast}${plural(real.size, 'PR')}: ${prList(real)} (unadjudicated)` : cls.k > 1 ? 'none in the sample' : '0 PRs', coverageOf(cls.k));
    }
  }
  // 8. Human re-adds: act mode only. Before the jobs, which take what is left.
  if (scan.complete) {
    const h = await humanReadds(gh, m, { repo, removals, prs: scan.prs, log, start, end, onError });
    if (h.available) {
      const detail = [h.prs.size ? prList(h.prs) : null, h.resumes ? `${plural(h.resumes, 'resume label')}` : null, h.undetermined ? `${h.undetermined} undetermined` : null].filter(Boolean);
      set('human_readds', `${h.count}${detail.length ? ` (${detail.join('; ')})` : ''}`, 'exact');
    }
  }
  // 5 and 6. Jobs of the queue runs.
  if (queue.complete) {
    const jobs = await jobStats(gh, m, { repo, runs: queue.runs, budget: m.left() });
    if (jobs.error) onError(jobs.error);
    if (jobs.k !== null) {
      const approx = jobs.k > 1 ? '≈' : '';
      set('runner_hours', `${approx}${Math.round(jobs.seconds / 3600).toLocaleString('en-US')} h (${plural(queue.runs.length, 'run')})`, coverageOf(jobs.k));
      set('linux_wait', jobs.linux ? `${((100 * jobs.waited) / jobs.linux).toFixed(1)}% (${jobs.waited} of ${jobs.linux} jobs${jobs.k > 1 ? ' read' : ''})` : 'no Linux jobs', coverageOf(jobs.k));
    }
  }
  return ROWS.map((r) => rows[r.key]);
}

// ── The post ─────────────────────────────────────────────────────────────

export const marker = (week) => `<!-- ci-metrics:v1 week=${week} -->`;

const cell = (s) => String(s).replace(/[|\r\n]+/g, ' ');
const day = (t) => iso(t).slice(0, 10);

export function renderWeekly({ week, rows }) {
  const { start, end } = weekBounds(week);
  return [
    `**CI throughput, week ${week}** (Mon ${day(start)} 00:00Z to Sun ${day(end - DAY)} 24:00Z)`,
    '',
    '| Metric | This week | Baseline (week of 10-21) | Target | Coverage |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.name)} | ${cell(r.value)} | ${cell(r.baseline)} | ${cell(r.target)} | ${cell(r.coverage)} |`),
    '',
    'Targets are proposals, not claims. Failed, cancelled and re-run runs count wherever cost or latency is measured.',
    'Coverage: `exact` read every run, job or PR; `sampled 1/k` read every k-th to stay inside the API budget, and ≈ marks a value scaled up from that sample; `unavailable` means the data could not be read in full, so no value is shown.',
    'Real interactions are listed unadjudicated: whether each hold caught a real bug is a human call.',
    '',
    marker(week),
    '',
  ].join('\n');
}

const ISSUE_BODY = [
  'One comment per ISO week (Monday to Sunday, UTC) with the CI throughput metrics from the CI throughput design spec, posted by the CI shepherd on the first act-mode tick after Monday 13:00Z.',
  '',
  'Comments here are kept by the shepherd. It never edits this description.',
  '',
].join('\n');

// The metrics issue: `known` (an issue number remembered from an earlier
// post) when it is still the operator's issue with this title, else the
// operator's oldest issue labelled ci-metrics with this title, else null.
// `complete: false`: the listing was cut short, so a missing issue is not
// proof there is none.
async function findIssue(gh, { repo, viewer, known }) {
  const fits = (i) => i && !i.pull_request && i.user?.login === viewer && i.title === METRICS_TITLE;
  if (Number.isInteger(known)) {
    const res = await gh.rest('GET', `repos/${repo}/issues/${known}`);
    if (res.status === 200 && fits(res.body)) return { issue: known, complete: true };
    if (res.status !== 200 && res.status !== 404 && res.status !== 410) throw new Error(`metrics issue ${known}: ${res.status}`);
  }
  const found = [];
  for (let page = 1; page <= ISSUE_PAGES; page++) {
    const q = new URLSearchParams({ labels: METRICS_LABEL, creator: viewer, state: 'all', per_page: '100', page: String(page) });
    const res = await gh.rest('GET', `repos/${repo}/issues?${q}`);
    if (res.status !== 200) throw new Error(`metrics issue listing: ${res.status}`);
    found.push(...res.body.filter(fits).map((i) => i.number));
    if (res.body.length < 100) return { issue: found.length ? Math.min(...found) : null, complete: true };
  }
  return { issue: found.length ? Math.min(...found) : null, complete: false };
}

// True when the operator already posted this week's comment. Throws when the
// comments cannot all be read: a repeat post is worse than a late one.
async function alreadyPosted(gh, { repo, issue, viewer, week }) {
  const tag = marker(week);
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const res = await gh.rest('GET', `repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
    if (res.status !== 200) throw new Error(`metrics issue ${issue} comments: ${res.status}`);
    if (res.body.some((c) => c.user?.login === viewer && typeof c.body === 'string' && c.body.includes(tag))) return true;
    if (res.body.length < 100) return false;
  }
  throw new Error(`metrics issue ${issue}: over ${COMMENT_PAGES * 100} comments; not posting`);
}

// → { status: 'posted' | 'noop' | 'shadow', issue, body }. Idempotent on the
// week's marker in an operator-written comment, so a crash after the post (or
// a lost local state) never posts twice. Writes only through `writer`.
export async function postWeekly(gh, { repo, week, rows, writer = null, viewer, knownIssue = null }) {
  if (!viewer) throw new Error('postWeekly: the operator login is required');
  const body = renderWeekly({ week, rows });
  const found = await findIssue(gh, { repo, viewer, known: knownIssue });
  if (found.issue !== null && (await alreadyPosted(gh, { repo, issue: found.issue, viewer, week }))) return { status: 'noop', issue: found.issue, body };
  if (!writer) return { status: 'shadow', issue: found.issue, body };
  let issue = found.issue;
  if (issue === null) {
    if (!found.complete) throw new Error('metrics issue listing was cut short; not opening a second issue');
    await writer.ensureLabel(METRICS_LABEL, { color: '0e8a16', description: 'Weekly CI throughput metrics from the CI shepherd' });
    issue = await writer.createIssue({ title: METRICS_TITLE, body: ISSUE_BODY, labels: [METRICS_LABEL] });
  }
  await writer.postComment(issue, body);
  return { status: 'posted', issue, body };
}

// ── The tick's hook ──────────────────────────────────────────────────────

// t: the tick context (tick.mjs). `state.metrics` = { postedWeek, issue,
// triedWeek, triedAt }. Returns a short status for the tick summary.
export async function weeklyMetrics(t, { readLog = () => readJsonl(join(t.stateDir, 'decisions.jsonl')), compute = weekMetrics, post = postWeekly } = {}) {
  const week = dueWeek(t.now);
  if (!week) return { status: 'not_due' };
  const s = (t.state.metrics = { postedWeek: null, issue: null, triedWeek: null, triedAt: null, tries: 0, ...(t.state.metrics ?? {}) });
  if (s.postedWeek === week) return { status: 'posted', week };
  if (t.mode !== 'act') return { status: 'not_act', week };
  if (s.triedWeek === week && s.triedAt && t.now - ms(s.triedAt) < RETRY_MS) return { status: 'waiting', week };
  const left = t.gh.budget - t.gh.calls;
  if (left < MIN_TICK_BUDGET) return { status: 'deferred', week };
  s.tries = s.triedWeek === week ? s.tries + 1 : 1;
  s.triedWeek = week;
  s.triedAt = iso(t.now);
  t.save();
  const errors = [];
  let rows;
  try {
    const clock = t.clock ?? Date.now;
    rows = await compute(t.gh, { repo: t.repo, week, decisionsLog: readLog(), apiBudget: left - 50, ciYml: t.ciYml, repoRoot: t.repoRoot, history: t.history, onError: (e) => errors.push(e), clock, deadline: clock() + TICK_TIME_LIMIT_MS });
  } catch (e) {
    // The tick's own budget: the metrics wait an hour, the tick goes on.
    if (e.name !== 'BudgetExceeded') throw e;
    return { status: 'deferred', week };
  }
  for (const e of errors.slice(0, 3)) t.error(`metrics ${week}: ${e}`);
  if (errors.length > 3) t.error(`metrics ${week}: and ${errors.length - 3} more`);
  // A read that failed may pass in an hour. A week gets one comment, so it is
  // not spent on rows a transient error blanked, unless that keeps happening.
  if (errors.length && s.tries < MAX_DEGRADED_TRIES) return { status: 'retry', week };
  // Mode is re-read before the write batch.
  if ((await t.modeNow()) !== 'act') return { status: 'left_act', week };
  const res = await post(t.gh, { repo: t.repo, week, rows, writer: t.writer, viewer: t.viewer, knownIssue: s.issue });
  s.issue = res.issue ?? s.issue;
  if (res.status === 'posted' || res.status === 'noop') s.postedWeek = week;
  t.record({
    actionId: `metrics:${week}`,
    kind: 'metrics_post',
    pr: null,
    mutations: res.status === 'posted' ? [{ op: 'comment', args: { issue: res.issue } }] : [],
    reasons: [],
    mode: t.mode,
    status: res.status === 'posted' ? 'applied' : 'skipped',
    source: 'metrics',
    issue: res.issue,
    rows: rows.map((r) => ({ name: r.name, value: r.value, coverage: r.coverage })),
    at: iso(t.now),
  });
  return { status: res.status, week };
}
