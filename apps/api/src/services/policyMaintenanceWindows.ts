/**
 * Configuration-policy maintenance windows as a LIST (#10409).
 *
 * Maintenance windows are authored only through configuration policies
 * (`manage_policy_feature_link` featureType "maintenance"); the standalone
 * `maintenance_windows` table is legacy. `manage_maintenance_windows` used to
 * read only that legacy table, so a fleet whose windows all come from, say, a
 * partner-wide "Default Workstation Policy" listed nothing at all.
 *
 * This reader answers "which policies carry a maintenance window, on what
 * schedule, and when does it next open" for the policies the caller can see:
 *
 *  - Visibility is `policyAccessCondition` — the same dual-axis reader
 *    `list_configuration_policies` and the HTTP list route use (org-owned
 *    policies in the caller's orgs, plus the caller's partner-wide policies at
 *    partner scope). Nothing here widens it.
 *  - Settings come through `config_policy_effective_feature_links` (the view),
 *    so a child policy that inherits its parent's window lists it, flagged with
 *    the authoring policy — exactly what the resolver applies to devices.
 *  - Only ACTIVE policies: resolution ignores the rest.
 *  - The schedule is projected with the resolver's own recurrence arithmetic
 *    (`isInMaintenanceWindow` / `projectNextConfigPolicyWindow`), so "open now"
 *    and "next window" can never disagree with what suppresses devices.
 *  - Site axis (app-layer, RLS does not defend it): each assignment is mapped
 *    to the legacy window target shape and run through
 *    `filterWindowsToSiteScope` — the same intersection rule the legacy list
 *    uses. A site-restricted caller sees a policy only when at least one of its
 *    assignments reaches their sites, and sees only those assignments.
 *  - Assignment target ids are never returned (level + role/OS filters only);
 *    `get_configuration_policy` is the detail surface.
 *
 * A policy window is a DEFINITION, not a per-device verdict: a closer-level
 * assignment of another policy can override it for some devices
 * (device > group > site > org > partner). `get_effective_configuration`
 * answers "which window governs this device".
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyMaintenanceSettings,
  configurationPolicies,
  organizations,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { policyAccessCondition } from './configurationPolicy';
import { isInMaintenanceWindow } from './featureConfigResolver';
import { filterWindowsToSiteScope, type MaintenanceWindowTarget } from './maintenanceSiteScope';
import { projectNextConfigPolicyWindow } from './maintenanceWindowProjection';

/** Upper bound on policies read per call, before the site filter narrows them. */
const MAX_SCAN = 500;
/** Assignments listed per policy; `assignmentCount` always carries the full visible count. */
const MAX_ASSIGNMENTS_SHOWN = 20;

export interface PolicyMaintenanceWindowAssignment {
  level: string;
  roleFilter: string[] | null;
  osFilter: string[] | null;
}

export interface PolicyMaintenanceWindow {
  source: 'config_policy';
  configPolicyId: string;
  policyName: string;
  /** `partner_wide` = owned by the partner (org_id NULL), reaches every org it is assigned into. */
  policyScope: 'partner_wide' | 'organization';
  orgId: string | null;
  orgName: string | null;
  /** Set when the window is inherited from a parent policy rather than authored on this one. */
  inheritedFromPolicyId: string | null;
  recurrence: string;
  windowStart: string | null;
  durationHours: number;
  timezone: string;
  suppressAlerts: boolean;
  suppressPatching: boolean;
  suppressAutomations: boolean;
  suppressScripts: boolean;
  rebootIfPending: boolean;
  activeNow: boolean;
  /** The current (if open) or next occurrence within 30 days; null when none. */
  nextWindow: { startsAt: string; endsAt: string } | null;
  assignmentCount: number;
  assignments: PolicyMaintenanceWindowAssignment[];
}

export interface ListPolicyMaintenanceWindowsOptions {
  limit: number;
  now?: Date;
  /** Keep only windows open at `now`. */
  activeOnly?: boolean;
}

type AssignmentRow = {
  configPolicyId: string;
  level: string;
  targetId: string;
  roleFilter: string[] | null;
  osFilter: string[] | null;
};

type AssignmentTarget = MaintenanceWindowTarget & { assignment: AssignmentRow };

function assignmentAsWindowTarget(orgId: string | null, assignment: AssignmentRow): AssignmentTarget {
  const { level, targetId } = assignment;
  return {
    orgId,
    // Partner- and organization-level assignments reach every site beneath them.
    targetType: level === 'partner' || level === 'organization' ? 'all' : level,
    siteIds: level === 'site' ? [targetId] : null,
    groupIds: level === 'device_group' ? [targetId] : null,
    deviceIds: level === 'device' ? [targetId] : null,
    assignment,
  };
}

export async function listPolicyMaintenanceWindows(
  auth: Pick<AuthContext, 'allowedSiteIds'> & Parameters<typeof policyAccessCondition>[0],
  options: ListPolicyMaintenanceWindowsOptions,
): Promise<{ windows: PolicyMaintenanceWindow[]; truncated: boolean }> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit);
  const restricted = auth.allowedSiteIds !== undefined;

  const conditions: SQL[] = [eq(configurationPolicies.status, 'active')];
  const access = policyAccessCondition(auth);
  if (access) conditions.push(access);

  // Read one past the limit to report truncation; a site-restricted caller (or
  // an activeOnly read) scans wider because filtering happens after the read.
  const scanLimit = restricted || options.activeOnly ? MAX_SCAN : limit + 1;
  const rows = await db
    .select({
      configPolicyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
      orgName: organizations.name,
      sourcePolicyId: configPolicyEffectiveFeatureLinks.sourcePolicyId,
      inherited: configPolicyEffectiveFeatureLinks.inherited,
      settings: configPolicyMaintenanceSettings,
    })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'maintenance'),
      ),
    )
    .innerJoin(
      configPolicyMaintenanceSettings,
      eq(configPolicyMaintenanceSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id),
    )
    .leftJoin(organizations, eq(organizations.id, configurationPolicies.orgId))
    .where(and(...conditions))
    .orderBy(asc(configurationPolicies.name), asc(configurationPolicies.id))
    .limit(scanLimit);

  if (rows.length === 0) return { windows: [], truncated: false };

  const assignmentRows: AssignmentRow[] = await db
    .select({
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, rows.map((r) => r.configPolicyId)))
    .orderBy(asc(configPolicyAssignments.level), asc(configPolicyAssignments.priority));

  const orgIdByPolicy = new Map(rows.map((r) => [r.configPolicyId, r.orgId]));
  const visibleAssignments = await filterWindowsToSiteScope(
    assignmentRows.map((a) => assignmentAsWindowTarget(orgIdByPolicy.get(a.configPolicyId) ?? null, a)),
    { allowedSiteIds: auth.allowedSiteIds },
  );
  const assignmentsByPolicy = new Map<string, AssignmentRow[]>();
  for (const { assignment } of visibleAssignments) {
    const list = assignmentsByPolicy.get(assignment.configPolicyId) ?? [];
    list.push(assignment);
    assignmentsByPolicy.set(assignment.configPolicyId, list);
  }

  const windows: PolicyMaintenanceWindow[] = [];
  for (const row of rows) {
    const assignments = assignmentsByPolicy.get(row.configPolicyId) ?? [];
    // A site-restricted caller sees only windows that reach their sites; an
    // unassigned policy reaches nobody's.
    if (restricted && assignments.length === 0) continue;

    const activeNow = isInMaintenanceWindow(row.settings, now).active;
    if (options.activeOnly && !activeNow) continue;

    const next = projectNextConfigPolicyWindow(row.settings, now);
    const s = row.settings;
    windows.push({
      source: 'config_policy',
      configPolicyId: row.configPolicyId,
      policyName: row.policyName,
      policyScope: row.orgId === null ? 'partner_wide' : 'organization',
      orgId: row.orgId,
      orgName: row.orgName ?? null,
      inheritedFromPolicyId: row.inherited ? row.sourcePolicyId : null,
      recurrence: s.recurrence,
      windowStart: s.windowStart,
      durationHours: s.durationHours,
      timezone: s.timezone,
      suppressAlerts: s.suppressAlerts,
      suppressPatching: s.suppressPatching,
      suppressAutomations: s.suppressAutomations,
      suppressScripts: s.suppressScripts,
      rebootIfPending: s.rebootIfPending,
      activeNow,
      nextWindow: next ? { startsAt: next.startsAt.toISOString(), endsAt: next.endsAt.toISOString() } : null,
      assignmentCount: assignments.length,
      assignments: assignments.slice(0, MAX_ASSIGNMENTS_SHOWN).map(({ level, roleFilter, osFilter }) => ({
        level,
        roleFilter: roleFilter ?? null,
        osFilter: osFilter ?? null,
      })),
    });
  }

  return {
    windows: windows.slice(0, limit),
    truncated: windows.length > limit || rows.length >= scanLimit,
  };
}
