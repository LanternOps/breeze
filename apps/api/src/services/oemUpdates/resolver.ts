import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  OEM_UPDATES_POLICY_DEFAULTS,
  oemUpdatesInlineSettingsSchema,
  type OemUpdatesInlineSettings,
} from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  organizations,
} from '../../db/schema';
import { policyOwnershipCondition } from '../configPolicyOwnership';
import {
  buildRoleOsFilterConditions,
  buildTargetConditions,
  loadDeviceHierarchy,
  matchesRoleOsFilter,
  sortByHierarchy,
} from '../featureConfigResolver';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { captureException } from '../sentry';

/**
 * The winning Vendor updates (`oem_updates`) link for a device (#11070, spec 4.1).
 *
 * Closest wins WITHIN `oem_updates`, through the same hierarchy walk as every
 * other feature, and the closer link replaces the farther one whole: no merge,
 * so an org override that turns BIOS off is not re-armed by a partner default.
 * Reads `config_policy_effective_feature_links`, so a child policy inherits its
 * parent's link. Runs in the caller's RLS context; partner-wide policies reach
 * every org of their partner through `policyOwnershipCondition`, and a device
 * parked in its partner's holding org gets nothing partner-wide.
 *
 * Deliberately NOT `resolveExecutionSafeGroupIds`: the feature is protective.
 * Dropping a self-selected group's override that turns BIOS off could expose a
 * broader policy that turns it on, so every group the device is in counts.
 *
 * The settings are returned as stored. Gates are not applied here: the write
 * path refuses a closed category stored true, and the dispatch seam re-checks
 * every gate per device, so opening a gate changes no resolved link.
 *
 * A stored blob that no longer parses resolves as the disabled defaults (install
 * nothing rather than guess), logged once per link per process.
 */

export type ResolvedOemUpdatesLink = {
  linkId: string;
  /** The policy that authored the link (the parent's id for an inherited one). */
  configPolicyId: string;
  /** The policy whose assignment won for this device. */
  assignedPolicyId: string;
  settings: OemUpdatesInlineSettings;
  /** True when the stored settings did not parse and `settings` are the disabled defaults. */
  invalidStoredSettings: boolean;
  /** The later of the link's last change and the winning assignment. Null if neither was read. */
  armedAt: Date | null;
};

const warnedUnparseableLinks = new Set<string>();

function toResolved(winner: {
  linkId: string;
  sourcePolicyId: string;
  assignedPolicyId: string;
  inlineSettings: unknown;
  linkUpdatedAt?: Date | null;
  assignmentCreatedAt?: Date | null;
}): ResolvedOemUpdatesLink {
  const parsed = oemUpdatesInlineSettingsSchema.safeParse(winner.inlineSettings);
  if (!parsed.success && !warnedUnparseableLinks.has(winner.linkId)) {
    // Once per link: a bad partner-wide link would otherwise log for every
    // device it reaches. Paths only: messages can echo rejected values.
    warnedUnparseableLinks.add(winner.linkId);
    const detail = {
      linkId: winner.linkId,
      configPolicyId: winner.sourcePolicyId,
      issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    };
    console.error('[oemUpdates] vendor updates link has unparseable settings; resolving as disabled', detail);
    // The write path cannot store such a blob, so this is a direct edit or a
    // schema change: make it reach someone, not only the process log.
    captureException(new Error(`oem_updates link ${winner.linkId} has unparseable settings; resolving as disabled`));
  }
  const armedAt = [winner.linkUpdatedAt, winner.assignmentCreatedAt]
    .filter((at): at is Date => at instanceof Date)
    .reduce<Date | null>((latest, at) => (!latest || at > latest ? at : latest), null);
  return {
    armedAt,
    linkId: winner.linkId,
    configPolicyId: winner.sourcePolicyId,
    assignedPolicyId: winner.assignedPolicyId,
    settings: parsed.success ? parsed.data : (OEM_UPDATES_POLICY_DEFAULTS as OemUpdatesInlineSettings),
    invalidStoredSettings: !parsed.success,
  };
}

export async function resolveOemUpdatesLinkForDevice(deviceId: string): Promise<ResolvedOemUpdatesLink | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      linkId: configPolicyEffectiveFeatureLinks.id,
      sourcePolicyId: configPolicyEffectiveFeatureLinks.sourcePolicyId,
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      linkUpdatedAt: configPolicyEffectiveFeatureLinks.updatedAt,
      assignedPolicyId: configurationPolicies.id,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy),
      ),
    )
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'oem_updates'),
      ),
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(configPolicyAssignments.level, configPolicyAssignments.priority, configPolicyAssignments.createdAt);

  if (rows.length === 0) return null;
  return toResolved(sortByHierarchy(rows)[0]!);
}

/**
 * The winning link for MANY devices with a fixed number of queries per chunk of
 * 500 (devices, their orgs, their group memberships, every candidate
 * assignment), for the scheduler, which resolves a whole partner per tick. The
 * same decision evaluated in memory, rule for rule, as
 * {@link resolveOemUpdatesLinkForDevice}: ownership (the device's org, or
 * partner-wide for its partner, none when parked), targets (device, every group,
 * site, org, partner), role/OS filters, closest wins. A device no link reaches is
 * absent from the map.
 */
export async function resolveOemUpdatesLinksForDevices(
  deviceIds: readonly string[],
): Promise<Map<string, ResolvedOemUpdatesLink>> {
  const winners = new Map<string, ResolvedOemUpdatesLink>();
  const unique = Array.from(new Set(deviceIds));
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    for (const [deviceId, link] of await resolveChunk(unique.slice(i, i + CHUNK))) winners.set(deviceId, link);
  }
  return winners;
}

async function resolveChunk(deviceIds: string[]): Promise<Map<string, ResolvedOemUpdatesLink>> {
  const result = new Map<string, ResolvedOemUpdatesLink>();
  if (deviceIds.length === 0) return result;

  const deviceRows = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, deviceRole: devices.deviceRole, osType: devices.osType })
    .from(devices)
    .where(inArray(devices.id, deviceIds));
  if (deviceRows.length === 0) return result;

  const orgIds = Array.from(new Set(deviceRows.map((d) => d.orgId)));
  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId, type: organizations.type })
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  // A device parked in its partner's holding org gets nothing partner-wide.
  const partnerByOrg = new Map<string, string | null>(
    orgRows.map((org) => [org.id, isUnassignedPoolOrgType(org.type) ? null : org.partnerId ?? null] as const),
  );

  const membershipRows = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(inArray(deviceGroupMemberships.deviceId, deviceIds));
  const groupsByDevice = new Map<string, string[]>();
  for (const m of membershipRows) {
    const list = groupsByDevice.get(m.deviceId) ?? [];
    list.push(m.groupId);
    groupsByDevice.set(m.deviceId, list);
  }

  const partnerIds = Array.from(new Set(Array.from(partnerByOrg.values()).filter((p): p is string => !!p)));
  const ownership = partnerIds.length > 0
    ? or(
      inArray(configurationPolicies.orgId, orgIds),
      and(isNull(configurationPolicies.orgId), inArray(configurationPolicies.partnerId, partnerIds)),
    )
    : inArray(configurationPolicies.orgId, orgIds);

  const candidates = await loadOemLinkCandidates(ownership);

  for (const device of deviceRows) {
    const link = pickOemLink(candidates, device, partnerByOrg.get(device.orgId) ?? null, groupsByDevice.get(device.id) ?? []);
    if (link) result.set(device.id, link);
  }
  return result;
}

export type OemLinkCandidate = {
  linkId: string;
  sourcePolicyId: string;
  inlineSettings: unknown;
  linkUpdatedAt: Date | null;
  assignedPolicyId: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
  assignmentLevel: 'partner' | 'organization' | 'site' | 'device_group' | 'device';
  assignmentTargetId: string;
  assignmentPriority: number;
  assignmentCreatedAt: Date;
  roleFilter: string[] | null;
  osFilter: string[] | null;
};

/**
 * Every assignment carrying an active policy's `oem_updates` link, in the caller's
 * RLS context, narrowed by `ownership` when given. {@link pickOemLink} decides among
 * them for one device, so a caller with many devices reads this once.
 */
export async function loadOemLinkCandidates(ownership?: SQL): Promise<OemLinkCandidate[]> {
  return db
    .select({
      linkId: configPolicyEffectiveFeatureLinks.id,
      sourcePolicyId: configPolicyEffectiveFeatureLinks.sourcePolicyId,
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      linkUpdatedAt: configPolicyEffectiveFeatureLinks.updatedAt,
      assignedPolicyId: configurationPolicies.id,
      policyOrgId: configurationPolicies.orgId,
      policyPartnerId: configurationPolicies.partnerId,
      assignmentLevel: configPolicyAssignments.level,
      assignmentTargetId: configPolicyAssignments.targetId,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        ownership,
      ),
    )
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'oem_updates'),
      ),
    )
    // Same ORDER BY as the per-device walk, so a full tie breaks the same way.
    .orderBy(configPolicyAssignments.level, configPolicyAssignments.priority, configPolicyAssignments.createdAt) as Promise<OemLinkCandidate[]>;
}

/**
 * One parse per candidate per read, not per device: a partner-wide link can win for a
 * whole fleet, and it is the settings parse that would add up across one.
 */
const resolvedByCandidate = new WeakMap<OemLinkCandidate, ResolvedOemUpdatesLink>();

/**
 * The winning link for one device among already-loaded candidates, in memory: the
 * same decision as {@link resolveOemUpdatesLinkForDevice}, rule for rule. Ownership
 * (the device's org, or partner-wide for its partner), targets, role/OS filters,
 * closest wins. `partnerId` is null for a parked device, which gets nothing partner-wide.
 */
export function pickOemLink(
  candidates: readonly OemLinkCandidate[],
  device: { id: string; orgId: string; siteId: string | null; deviceRole: string; osType: string },
  partnerId: string | null,
  groups: readonly string[],
): ResolvedOemUpdatesLink | null {
  const applicable = candidates.filter((row) => {
    const owned = row.policyOrgId === device.orgId
      || (row.policyOrgId === null && partnerId !== null && row.policyPartnerId === partnerId);
    if (!owned) return false;
    const targeted =
      (row.assignmentLevel === 'device' && row.assignmentTargetId === device.id)
      || (row.assignmentLevel === 'device_group' && groups.includes(row.assignmentTargetId))
      || (row.assignmentLevel === 'site' && row.assignmentTargetId === device.siteId)
      || (row.assignmentLevel === 'organization' && row.assignmentTargetId === device.orgId)
      || (row.assignmentLevel === 'partner' && partnerId !== null && row.assignmentTargetId === partnerId);
    return targeted && matchesRoleOsFilter(row, device);
  });
  if (applicable.length === 0) return null;
  const winner = sortByHierarchy([...applicable])[0]!;
  let resolved = resolvedByCandidate.get(winner);
  if (!resolved) {
    resolved = toResolved(winner);
    resolvedByCandidate.set(winner, resolved);
  }
  return resolved;
}
