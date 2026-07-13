import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
  configPolicyBackupSettings,
  backupProfiles,
  backupConfigs,
  devices,
  organizations,
  partners,
  deviceGroupMemberships,
  sites,
  softwarePolicies,
} from '../db/schema';
import { and, eq, sql, inArray, asc, SQL } from 'drizzle-orm';
import { resolveEffectiveTimezone, canonicalizeTimezone } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { TokenPayload } from './jwt';
import type { AutomationAssignmentLevel } from '../jobs/queueSchemas';

// ============================================
// Types
// ============================================

type ConfigAssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

const LEVEL_PRIORITY: Record<ConfigAssignmentLevel, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

// ============================================
// System Auth Context (for workers / background jobs)
// ============================================

/**
 * Creates a synthetic AuthContext for system-level operations
 * that run outside HTTP request context (e.g. BullMQ workers, cron jobs).
 * This context passes all org checks (system scope, no org filter).
 */
export function createSystemAuthContext(): AuthContext {
  const token: TokenPayload = {
    sub: '00000000-0000-0000-0000-000000000000',
    email: 'system@breeze.internal',
    roleId: null,
    orgId: null,
    partnerId: null,
    scope: 'system',
    type: 'access',
    mfa: false,
  };

  return {
    user: {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'system@breeze.internal',
      name: 'System',
      isPlatformAdmin: false,
    },
    token,
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null, // null = all orgs accessible
    orgCondition: () => undefined, // no filter for system scope
    canAccessOrg: () => true, // system can access any org
  };
}

// ============================================
// Internal: Build hierarchy target conditions
// ============================================

interface DeviceHierarchy {
  deviceId: string;
  orgId: string;
  siteId: string;
  partnerId: string | null;
  groupIds: string[];
  deviceRole: string;
  osType: string;
}

async function loadDeviceHierarchy(deviceId: string): Promise<DeviceHierarchy | null> {
  // 1. Load device
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, deviceRole: devices.deviceRole, osType: devices.osType })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;

  // 2. Load org for partnerId
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  return {
    deviceId: device.id,
    orgId: device.orgId,
    siteId: device.siteId,
    partnerId: org?.partnerId ?? null,
    groupIds: groupRows.map((r) => r.groupId),
    deviceRole: device.deviceRole,
    osType: device.osType,
  };
}

/**
 * Build SQL conditions that enforce roleFilter and osFilter on assignments.
 * NULL filter = match all (backward compatible).
 */
function buildRoleOsFilterConditions(hierarchy: DeviceHierarchy): SQL[] {
  return [
    sql`(${configPolicyAssignments.roleFilter} IS NULL OR ${sql.param(hierarchy.deviceRole)} = ANY(${configPolicyAssignments.roleFilter}))`,
    sql`(${configPolicyAssignments.osFilter} IS NULL OR ${sql.param(hierarchy.osType)} = ANY(${configPolicyAssignments.osFilter}))`,
  ];
}

/**
 * Build the policy-ownership condition for a device's hierarchy.
 *
 * A configuration_policies row resolves for this device when it is owned by
 * the device's own org (the original org-scoped shape) OR owned by the
 * device's partner (org_id NULL, partner_id set — the "partner-wide / all orgs"
 * shape, #1724). breeze_has_org_access / breeze_has_partner_access at the RLS
 * layer still gate visibility; this is the additional "does this policy apply
 * to this device" join predicate.
 *
 * Use this in place of a bare org-equality join on every per-device resolver
 * so partner-owned policies span all of the partner's orgs.
 */
function policyOwnershipCondition(hierarchy: DeviceHierarchy): SQL {
  if (hierarchy.partnerId) {
    return sql`(${configurationPolicies.orgId} = ${hierarchy.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${hierarchy.partnerId}))`;
  }
  return sql`${configurationPolicies.orgId} = ${hierarchy.orgId}`;
}

function buildTargetConditions(hierarchy: DeviceHierarchy): SQL[] {
  const conditions: SQL[] = [];

  // Device level
  conditions.push(
    and(
      eq(configPolicyAssignments.level, 'device'),
      eq(configPolicyAssignments.targetId, hierarchy.deviceId)
    )!
  );

  // Device group level
  if (hierarchy.groupIds.length > 0) {
    conditions.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(configPolicyAssignments.targetId, hierarchy.groupIds)
      )!
    );
  }

  // Site level
  conditions.push(
    and(
      eq(configPolicyAssignments.level, 'site'),
      eq(configPolicyAssignments.targetId, hierarchy.siteId)
    )!
  );

  // Organization level
  conditions.push(
    and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, hierarchy.orgId)
    )!
  );

  // Partner level
  if (hierarchy.partnerId) {
    conditions.push(
      and(
        eq(configPolicyAssignments.level, 'partner'),
        eq(configPolicyAssignments.targetId, hierarchy.partnerId)
      )!
    );
  }

  return conditions;
}

/**
 * Sort rows by hierarchy level (device=5 wins first), then assignment priority ASC,
 * then createdAt ASC (earliest first as tiebreaker).
 */
function sortByHierarchy<T extends { assignmentLevel: string; assignmentPriority: number; assignmentCreatedAt: Date }>(
  rows: T[]
): T[] {
  return rows.sort((a, b) => {
    const levelDiff =
      (LEVEL_PRIORITY[b.assignmentLevel as ConfigAssignmentLevel] ?? 0) -
      (LEVEL_PRIORITY[a.assignmentLevel as ConfigAssignmentLevel] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    const priDiff = a.assignmentPriority - b.assignmentPriority;
    if (priDiff !== 0) return priDiff;
    return a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime();
  });
}

// ============================================
// Feature-Specific Resolvers
// ============================================

/**
 * Resolves alert rules for a device via the hierarchy.
 * Returns all alert rule rows from the WINNING assignment (closest level wins).
 */
export async function resolveAlertRulesForDevice(
  deviceId: string
): Promise<(typeof configPolicyAlertRules.$inferSelect)[]> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return [];

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      alertRule: configPolicyAlertRules,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        inArray(configPolicyFeatureLinks.featureType, ['alert_rule', 'monitoring'])
      )
    )
    .innerJoin(
      configPolicyAlertRules,
      eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt,
      asc(configPolicyAlertRules.sortOrder)
    );

  if (rows.length === 0) return [];

  // Sort by hierarchy and pick the winning assignment
  const sorted = sortByHierarchy(rows);
  const winningAssignmentId = sorted[0]!.assignmentId;

  // Return all alert rules from the winning assignment
  return sorted
    .filter((r) => r.assignmentId === winningAssignmentId)
    .map((r) => r.alertRule);
}

/**
 * Resolves automations for a device via the hierarchy.
 * Returns all automation rows from the WINNING assignment.
 */
export async function resolveAutomationsForDevice(
  deviceId: string
): Promise<(typeof configPolicyAutomations.$inferSelect)[]> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return [];

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      automation: configPolicyAutomations,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'automation')
      )
    )
    .innerJoin(
      configPolicyAutomations,
      eq(configPolicyAutomations.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt,
      asc(configPolicyAutomations.sortOrder)
    );

  if (rows.length === 0) return [];

  const sorted = sortByHierarchy(rows);
  const winningAssignmentId = sorted[0]!.assignmentId;

  return sorted
    .filter((r) => r.assignmentId === winningAssignmentId)
    .map((r) => r.automation);
}

/**
 * Resolves patch settings for a device via the hierarchy.
 * Returns the single patch settings row from the WINNING assignment, or null.
 */
export async function resolvePatchConfigForDevice(
  deviceId: string
): Promise<typeof configPolicyPatchSettings.$inferSelect | null> {
  const resolved = await resolvePatchConfigDetailsForDevice(deviceId);
  return resolved?.settings ?? null;
}

export interface ResolvedPatchConfigDetails {
  settings: typeof configPolicyPatchSettings.$inferSelect;
  featureLinkId: string;
  configPolicyId: string;
  configPolicyName: string;
  featurePolicyId: string | null;
  assignmentLevel: string;
  assignmentTargetId: string;
  assignmentPriority: number;
  resolvedTimezone: string;
}

// Reads the partner timezone with the column as the source of truth and the
// legacy `settings.timezone` JSONB key as a non-destructive fallback (the column
// is backfilled from that key but the UI still writes the key today — see
// issue #1318 / migration 2026-06-13-c).
function partnerTimezoneFrom(
  column: string | null | undefined,
  settings: unknown,
): string | null {
  // Canonicalize the column so a non-canonical stored 'utc' (e.g. a row that
  // predates the canonicalize-on-write fix) folds to the 'UTC' sentinel and is
  // correctly treated as "still at the default" rather than an explicit choice.
  const canonicalColumn = canonicalizeTimezone(column);
  if (canonicalColumn !== null && canonicalColumn !== 'UTC') {
    return canonicalColumn;
  }
  const fromSettings =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).timezone
      : null;
  if (typeof fromSettings === 'string' && fromSettings.length > 0) {
    return fromSettings;
  }
  // Column defaults to 'UTC'; surface it so the resolver can use it as a
  // genuine (if last-resort) candidate rather than treating it as unset.
  return canonicalColumn;
}

export async function resolveDeviceTimezone(deviceId: string): Promise<string> {
  const [row] = await db
    .select({
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    // leftJoin (not inner) on partners: the partners SELECT RLS policy is
    // breeze_has_partner_access(id), which is FALSE for an ORG-scoped request
    // (computeAccessiblePartnerIds returns [] for org scope). An inner join
    // would make the partner row RLS-invisible and drop the ENTIRE device row,
    // sending resolveDeviceTimezone down its missing-row branch -> 'UTC', a
    // regression of the prior site->org->UTC behavior. With a left join the
    // device row survives, partnerTimezone is simply null, and
    // resolveEffectiveTimezone falls through site -> org -> UTC. For
    // system/partner-scoped requests the partner row is visible and contributes
    // to the chain as intended (#1318).
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(eq(devices.id, deviceId))
    .limit(1);

  const orgTimezone =
    row?.orgSettings && typeof row.orgSettings === 'object'
      ? (row.orgSettings as Record<string, unknown>).timezone
      : null;

  // explicit (n/a for a device — devices have no own tz) -> site -> org -> partner -> UTC
  //
  // BEHAVIORAL CHANGE (issue #1318, intended): the historical chain stopped at
  // site -> org -> UTC with no partner branch, so any device whose site/org had
  // no tz resolved to UTC. Inserting `partner` between org and the UTC floor
  // means an existing device under a partner that has set a non-UTC
  // `partners.timezone` now resolves patch/backup/maintenance schedules in
  // partner-LOCAL time instead of UTC. Patch/maintenance windows for those
  // devices effectively shift on upgrade — this is the explicit intent of
  // #1318 (default to the partner tz), NOT a regression. Partners left at the
  // 'UTC' default are unaffected (UTC stays the resolved value).
  return resolveEffectiveTimezone({
    siteTz: row?.siteTimezone,
    orgTz: typeof orgTimezone === 'string' ? orgTimezone : null,
    partnerTz: partnerTimezoneFrom(row?.partnerTimezone, row?.partnerSettings),
  });
}

export async function resolvePatchConfigDetailsForDevice(
  deviceId: string
): Promise<ResolvedPatchConfigDetails | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      patchSettings: configPolicyPatchSettings,
      featureLinkId: configPolicyFeatureLinks.id,
      configPolicyId: configurationPolicies.id,
      configPolicyName: configurationPolicies.name,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      assignmentTargetId: configPolicyAssignments.targetId,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'patch')
      )
    )
    .innerJoin(
      configPolicyPatchSettings,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  const winner = sorted[0]!;

  return {
    settings: winner.patchSettings,
    featureLinkId: winner.featureLinkId,
    configPolicyId: winner.configPolicyId,
    configPolicyName: winner.configPolicyName,
    featurePolicyId: winner.featurePolicyId,
    assignmentLevel: winner.assignmentLevel,
    assignmentTargetId: winner.assignmentTargetId,
    assignmentPriority: winner.assignmentPriority,
    resolvedTimezone: await resolveDeviceTimezone(deviceId),
  };
}

/**
 * Runs a backup POLICY lookup where partner-wide rows must be visible.
 *
 * `configuration_policies` and `backup_profiles` rows owned by a partner have
 * `org_id NULL`, and an org-scoped token never passes `breeze_has_partner_access`
 * — so under a request's RLS context those rows simply do not exist. A backup
 * reader that runs there silently reports "no policy" for partner-linked
 * devices: manual runs fall back to a legacy single-mode job, dashboards call
 * protected devices unprotected. Same trap the heartbeat probe-config hit
 * (#1105); the playbook's answer is a system context.
 *
 * Only the policy/profile joins go through here — they are self-tenanted by the
 * caller-supplied orgId or the device's own hierarchy. Device expansion stays in
 * the caller's context so RLS keeps guarding which devices a caller may see.
 *
 * No-ops when already system-scoped (the scheduler), so the worker doesn't open
 * a second transaction per resolve.
 */
async function withPartnerWideVisibility<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Resolves backup settings for a device via the hierarchy.
 * Returns the single backup settings row + metadata from the WINNING assignment, or null.
 */
export async function resolveBackupConfigForDevice(
  deviceId: string
): Promise<{
  settings: typeof configPolicyBackupSettings.$inferSelect | null;
  featureLinkId: string;
  /** Resolved storage destination — see BackupAssignedDevice.configId. */
  configId: string | null;
  selectionSpecs: BackupSelectionSpec[] | null;
  /** Broken profile link — see BackupAssignedDevice.selectionError. */
  selectionError: string | null;
  inlineSettings: Record<string, unknown> | null;
  resolvedTimezone: string;
} | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // Partner-wide policies + profiles are RLS-invisible to org tokens — resolve
  // them in a system context (self-tenanted by this device's hierarchy).
  const rows = await withPartnerWideVisibility(() =>
    db
      .select({
        backupSettings: configPolicyBackupSettings,
        featureLinkId: configPolicyFeatureLinks.id,
        featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
        inlineSettings: configPolicyFeatureLinks.inlineSettings,
        profileSelections: backupProfiles.selections,
        assignmentLevel: configPolicyAssignments.level,
        assignmentPriority: configPolicyAssignments.priority,
        assignmentCreatedAt: configPolicyAssignments.createdAt,
        assignmentId: configPolicyAssignments.id,
      })
      .from(configPolicyAssignments)
      .innerJoin(
        configurationPolicies,
        and(
          eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
          eq(configurationPolicies.status, 'active'),
          policyOwnershipCondition(hierarchy)
        )
      )
      .innerJoin(
        configPolicyFeatureLinks,
        and(
          eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
          eq(configPolicyFeatureLinks.featureType, 'backup')
        )
      )
      .leftJoin(
        configPolicyBackupSettings,
        eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
      )
      // Deliberately NOT filtered on backupProfiles.isActive: deactivating a
      // profile removes it from the pickers (the list API hides inactive rows)
      // but must NOT silently stop backups on policies that already link it —
      // that would be a data-protection change disguised as a UI toggle. The
      // profile editor's helper text states this contract. To stop backups,
      // unlink the profile or deactivate the policy.
      .leftJoin(
        backupProfiles,
        eq(backupProfiles.id, configPolicyBackupSettings.backupProfileId)
      )
      .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
      .orderBy(
        configPolicyAssignments.level,
        configPolicyAssignments.priority,
        configPolicyAssignments.createdAt
      )
  );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  const winner = sorted[0]!;
  const profileId = winner.backupSettings?.backupProfileId ?? null;
  const selectionSpecs = profileId
    ? backupSelectionSpecs(winner.profileSelections, { profileId })
    : null;
  // A profile link whose profile yields no usable selection is BROKEN, not
  // legacy — surface it instead of falling through to the settings row (which
  // for a profile link has no paths and would back up nothing).
  const selectionError =
    profileId && !selectionSpecs
      ? `Backup profile ${profileId} could not be resolved into any data source`
      : null;
  // Destination chain: explicit link destination → legacy featurePolicyId
  // (pre-profile links stored the destination there) → org default.
  const legacyDestination = profileId ? null : winner.featurePolicyId;
  const configId =
    winner.backupSettings?.destinationConfigId ??
    legacyDestination ??
    (await resolveOrgDefaultBackupConfigId(hierarchy.orgId));
  return {
    settings: winner.backupSettings,
    featureLinkId: winner.featureLinkId,
    configId,
    selectionSpecs,
    selectionError,
    inlineSettings: winner.inlineSettings as Record<string, unknown> | null,
    resolvedTimezone: await resolveDeviceTimezone(deviceId),
  };
}

/**
 * Resolves maintenance settings for a device via the hierarchy.
 * Returns the single maintenance settings row from the WINNING assignment, or null.
 */
export async function resolveMaintenanceConfigForDevice(
  deviceId: string
): Promise<typeof configPolicyMaintenanceSettings.$inferSelect | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      maintenanceSettings: configPolicyMaintenanceSettings,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'maintenance')
      )
    )
    .innerJoin(
      configPolicyMaintenanceSettings,
      eq(configPolicyMaintenanceSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  return sorted[0]!.maintenanceSettings;
}

/**
 * Resolves compliance rules for a device via the hierarchy.
 * Returns all compliance rule rows from the WINNING assignment.
 */
export async function resolveComplianceRulesForDevice(
  deviceId: string
): Promise<(typeof configPolicyComplianceRules.$inferSelect)[]> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return [];

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      complianceRule: configPolicyComplianceRules,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'compliance')
      )
    )
    .innerJoin(
      configPolicyComplianceRules,
      eq(configPolicyComplianceRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt,
      asc(configPolicyComplianceRules.sortOrder)
    );

  if (rows.length === 0) return [];

  const sorted = sortByHierarchy(rows);
  const winningAssignmentId = sorted[0]!.assignmentId;

  return sorted
    .filter((r) => r.assignmentId === winningAssignmentId)
    .map((r) => r.complianceRule);
}

/**
 * Resolves the winning software policy ID for a device via config policy hierarchy.
 * Returns the featurePolicyId from the closest config policy assignment, or null.
 */
export async function resolveSoftwarePolicyForDevice(
  deviceId: string
): Promise<string | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      assignmentId: configPolicyAssignments.id,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'software_policy')
      )
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  return sorted[0]!.featurePolicyId;
}

/**
 * Batch resolver: finds all device IDs that should be governed by a given software policy
 * via config policy assignments. Used by the compliance worker.
 *
 * Steps:
 * 1. Find all config policies that link to this software policy
 * 2. Get all assignments for those config policies
 * 3. Resolve each assignment to device IDs based on level/targetId
 * 4. For each device, verify this software policy is the "winning" one
 *    (closest wins — if a device has a closer assignment linking to a different policy, exclude it)
 */
export async function resolveDeviceIdsForSoftwarePolicy(
  softwarePolicyId: string
): Promise<string[]> {
  // 1. Find config policies linking to this software policy
  const links = await db
    .select({
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .where(
      and(
        eq(configPolicyFeatureLinks.featureType, 'software_policy'),
        eq(configPolicyFeatureLinks.featurePolicyId, softwarePolicyId)
      )
    );

  if (links.length === 0) return [];

  const configPolicyIds = links.map((l) => l.configPolicyId);

  // 2. Get all assignments for those config policies
  const assignments = await db
    .select({
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, configPolicyIds));

  if (assignments.length === 0) return [];

  // 3. Resolve each assignment to device IDs
  const candidateDeviceIds = new Set<string>();

  for (const assignment of assignments) {
    let assignedDeviceIds: string[];

    switch (assignment.level) {
      case 'device': {
        assignedDeviceIds = [assignment.targetId];
        break;
      }
      case 'device_group': {
        const rows = await db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(eq(deviceGroupMemberships.groupId, assignment.targetId));
        assignedDeviceIds = rows.map((r) => r.deviceId);
        break;
      }
      case 'site': {
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.siteId, assignment.targetId));
        assignedDeviceIds = rows.map((r) => r.id);
        break;
      }
      case 'organization': {
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.orgId, assignment.targetId));
        assignedDeviceIds = rows.map((r) => r.id);
        break;
      }
      case 'partner': {
        const orgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, assignment.targetId));
        if (orgs.length === 0) {
          assignedDeviceIds = [];
        } else {
          const rows = await db
            .select({ id: devices.id })
            .from(devices)
            .where(inArray(devices.orgId, orgs.map((o) => o.id)));
          assignedDeviceIds = rows.map((r) => r.id);
        }
        break;
      }
      default:
        assignedDeviceIds = [];
    }

    for (const id of assignedDeviceIds) {
      candidateDeviceIds.add(id);
    }
  }

  if (candidateDeviceIds.size === 0) return [];

  // 4. Verify each candidate — the winning software policy must be this one.
  // For efficiency, batch-check: resolve the winning policy for each candidate device.
  // A device is included only if its closest config policy points to this software policy.
  const verifiedDeviceIds: string[] = [];
  const candidates = Array.from(candidateDeviceIds);

  // Process in batches to avoid excessive parallel DB queries
  const BATCH_SIZE = 50;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (deviceId) => {
        const winningPolicyId = await resolveSoftwarePolicyForDevice(deviceId);
        return { deviceId, winningPolicyId };
      })
    );
    for (const { deviceId, winningPolicyId } of results) {
      if (winningPolicyId === softwarePolicyId) {
        verifiedDeviceIds.push(deviceId);
      }
    }
  }

  return verifiedDeviceIds;
}

// ============================================
// Vulnerability scanning gate (BE-16 correlation)
// ============================================

/**
 * Resolve whether per-device vulnerability correlation is enabled for a device,
 * via the config-policy hierarchy ("closest wins"). Reads the winning
 * `vulnerability` feature link's `inlineSettings.enabled`.
 *
 * DEFAULT DISABLED: no `vulnerability` policy anywhere in the hierarchy → false,
 * and a closer assignment with `enabled:false` correctly overrides a broader
 * `enabled:true` (e.g. a device- or group-level opt-out under an org-wide opt-in).
 * Pattern B inline toggle — there is no normalized table; the flag lives in the
 * feature link's JSONB `inlineSettings`.
 */
export async function resolveVulnerabilityEnabledForDevice(deviceId: string): Promise<boolean> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return false;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
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
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'vulnerability')
      )
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return false;

  const winner = sortByHierarchy(rows)[0]!;
  const settings = winner.inlineSettings as { enabled?: unknown } | null;
  return settings?.enabled === true;
}

/**
 * Batch resolver: every device for which vulnerability correlation is enabled,
 * grouped by orgId. Drives the daily `vuln-correlate` job so correlation only
 * touches opted-in devices.
 *
 * Mirrors {@link resolveDeviceIdsForSoftwarePolicy}: gather candidate devices
 * from every active config policy that carries a `vulnerability` feature link,
 * then verify each candidate's WINNING vulnerability link is enabled (closest-
 * wins, so a device/group-level `enabled:false` suppresses a broader opt-in).
 * Returns an empty map when nothing is enabled.
 *
 * Run inside `withSystemDbAccessContext` (config-policy tables are RLS-scoped).
 */
export async function resolveAllVulnerabilityEnabledDevices(): Promise<Map<string, string[]>> {
  // 1. Active config policies that carry a vulnerability feature link.
  const links = await db
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .where(eq(configPolicyFeatureLinks.featureType, 'vulnerability'));

  if (links.length === 0) return new Map();

  const configPolicyIds = [...new Set(links.map((l) => l.configPolicyId))];

  // 2. Assignments for those policies → candidate device IDs.
  const assignments = await db
    .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, configPolicyIds));

  if (assignments.length === 0) return new Map();

  const candidateDeviceIds = new Set<string>();
  for (const assignment of assignments) {
    let ids: string[];
    switch (assignment.level) {
      case 'device':
        ids = [assignment.targetId];
        break;
      case 'device_group': {
        const rows = await db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(eq(deviceGroupMemberships.groupId, assignment.targetId));
        ids = rows.map((r) => r.deviceId);
        break;
      }
      case 'site': {
        const rows = await db.select({ id: devices.id }).from(devices).where(eq(devices.siteId, assignment.targetId));
        ids = rows.map((r) => r.id);
        break;
      }
      case 'organization': {
        const rows = await db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, assignment.targetId));
        ids = rows.map((r) => r.id);
        break;
      }
      case 'partner': {
        const orgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, assignment.targetId));
        if (orgs.length === 0) {
          ids = [];
          break;
        }
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(inArray(devices.orgId, orgs.map((o) => o.id)));
        ids = rows.map((r) => r.id);
        break;
      }
      default:
        ids = [];
    }
    for (const id of ids) candidateDeviceIds.add(id);
  }

  if (candidateDeviceIds.size === 0) return new Map();

  // 3. Verify each candidate (closest-wins) — batched to bound parallel queries.
  const candidates = [...candidateDeviceIds];
  const enabledIds: string[] = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (deviceId) => ({
        deviceId,
        enabled: await resolveVulnerabilityEnabledForDevice(deviceId),
      }))
    );
    for (const { deviceId, enabled } of results) {
      if (enabled) enabledIds.push(deviceId);
    }
  }

  if (enabledIds.length === 0) return new Map();

  // 4. Group enabled devices by org.
  const orgRows = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(inArray(devices.id, enabledIds));

  const byOrg = new Map<string, string[]>();
  for (const row of orgRows) {
    const list = byOrg.get(row.orgId) ?? [];
    list.push(row.id);
    byOrg.set(row.orgId, list);
  }
  return byOrg;
}

// ============================================
// Batch Scan Helpers (for workers)
// ============================================

export interface ScheduledAutomationWithTarget {
  automation: typeof configPolicyAutomations.$inferSelect;
  assignmentLevel: AutomationAssignmentLevel;
  assignmentTargetId: string;
  policyId: string;
  policyName: string;
}

/**
 * Scans all scheduled automations that are enabled and belong to active policies.
 * Used by the automation scheduler worker to find due cron-based automations.
 */
export async function scanScheduledAutomations(): Promise<ScheduledAutomationWithTarget[]> {
  const rows = await db
    .select({
      automation: configPolicyAutomations,
      assignmentLevel: configPolicyAssignments.level,
      assignmentTargetId: configPolicyAssignments.targetId,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
    })
    .from(configPolicyAutomations)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyAutomations.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .where(
      and(
        eq(configPolicyAutomations.triggerType, 'schedule'),
        eq(configPolicyAutomations.enabled, true)
      )
    )
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.targetId,
      asc(configPolicyAutomations.sortOrder)
    );

  return rows;
}

export interface ComplianceRuleWithTarget {
  complianceRule: typeof configPolicyComplianceRules.$inferSelect;
  assignmentLevel: string;
  assignmentTargetId: string;
  policyId: string;
  policyName: string;
}

/**
 * Scans all active compliance rules with their assignment targets.
 * Used by the compliance checker worker to find rules that need evaluation.
 */
export async function scanDueComplianceChecks(): Promise<ComplianceRuleWithTarget[]> {
  const rows = await db
    .select({
      complianceRule: configPolicyComplianceRules,
      assignmentLevel: configPolicyAssignments.level,
      assignmentTargetId: configPolicyAssignments.targetId,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
    })
    .from(configPolicyComplianceRules)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyComplianceRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.targetId,
      asc(configPolicyComplianceRules.sortOrder)
    );

  return rows;
}

// ============================================
// Backup: All Assigned Devices for an Org
// ============================================

export interface BackupAssignedDevice {
  deviceId: string;
  featureLinkId: string;
  /** Resolved storage destination (backup_configs id): explicit link
   *  destination → legacy featurePolicyId destination → org default. NULL
   *  when none resolves — job creation then skips the device LOUDLY (worker
   *  error log + policy-UI warning); it never creates a job row, because
   *  backup_jobs.config_id is NOT NULL. */
  configId: string | null;
  settings: typeof configPolicyBackupSettings.$inferSelect | null;
  /** One spec per enabled profile selection; null for legacy custom links
   *  (dispatch falls back to the settings row's backupMode/targets). */
  selectionSpecs: BackupSelectionSpec[] | null;
  /** Set when the winning link points at a profile that could not be resolved
   *  into any usable selection (RLS-hidden, deleted, or malformed selections).
   *  Job creation MUST skip the device loudly: the legacy settings row on a
   *  profile link carries no paths, so falling through would back up nothing. */
  selectionError: string | null;
  resolvedTimezone: string;
}

// ── Backup profile fan-out (spec 2026-07-13) ─────────────────────────────────

export type BackupSelectionSpec = {
  backupMode: 'file' | 'hyperv' | 'mssql' | 'system_image';
  targets: Record<string, unknown>;
};

/**
 * Maps a backup profile's `selections` jsonb to per-mode job specs, in
 * fan-out order (must stay in sync with `enabledBackupSelections` in
 * @breeze/shared). Returns null when nothing usable is enabled.
 *
 * A caller holding a backupProfileId MUST treat null as a BROKEN link and skip
 * the device loudly — never fall through to the legacy settings row, which for
 * a profile link carries no paths and would dispatch a backup that reports
 * success while protecting nothing.
 *
 * Keys match backup_mode_enum by design (see backupProfileSelectionsSchema).
 */
export function backupSelectionSpecs(
  selections: unknown,
  context?: { profileId?: string | null }
): BackupSelectionSpec[] | null {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) return null;
  const s = selections as Record<string, Record<string, unknown> | undefined>;
  const specs: BackupSelectionSpec[] = [];
  if (s.file?.enabled === true) {
    const paths = Array.isArray(s.file.paths)
      ? s.file.paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [];
    // An enabled file selection with no paths dispatches an empty backup that
    // completes green. `volumes` is rejected at the validator until job
    // creation can expand it into paths (spec phase 3), so this only fires on
    // pre-validator or hand-forged rows: drop the selection, never protect
    // nothing silently.
    if (paths.length === 0) {
      console.error(
        `[BackupResolver] Profile ${context?.profileId ?? '(unknown)'} has an enabled file selection with no paths — dropping it (drive/volume selection is not honored yet)`
      );
    } else {
      specs.push({
        backupMode: 'file',
        targets: {
          paths,
          excludes: Array.isArray(s.file.excludes) ? s.file.excludes : [],
        },
      });
    }
  }
  if (s.system_image?.enabled === true) {
    specs.push({
      backupMode: 'system_image',
      targets: { includeSystemState: s.system_image.includeSystemState !== false },
    });
  }
  if (s.mssql?.enabled === true) {
    specs.push({
      backupMode: 'mssql',
      targets: {
        backupType: typeof s.mssql.backupType === 'string' ? s.mssql.backupType : 'full',
        excludeDatabases: Array.isArray(s.mssql.excludeDatabases) ? s.mssql.excludeDatabases : [],
      },
    });
  }
  if (s.hyperv?.enabled === true) {
    specs.push({
      backupMode: 'hyperv',
      targets: {
        consistencyType:
          typeof s.hyperv.consistencyType === 'string' ? s.hyperv.consistencyType : 'application',
        excludeVms: Array.isArray(s.hyperv.excludeVms) ? s.hyperv.excludeVms : [],
      },
    });
  }
  return specs.length > 0 ? specs : null;
}

/**
 * Effective backup modes for a resolved entry — a profile's enabled
 * selections, or the legacy settings row's single backupMode. Mode-filtered
 * readers (currently the Hyper-V and MSSQL views) must use this instead of
 * `settings.backupMode === X`, which is blind to profiles. SLA and readiness
 * consume the resolver but are mode-agnostic today.
 */
export function effectiveBackupModes(entry: {
  selectionSpecs: BackupSelectionSpec[] | null;
  settings: { backupMode: string } | null;
  selectionError?: string | null;
}): string[] {
  // A broken profile link protects nothing — don't report the legacy row's
  // stale mode as if it were live.
  if (entry.selectionError) return [];
  if (entry.selectionSpecs) return entry.selectionSpecs.map((spec) => spec.backupMode);
  return entry.settings ? [entry.settings.backupMode] : [];
}

/** The org's default backup destination (active), or null. */
export async function resolveOrgDefaultBackupConfigId(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: backupConfigs.id })
    .from(backupConfigs)
    .where(
      and(
        eq(backupConfigs.orgId, orgId),
        eq(backupConfigs.isDefault, true),
        eq(backupConfigs.isActive, true)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export type ResolvedBackupProtection = {
  legalHold: boolean;
  legalHoldReason: string | null;
  immutabilityMode: 'application' | 'provider' | null;
  immutableDays: number | null;
  sourceFeatureLinkIds: string[];
};

function parseBackupRetentionObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getRetentionLegalHoldReason(retention: Record<string, unknown> | null): string | null {
  if (!retention) return null;
  const reason = retention.legalHoldReason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null;
}

function getRetentionImmutabilityMode(retention: Record<string, unknown> | null): 'application' | 'provider' | null {
  if (!retention) return null;
  return retention.immutabilityMode === 'application' || retention.immutabilityMode === 'provider'
    ? retention.immutabilityMode
    : null;
}

function getRetentionImmutableDays(retention: Record<string, unknown> | null): number | null {
  if (!retention) return null;
  const value = retention.immutableDays;
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * Finds ALL devices with backup config policy assignments for an org.
 * Used by the backup scheduler (to know which devices to back up) and the run-all endpoint.
 *
 * Steps:
 * 1. Query all active backup feature links for the org
 * 2. For each, resolve assignment targets to device IDs
 * 3. Deduplicate: first (highest priority) assignment wins per device
 */
export async function resolveAllBackupAssignedDevices(
  orgId: string
): Promise<BackupAssignedDevice[]> {
  // Partner-wide policies (org_id NULL) cover this org when owned by its
  // partner — never filter on org equality alone (that silently no-ops on
  // partner-wide rows; see the partner-wide-first playbook).
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const orgPartnerId = org?.partnerId ?? null;
  const ownershipCondition = orgPartnerId
    ? sql`(${configurationPolicies.orgId} = ${orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${orgPartnerId}))`
    : sql`${configurationPolicies.orgId} = ${orgId}`;

  // 1. Load all active backup feature links + settings + assignments for this org
  // LEFT JOIN backup settings so devices are still found even when the
  // normalized settings row is missing (e.g. feature link predates migration).
  // Runs in a system context: partner-wide policies/profiles (org_id NULL) are
  // RLS-invisible to org tokens, and this query is self-tenanted by ownershipCondition.
  const rows = await withPartnerWideVisibility(() =>
    db
      .select({
        backupSettings: configPolicyBackupSettings,
        featureLinkId: configPolicyFeatureLinks.id,
        featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
        profileSelections: backupProfiles.selections,
        assignmentLevel: configPolicyAssignments.level,
        assignmentTargetId: configPolicyAssignments.targetId,
        assignmentPriority: configPolicyAssignments.priority,
        assignmentCreatedAt: configPolicyAssignments.createdAt,
      })
      .from(configPolicyFeatureLinks)
      .innerJoin(
        configurationPolicies,
        and(
          eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
          eq(configurationPolicies.status, 'active'),
          ownershipCondition
        )
      )
      .innerJoin(
        configPolicyAssignments,
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
      )
      .leftJoin(
        configPolicyBackupSettings,
        eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
      )
      // Deliberately NOT filtered on backupProfiles.isActive: deactivating a
      // profile removes it from the pickers (the list API hides inactive rows)
      // but must NOT silently stop backups on policies that already link it —
      // that would be a data-protection change disguised as a UI toggle. The
      // profile editor's helper text states this contract. To stop backups,
      // unlink the profile or deactivate the policy.
      .leftJoin(
        backupProfiles,
        eq(backupProfiles.id, configPolicyBackupSettings.backupProfileId)
      )
      .where(eq(configPolicyFeatureLinks.featureType, 'backup'))
  );

  if (rows.length === 0) return [];

  // Org default destination, resolved once per call (used by profile links
  // without an explicit destination and by partner-wide links).
  const orgDefaultConfigId = await resolveOrgDefaultBackupConfigId(orgId);

  // Sort by hierarchy priority (device > group > site > org > partner)
  const sorted = sortByHierarchy(rows);

  // 2. Resolve each assignment to device IDs and collect results
  // Track which devices we've already seen — first (highest priority) wins
  const seen = new Map<string, BackupAssignedDevice>();

  for (const row of sorted) {
    let deviceIds: string[];

    // EVERY branch must re-tenant to `orgId`. A partner-wide policy is visible
    // to every org under the partner, so its assignment can name a target in a
    // DIFFERENT org (e.g. an org-level assignment to org B, resolved here for
    // org A). Returning that target's devices would attribute org B's devices
    // to org A — and since a partner-wide link pins no destination, the worker
    // would back them up into org A's storage bucket and file the backup_jobs
    // rows under org A. The worker runs in a system context, so RLS is NOT a
    // backstop here: this function must tenant itself.
    switch (row.assignmentLevel) {
      case 'device': {
        const [device] = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, row.assignmentTargetId), eq(devices.orgId, orgId)))
          .limit(1);
        deviceIds = device ? [device.id] : [];
        break;
      }
      case 'device_group': {
        const members = await db
          .select({ deviceId: devices.id })
          .from(deviceGroupMemberships)
          .innerJoin(devices, eq(devices.id, deviceGroupMemberships.deviceId))
          .where(
            and(
              eq(deviceGroupMemberships.groupId, row.assignmentTargetId),
              eq(devices.orgId, orgId)
            )
          );
        deviceIds = members.map((m) => m.deviceId);
        break;
      }
      case 'site': {
        const siteDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.siteId, row.assignmentTargetId), eq(devices.orgId, orgId)));
        deviceIds = siteDevices.map((d) => d.id);
        break;
      }
      case 'organization': {
        // An org-level assignment contributes devices ONLY to the org it names.
        if (row.assignmentTargetId !== orgId) {
          deviceIds = [];
          break;
        }
        const orgDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.orgId, orgId));
        deviceIds = orgDevices.map((d) => d.id);
        break;
      }
      case 'partner': {
        const partnerDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(
            and(
              eq(organizations.partnerId, row.assignmentTargetId),
              eq(devices.orgId, orgId),
            )
          );
        deviceIds = partnerDevices.map((d) => d.id);
        break;
      }
      default:
        deviceIds = [];
    }

    // First assignment wins per device (sorted is already highest-priority-first)
    const profileId = row.backupSettings?.backupProfileId ?? null;
    const selectionSpecs = profileId
      ? backupSelectionSpecs(row.profileSelections, { profileId })
      : null;
    // Broken profile link: keep the device in `seen` (the winning policy still
    // governs it — a lower-priority policy must not silently take over) but
    // carry the error so job creation skips it loudly.
    const selectionError =
      profileId && !selectionSpecs
        ? `Backup profile ${profileId} could not be resolved into any data source`
        : null;
    const legacyDestination = profileId ? null : row.featurePolicyId;
    const configId =
      row.backupSettings?.destinationConfigId ?? legacyDestination ?? orgDefaultConfigId;
    for (const deviceId of deviceIds) {
      if (!seen.has(deviceId)) {
        seen.set(deviceId, {
          deviceId,
          featureLinkId: row.featureLinkId,
          configId,
          settings: row.backupSettings,
          selectionSpecs,
          selectionError,
          resolvedTimezone: 'UTC',
        });
      }
    }
  }

  const resolved = await Promise.all(
    Array.from(seen.values()).map(async (entry) => ({
      ...entry,
      resolvedTimezone: await resolveDeviceTimezone(entry.deviceId),
    }))
  );

  return resolved;
}

export async function resolveBackupProtectionForDevice(
  deviceId: string
): Promise<ResolvedBackupProtection | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      featureLinkId: configPolicyFeatureLinks.id,
      retention: configPolicyBackupSettings.retention,
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
        policyOwnershipCondition(hierarchy)
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .leftJoin(
      configPolicyBackupSettings,
      eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  const legalHoldRows = sorted.filter((row) => parseBackupRetentionObject(row.retention)?.legalHold === true);
  const legalHoldReason = legalHoldRows
    .map((row) => getRetentionLegalHoldReason(parseBackupRetentionObject(row.retention)))
    .find((reason) => reason !== null) ?? null;

  const immutabilityRows = sorted
    .map((row) => {
      const retention = parseBackupRetentionObject(row.retention);
      return {
        featureLinkId: row.featureLinkId,
        mode: getRetentionImmutabilityMode(retention),
        immutableDays: getRetentionImmutableDays(retention),
      };
    })
    .filter((row): row is { featureLinkId: string; mode: 'application' | 'provider'; immutableDays: number } =>
      row.mode !== null && row.immutableDays !== null
    );

  const maxImmutableDays = immutabilityRows.reduce<number | null>(
    (current, row) => current === null ? row.immutableDays : Math.max(current, row.immutableDays),
    null,
  );

  const maxDurationRows = maxImmutableDays === null
    ? []
    : immutabilityRows.filter((row) => row.immutableDays === maxImmutableDays);

  const immutabilityMode =
    maxDurationRows.some((row) => row.mode === 'provider')
      ? 'provider'
      : maxDurationRows.some((row) => row.mode === 'application')
        ? 'application'
        : null;

  return {
    legalHold: legalHoldRows.length > 0,
    legalHoldReason,
    immutabilityMode,
    immutableDays: maxImmutableDays,
    sourceFeatureLinkIds: Array.from(new Set([
      ...legalHoldRows.map((row) => row.featureLinkId),
      ...maxDurationRows.map((row) => row.featureLinkId),
    ])),
  };
}

// ============================================
// Maintenance Window Helper
// ============================================

export interface MaintenanceWindowStatus {
  active: boolean;
  suppressAlerts: boolean;
  suppressPatching: boolean;
  suppressAutomations: boolean;
  suppressScripts: boolean;
  rebootIfPending: boolean;
}

/**
 * Determines whether a maintenance window is currently active based on
 * the recurrence pattern, duration, and timezone.
 *
 * Recurrence values:
 *   - 'daily'   — window starts every day at 00:00 in the configured timezone
 *   - 'weekly'  — window starts every Sunday at 00:00 in the configured timezone
 *   - 'monthly' — window starts on the 1st of each month at 00:00 in the configured timezone
 *
 * The window lasts for `durationHours` from the start time.
 */
export function isInMaintenanceWindow(
  settings: typeof configPolicyMaintenanceSettings.$inferSelect,
  now?: Date
): MaintenanceWindowStatus {
  const inactive: MaintenanceWindowStatus = {
    active: false,
    suppressAlerts: false,
    suppressPatching: false,
    suppressAutomations: false,
    suppressScripts: false,
    rebootIfPending: false,
  };

  const currentTime = now ?? new Date();
  const tz = settings.timezone || 'UTC';

  // Get the current time in the maintenance window's timezone
  let localNow: Date;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(currentTime);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
    localNow = new Date(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
    );
  } catch (err) {
    console.warn(`[FeatureConfigResolver] Invalid timezone "${settings.timezone}", falling back to UTC:`, err);
    localNow = currentTime;
  }

  const durationMs = settings.durationHours * 60 * 60 * 1000;

  // Compute potential window start based on recurrence
  let windowStart: Date;

  switch (settings.recurrence) {
    case 'once': {
      // Window starts at the stored windowStart datetime (in the configured timezone).
      // If no windowStart is stored, treat as inactive.
      if (!settings.windowStart) {
        return inactive;
      }
      try {
        windowStart = new Date(settings.windowStart);
        if (Number.isNaN(windowStart.getTime())) {
          return inactive;
        }
      } catch {
        return inactive;
      }
      break;
    }
    case 'daily': {
      // Window starts at midnight local time each day
      windowStart = new Date(localNow);
      windowStart.setHours(0, 0, 0, 0);
      break;
    }
    case 'weekly': {
      // Window starts at midnight on the most recent Sunday
      windowStart = new Date(localNow);
      const dayOfWeek = windowStart.getDay(); // 0 = Sunday
      windowStart.setDate(windowStart.getDate() - dayOfWeek);
      windowStart.setHours(0, 0, 0, 0);
      break;
    }
    case 'monthly': {
      // Window starts at midnight on the 1st of the current month
      windowStart = new Date(localNow);
      windowStart.setDate(1);
      windowStart.setHours(0, 0, 0, 0);
      break;
    }
    default: {
      // Unknown recurrence type; treat as inactive
      return inactive;
    }
  }

  const windowEnd = new Date(windowStart.getTime() + durationMs);
  const isActive = localNow >= windowStart && localNow < windowEnd;

  if (!isActive) {
    return inactive;
  }

  return {
    active: true,
    suppressAlerts: settings.suppressAlerts,
    suppressPatching: settings.suppressPatching,
    suppressAutomations: settings.suppressAutomations,
    suppressScripts: settings.suppressScripts,
    rebootIfPending: settings.rebootIfPending,
  };
}

/**
 * Check if a device is currently in a maintenance window (from config policy).
 * Returns the maintenance window status, or inactive if no maintenance policy applies.
 */
export async function checkDeviceMaintenanceWindow(deviceId: string): Promise<MaintenanceWindowStatus> {
  const settings = await resolveMaintenanceConfigForDevice(deviceId);
  if (!settings) {
    return { active: false, suppressAlerts: false, suppressPatching: false, suppressAutomations: false, suppressScripts: false, rebootIfPending: false };
  }
  return isInMaintenanceWindow(settings);
}
