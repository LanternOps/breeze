import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { configurationPolicies, organizations } from '../../db/schema';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';

/**
 * App-level mirror of `breeze_monitor_attachment_compatible` (#5289).
 *
 * WHY THIS EXISTS, given the database already enforces it:
 *
 * The DB guard is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so
 * Postgres only evaluates it at the OUTERMOST transaction's real COMMIT. Every
 * request already runs inside one ambient transaction opened by
 * `middleware/auth.ts`, and `addFeatureLink` / `updateFeatureLink` open their
 * own `db.transaction(...)`, which nests as a SAVEPOINT rather than a second
 * top-level transaction. Releasing a savepoint does NOT force a deferred
 * constraint check — so the write "succeeds", the route returns 201, and the
 * 23514 only fires later when the middleware's transaction commits, long after
 * the handler's catch block that was supposed to map it to
 * `400 MONITOR_NOT_ATTACHABLE` has already returned. Same class as #5580
 * (a caught 23505 inside withDbAccessContext still aborting the request tx).
 *
 * So the check has to happen BEFORE the write on the request path. The trigger
 * stays as the database-level backstop for every other writer (workers, psql,
 * a future code path that forgets this helper) — it is the authority, this is
 * the fast, mappable path.
 *
 * Deny on a lookup miss, matching the trigger's `COALESCE(..., false)`.
 */
export async function isMonitorAttachableToPolicy(
  monitorId: string,
  configPolicyId: string,
): Promise<boolean> {
  const [monitor] = await db
    .select({ orgId: monitorDefinitions.orgId, partnerId: monitorDefinitions.partnerId })
    .from(monitorDefinitions)
    .where(eq(monitorDefinitions.id, monitorId))
    .limit(1);
  if (!monitor) return false;

  const [policy] = await db
    .select({ orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, configPolicyId))
    .limit(1);
  if (!policy) return false;

  // Org-owned monitor: only that org's own policies.
  if (monitor.orgId && policy.orgId) return monitor.orgId === policy.orgId;
  // Partner-wide monitor on a partner-wide policy: same partner.
  if (monitor.partnerId && policy.partnerId) return monitor.partnerId === policy.partnerId;
  // Partner-wide monitor on an ORG policy: only when that org is under the
  // monitor's partner.
  if (monitor.partnerId && policy.orgId) {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, policy.orgId))
      .limit(1);
    return !!org?.partnerId && org.partnerId === monitor.partnerId;
  }
  // An ORG-owned monitor on a PARTNER-wide policy would apply one org's monitor
  // to every org under the partner. Always refused.
  return false;
}
