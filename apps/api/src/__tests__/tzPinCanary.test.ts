import { describe, it, expect } from 'vitest';

/**
 * Canary for issue #4046: this file must ONLY run as part of the pinned
 * non-UTC pass (`apps/api/vitest.config.tz.ts`, wired into CI's `test-api`
 * job via `pnpm test:tz` with `TZ=America/Denver` set at the step level) —
 * it is excluded from the default `vitest.config.ts` unit run (see its
 * `exclude` list) specifically so this assertion has teeth in both places:
 * green here confirms the pin reached this worker process; if it ever ran
 * under the plain UTC job instead, it would fail there.
 *
 * If a future refactor of ci.yml or vitest.config.tz.ts silently drops the
 * TZ pin (the step's `env:` block gets deleted, the include entry below
 * gets removed, etc.), this test fails loudly instead of the whole
 * tz-pinned job quietly degrading back into a vacuous UTC run — which is
 * exactly the failure mode #4046 exists to prevent.
 */
describe('non-UTC TZ pin (issue #4046)', () => {
  it('the process actually observes a non-UTC offset', () => {
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });
});
