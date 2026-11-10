import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { History, failureFromId, ingestRun } from './evidence.mjs';
import { fakeFetch, loadRoutes } from './fake-github.mjs';
import { isMutationQuery, createGitHub } from './github.mjs';
import { REPO_ROOT, main, parseArgs, renderReplay, replay, trimFacts } from './shepherd.mjs';

// Sightings, the recorded fixture set and the read-only replay (W06a, #10750).

const REPO = 'LanternOps/breeze';
const ciYml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const ingest = (facts) => ingestRun(facts, { repo: REPO, repoRoot: REPO_ROOT });

// Recorded from the API on 2026-11-08. `real-interaction` is #10287's queue
// failure on a test it touched (run 40753125135); date-bomb-1/2 are the two
// PRs the 2026-11-01 threatDetectionEvidence date bomb ejected (runs
// 41255349542, 41255342270).
const RECORDED = [
  '11312-runner-lost',
  '11312-web3-disjoint',
  '11338-psa-fail-fail',
  '11370-api1-fail-fail',
  'date-bomb-1',
  'date-bomb-2',
  'osv-504-1',
  'osv-504-2',
  'osv-504-3',
  'osv-504-4',
  'osv-504-5',
  'osv-504-6',
  'osv-504-7',
  'psa-fail-pass',
  'real-interaction',
];
// Every failed merge_group run of 2026-11-01 was checked: only two PRs hit the
// date bomb, so the third (the main_broken breaker opens on three) is cloned
// from date-bomb-1 under a fresh PR and run id.
const SYNTHETIC = ['date-bomb-3', 'synthetic-aggregate-only', 'synthetic-ci-success-missing', 'synthetic-timeout', 'synthetic-typecheck-dns'];

test('fixture directory holds exactly the recorded set', () => {
  const names = readdirSync(new URL('./fixtures/', import.meta.url))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
  const expected = [...RECORDED, ...SYNTHETIC].sort();
  assert.equal(names.length, expected.length);
  assert.deepEqual(names, expected);
  for (const n of names) {
    const fx = fixture(n);
    assert.equal(fx.name, n);
    assert.equal(fx.synthetic === true, SYNTHETIC.includes(n), `${n}: synthetic flag`);
    for (const j of fx.facts.jobs) assert.ok(j.logTail === null || j.logTail.split('\n').length <= 200, `${n}/${j.name}: tail ≤ 200 lines`);
  }
});

test('ingestRun reads each kind: fail_other, fail_pass, fail_fail', () => {
  const PSA = /^src\/components\/psa\/PsaConnectionsPage\.test\.tsx > /;
  const web3 = ingest(fixture('11312-web3-disjoint').facts);
  assert.deepEqual(web3.map((s) => [s.kind, PSA.test(s.id)]), [['fail_other', true]]);
  assert.equal(web3[0].runner, 'vitest-web');
  assert.equal(web3[0].file, 'apps/web/src/components/psa/PsaConnectionsPage.test.tsx');
  assert.equal(web3[0].pr, 11312);
  assert.equal(web3[0].event, 'merge_group');
  const pass = ingest(fixture('psa-fail-pass').facts).filter((s) => PSA.test(s.id));
  assert.deepEqual(pass.map((s) => s.kind), ['fail_pass']);
  const failFail = ingest(fixture('11338-psa-fail-fail').facts);
  assert.deepEqual(failFail.map((s) => [s.kind, PSA.test(s.id)]), [['fail_fail', true]]);
  // Runner lost: no attempts, no sightings. Infra jobs carry no test ids.
  assert.deepEqual(ingest(fixture('11312-runner-lost').facts), []);
  assert.deepEqual(ingest(fixture('osv-504-1').facts), []);
});

test('ingestRun drops fork runs', () => {
  const facts = structuredClone(fixture('11312-web3-disjoint').facts);
  assert.ok(ingest(facts).length > 0);
  facts.run.headRepo = 'someone/breeze';
  assert.deepEqual(ingest(facts), []);
  facts.run.headRepo = null;
  assert.deepEqual(ingest(facts), []);
});

test('duplicate sightings collapse', () => {
  const s = ingest(fixture('11312-web3-disjoint').facts);
  const h = History.fromSightings([...s, ...s, { ...s[0] }]);
  assert.equal(h.all().length, s.length);
  // A different attempt of the same run is a different sighting.
  assert.equal(History.fromSightings([...s, { ...s[0], attempt: 2 }]).all().length, s.length + 1);
});

test('failureFromId maps go ids to their package and vitest ids to their file', () => {
  assert.deepEqual(failureFromId('go', 'github.com/breeze-rmm/agent/internal/x.TestA/sub/case'), {
    id: 'github.com/breeze-rmm/agent/internal/x.TestA/sub/case',
    file: null,
    pkg: 'github.com/breeze-rmm/agent/internal/x',
  });
  assert.equal(failureFromId('go', 'github.com/breeze-rmm/agent/internal/x').pkg, 'github.com/breeze-rmm/agent/internal/x');
  assert.equal(failureFromId('vitest', 'src/broken.test.ts [ src/broken.test.ts ]').file, 'src/broken.test.ts');
});

// One failed_checks removal (#11312 removal 2) plus a manual one, served from
// recorded responses. Every request is checked: GET, or a GraphQL query.
function replayRoutes() {
  const routes = loadRoutes(new URL('./fixtures/api/11312-runner-lost.json', import.meta.url));
  const sha = 'e3702cf316ebeade516667668ea83b0c39ded9d2';
  const removal = {
    __typename: 'RemovedFromMergeQueueEvent',
    id: 'RFMQE_2',
    createdAt: '2026-11-08T07:08:59Z',
    reason: 'failed_checks',
    actor: { login: 'github-merge-queue' },
    beforeCommit: { oid: sha },
  };
  const manual = { ...removal, id: 'RFMQE_3', createdAt: '2026-11-08T07:28:57Z', reason: 'manual', actor: { login: 'op' }, beforeCommit: null };
  routes['POST /graphql'] = (req) => {
    if (/pullRequests\(/.test(req.body.query)) {
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ number: 11312, updatedAt: '2026-11-08T08:53:58Z', timelineItems: { nodes: [removal, manual] } }],
              },
            },
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              number: 11312,
              state: 'MERGED',
              headRefOid: 'a89d1382387cec939c6691b75740aba630fbd552',
              headRefName: 'feature/10991-wisp-check-in-timers/wave-10996',
              isCrossRepository: false,
              headRepository: { nameWithOwner: REPO },
              autoMergeRequest: null,
              mergeQueueEntry: null,
              labels: { nodes: [] },
              timelineItems: { nodes: [removal, manual] },
            },
          },
        },
      },
    };
  };
  routes[`GET /repos/${REPO}/pulls/11312/files?per_page=100&page=1`] = { status: 200, body: [{ filename: 'apps/api/src/routes/wisp/checkIns.ts' }] };
  routes[`GET /repos/${REPO}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&per_page=20`] = {
    status: 200,
    body: {
      total_count: 1,
      workflow_runs: [
        {
          id: 42453222760,
          run_attempt: 1,
          path: '.github/workflows/ci.yml',
          event: 'merge_group',
          head_branch: 'gh-readonly-queue/main/pr-11312-0000000000000000000000000000000000000000',
          head_sha: sha,
          created_at: '2026-11-08T06:04:30Z',
          conclusion: 'failure',
        },
      ],
    },
  };
  return routes;
}

test('replay never mutates, and gives one row per failed_checks removal', async () => {
  const fake = fakeFetch(replayRoutes());
  const gh = createGitHub({ token: 't', fetchImpl: fake.fetchImpl, budget: 100 });
  const result = await replay(gh, { repo: REPO, since: '2026-11-08', until: '2026-11-09', ciYml });
  for (const c of fake.calls) {
    if (c.url.includes('/graphql')) assert.equal(isMutationQuery(c.body.query), false, c.body.query.slice(0, 40));
    else assert.equal(c.method, 'GET', c.key);
  }
  assert.ok(fake.calls.some((c) => c.url.includes('/graphql')), 'GraphQL was exercised');
  assert.deepEqual(fake.unrouted, []);
  assert.equal(result.rows.length, 1, 'the manual removal is not a row');
  assert.deepEqual(
    (({ pr, run, class: c, signature }) => ({ pr, run, class: c, signature }))(result.rows[0]),
    { pr: 11312, run: 42453222760, class: 'infra', signature: 'runner_lost' },
  );
  assert.deepEqual(result.counts, { infra: 1 });
  assert.equal(result.complete, true);
  assert.doesNotMatch(renderReplay(result), /PARTIAL/);
  assert.match(renderReplay({ ...result, complete: false }), /^PARTIAL: /m);
  const table = renderReplay(result);
  assert.match(table, /^pr\tremoval_at\trun\tclass\tsignature\ttest_ids$/m);
  assert.match(table, /^11312\t2026-11-08T07:08:59Z\t42453222760\tinfra\trunner_lost\t-$/m);
  assert.match(table, /^total\t1$/m);
});

test('trimFacts keeps failed jobs, CI Success and reported jobs, and cuts tails to 200 lines', () => {
  const job = (name, conclusion, over = {}) => ({ name, conclusion, logTail: null, report: null, ...over });
  const facts = {
    run: {},
    jobs: [
      job('A', 'success'),
      job('B', 'failure', { logTail: Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n') }),
      job('C', 'success', { report: { label: 'web-1' } }),
      job('CI Success', 'failure'),
      job('D', 'skipped'),
    ],
  };
  const t = trimFacts(facts);
  assert.deepEqual(t.jobs.map((j) => j.name), ['B', 'C', 'CI Success']);
  assert.equal(t.jobs[0].logTail.split('\n').length, 200);
  assert.equal(t.jobs[0].logTail.split('\n')[199], 'l299');
});

test('CLI: bad arguments exit 2 before any API call', async () => {
  let made = 0;
  const makeGitHub = () => {
    made++;
    return null;
  };
  const bad = [
    [],
    ['nope'],
    ['replay'],
    ['replay', '--since', 'yesterday'],
    ['classify', '--run', 'x', '--pr', '1'],
    ['classify', '--run', '1'],
    ['record-fixture', '--run', '1', '--pr', '1'],
    ['record-fixture', '--run', '1', '--pr', '1', '--name', 'Bad Name'],
    ['replay', '--since', '2026-11-01', '--repo', 'not a repo'],
    ['replay', '--since', '2026-99-99'],
    ['replay', '--since', '2026-11-01', '--until', '2026-13-01'],
  ];
  for (const argv of bad) assert.equal(await main(argv, { makeGitHub }), 2, argv.join(' '));
  assert.equal(made, 0);
  assert.deepEqual(parseArgs(['replay', '--since', '2026-11-01', '--json']), { command: 'replay', repo: REPO, budget: 600, json: true, since: '2026-11-01' });
});
