import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MAX_DEGRADED_TRIES, METRICS_LABEL, METRICS_TITLE, MIN_TICK_BUDGET, RETRY_MS, dueWeek, isoWeek, marker, percentile, postWeekly, renderWeekly, weekBounds, weekMetrics, weeklyMetrics } from './metrics.mjs';

// Weekly CI throughput metrics (W06d, #10750), against an in-memory fake of
// the GitHub reads; writes go to a recording fake writer, never to GitHub.

const REPO = 'LanternOps/breeze';
const OP = 'operator';
const WEEK = '2026-W45'; // Mon 2026-11-02 .. Sun 2026-11-08
const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

function fakeGh({ runs = [], prs = [], jobs = {}, pushes = {}, issues = [], comments = {}, runsStatus = 200, budget = 100_000 } = {}) {
  const gh = { calls: 0, budget, requests: [] };
  const take = () => {
    if (gh.calls >= gh.budget) {
      const e = new Error('budget');
      e.name = 'BudgetExceeded';
      throw e;
    }
    gh.calls++;
  };
  const page = (list, q) => {
    const n = Number(q.get('page') ?? 1);
    const size = Number(q.get('per_page') ?? 30);
    return list.slice((n - 1) * size, n * size);
  };
  gh.rest = async (method, path) => {
    take();
    gh.requests.push(`${method} ${path}`);
    if (method !== 'GET') throw new Error(`fake gh: ${method} ${path}: writes go through the writer`);
    const url = new URL(`https://api.invalid/${path}`);
    const p = url.pathname.slice(1);
    const q = url.searchParams;
    if (p === `repos/${REPO}/actions/workflows/ci.yml/runs`) {
      if (runsStatus !== 200) return { status: runsStatus, body: { message: 'boom' } };
      const [a, b] = q.get('created').split('..');
      const list = runs
        .filter((r) => r.event === q.get('event') && (!q.get('status') || r.conclusion === q.get('status')) && ms(r.created_at) >= ms(a) && ms(r.created_at) <= ms(b))
        .sort((x, y) => ms(y.created_at) - ms(x.created_at) || y.id - x.id);
      return { status: 200, body: { total_count: list.length, workflow_runs: page(list, q) } };
    }
    if (p === `repos/${REPO}/actions/runs` && q.get('head_sha')) {
      const sha = q.get('head_sha');
      return { status: 200, body: { workflow_runs: pushes[sha] ? [{ head_sha: sha, event: 'pull_request', created_at: pushes[sha] }] : [] } };
    }
    let m = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    if (m) {
      const list = jobs[m[1]] ?? [];
      return { status: 200, body: { total_count: list.length, jobs: page(list, q) } };
    }
    if (p === `repos/${REPO}/issues`) {
      const list = issues.filter((i) => (!q.get('labels') || i.labels.includes(q.get('labels'))) && (!q.get('creator') || i.user.login === q.get('creator')));
      return { status: 200, body: page(list, q) };
    }
    m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(p);
    if (m) {
      const i = issues.find((x) => x.number === Number(m[1]));
      return i ? { status: 200, body: i } : { status: 404, body: { message: 'Not Found' } };
    }
    m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(p);
    if (m) return { status: 200, body: page(comments[m[1]] ?? [], q) };
    return { status: 404, body: { message: `fake gh: unrouted ${path}` } };
  };
  const node = ([type, id, at, reason]) => (type === 'added' ? { __typename: 'AddedToMergeQueueEvent', id, createdAt: at } : { __typename: 'RemovedFromMergeQueueEvent', id, createdAt: at, reason });
  gh.graphql = async (query, vars = {}) => {
    take();
    gh.requests.push(/pullRequest\(number/.test(query) ? `POST graphql pr ${vars.n} after=${vars.after}` : 'POST graphql');
    // One PR's queue events since `since`, 100 a page (cursor = offset).
    if (/pullRequest\(number/.test(query)) {
      const list = prs.find((p) => p.pr === vars.n).events.filter((e) => ms(e[2]) >= ms(vars.since));
      const from = Number(vars.after ?? 0);
      return { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: from + 100 < list.length, endCursor: String(from + 100) }, nodes: list.slice(from, from + 100).map(node) } } } };
    }
    if (!/pullRequests\(/.test(query)) throw new Error('fake gh: unhandled query');
    const nodes = prs.map((p) => ({
      number: p.pr,
      updatedAt: p.updatedAt ?? '2026-11-08T12:00:00Z',
      mergedAt: p.mergedAt ?? null,
      headRefOid: p.head,
      isCrossRepository: Boolean(p.fork),
      // timelineItems(last: 50). Like GitHub, totalCount over-counts.
      timelineItems: { totalCount: p.events.length + 14, pageInfo: { hasPreviousPage: p.events.length > 50 }, nodes: p.events.slice(-50).map(node) },
    }));
    return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
  };
  return gh;
}

function fakeWriter() {
  const writes = [];
  let next = 900;
  return {
    writes,
    async ensureLabel(name, opts) {
      writes.push({ op: 'ensure_label', name, opts });
    },
    async createIssue(fields) {
      writes.push({ op: 'create_issue', ...fields });
      return next++;
    },
    async postComment(issue, body) {
      writes.push({ op: 'comment', issue, body });
      return 1;
    },
  };
}

const run = (id, event, conclusion, created, minutes) => ({ id, event, conclusion, created_at: created, run_started_at: created, updated_at: iso(ms(created) + minutes * 60_000) });
const job = (labels, created, waitS, tookMin, conclusion = 'success') => ({
  labels,
  conclusion,
  created_at: created,
  started_at: iso(ms(created) + waitS * 1000),
  completed_at: iso(ms(created) + waitS * 1000 + tookMin * 60_000),
});

// One synthetic week. Queue runs: three green (10, 30 and 20 min; the last
// created Sun 23:59Z), one red; runs from the weeks either side. PR runs:
// 20, 40, 10 min. PR 501 merged through the queue (an add before its last
// push does not count). Removals: 502 re-queued by GitHub (logged record),
// 503 held real and re-added by hand an hour later on the same head, 504 a
// fork nobody logged, 505 re-queued by the shepherd. One resume release.
function syntheticWeek() {
  const runs = [
    run(9000, 'merge_group', 'success', '2026-11-01T23:59:00Z', 5),
    run(9001, 'merge_group', 'success', '2026-11-02T10:00:00Z', 10),
    run(9002, 'merge_group', 'success', '2026-11-03T10:00:00Z', 30),
    run(9003, 'merge_group', 'failure', '2026-11-04T10:00:00Z', 20),
    run(9004, 'merge_group', 'success', '2026-11-08T23:59:00Z', 20),
    run(9005, 'merge_group', 'success', '2026-11-09T00:00:00Z', 5),
    run(8001, 'pull_request', 'success', '2026-11-02T09:00:00Z', 20),
    run(8002, 'pull_request', 'success', '2026-11-05T09:00:00Z', 40),
    run(8003, 'pull_request', 'success', '2026-11-06T09:00:00Z', 10),
    run(8004, 'pull_request', 'failure', '2026-11-06T10:00:00Z', 90),
  ];
  const jobs = {
    9001: [job(['ubuntu-latest'], '2026-11-02T10:00:00Z', 60, 8), job(['ubuntu-latest'], '2026-11-02T10:00:00Z', 420, 3)],
    9002: [job(['ubuntu-24.04'], '2026-11-03T10:00:00Z', 30, 29.5), job(['macos-latest'], '2026-11-03T10:00:00Z', 1200, 5), job(['ubuntu-latest'], '2026-11-03T10:00:00Z', 0, 0, 'skipped')],
    9003: [job(['ubuntu-latest'], '2026-11-04T10:00:00Z', 360, 14)],
    9004: [job(['ubuntu-latest'], '2026-11-08T23:59:00Z', 30, 19.5)],
  };
  const prs = [
    { pr: 501, head: 'a501', mergedAt: '2026-11-04T12:05:00Z', events: [['added', 'A501a', '2026-11-04T11:00:00Z'], ['added', 'A501b', '2026-11-04T11:05:00Z'], ['removed', 'R501', '2026-11-04T12:05:00Z', 'merged']] },
    { pr: 502, head: 'a502', events: [['removed', 'R502', '2026-11-05T08:00:00Z', 'failed_checks'], ['added', 'A502', '2026-11-05T08:02:00Z']] },
    { pr: 503, head: 'a503', events: [['removed', 'R503', '2026-11-06T08:00:00Z', 'failed_checks'], ['added', 'A503', '2026-11-06T09:00:00Z']] },
    { pr: 504, head: 'a504', fork: true, events: [['removed', 'R504', '2026-11-07T08:00:00Z', 'failed_checks']] },
    { pr: 505, head: 'a505', events: [['removed', 'R505', '2026-11-07T09:00:00Z', 'failed_checks'], ['added', 'A505', '2026-11-07T09:03:00Z']] },
  ];
  const pushes = { a501: '2026-11-04T11:02:00Z', a503: '2026-11-06T07:00:00Z' };
  const log = [
    { removalId: 'R502', pr: 502, kind: 'record', class: 'suspected_flake', mode: 'act', status: 'applied', at: '2026-11-05T08:01:00Z' },
    { removalId: 'R503', pr: 503, kind: 'hold', holdReason: 'real', class: 'real', mode: 'act', status: 'applied', at: '2026-11-06T08:01:00Z' },
    { removalId: 'R505', pr: 505, kind: 'requeue', class: 'infra', mode: 'act', status: 'applied', at: '2026-11-07T09:01:00Z' },
    { actionId: '506:abc:resume:n1s0', pr: 506, kind: 'resume', mode: 'act', status: 'applied', at: '2026-11-07T10:00:00Z' },
  ];
  return { runs, jobs, prs, pushes, log };
}

const EXPECTED_TABLE = `**CI throughput, week 2026-W45** (Mon 2026-11-02 00:00Z to Sun 2026-11-08 24:00Z)

| Metric | This week | Baseline (week of 10-21) | Target | Coverage |
|---|---|---|---|---|
| Queue run time-to-green p50 / p90 | 20.0 / 30.0 min (3 runs) | 24.8 / 44.1 min | < 8 / < 20 min | exact |
| Queue latency p50 / p90 (new) | 60.0 / 60.0 min (1 merged PR) | not measured | none set | exact |
| PR run time-to-green p50 / p90 | 20.0 / 40.0 min (3 runs) | 26.3 / 60.4 min | < 20 / < 35 min | exact |
| Queue failures that were flake/infra/external | 2 of 4 (infra 1, real 1, suspected_flake 1, unknown 1) | 57 of 71 | < 10 | exact |
| Queue runner-hours / week | 1 h (4 runs) | 5,485 h | −70% | exact |
| Linux jobs waiting > 5 min for a runner | 40.0% (2 of 5 jobs) | 22.9% | < 5% | exact |
| Real interactions caught (must not drop) | 1 PR: PR 503 (unadjudicated) | 5 PRs / 8 days | same catches, all in thin selection | exact |
| Re-enqueues needing a human | 2 (PR 503; 1 resume label) | not measured | ~0 | exact |
`;

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 90), 7);
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(ten, 91), 10);
  assert.equal(percentile(ten, 100), 10);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([3, 1, 2], 90), 3);
  assert.equal(percentile([1, Number.NaN, 2], 100), 2);
  assert.throws(() => percentile([1], 0));
  assert.throws(() => percentile([1], 101));
});

test('isoWeek and weekBounds follow ISO 8601', () => {
  assert.equal(isoWeek('2026-11-02T00:00:00Z'), '2026-W45');
  assert.equal(isoWeek('2026-11-08T23:59:59Z'), '2026-W45');
  assert.equal(isoWeek('2026-11-09T00:00:00Z'), '2026-W46');
  assert.equal(isoWeek('2026-01-01T00:00:00Z'), '2026-W01'); // a Thursday
  assert.equal(isoWeek('2027-01-01T00:00:00Z'), '2026-W53'); // a Friday: 2026 has 53 weeks
  assert.equal(isoWeek('2024-12-30T00:00:00Z'), '2025-W01');
  assert.equal(isoWeek(new Date('2026-11-04T12:00:00Z')), '2026-W45');
  assert.deepEqual(weekBounds(WEEK), { start: ms('2026-11-02T00:00:00Z'), end: ms('2026-11-09T00:00:00Z') });
  assert.equal(weekBounds('2026-W53').start, ms('2026-12-28T00:00:00Z'));
  assert.throws(() => weekBounds('2025-W53'), /does not exist/);
  assert.throws(() => weekBounds('2026-W00'), /does not exist/);
  assert.throws(() => weekBounds('2026-45'), /not YYYY-Www/);
  assert.throws(() => isoWeek('not a date'));
});

test('the post is due from Monday 13:00Z, for the previous week', () => {
  assert.equal(dueWeek(ms('2026-11-09T12:59:59Z')), null);
  assert.equal(dueWeek(ms('2026-11-09T13:00:00Z')), WEEK);
  assert.equal(dueWeek(ms('2026-11-15T23:59:00Z')), WEEK);
  assert.equal(dueWeek(ms('2026-11-16T12:00:00Z')), null);
  assert.equal(dueWeek(ms('2026-11-16T13:00:00Z')), '2026-W46');
});

test('a run created Sun 23:59Z is in the week, one created Mon 00:00Z is not', async () => {
  const runs = [run(1, 'merge_group', 'success', '2026-11-08T23:59:00Z', 12), run(2, 'merge_group', 'success', '2026-11-09T00:00:00Z', 40), run(3, 'merge_group', 'success', '2026-11-02T00:00:00Z', 6), run(4, 'merge_group', 'success', '2026-11-01T23:59:59Z', 50)];
  const rows = await weekMetrics(fakeGh({ runs }), { repo: REPO, week: WEEK });
  assert.equal(rows[0].value, '6.0 / 12.0 min (2 runs)');
  assert.equal(rows[0].coverage, 'exact');
  assert.equal(rows[4].value, '0 h (2 runs)');
});

test('a synthetic week renders to the exact markdown table', async () => {
  const w = syntheticWeek();
  const gh = fakeGh(w);
  const rows = await weekMetrics(gh, { repo: REPO, week: WEEK, decisionsLog: w.log });
  const body = renderWeekly({ week: WEEK, rows });
  assert.equal(body.split('\n\nTargets are proposals')[0] + '\n', EXPECTED_TABLE);
  assert.ok(body.endsWith(`${marker(WEEK)}\n`));
  // Neutral: no mentions, no closing keywords, no bare #N references.
  assert.doesNotMatch(body, /@/);
  assert.doesNotMatch(body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i);
  assert.doesNotMatch(body, /#\d/);
  // The fork's run was never read; the covered removals cost no head read.
  assert.ok(!gh.requests.some((r) => /head_sha=a50[245]/.test(r)), gh.requests.join('\n'));
});

test('an unreadable or capped run listing makes its rows unavailable, never partial', async () => {
  const errors = [];
  const rows = await weekMetrics(fakeGh({ ...syntheticWeek(), runsStatus: 502 }), { repo: REPO, week: WEEK, decisionsLog: syntheticWeek().log, onError: (e) => errors.push(e) });
  for (const i of [0, 2, 4, 5]) assert.deepEqual([rows[i].value, rows[i].coverage], ['—', 'unavailable'], rows[i].name);
  assert.equal(rows[3].coverage, 'exact');
  assert.ok(errors.some((e) => /merge_group run listing: 502/.test(e)));

  const many = Array.from({ length: 1001 }, (_, i) => run(20000 + i, 'merge_group', 'success', iso(ms('2026-11-03T00:00:00Z') + i * 1000), 5));
  const capped = await weekMetrics(fakeGh({ runs: many }), { repo: REPO, week: WEEK, onError: (e) => errors.push(e) });
  assert.equal(capped[0].coverage, 'unavailable');
  assert.ok(errors.some((e) => /over the 1,000-result cap/.test(e)));
});

// `n` add/manual-removal pairs, ten minutes apart, from `from`.
const churn = (pr, from, n) =>
  Array.from({ length: n }, (_, i) => [
    ['added', `C${pr}a${i}`, iso(ms(from) + i * 600_000)],
    ['removed', `C${pr}r${i}`, iso(ms(from) + i * 600_000 + 300_000), 'manual'],
  ]).flat();

test('a PR with more queue events than the scan reads is read again on its own', async () => {
  // PR 502 churned 30 times on Tuesday before its failed_checks removal: the
  // scan's last 50 events start inside the week, so it is read in full.
  const w = syntheticWeek();
  w.prs[1] = { ...w.prs[1], events: [...churn(502, '2026-11-03T00:00:00Z', 30), ...w.prs[1].events] };
  const gh = fakeGh(w);
  const rows = await weekMetrics(gh, { repo: REPO, week: WEEK, decisionsLog: w.log });
  assert.deepEqual(gh.requests.filter((r) => r.startsWith('POST graphql pr')), ['POST graphql pr 502 after=null']);
  const want = renderWeekly({ week: WEEK, rows: await weekMetrics(fakeGh(syntheticWeek()), { repo: REPO, week: WEEK, decisionsLog: w.log }) });
  assert.equal(renderWeekly({ week: WEEK, rows }), want);

  // 300 pairs in the week: more than the 500 events one PR may take.
  const heavy = syntheticWeek();
  heavy.prs[1] = { ...heavy.prs[1], events: [...churn(502, '2026-11-02T01:00:00Z', 300), ...heavy.prs[1].events] };
  const errors = [];
  const cut = await weekMetrics(fakeGh(heavy), { repo: REPO, week: WEEK, decisionsLog: heavy.log, onError: (e) => errors.push(e) });
  for (const i of [1, 3, 6, 7]) assert.deepEqual([cut[i].value, cut[i].coverage], ['—', 'unavailable'], cut[i].name);
  assert.equal(cut[0].coverage, 'exact');
  assert.ok(errors.some((e) => /PR 502: more than 500 queue events/.test(e)), errors.join('\n'));
});

test('a merged head that arrived before the events read has an undetermined latency', async () => {
  // PR 501's last 50 events start before the week; its head arrived earlier
  // still, so its first add may be among the events not read.
  const w = syntheticWeek();
  w.prs[0] = { ...w.prs[0], events: [...churn(501, '2026-10-30T00:00:00Z', 40), ...w.prs[0].events] };
  w.pushes.a501 = '2026-10-29T00:00:00Z';
  const errors = [];
  const rows = await weekMetrics(fakeGh(w), { repo: REPO, week: WEEK, decisionsLog: w.log, onError: (e) => errors.push(e) });
  // 1 of 1 undetermined is over the 20% share: the row would be biased.
  assert.deepEqual([rows[1].value, rows[1].coverage], ['—', 'unavailable']);
  assert.ok(errors.includes('queue latency: 1 of 1 merged PRs undetermined'), errors.join('\n'));
});

test('queue latency: a failed head read is reported, never silent', async () => {
  const w = syntheticWeek();
  const gh = fakeGh(w);
  const rest = gh.rest;
  gh.rest = async (method, path) => (/head_sha=a501/.test(path) ? (gh.calls++, { status: 500, body: { message: 'boom' } }) : rest(method, path));
  const errors = [];
  const rows = await weekMetrics(gh, { repo: REPO, week: WEEK, decisionsLog: w.log, onError: (e) => errors.push(e) });
  assert.equal(rows[1].coverage, 'unavailable');
  assert.ok(errors.some((e) => /queue latency: PR 501 head arrival not read/.test(e)), errors.join('\n'));
});

test('re-enqueues needing a human are unavailable before act mode', async () => {
  const w = syntheticWeek();
  const shadow = w.log.map((e) => ({ ...e, mode: 'shadow', status: 'shadow' }));
  const rows = await weekMetrics(fakeGh(w), { repo: REPO, week: WEEK, decisionsLog: shadow });
  assert.deepEqual([rows[7].value, rows[7].coverage], ['—', 'unavailable']);
  // Shadow decisions still carry the classes.
  assert.equal(rows[3].value, '2 of 4 (infra 1, real 1, suspected_flake 1, unknown 1)');
});

test('over the API budget the job rows are sampled 1/k with the right k', async () => {
  const runs = Array.from({ length: 50 }, (_, i) => run(30000 + i, 'merge_group', 'success', iso(ms('2026-11-03T00:00:00Z') + i * 60_000), 10));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(['ubuntu-latest'], r.created_at, 0, 60)]]));
  // Fixed reads: 7 queue-run days, 7 PR-run days, 1 queue event scan = 15.
  // The first run's jobs (1 page; 1.5 pages a run with the margin) leave 30:
  // k = ceil(50 runs × 1.5 / 30) = 3 → 17 runs read, scaled by 50/17.
  const gh = fakeGh({ runs, jobs });
  const rows = await weekMetrics(gh, { repo: REPO, week: WEEK, apiBudget: 45 });
  assert.equal(rows[4].coverage, 'sampled 1/3');
  assert.equal(rows[4].value, '≈50 h (50 runs)');
  assert.equal(rows[5].coverage, 'sampled 1/3');
  assert.equal(rows[5].value, '0.0% (0 of 17 jobs read)');
  assert.equal(rows[0].coverage, 'exact');
  assert.ok(gh.calls <= 45, `spent ${gh.calls}`);
  assert.equal(gh.requests.filter((r) => /\/jobs\?/.test(r)).length, 17);

  // Too little left for even one run's jobs: unavailable, and said why.
  const errors = [];
  const none = await weekMetrics(fakeGh({ runs, jobs }), { repo: REPO, week: WEEK, apiBudget: 15, onError: (e) => errors.push(e) });
  assert.deepEqual([none[4].value, none[4].coverage], ['—', 'unavailable']);
  assert.ok(errors.includes('jobs: the API budget ran out'), errors.join('\n'));

  const full = await weekMetrics(fakeGh({ runs, jobs }), { repo: REPO, week: WEEK });
  assert.deepEqual([full[4].value, full[4].coverage], ['50 h (50 runs)', 'exact']);
});

test('PR runs past the sample cap are read every k-th', async () => {
  // 900 green PR runs on one day; cap 300 → k = 3, pages 2–9 read.
  const runs = Array.from({ length: 900 }, (_, i) => run(40000 + i, 'pull_request', 'success', iso(ms('2026-11-04T00:00:00Z') + i * 60_000), i % 2 ? 10 : 20));
  const gh = fakeGh({ runs });
  const rows = await weekMetrics(gh, { repo: REPO, week: WEEK });
  assert.equal(rows[2].coverage, 'sampled 1/3');
  assert.match(rows[2].value, /\(300 runs read\)$/);
  assert.equal(gh.requests.filter((r) => /event=pull_request/.test(r)).length, 7 + 8);
});

test('unlogged removals are classified now, every k-th within the budget', async () => {
  const w = syntheticWeek();
  // Without ci.yml the shepherd cannot classify: the row is unavailable.
  const noLog = await weekMetrics(fakeGh(w), { repo: REPO, week: WEEK, decisionsLog: [] });
  assert.equal(noLog[3].coverage, 'unavailable');
  assert.equal(noLog[6].coverage, 'unavailable');

  // Three unlogged same-repo removals; 15 fixed reads, then 100 left, 40 of
  // it for classifying: one classification (25 calls each) → k = 3.
  const prs = [601, 602, 603].map((n, i) => ({ pr: n, head: `a${n}`, events: [['removed', `R${n}`, iso(ms('2026-11-03T08:00:00Z') + i * 3600_000), 'failed_checks']] }));
  const seen = [];
  const classifyRemoval = async (_gh, r) => {
    seen.push(r.pr);
    return 'real';
  };
  const rows = await weekMetrics(fakeGh({ prs }), { repo: REPO, week: WEEK, apiBudget: 115, classifyRemoval });
  assert.deepEqual(seen, [601]);
  assert.deepEqual([rows[3].value, rows[3].coverage], ['≈0 of 3 (real ≈3)', 'sampled 1/3']);
  // Sampled: the PRs read are a lower bound.
  assert.deepEqual([rows[6].value, rows[6].coverage], ['at least 1 PR: PR 601 (unadjudicated)', 'sampled 1/3']);

  // With room for all three, every one is classified and the row is exact.
  seen.length = 0;
  const all = await weekMetrics(fakeGh({ prs }), { repo: REPO, week: WEEK, classifyRemoval });
  assert.deepEqual(seen, [601, 602, 603]);
  assert.deepEqual([all[3].value, all[3].coverage], ['0 of 3 (real 3)', 'exact']);

  // A classifier error is not a class: counted apart, and reported.
  const errors = [];
  const failing = await weekMetrics(fakeGh({ prs }), { repo: REPO, week: WEEK, onError: (e) => errors.push(e), classifyRemoval: async () => { throw new Error('log 404'); } });
  assert.equal(failing[3].value, '0 of 3 (3 not classified)');
  assert.equal(errors.length, 3);

  // Ten unlogged, room for three: k = 4 picks 0, 4, 8. Each stands for 10/3,
  // so the estimate is ≈10 of 10, never ≈12 of 10.
  const ten = Array.from({ length: 10 }, (_, i) => ({ pr: 700 + i, head: `a${700 + i}`, events: [['removed', `R${700 + i}`, iso(ms('2026-11-04T00:00:00Z') + i * 3600_000), 'failed_checks']] }));
  const picked = [];
  const tenRows = await weekMetrics(fakeGh({ prs: ten }), { repo: REPO, week: WEEK, apiBudget: 15 + 190, classifyRemoval: async (_gh, r) => (picked.push(r.pr), 'infra') });
  assert.deepEqual(picked, [700, 704, 708]);
  assert.deepEqual([tenRows[3].value, tenRows[3].coverage], ['≈10 of 10 (infra ≈10)', 'sampled 1/4']);
});

// Re-enqueues needing a human: each branch of the same-head and cover rules.
test('human re-adds: same head, a push in between, unknown order, and the 15-minute cover', async () => {
  const at = (min) => iso(ms('2026-11-05T08:00:00Z') + min * 60_000);
  const pr = (n, readdMin) => ({ pr: n, head: `a${n}`, events: [['removed', `R${n}`, at(0), 'failed_checks'], ['added', `A${n}`, at(readdMin)]] });
  const prs = [pr(801, 60), pr(802, 60), pr(803, 60), pr(804, 20), pr(805, 20), pr(806, 20)];
  const pushes = {
    a801: at(-60), // before the removal: same head → a human re-add
    a802: at(30), // between the removal and the re-add: the author pushed → not counted
    a803: at(90), // after the re-add: cannot tell → undetermined
    a804: at(-60),
    a805: at(-60),
    a806: at(-60),
  };
  const decision = (n, kind, min, extra = {}) => ({ removalId: `R${n}`, pr: n, kind, class: 'infra', mode: 'act', status: 'applied', at: at(min), ...extra });
  const log = [
    decision(801, 'hold', 1),
    decision(802, 'hold', 1),
    decision(803, 'hold', 1),
    decision(804, 'requeue', 15), // covered: exactly at the 15-minute edge
    decision(805, 'requeue', 15.02), // 15 min 1 s: not covered
    decision(806, 'requeue', 1, { status: 'shadow' }), // a shadow requeue covers nothing
  ];
  const rows = await weekMetrics(fakeGh({ prs, pushes }), { repo: REPO, week: WEEK, decisionsLog: log });
  assert.deepEqual([rows[7].value, rows[7].coverage], ['3 (PR 801, PR 805, PR 806; 1 undetermined)', 'exact']);
});

test('human re-adds: unavailable unless every removal of the week was decided in act mode', async () => {
  const w = syntheticWeek();
  // R505 decided in shadow (act started later in the week): its re-add has no
  // shepherd requeue to cover it and would read as a human's.
  const log = w.log.map((e) => (e.removalId === 'R505' ? { ...e, mode: 'shadow', status: 'shadow' } : e));
  const rows = await weekMetrics(fakeGh(w), { repo: REPO, week: WEEK, decisionsLog: log });
  assert.deepEqual([rows[7].value, rows[7].coverage], ['—', 'unavailable']);
});

function postEnv({ issues = [], comments = {} } = {}) {
  const gh = fakeGh({ issues, comments });
  const writer = fakeWriter();
  const rows = [{ name: 'Queue run time-to-green p50 / p90', value: '1.0 / 2.0 min (2 runs)', baseline: '24.8 / 44.1 min', target: '< 8 / < 20 min', coverage: 'exact' }];
  return { gh, writer, rows };
}
const opIssue = (number, extra = {}) => ({ number, title: METRICS_TITLE, user: { login: OP }, labels: [METRICS_LABEL], state: 'open', ...extra });

test('the first post creates the label and the issue once, then comments', async () => {
  const { gh, writer, rows } = postEnv();
  const res = await postWeekly(gh, { repo: REPO, week: WEEK, rows, writer, viewer: OP });
  assert.equal(res.status, 'posted');
  assert.equal(res.issue, 900);
  assert.deepEqual(writer.writes.map((x) => x.op), ['ensure_label', 'create_issue', 'comment']);
  assert.equal(writer.writes[1].title, METRICS_TITLE);
  assert.deepEqual(writer.writes[1].labels, [METRICS_LABEL]);
  assert.ok(writer.writes[2].body.includes(marker(WEEK)));
});

test('a second post for the same week is a noop', async () => {
  const comments = { 77: [{ user: { login: OP }, body: `old\n${marker('2026-W44')}\n` }, { user: { login: OP }, body: `table\n${marker(WEEK)}\n` }] };
  const { gh, writer, rows } = postEnv({ issues: [opIssue(77)], comments });
  const res = await postWeekly(gh, { repo: REPO, week: WEEK, rows, writer, viewer: OP });
  assert.deepEqual([res.status, res.issue], ['noop', 77]);
  assert.deepEqual(writer.writes, []);
  // Another week on the same issue is posted, with no new issue.
  const next = await postWeekly(gh, { repo: REPO, week: '2026-W46', rows, writer, viewer: OP });
  assert.deepEqual([next.status, next.issue], ['posted', 77]);
  assert.deepEqual(writer.writes.map((x) => x.op), ['comment']);
});

test('only the operator’s issue and the operator’s marker count', async () => {
  const issues = [opIssue(70, { user: { login: 'someone' } }), opIssue(71, { title: 'CI throughput' }), opIssue(72, { state: 'closed' }), opIssue(74)];
  const comments = { 72: [{ user: { login: 'someone' }, body: marker(WEEK) }] };
  const { gh, writer, rows } = postEnv({ issues, comments });
  const res = await postWeekly(gh, { repo: REPO, week: WEEK, rows, writer, viewer: OP });
  // The oldest operator issue with the exact title, open or closed; a pasted marker is ignored.
  assert.deepEqual([res.status, res.issue], ['posted', 72]);
  assert.deepEqual(writer.writes.map((x) => [x.op, x.issue]), [['comment', 72]]);
});

test('a remembered issue is used even after its label is gone', async () => {
  const { gh, writer, rows } = postEnv({ issues: [opIssue(81, { labels: [] })] });
  const res = await postWeekly(gh, { repo: REPO, week: WEEK, rows, writer, viewer: OP, knownIssue: 81 });
  assert.deepEqual([res.status, res.issue], ['posted', 81]);
  assert.deepEqual(writer.writes.map((x) => x.op), ['comment']);
});

test('without a writer postWeekly writes nothing and says what it would post', async () => {
  const { gh, rows } = postEnv();
  const res = await postWeekly(gh, { repo: REPO, week: WEEK, rows, viewer: OP });
  assert.equal(res.status, 'shadow');
  assert.ok(res.body.includes('| Queue run time-to-green p50 / p90 | 1.0 / 2.0 min (2 runs) |'));
  assert.ok(gh.requests.every((r) => r.startsWith('GET ')));
});

// The tick's hook, with a fake tick context.
function tickEnv({ now, mode = 'act', modeNow = mode, state = {}, budget = 600, log = [] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ci-shepherd-metrics-'));
  writeFileSync(join(stateDir, 'decisions.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + (log.length ? '\n' : ''));
  const gh = fakeGh({ ...syntheticWeek(), budget });
  const writer = fakeWriter();
  const records = [];
  const errors = [];
  let saves = 0;
  const t = {
    gh,
    repo: REPO,
    now: ms(now),
    mode,
    state,
    stateDir,
    writer: mode === 'act' ? writer : null,
    viewer: mode === 'act' ? OP : null,
    ciYml: null,
    repoRoot: null,
    modeNow: async () => modeNow,
    record: (e) => records.push(e),
    error: (e) => errors.push(e),
    save: () => saves++,
  };
  return { t, gh, writer, records, errors, saves: () => saves };
}

test('the tick posts once, on the first act-mode tick after Monday 13:00Z', async () => {
  const before = tickEnv({ now: '2026-11-09T12:55:00Z' });
  assert.deepEqual(await weeklyMetrics(before.t), { status: 'not_due' });
  assert.equal(before.gh.calls, 0);

  const shadow = tickEnv({ now: '2026-11-09T13:05:00Z', mode: 'shadow' });
  assert.deepEqual(await weeklyMetrics(shadow.t), { status: 'not_act', week: WEEK });
  assert.equal(shadow.gh.calls, 0);

  const env = tickEnv({ now: '2026-11-09T13:05:00Z', log: syntheticWeek().log });
  const res = await weeklyMetrics(env.t);
  assert.deepEqual(res, { status: 'posted', week: WEEK });
  assert.deepEqual(env.writer.writes.map((x) => x.op), ['ensure_label', 'create_issue', 'comment']);
  assert.ok(env.writer.writes[2].body.includes('| Re-enqueues needing a human | 2 (PR 503; 1 resume label) |'));
  assert.equal(env.t.state.metrics.postedWeek, WEEK);
  assert.equal(env.t.state.metrics.issue, 900);
  assert.equal(env.records.length, 1);
  assert.deepEqual([env.records[0].kind, env.records[0].status, env.records[0].issue], ['metrics_post', 'applied', 900]);
  assert.ok(env.gh.calls <= 600);
  // The attempt is saved before the reads, so a crash waits RETRY_MS.
  assert.ok(env.saves() >= 1);
  assert.equal(env.t.state.metrics.triedWeek, WEEK);

  // The next tick spends nothing.
  const calls = env.gh.calls;
  env.t.now = ms('2026-11-09T13:10:00Z');
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'posted', week: WEEK });
  assert.equal(env.gh.calls, calls);
  assert.equal(env.writer.writes.length, 3);
});

test('the tick writes nothing when act ends before the post', async () => {
  const env = tickEnv({ now: '2026-11-10T09:00:00Z', modeNow: 'shadow', log: syntheticWeek().log });
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'left_act', week: WEEK });
  assert.deepEqual(env.writer.writes, []);
  assert.equal(env.t.state.metrics.postedWeek, null);
  // …and waits an hour before trying again.
  env.t.now = ms('2026-11-10T09:30:00Z');
  const calls = env.gh.calls;
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'waiting', week: WEEK });
  assert.equal(env.gh.calls, calls);
});

test('a week whose reads failed is retried hourly, and posted after the last try', async () => {
  // No decisions logged and no ci.yml: the class rows cannot be read.
  const env = tickEnv({ now: '2026-11-09T14:00:00Z' });
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'retry', week: WEEK });
  assert.deepEqual(env.writer.writes, []);
  assert.ok(env.errors.some((e) => /no ci\.yml to classify/.test(e)), env.errors.join('\n'));
  env.t.now += RETRY_MS - 60_000;
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'waiting', week: WEEK });
  for (let i = 2; i < MAX_DEGRADED_TRIES; i++) {
    env.t.now += RETRY_MS;
    assert.deepEqual(await weeklyMetrics(env.t), { status: 'retry', week: WEEK });
  }
  env.t.now += RETRY_MS;
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'posted', week: WEEK });
  assert.ok(env.writer.writes.at(-1).body.includes('| Queue failures that were flake/infra/external | — |'));
});

test('a post that throws leaves the week unposted, to try again in an hour', async () => {
  const env = tickEnv({ now: '2026-11-09T14:00:00Z', log: syntheticWeek().log });
  const boom = async () => {
    throw new Error('metrics issue 900 comments: 502');
  };
  await assert.rejects(weeklyMetrics(env.t, { post: boom }), /502/);
  assert.equal(env.t.state.metrics.postedWeek, null);
  assert.equal(env.t.state.metrics.triedWeek, WEEK);
  env.t.now += RETRY_MS;
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'posted', week: WEEK });
});

test('the tick budget running out inside the metrics defers them, it does not end the tick', async () => {
  const env = tickEnv({ now: '2026-11-09T14:00:00Z', log: syntheticWeek().log });
  const spent = async () => {
    const e = new Error('GitHub API budget of 600 calls exhausted');
    e.name = 'BudgetExceeded';
    throw e;
  };
  assert.deepEqual(await weeklyMetrics(env.t, { compute: spent }), { status: 'deferred', week: WEEK });
  assert.equal(env.t.state.metrics.postedWeek, null);
});

test('the marker is found on a later comment page; an unreadable page posts nothing', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ user: { login: OP }, body: `comment ${i}` }));
  const { gh, writer, rows } = postEnv({ issues: [opIssue(77)], comments: { 77: [...filler, { user: { login: OP }, body: marker(WEEK) }] } });
  assert.equal((await postWeekly(gh, { repo: REPO, week: WEEK, rows, writer, viewer: OP })).status, 'noop');
  assert.deepEqual(writer.writes, []);

  const broken = postEnv({ issues: [opIssue(77)] });
  const rest = broken.gh.rest;
  broken.gh.rest = async (method, path) => (/comments/.test(path) ? { status: 502, body: {} } : rest(method, path));
  await assert.rejects(postWeekly(broken.gh, { repo: REPO, week: WEEK, rows: broken.rows, writer: broken.writer, viewer: OP }), /comments: 502/);
  assert.deepEqual(broken.writer.writes, []);
});

test('the tick leaves the metrics for later when its budget is nearly spent', async () => {
  const env = tickEnv({ now: '2026-11-09T14:00:00Z', budget: MIN_TICK_BUDGET - 1 });
  assert.deepEqual(await weeklyMetrics(env.t), { status: 'deferred', week: WEEK });
  assert.equal(env.gh.calls, 0);
  assert.equal(env.t.state.metrics.triedAt, null);
});

test('CLI: metrics only prints, and needs --dry-run and a real ISO week', async () => {
  const { main, parseArgs } = await import('./shepherd.mjs');
  assert.equal(parseArgs(['metrics', '--week', WEEK, '--dry-run']).budget, 4000);
  assert.equal(parseArgs(['replay', '--since', '2026-11-01']).budget, 600);
  const quiet = async (fn) => {
    const out = [];
    const [o, e] = [process.stdout.write, process.stderr.write];
    process.stdout.write = (s) => out.push(String(s)) > 0;
    process.stderr.write = (s) => out.push(String(s)) > 0;
    try {
      return { code: await fn(), out: out.join('') };
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
  };
  const never = () => {
    throw new Error('no GitHub client for a usage error');
  };
  assert.equal((await quiet(() => main(['metrics', '--week', WEEK], { makeGitHub: never }))).code, 2);
  assert.equal((await quiet(() => main(['metrics', '--week', '2025-W53', '--dry-run'], { makeGitHub: never }))).code, 2);

  const stateDir = mkdtempSync(join(tmpdir(), 'ci-shepherd-metrics-cli-'));
  writeFileSync(join(stateDir, 'decisions.jsonl'), syntheticWeek().log.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const gh = fakeGh(syntheticWeek());
  const res = await quiet(() => main(['metrics', '--week', WEEK, '--dry-run', '--state-dir', stateDir], { makeGitHub: () => gh }));
  assert.equal(res.code, 0);
  assert.ok(res.out.includes(EXPECTED_TABLE), res.out);
  assert.ok(gh.requests.every((r) => r.startsWith('GET ') || r === 'POST graphql'));
});
