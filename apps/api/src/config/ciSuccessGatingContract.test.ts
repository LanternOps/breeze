import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const ciSuccess = workflow.slice(
  workflow.indexOf('  ci-success:'),
  workflow.indexOf('  main-red-alert:'),
);
const needsMatch = ciSuccess.match(/^    needs: \[([^\]]+)]$/m);
const neededJobs = needsMatch?.[1]?.split(',').map((job) => job.trim()) ?? [];
const envBlock = ciSuccess.slice(ciSuccess.indexOf('        env:'), ciSuccess.indexOf('        run: |'));
const resultEnvByName = new Map(
  [...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]*_RESULT): \$\{\{ needs\.([a-z0-9-]+)\.result \}\}$/gm)].map(
    ([, envVar, job]) => [envVar, job] as const,
  ),
);
const blockingStart = ciSuccess.indexOf('if [[');
const blockingEnd = ciSuccess.indexOf('; then', blockingStart) + '; then'.length;
const blockingCondition = ciSuccess.slice(blockingStart, blockingEnd);
const conditionalChecks = ciSuccess.slice(blockingEnd);

// smoke-test is deliberately non-blocking on PRs and required on main pushes via the IS_PR guard.
const PR_EXEMPT_JOBS = new Set(['smoke-test']);

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
    expect(conditionalChecks, 'The conditional checks no longer inspect SMOKE_TEST_RESULT').toContain(
      'SMOKE_TEST_RESULT',
    );
    expect(conditionalChecks, 'The smoke-test main-push check no longer uses the IS_PR guard').toContain(
      'IS_PR',
    );
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
