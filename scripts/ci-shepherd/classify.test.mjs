import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CLASSES, DETERMINISTIC_JOBS, classifyJob, classifyRun } from './classify.mjs';
import { History, ingestRun } from './evidence.mjs';
import { jobIdentity, requiredJobIds } from './facts.mjs';
import { REPO_ROOT } from './shepherd.mjs';

// Classification of merge-queue failures (W06a, #10750). Expected classes live
// here, never in the fixtures: a fixture is recorded evidence, nothing more.

const REPO = 'LanternOps/breeze';
const ciYml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const requiredJobs = requiredJobIds(ciYml);
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const clone = (x) => structuredClone(x);
const empty = History.fromSightings([]);

const ctxFor = (fx, history = empty) => ({
  prFiles: new Set(fx.prFiles),
  history,
  repoRoot: REPO_ROOT,
  pr: fx.source.pr,
  now: Date.parse(fx.facts.run.updatedAt),
  requiredJobs,
});
const classify = (fx, history) => classifyRun(fx.facts, ctxFor(fx, history));
const historyOf = (...names) => History.fromSightings(names.flatMap((n) => ingestRun(fixture(n).facts, { repo: REPO, repoRoot: REPO_ROOT })));

const PSA = 'src/components/psa/PsaConnectionsPage.test.tsx > PsaConnectionsPage round-trip contract > ownerScope selector and All orgs badge > shows the selector defaulted to partner-wide and POSTs ownerScope:partner';

// ── The 2026-11-08 incidents ─────────────────────────────────────────────

test('11312-web3-disjoint → suspected_flake (attempt 1 PsaConnectionsPage, attempt 2 M365MailboxCard)', () => {
  const v = classify(fixture('11312-web3-disjoint'));
  assert.equal(v.class, 'suspected_flake');
  assert.equal(v.signature, null);
  assert.equal(v.jobs.length, 1);
  assert.match(v.testIds[0], /^src\/components\/settings\/M365MailboxCard\.test\.tsx > /);
});

test('11312-runner-lost → infra/runner_lost (the log is gone; the annotation is the evidence)', () => {
  const v = classify(fixture('11312-runner-lost'));
  assert.deepEqual([v.class, v.signature], ['infra', 'runner_lost']);
  assert.match(v.jobs[0].evidence.join('\n'), /lost communication with the server/);
});

test('osv-504-1…7 → infra/download_5xx, never real', () => {
  for (let i = 1; i <= 7; i++) {
    const v = classify(fixture(`osv-504-${i}`));
    assert.deepEqual([v.class, v.signature], ['infra', 'download_5xx'], `osv-504-${i}`);
  }
});

test('11338-psa-fail-fail: unknown on empty history; known_flake once other runs saw it flake', () => {
  const fx = fixture('11338-psa-fail-fail');
  const alone = classify(fx);
  assert.equal(alone.class, 'unknown');
  assert.deepEqual(alone.testIds, [PSA]);
  const v = classify(fx, historyOf('psa-fail-pass', '11312-web3-disjoint'));
  assert.equal(v.class, 'known_flake');
  assert.deepEqual(v.testIds, [PSA]);
  // Its own PR's non-queue runs never corroborate it, and neither does the run itself.
  const self = ingestRun(fixture('psa-fail-pass').facts, { repo: REPO, repoRoot: REPO_ROOT }).map((s) => ({ ...s, pr: fx.source.pr, event: 'pull_request' }));
  assert.equal(classify(fx, History.fromSightings(self)).class, 'unknown');
  // A sighting after the removal is not evidence at removal time.
  const later = ingestRun(fixture('11312-web3-disjoint').facts, { repo: REPO, repoRoot: REPO_ROOT }).map((s) => ({ ...s, at: '2026-11-09T00:00:00Z' }));
  assert.equal(classify(fx, History.fromSightings(later)).class, 'unknown');
});

// The plan expected "never suspected_flake" here, assuming a schema-1 report
// leaves only the last attempt recoverable. The job log keeps both attempts,
// and in run 42475142031 they failed different tests (staleCommandReaper, then
// aiToolsDevice.customFields; log lines 11212 and 21884 either side of the
// retry marker), the same evidence that makes 11312-web3 a suspected flake.
// The invariant kept: a schema-1 report alone never makes a flake.
test('11370-api1-fail-fail (schema-1 report, no ids): both attempts come from the log; the report alone never makes a flake', () => {
  const fx = fixture('11370-api1-fail-fail');
  const job = fx.facts.jobs.find((j) => j.label === 'api-1');
  assert.equal(job.report.schema, undefined, 'a schema-1 report');
  assert.deepEqual(job.report.flaky, []);
  const v = classify(fx);
  assert.equal(v.class, 'suspected_flake');
  assert.match(v.jobs[0].evidence[0], /disjoint tests \(job log\)/);
  assert.deepEqual(v.testIds, [job.logAttempts[1].failures[0]]);
  // Without the log, the schema-1 report names no test: unknown, never a flake.
  const noLog = clone(fx);
  const j = noLog.facts.jobs.find((x) => x.label === 'api-1');
  Object.assign(j, { logStatus: 404, logTail: null, logAttempts: null });
  const blind = classify(noLog);
  assert.equal(blind.class, 'unknown');
  assert.deepEqual(blind.testIds, []);
  // A log with only one attempt (no retry marker) is no pair either.
  const oneAttempt = clone(fx);
  const k = oneAttempt.facts.jobs.find((x) => x.label === 'api-1');
  k.logAttempts = [k.logAttempts[1]];
  assert.equal(classify(oneAttempt).class, 'unknown');
});

test('real-interaction: a failing test the PR touched is real, whatever the history says', () => {
  const fx = fixture('real-interaction');
  const v = classify(fx);
  assert.equal(v.class, 'real');
  assert.ok(v.testIds.length > 0);
  const flaky = v.testIds.map((id) => ({
    runner: 'vitest-integration',
    id,
    file: null,
    kind: 'fail_pass',
    run: 1,
    attempt: 1,
    job: 'x',
    pr: 1,
    event: 'merge_group',
    sha: 'x',
    at: fx.facts.run.createdAt,
  }));
  assert.equal(classify(fx, History.fromSightings(flaky)).class, 'real');
});

// ── Synthetic cases ──────────────────────────────────────────────────────

test('synthetic-typecheck-dns: DNS failure installing deps → infra/dns; the same job failing typecheck → real', () => {
  const fx = fixture('synthetic-typecheck-dns');
  assert.deepEqual([classify(fx).class, classify(fx).signature], ['infra', 'dns']);
  const typecheck = clone(fx);
  typecheck.facts.jobs[0].failedStep = 'Run typecheck';
  typecheck.facts.jobs[0].logTail = 'src/routes/devices.ts(12,3): error TS2322: Type string is not assignable to type number.';
  assert.deepEqual([classify(typecheck).class, classify(typecheck).signature], ['real', null]);
  // A setup-step failure alone is not infra.
  const setupOnly = clone(fx);
  setupOnly.facts.jobs[0].logTail = 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile';
  assert.equal(classify(setupOnly).class, 'real');
});

test('synthetic-timeout: cancelled at 54.5/55 min → timeout; cancelled at 20/55 → unknown', () => {
  const fx = fixture('synthetic-timeout');
  assert.deepEqual([classify(fx).class, classify(fx).signature], ['timeout', 'job_timeout']);
  const early = clone(fx);
  early.facts.jobs[0].completedAt = '2026-11-08T10:22:00Z';
  early.facts.jobs[0].annotations = ['The operation was canceled.'];
  assert.deepEqual([classify(early).class, classify(early).signature], ['unknown', null]);
});

test('synthetic-aggregate-only → unknown with aggregate_only', () => {
  const v = classify(fixture('synthetic-aggregate-only'));
  assert.equal(v.class, 'unknown');
  assert.deepEqual(v.evidence, ['aggregate_only']);
});

test('synthetic-ci-success-missing → infra/ci_success_missing', () => {
  assert.deepEqual(Object.values((({ class: c, signature }) => ({ c, signature }))(classify(fixture('synthetic-ci-success-missing')))), ['infra', 'ci_success_missing']);
  // Still running is not missing.
  const running = clone(fixture('synthetic-ci-success-missing'));
  running.facts.run.status = 'in_progress';
  assert.equal(classify(running).class, 'unknown');
});

test('gate reason not_pinned → gate_fault; api_error → infra/gate_infra', () => {
  const fx = clone(fixture('synthetic-aggregate-only'));
  fx.facts.gate = { verdict: 'fail', reason: 'not_pinned' };
  assert.equal(classify(fx).class, 'gate_fault');
  fx.facts.gate = { verdict: 'fail', reason: 'api_error' };
  assert.deepEqual([classify(fx).class, classify(fx).signature], ['infra', 'gate_infra']);
  // gate_fault outranks a real failure; gate_infra never masks one.
  const real = clone(fixture('synthetic-typecheck-dns'));
  real.facts.jobs[0].failedStep = 'Run typecheck';
  real.facts.jobs[0].logTail = 'error TS2322';
  real.facts.gate = { verdict: 'fail', reason: 'error' };
  assert.equal(classify(real).class, 'gate_fault');
  real.facts.gate = { verdict: 'fail', reason: 'api_error' };
  assert.equal(classify(real).class, 'real');
});

// ── Guards ───────────────────────────────────────────────────────────────

const vitestJob = (over = {}) => ({
  id: 1,
  name: 'Test API (shard 2/8)',
  jobId: 'test-api',
  conclusion: 'failure',
  startedAt: '2026-11-08T10:00:00Z',
  completedAt: '2026-11-08T10:20:00Z',
  timeoutMinutes: 40,
  label: 'api-2',
  runner: 'vitest',
  failedStep: 'Run API tests',
  annotations: [],
  logStatus: 200,
  logTail: '',
  logAttempts: null,
  report: null,
  reportError: null,
  errors: [],
  ...over,
});
const attempt = (failures, extra = {}) => ({ failures, truncated: false, unattributed: false, buildFailed: false, raceDetected: false, timedOut: false, ...extra });
const jobCtx = { prFiles: new Set(), history: empty, repoRoot: REPO_ROOT, pr: 1, now: Date.parse('2026-11-08T11:00:00Z') };

test('a log-text signature never hides parsed test failures', () => {
  const ids = ['src/routes/rateLimit.test.ts > limits > returns 429 after the burst'];
  const job = vitestJob({ logTail: 'AssertionError: expected "rate limit exceeded" to equal "ok"\nHTTP 503', logAttempts: [attempt(ids), attempt(ids)] });
  assert.equal(classifyJob(job, jobCtx).class, 'unknown');
  // With no parsed failures the same text is a registry rate limit.
  const pull = vitestJob({ failedStep: 'Start test-stack containers', logTail: 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.', logAttempts: [attempt([])] });
  assert.deepEqual([classifyJob(pull, jobCtx).class, classifyJob(pull, jobCtx).signature], ['infra', 'registry_rate_limit']);
});

test('empty failures never mean flake: both attempts with no parsed ids → unknown', () => {
  const report = { schema: 2, label: 'api-2', runner: 'vitest', attempts: 2, exitCode: 1, flaky: [], quarantined: [], first: attempt([]), second: attempt([]), noRetry: null };
  assert.equal(classifyJob(vitestJob({ report }), jobCtx).class, 'unknown');
  // An unattributed attempt (vitest Unhandled Errors) is never a clean disjoint pair.
  const messy = { ...report, first: attempt(['src/a.test.ts > a']), second: attempt(['src/b.test.ts > b'], { unattributed: true }) };
  assert.equal(classifyJob(vitestJob({ report: messy }), jobCtx).class, 'unknown');
  const disjoint = { ...report, first: attempt(['src/a.test.ts > a']), second: attempt(['src/b.test.ts > b']) };
  assert.equal(classifyJob(vitestJob({ report: disjoint }), jobCtx).class, 'suspected_flake');
  // The same test twice is not a flake.
  const repeat = { ...report, first: attempt(['src/a.test.ts > a']), second: attempt(['src/a.test.ts > a']) };
  assert.equal(classifyJob(vitestJob({ report: repeat }), jobCtx).class, 'unknown');
});

test('touched means the test file, its sibling source or its Go package — not any file under apps/api/src', () => {
  const report = { schema: 2, label: 'integration-3', runner: 'vitest', attempts: 2, exitCode: 1, flaky: [], quarantined: [], noRetry: null };
  const id = 'src/__tests__/integration/alerts.integration.test.ts > alerts > fires';
  const job = vitestJob({ name: 'Integration Tests (shard 3/16)', jobId: 'integration-test', label: 'integration-3', report: { ...report, first: attempt([id]), second: attempt([id]) } });
  const unrelated = { ...jobCtx, prFiles: new Set(['apps/api/src/services/devices.ts']) };
  assert.equal(classifyJob(job, unrelated).class, 'unknown');
  const testFile = { ...jobCtx, prFiles: new Set(['apps/api/src/__tests__/integration/alerts.integration.test.ts']) };
  assert.equal(classifyJob(job, testFile).class, 'real');
  const goId = 'github.com/breeze-rmm/agent/internal/heartbeat.TestReconnect';
  const goJob = vitestJob({ name: 'Test Agent', jobId: 'test-agent', label: 'agent', runner: 'go', report: { ...report, label: 'agent', runner: 'go', first: attempt([goId]), second: attempt([goId]) } });
  assert.equal(classifyJob(goJob, { ...jobCtx, prFiles: new Set(['agent/internal/heartbeat/heartbeat.go']) }).class, 'real');
  assert.equal(classifyJob(goJob, { ...jobCtx, prFiles: new Set(['agent/internal/other/x.go']) }).class, 'unknown');
});

test('known_flake needs every failing id corroborated, from another PR or a merge_group run, within 14 days', () => {
  const a = 'src/a.test.ts > a';
  const b = 'src/b.test.ts > b';
  const report = { schema: 2, label: 'api-2', runner: 'vitest', attempts: 2, exitCode: 1, flaky: [], quarantined: [], noRetry: null, first: attempt([a, b]), second: attempt([a, b]) };
  const job = vitestJob({ report });
  const s = (id, over = {}) => ({ runner: 'vitest-api', id, file: null, kind: 'fail_pass', run: 7, attempt: 1, job: 'x', pr: 2, event: 'pull_request', sha: 'x', at: '2026-11-07T00:00:00Z', ...over });
  const ctx = (list) => ({ ...jobCtx, history: History.fromSightings(list) });
  assert.equal(classifyJob(job, ctx([s(a)])).class, 'unknown', 'b is uncorroborated');
  assert.equal(classifyJob(job, ctx([s(a), s(b)])).class, 'known_flake');
  assert.equal(classifyJob(job, ctx([s(a), s(b, { kind: 'fail_fail' })])).class, 'unknown', 'fail_fail is not flake evidence');
  assert.equal(classifyJob(job, ctx([s(a), s(b, { at: '2026-10-20T00:00:00Z' })])).class, 'unknown', 'older than 14 days');
  assert.equal(classifyJob(job, ctx([s(a), s(b, { pr: 1 })])).class, 'unknown', "the PR's own pull_request run");
  assert.equal(classifyJob(job, ctx([s(a), s(b, { pr: 1, event: 'merge_group' })])).class, 'known_flake', 'a merge_group run counts');
  assert.equal(classifyJob(job, ctx([s(a), s(b, { runner: 'vitest-web' })])).class, 'unknown', 'another runner');
});

test('a failed job outside CI Success needs is ignored (Test Agent (race) does not block)', () => {
  assert.ok(!requiredJobs.has('test-agent-race'));
  const fx = clone(fixture('synthetic-aggregate-only'));
  fx.facts.jobs.unshift(vitestJob({ name: 'Test Agent (race)', jobId: 'test-agent-race', label: 'agent-race', runner: 'go', conclusion: 'cancelled' }));
  assert.deepEqual(classify(fx).evidence, ['aggregate_only']);
  // Without the needs list every failed job counts.
  assert.equal(classifyRun(fx.facts, { ...ctxFor(fx), requiredJobs: undefined }).class, 'unknown');
  assert.equal(classifyRun(fx.facts, { ...ctxFor(fx), requiredJobs: undefined }).jobs.length, 1);
});

test('classifyRun takes the most severe job class and unions the test ids', () => {
  assert.deepEqual(CLASSES, ['gate_fault', 'real', 'unknown', 'timeout', 'suspected_flake', 'known_flake', 'infra']);
  const flake = fixture('11312-web3-disjoint').facts.jobs.find((j) => j.label === 'web-3');
  const lost = fixture('11312-runner-lost').facts.jobs.find((j) => j.label === 'integration-11');
  const facts = { ...clone(fixture('11312-web3-disjoint').facts), jobs: [clone(lost), clone(flake)] };
  const v = classifyRun(facts, { ...jobCtx, requiredJobs });
  assert.equal(v.class, 'suspected_flake');
  assert.deepEqual(v.jobs.map((j) => j.class), ['infra', 'suspected_flake']);
  const typecheck = clone(fixture('synthetic-typecheck-dns').facts.jobs[0]);
  typecheck.failedStep = 'Run typecheck';
  typecheck.logTail = 'error TS2322';
  const worse = classifyRun({ ...facts, jobs: [...facts.jobs, typecheck] }, { ...jobCtx, requiredJobs });
  assert.equal(worse.class, 'real');
  assert.ok(worse.testIds.length >= 1);
});

test('date-bomb-1…3: the same untouched test failing both attempts in three PRs → unknown each (the breaker is W06b)', () => {
  const ids = new Set();
  for (let i = 1; i <= 3; i++) {
    const v = classify(fixture(`date-bomb-${i}`));
    assert.equal(v.class, 'unknown', `date-bomb-${i}`);
    for (const id of v.testIds) ids.add(id);
  }
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^src\/__tests__\/integration\/threatDetectionEvidence\.integration\.test\.ts > /);
  // Its sightings are fail_fail: never flake evidence for one another.
  assert.equal(classify(fixture('date-bomb-2'), historyOf('date-bomb-1', 'date-bomb-3')).class, 'unknown');
});

test('infra signatures: runner shutdown, apt, disk; free-text forms stand down when test output explains the failure', () => {
  const sig = (job) => {
    const v = classifyJob(job, jobCtx);
    return `${v.class}/${v.signature}`;
  };
  const setup = { failedStep: 'Install system packages', logAttempts: [attempt([])] };
  assert.equal(sig(vitestJob({ logTail: '##[error]The runner has received a shutdown signal.' })), 'infra/runner_shutdown');
  assert.equal(sig(vitestJob({ ...setup, logTail: 'E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/x.deb  503' })), 'infra/apt_fetch');
  assert.equal(sig(vitestJob({ annotations: ['System.IO.IOException: No space left on device'] })), 'infra/disk_full');
  // An ENOSPC test failing prints the same words: its log form is not infra.
  const enospc = ['src/services/backup.test.ts > backup > reports ENOSPC'];
  assert.equal(sig(vitestJob({ logTail: 'Error: No space left on device', logAttempts: [attempt(enospc), attempt(enospc)] })), 'unknown/null');
  // The app's own rate limiter is not a registry rate limit.
  assert.equal(sig(vitestJob({ ...setup, logTail: '{"error":"Rate limit exceeded"}' })), 'unknown/null');
  assert.equal(sig(vitestJob({ ...setup, logTail: 'Error: API rate limit exceeded for installation ID 1.' })), 'infra/registry_rate_limit');
});

test('free-text signatures stand down over unattributed output even when no test id parsed', () => {
  const crash = vitestJob({ failedStep: 'Install deps then run tests', logTail: 'curl: (22) The requested URL returned error: 503', logAttempts: [attempt([], { unattributed: true })] });
  assert.deepEqual([classifyJob(crash, jobCtx).class, classifyJob(crash, jobCtx).signature], ['unknown', null]);
  const plain = vitestJob({ failedStep: 'Install deps then run tests', logTail: 'curl: (22) The requested URL returned error: 503', logAttempts: [attempt([])] });
  assert.equal(classifyJob(plain, jobCtx).signature, 'download_5xx');
});

test('a killed or timed-out attempt is never half of a flake pair, nor known_flake evidence', () => {
  const report = (second) => ({ schema: 2, label: 'api-2', runner: 'vitest', attempts: 2, exitCode: 1, flaky: [], quarantined: [], noRetry: null, first: { ...attempt(['src/a.test.ts > a']), code: 1 }, second });
  assert.equal(classifyJob(vitestJob({ report: report({ ...attempt(['src/b.test.ts > b']), code: 1 }) }), jobCtx).class, 'suspected_flake');
  assert.equal(classifyJob(vitestJob({ report: report({ ...attempt(['src/b.test.ts > b']), code: null }) }), jobCtx).class, 'unknown');
  assert.equal(classifyJob(vitestJob({ report: report({ ...attempt(['src/b.test.ts > b'], { timedOut: true }), code: 1 }) }), jobCtx).class, 'unknown');
  const history = History.fromSightings([
    { runner: 'vitest-api', id: 'src/b.test.ts > b', file: null, kind: 'fail_pass', run: 7, attempt: 1, job: 'x', pr: 2, event: 'merge_group', sha: 'x', at: '2026-11-08T00:00:00Z' },
  ]);
  const killed = report({ ...attempt(['src/b.test.ts > b']), code: null });
  killed.first = killed.second;
  assert.equal(classifyJob(vitestJob({ report: killed }), { ...jobCtx, history }).class, 'unknown');
});

test('ci_success_missing needs finished jobs: an empty or partial job list is not infra', () => {
  const fx = clone(fixture('synthetic-ci-success-missing'));
  fx.facts.jobs = [];
  assert.equal(classify(fx).class, 'unknown');
  const partial = clone(fixture('synthetic-ci-success-missing'));
  partial.facts.jobsComplete = false;
  const v = classify(partial);
  assert.equal(v.class, 'unknown');
  assert.deepEqual(v.gaps, ['job list incomplete']);
  const startup = clone(fixture('synthetic-ci-success-missing'));
  startup.facts.run.conclusion = 'startup_failure';
  assert.equal(classify(startup).class, 'unknown');
});

test('evidence that could not be read is named in the verdict', () => {
  const blind = vitestJob({ logStatus: 502, logTail: null, logAttempts: null, errors: ['annotations 429'], reportError: 'artifact listing 500' });
  const v = classifyJob(blind, jobCtx);
  assert.equal(v.class, 'unknown');
  assert.deepEqual(v.gaps, ['annotations 429', 'log 502', 'flake report: artifact listing 500']);
  assert.match(v.evidence[0], /evidence unavailable: annotations 429, log 502/);
  // A report that was simply never uploaded is not a gap.
  assert.deepEqual(classifyJob(vitestJob({ reportError: 'not_uploaded', logStatus: 200 }), jobCtx).gaps, []);
  const fx = clone(fixture('synthetic-aggregate-only'));
  fx.facts.jobs.unshift(blind);
  fx.facts.gate = { verdict: null, reason: 'gate_lookup_500' };
  const run = classify(fx);
  assert.deepEqual(run.gaps, ['CI Gate: gate_lookup_500', 'Test API (shard 2/8): annotations 429', 'Test API (shard 2/8): log 502', 'Test API (shard 2/8): flake report: artifact listing 500']);
});

test('a timed_out or startup_failure job counts as failed', () => {
  const fx = clone(fixture('synthetic-aggregate-only'));
  fx.facts.jobs.unshift(vitestJob({ conclusion: 'timed_out' }));
  assert.equal(classify(fx).jobs.length, 1);
  assert.notDeepEqual(classify(fx).evidence, ['aggregate_only']);
});

test('every deterministic job name exists in ci.yml', () => {
  for (const name of DETERMINISTIC_JOBS) assert.notEqual(jobIdentity(ciYml, name).jobId, null, name);
});
