// Classify a merge-queue failure from run evidence (W06a, #10750).
//
// classifyJob: first match wins.
//   1. An infra signature matches → `infra` (or `timeout` for job_timeout).
//   2. A failing test the PR touched (the test file, its sibling source or its
//      Go package) → `real`.
//   3. Two clean attempts that failed on disjoint tests → `suspected_flake`.
//   4. Every failing test was seen failing-then-passing (or failing beside
//      other failures) in another PR's run or a merge_group run within 14
//      days → `known_flake`.
//   5. A deterministic job (lint, typecheck, migrations, builds) → `real`.
//   6. Otherwise `unknown`. No failing ids and no signature is always
//      `unknown`, never a flake.
// Failing ids come from a schema-2 flake report (the second attempt's, else
// the first's), else from the job log's last attempt (facts.processLog).
//
// classifyRun takes the most severe job verdict, in the order of CLASSES.
// None of this proves a flake: suspected_flake and known_flake are bounded
// bets the decision layer budgets, and a retry never turns a failure into a pass.
import { join } from 'node:path';

import { failureTouched } from '../../.github/scripts/flaky-ledger.mjs';
import { ledgerPaths, ledgerRunner } from '../../.github/scripts/retry-shard.mjs';
import { GO_DIR, attemptsOf, failureFromId } from './evidence.mjs';
import { isFailedConclusion } from './facts.mjs';
import { INFRA_SIGNATURES, signatureEvidence } from './signatures.mjs';

// Most severe first.
export const CLASSES = ['gate_fault', 'real', 'unknown', 'timeout', 'suspected_flake', 'known_flake', 'infra'];
export const KNOWN_FLAKE_DAYS = 14;
export const GATE_FAULT_REASONS = new Set(['error', 'not_pinned', 'aggregator_unparseable', 'base_unreadable', 'head_unparseable', 'duplicate_job_name']);
// Jobs whose failure no retry changes. `Lint Agent (Go)` is the display name
// in ci.yml; every name starting `Build ` is a build.
export const DETERMINISTIC_JOBS = new Set(['Lint', 'Type Check', 'Docs Check', 'Check Migrations', 'Check Migrations (non-superuser)', 'Lint Agent (Go)']);
export const isDeterministic = (name) => DETERMINISTIC_JOBS.has(name) || name.startsWith('Build ');

const CI_SUCCESS = 'CI Success';
const FLAKE_KINDS = new Set(['fail_pass', 'fail_other']);
const severity = (cls) => CLASSES.indexOf(cls);
// An attempt whose failure ids explain it: it was not killed by a signal
// (`code: null`, schema 2 only), timed out, raced, failed to build, or had
// output no test explains, and its id list is complete.
const clean = (a) => a && a.code !== null && !a.timedOut && !a.unattributed && !a.buildFailed && !a.raceDetected && !a.truncated;

// Evidence the shepherd tried and failed to read. It never changes a class by
// itself (missing evidence can only remove a match, never add one), but a
// verdict reached without it says so, so "nothing to find" and "could not
// look" are not the same line.
export function evidenceGaps(job) {
  const gaps = [...(job.errors ?? [])];
  if (job.logStatus !== null && job.logStatus !== undefined && job.logStatus !== 200) gaps.push(`log ${job.logStatus}`);
  if (job.reportError && job.reportError !== 'not_uploaded') gaps.push(`flake report: ${job.reportError}`);
  return gaps;
}

// The ids that failed the job, and where they came from.
function failingIds(job) {
  const a = attemptsOf(job);
  if (a?.source === 'report' && a.first) {
    const last = a.second ?? a.first;
    return { ids: last.failures, last, attempts: a };
  }
  if (a?.source === 'log') {
    const last = a.second ?? a.first;
    return { ids: last.failures, last, attempts: a };
  }
  return { ids: [], last: null, attempts: a };
}

function touchedPaths(job, repoRoot) {
  const ledger = job.runner && job.label ? ledgerRunner(job.runner, job.label) : null;
  const paths = ledger ? ledgerPaths(ledger, { repoRoot, goDir: join(repoRoot, GO_DIR) }) : null;
  // Without sourceRoot on purpose: for classification it would make every API
  // PR's integration failure "real".
  return { ledger, paths: { ...(paths ?? {}), sourceRoot: undefined } };
}

export function classifyJob(job, ctx) {
  const gaps = evidenceGaps(job);
  const verdict = (j, cls, signature, testIds, evidence) => ({ job: j.name, class: cls, signature, testIds, evidence, gaps });
  const { ids, last, attempts } = failingIds(job);
  for (const sig of INFRA_SIGNATURES) {
    if (sig.scope !== 'job' || !sig.test(job, { testFailures: ids, unattributed: Boolean(last?.unattributed) })) continue;
    return verdict(job, sig.class ?? 'infra', sig.id, ids, [`signature ${sig.id}`, ...signatureEvidence(job)]);
  }
  const { ledger, paths } = touchedPaths(job, ctx.repoRoot);
  const failures = ids.map((id) => failureFromId(job.runner, id));
  const touched = failures.filter((f) => failureTouched(f, ctx.prFiles, paths));
  if (touched.length) return verdict(job, 'real', null, ids, touched.map((f) => `touched by the PR: ${f.id}`));

  const source = attempts?.source === 'log' ? 'job log' : 'flake report';
  if (attempts?.first && attempts?.second && ids.length && attempts.first.failures.length && clean(attempts.first) && clean(attempts.second)) {
    const second = new Set(attempts.second.failures);
    if (!attempts.first.failures.some((id) => second.has(id))) {
      return verdict(job, 'suspected_flake', null, ids, [`attempts failed on disjoint tests (${source})`]);
    }
  }

  if (ids.length && ledger && clean(last) && ctx.history) {
    const now = ctx.now ?? Date.now();
    const since = new Date(now - KNOWN_FLAKE_DAYS * 86_400_000).toISOString();
    const until = new Date(now).toISOString();
    const seen = ids.map((id) =>
      ctx.history.sightings(ledger, id, { since, until, excludePr: ctx.pr ?? null, excludeRun: ctx.runId ?? null }).filter((s) => FLAKE_KINDS.has(s.kind)),
    );
    if (seen.every((s) => s.length > 0)) {
      return verdict(job, 'known_flake', null, ids, ids.map((id, i) => `${id}: seen flaking in run ${seen[i][0].run} (${seen[i][0].kind})`));
    }
  }

  if (isDeterministic(job.name)) return verdict(job, 'real', null, ids, ['deterministic job, no infra signature']);
  const why = ids.length ? 'failing tests not corroborated as flaky' : gaps.length ? `no failing test ids and no signature; evidence unavailable: ${gaps.join(', ')}` : 'no failing test ids and no signature';
  return verdict(job, 'unknown', null, ids, [why]);
}

// ctx: { prFiles: Set, history, repoRoot, pr?, now?, requiredJobs? }.
// `requiredJobs` (ci.yml job ids CI Success needs) drops failed jobs outside
// the aggregate: they cannot have caused the removal, and jobs still running
// at removal time are cancelled afterwards when GitHub deletes the queue ref.
// RunVerdict = { class, signature, testIds, jobs, evidence, gaps }. `gaps`
// lists evidence that could not be read (job logs, annotations, reports, the
// gate lookup, a partial job list); W06b decides what a gap costs.
export function classifyRun(facts, ctx) {
  const runGaps = [];
  if (facts.jobsComplete === false) runGaps.push('job list incomplete');
  const reason = facts.gate?.reason ?? null;
  if (reason && /^gate_(?:lookup_|line_missing)/.test(reason)) runGaps.push(`CI Gate: ${reason}`);
  if (GATE_FAULT_REASONS.has(reason)) {
    return { class: 'gate_fault', signature: null, testIds: [], jobs: [], evidence: [`CI Gate reason ${reason}`], gaps: runGaps };
  }
  const failed = facts.jobs.filter(
    (j) => isFailedConclusion(j.conclusion) && j.name !== CI_SUCCESS && (!ctx.requiredJobs || !j.jobId || ctx.requiredJobs.has(j.jobId)),
  );
  if (!failed.length) {
    for (const sig of INFRA_SIGNATURES) {
      if (sig.scope === 'run' && sig.test(null, facts)) return { class: 'infra', signature: sig.id, testIds: [], jobs: [], evidence: [`signature ${sig.id}`], gaps: runGaps };
    }
    return { class: 'unknown', signature: null, testIds: [], jobs: [], evidence: ['aggregate_only'], gaps: runGaps };
  }
  const jobs = failed.map((j) => classifyJob(j, { ...ctx, runId: facts.run.id }));
  const worst = jobs.reduce((a, b) => (severity(b.class) < severity(a.class) ? b : a));
  return {
    class: worst.class,
    signature: worst.signature,
    testIds: [...new Set(jobs.flatMap((j) => j.testIds))],
    jobs,
    evidence: [`${worst.job}: ${worst.class}`],
    gaps: [...runGaps, ...jobs.flatMap((j) => j.gaps.map((g) => `${j.job}: ${g}`))],
  };
}
