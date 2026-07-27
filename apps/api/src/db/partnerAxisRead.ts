import {
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from './index';

/**
 * Run a read of a PARTNER-AXIS table in a system RLS context (issue #2822).
 *
 * Partner-axis tables (`partners`, and everything in `PARTNER_TENANT_TABLES` in
 * `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`) are
 * gated by `breeze_has_partner_access(...)`, which evaluates against the
 * `breeze.accessible_partner_ids` GUC. `computeAccessiblePartnerIds`
 * (apps/api/src/middleware/auth.ts) returns `[]` for `scope === 'organization'`,
 * and agentAuth / clientAiAuth / portal auth / org-scoped OAuth bearers all set
 * `accessiblePartnerIds: []` too. Under those contexts the read returns ZERO
 * ROWS — it does not raise — so the value silently collapses to a default, an
 * empty list, or a spurious 404, for exactly the population the feature was
 * meant to serve. A mocked-DB unit test cannot see this; only real Postgres can.
 *
 * Callers must keep the lookup hard-pinned to an id that came from the verified
 * auth context (e.g. `auth.partnerId`) or from a row already resolved under the
 * caller's own RLS context. Escaping RLS here widens which COLUMNS of the
 * caller's own partner are legible; it must never widen WHICH partner row can
 * be selected. Do not feed client-supplied ids through this helper.
 *
 * AVAILABILITY: the escape is taken ONLY when it is actually needed.
 * `withDbAccessContext` opens a real `baseDb.transaction`, pinning one pooled
 * connection for the whole callback, and `runOutsideDbContext` exits the
 * AsyncLocalStorage store — so the nested `withSystemDbAccessContext` does not
 * nest, it opens a SECOND transaction on a SECOND pooled connection while the
 * first is still held. A caller that is already system-scoped gains nothing
 * (partner-axis tables are fully visible to it) and would double-hold
 * connections against the 25-connection US ceiling, where postgres-js has no
 * acquire timeout. Same skip branch as `getEnrollmentDefaultsForOrg`
 * (services/enrollmentDefaults.ts, #2818) and `withPartnerWideVisibility`
 * (services/featureConfigResolver.ts).
 */
export async function readWithPartnerAxisVisibility<T>(fn: () => Promise<T>): Promise<T> {
  // `getCurrentDbAccessContext()` reflects the GUCs actually SET LOCAL on the
  // held transaction, so a reported scope of 'system' means the session really
  // is running with breeze.scope = 'system' and breeze_has_partner_access
  // short-circuits true. Anything else — including no context at all — takes
  // the escape.
  //
  // Note for test authors: these are named imports on purpose. A unit suite
  // whose `vi.mock('../db')` factory omits any of the three will fail loudly
  // with "No <name> export is defined on the mock" rather than silently
  // skipping the escape and reintroducing #2822. Add them to the factory:
  //   getCurrentDbAccessContext: vi.fn(() => undefined),
  //   runOutsideDbContext: vi.fn((fn) => fn()),
  //   withSystemDbAccessContext: vi.fn(async (fn) => fn()),
  const ambientScope = getCurrentDbAccessContext()?.scope;

  if (ambientScope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}
