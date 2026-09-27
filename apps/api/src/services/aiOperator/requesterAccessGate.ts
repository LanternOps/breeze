/**
 * Re-checks a manual-delegation AI Operator task's requester's LIVE access
 * before a new effect (Recipe Library / AI Operator spec §5.1: "Manual
 * delegation captures the requester's authorized org/site/target ceiling and
 * rechecks current access before each new effect. Loss of that access pauses
 * delegated execution.").
 *
 * Admission (`routes/aiOperatorTasks.ts`) checks the requester's access ONCE,
 * at delegation time, and stamps `requesterUserId` for later re-evaluation —
 * but nothing previously re-read that stamp. This module is that re-read. It
 * is called from `taskCoordinator.ts`'s `advanceExecute`, the step that sits
 * immediately before a device command is dispatched — the natural new-effect
 * boundary for the `service_recovery` recipe today.
 *
 * Mirrors the admission-time check exactly — `auth.canAccessOrg(orgId)` then
 * (for a site-restricted caller) `auth.canAccessSite(device.siteId)` — using
 * the SAME `canAccessOrg`/`canAccessSite` helpers the request-path
 * `AuthContext` is built from, so live re-evaluation cannot drift from what a
 * fresh request would decide. The permission cache is deliberately skipped: this check
 * exists to answer "right now", not "as of up to five minutes ago".
 *
 * SCOPE NOTE: a partner-scope requester's continuing access is approximated
 * from their CURRENT home partner (`users.partnerId`), not from a partnerId
 * denormalized onto the task at admission time — `ai_operator_tasks` carries
 * no such column today, unlike `action_intents.partnerId` (see
 * `actionIntents/actorContext.ts`, the analogous release-time re-derivation
 * this module is modeled on). A partner requester whose partner affiliation
 * itself changed between delegation and this check is not specially handled;
 * flagged as a residual gap rather than silently assumed away.
 */
import { eq, and } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema/users';
import { devices } from '../../db/schema/devices';
import { canAccessOrg, canAccessSite, getUserPermissions } from '../permissions';

export interface RequesterAccessCheck {
  lost: boolean;
  /** Human-readable reason, null when `lost` is false. */
  detail: string | null;
}

const ACCESS_OK: RequesterAccessCheck = { lost: false, detail: null };

/**
 * `task` is intentionally a minimal pick, not the full row type, so a caller
 * with only the id/requester/org columns in hand (e.g. a reconciler scan that
 * re-reads a narrower projection) can still call this without a wider query.
 */
export async function requesterAccessLost(
  task: { orgId: string; requesterUserId: string | null },
  deviceId: string,
): Promise<RequesterAccessCheck> {
  // No human requester recorded — an automatic/non-delegated task origin has
  // no requester ceiling to re-check.
  if (!task.requesterUserId) return ACCESS_OK;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async (): Promise<RequesterAccessCheck> => {
      const [user] = await db
        .select({ id: users.id, partnerId: users.partnerId, status: users.status })
        .from(users)
        .where(eq(users.id, task.requesterUserId!))
        .limit(1);
      if (!user || user.status !== 'active') {
        return { lost: true, detail: 'the requester account is no longer active' };
      }

      // Skip the permission cache: this recheck answers "does the requester have
      // access RIGHT NOW", not a cached answer up to CACHE_TTL stale — the
      // whole point is catching a membership/role change that just happened.
      const perms = await getUserPermissions(
        user.id,
        { partnerId: user.partnerId, orgId: task.orgId },
        { bypassCache: true },
      );
      if (!perms || !canAccessOrg(perms, task.orgId)) {
        return { lost: true, detail: `the requester no longer has access to organization ${task.orgId}` };
      }

      const [device] = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.orgId, task.orgId)))
        .limit(1);
      if (!device) {
        return { lost: true, detail: 'the target device is no longer in this organization' };
      }
      if (!canAccessSite(perms, device.siteId)) {
        return { lost: true, detail: "the requester no longer has access to the target device's site" };
      }

      return ACCESS_OK;
    }),
  );
}
