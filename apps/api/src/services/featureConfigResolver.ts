import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { policyOwnershipCondition } from './configPolicyOwnership';
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
import { and, eq, ne, sql, inArray, asc, SQL } from 'drizzle-orm';
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
    principal: { kind: 'system', reason: 'feature-config-resolution' },
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
 * Outcome of {@link resolveGoverningAlertRulePolicyForDevice}: exactly three
 * states, each with its own remedy for the tech.
 *
 * A union rather than `{ winningPolicyId: string | null; candidateAssigned: boolean }`
 * — that pair spells four combinations, and the fourth
 * (`candidateAssigned` with no winner) is unreachable but would render as
 * "another configuration policy takes precedence" naming a policy that does not
 * exist. A fabricated verdict reason is precisely the failure class this
 * endpoint exists to close (#3752/#3923/#3988), so the type refuses to spell it.
 */
export type GoverningAlertRulePolicy =
  /** The candidate policy's alert rules are the ones that run on this device. */
  | { outcome: 'governs' }
  /**
   * The candidate is assigned, but another policy wins the hierarchy.
   * `winningPolicyId` is for diagnostics only — it may name a policy in another
   * org under the partner, so it must never be surfaced to an API client.
   */
  | { outcome: 'outranked'; winningPolicyId: string }
  /** The candidate policy is not assigned to this device at all. */
  | { outcome: 'unassigned' };

/**
 * Would `candidatePolicyId`'s alert rules be the ones that run on this device,
 * if the draft currently open in the editor were saved?
 *
 * This is the targeting half of the config-policy rule Test verdict (#3988), and
 * it deliberately does NOT reuse {@link resolveAlertRulesForDevice}. That
 * resolver inner-joins the persisted rule rows, which makes it answer the wrong
 * question in both directions for an editor:
 *
 *  - A policy whose alert rules are not saved yet (the tech is authoring the
 *    very first one, so there is no feature link and no row) cannot appear in
 *    that join at all, so the draft's own policy would always be reported as
 *    not governing the device.
 *  - Conversely, resolving on the feature LINK alone would let a policy holding
 *    an EMPTY alert_rule link outrank one that actually has rules — which is not
 *    what happens at runtime, where a policy contributing no rows simply does
 *    not win.
 *
 * So the candidate is overlaid onto real runtime behaviour: the candidate policy
 * competes as though it already held a rule, every OTHER policy competes only if
 * it currently holds at least one persisted alert rule, and the ordinary
 * hierarchy sort (level, then assignment priority, then age) picks the winner.
 * Assignment status, ownership, and the role/OS filters are unchanged.
 *
 * Runs in the CALLER'S OWN RLS context like every sibling resolver (#4673 W03 —
 * the former system-context escape is gone). It is NOT a tenancy boundary: it is
 * self-tenanted by the device's own hierarchy, and the caller must have already
 * authorized both the device and the candidate policy.
 */
export async function resolveGoverningAlertRulePolicyForDevice(
  deviceId: string,
  candidatePolicyId: string
): Promise<GoverningAlertRulePolicy> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return { outcome: 'unassigned' };

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // Both reads run in the CALLER'S OWN context (#4673 W03). Partner-wide rows
  // are legible there through the `*_partner_wide_select` RLS branch, so the
  // former system-context escape is gone — no second pooled connection, no RLS
  // bypass. Self-tenanted by this device's own hierarchy either way.
  const assigned = await db
    .select({
      configPolicyId: configurationPolicies.id,
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
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    // sortByHierarchy re-sorts in JS, but ordering here too pins the outcome
    // of a genuine three-way tie (same level, priority AND createdAt), which
    // unordered Postgres output would otherwise decide arbitrarily. Matches
    // resolveAlertRulesForDevice.
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (!assigned.some((row) => row.configPolicyId === candidatePolicyId)) {
    return { outcome: 'unassigned' };
  }

  // Which of the assigned policies actually hold alert rules today. The
  // candidate is exempt: its rules are the draft being tested.
  const policyIdsWithRules = await db
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configPolicyAlertRules,
      eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(
      and(
        eq(configPolicyFeatureLinks.featureType, 'alert_rule'),
        inArray(
          configPolicyFeatureLinks.configPolicyId,
          [...new Set(assigned.map((row) => row.configPolicyId))]
        )
      )
    );
  const haveRules = new Set(policyIdsWithRules.map((row) => row.configPolicyId));

  // The candidate is always a contender here — it is assigned, and its draft
  // counts as a rule — so `contenders` can never be empty at this point.
  const contenders = assigned.filter(
    (row) => row.configPolicyId === candidatePolicyId || haveRules.has(row.configPolicyId)
  );
  const winningPolicyId = sortByHierarchy(contenders)[0]!.configPolicyId;

  return winningPolicyId === candidatePolicyId
    ? { outcome: 'governs' }
    : { outcome: 'outranked', winningPolicyId };
}

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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
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
        // Server-evaluated rules live exclusively under alert_rule links since the
        // 2026-07-30 ownership consolidation migration.
        eq(configPolicyFeatureLinks.featureType, 'alert_rule')
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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
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

/**
 * The partner timezone for an org, resolved with ONE partner-axis escape.
 *
 * Split out so a batch resolver can pay for the escape once instead of per
 * device — every device in an org shares the same partner, so the per-device
 * read is identical N times over (#2822 review). Pinned to the partnerId of an
 * `organizations` row read under the CALLER'S context, so RLS still decides
 * which org is legible and this cannot be aimed at a foreign partner.
 *
 * Returns `undefined` (not null) when the org has no partner, so a caller can
 * tell "not looked up" from "looked up, no partner tz".
 */
export async function resolvePartnerTimezoneForOrg(orgId: string): Promise<string | null> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org?.partnerId) return null;
  const orgPartnerId = org.partnerId;

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ timezone: partners.timezone, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, orgPartnerId))
      .limit(1)
  );

  return partnerTimezoneFrom(partner?.timezone, partner?.settings);
}

export async function resolveDeviceTimezone(
  deviceId: string,
  /**
   * Pre-resolved partner timezone, for batch callers that already paid for the
   * partner read once. When supplied, the per-device partner-axis escape is
   * skipped entirely — that is the whole point.
   */
  opts?: { partnerTz?: string | null },
): Promise<string> {
  // The device/site/org half stays in the CALLER'S context so RLS still decides
  // which device is legible; only the partner row is escaped (#2822).
  //
  // leftJoin (not inner) on sites: a device may have no site. The `partners`
  // join was previously here as a leftJoin so that an RLS-invisible partner
  // could not drop the whole device row (#1318) — but that only prevented a
  // regression, it never made the partner's timezone legible. Under an
  // org-scoped caller `partnerTimezone`/`partnerSettings` simply came back null
  // and the chain silently fell through to site -> org -> 'UTC'. Callers reach
  // this from requireScope('organization','partner','system') routes AND from
  // the system-scoped scheduler, so the SAME device resolved a DIFFERENT
  // maintenance window depending on who triggered the job, with no error
  // anywhere.
  const [row] = await db
    .select({
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerId: organizations.partnerId,
    })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(eq(devices.id, deviceId))
    .limit(1);

  // Escaped separately, pinned to the partnerId of an `organizations` row the
  // caller could already see. Escaping the whole join instead would make the
  // DEVICE row selectable system-wide, demoting device isolation on this path
  // to app-layer-only — which CLAUDE.md forbids — even though today's callers
  // all resolve the device under the caller's context first.
  //
  // Skipped when a batch caller already resolved it (`opts.partnerTz`).
  const partnerTz = opts?.partnerTz !== undefined
    ? opts.partnerTz
    : await resolvePartnerTimezoneForDeviceRow(row?.partnerId ?? null);

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
    partnerTz,
  });
}

/** The partner-axis half of resolveDeviceTimezone, for the single-device path. */
async function resolvePartnerTimezoneForDeviceRow(partnerId: string | null): Promise<string | null> {
  if (!partnerId) return null;
  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ timezone: partners.timezone, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1)
  );
  return partnerTimezoneFrom(partner?.timezone, partner?.settings);
}

export async function resolvePatchConfigDetailsForDevice(
  deviceId: string
): Promise<ResolvedPatchConfigDetails | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // #2930 — the ownership predicate below already admits partner-owned rows,
  // and #4673 W01 makes RLS agree via the SELECT-only `*_partner_wide_select`
  // branch keyed on breeze_current_partner_id(), which W02 populates on agent
  // contexts. So this runs in the CALLER'S OWN context (the agent heartbeat, an
  // org user token) with no second pooled connection — W03 deleted the escape.
  // Self-tenanted by this device's own hierarchy on top of RLS.
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
  const rows = await db
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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(), which W02 populates on agent contexts. So the
  // PAM UAC elevation decision path resolves this inside the agent request's own
  // org-scoped context (W03 deleted the system-context escape). Self-tenanted by
  // this device's own hierarchy on top of RLS.
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
      // Assignment fan-outs skip ephemeral Quick Support devices (and the hidden
      // 'quick_support' org that holds them) — a transient support session is
      // never a policy target. Explicit `device`-level targets are left as-is.
      case 'site': {
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.siteId, assignment.targetId), eq(devices.isEphemeral, false)));
        assignedDeviceIds = rows.map((r) => r.id);
        break;
      }
      case 'organization': {
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.orgId, assignment.targetId), eq(devices.isEphemeral, false)));
        assignedDeviceIds = rows.map((r) => r.id);
        break;
      }
      case 'partner': {
        const orgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.partnerId, assignment.targetId), ne(organizations.type, 'quick_support')));
        if (orgs.length === 0) {
          assignedDeviceIds = [];
        } else {
          const rows = await db
            .select({ id: devices.id })
            .from(devices)
            .where(and(inArray(devices.orgId, orgs.map((o) => o.id)), eq(devices.isEphemeral, false)));
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

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
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
        const rows = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.siteId, assignment.targetId), eq(devices.isEphemeral, false)));
        ids = rows.map((r) => r.id);
        break;
      }
      case 'organization': {
        const rows = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.orgId, assignment.targetId), eq(devices.isEphemeral, false)));
        ids = rows.map((r) => r.id);
        break;
      }
      case 'partner': {
        const orgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.partnerId, assignment.targetId), ne(organizations.type, 'quick_support')));
        if (orgs.length === 0) {
          ids = [];
          break;
        }
        const rows = await db
          .select({ id: devices.id })
          .from(devices)
          .where(and(inArray(devices.orgId, orgs.map((o) => o.id)), eq(devices.isEphemeral, false)));
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
 * The device rows a backup policy is allowed to target (#3968).
 *
 * `decommissioned` is this schema's soft delete — `DELETE /devices/:id` only
 * flips `status`, so the row (and every backup assignment reaching it) survives
 * indefinitely — and an ephemeral device is a Quick Support session box the
 * reaper purges a few hours after the session ends. Neither can ever complete a
 * backup, so fanning out to them buys a guaranteed-failing `backup_jobs` row per
 * schedule tick, forever, plus a `recovery_readiness` row scoring 0 that pins
 * the low-readiness alert.
 *
 * Built as ONE predicate every branch of the fan-out switch reuses: the bug this
 * fixes was five independent WHERE clauses of which zero carried the exclusion,
 * and a sixth branch written later must not be able to miss it. Same pair used
 * by `GET /metrics/`, `readFleetGauges`, and the fleet workers.
 *
 * A function rather than a module constant so the `sql` template is built at
 * call time — module-level evaluation would run inside every suite that mocks
 * `drizzle-orm` at import.
 */
function backupTargetableDeviceCondition(): SQL {
  return sql`${devices.status} <> 'decommissioned' AND ${devices.isEphemeral} = false`;
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
  // Runs in the caller's own context (#4673 W03): partner-wide policies and
  // profiles (org_id NULL) are legible through the `*_partner_wide_select`
  // branches on configuration_policies / config_policy_* / backup_profiles, and
  // the query is self-tenanted by ownershipCondition on top of that.
  const rows = await db
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
    .where(eq(configPolicyFeatureLinks.featureType, 'backup'));

  if (rows.length === 0) return [];

  // Org default destination, resolved once per call (used by profile links
  // without an explicit destination and by partner-wide links).
  const orgDefaultConfigId = await resolveOrgDefaultBackupConfigId(orgId);

  // Sort by hierarchy priority (device > group > site > org > partner)
  const sorted = sortByHierarchy(rows);

  // 2. Resolve each assignment to device IDs and collect results
  // Track which devices we've already seen — first (highest priority) wins
  const seen = new Map<string, BackupAssignedDevice>();

  // EVERY branch of the switch below must ALSO exclude decommissioned and
  // ephemeral rows — see `backupTargetableDeviceCondition`. Bound once and
  // reused because the bug was that all five branches independently forgot it
  // (#3968); a sixth branch should have to reach for this same name.
  const targetableDevice = backupTargetableDeviceCondition();

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
          .where(
            and(
              eq(devices.id, row.assignmentTargetId),
              eq(devices.orgId, orgId),
              targetableDevice
            )
          )
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
              eq(devices.orgId, orgId),
              targetableDevice
            )
          );
        deviceIds = members.map((m) => m.deviceId);
        break;
      }
      case 'site': {
        const siteDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.siteId, row.assignmentTargetId),
              eq(devices.orgId, orgId),
              targetableDevice
            )
          );
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
          .where(and(eq(devices.orgId, orgId), targetableDevice));
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
              targetableDevice
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

  // Timezones resolved with ONE partner-axis escape for the whole batch (#2822).
  //
  // `resolveDeviceTimezone` takes an escape of its own, and each escape is a
  // real `baseDb.transaction` on its own pooled connection. Called per device
  // inside a bare `Promise.all` that is N SIMULTANEOUS connection acquires, on
  // top of the caller's own held request transaction. This resolver runs on
  // org-scoped REQUEST routes (routes/backup/{jobs,dashboard,hyperv,mssql}.ts,
  // routes/backup/readinessCalculator.ts) where the skip-when-system branch does
  // NOT fire, so an org with a few dozen backup-assigned devices loading the
  // backup dashboard would exhaust the 25-connection pool — and postgres-js has
  // no acquire timeout, so it hangs rather than erroring (#1105 class).
  //
  // Every device here belongs to `orgId`, so they all share ONE partner and one
  // partner timezone. Resolving it once and passing it down means the batch
  // costs a single escape AND avoids N redundant identical `partners` reads
  // serialized inside a held transaction (which would trip the
  // DB_CONTEXT_HELD_WARN_MS tripwire on large orgs). Device expansion above
  // already happened in the caller's context, so RLS still decided which devices
  // are in `seen`, and the per-device site/org reads stay caller-scoped.
  const entries = Array.from(seen.values());
  if (entries.length === 0) return [];

  const partnerTz = await resolvePartnerTimezoneForOrg(orgId);
  const timezones = await Promise.all(
    entries.map((entry) => resolveDeviceTimezone(entry.deviceId, { partnerTz })),
  );

  return entries.map((entry, i) => ({ ...entry, resolvedTimezone: timezones[i]! }));
}

export async function resolveBackupProtectionForDevice(
  deviceId: string
): Promise<ResolvedBackupProtection | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  // #2930 — the ownership predicate below admits partner-owned rows; #4673 W01
  // makes RLS agree, via the SELECT-only `*_partner_wide_select` branch keyed on
  // breeze_current_partner_id(). So this runs in the CALLER'S OWN context (W03
  // deleted the system-context escape). Self-tenanted by this device's own
  // hierarchy on top of RLS.
  // The leftJoin to configPolicyBackupSettings is RLS-chained to
  // configuration_policies (same feature-link id); it resolves here because
  // config_policy_backup_settings carries its own partner-wide SELECT branch.
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
  /**
   * When the active window closes, as a real instant. Null whenever the window
   * is not active. #3207 uses it as the ceiling on a reboot deadline: a user
   * may not postpone a maintenance-window reboot past the end of the window.
   */
  windowEndsAt: Date | null;
}

/** Bare time of day, e.g. "1:50", "01:50" or "01:50:00". */
const TIME_OF_DAY_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
/** Time component of a naive (zoneless) ISO-8601-ish datetime, e.g. "2026-03-15T02:00". */
const DATETIME_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ](\d{1,2}):(\d{2})/;
/**
 * A trailing `Z` or `±HH:MM` offset. Such a value names an *instant*, so its
 * digits are not wall-clock time in `settings.timezone` — `migrateToConfigPolicies`
 * writes exactly this shape (`toISOString()`) for migrated `once` windows.
 */
const EXPLICIT_UTC_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The anchor recurring windows used before issue #4224, and the fallback still. */
const MIDNIGHT_ANCHOR = { hours: 0, minutes: 0 } as const;

/**
 * Reads the time-of-day anchor for a recurring maintenance window out of
 * `config_policy_maintenance_settings.window_start`.
 *
 * That column is recurrence-discriminated: for `once` it holds a full
 * ISO-8601 local datetime, and for `daily`/`weekly`/`monthly` it holds an
 * "HH:MM" time of day. A *naive* datetime is accepted for the recurring
 * cadences too, using only its time component, so a policy switched from
 * `once` keeps a sensible anchor instead of jumping to midnight.
 *
 * A datetime carrying `Z` or a numeric offset is rejected rather than read
 * digit-for-digit: it names an instant, and treating its UTC hour as local
 * wall-clock time would shift the window by the zone's offset invisibly.
 *
 * Returns `'invalid'` for a value that parses as none of these — the caller
 * warns and falls back to midnight rather than treating the window as never
 * open.
 */
function parseRecurringWindowAnchor(
  rawWindowStart: string | null
): { hours: number; minutes: number } | 'invalid' {
  const value = (rawWindowStart ?? '').trim();
  // Absent is not a defect: every pre-#4224 recurring row has window_start
  // NULL and must keep the midnight schedule it has been running on.
  if (value === '') return MIDNIGHT_ANCHOR;
  if (EXPLICIT_UTC_OFFSET_PATTERN.test(value)) return 'invalid';

  const match = TIME_OF_DAY_PATTERN.exec(value) ?? DATETIME_TIME_PATTERN.exec(value);
  if (!match) return 'invalid';

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return 'invalid';
  return { hours, minutes };
}

/**
 * Determines whether a maintenance window is currently active based on
 * the recurrence pattern, duration, and timezone.
 *
 * Recurrence values (all times in the configured timezone):
 *   - 'once'    — window starts at the `windowStart` datetime
 *   - 'daily'   — window starts every day at the `windowStart` time of day
 *   - 'weekly'  — window starts every Sunday at the `windowStart` time of day
 *   - 'monthly' — window starts on the 1st of each month at the `windowStart` time of day
 *
 * Recurring cadences fall back to 00:00 when no `windowStart` is stored, which
 * is what every recurring window did before issue #4224.
 *
 * The window lasts for `durationHours` from the start time. Because the start
 * time may sit late in its period, the evaluated occurrence is the most recent
 * one at or before `now` — a 23:00 daily window is still open at 00:30 the
 * next morning.
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
    windowEndsAt: null,
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

  // Lazily resolved so the `once` branch — which reads windowStart as a full
  // datetime — never warns about a value that is valid for its own recurrence.
  const resolveRecurringAnchor = (): { hours: number; minutes: number } => {
    const anchor = parseRecurringWindowAnchor(settings.windowStart);
    if (anchor === 'invalid') {
      console.warn(
        `[FeatureConfigResolver] Unparseable maintenance windowStart "${settings.windowStart}" for ` +
          `'${settings.recurrence}' recurrence; anchoring the window to midnight`
      );
      return MIDNIGHT_ANCHOR;
    }
    return anchor;
  };

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
      // Window starts at the configured time of day, every day. If today's
      // occurrence has not begun yet, yesterday's may still be running.
      const { hours, minutes } = resolveRecurringAnchor();
      windowStart = new Date(localNow);
      windowStart.setHours(hours, minutes, 0, 0);
      if (windowStart > localNow) {
        windowStart.setDate(windowStart.getDate() - 1);
      }
      break;
    }
    case 'weekly': {
      // Window starts at the configured time of day on Sunday. If this
      // Sunday's occurrence has not begun yet, last Sunday's may still run.
      const { hours, minutes } = resolveRecurringAnchor();
      windowStart = new Date(localNow);
      windowStart.setDate(windowStart.getDate() - windowStart.getDay()); // 0 = Sunday
      windowStart.setHours(hours, minutes, 0, 0);
      if (windowStart > localNow) {
        windowStart.setDate(windowStart.getDate() - 7);
      }
      break;
    }
    case 'monthly': {
      // Window starts at the configured time of day on the 1st. If this
      // month's occurrence has not begun yet, last month's may still run.
      const { hours, minutes } = resolveRecurringAnchor();
      windowStart = new Date(localNow);
      windowStart.setDate(1);
      windowStart.setHours(hours, minutes, 0, 0);
      if (windowStart > localNow) {
        // Safe to roll the month back: the day is pinned to the 1st, so there
        // is no short-month overflow.
        windowStart.setMonth(windowStart.getMonth() - 1);
      }
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
    // windowStart/windowEnd/localNow all live in the same "wall clock rendered
    // as UTC" space, so their difference is a real duration even though none of
    // them is a real instant. Projecting the remaining time off `currentTime`
    // is what turns it back into one.
    windowEndsAt: new Date(currentTime.getTime() + (windowEnd.getTime() - localNow.getTime())),
  };
}

/**
 * Check if a device is currently in a maintenance window (from config policy).
 * Returns the maintenance window status, or inactive if no maintenance policy applies.
 */
export async function checkDeviceMaintenanceWindow(deviceId: string): Promise<MaintenanceWindowStatus> {
  const settings = await resolveMaintenanceConfigForDevice(deviceId);
  if (!settings) {
    return { active: false, suppressAlerts: false, suppressPatching: false, suppressAutomations: false, suppressScripts: false, rebootIfPending: false, windowEndsAt: null };
  }
  return isInMaintenanceWindow(settings);
}
