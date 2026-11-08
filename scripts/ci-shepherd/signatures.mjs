// Positive infrastructure signatures for merge-queue failures (W06a, #10750).
//
// Each signature must match positively: a failed setup step alone is never
// infra. Signatures that read free log text (download_5xx, apt_fetch, dns,
// registry_rate_limit) apply only when the job has no parsed test failures,
// so a test whose own output mentions "rate limit exceeded" or "HTTP 500"
// cannot hide behind them. GitHub's own runner annotations always apply.
//
// `scope: 'job'` signatures test one JobFact; `scope: 'run'` ones test the
// run when no required job failed (classify.mjs).

const FETCH_STEP = /install|download|fetch|setup|restore/i;
const CURL_5XX = /curl: \(22\) The requested URL returned error: 5\d\d/;
const HTTP_5XX = /\b(?:HTTP|status)[ :/]+5\d\d\b/;
const DNS = /Could not resolve host|EAI_AGAIN|getaddrinfo ENOTFOUND/;
const RUNNER_LOST = /The hosted runner lost communication with the server/;
const RUNNER_SHUTDOWN = /The runner has received a shutdown signal/;
const APT = /E: Failed to fetch|Temporary failure resolving/;
const RATE_LIMIT = /toomanyrequests|rate limit exceeded/i;
const DISK = /No space left on device/;

export const GATE_INFRA_REASONS = new Set(['api_error', 'ci_run_missing', 'deadline']);

const log = (job) => job.logTail ?? '';
const anyText = (job, re) => job.annotations.some((a) => re.test(a)) || re.test(log(job));
const fetchStep = (job) => FETCH_STEP.test(job.failedStep ?? '');
// ctx.testFailures: the job's parsed failing ids (classify.mjs).
const noTests = (ctx) => !ctx?.testFailures?.length;

export const INFRA_SIGNATURES = [
  { id: 'runner_lost', scope: 'job', test: (job) => job.annotations.some((a) => RUNNER_LOST.test(a)) },
  { id: 'runner_shutdown', scope: 'job', test: (job) => anyText(job, RUNNER_SHUTDOWN) },
  {
    id: 'download_5xx',
    scope: 'job',
    test: (job, ctx) => noTests(ctx) && fetchStep(job) && (CURL_5XX.test(log(job)) || HTTP_5XX.test(log(job))),
  },
  { id: 'apt_fetch', scope: 'job', test: (job, ctx) => noTests(ctx) && APT.test(log(job)) },
  { id: 'dns', scope: 'job', test: (job, ctx) => noTests(ctx) && fetchStep(job) && DNS.test(log(job)) },
  { id: 'registry_rate_limit', scope: 'job', test: (job, ctx) => noTests(ctx) && RATE_LIMIT.test(log(job)) },
  { id: 'disk_full', scope: 'job', test: (job) => anyText(job, DISK) },
  {
    // A job that hit `timeout-minutes` reports `cancelled`; only the duration
    // tells it from a cancel.
    id: 'job_timeout',
    scope: 'job',
    class: 'timeout',
    test: (job) =>
      job.conclusion === 'cancelled' &&
      Number.isFinite(job.timeoutMinutes) &&
      Boolean(job.startedAt && job.completedAt) &&
      Date.parse(job.completedAt) - Date.parse(job.startedAt) >= (job.timeoutMinutes - 1) * 60_000,
  },
  {
    id: 'ci_success_missing',
    scope: 'run',
    test: (_, facts) => facts.run.status === 'completed' && facts.ciSuccess === 'missing',
  },
  { id: 'gate_infra', scope: 'run', test: (_, facts) => GATE_INFRA_REASONS.has(facts.gate?.reason) },
];

// The log or annotation line that matched, for the verdict's evidence.
export function signatureEvidence(job) {
  const lines = [...job.annotations.map((a) => `annotation: ${a}`), ...log(job).split('\n').map((l) => `log: ${l}`)];
  const res = [RUNNER_LOST, RUNNER_SHUTDOWN, CURL_5XX, DNS, APT, RATE_LIMIT, DISK, HTTP_5XX];
  const hit = lines.find((l) => res.some((re) => re.test(l)));
  return hit ? [hit.slice(0, 300)] : [];
}
