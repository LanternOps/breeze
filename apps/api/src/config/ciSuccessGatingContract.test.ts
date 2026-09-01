import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
// Scope the job-header scan to the `jobs:` section. Scanning the whole file also matches
// two-space keys under `on:` (`push:` is the live example), which would be reported as
// ungated jobs — a parser bug that must not be papered over by exempting them.
const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));
const jobHeaderMatches = [...jobsSection.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)];
const workflowJobs = jobHeaderMatches.flatMap((match) => {
  const job = match?.[1];
  return job ? [job] : [];
});
const jobBodies = new Map(
  jobHeaderMatches.flatMap((match, index) => {
    const job = match?.[1];
    const start = match?.index;
    if (!job || start === undefined) return [];

    const end = jobHeaderMatches[index + 1]?.index ?? jobsSection.length;
    return [[job, jobsSection.slice(start, end)] as const];
  }),
);
const ciSuccess = workflow.slice(
  workflow.indexOf('  ci-success:'),
  workflow.indexOf('  main-red-alert:'),
);
const needsMatch = ciSuccess.match(/^    needs: \[([^\]]+)]$/m);
const neededJobs = needsMatch?.[1]?.split(',').map((job) => job.trim()) ?? [];
const envBlock = ciSuccess.slice(ciSuccess.indexOf('        env:'), ciSuccess.indexOf('        run: |'));
const resultEnvByName = new Map(
  [...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*_RESULT): \$\{\{ needs\.([a-z0-9-]+)\.result \}\}$/gm)].flatMap(
    ([, envVar, job]) => (envVar && job ? [[envVar, job] as const] : []),
  ),
);
const blockingStart = ciSuccess.indexOf('if [[');
const blockingEnd = ciSuccess.indexOf('; then', blockingStart) + '; then'.length;
const blockingCondition = ciSuccess.slice(blockingStart, blockingEnd);
const conditionalChecks = ciSuccess.slice(blockingEnd);

// smoke-test and guided-setup-smoke are deliberately non-blocking on PRs and required on main
// pushes via the IS_PR guard (both boot a full stack; guided-setup-smoke also runs the real
// self-host installer + systemd unit on the runner).
const PR_EXEMPT_JOBS = new Set(['smoke-test', 'guided-setup-smoke']);

const UNGATED_JOBS = new Set([
  'ci-success', // the aggregate itself
  'main-red-alert', // runs after ci-success, alerts on a red main
  'rust-check-windows', // deliberately excluded, documented at its job definition: path-filtered and usually skipped
  'check-migrations', // KNOWN GAP, not policy - see comment below
  'lint-agent', // KNOWN GAP
  'test-agent-race', // KNOWN GAP
  'agent-windows-manifest-guard', // KNOWN GAP
]);
// The four KNOWN GAP jobs above run on every PR but are not in ci-success needs:, so they
// cannot block a merge — the same defect as #3941. They are pinned here so the gap is visible
// and any NEW job must be a conscious decision, not silently ungated. Promoting them is
// deliberately out of scope for this PR: check-migrations is currently red repo-wide, tracked
// by #4227, so making it blocking would block every PR.

describe('ci-success gating contract', () => {
  // Without this, a change to the `needs:` / `env:` / `run:` formatting would empty the parsed
  // sets and make every filter-based assertion below pass vacuously — the exact failure mode
  // this suite exists to catch. Fail loudly on a parse miss instead.
  it('parses the ci-success job (guards against vacuous assertions)', () => {
    expect(ciSuccess, 'could not locate the ci-success job in ci.yml').not.toHaveLength(0);
    expect(neededJobs.length, 'ci-success needs: parsed to too few jobs — the parser is stale').toBeGreaterThan(
      20,
    );
    expect(
      resultEnvByName.size,
      'the ci-success result env block parsed to too few entries — the parser is stale',
    ).toBeGreaterThan(20);
    expect(blockingCondition, 'could not locate the unconditional blocking if-condition').toContain('; then');
    expect(blockingCondition.startsWith('if [['), 'blocking condition did not start at `if [[`').toBe(true);
  });

  it('every job in ci-success needs: has a result env var', () => {
    const mappedJobs = new Set(resultEnvByName.values());
    const missingJobs = neededJobs.filter((job) => !mappedJobs.has(job));

    expect(
      missingJobs,
      `Jobs in ci-success needs: without result env vars: ${missingJobs.join(', ')}`,
    ).toEqual([]);
  });

  it('every required job is actually asserted in the blocking condition', () => {
    const missingJobs = neededJobs.filter((job) => {
      if (PR_EXEMPT_JOBS.has(job)) return false;
      const envVar = [...resultEnvByName].find(([, mappedJob]) => mappedJob === job)?.[0];
      return !envVar || !blockingCondition.includes(`[[ "\${${envVar}}" != "success" ]]`);
    });

    expect(
      missingJobs,
      `Jobs not asserted in the unconditional blocking condition: ${missingJobs.join(', ')}. ` +
        'Being in needs: alone does not fail the gate.',
    ).toEqual([]);
  });

  it('smoke-test is still guarded on main pushes', () => {
    expect(
      conditionalChecks,
      'The smoke-test PR exemption changed shape and must be re-reviewed.',
    ).toContain(
      `if [[ "\${IS_PR}" != "true" ]] && [[ "\${SMOKE_TEST_RESULT}" != "success" ]]; then`,
    );
  });

  it('guided-setup-smoke is still guarded on main pushes', () => {
    expect(
      conditionalChecks,
      'The guided-setup-smoke PR exemption changed shape and must be re-reviewed.',
    ).toContain(
      `if [[ "\${IS_PR}" != "true" ]] && [[ "\${GUIDED_SETUP_SMOKE_RESULT}" != "success" ]]; then`,
    );
  });

  it('blocking jobs do not use job-level continue-on-error', () => {
    const blockingJobs = [...resultEnvByName].flatMap(([envVar, job]) => {
      if (PR_EXEMPT_JOBS.has(job)) return [];
      return blockingCondition.includes(`[[ "\${${envVar}}" != "success" ]]`) ? [job] : [];
    });
    const offendingJobs = blockingJobs.filter((job) =>
      /^    continue-on-error:/m.test(jobBodies.get(job) ?? ''),
    );

    expect(
      offendingJobs,
      `Blocking jobs with job-level continue-on-error: ${offendingJobs.join(', ')}. ` +
        'Job-level continue-on-error makes needs.<job>.result report success even when the job fails.',
    ).toEqual([]);
  });

  it('every top-level workflow job has an explicit gating decision', () => {
    expect(
      workflowJobs.length,
      'Parsed too few top-level jobs from ci.yml — the job-header parser is stale.',
    ).toBeGreaterThan(30);

    const jobsWithGatingDecisions = new Set([...neededJobs, ...UNGATED_JOBS]);
    const undecidedJobs = workflowJobs.filter((job) => !jobsWithGatingDecisions.has(job));

    expect(
      undecidedJobs,
      `Jobs without a gating decision: ${undecidedJobs.join(', ')}. ` +
        'A new job was added to ci.yml without deciding whether it gates a merge; add it to ' +
        'ci-success needs: (plus its env var and blocking assertion) or to UNGATED_JOBS with a reason.',
    ).toEqual([]);
  });

  it('test-mobile blocks a merge (regression guard for #3941)', () => {
    // Regression guard for GitHub issue #3941.
    expect(neededJobs, 'test-mobile is missing from ci-success needs:').toContain('test-mobile');
    expect(resultEnvByName.get('TEST_MOBILE_RESULT'), 'TEST_MOBILE_RESULT is not mapped to test-mobile').toBe(
      'test-mobile',
    );
    expect(blockingCondition, 'test-mobile is not asserted in the unconditional blocking condition').toContain(
      '[[ "${TEST_MOBILE_RESULT}" != "success" ]]',
    );
  });
});
