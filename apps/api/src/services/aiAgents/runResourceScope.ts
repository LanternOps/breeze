import type { AiAgentTriggers } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceGroupMemberships } from '../../db/schema/devices';

/** Resource filters are an execution boundary even for manual runs. */
export function hasAgentResourceScope(triggers: AiAgentTriggers): boolean {
  return triggers.siteIds !== undefined || triggers.deviceTags !== undefined
    || triggers.deviceGroupIds !== undefined;
}

/** Tools verified to enforce an exact device allowlist, including enumeration.
 * Extend only with a regression test proving sibling-device isolation. Other
 * tools can expose org/site data even when their primary device argument is safe.
 */
export const RESOURCE_SCOPED_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'query_devices', 'get_device_details', 'get_device_context', 'set_device_context',
  'analyze_metrics', 'analyze_boot_performance',
]);

/**
 * Until fleet evidence and every fleet tool support these filters, a scoped
 * agent must have an exact device target. A focus device or a staged dataset
 * does not make an org-wide prompt safe. Never silently widen to the org.
 */
export async function agentRunMatchesResourceScope(
  triggers: AiAgentTriggers,
  orgId: string,
  deviceId: string | null,
  expectedSiteId?: string | null,
): Promise<boolean> {
  if (!hasAgentResourceScope(triggers)) return true;
  if (!deviceId) return false;
  if ([triggers.siteIds, triggers.deviceTags, triggers.deviceGroupIds]
    .some((values) => values !== undefined && values.length === 0)) return false;

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
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
  }));
}
