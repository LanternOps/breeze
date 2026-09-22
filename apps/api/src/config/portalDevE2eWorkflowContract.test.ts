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
});

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
