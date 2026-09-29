import { defineConfig } from 'vitest/config';
import path from 'path';

// Targeted non-UTC pass over the auth/SSO/MFA-adjacent unit suites (#4046).
//
// GitHub-hosted runners default to UTC, and neither this repo's CI nor
// vitest.config.ts ever pins a different zone. Code that depends on the host
// zone (reading a Date's local fields, parsing an offsetless string with
// `new Date(...)`, adjusting by `getTimezoneOffset()`) behaves identically to
// zone-independent code when the host offset is exactly 0, so a UTC-only run
// cannot tell the two apart.
//
// This config re-runs the auth/SSO/MFA/passkey suites and the scheduler seams
// below under a fixed non-UTC zone. It intentionally does NOT re-run the full
// suite a second time: that would double the cost of every unrelated test for
// no coverage gain, since only timestamp/timezone arithmetic is
// offset-sensitive. Suites that must hold on BOTH sides of UTC pin a zone per
// test with `testUtils/hostTimeZone.ts`, which works in any runner zone.
//
// Timestamps read through Drizzle need no host-zone handling: Drizzle decodes
// offsetless `timestamp` columns as UTC. The real-Postgres proof, run west and
// east of UTC, is
// `src/__tests__/integration/offsetlessTimestampRead.integration.test.ts`.
//
// The TZ pin lives in the CI workflow step's `env:` block (runner-level, set
// before the Node process starts), not here. Run locally via
// `TZ=America/Denver pnpm test:tz` (or any non-UTC zone) from apps/api.
export default defineConfig({
  resolve: {
    alias: {
      '@breeze/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    // explicit: vitest 5 flips the default to true; flip per package in a follow-up
    clearMocks: false,
    globals: true,
    environment: 'node',
    // This is a manual allowlist, not a broad glob — a new TZ-sensitive test
    // file must be added here explicitly or it runs under UTC only.
    //
    // AUDIT NOTE (#4059 gap 2, 2026-09): the other schedulers named in that
    // issue — `services/automationRuntime.ts`/`services/cronDue.ts`
    // (`isCronDue`/`getZonedDateParts`), `jobs/patchSchedulerWorker.ts`
    // (`getLocalTimeParts` and friends) and `services/pamRuleEngine.ts`
    // (`isWithinTimeWindow`) — were audited and deliberately NOT added. They
    // are timezone-AWARE but host-timezone-INDEPENDENT: every one takes an
    // explicit IANA zone (defaulting to the 'UTC' sentinel, never the host
    // default) and resolves parts through `Intl.DateTimeFormat`, and their
    // existing suites pass explicit zone strings into every assertion. Re-running
    // them under a pinned zone is byte-identical to the UTC run, so it would
    // cost CI time for zero signal. `pamRuleEngine`'s `at` argument traces to
    // `elevation_requests.requested_at`, which IS `withTimezone: true`. The
    // report and discovery seams registered below read offsetless `timestamp`
    // columns through Drizzle, which already yields the stored instant.
    // Re-audit if any of those files starts reading wall-clock parts off a
    // Date with bare local getters (`getHours`/`getDay`) or parses a raw
    // `db.execute` timestamp string.
    include: [
      'src/routes/auth.test.ts',
      'src/routes/auth.passkeys.test.ts',
      'src/routes/authenticator.test.ts',
      'src/routes/auth/**/*.test.ts',
      // SSO re-auth freshness (sso_sessions.created_at vs auth_time).
      'src/routes/sso.reauth.test.ts',
      // Guards the per-test zone switch the suites below rely on.
      'src/testUtils/hostTimeZone.test.ts',
      'src/services/sso.test.ts',
      'src/services/ssoDomainVerification.test.ts',
      'src/services/mfa.test.ts',
      'src/services/mfaAssurance.test.ts',
      'src/services/mfaPolicy.test.ts',
      'src/services/mfaSecretCrypto.test.ts',
      'src/services/mfaStepUpGrant.test.ts',
      'src/services/passkeys.test.ts',
      'src/services/authEpochs.test.ts',
      'src/services/authLifecycle.test.ts',
      'src/services/authenticatorAssurance.test.ts',
      'src/services/authenticatorPolicy.test.ts',
      'src/services/apiKeyAuthorization.test.ts',
      'src/services/approverWebAuthn.test.ts',
      'src/services/authEmailQueue.test.ts',
      // Password-change token check (users.password_changed_at vs iat).
      'src/services/tokenRevocation.test.ts',
      // Scheduler seams that compare an offsetless `timestamp` read with the
      // current instant — see each file's header.
      'src/jobs/reportScheduleWorker.due.test.ts',
      // Its findDueReports fixtures resolve org/partner zones for
      // lastGeneratedAt, so they run here too.
      'src/jobs/reportScheduleWorker.test.ts',
      'src/jobs/discoveryWorker.intervalDue.test.ts',
      // Canary asserting the pin itself is active — see its own file
      // header. Deliberately excluded from vitest.config.ts (main) so it
      // fails loudly there if it's ever accidentally run under UTC.
      'src/__tests__/tzPinCanary.test.ts',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
