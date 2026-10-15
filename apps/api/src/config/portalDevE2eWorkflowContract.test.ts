import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../../../.github/workflows/ci.yml', import.meta.url));

/**
 * #6447 — `Portal Dev E2E (hydration, non-blocking)` was red on EVERY open PR.
 *
 * Every Playwright context in a run replays the one `storageState` that
 * `global-setup.ts` mints, so the whole run shares a single refresh-token
 * family; `POST /auth/refresh` is budgeted per family at 60/60s
 * (`getRefreshRateLimit()`); and `apps/web` is an Astro MPA that spends one
 * refresh on every full-page navigation. Four parallel workers exhaust that in
 * seconds, the API 429s, and the app masks itself with "Too many requests —
 * reconnecting" — which surfaced as a `waitForAppReady` timeout with no hint of
 * the real cause. `E2E_MODE` is the API's own switch for that limiter (and the
 * global per-IP one, which sees the whole run as one client behind Caddy).
 *
 * The job's generated `.env` is the only place that can carry the flag into the
 * stack from CI, and it is a hand-maintained duplicate of the pin in
 * `scripts/dev/wt-stack/env.ts` — nothing derives one from the other. Deleting
 * the line would not fail a single test; it would just quietly restore an
 * intermittent red. Same shape, and same reason, as
 * `authBrowserTransitionWorkflowContract.test.ts`.
 */
describe('portal-dev-e2e CI job contract', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const jobStart = workflow.indexOf('\n  portal-dev-e2e:');
  const job = workflow.slice(jobStart, nextJobIndex(workflow, jobStart));

  it('locates the job block', () => {
    expect(jobStart).toBeGreaterThan(-1);
    expect(job).toContain('name: Portal Dev E2E (hydration, non-blocking)');
  });

  it('stands the rate limiters down for the dev stack it brings up', () => {
    expect(job).toContain('E2E_MODE=true');
  });

  it('preserves failed hydration traces before the next Playwright run replaces them', () => {
    const hydration = job.indexOf('- name: Run the portal hydration specs');
    const upload = job.indexOf('- name: Upload portal hydration Playwright report');
    const approval = job.indexOf('- name: Run the WebAuthn approval specs');
    expect(hydration).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(hydration);
    expect(approval).toBeGreaterThan(upload);
    const step = job.slice(upload, nextStepIndex(job, upload));
    expect(step).toMatch(/^ {8}if: failure\(\)$/m);
    expect(step).toContain('name: portal-dev-e2e-playwright-report');
    expect(step).toContain('e2e-tests/playwright-report');
    expect(step).toContain('e2e-tests/test-results');
  });

  it('keeps the approval report in a distinct artifact after its own run', () => {
    const approval = job.indexOf('- name: Run the WebAuthn approval specs');
    const upload = job.indexOf('- name: Upload WebAuthn approval Playwright report');
    expect(upload).toBeGreaterThan(approval);
    const step = job.slice(upload, nextStepIndex(job, upload));
    expect(step).toMatch(/^ {8}if: failure\(\)$/m);
    expect(step).toContain('name: portal-dev-e2e-approval-playwright-report');
    expect(step).toContain('e2e-tests/playwright-report');
    expect(step).toContain('e2e-tests/test-results');
  });

  /**
   * #5786 — `intent-self-approve` and `ai-operator-approve-after-browser-close`
   * drive real WebAuthn ceremonies and were in no job's spec list, so they
   * could not go red (#5273 sat stale for weeks that way). The stack side is
   * already handled: wt-stack pins WEBAUTHN_ORIGIN/WEBAUTHN_RP_ID to caddy's
   * published port after `up` (#6443), the specs self-seed over `docker exec
   * psql` via `.breeze-stack.json`, and `wt-stack test` forwards
   * REDIS_PASSWORD. What CI must still supply is the spec list itself and
   * `E2E_MACOS_DEVICE_ID`: the operator spec `test.skip`s without it, and a
   * skipped spec reports green — the exact blind spot this step closes.
   */
  describe('webauthn approval specs (#5786)', () => {
    const stepStart = job.indexOf('- name: Run the WebAuthn approval specs');
    const step = stepStart === -1 ? '' : job.slice(stepStart, nextStepIndex(job, stepStart));

    it('has a dedicated step that runs both specs through wt-stack test', () => {
      expect(stepStart).toBeGreaterThan(-1);
      // Anchored to a real, uncommented `run:` line so an echo'd or commented-out
      // command cannot satisfy the match.
      const run = /^ {8}run: \.\/e2e-tests\/node_modules\/\.bin\/tsx scripts\/dev\/wt-stack\/cli\.ts test -- (.*)$/m.exec(step)?.[1];
      expect(run, 'step has no real wt-stack test run: line').toBeTruthy();
      expect(run).toContain('tests/intent-self-approve.spec.ts');
      expect(run).toContain('tests/ai-operator-approve-after-browser-close.spec.ts');
    });

    it('still runs when the hydration specs fail, so one red cannot hide the other', () => {
      expect(step).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
      expect(step).not.toContain('continue-on-error');
    });

    it('enables the AI Operator flags the operator spec needs (admission 422s without them)', () => {
      expect(job).toMatch(/^ {10}AI_OPERATOR_TASKS_ENABLED=true$/m);
      expect(job).toMatch(/^ {10}AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED=true$/m);
    });

    it('runs the two specs serially: both register an approver on the same admin and the ceremony rotates its refresh token', () => {
      expect(step).toMatch(/cli\.ts test -- .*--workers=1/);
    });

    it('supplies the seeded macOS device id the operator spec skips without', () => {
      const seed = readFileSync(
        fileURLToPath(new URL('../../../../e2e-tests/seed-fixtures.sql', import.meta.url)),
        'utf8',
      );
      const id = /v_macos_device_id\s+UUID := '([0-9a-f-]{36})'/.exec(seed)?.[1];
      expect(id, 'seed-fixtures.sql no longer declares v_macos_device_id').toBeTruthy();
      expect(step).toMatch(new RegExp(`^ {10}E2E_MACOS_DEVICE_ID: ${id}$`, 'm'));
    });
  });
});

/** Index of the next step (or comment block) at step indentation after `from`. */
function nextStepIndex(job: string, from: number): number {
  const found = /\n {6}(?:- name:|# )/.exec(job.slice(from + 1));
  return found ? from + 1 + found.index : job.length;
}

/**
 * Index of the next top-level job key after `from`, so the slice stops at the
 * job boundary instead of swallowing the rest of the file — otherwise the
 * assertion above would pass on a sibling job's `E2E_MODE`, which is precisely
 * the false green this test exists to avoid (the auth-browser-transition job
 * sets the same flag).
 */
function nextJobIndex(workflow: string, from: number): number {
  const match = /\n {2}[a-z0-9][a-z0-9-]*:\n/g;
  match.lastIndex = from + 1;
  const found = match.exec(workflow);
  return found ? found.index : workflow.length;
}
