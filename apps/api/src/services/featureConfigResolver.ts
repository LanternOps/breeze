import { db } from '../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
  devices,
  organizations,
  deviceGroupMemberships,
} from '../db/schema';
import { and, eq, sql, inArray, asc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { TokenPayload } from './jwt';

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
}

async function loadDeviceHierarchy(deviceId: string): Promise<DeviceHierarchy | null> {
  // 1. Load device
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
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
  };
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
        eq(configurationPolicies.status, 'active')
      )
    )
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'alert_rule')
      )
    )
    .innerJoin(
      configPolicyAlertRules,
      eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
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
        eq(configurationPolicies.status, 'active')
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
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
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
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);

  const rows = await db
    .select({
      patchSettings: configPolicyPatchSettings,
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
        eq(configurationPolicies.status, 'active')
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
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt
    );

  if (rows.length === 0) return null;

  const sorted = sortByHierarchy(rows);
  return sorted[0]!.patchSettings;
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
        eq(configurationPolicies.status, 'active')
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
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
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
        eq(configurationPolicies.status, 'active')
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
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`)
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

// ============================================
// Batch Scan Helpers (for workers)
// ============================================

export interface ScheduledAutomationWithTarget {
  automation: typeof configPolicyAutomations.$inferSelect;
  assignmentLevel: string;
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
// Maintenance Window Helper
// ============================================

export interface MaintenanceWindowStatus {
  active: boolean;
  suppressAlerts: boolean;
  suppressPatching: boolean;
  suppressAutomations: boolean;
  suppressScripts: boolean;
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
  };
}

/**
 * Check if a device is currently in a maintenance window (from config policy).
 * Returns the maintenance window status, or inactive if no maintenance policy applies.
 */
export async function checkDeviceMaintenanceWindow(deviceId: string): Promise<MaintenanceWindowStatus> {
  const settings = await resolveMaintenanceConfigForDevice(deviceId);
  if (!settings) {
    return { active: false, suppressAlerts: false, suppressPatching: false, suppressAutomations: false, suppressScripts: false };
  }
  return isInMaintenanceWindow(settings);
}
