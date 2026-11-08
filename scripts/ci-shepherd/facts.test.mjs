import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fakeFetch, loadRoutes } from './fake-github.mjs';
import { groupRunFor, jobIdentity, prSnapshot, processLog, recentRemovals, runFacts } from './facts.mjs';
import { BudgetExceeded, GitHubError, createGitHub } from './github.mjs';

// Facts about one merge-queue removal (W06a, #10750): what the PR looked like,
// which merge_group CI run tested it, and each failed job's evidence. Recorded
// responses only; nothing here talks to GitHub.

const REPO = 'LanternOps/breeze';
const R = `/repos/${REPO}`;
const ciYml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const gh = (routes, opts = {}) => {
  const fake = fakeFetch(routes);
  return { gh: createGitHub({ token: 't', fetchImpl: fake.fetchImpl, ...opts }), fake };
};

test('runner-lost job keeps annotations when the log is gone', async () => {
  const { gh: api, fake } = gh(loadRoutes(new URL('./fixtures/api/11312-runner-lost.json', import.meta.url)));
  const facts = await runFacts(api, { repo: REPO, runId: 42453222760, ciYml });
  assert.deepEqual(fake.unrouted, []);
  assert.equal(facts.run.id, 42453222760);
  assert.equal(facts.run.event, 'merge_group');
  assert.equal(facts.run.headSha, 'e3702cf316ebeade516667668ea83b0c39ded9d2');
  assert.equal(facts.run.headRepo, REPO);
  assert.equal(facts.run.pr, 11312);
  assert.equal(facts.ciSuccess, 'present');
  assert.equal(facts.gate, null);
  const job = facts.jobs.find((j) => j.name === 'Integration Tests (shard 11/16)');
  assert.equal(job.conclusion, 'failure');
  assert.equal(job.logStatus, 404);
  assert.equal(job.logTail, null);
  assert.equal(job.logAttempts, null);
  assert.equal(job.report, null);
  assert.equal(job.reportError, 'not_uploaded');
  assert.equal(job.label, 'integration-11');
  assert.equal(job.runner, 'vitest');
  assert.equal(job.timeoutMinutes, 55);
  assert.equal(job.failedStep, 'Run integration tests');
  assert.ok(job.annotations.some((a) => a.includes('lost communication with the server')), job.annotations.join('\n'));
  // Notices are not evidence.
  assert.ok(!job.annotations.some((a) => a.includes('ubuntu-latest label')));
  // Only failed or cancelled jobs are inspected; CI Success is the aggregate.
  const lint = facts.jobs.find((j) => j.name === 'Lint');
  assert.deepEqual([lint.annotations, lint.logStatus, lint.report], [[], null, null]);
  const ciSuccess = facts.jobs.find((j) => j.name === 'CI Success');
  assert.equal(ciSuccess.logStatus, null);
});

const run = (id, createdAt, headBranch, headSha = `${id}`.padEnd(40, '0')) => ({
  id,
  run_attempt: 1,
  path: '.github/workflows/ci.yml',
  event: 'merge_group',
  head_branch: headBranch,
  head_sha: headSha,
  created_at: createdAt,
  conclusion: 'failure',
});

test('groupRunFor ignores runs created after the removal', async () => {
  const branch = 'gh-readonly-queue/main/pr-11312-4514157ba45f374f45027ccbdabd3a86ffe0ae5c';
  const sha = 'c5e2ad9f61f07778d619156fbc70cadf1eb6c694';
  const removal = { pr: 11312, at: '2026-11-08T06:03:21Z', beforeCommit: sha };
  // Primary path: the removal's beforeCommit is the merge-group commit.
  const runs = { total_count: 2, workflow_runs: [run(2, '2026-11-08T06:10:00Z', branch, sha), run(1, '2026-11-08T05:36:25Z', branch, sha)] };
  const { gh: api } = gh({
    [`GET ${R}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=20`]: { status: 200, body: runs },
  });
  assert.equal((await groupRunFor(api, { repo: REPO, pr: 11312, removal })).id, 1);
  // Fallback when beforeCommit is missing: the queue branch prefix in a window.
  const other = run(3, '2026-11-08T05:50:00Z', 'gh-readonly-queue/main/pr-11320-4514157ba45f374f45027ccbdabd3a86ffe0ae5c');
  const window = { total_count: 3, workflow_runs: [run(2, '2026-11-08T06:10:00Z', branch), other, run(1, '2026-11-08T05:36:25Z', branch)] };
  const { gh: api2, fake } = gh({
    [`GET ${R}/actions/workflows/ci.yml/runs?event=merge_group&created=2026-11-08T00%3A03%3A21Z..2026-11-08T06%3A03%3A21Z&per_page=100&page=1`]: { status: 200, body: window },
  });
  const ref = await groupRunFor(api2, { repo: REPO, pr: 11312, removal: { ...removal, beforeCommit: null } });
  assert.deepEqual(fake.unrouted, []);
  assert.equal(ref.id, 1);
  // beforeCommit matches no run: the queue-branch search still finds it.
  const windowKey = `GET ${R}/actions/workflows/ci.yml/runs?event=merge_group&created=2026-11-08T00%3A03%3A21Z..2026-11-08T06%3A03%3A21Z&per_page=100&page=1`;
  const noSha = { [`GET ${R}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=20`]: { status: 200, body: { total_count: 0, workflow_runs: [] } } };
  const { gh: api3 } = gh({ ...noSha, [windowKey]: { status: 200, body: window } });
  assert.equal((await groupRunFor(api3, { repo: REPO, pr: 11312, removal })).id, 1);
  // No run either way → null, never a guess.
  const { gh: api4 } = gh({ ...noSha, [windowKey]: { status: 200, body: { total_count: 1, workflow_runs: [other] } } });
  assert.equal(await groupRunFor(api4, { repo: REPO, pr: 11312, removal }), null);
});

const prGraph = (over = {}) => ({
  data: {
    repository: {
      pullRequest: {
        number: 7,
        state: 'OPEN',
        headRefOid: 'a'.repeat(40),
        headRefName: 'fix/x',
        isCrossRepository: false,
        headRepository: { nameWithOwner: REPO },
        autoMergeRequest: { enabledAt: '2026-11-08T05:00:00Z' },
        mergeQueueEntry: null,
        labels: { nodes: [{ name: 'wave' }] },
        timelineItems: {
          nodes: [
            { __typename: 'AddedToMergeQueueEvent', id: 'A1', createdAt: '2026-11-08T05:36:07Z', actor: { login: 'op' } },
            {
              __typename: 'RemovedFromMergeQueueEvent',
              id: 'R1',
              createdAt: '2026-11-08T06:03:21Z',
              reason: 'failed_checks',
              actor: { login: 'github-merge-queue' },
              beforeCommit: { oid: 'c'.repeat(40) },
            },
          ],
        },
        ...over,
      },
    },
  },
});

test('prSnapshot marks forks', async () => {
  const files = { status: 200, body: [{ filename: 'apps/web/src/a.ts' }, { filename: 'apps/web/src/b.ts', previous_filename: 'apps/web/src/old-b.ts' }] };
  const { gh: api } = gh({ [`POST /graphql`]: { status: 200, body: prGraph() }, [`GET ${R}/pulls/7/files?per_page=100&page=1`]: files });
  const own = await prSnapshot(api, { repo: REPO, pr: 7 });
  assert.equal(own.isFork, false);
  assert.equal(own.state, 'OPEN');
  assert.equal(own.headSha, 'a'.repeat(40));
  assert.equal(own.autoMerge, true);
  assert.equal(own.queue, null);
  assert.deepEqual(own.labels, ['wave']);
  assert.deepEqual(own.files, ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/src/old-b.ts']);
  assert.deepEqual(own.events, [
    { type: 'added', id: 'A1', at: '2026-11-08T05:36:07Z', actor: 'op' },
    { type: 'removed', id: 'R1', at: '2026-11-08T06:03:21Z', actor: 'github-merge-queue', reason: 'failed_checks', beforeCommit: 'c'.repeat(40) },
  ]);
  const fork = prGraph({ isCrossRepository: true, headRepository: { nameWithOwner: 'someone/breeze' }, mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 2 } });
  const { gh: api2 } = gh({ [`POST /graphql`]: { status: 200, body: fork }, [`GET ${R}/pulls/7/files?per_page=100&page=1`]: files });
  const forked = await prSnapshot(api2, { repo: REPO, pr: 7 });
  assert.equal(forked.isFork, true);
  assert.deepEqual(forked.queue, { state: 'AWAITING_CHECKS', position: 2 });
  // A deleted fork has no head repository: still a fork.
  const gone = prGraph({ isCrossRepository: false, headRepository: null });
  const { gh: api3 } = gh({ [`POST /graphql`]: { status: 200, body: gone }, [`GET ${R}/pulls/7/files?per_page=100&page=1`]: files });
  assert.equal((await prSnapshot(api3, { repo: REPO, pr: 7 })).isFork, true);
});

// A merge_group run with one failed web shard whose flake-report artifact is
// served from `zipBytes`.
function reportRun({ artifactSize, zipBytes }) {
  const sha = 'd'.repeat(40);
  return {
    [`GET ${R}/actions/runs/9`]: {
      status: 200,
      body: {
        id: 9,
        path: '.github/workflows/ci.yml',
        event: 'merge_group',
        status: 'completed',
        conclusion: 'failure',
        run_attempt: 1,
        head_sha: sha,
        head_branch: 'gh-readonly-queue/main/pr-7-abc',
        head_repository: { full_name: REPO },
        pull_requests: [],
        created_at: '2026-11-08T05:00:00Z',
        updated_at: '2026-11-08T05:40:00Z',
      },
    },
    [`GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=1`]: {
      status: 200,
      body: {
        total_count: 1,
        jobs: [
          {
            id: 91,
            name: 'Test Web (shard 3/4)',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-11-08T05:01:00Z',
            completed_at: '2026-11-08T05:20:00Z',
            steps: [{ name: 'Run web tests', status: 'completed', conclusion: 'failure', number: 9 }],
          },
        ],
      },
    },
    [`GET ${R}/check-runs/91/annotations?per_page=100`]: { status: 200, body: [] },
    [`GET ${R}/actions/jobs/91/logs`]: { status: 302, location: 'https://blob.example.test/log?sig=1' },
    ['GET https://blob.example.test/log?sig=1']: { status: 200, text: '2026-11-08T05:01:00.0000000Z hello\n' },
    [`GET ${R}/actions/runs/9/artifacts?per_page=100&page=1`]: {
      status: 200,
      body: { total_count: 1, artifacts: [{ id: 501, name: 'flake-report-web-3', size_in_bytes: artifactSize, expired: false }] },
    },
    [`GET ${R}/actions/artifacts/501/zip`]: { status: 302, location: 'https://blob.example.test/zip?sig=2' },
    ['GET https://blob.example.test/zip?sig=2']: { status: 200, bytes: zipBytes },
    [`GET ${R}/actions/workflows/ci-gate.yml/runs?head_sha=${sha}&per_page=5`]: { status: 404, body: { message: 'Not Found' } },
  };
}

function zipOf(name, text) {
  const dir = mkdtempSync(join(tmpdir(), 'shepherd-zip-'));
  writeFileSync(join(dir, name), text);
  const r = spawnSync('zip', ['-q', '-X', 'a.zip', name], { cwd: dir });
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(join(dir, 'a.zip'));
}

test('oversized or invalid flake report is rejected', async () => {
  const v2 = { schema: 2, label: 'web-3', runner: 'vitest', attempts: 2, exitCode: 1, flaky: [], quarantined: [], first: { failures: ['a'] }, second: { failures: ['b'] } };
  const good = zipOf('flake-report-web-3.json', JSON.stringify(v2));
  const ok = await runFacts(gh(reportRun({ artifactSize: good.length, zipBytes: good })).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(ok.jobs[0].reportError, null);
  assert.deepEqual(ok.jobs[0].report, v2);
  assert.equal(ok.jobs[0].logStatus, 200);
  assert.equal(ok.jobs[0].logTail, 'hello');

  // The listing says 300 KB: never downloaded.
  const big = reportRun({ artifactSize: 300 * 1024, zipBytes: good });
  const { gh: api, fake } = gh(big);
  const tooBig = await runFacts(api, { repo: REPO, runId: 9, ciYml });
  assert.equal(tooBig.jobs[0].report, null);
  assert.match(tooBig.jobs[0].reportError, /too large/);
  assert.ok(!fake.calls.some((c) => c.key.includes('/artifacts/501/zip')));

  // A small zip that inflates past 256 KB.
  const padded = zipOf('flake-report-web-3.json', JSON.stringify({ ...v2, pad: 'x'.repeat(300 * 1024) }));
  const inflated = await runFacts(gh(reportRun({ artifactSize: padded.length, zipBytes: padded })).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(inflated.jobs[0].report, null);
  assert.match(inflated.jobs[0].reportError, /too large/);

  // Schema 7 and broken JSON.
  for (const text of [JSON.stringify({ ...v2, schema: 7 }), '{not json']) {
    const zip = zipOf('flake-report-web-3.json', text);
    const facts = await runFacts(gh(reportRun({ artifactSize: zip.length, zipBytes: zip })).gh, { repo: REPO, runId: 9, ciYml });
    assert.equal(facts.jobs[0].report, null, text);
    assert.match(facts.jobs[0].reportError, /schema|JSON/, text);
  }

  // A schema-1 report (no `schema` field) is accepted as is.
  const v1 = { label: 'web-3', attempts: 2, flaky: [], quarantined: [], exitCode: 1 };
  const v1zip = zipOf('flake-report-web-3.json', JSON.stringify(v1));
  const old = await runFacts(gh(reportRun({ artifactSize: v1zip.length, zipBytes: v1zip })).gh, { repo: REPO, runId: 9, ciYml });
  assert.deepEqual(old.jobs[0].report, v1);
});

test('a passed job that failed then passed on the retry keeps its flake report (and only that)', async () => {
  const v1 = { label: 'web-3', attempts: 2, flaky: ['src/a.test.tsx > A > flaky'], quarantined: [], exitCode: 0 };
  const zip = zipOf('flake-report-web-3.json', JSON.stringify(v1));
  const routes = reportRun({ artifactSize: zip.length, zipBytes: zip });
  const jobsKey = `GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=1`;
  routes[jobsKey].body.jobs[0].conclusion = 'success';
  routes[jobsKey].body.jobs[0].steps[0].conclusion = 'success';
  const { gh: api, fake } = gh(routes);
  const facts = await runFacts(api, { repo: REPO, runId: 9, ciYml });
  assert.deepEqual(facts.jobs[0].report, v1);
  assert.equal(facts.jobs[0].logStatus, null);
  assert.ok(!fake.calls.some((c) => c.key.includes('/annotations') || c.key.includes('/logs')));
});

test('budget stops further calls', async () => {
  const { gh: api, fake } = gh({ [`GET ${R}/x`]: { status: 200, body: {} } }, { budget: 3 });
  for (let i = 0; i < 3; i++) await api.rest('GET', `repos/${REPO}/x`);
  assert.equal(api.calls, 3);
  await assert.rejects(api.rest('GET', `repos/${REPO}/x`), BudgetExceeded);
  await assert.rejects(api.graphql('query { viewer { login } }', {}), BudgetExceeded);
  assert.equal(fake.calls.length, 3);
});

test('mutations are never retried; reads retry once after a 5xx', async () => {
  const { gh: api, fake } = gh({ 'POST /graphql': { status: 502, text: 'bad gateway' } });
  await assert.rejects(api.graphql('mutation { enqueuePullRequest(input: {}) { clientMutationId } }', {}), (e) => e instanceof GitHubError && e.status === 502);
  assert.equal(fake.calls.length, 1);
  const { gh: api2, fake: fake2 } = gh({ [`POST ${R}/issues/1/comments`]: { status: 503, body: {} } });
  assert.equal((await api2.rest('POST', `repos/${REPO}/issues/1/comments`, { body: 'x' })).status, 503);
  assert.equal(fake2.calls.length, 1);
  const { gh: api3, fake: fake3 } = gh({
    'POST /graphql': [{ status: 502, text: '' }, { status: 200, body: { data: { viewer: { login: 'op' } } } }],
    [`GET ${R}/y`]: [{ status: 500, body: {} }, { status: 200, body: { ok: true } }],
  });
  assert.deepEqual(await api3.graphql('# a comment\nquery { viewer { login } }', {}), { viewer: { login: 'op' } });
  assert.deepEqual((await api3.rest('GET', `repos/${REPO}/y`)).body, { ok: true });
  assert.equal(fake3.calls.length, 4);
  // GraphQL errors in a 200 surface as GitHubError.
  const { gh: api4 } = gh({ 'POST /graphql': { status: 200, body: { errors: [{ message: 'Something went wrong' }] } } });
  await assert.rejects(api4.graphql('query { x }', {}), /Something went wrong/);
});

test('raw follows the redirect without sending the token to the blob host', async () => {
  const { gh: api, fake } = gh({
    [`GET ${R}/actions/jobs/1/logs`]: { status: 302, location: 'https://blob.example.test/l' },
    'GET https://blob.example.test/l': { status: 200, text: 'line' },
  });
  assert.deepEqual(await api.raw(`repos/${REPO}/actions/jobs/1/logs`), { status: 200, text: 'line' });
  assert.equal(fake.calls[0].headers.Authorization, 'Bearer t');
  assert.equal(fake.calls[1].headers.Authorization, undefined);
  assert.equal(api.calls, 1);
});

test('recentRemovals returns removals since the cutoff, oldest first, across pages', async () => {
  const page = (nodes, hasNextPage, endCursor) => ({
    status: 200,
    body: { data: { repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
  });
  const rm = (id, at, reason, oid = 'f'.repeat(40)) => ({
    __typename: 'RemovedFromMergeQueueEvent',
    id,
    createdAt: at,
    reason,
    actor: { login: 'github-merge-queue' },
    beforeCommit: reason === 'manual' ? null : { oid },
  });
  const add = { __typename: 'AddedToMergeQueueEvent', id: 'A', createdAt: '2026-11-08T05:00:00Z', actor: { login: 'op' } };
  const { gh: api, fake } = gh({
    'POST /graphql': (req) =>
      req.body.variables.after
        ? page([{ number: 3, updatedAt: '2026-11-07T23:00:00Z', timelineItems: { nodes: [rm('R9', '2026-11-07T22:00:00Z', 'failed_checks')] } }], true, 'c2')
        : page(
            [
              { number: 1, updatedAt: '2026-11-08T07:00:00Z', timelineItems: { nodes: [add, rm('R2', '2026-11-08T06:30:00Z', 'failed_checks'), rm('R3', '2026-11-08T06:40:00Z', 'manual')] } },
              { number: 2, updatedAt: '2026-11-08T06:50:00Z', timelineItems: { nodes: [rm('R1', '2026-11-08T06:10:00Z', 'merged'), rm('R0', '2026-11-07T20:00:00Z', 'failed_checks')] } },
            ],
            true,
            'c1',
          ),
  });
  const removals = await recentRemovals(api, { repo: REPO, since: '2026-11-08T00:00:00Z', maxPages: 5 });
  assert.deepEqual(
    removals.map((r) => [r.pr, r.id, r.reason]),
    [
      [2, 'R1', 'merged'],
      [1, 'R2', 'failed_checks'],
      [1, 'R3', 'manual'],
    ],
  );
  assert.deepEqual(removals[1], { pr: 1, id: 'R2', at: '2026-11-08T06:30:00Z', reason: 'failed_checks', actor: 'github-merge-queue', beforeCommit: 'f'.repeat(40) });
  // Page 2's oldest PR update predates the cutoff, so page 3 is never asked for.
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].body.query, /REMOVED_FROM_MERGE_QUEUE_EVENT/);
});

// The job's own `timeout-minutes` line, read independently of jobIdentity so a
// timeout retune in ci.yml does not break this test.
const timeoutOf = (jobId) => {
  const block = new RegExp(`^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n)`, 'm').exec(ciYml)[1];
  return Number(/^ {4}timeout-minutes: (\d+)/m.exec(block)[1]);
};

test('jobIdentity maps a display name to its job, timeout and retry-shard label', () => {
  const rows = [
    ['Integration Tests (shard 11/16)', 'integration-test', 'integration-11', 'vitest'],
    ['Test Web (shard 3/4)', 'test-web', 'web-3', 'vitest'],
    ['Test API (shard 8/8)', 'test-api', 'api-8', 'vitest'],
    ['Test Agent (race)', 'test-agent-race', 'agent-race', 'go'],
    ['Test Agent', 'test-agent', 'agent', 'go'],
  ];
  for (const [name, jobId, label, runner] of rows) {
    assert.deepEqual(jobIdentity(ciYml, name), { jobId, timeoutMinutes: timeoutOf(jobId), label, runner }, name);
  }
  assert.deepEqual(jobIdentity(ciYml, 'Lint'), { jobId: 'lint', timeoutMinutes: null, label: null, runner: null });
  assert.deepEqual(jobIdentity(ciYml, 'No Such Job'), { jobId: null, timeoutMinutes: null, label: null, runner: null });
});

test('the retry marker processLog splits on is the text retry-shard prints', () => {
  const src = readFileSync(new URL('../../.github/scripts/retry-shard.mjs', import.meta.url), 'utf8');
  assert.match(src, /re-running the whole shard once/);
});

test('processLog parses the whole log: a failure 1,000 lines before the end still counts', () => {
  const filler = Array.from({ length: 1000 }, (_, i) => `  ✓ src/ok${i}.test.ts > passes`);
  const lines = [
    ' Failed Tests 1 ',
    ' FAIL  src/a.test.ts > A > first',
    ...filler,
    '##[warning]api-2: attempt 1 failed with 1 failing test(s); re-running the whole shard once',
    ...filler,
    ' Failed Tests 1 ',
    ' FAIL  src/b.test.ts > B > second',
    ...filler,
  ];
  const { logTail, logAttempts } = processLog(lines.join('\n'), 'vitest');
  assert.deepEqual(logAttempts.map((a) => a.failures), [['src/a.test.ts > A > first'], ['src/b.test.ts > B > second']]);
  assert.doesNotMatch(logTail, /src\/[ab]\.test\.ts/);
});

test('prSnapshot pages through PR files', async () => {
  const page = (n, start) => ({ status: 200, body: Array.from({ length: n }, (_, i) => ({ filename: `f${start + i}.ts` })) });
  const graph = { status: 200, body: prGraph() };
  const { gh: api, fake } = gh({
    'POST /graphql': graph,
    [`GET ${R}/pulls/7/files?per_page=100&page=1`]: page(100, 0),
    [`GET ${R}/pulls/7/files?per_page=100&page=2`]: { status: 200, body: [{ filename: 'apps/api/src/x.test.ts' }] },
  });
  const snap = await prSnapshot(api, { repo: REPO, pr: 7 });
  assert.equal(snap.files.length, 101);
  assert.ok(snap.files.includes('apps/api/src/x.test.ts'));
  assert.equal(fake.calls.filter((c) => c.key.includes('/files?')).length, 2);
  // A full last page is followed by an empty one, then stops.
  const { gh: api2, fake: fake2 } = gh({
    'POST /graphql': graph,
    [`GET ${R}/pulls/7/files?per_page=100&page=1`]: page(100, 0),
    [`GET ${R}/pulls/7/files?per_page=100&page=2`]: { status: 200, body: [] },
  });
  assert.equal((await prSnapshot(api2, { repo: REPO, pr: 7 })).files.length, 100);
  assert.equal(fake2.calls.filter((c) => c.key.includes('/files?')).length, 2);
  // A failed page is loud, never a short file list.
  const { gh: api3 } = gh({ 'POST /graphql': graph, [`GET ${R}/pulls/7/files?per_page=100&page=1`]: { status: 502, body: {} } });
  await assert.rejects(prSnapshot(api3, { repo: REPO, pr: 7 }), (e) => e instanceof GitHubError && e.status === 502);
});

test('gate verdict: read from the newest CI Gate run; a failed lookup or missing line is recorded, not dropped', async () => {
  const sha = 'd'.repeat(40);
  const gateKey = `GET ${R}/actions/workflows/ci-gate.yml/runs?head_sha=${sha}&per_page=5`;
  const zip = zipOf('flake-report-web-3.json', JSON.stringify({ label: 'web-3', attempts: 2, flaky: [], quarantined: [], exitCode: 1 }));
  const base = () => reportRun({ artifactSize: zip.length, zipBytes: zip });
  const line = '2026-11-08T05:40:00.0000000Z ci-gate: verdict=fail reason=not_pinned event=merge_group base=none head=none ci_run=none attempt=none policy_paths=[] flags=null oracle=none';
  const withGate = (logText) => ({
    ...base(),
    [gateKey]: { status: 200, body: { total_count: 2, workflow_runs: [{ id: 70, created_at: '2026-11-08T05:00:00Z' }, { id: 71, created_at: '2026-11-08T05:30:00Z' }] } },
    [`GET ${R}/actions/runs/71/jobs?filter=latest&per_page=100&page=1`]: { status: 200, body: { total_count: 1, jobs: [{ id: 710, name: 'CI Gate' }] } },
    [`GET ${R}/actions/jobs/710/logs`]: { status: 200, text: logText },
  });
  const found = await runFacts(gh(withGate(`${line}\n`)).gh, { repo: REPO, runId: 9, ciYml });
  assert.deepEqual(found.gate, { verdict: 'fail', reason: 'not_pinned', run: 71 });
  const missing = await runFacts(gh(withGate('2026-11-08T05:40:00Z nothing here\n')).gh, { repo: REPO, runId: 9, ciYml });
  assert.deepEqual(missing.gate, { verdict: null, reason: 'gate_line_missing', run: 71 });
  const failed = await runFacts(gh({ ...base(), [gateKey]: { status: 500, body: {} } }).gh, { repo: REPO, runId: 9, ciYml });
  assert.deepEqual(failed.gate, { verdict: null, reason: 'gate_lookup_500' });
});

test('a flake report from an earlier attempt is stale, never evidence for this one', async () => {
  const v2 = (runAttempt) => ({
    schema: 2,
    label: 'web-3',
    runner: 'vitest',
    attempts: 2,
    exitCode: 1,
    flaky: [],
    quarantined: [],
    first: { failures: ['a'] },
    second: { failures: ['b'] },
    noRetry: null,
    provenance: { runId: '9', runAttempt },
  });
  const jobsKey = `GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=1`;
  const artKey = `GET ${R}/actions/runs/9/artifacts?per_page=100&page=1`;
  const routesFor = (report, artifactPatch = {}) => {
    const zip = zipOf('flake-report-web-3.json', JSON.stringify(report));
    const routes = reportRun({ artifactSize: zip.length, zipBytes: zip });
    routes[jobsKey].body.jobs[0].run_attempt = 2;
    Object.assign(routes[artKey].body.artifacts[0], artifactPatch);
    return routes;
  };
  const current = await runFacts(gh(routesFor(v2('2'))).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(current.jobs[0].reportError, null);
  assert.equal(current.jobs[0].attempt, 2);
  const older = await runFacts(gh(routesFor(v2('1'))).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(older.jobs[0].report, null);
  assert.match(older.jobs[0].reportError, /^stale: report is from attempt 1/);
  // A schema-1 report has no provenance: its upload time decides, before any download.
  const { gh: api, fake } = gh(routesFor({ label: 'web-3', attempts: 2, flaky: [], quarantined: [], exitCode: 1 }, { updated_at: '2026-11-08T04:00:00Z' }));
  const early = await runFacts(api, { repo: REPO, runId: 9, ciYml });
  assert.match(early.jobs[0].reportError, /^stale: uploaded before this job attempt started/);
  assert.ok(!fake.calls.some((c) => c.key.includes('/artifacts/501/zip')));
});

test('a failed artifact listing is recorded on every retry-shard job, passed ones included', async () => {
  const routes = reportRun({ artifactSize: 1, zipBytes: Buffer.from('x') });
  routes[`GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=1`].body.jobs[0].conclusion = 'success';
  routes[`GET ${R}/actions/runs/9/artifacts?per_page=100&page=1`] = { status: 500, body: {} };
  const facts = await runFacts(gh(routes).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(facts.jobs[0].reportError, 'artifact listing 500');
});

test('a timed_out job is inspected like a failed one; jobsComplete reflects the listing', async () => {
  const zip = zipOf('flake-report-web-3.json', JSON.stringify({ label: 'web-3', attempts: 1, flaky: [], quarantined: [], exitCode: 1 }));
  const routes = reportRun({ artifactSize: zip.length, zipBytes: zip });
  const jobsKey = `GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=1`;
  routes[jobsKey].body.jobs[0].conclusion = 'timed_out';
  const { gh: api, fake } = gh(routes);
  const facts = await runFacts(api, { repo: REPO, runId: 9, ciYml });
  assert.equal(facts.jobs[0].logStatus, 200);
  assert.ok(fake.calls.some((c) => c.key.includes('/check-runs/91/annotations')));
  assert.equal(facts.jobsComplete, true);
  routes[jobsKey].body.total_count = 250;
  routes[jobsKey].body.jobs = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `Job ${i}`, conclusion: 'success', steps: [] }));
  routes[`GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=2`] = { status: 200, body: { total_count: 250, jobs: Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, name: `Job b${i}`, conclusion: 'success', steps: [] })) } };
  routes[`GET ${R}/actions/runs/9/jobs?filter=latest&per_page=100&page=3`] = { status: 200, body: { total_count: 250, jobs: Array.from({ length: 40 }, (_, i) => ({ id: 3000 + i, name: `Job c${i}`, conclusion: 'success', steps: [] })) } };
  const partial = await runFacts(gh(routes).gh, { repo: REPO, runId: 9, ciYml });
  assert.equal(partial.jobs.length, 240);
  assert.equal(partial.jobsComplete, false);
});

test('processLog strips timestamps and colour, keeps a tail, and splits attempts at the retry marker', () => {
  const ts = (s) => `2026-11-08T05:43:29.9984588Z ${s}`;
  const lines = [
    '﻿' + ts('Current runner version'),
    ts('\x1b[31m⎯⎯⎯\x1b[39m\x1b[1m\x1b[41m Failed Tests 1 \x1b[49m\x1b[22m\x1b[31m⎯⎯⎯\x1b[39m'),
    ts('\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/a.test.tsx\x1b[2m > \x1b[22mA\x1b[2m > \x1b[22mfirst'),
    ts('##[warning]web-3: attempt 1 failed with 1 failing test(s); re-running the whole shard once'),
    ts(' Failed Tests 1 '),
    ts(' FAIL  src/b.test.tsx > B > second'),
    ts('##[error]Process completed with exit code 1.'),
  ];
  const { logTail, logAttempts } = processLog(lines.join('\n'), 'vitest');
  assert.equal(logTail.split('\n')[0], 'Current runner version');
  assert.ok(!/\x1b|2026-11-08T/.test(logTail));
  assert.equal(logAttempts.length, 2);
  assert.deepEqual(logAttempts[0].failures, ['src/a.test.tsx > A > first']);
  assert.deepEqual(logAttempts[1].failures, ['src/b.test.tsx > B > second']);
  // No marker: one attempt. No runner: no attempts.
  assert.equal(processLog(lines.slice(0, 3).join('\n'), 'vitest').logAttempts.length, 1);
  assert.equal(processLog(lines.join('\n'), null).logAttempts, null);
  // The tail keeps the last 400 lines.
  const long = Array.from({ length: 1000 }, (_, i) => ts(`line ${i}`)).join('\n');
  const tail = processLog(long, null).logTail.split('\n');
  assert.equal(tail.length, 400);
  assert.equal(tail[399], 'line 999');
});

test('processLog reads plain go test output (retry-shard re-prints -json as text)', () => {
  const out = [
    '=== RUN   TestA',
    '--- FAIL: TestA (0.01s)',
    '=== RUN   TestB',
    '    --- FAIL: TestB/sub (0.00s)',
    '--- FAIL: TestB (0.00s)',
    'FAIL',
    'FAIL\tgithub.com/breeze-rmm/agent/internal/x\t0.02s',
    'ok  \tgithub.com/breeze-rmm/agent/internal/y\t0.01s',
    '--- PASS: TestC (0.00s)',
    'FAIL\tgithub.com/breeze-rmm/agent/internal/z [build failed]',
  ].join('\n');
  const [a] = processLog(out, 'go').logAttempts;
  // A parent implied by its failing subtest is dropped; a package with no
  // failing test (here a build failure) is reported as the package.
  assert.deepEqual(a.failures, [
    'github.com/breeze-rmm/agent/internal/x.TestA',
    'github.com/breeze-rmm/agent/internal/x.TestB/sub',
    'github.com/breeze-rmm/agent/internal/z',
  ]);
  assert.equal(a.buildFailed, true);
});
