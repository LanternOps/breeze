import { defineConfig } from 'vitest/config';
import path from 'path';

// Targeted non-UTC pass over the auth/SSO/MFA-adjacent unit suites (#4046).
//
// GitHub-hosted runners default to UTC, and neither this repo's CI nor
// vitest.config.ts ever pins a different zone. A test written to assert
// timezone-correcting behavior (e.g. comparing an offsetless-timestamp-derived
// value against a UTC epoch) is dormant by construction when the host offset
// is exactly 0 — the assertion can collapse to `0 === 0` and stay green
// forever while the underlying conversion is missing or wrong. That is
// exactly how #4018's TZ bug (sso_sessions.created_at compared against
// auth_time without correcting for local-time parsing) shipped past 25,000+
// green tests and was only caught by a human review pass, then confirmed by
// re-running under TZ=America/Denver.
//
// This config re-runs just the auth/SSO/MFA/passkey suites — where that bug
// class lives — under a fixed non-UTC zone, so a future regression of the
// same shape fails CI instead of passing vacuously. It intentionally does
// NOT re-run the full suite a second time: that would double the cost of
// every unrelated test for no coverage gain, since only timestamp/timezone
// arithmetic is offset-sensitive.
//
// The TZ pin lives in the CI workflow step's `env:` block (runner-level, set
// before the Node process starts), not here and not in a test file — Node/V8
// cache the resolved timezone at first use of Date/Intl within a process, so
// assigning `process.env.TZ` from inside a test file (or a `beforeEach`) has
// no effect on already-initialized Date behavior in that worker. Run locally
// via `TZ=America/Denver pnpm test:tz` (or any non-UTC zone) from apps/api.
export default defineConfig({
  resolve: {
    alias: {
      '@breeze/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // This is a manual allowlist, not a broad glob — a new TZ-sensitive test
    // file must be added here explicitly or it runs under UTC only.
    include: [
      'src/routes/auth.test.ts',
      'src/routes/auth.passkeys.test.ts',
      'src/routes/authenticator.test.ts',
      'src/routes/auth/**/*.test.ts',
      // #4041's two offsetless-timestamp-simulation suites — previously
      // missing from this list despite the PR merging (stale MAINTENANCE
      // note caught during #4059).
      'src/routes/sso.reauth.test.ts',
      'src/testUtils/pgOffsetlessTimestamp.test.ts',
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
      // #4059 gap 1: the last hop before a request is authorized/rejected on
      // password-change revocation, same offsetless-timestamp bug shape as
      // #4018 (see tokenRevocation.ts's isTokenIssuedBeforePasswordChange).
      'src/services/tokenRevocation.test.ts',
      // Canary asserting the pin itself is active — see its own file
      // header. Deliberately excluded from vitest.config.ts (main) so it
      // fails loudly there if it's ever accidentally run under UTC.
      'src/__tests__/tzPinCanary.test.ts',
    ],
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
