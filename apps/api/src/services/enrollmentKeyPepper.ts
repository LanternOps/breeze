/**
 * The server secret that keys every enrollment-credential digest: enrollment
 * keys (`enrollmentKeySecurity.hashEnrollmentKey`) and installer bootstrap
 * tokens (`installerBootstrapToken.hashBootstrapToken`).
 *
 * Its own module so the bootstrap-token hash can reuse the one resolution
 * without importing `enrollmentKeySecurity`, which a dozen route suites
 * replace wholesale with `vi.mock` stubs exposing only the hash functions.
 *
 * Required in production (`config/validate.ts` → validateProductionPepper).
 */
export function getEnrollmentKeyPepper(): string {
  const pepper = process.env.ENROLLMENT_KEY_PEPPER?.trim();
  if (pepper) return pepper;

  if (process.env.NODE_ENV === 'test') {
    return 'test-enrollment-key-pepper';
  }

  throw new Error('No enrollment key pepper configured. Set ENROLLMENT_KEY_PEPPER.');
}
