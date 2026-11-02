/**
 * Clear every reinstall link that points at a retired record, across the
 * record's partner (#8318 §7.3, review of wave 2-1).
 *
 * Retiring the old record (the admin decommission route, the uninstall-intent
 * reaper) answers the "possible replacement" question the link asks. Since
 * wave 2-1 a link can come from any org of the partner (hardware evidence is
 * searched partner-wide), so the same-org clear those callers already run in
 * their own transaction is not enough. This one runs AFTER their transaction
 * commits, in its own short system transaction:
 *  - the caller's transaction has already taken the target org's
 *    partner-export lock (its decommission UPDATE fires the devices export
 *    triggers), and the export lock helpers refuse a second org below that
 *    one's UUID inside the same transaction. A fresh transaction takes the
 *    whole sorted set once, before the first write, as the README requires
 *    for multi-org writes;
 *  - a request-path caller's RLS context could not write the other orgs'
 *    rows anyway.
 *
 * Scoped to `possible_replacement_of_device_id = <target>` and to orgs of the
 * target's partner. Clearing only the link would be enough (the reason sync
 * trigger nulls the rest); all three are written for clarity.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, runAfterDbContextCommit, withSystemDbAccessContext } from '../../db';
import { devices, organizations } from '../../db/schema';
import { captureException } from '../sentry';

/** Clear the links to `targetDeviceId` from every org of its partner. Returns the rows cleared. */
export async function clearReinstallLinksToTarget(targetDeviceId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const [target] = await db
      .select({ partnerId: organizations.partnerId })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(eq(devices.id, targetDeviceId))
      .limit(1);
    if (!target) return 0;

    const sourceOrgs = await db
      .selectDistinct({ orgId: devices.orgId })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(and(eq(devices.possibleReplacementOfDeviceId, targetDeviceId), eq(organizations.partnerId, target.partnerId)))
      .orderBy(asc(devices.orgId));
    const orgIds = sourceOrgs.map((row) => row.orgId);
    if (orgIds.length === 0) return 0;

    // Every org this statement writes, ascending, before the first write.
    await db.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${sql.join(
      orgIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]::uuid[])`);

    const cleared = await db
      // own-device-row-allowlisted: reinstall-link-clear
      .update(devices)
      .set({
        possibleReplacementOfDeviceId: null,
        possibleReplacementReason: null,
        possibleReplacementDetectedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(devices.possibleReplacementOfDeviceId, targetDeviceId), inArray(devices.orgId, orgIds)))
      .returning({ id: devices.id });
    return cleared.length;
  }, 'reinstall-candidates:clear-links');
}

/**
 * Register the partner-wide clear to run once the caller's DB context
 * COMMITS (dropped on rollback), outside it. Never throws.
 */
export function scheduleReinstallLinkClear(targetDeviceId: string): void {
  runAfterDbContextCommit('reinstall-link-clear', () =>
    clearReinstallLinksToTarget(targetDeviceId).catch((err: unknown) => {
      console.error(
        `[reinstallCandidates] partner-wide link clear failed for target ${targetDeviceId}:`,
        err instanceof Error ? err.message : err,
      );
      captureException(err);
    }));
}
