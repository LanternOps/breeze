/**
 * #11231: the reads and the lock behind the elevation notifier's announce
 * rules (pamElevationNotify.ts, which states the rules). Kept apart so the
 * notifier's decisions can be unit-tested against these functions and the
 * SQL against real Postgres.
 *
 * CALLER OWNS THE DB CONTEXT: one system-scope transaction opened outside any
 * request context. The advisory lock is transaction-scoped, so it holds until
 * that transaction commits.
 */

import { and, eq, gte, inArray, isNull, like, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { elevationRequests, organizations, organizationUsers, userNotifications, users } from '../db/schema';
import { PERMISSIONS } from './permissions';
import { getRoleIdsHoldingPermission } from './roleInheritance';
import { normalizeSiteAllowlist } from './siteAllowlist';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

/** Every in-app notice this notifier writes carries a dedupe key with this prefix. */
export const PAM_ELEVATION_NOTICE_KEY_PREFIX = 'pam-elevation:';

/** The in-app dedupe key: one notice per person and request. */
export function pamElevationNotifyDedupeKey(elevationRequestId: string): string {
  return `${PAM_ELEVATION_NOTICE_KEY_PREFIX}${elevationRequestId}`;
}

export interface ElevationNoticeRecipient { id: string; email: string }

/** How long a notifier run waits for another run on the same device before giving up. */
export const PAM_ELEVATION_NOTIFY_LOCK_TIMEOUT = '10s';

/**
 * Serialize announcement decisions for one device until the caller's
 * transaction ends. A second notifier run for the same device waits here, and
 * then reads the notices the first run committed. Two devices whose ids hash
 * alike only wait on each other. Each waiter holds a pooled connection, so the
 * wait is bounded by a transaction-local lock_timeout (it also bounds the
 * caller's remaining statements, which are short); past it this throws
 * SQLSTATE 55P03 and that request is not announced.
 */
export async function lockDeviceAnnouncements(deviceId: string): Promise<void> {
  await db.execute(sql`SELECT set_config('lock_timeout', ${PAM_ELEVATION_NOTIFY_LOCK_TIMEOUT}, true)`);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pam-elevation-notify'), hashtext(${deviceId}))`);
}

/** The request's flow and current status, or null when no such row is on this device and org. */
export async function readElevationRequestState(args: {
  elevationRequestId: string; orgId: string; deviceId: string;
}): Promise<{ flowType: string; status: string } | null> {
  const [row] = await db
    .select({ flowType: elevationRequests.flowType, status: elevationRequests.status })
    .from(elevationRequests)
    .where(and(
      eq(elevationRequests.id, args.elevationRequestId),
      eq(elevationRequests.orgId, args.orgId),
      eq(elevationRequests.deviceId, args.deviceId),
    ))
    .limit(1);
  return row ?? null;
}

export interface ElevationNoticeAudience {
  /** Users `resolveUsersWithPermissionForOrg` returned for `pam:approve`. */
  permissionHolders: number;
  /** Of those, the ones left after the org-membership checks. */
  withAccess: number;
  /** Active users among them, with their email. */
  people: ElevationNoticeRecipient[];
}

/**
 * The people who may decide a request on this org and site.
 *
 * Starts from `resolveUsersWithPermissionForOrg` (org members whose role
 * grants `pam:approve`, plus partner staff whose role grants it and whose org
 * access covers the org). A user who also has an org membership here is then
 * judged by that membership alone, as getUserPermissions does (org membership
 * wins over partner membership): its role must grant `pam:approve`, and its
 * site allowlist (NULL = all sites) must cover the device's site. Partner
 * staff without a membership have no site allowlist.
 */
export async function resolveElevationNoticeAudience(orgId: string, siteId: string | null): Promise<ElevationNoticeAudience> {
  const holderIds = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.PAM_APPROVE);
  if (holderIds.length === 0) return { permissionHolders: 0, withAccess: 0, people: [] };

  const grantingRoleIds = new Set(await getRoleIdsHoldingPermission(PERMISSIONS.PAM_APPROVE));
  const memberships = await db
    .select({ userId: organizationUsers.userId, roleId: organizationUsers.roleId, siteIds: organizationUsers.siteIds })
    .from(organizationUsers)
    .where(and(eq(organizationUsers.orgId, orgId), inArray(organizationUsers.userId, holderIds)));
  const blocked = new Set<string>();
  for (const m of memberships) {
    if (!grantingRoleIds.has(m.roleId)) {
      blocked.add(m.userId);
      continue;
    }
    const allowed = normalizeSiteAllowlist(m.siteIds ?? undefined);
    if (siteId && allowed !== undefined && !allowed.includes(siteId)) blocked.add(m.userId);
  }
  const ids = holderIds.filter((id) => !blocked.has(id));
  const people = ids.length === 0 ? [] : await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.status, 'active')));
  return { permissionHolders: holderIds.length, withAccess: ids.length, people };
}

/**
 * True when another uac_intercept request from this device, created at or
 * after `since`, was announced and no person has decided it.
 *
 * "Announced" is durable state: at least one of `recipientIds` holds that
 * request's in-app notice (its dedupe key). Matching on the recipients keeps
 * the lookup on the (user_id, dedupe_key) unique index. A request whose
 * notifier never ran, threw, or found nobody to tell has no notice, so it
 * never counts. "Decided" means a person approved or denied it
 * (approved_by_user_id or denied_by_user_id is set); a withdrawal, an expiry
 * or any other status change made without a person does not end the
 * cooldown.
 */
export async function deviceAnnouncedWithin(args: {
  orgId: string; deviceId: string; elevationRequestId: string; recipientIds: string[]; since: Date;
}): Promise<boolean> {
  if (args.recipientIds.length === 0) return false;
  const rows = await db
    .select({ id: elevationRequests.id })
    .from(elevationRequests)
    .where(and(
      eq(elevationRequests.orgId, args.orgId),
      eq(elevationRequests.deviceId, args.deviceId),
      eq(elevationRequests.flowType, 'uac_intercept'),
      ne(elevationRequests.id, args.elevationRequestId),
      gte(elevationRequests.createdAt, args.since),
      isNull(elevationRequests.approvedByUserId),
      isNull(elevationRequests.deniedByUserId),
      sql`EXISTS (SELECT 1 FROM ${userNotifications} WHERE ${and(
        inArray(userNotifications.userId, args.recipientIds),
        eq(userNotifications.dedupeKey, sql`${PAM_ELEVATION_NOTICE_KEY_PREFIX} || ${elevationRequests.id}::text`),
      )})`,
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * How many elevation notices each of `userIds` has received since `since`, by
 * user id (users with none are absent). Counts in-app notices, which every
 * announcement writes whether or not it was emailed.
 *
 * `user_notifications.created_at` is `timestamp without time zone` filled by
 * now() in the session's TimeZone, so `since` is converted the same way in SQL
 * (timestamptz -> timestamp) instead of being sent as a bare timestamp.
 */
export async function countRecentElevationNotices(userIds: string[], since: Date): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userNotifications.userId, n: sql<number>`count(*)::int` })
    .from(userNotifications)
    .where(and(
      inArray(userNotifications.userId, userIds),
      like(userNotifications.dedupeKey, `${PAM_ELEVATION_NOTICE_KEY_PREFIX}%`),
      sql`${userNotifications.createdAt} >= (${since.toISOString()}::timestamptz)::timestamp`,
    ))
    .groupBy(userNotifications.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

export async function readOrgName(orgId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.name ?? '';
}
