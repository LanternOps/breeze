import type { AiAgentTriggers } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import {
  db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext,
} from '../../db';
import { devices, deviceGroupMemberships } from '../../db/schema/devices';

/** Resource filters are an execution boundary even for manual runs. */
export function hasAgentResourceScope(triggers: AiAgentTriggers): boolean {
  return triggers.siteIds !== undefined || triggers.deviceTags !== undefined
    || triggers.deviceGroupIds !== undefined;
}

/**
 * Until fleet evidence and every fleet tool support these filters, a scoped
 * agent must have an exact device target. A focus device or a staged dataset
 * does not make an org-wide prompt safe. Never silently widen to the org.
 */
export async function agentRunMatchesResourceScope(
  triggers: AiAgentTriggers,
  orgId: string,
  deviceId: string | null,
  /**
   * Three-valued, and the caller must pass what ADMISSION saw, not what it
   * wishes were true:
   *   - `undefined` — skip the check (the caller has no admission-time site to
   *     compare against, e.g. admission itself).
   *   - `null` — the device had NO site at admission; a device that has since
   *     been given one no longer matches.
   *   - a string — the device's site at admission; it must still be that site.
   * This is what stops a device from being moved between sites mid-run and
   * carrying its admitted run along with it.
   */
  expectedSiteId?: string | null,
): Promise<boolean> {
  if (!hasAgentResourceScope(triggers)) return true;
  if (!deviceId) return false;
  if ([triggers.siteIds, triggers.deviceTags, triggers.deviceGroupIds]
    .some((values) => values !== undefined && values.length === 0)) return false;

  const check = async (): Promise<boolean> => {
    const [device] = await db.select({ siteId: devices.siteId, tags: devices.tags })
      .from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
    if (!device) return false;
    if (expectedSiteId !== undefined && device.siteId !== expectedSiteId) return false;
    if (triggers.siteIds !== undefined
      && (!device.siteId || !triggers.siteIds.includes(device.siteId))) return false;
    if (triggers.deviceTags !== undefined
      && !triggers.deviceTags.some((tag) => (device.tags ?? []).includes(tag))) return false;
    if (triggers.deviceGroupIds !== undefined) {
      const memberships = await db.select({ groupId: deviceGroupMemberships.groupId })
        .from(deviceGroupMemberships).where(and(
          eq(deviceGroupMemberships.deviceId, deviceId), eq(deviceGroupMemberships.orgId, orgId),
        ));
      if (!memberships.some((row) => triggers.deviceGroupIds!.includes(row.groupId))) return false;
    }
    return true;
  };

  // Already system-scoped (a BullMQ worker that opened its own system context):
  // read straight through. Re-entering would open a SECOND pooled connection
  // while the first is still held, for no visibility gain — same skip branch,
  // same reason, as `resolveEffectiveAgentSystem` (#1105).
  if (getCurrentDbAccessContext()?.scope === 'system') return check();

  // Load-bearing: a bare system wrapper is a no-op inside an ambient request
  // context, so exit that context before establishing system visibility.
  return runOutsideDbContext(() => withSystemDbAccessContext(check));
}
