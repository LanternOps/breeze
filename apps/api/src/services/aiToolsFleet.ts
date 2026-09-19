/**
 * AI Fleet Orchestration Tools
 *
 * Fleet-level MCP tools for managing deployments, patches,
 * groups, maintenance windows, automations, alert rules, service monitors, and reports.
 * Each tool wraps existing DB schema and service logic with org-scoped isolation.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db';
import { pgErrorCode } from '../utils/pgErrors';
import {
  automationPolicies,
  automationPolicyCompliance,
  automations,
  automationRuns,
} from '../db/schema/automations';
import {
  deployments,
  deploymentDevices,
} from '../db/schema/deployments';
import {
  patches,
  patchApprovals,
  patchPolicies,
  devicePatches,
  patchJobs,
  patchRollbacks,
  patchComplianceSnapshots,
} from '../db/schema/patches';
import {
  deviceGroups,
  deviceGroupMemberships,
  groupMembershipLog,
} from '../db/schema/devices';
import {
  maintenanceWindows,
  maintenanceOccurrences,
} from '../db/schema/maintenance';
import {
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
} from '../db/schema/alerts';
import {
  configurationPolicies,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
} from '../db/schema/configurationPolicies';
import {
  addFeatureLink,
  updateFeatureLink,
  policyAccessCondition,
} from './configurationPolicy';
import {
  reports,
  reportRuns,
} from '../db/schema/reports';
import { devices, sites } from '../db/schema';
import { schedulePeripheralPolicyDevice } from '../jobs/peripheralJobs';
import { eq, and, desc, sql, inArray, gte, lte, isNull, or, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

async function scheduleAiGroupPeripheralReconciliation(deviceIds: readonly string[]): Promise<void> {
  await Promise.all([...new Set(deviceIds)].map((deviceId) =>
    schedulePeripheralPolicyDevice(deviceId, 'ai_group_membership_changed').catch((error) => {
      console.error(`[aiToolsFleet] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
    })
  ));
}
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';
import type { UserPermissions } from './permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { filterWindowsToSiteScope, scopeWindowForRead } from './maintenanceSiteScope';
import {
  deviceSiteDenied,
  deviceIdSiteDenied,
  deviceScopeCondition,
  filterToDeviceScope,
  resolveSiteAllowedDeviceIds,
  SITE_SCOPE_EMPTY_NOTE,
} from './aiToolsSiteScope';
import {
  checkAutomationTargetsWithinSiteScope,
  resolveAutomationTargetDeviceIds,
} from './automationRuntime';
import { scanProjectedAutomationRuns } from './automationReadProjection';
import { assertReportExecutionPreflight } from './reportGenerationService';
import { deleteDeviceGroup, DeviceGroupDeleteError } from './deviceGroupDelete';
import {
  decodeSiteScope,
  intersectSiteScopes,
  isSiteScopeSubset,
  persistedSiteScopeValues,
  reportDefinitionMultiOrgScopeSqlPredicate,
  reportDefinitionScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  unrestrictedReportDefinitionScopeSqlPredicate,
  type LiveSiteScopeV1,
  type PersistedSiteScopeColumns,
  type ReportAction,
  type ReportExecutionAuthority,
  type UserReportExecutionAuthority,
} from './siteScope';
import { upsertPatchApproval, resolvePartnerIdForOrg, declineAllRingApprovals } from '../routes/patches/helpers';
import { sanitizeThrownToolError } from './aiToolErrors';
import { listFleetFindings } from './fleetFindings/query';
import {
  AI_TRIAGE_SYSTEM_MANAGED_ERROR_CODE,
  MANAGED_AUTOMATION_ERROR_CODE,
  containsAiTriageAction,
  isManagedAutomation,
  managedAutomationOwnerIsLive,
} from './aiAgents/managedAutomation';
import { MANAGED_BY_MONITOR_ERROR } from './monitors/managedRowGuard';
import type {
  FleetFindingKind,
  FleetFindingSeverity,
  FleetFindingStatus,
} from '../db/schema/fleetFindings';

type AiToolTier = 1 | 2 | 3 | 4;

type FleetHandler = (
  input: Record<string, unknown>,
  auth: AuthContext,
  context?: ToolExecutionContext,
) => Promise<string>;

/**
 * #6200: the shared refusal for a user-owned release (see
 * `USER_OWNED_RELEASE_ACTIONS` in `jobs/intentReleaseWorker.ts`) whose auth
 * and named approver disagree. The row this branch is about to create carries
 * a `users` FK, and who owns it is the one thing the branch must never get
 * wrong — so refuse rather than trust either side. Mirrors
 * `aiToolsTicketing.ts`'s `log_time_entry` guard exactly.
 */
function approverReleaseMismatch(auth: AuthContext, context: ToolExecutionContext | undefined): boolean {
  return !!context?.approverRelease && context.approverRelease.approverUserId !== auth.user.id;
}

// ============================================
// Helpers
// ============================================

function getOrgId(auth: AuthContext): string | null {
  return auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
}

function orgWhere(auth: AuthContext, orgIdCol: ReturnType<typeof sql.raw> | any): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

const aiReportDefinitionMetadataProjection = {
  id: reports.id,
  orgId: reports.orgId,
  executionScopeVersion: reports.executionScopeVersion,
  executionScopeKind: reports.executionScopeKind,
  executionScopeSiteIds: reports.executionScopeSiteIds,
  executionScopeUserId: reports.executionScopeUserId,
  executionScopeFingerprint: reports.executionScopeFingerprint,
  executionScopeCapturedAt: reports.executionScopeCapturedAt,
  executionScopePrincipalKind: reports.executionScopePrincipalKind,
};

const aiReportRunMetadataProjection = {
  id: reportRuns.id,
  reportId: reportRuns.reportId,
  orgId: reports.orgId,
  executionScopeVersion: reportRuns.executionScopeVersion,
  executionScopeKind: reportRuns.executionScopeKind,
  executionScopeSiteIds: reportRuns.executionScopeSiteIds,
  executionScopeUserId: reportRuns.executionScopeUserId,
  executionScopeFingerprint: reportRuns.executionScopeFingerprint,
  executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
  executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
};

export async function aiLiveReportAuthority(
  auth: AuthContext,
  orgId: string,
  action: ReportAction,
): Promise<
  (Omit<UserReportExecutionAuthority, 'scope'> & { scope: LiveSiteScopeV1 }) | null
> {
  const result = await resolveRequestReportAuthority(auth, orgId, action);
  if (!result.ok || result.authority.scope.kind === 'legacy_unscoped') return null;
  return result.authority as Omit<UserReportExecutionAuthority, 'scope'> & {
    scope: LiveSiteScopeV1;
  };
}

async function aiReportDefinitionAccess(
  auth: AuthContext,
  reportId: string,
  action: ReportAction,
) {
  const metadataConditions: SQL[] = [eq(reports.id, reportId)];
  const tenantCondition = orgWhere(auth, reports.orgId);
  if (tenantCondition) metadataConditions.push(tenantCondition);
  const [metadata] = await db
    .select(aiReportDefinitionMetadataProjection)
    .from(reports)
    .where(and(...metadataConditions))
    .limit(1);
  if (!metadata) return null;

  const authority = await aiLiveReportAuthority(auth, metadata.orgId, action);
  if (!authority) return null;
  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      metadata.orgId,
    );
    if (!isSiteScopeSubset(storedScope, authority.scope)) return null;
  } catch {
    return null;
  }

  const predicate = reportDefinitionScopeSqlPredicate(reports, authority.scope);
  const [report] = await db
    .select()
    .from(reports)
    .where(and(
      eq(reports.id, reportId),
      eq(reports.orgId, metadata.orgId),
      predicate,
    ))
    .limit(1);
  if (!report) return null;

  try {
    const storedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      report.orgId,
    );
    if (!isSiteScopeSubset(storedScope, authority.scope)) return null;
  } catch {
    return null;
  }
  return { report, authority, predicate };
}

async function aiReportRunAccess(
  auth: AuthContext,
  runId: string,
  action: ReportAction,
) {
  const metadataConditions: SQL[] = [eq(reportRuns.id, runId)];
  const tenantCondition = orgWhere(auth, reports.orgId);
  if (tenantCondition) metadataConditions.push(tenantCondition);
  const [metadata] = await db
    .select(aiReportRunMetadataProjection)
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(...metadataConditions))
    .limit(1);
  if (!metadata) return null;

  const authority = await aiLiveReportAuthority(auth, metadata.orgId, action);
  if (!authority) return null;
  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      metadata.orgId,
    );
    if (!isSiteScopeSubset(storedScope, authority.scope)) return null;
  } catch {
    return null;
  }
  return {
    metadata,
    authority,
    predicate: reportRunScopeSqlPredicate(reportRuns, authority.scope),
  };
}

/**
 * The device ids a report READ may cover: the report authority's site scope
 * INTERSECTED with the caller's frozen device set (#6096). A report authority
 * carries sites only, so without the intersection a run pinned to one device
 * aggregates every sibling in its site — and a device-LESS analysis run, whose
 * authority resolves to `unrestricted`, aggregates the whole org.
 *
 * `null` means "no narrowing at all" (unrestricted on both axes); an empty
 * array means "restricted, nothing in scope" and must never be collapsed into
 * `null` by a caller.
 */
async function aiAuthorityDeviceIds(
  orgId: string,
  authority: ReportExecutionAuthority,
  auth: AuthContext,
): Promise<string[] | null> {
  const frozen = auth.allowedDeviceIds ? new Set(auth.allowedDeviceIds) : null;
  if (authority.scope.kind === 'unrestricted') return frozen ? [...frozen] : null;
  if (authority.scope.kind !== 'restricted' || authority.scope.siteIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      inArray(devices.siteId, authority.scope.siteIds),
      deviceScopeCondition(auth, devices.id),
    ));
  return rows.map((row) => row.id);
}

// Dual-axis access for alert_rules (#2128): org-owned rules the caller can
// reach OR partner-wide rules (org_id NULL) owned by the caller's own partner.
function alertRuleWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, alertRules.orgId);
  if (!oc) return undefined; // system scope
  // Only partner-scope callers hold the partner axis — RLS's
  // breeze_has_partner_access is false for org-scope tokens even when they
  // carry a partnerId, so adding the branch for them would be dead code.
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${alertRules.orgId} IS NULL AND ${alertRules.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Dual-axis access for notification_channels (#2130): same shape as
// alertRuleWhere — org-owned channels the caller can reach OR partner-wide
// ones (org_id NULL) owned by the caller's own partner.
function notificationChannelWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, notificationChannels.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${notificationChannels.orgId} IS NULL AND ${notificationChannels.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Dual-axis access for maintenance_windows (#2131): same shape as
// alertRuleWhere — org-owned windows the caller can reach OR partner-wide
// ones (org_id NULL) owned by the caller's own partner.
function maintenanceWindowWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, maintenanceWindows.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${maintenanceWindows.orgId} IS NULL AND ${maintenanceWindows.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Dual-axis access for automation_policies (#2129): same shape as
// alertRuleWhere — org-owned compliance policies the caller can reach OR
// partner-wide ones (org_id NULL) owned by the caller's own partner.
function automationPolicyWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, automationPolicies.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${automationPolicies.orgId} IS NULL AND ${automationPolicies.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// Dual-axis access for automations (#2133): same shape as alertRuleWhere —
// org-owned automations the caller can reach OR partner-wide ones (org_id
// NULL) owned by the caller's own partner.
function automationWhere(auth: AuthContext): SQL | undefined {
  const oc = orgWhere(auth, automations.orgId);
  if (!oc) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${oc} OR (${automations.orgId} IS NULL AND ${automations.partnerId} = ${auth.partnerId}))`;
  }
  return oc;
}

// ============================================
// Site-axis helpers (app-layer authz — RLS does NOT enforce site)
// ============================================

/**
 * Denial for a run pinned to a frozen device set (`auth.allowedDeviceIds`)
 * that asked for something whose blast radius is the fleet — a partner-wide
 * patch approval, an automation that targets other devices, a deployment that
 * includes them. Fail CLOSED and say so: the model must be able to tell
 * "denied because of my binding" from "nothing matched".
 */
const DEVICE_SCOPE_FLEET_DENIED_MESSAGE =
  'This run is bound to a fixed set of devices and cannot act on the fleet.';

/**
 * Reports are authorized by SITE scope end to end (`siteScope.ts` persists
 * site ids onto the run row and the generator re-reads them), so there is no
 * device axis to intersect a frozen device set with. Producing one anyway
 * would hand the run every sibling device in its site.
 */
const DEVICE_SCOPE_REPORT_DENIED_MESSAGE =
  'This run is bound to a fixed set of devices; reports are scoped by site and cannot be generated or downloaded from it.';

/**
 * True when the caller is narrowed on EITHER app-layer axis. Used by fleet-wide
 * governance writes, which no narrowed caller may perform.
 * `canMutateOrgWideGovernance` alone is not enough here: it only speaks for
 * `scope === 'organization'` principals, so a partner-scope caller carrying a
 * site ceiling passes it.
 */
function isScopeNarrowedCaller(auth: AuthContext): boolean {
  return auth.allowedSiteIds !== undefined || auth.allowedDeviceIds !== undefined;
}

// Minimal UserPermissions view for the automation target helper, which reads
// only `allowedSiteIds`. Undefined lets that helper no-op for unrestricted callers.
function siteScopePerms(auth: AuthContext): UserPermissions | undefined {
  return auth.allowedSiteIds ? ({ allowedSiteIds: auth.allowedSiteIds } as UserPermissions) : undefined;
}

// Canonical alert site-scope condition (mirrors routes/alerts/alerts.ts:188-210).
// Returns null for unrestricted callers (no narrowing / no device leftJoin
// needed). For a restricted caller the query MUST leftJoin devices on
// alerts.deviceId; zero-site callers then see only device-less (org-wide) alerts.
function alertSiteCondition(auth: AuthContext): SQL | null {
  const parts: SQL[] = [];
  const allowed = auth.allowedSiteIds;
  if (allowed) {
    parts.push(allowed.length === 0
      ? isNull(alerts.deviceId)
      : (or(isNull(alerts.deviceId), inArray(devices.siteId, allowed)) as SQL));
  }
  // Exact-device axis (#6096) — ANDed on top, and independent of the site axis
  // (a device-LESS analysis run carries only this one). It also overrides the
  // `isNull(deviceId)` escape hatch above: a device-less org-wide alert is not
  // attributable to the run's device, and `deviceId IN (…)` is false for NULL,
  // so those alerts drop out for a device-bound caller by construction.
  const deviceScope = deviceScopeCondition(auth, alerts.deviceId);
  if (deviceScope) parts.push(deviceScope);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : (and(...parts) as SQL);
}

// Whether a site-restricted caller must be denied an alert rule based on its
// target. Rules are not RLS-site-scoped, so resolve the rule's target to
// site(s) and fail closed: org/partner-wide ('all') rules and unresolvable
// targets are hidden from site-restricted callers. Always allowed (false) for
// unrestricted callers.
async function alertRuleTargetDenied(
  auth: AuthContext,
  rule: { targetType: string; targetId: string },
): Promise<boolean> {
  // Both axes, read INDEPENDENTLY (#6096 C2). The old guard was
  // `!auth.allowedSiteIds || !auth.canAccessSite`, which (a) waved a device-LESS
  // analysis run — device axis, no site axis — through as unrestricted, and
  // (b) failed OPEN when `allowedSiteIds` was set but `canAccessSite` was not.
  // `deviceSiteDenied` already denies that second shape, so only the
  // genuinely-unrestricted caller short-circuits here.
  const siteRestricted = auth.allowedSiteIds !== undefined;
  const deviceRestricted = auth.allowedDeviceIds !== undefined;
  if (!siteRestricted && !deviceRestricted) return false;
  // Site- and group-shaped targets keep their site-only check: a rule is a
  // site-shaped fleet resource, and denying those on the device axis would make
  // every one of them unreachable for a device-bound run (#6096 D2). The alert
  // DATA a rule exposes is narrowed separately by `alertSiteCondition`, which
  // carries the device axis. An org-wide ('all') target has no site to check at
  // all and is denied for every narrowed caller by the default branch.
  switch (rule.targetType) {
    case 'site':
      return deviceSiteDenied(auth, rule.targetId);
    case 'device':
      return deviceIdSiteDenied(auth, rule.targetId);
    case 'group': {
      const [group] = await db
        .select({ siteId: deviceGroups.siteId })
        .from(deviceGroups)
        .where(eq(deviceGroups.id, rule.targetId))
        .limit(1);
      // Null-site (org-wide) or missing group → fail closed.
      return deviceSiteDenied(auth, group?.siteId ?? null);
    }
    default:
      // 'all' / org-wide / unknown target → exceeds a site-restricted caller.
      return true;
  }
}

/**
 * Narrow a list of rows carrying a `policyId` to the configuration policies
 * that actually reach this caller. No-op for a caller restricted on neither
 * app-layer axis (and no query is issued for one).
 *
 * Lookups are lazy and batched: the device/group SITE maps are only read when
 * the caller has no exact-device allowlist (with one, membership in it settles
 * the question and the device's site is the run's own by construction), and
 * group MEMBERSHIPS are only read when it does.
 */
async function narrowMonitorsToCallerReach<T extends { policyId: string | null }>(
  auth: AuthContext,
  rows: T[],
): Promise<T[]> {
  if (!auth.allowedSiteIds && !auth.allowedDeviceIds) return rows;
  const policyIds = [...new Set(rows.map((r) => r.policyId).filter((id): id is string => !!id))];
  if (policyIds.length === 0) return [];

  const assignments = await db
    .select({
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, policyIds));

  const exactDevices = auth.allowedDeviceIds ? new Set(auth.allowedDeviceIds) : null;
  const targetsAt = (level: string) =>
    [...new Set(assignments.filter((a) => a.level === level).map((a) => a.targetId))];

  const deviceSite = new Map<string, string | null>();
  const groupSite = new Map<string, string | null>();
  const groupMembers = new Map<string, string[]>();

  if (!exactDevices) {
    const deviceTargets = targetsAt('device');
    if (deviceTargets.length > 0) {
      for (const row of await db.select({ id: devices.id, siteId: devices.siteId })
        .from(devices).where(inArray(devices.id, deviceTargets))) {
        deviceSite.set(row.id, row.siteId);
      }
    }
    const groupTargets = targetsAt('device_group');
    if (groupTargets.length > 0) {
      for (const row of await db.select({ id: deviceGroups.id, siteId: deviceGroups.siteId })
        .from(deviceGroups).where(inArray(deviceGroups.id, groupTargets))) {
        groupSite.set(row.id, row.siteId);
      }
    }
  } else {
    const groupTargets = targetsAt('device_group');
    if (groupTargets.length > 0) {
      for (const row of await db.select({
        groupId: deviceGroupMemberships.groupId,
        deviceId: deviceGroupMemberships.deviceId,
      }).from(deviceGroupMemberships).where(inArray(deviceGroupMemberships.groupId, groupTargets))) {
        groupMembers.set(row.groupId, [...(groupMembers.get(row.groupId) ?? []), row.deviceId]);
      }
    }
  }

  // Site-shaped assignment targets — a `site` assignment, or a device group's
  // own site — have no device to name, so only the site axis applies. Funnelled
  // through ONE call so the exact-device contract test
  // (aiToolsDeviceGuard.contract.test.ts) has a single site-only entry to carry.
  const assignmentSiteDenied = (siteId: string | null): boolean => deviceSiteDenied(auth, siteId);

  const reaches = (a: { level: string; targetId: string }): boolean => {
    switch (a.level) {
      // Partner/org-wide policies apply to the caller's own device as well, so
      // they are not a disclosure of anyone else's configuration.
      case 'partner':
      case 'organization':
        return true;
      case 'site':
        return !assignmentSiteDenied(a.targetId);
      case 'device':
        return exactDevices
          ? exactDevices.has(a.targetId)
          : !deviceSiteDenied(auth, deviceSite.get(a.targetId) ?? null, a.targetId);
      case 'device_group':
        return exactDevices
          ? (groupMembers.get(a.targetId) ?? []).some((id) => exactDevices.has(id))
          : !assignmentSiteDenied(groupSite.get(a.targetId) ?? null);
      default:
        return false;
    }
  };

  const reachable = new Set(
    assignments.filter(reaches).map((a) => a.configPolicyId),
  );
  return rows.filter((r) => !!r.policyId && reachable.has(r.policyId));
}

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing.
 *
 *  #6200: the third `context` argument is FORWARDED, not dropped. It used to
 *  be truncated here (the trap `services/aiTools.ts`'s `CoreAiTool.handler`
 *  doc calls out by name), which meant the user-owned-release branches below
 *  could not see `context.approverRelease` at all and so could not refuse a
 *  release whose auth and named approver disagree. */
function safeHandler(toolName: string, fn: FleetHandler): FleetHandler {
  return async (input, auth, context) => {
    try {
      return await fn(input, auth, context);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal error';
      const code = pgErrorCode(err);
      console.error(`[fleet:${toolName}]`, input.action, message, err);

      // Surface specific DB constraint errors instead of generic "Operation failed"
      if (code === '23503') return JSON.stringify({ error: `Referenced record not found — a required ID (template, device, policy, etc.) does not exist or was deleted.` });
      if (code === '23505') return JSON.stringify({ error: `Duplicate entry — a record with this name or key already exists.` });
      if (code === '22P02') return JSON.stringify({ error: `Invalid ID format — expected a valid UUID.` });
      // Fail closed: anything else may embed the query/column list (#2603).
      return JSON.stringify({
        error: sanitizeThrownToolError(`fleet:${toolName}`, err, { action: input.action }),
      });
    }
  };
}

// ============================================
// get_fleet_findings helpers
// ============================================
//
// Mirrors the validation constants in routes/fleetFindings.ts (kept local
// here rather than imported — a service importing a route module would be
// the wrong dependency direction). The actual scoping/site-filtering logic
// is NOT duplicated: it lives solely in services/fleetFindings/query.ts's
// `listFleetFindings`, which this tool calls directly, per CLAUDE.md's
// warning about AI-tool/route dual-map drift. Keep these value lists in
// sync with routes/fleetFindings.ts's KIND_VALUES/SEVERITY_VALUES/STATUS_VALUES.

/**
 * Annotation for a deployment page that a site/device-restricted caller had rows
 * removed from (or that came back empty while the caller is restricted). Without
 * it an empty page is indistinguishable from "this organization runs no
 * deployments", which the model then reports as fact.
 */
const DEPLOYMENT_SITE_SCOPE_PARTIAL_NOTE =
  'Some deployments were withheld because they reach devices outside your site access — this list may be incomplete.';

const FLEET_FINDING_KIND_VALUES = ['metric_anomaly_pattern', 'log_correlation', 'reliability_offenders'] as const;
const FLEET_FINDING_SEVERITY_VALUES = ['info', 'warning', 'error', 'critical'] as const;
const FLEET_FINDING_STATUS_VALUES = ['open', 'acknowledged', 'dismissed', 'resolved'] as const;
const FLEET_FINDING_STATUS_SET = new Set<string>(FLEET_FINDING_STATUS_VALUES);
const DEFAULT_FLEET_FINDING_STATUSES: FleetFindingStatus[] = ['open', 'acknowledged'];

/** `status=open,acknowledged` CSV -> validated array, or `null` on an unknown value. */
function parseFleetFindingStatusCsv(raw: string | undefined): FleetFindingStatus[] | null {
  if (!raw) return [...DEFAULT_FLEET_FINDING_STATUSES];
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return [...DEFAULT_FLEET_FINDING_STATUSES];
  for (const item of items) {
    if (!FLEET_FINDING_STATUS_SET.has(item)) return null;
  }
  return items as FleetFindingStatus[];
}

// ============================================
// Register all fleet tools into the aiTools Map
// ============================================

export function registerFleetTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. manage_deployments — Staged rollout control
  // ============================================

  registerTool({
    tier: 1,
    domain: 'patching',
    searchHint: 'software deployments: list, get, device status, create, start, pause, resume, cancel',
    definition: {
      name: 'manage_deployments',
      description: 'Manage staged software deployments: list, get details, view per-device status, create, start, pause, resume, or cancel deployments.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'device_status', 'create', 'start', 'pause', 'resume', 'cancel'], description: 'The action to perform' },
          deploymentId: { type: 'string', description: 'Deployment UUID (required for get/device_status/start/pause/resume/cancel)' },
          status: { type: 'string', enum: ['draft', 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'], description: 'Filter by status (for list)' },
          name: { type: 'string', description: 'Deployment name (for create)' },
          type: { type: 'string', description: 'Deployment type (for create)' },
          payload: { type: 'object', description: 'Deployment payload (for create)' },
          targetType: { type: 'string', description: 'Target type: device, group, filter, all (for create)' },
          targetConfig: { type: 'object', description: 'Target configuration (for create)' },
          rolloutConfig: { type: 'object', description: 'Rollout configuration: batch size, failure threshold (for create)' },
          schedule: { type: 'object', description: 'Schedule configuration (for create)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_deployments', async (input, auth, context) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      // Deployments have no siteId column — gate site-restricted callers via
      // their member devices (mirrors routes/deployments.ts:760-766). Control
      // actions affect ALL member devices, so deny if the deployment includes
      // ANY out-of-site device (fail closed). Unrestricted callers: always false.
      // Batched form: ONE membership query for any number of deployments, so
      // `list` never degenerates into an N+1 for a restricted caller. Returns
      // the subset of `deploymentIds` the caller must not reach; an empty set
      // (and zero queries) for an unrestricted caller.
      const deniedDeploymentIds = async (deploymentIds: string[]): Promise<Set<string>> => {
        if (!auth.allowedSiteIds && !auth.allowedDeviceIds) return new Set();
        if (deploymentIds.length === 0) return new Set();
        const members = await db.select({
          deploymentId: deploymentDevices.deploymentId,
          deviceId: deploymentDevices.deviceId,
          siteId: devices.siteId,
        })
          .from(deploymentDevices)
          .leftJoin(devices, eq(deploymentDevices.deviceId, devices.id))
          .where(inArray(deploymentDevices.deploymentId, deploymentIds));
        const denied = new Set<string>();
        const seen = new Set<string>();
        // Three arguments, not two (#6096): the member IS a device, so the
        // exact-device axis applies — a device-bound run shares its site with
        // every sibling, and site alone would wave them through. `?? null`
        // keeps an unresolvable member failing closed for such a run.
        for (const m of members) {
          seen.add(m.deploymentId);
          if (deviceSiteDenied(auth, m.siteId, m.deviceId ?? null)) denied.add(m.deploymentId);
        }
        // A deployment with NO member rows produced no evidence either way, so
        // the denied set stayed empty and it was visible and CONTROLLABLE by a
        // restricted caller (fail-OPEN). An unattributable resource is denied
        // to a restricted caller — the same rule the SLA and browser-policy
        // gates apply to an empty target list.
        for (const id of deploymentIds) {
          if (!seen.has(id)) denied.add(id);
        }
        return denied;
      };

      const deploymentSiteDenied = async (deploymentId: string): Promise<boolean> =>
        (await deniedDeploymentIds([deploymentId])).has(deploymentId);

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.status === 'string') conditions.push(eq(deployments.status, input.status as any));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        // The site filter below lands AFTER the SQL LIMIT, so a restricted
        // caller whose newest deployments are all out of scope got an empty (or
        // short) page while reachable older ones existed — and the model reads
        // an empty page as "none exist". Over-scan a wider, still-bounded page
        // and slice after filtering, exactly as `manage_maintenance_windows`
        // does in this file.
        const restricted = Boolean(auth.allowedSiteIds || auth.allowedDeviceIds);
        const scanLimit = restricted ? Math.min(Math.max(limit * 5, 100), 500) : limit;
        const rows = await db.select({
          id: deployments.id,
          name: deployments.name,
          type: deployments.type,
          status: deployments.status,
          targetType: deployments.targetType,
          createdAt: deployments.createdAt,
          startedAt: deployments.startedAt,
          completedAt: deployments.completedAt,
        }).from(deployments)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(deployments.createdAt))
          .limit(scanLimit);

        // Deployments are site-attributable through their member devices, so a
        // site-restricted caller must not even see the metadata of a deployment
        // that reaches a device outside their sites (audit §1.1). Batched: one
        // extra query for a restricted caller, zero for an unrestricted one.
        const denied = await deniedDeploymentIds(rows.map((r) => r.id));
        const filtered = denied.size > 0 ? rows.filter((r) => !denied.has(r.id)) : rows;
        const visible = filtered.slice(0, limit);
        // Tell the model the page was narrowed, so a short/empty result is not
        // reported back as "this organization has no deployments".
        const dropped = restricted && (denied.size > 0 || rows.length > filtered.length);

        return JSON.stringify({
          deployments: visible,
          showing: visible.length,
          ...(dropped || (restricted && visible.length === 0)
            ? { scopeNote: DEPLOYMENT_SITE_SCOPE_PARTIAL_NOTE }
            : {}),
        });
      }

      if (action === 'get') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        // Same gate the control actions carry: the progress counts below
        // aggregate over EVERY member device, so they are unattributable for a
        // caller who cannot reach all of them (audit §1.1).
        if (await deploymentSiteDenied(dep.id)) return JSON.stringify({ error: 'Deployment not found or access denied' });

        // Get progress stats
        const stats = await db.select({
          total: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'pending')`,
          running: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'running')`,
          completed: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'completed')`,
          failed: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'failed')`,
          skipped: sql<number>`count(*) filter (where ${deploymentDevices.status} = 'skipped')`,
        }).from(deploymentDevices)
          .where(eq(deploymentDevices.deploymentId, dep.id));

        return JSON.stringify({ deployment: dep, progress: stats[0] });
      }

      if (action === 'device_status') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        // Site axis (app-layer only; RLS does NOT enforce it): a site-restricted
        // caller may only see per-device rows for devices in their allowed sites.
        const dsConditions: SQL[] = [eq(deploymentDevices.deploymentId, dep.id)];
        if (auth.allowedSiteIds) {
          if (auth.allowedSiteIds.length === 0) {
            return JSON.stringify({ deploymentId: dep.id, devices: [], showing: 0 });
          }
          dsConditions.push(inArray(devices.siteId, auth.allowedSiteIds));
        }
        // Exact-device axis, applied whether or not the site axis is set.
        const dsDeviceScope = deviceScopeCondition(auth, deploymentDevices.deviceId);
        if (dsDeviceScope) dsConditions.push(dsDeviceScope);
        const rows = await db.select({
          deviceId: deploymentDevices.deviceId,
          hostname: devices.hostname,
          status: deploymentDevices.status,
          batchNumber: deploymentDevices.batchNumber,
          retryCount: deploymentDevices.retryCount,
          startedAt: deploymentDevices.startedAt,
          completedAt: deploymentDevices.completedAt,
        }).from(deploymentDevices)
          .leftJoin(devices, eq(deploymentDevices.deviceId, devices.id))
          .where(and(...dsConditions))
          .limit(limit);

        return JSON.stringify({ deploymentId: dep.id, devices: rows, showing: rows.length });
      }

      if (action === 'create') {
        // #6200: `deployments.created_by` below is a `users` FK. An
        // agent-originated intent is released as the APPROVER
        // (USER_OWNED_RELEASE_ACTIONS), so the two must agree.
        if (approverReleaseMismatch(auth, context)) {
          return JSON.stringify({ error: 'approver_auth_mismatch', action });
        }
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [dep] = await db.insert(deployments).values({
          orgId,
          name: input.name as string,
          type: input.type as string,
          payload: input.payload as Record<string, unknown>,
          targetType: input.targetType as string,
          targetConfig: input.targetConfig as Record<string, unknown>,
          rolloutConfig: input.rolloutConfig as Record<string, unknown>,
          schedule: (input.schedule as Record<string, unknown>) ?? null,
          status: 'draft',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, deploymentId: dep?.id, name: dep?.name });
      }

      if (action === 'start') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (await deploymentSiteDenied(dep.id)) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (!['draft', 'pending'].includes(dep.status)) return JSON.stringify({ error: `Cannot start deployment in ${dep.status} status` });

        await db.update(deployments)
          .set({ status: 'running', startedAt: new Date() })
          .where(eq(deployments.id, dep.id));

        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" started` });
      }

      if (action === 'pause') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (await deploymentSiteDenied(dep.id)) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (dep.status !== 'running') return JSON.stringify({ error: `Cannot pause deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'paused' }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" paused` });
      }

      if (action === 'resume') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (await deploymentSiteDenied(dep.id)) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (dep.status !== 'paused') return JSON.stringify({ error: `Cannot resume deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" resumed` });
      }

      if (action === 'cancel') {
        if (!input.deploymentId) return JSON.stringify({ error: 'deploymentId is required' });
        const conditions: SQL[] = [eq(deployments.id, input.deploymentId as string)];
        const oc = orgWhere(auth, deployments.orgId);
        if (oc) conditions.push(oc);

        const [dep] = await db.select().from(deployments).where(and(...conditions)).limit(1);
        if (!dep) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (await deploymentSiteDenied(dep.id)) return JSON.stringify({ error: 'Deployment not found or access denied' });
        if (['completed', 'cancelled'].includes(dep.status)) return JSON.stringify({ error: `Cannot cancel deployment in ${dep.status} status` });

        await db.update(deployments).set({ status: 'cancelled', completedAt: new Date() }).where(eq(deployments.id, dep.id));
        return JSON.stringify({ success: true, message: `Deployment "${dep.name}" cancelled` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 3. manage_patches — Patch scanning, approval, installation
  // ============================================

  // Resolves the patchId to act on: the caller's explicit patchId if given,
  // otherwise a lookup by title/KB (external id) among patches actually
  // present on this org's fleet (mirrors action:'list' scoping, so a name
  // can't resolve to a patch this org has never seen). #5585: the AI could
  // only decline by UUID, which the model has no way to know without reading
  // page HTML — this closes that gap for approve/decline/defer.
  async function resolveManagePatchesPatchId(
    orgId: string,
    input: Record<string, unknown>
  ): Promise<{ patchId: string } | { error: string }> {
    if (typeof input.patchId === 'string' && input.patchId) {
      return { patchId: input.patchId };
    }
    const patchName = typeof input.patchName === 'string' ? input.patchName.trim() : '';
    if (!patchName) {
      return { error: 'patchId or patchName is required' };
    }

    const rows = await db
      .selectDistinct({ id: patches.id, title: patches.title, externalId: patches.externalId })
      .from(patches)
      .innerJoin(devicePatches, eq(devicePatches.patchId, patches.id))
      .where(and(
        eq(devicePatches.orgId, orgId),
        or(
          sql`${patches.title} ILIKE ${`%${patchName}%`}`,
          eq(patches.externalId, patchName),
        ),
      ))
      .orderBy(desc(patches.createdAt))
      .limit(6);

    if (rows.length === 0) {
      return { error: `No patch found matching "${patchName}" on this organization's fleet` };
    }
    if (rows.length > 1) {
      const exact = rows.filter((r) => r.title.toLowerCase() === patchName.toLowerCase() || r.externalId === patchName);
      if (exact.length === 1) return { patchId: exact[0]!.id };
      return {
        error: `Ambiguous patch name "${patchName}" (${rows.length} matches: ${rows.map((r) => r.title).join('; ')}). Use patchId instead.`,
      };
    }
    return { patchId: rows[0]!.id };
  }

  // Validates a ring UUID belongs to the resolved partner before it's used to
  // scope an approve/decline/defer. Mirrors resolvePatchApprovalPartnerIdForRing's
  // route-level check, but stays compatible with org-scoped AI callers (that
  // helper hard-rejects auth.scope === 'organization', which manage_patches
  // supports via resolvePartnerIdForOrg).
  async function resolveManagePatchesRingId(
    input: Record<string, unknown>,
    partnerId: string
  ): Promise<{ ringId: string | null } | { error: string }> {
    const ringId = typeof input.ringId === 'string' && input.ringId ? input.ringId : null;
    if (!ringId) return { ringId: null };

    const [ring] = await db
      .select({ partnerId: patchPolicies.partnerId })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, ringId))
      .limit(1);
    if (!ring) return { error: 'Update ring not found' };
    if (ring.partnerId !== partnerId) return { error: 'Access denied to this update ring' };
    return { ringId };
  }

  registerTool({
    tier: 1,
    domain: 'patching',
    searchHint: 'missing patches, KB approval, not CVEs: list, compliance, scan, approve, decline, defer, bulk approve, install, rollback',
    deviceArgs: ['deviceIds', 'deviceId'],
    definition: {
      name: 'manage_patches',
      description: 'Manage patches: list patches present on the org\'s devices (optionally scoped to a single device via deviceId, which also returns per-device install status), check compliance, trigger scans, approve/decline/defer patches, bulk approve, install on targets, or rollback. Required fields per action: install requires BOTH patchIds and deviceIds; scan requires deviceIds; bulk_approve requires patchIds; approve/decline/defer require patchId OR patchName; rollback requires BOTH patchId and deviceIds; list/compliance require none. approve/decline/defer accept an optional ringId to scope the action to one update ring (omit for the partner-wide blanket); decline also accepts allRings to revoke the approval in every update ring at once, not just the current scope — use this to fully unapprove a patch a device might otherwise still install under a different ring. To configure patch schedules and auto-approval policies, use manage_policy_feature_link with featureType "patch".',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'compliance', 'scan', 'approve', 'decline', 'defer', 'bulk_approve', 'install', 'rollback'], description: 'The action to perform. Required inputs: install needs patchIds AND deviceIds; scan needs deviceIds; bulk_approve needs patchIds; approve/decline/defer need patchId or patchName; rollback needs patchId AND deviceIds. To configure patch policies/auto-approval, use manage_policy_feature_link with featureType "patch".' },
          patchId: { type: 'string', description: 'Patch UUID. Required for approve/decline/defer/rollback unless patchName is given (rollback always needs the UUID).' },
          patchName: { type: 'string', description: 'Patch title or KB/external ID to look up when the UUID is unknown (for approve/decline/defer only). Matched against patches present on this org\'s fleet; an ambiguous match returns the candidates instead of guessing.' },
          patchIds: { type: 'array', items: { type: 'string' }, description: 'Patch UUIDs. Required for bulk_approve and install.' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs. Required for scan, install, and rollback.' },
          deviceId: { type: 'string', description: 'Single device UUID to scope the patch list to one device (for list); returns per-device install status' },
          ringId: { type: 'string', description: 'Update ring UUID to scope approve/decline/defer to one ring (for approve/decline/defer only; omit for the partner-wide blanket). Cannot be combined with allRings.' },
          allRings: { type: 'boolean', description: 'Decline only: revoke this patch\'s approval in every update ring for the partner, not just the current/blanket scope — use to fully unapprove a patch that was approved in more than one ring. Cannot be combined with ringId.' },
          source: { type: 'string', enum: ['microsoft', 'apple', 'linux', 'third_party', 'custom'], description: 'Filter by source' },
          severity: { type: 'string', enum: ['critical', 'important', 'moderate', 'low', 'unknown'], description: 'Filter by severity' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'deferred'], description: 'Filter by approval status' },
          deferUntil: { type: 'string', description: 'ISO date to defer until (for defer)' },
          notes: { type: 'string', description: 'Approval/decline notes' },
          configPolicyId: { type: 'string', description: 'Configuration policy UUID to attach patch settings to (for setup_auto_approval). If omitted, creates a new policy.' },
          autoApprove: { type: 'boolean', description: 'Enable auto-approval of patches (for setup_auto_approval)' },
          autoApproveSeverities: { type: 'array', items: { type: 'string', enum: ['critical', 'important', 'moderate', 'low'] }, description: 'Which severities to auto-approve (for setup_auto_approval)' },
          scheduleFrequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Patch scan frequency (for setup_auto_approval, default: weekly)' },
          scheduleTime: { type: 'string', description: 'Time to run scans in HH:MM format (for setup_auto_approval, default: 02:00)' },
          rebootPolicy: { type: 'string', enum: ['if_required', 'always', 'never'], description: 'Reboot policy after patching (for setup_auto_approval, default: if_required)' },
          sources: { type: 'array', items: { type: 'string', enum: ['os', 'third_party', 'custom'] }, description: 'Patch sources to include (for setup_auto_approval, default: ["os"])' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_patches', async (input, auth, context) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'approve' || action === 'decline' || action === 'defer' || action === 'bulk_approve') {
        if (!canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
        }
        // A patch approval is partner-wide fleet POLICY: it decides what every
        // device under the partner may install, and carries no device or site
        // argument at all. So no caller narrowed to specific devices or sites
        // may set it — mirroring the org-wide governance ceiling applied to
        // setup_auto_approval below, but checking both axes directly because
        // `canMutateOrgWideGovernance` only speaks for org-scope principals.
        if (isScopeNarrowedCaller(auth)) {
          return JSON.stringify({
            error: auth.allowedDeviceIds
              ? DEVICE_SCOPE_FLEET_DENIED_MESSAGE
              : SITE_CEILING_WRITE_DENIED_MESSAGE,
          });
        }
      }

      if (action === 'setup_auto_approval') {
        return JSON.stringify({
          error: 'Action "setup_auto_approval" is disabled. Patch policies must be managed through configuration policies. Use manage_policy_feature_link with featureType "patch" to configure auto-approval rules on a policy.',
        });
      }

      if (action === 'list') {
        // `patches` is a global vendor catalog (no org/device columns). Always
        // scope to the caller's tenant via device_patches so the list reflects
        // patches actually present on this org's fleet — never the raw catalog,
        // which would be identical for every device/tenant (issue #2112).
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const deviceId = typeof input.deviceId === 'string' ? input.deviceId : undefined;
        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

        const catalogConds: SQL[] = [];
        if (typeof input.source === 'string') catalogConds.push(eq(patches.source, input.source as any));
        if (typeof input.severity === 'string') catalogConds.push(eq(patches.severity, input.severity as any));

        const patchCols = {
          id: patches.id,
          source: patches.source,
          externalId: patches.externalId,
          title: patches.title,
          severity: patches.severity,
          category: patches.category,
          releaseDate: patches.releaseDate,
          requiresReboot: patches.requiresReboot,
        };

        // Both axes, independent of each other: a site-restricted human sees
        // their sites' patch inventory, a device-bound or device-LESS agent run
        // only its own devices'. `null` = unrestricted (no narrowing, no query).
        const patchListAllowed = await resolveSiteAllowedDeviceIds(orgId, auth);
        if (patchListAllowed && patchListAllowed.length === 0) {
          return JSON.stringify({ patches: [], showing: 0, note: SITE_SCOPE_EMPTY_NOTE });
        }
        const patchListScope: SQL[] = patchListAllowed ? [inArray(devicePatches.deviceId, patchListAllowed)] : [];

        if (deviceId) {
          // Per-device: patches on this specific device, with install status.
          const rows = await db.select({ ...patchCols, status: devicePatches.status })
            .from(devicePatches)
            .innerJoin(patches, eq(devicePatches.patchId, patches.id))
            .where(and(eq(devicePatches.orgId, orgId), eq(devicePatches.deviceId, deviceId), ...patchListScope, ...catalogConds))
            .orderBy(desc(patches.createdAt))
            .limit(limit);
          return JSON.stringify({ patches: rows, showing: rows.length, scope: { deviceId } });
        }

        // Org-wide: distinct catalog entries present on any of the org's
        // devices. selectDistinct collapses the per-device fan-out to one row
        // per patch; createdAt is in the projection so the DISTINCT + ORDER BY
        // is valid in Postgres.
        const rows = await db.selectDistinct({ ...patchCols, createdAt: patches.createdAt })
          .from(patches)
          .innerJoin(devicePatches, eq(devicePatches.patchId, patches.id))
          .where(and(eq(devicePatches.orgId, orgId), ...patchListScope, ...catalogConds))
          .orderBy(desc(patches.createdAt))
          .limit(limit);

        return JSON.stringify({ patches: rows, showing: rows.length, scope: { orgId } });
      }

      if (action === 'compliance') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Approvals are partner-scoped: derive partner from org for the approval stats query.
        const compliancePartnerId = auth.partnerId ?? await resolvePartnerIdForOrg(orgId);
        if (!compliancePartnerId) return JSON.stringify({ error: 'Could not resolve partner for organization' });

        // `patch_approvals` has no org column — a bare partner-id count tells an
        // org-scoped caller how many approvals exist across every SIBLING org
        // under the partner. Narrow to patches actually present on this org's
        // fleet (an EXISTS over device_patches, so the count stays one query and
        // the site/device narrowing below keeps its own call order).
        const approvalStats = await db.select({
          total: sql<number>`count(*)`,
          pending: sql<number>`count(*) filter (where ${patchApprovals.status} = 'pending')`,
          approved: sql<number>`count(*) filter (where ${patchApprovals.status} = 'approved')`,
          rejected: sql<number>`count(*) filter (where ${patchApprovals.status} = 'rejected')`,
          deferred: sql<number>`count(*) filter (where ${patchApprovals.status} = 'deferred')`,
        }).from(patchApprovals)
          .where(and(
            eq(patchApprovals.partnerId, compliancePartnerId),
            sql`EXISTS (SELECT 1 FROM device_patches dp WHERE dp.patch_id = ${patchApprovals.patchId} AND dp.org_id = ${orgId})`,
          ));

        // Site AND exact-device axes (app-layer only; RLS does NOT enforce
        // either): the precomputed snapshot aggregates EVERY device in the org,
        // so no narrowed caller may receive it. Recompute from device_patches
        // over the caller's in-scope devices instead (mirrors
        // routes/patches/compliance.ts:82-97, which zeroes the response for a
        // zero-site caller). `resolveSiteAllowedDeviceIds` intersects both axes
        // and only returns null when NEITHER is set, so a device-LESS analysis
        // run lands here too (#6096 C2) instead of falling through to the
        // org-wide snapshot below.
        if (auth.allowedSiteIds || auth.allowedDeviceIds) {
          const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);
          if (!allowed || allowed.length === 0) {
            return JSON.stringify({
              snapshot: { totalDevices: 0, compliantDevices: 0, nonCompliantDevices: 0, pendingPatches: 0, installedPatches: 0, failedPatches: 0, missingPatches: 0, siteScoped: true },
              approvals: approvalStats[0],
            });
          }
          const [patchStats] = await db.select({
            pending: sql<number>`count(*) filter (where ${devicePatches.status} = 'pending')`,
            installed: sql<number>`count(*) filter (where ${devicePatches.status} = 'installed')`,
            failed: sql<number>`count(*) filter (where ${devicePatches.status} = 'failed')`,
            missing: sql<number>`count(*) filter (where ${devicePatches.status} = 'missing')`,
            devicesNeedingPatches: sql<number>`count(distinct ${devicePatches.deviceId}) filter (where ${devicePatches.status} in ('pending','missing','failed'))`,
          }).from(devicePatches)
            .where(and(eq(devicePatches.orgId, orgId), inArray(devicePatches.deviceId, allowed)));

          const totalDevices = allowed.length;
          const nonCompliant = Number(patchStats?.devicesNeedingPatches ?? 0);
          return JSON.stringify({
            snapshot: {
              totalDevices,
              compliantDevices: totalDevices - nonCompliant,
              nonCompliantDevices: nonCompliant,
              pendingPatches: Number(patchStats?.pending ?? 0),
              installedPatches: Number(patchStats?.installed ?? 0),
              failedPatches: Number(patchStats?.failed ?? 0),
              missingPatches: Number(patchStats?.missing ?? 0),
              siteScoped: true,
            },
            approvals: approvalStats[0],
          });
        }

        // Unrestricted caller: fast precomputed snapshot path.
        const latest = await db.select()
          .from(patchComplianceSnapshots)
          .where(eq(patchComplianceSnapshots.orgId, orgId))
          .orderBy(desc(patchComplianceSnapshots.createdAt))
          .limit(1);

        if (latest.length === 0) return JSON.stringify({ message: 'No compliance data available yet' });

        return JSON.stringify({ snapshot: latest[0], approvals: approvalStats[0] });
      }

      if (action === 'scan') {
        if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) return JSON.stringify({ error: 'deviceIds is required' });
        return JSON.stringify({ success: true, message: `Patch scan requested for ${(input.deviceIds as string[]).length} device(s)`, deviceIds: input.deviceIds });
      }

      if (action === 'approve' || action === 'decline') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const resolvedPatch = await resolveManagePatchesPatchId(orgId, input);
        if ('error' in resolvedPatch) return JSON.stringify({ error: resolvedPatch.error });
        const patchId = resolvedPatch.patchId;

        const approveDeclinePartnerId = auth.partnerId ?? await resolvePartnerIdForOrg(orgId);
        if (!approveDeclinePartnerId) return JSON.stringify({ error: 'Could not resolve partner for organization' });

        // #5585: allRings clears every ring-specific approval for the patch,
        // not just the blanket/current-ring one — a blanket-only decline
        // leaves previously-approved ring rows live (patchApprovalEvaluator
        // matches either row). Only meaningful for decline.
        if (action === 'decline' && input.allRings === true) {
          const { ringIds, failedRingIds } = await declineAllRingApprovals(
            approveDeclinePartnerId,
            patchId,
            (input.notes as string) ?? null,
            auth,
          );
          const success = failedRingIds.length === 0;
          return JSON.stringify({
            success,
            message: success
              ? `Patch declined across all ${ringIds.length} approval scope(s) for this partner`
              : `Patch declined for ${ringIds.length} of ${ringIds.length + failedRingIds.length} approval scope(s); ${failedRingIds.length} failed — retry to finish clearing the rest`,
            patchId,
            declinedRingIds: ringIds,
            failedRingIds,
          });
        }

        const resolvedRing = await resolveManagePatchesRingId(input, approveDeclinePartnerId);
        if ('error' in resolvedRing) return JSON.stringify({ error: resolvedRing.error });

        const status = action === 'approve' ? 'approved' : 'rejected';
        await upsertPatchApproval({
          partnerId: approveDeclinePartnerId,
          patchId,
          ringId: resolvedRing.ringId,
          status,
          approvedBy: auth.user.id,
          approvedAt: new Date(),
          notes: (input.notes as string) ?? null,
        }, auth);

        return JSON.stringify({ success: true, message: `Patch ${action}d`, patchId });
      }

      if (action === 'defer') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const resolvedPatch = await resolveManagePatchesPatchId(orgId, input);
        if ('error' in resolvedPatch) return JSON.stringify({ error: resolvedPatch.error });
        const patchId = resolvedPatch.patchId;

        const deferPartnerId = auth.partnerId ?? await resolvePartnerIdForOrg(orgId);
        if (!deferPartnerId) return JSON.stringify({ error: 'Could not resolve partner for organization' });

        const resolvedRing = await resolveManagePatchesRingId(input, deferPartnerId);
        if ('error' in resolvedRing) return JSON.stringify({ error: resolvedRing.error });

        const deferUntil = input.deferUntil ? new Date(input.deferUntil as string) : null;
        await upsertPatchApproval({
          partnerId: deferPartnerId,
          patchId,
          ringId: resolvedRing.ringId,
          status: 'deferred',
          approvedBy: auth.user.id,
          deferUntil,
          notes: (input.notes as string) ?? null,
        }, auth);

        return JSON.stringify({ success: true, message: `Patch deferred${deferUntil ? ` until ${deferUntil.toISOString()}` : ''}`, patchId });
      }

      if (action === 'bulk_approve') {
        if (!Array.isArray(input.patchIds) || input.patchIds.length === 0) return JSON.stringify({ error: 'patchIds is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const bulkPartnerId = auth.partnerId ?? await resolvePartnerIdForOrg(orgId);
        if (!bulkPartnerId) return JSON.stringify({ error: 'Could not resolve partner for organization' });

        let approved = 0;
        const failed: string[] = [];
        for (const patchId of (input.patchIds as string[]).slice(0, 50)) {
          try {
            await upsertPatchApproval({
              partnerId: bulkPartnerId,
              patchId,
              ringId: null,
              status: 'approved',
              approvedBy: auth.user.id,
              approvedAt: new Date(),
              notes: (input.notes as string) ?? null,
            }, auth);
            approved++;
          } catch (err) {
            console.error(`[fleet:manage_patches] bulk_approve failed for ${patchId}:`, err);
            failed.push(patchId);
          }
        }

        return JSON.stringify({
          success: failed.length === 0,
          message: `${approved} patch(es) approved${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
          approved,
          failed: failed.length > 0 ? failed : undefined,
        });
      }

      if (action === 'install') {
        // #6200: `patch_jobs.created_by` below is a `users` FK. An
        // agent-originated intent is released as the APPROVER
        // (USER_OWNED_RELEASE_ACTIONS), so the two must agree.
        if (approverReleaseMismatch(auth, context)) {
          return JSON.stringify({ error: 'approver_auth_mismatch', action });
        }
        if (!Array.isArray(input.patchIds) || !Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'patchIds and deviceIds are required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Validate devices belong to this org AND the caller's site scope. Site
        // is an app-layer axis (RLS does NOT enforce it), so a site-restricted
        // caller installing patches must be denied for out-of-site devices.
        const ownedDevices = await db.select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(
            eq(devices.orgId, orgId),
            inArray(devices.id, input.deviceIds as string[]),
          ));
        const ownedIds = new Set(
          ownedDevices.filter((d) => !deviceSiteDenied(auth, d.siteId, d.id)).map((d) => d.id),
        );
        const unauthorizedIds = (input.deviceIds as string[]).filter((id) => !ownedIds.has(id));
        if (unauthorizedIds.length > 0) {
          return JSON.stringify({ error: `Access denied: ${unauthorizedIds.length} device(s) not in your organization or site scope` });
        }

        const [job] = await db.insert(patchJobs).values({
          orgId,
          name: `AI-initiated patch install - ${new Date().toISOString()}`,
          patches: { patchIds: input.patchIds },
          targets: { deviceIds: input.deviceIds },
          status: 'scheduled',
          scheduledAt: new Date(),
          devicesTotal: (input.deviceIds as string[]).length,
          devicesPending: (input.deviceIds as string[]).length,
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, jobId: job?.id, patchCount: (input.patchIds as string[]).length, deviceCount: (input.deviceIds as string[]).length });
      }

      if (action === 'rollback') {
        // #6200: `patch_rollbacks.initiated_by` below is a `users` FK.
        if (approverReleaseMismatch(auth, context)) {
          return JSON.stringify({ error: 'approver_auth_mismatch', action });
        }
        if (!input.patchId) return JSON.stringify({ error: 'patchId is required' });
        if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) return JSON.stringify({ error: 'deviceIds is required for rollback' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        // Validate device belongs to this org
        const [device] = await db.select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.orgId, orgId), eq(devices.id, (input.deviceIds as string[])[0]!)))
          .limit(1);
        if (!device) return JSON.stringify({ error: 'Device not found or access denied' });
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, device.siteId, device.id)) return JSON.stringify({ error: 'Device not found or access denied' });

        const [rollback] = await db.insert(patchRollbacks).values({
          deviceId: device.id,
          patchId: input.patchId as string,
          reason: (input.notes as string) ?? 'Initiated via AI assistant',
          status: 'pending',
          initiatedBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, rollbackId: rollback?.id, message: 'Rollback initiated' });
      }

      if (action === 'setup_auto_approval') {
        // NOTE: this whole action is currently unreachable (see the disabled
        // early-return above) — defense-in-depth, kept correct so the block is
        // not a trap if the gate is ever lifted (same convention as the
        // canManagePartnerWidePolicies check a few lines below). This path
        // inserts an org configuration_policies row + feature link, which is
        // exactly the org-wide governance object this contract protects.
        if (!canMutateOrgWideGovernance(auth)) {
          return JSON.stringify({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
        }
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        const patchSettings = {
          sources: Array.isArray(input.sources) ? input.sources as string[] : ['os'],
          autoApprove: typeof input.autoApprove === 'boolean' ? input.autoApprove : true,
          autoApproveSeverities: Array.isArray(input.autoApproveSeverities) ? input.autoApproveSeverities as string[] : ['critical', 'important'],
          scheduleFrequency: typeof input.scheduleFrequency === 'string' ? input.scheduleFrequency : 'weekly',
          scheduleTime: typeof input.scheduleTime === 'string' ? input.scheduleTime : '02:00',
          rebootPolicy: typeof input.rebootPolicy === 'string' ? input.rebootPolicy : 'if_required',
        };

        const configPolicyId = input.configPolicyId as string | undefined;

        if (configPolicyId) {
          // Check if policy exists and user has access.
          //
          // NOTE: this whole action is currently unreachable — `setup_auto_approval`
          // early-returns as disabled above (patch policies are managed through
          // configuration policies). The two fixes below are defense-in-depth,
          // kept correct so the block is not a trap if the gate is ever lifted
          // — same convention as the disabled `manage_alert_rules` branch.
          //
          // `policyAccessCondition`, not a bare org-equality (#3493): a
          // partner-wide policy stores `org_id NULL`, so the org form would tell
          // the partner-scoped tech who AUTHORED the policy it "was not found".
          const policyConditions: SQL[] = [eq(configurationPolicies.id, configPolicyId)];
          const oc = policyAccessCondition(auth);
          if (oc) policyConditions.push(oc);
          const [policy] = await db.select().from(configurationPolicies).where(and(...policyConditions)).limit(1);
          if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });

          // Making a partner-wide policy REACHABLE is not the same as making it
          // writable. Everything below mutates the policy's patch feature link,
          // which lands on every org the policy covers — so it takes the same
          // capability the HTTP feature-link route requires
          // (routes/configurationPolicies/featureLinks.ts).
          if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
            return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
          }

          // Check if patch feature link already exists
          const existingLinks = await db.select()
            .from(configPolicyFeatureLinks)
            .where(and(
              eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
              eq(configPolicyFeatureLinks.featureType, 'patch'),
            )).limit(1);

          if (existingLinks.length > 0) {
            // Update existing feature link
            const updated = await updateFeatureLink(existingLinks[0]!.id, { inlineSettings: patchSettings }, configPolicyId);
            if (!updated) return JSON.stringify({ error: 'Failed to update patch settings — the feature link may have been deleted. Try again.' });
            return JSON.stringify({
              success: true,
              message: `Patch auto-approval settings updated on policy "${policy.name}"`,
              configPolicyId,
              featureLinkId: existingLinks[0]!.id,
              settings: patchSettings,
            });
          }

          // Add new patch feature link. addFeatureLink returns null (instead of
          // throwing) on a duplicate; existingLinks was just checked above so
          // this is effectively unreachable outside a race, but guard anyway.
          const link = await addFeatureLink(configPolicyId, 'patch', null, patchSettings);
          if (!link) return JSON.stringify({ error: 'Patch feature link already exists on this policy' });
          return JSON.stringify({
            success: true,
            message: `Patch auto-approval configured on policy "${policy.name}"`,
            configPolicyId,
            featureLinkId: link.id,
            settings: patchSettings,
          });
        }

        // No configPolicyId — create a new config policy with patch settings
        const [newPolicy] = await db.insert(configurationPolicies).values({
          orgId,
          name: `Patch Auto-Approval Policy`,
          description: `Auto-approve ${patchSettings.autoApproveSeverities.join(', ')} patches on a ${patchSettings.scheduleFrequency} schedule`,
          status: 'active',
          createdBy: auth.user.id,
        }).returning();

        if (!newPolicy) return JSON.stringify({ error: 'Failed to create configuration policy' });

        // newPolicy.id is freshly generated above, so a duplicate feature-link
        // conflict is not realistically reachable; guard for type-safety only.
        const link = await addFeatureLink(newPolicy.id, 'patch', null, patchSettings);
        if (!link) return JSON.stringify({ error: 'Failed to configure patch auto-approval on the new policy' });
        return JSON.stringify({
          success: true,
          message: `Created new policy "${newPolicy.name}" with patch auto-approval`,
          configPolicyId: newPolicy.id,
          featureLinkId: link.id,
          settings: patchSettings,
          hint: 'Use apply_configuration_policy to assign this policy to an organization, site, or device group.',
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 4. manage_groups — Device group lifecycle
  // ============================================

  registerTool({
    tier: 1,
    domain: 'devices',
    searchHint: 'device groups: list, get, preview, membership log, create, update, delete, add/remove devices',
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'manage_groups',
      description: 'Manage device groups: list groups, get details with members, preview dynamic filter results, view membership audit log, create/update/delete groups, add/remove devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'preview', 'membership_log', 'create', 'update', 'delete', 'add_devices', 'remove_devices'], description: 'The action to perform' },
          groupId: { type: 'string', description: 'Group UUID (required for get/membership_log/update/delete/add_devices/remove_devices)' },
          name: { type: 'string', description: 'Group name (for create/update)' },
          type: { type: 'string', enum: ['static', 'dynamic'], description: 'Group type (for create/list filter)' },
          siteId: { type: 'string', description: 'Site UUID filter (for list) or scope (for create)' },
          filterConditions: { type: 'object', description: 'Dynamic filter conditions (for create/update/preview)' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs (for add_devices/remove_devices)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_groups', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      // Device groups are SITE-shaped, so read paths gate on the group's site.
      // update and delete are not read paths: delete removes every member's
      // membership and reconciles peripheral policy for all of them, and update
      // can rewrite the dynamic `filterConditions` that decide who is in the
      // group. Both therefore reach DEVICES, and a device-bound run shares its
      // site with every sibling (#6096 I2). Mirrors `deploymentSiteDenied`:
      // deny when ANY member is outside the frozen set, fail closed on an
      // unresolvable member, and never query for a caller with no device
      // ceiling (site-restricted humans are unaffected).
      const groupMembershipDeviceDenied = async (groupId: string): Promise<boolean> => {
        if (!auth.allowedDeviceIds) return false;
        const allowed = new Set(auth.allowedDeviceIds);
        const members = await db.select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(eq(deviceGroupMemberships.groupId, groupId));
        return members.some((m) => !m.deviceId || !allowed.has(m.deviceId));
      };

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.type === 'string') conditions.push(eq(deviceGroups.type, input.type as 'static' | 'dynamic'));
        if (typeof input.siteId === 'string') conditions.push(eq(deviceGroups.siteId, input.siteId as string));
        // Site axis (app-layer only; RLS does NOT enforce it): a site-restricted
        // caller only sees groups scoped to a site they can access. Null-site
        // (org-wide) groups are treated as out-of-scope (fail closed), matching
        // deviceSiteDenied semantics used by get/update/delete below.
        if (auth.allowedSiteIds) {
          if (auth.allowedSiteIds.length === 0) {
            return JSON.stringify({ groups: [], showing: 0 });
          }
          conditions.push(inArray(deviceGroups.siteId, auth.allowedSiteIds));
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 200);
        const rows = await db.select({
          id: deviceGroups.id,
          name: deviceGroups.name,
          type: deviceGroups.type,
          siteId: deviceGroups.siteId,
          createdAt: deviceGroups.createdAt,
        }).from(deviceGroups)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(deviceGroups.createdAt))
          .limit(limit);

        return JSON.stringify({ groups: rows, showing: rows.length });
      }

      if (action === 'get') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, group.siteId)) return JSON.stringify({ error: 'Group not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const members = await db.select({
          deviceId: deviceGroupMemberships.deviceId,
          hostname: devices.hostname,
          status: devices.status,
          osType: devices.osType,
          isPinned: deviceGroupMemberships.isPinned,
          addedAt: deviceGroupMemberships.addedAt,
        }).from(deviceGroupMemberships)
          .leftJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
          .where(eq(deviceGroupMemberships.groupId, group.id))
          .limit(limit);

        // Exact-device axis (#6096): the GROUP may be in the caller's site, but
        // its membership is a list of devices — a device-bound run must not read
        // its siblings out of it. No-op without `allowedDeviceIds`.
        const visibleMembers = filterToDeviceScope(auth, members, (m) => m.deviceId);

        return JSON.stringify({ group, members: visibleMembers, memberCount: visibleMembers.length });
      }

      if (action === 'preview') {
        if (!input.filterConditions) return JSON.stringify({ error: 'filterConditions is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        try {
          const { evaluateFilterWithPreview } = await import('./filterEngine');
          const result = await evaluateFilterWithPreview(
            input.filterConditions as any,
            // Site axis (app-layer only; RLS does NOT enforce it): narrow the
            // preview to the caller's allowed sites. filterEngine short-circuits
            // to empty for a zero-site restricted caller.
            // Both axes: site narrows the preview to the caller's sites, and
            // the exact-device allowlist narrows it further (a device-bound run
            // would otherwise preview every sibling in its own site, and a
            // device-LESS analysis run has no site axis to narrow on at all).
            {
              orgId,
              limit: Number(input.limit) || 25,
              allowedSiteIds: auth.allowedSiteIds,
              allowedDeviceIds: auth.allowedDeviceIds,
            },
          );
          return JSON.stringify({ preview: result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[fleet:manage_groups] preview filter error:', msg, err);
          // Distinguish module-not-found from runtime errors
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return JSON.stringify({ error: 'Filter engine not available' });
          }
          return JSON.stringify({ error: `Filter preview failed: ${msg}` });
        }
      }

      if (action === 'membership_log') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, group.siteId)) return JSON.stringify({ error: 'Group not found or access denied' });

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const rows = await db.select({
          deviceId: groupMembershipLog.deviceId,
          hostname: devices.hostname,
          action: groupMembershipLog.action,
          reason: groupMembershipLog.reason,
          createdAt: groupMembershipLog.createdAt,
        }).from(groupMembershipLog)
          .leftJoin(devices, eq(groupMembershipLog.deviceId, devices.id))
          .where(eq(groupMembershipLog.groupId, group.id))
          .orderBy(desc(groupMembershipLog.createdAt))
          .limit(limit);

        // Exact-device axis (#6096): same reasoning as `get` — the log is a
        // per-device history, so it discloses sibling devices by name.
        const visibleLog = filterToDeviceScope(auth, rows, (r) => r.deviceId);

        return JSON.stringify({ groupId: group.id, log: visibleLog, showing: visibleLog.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        // Site axis (app-layer only; RLS does NOT enforce it): a site-restricted
        // caller may only create a group scoped to a site they can access. A
        // null/omitted siteId (org-wide group) fails closed for restricted callers.
        if (deviceSiteDenied(auth, (input.siteId as string) ?? null)) {
          return JSON.stringify({ error: 'Access denied: cannot create a group in a site outside your access' });
        }
        const [group] = await db.insert(deviceGroups).values({
          orgId,
          name: input.name as string,
          type: (input.type as 'static' | 'dynamic') ?? 'static',
          siteId: (input.siteId as string) ?? null,
          filterConditions: (input.filterConditions as Record<string, unknown>) ?? null,
        }).returning();

        return JSON.stringify({ success: true, groupId: group?.id, name: group?.name });
      }

      if (action === 'update') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, existing.siteId)) return JSON.stringify({ error: 'Group not found or access denied' });
        // Exact-device axis, beside the site check and never inside it (#6096 I2).
        // A filterConditions rewrite is denied outright for a device-restricted
        // caller: the new predicate decides FUTURE membership, so the current
        // member list says nothing about its reach.
        if (auth.allowedDeviceIds
          && (input.filterConditions !== undefined || await groupMembershipDeviceDenied(existing.id))) {
          return JSON.stringify({ error: DEVICE_SCOPE_FLEET_DENIED_MESSAGE });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.filterConditions) updates.filterConditions = input.filterConditions;

        await db.update(deviceGroups).set(updates).where(eq(deviceGroups.id, existing.id));
        return JSON.stringify({ success: true, message: `Group "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Group not found or access denied' });
        // Site axis (app-layer only; RLS does NOT enforce it).
        if (deviceSiteDenied(auth, existing.siteId)) return JSON.stringify({ error: 'Group not found or access denied' });
        // Exact-device axis (#6096 I2): the delete unmembers every device in the
        // group and reconciles peripheral policy for each one.
        if (await groupMembershipDeviceDenied(existing.id)) {
          return JSON.stringify({ error: DEVICE_SCOPE_FLEET_DENIED_MESSAGE });
        }

        let result: Awaited<ReturnType<typeof deleteDeviceGroup>>;
        try {
          result = await deleteDeviceGroup(existing.id, existing.orgId);
        } catch (err) {
          if (err instanceof DeviceGroupDeleteError) return JSON.stringify({ error: err.message, code: err.code });
          throw err;
        }
        await scheduleAiGroupPeripheralReconciliation(result.affectedDeviceIds);
        return JSON.stringify({ success: true, message: `Group "${existing.name}" deleted` });
      }

      if (action === 'add_devices') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        if (!Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'deviceIds is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        const deviceIdList = (input.deviceIds as string[]).slice(0, 100);
        // Only add devices that belong to the group's org AND are in the caller's
        // site scope. Site is an app-layer axis (RLS does NOT enforce it), so
        // restrict the membership write to in-scope, owned devices.
        const candidateRows = await db.select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.orgId, group.orgId), inArray(devices.id, deviceIdList)));
        const insertableIds = candidateRows
          .filter((d) => !deviceSiteDenied(auth, d.siteId, d.id))
          .map((d) => d.id);
        if (insertableIds.length === 0) {
          return JSON.stringify({ success: true, added: 0, message: 'No in-scope devices to add' });
        }
        const results = await db.insert(deviceGroupMemberships)
          .values(insertableIds.map((deviceId) => ({
            groupId: group.id,
            deviceId,
            orgId: group.orgId,
            addedBy: 'manual' as const,
          })))
          .onConflictDoNothing()
          .returning({ deviceId: deviceGroupMemberships.deviceId });

        await scheduleAiGroupPeripheralReconciliation(results.map(({ deviceId }) => deviceId));

        const skipped = deviceIdList.length - insertableIds.length;
        return JSON.stringify({ success: true, added: results.length, ...(skipped > 0 ? { skipped } : {}), message: `${results.length} device(s) added to group "${group.name}"${skipped > 0 ? ` (${skipped} skipped — outside org/site scope)` : ''}` });
      }

      if (action === 'remove_devices') {
        if (!input.groupId) return JSON.stringify({ error: 'groupId is required' });
        if (!Array.isArray(input.deviceIds)) return JSON.stringify({ error: 'deviceIds is required' });
        const conditions: SQL[] = [eq(deviceGroups.id, input.groupId as string)];
        const oc = orgWhere(auth, deviceGroups.orgId);
        if (oc) conditions.push(oc);

        const [group] = await db.select().from(deviceGroups).where(and(...conditions)).limit(1);
        if (!group) return JSON.stringify({ error: 'Group not found or access denied' });

        const requestedIds = (input.deviceIds as string[]).slice(0, 100);
        // Only remove devices in the caller's site scope. Site is an app-layer
        // axis (RLS does NOT enforce it) — mirror add_devices so a site-restricted
        // caller can't mutate group membership for out-of-site devices.
        const candidateRows = await db.select({ id: devices.id, siteId: devices.siteId })
          .from(devices)
          .where(and(eq(devices.orgId, group.orgId), inArray(devices.id, requestedIds)));
        const removableIds = candidateRows
          .filter((d) => !deviceSiteDenied(auth, d.siteId, d.id))
          .map((d) => d.id);
        const skipped = requestedIds.length - removableIds.length;
        if (removableIds.length === 0) {
          return JSON.stringify({ success: true, removed: 0, ...(skipped > 0 ? { skipped } : {}), message: 'No in-scope devices to remove' });
        }

        const removedMemberships = await db.delete(deviceGroupMemberships)
          .where(and(
            eq(deviceGroupMemberships.groupId, group.id),
            inArray(deviceGroupMemberships.deviceId, removableIds),
          ))
          .returning({ deviceId: deviceGroupMemberships.deviceId });

        await scheduleAiGroupPeripheralReconciliation(removedMemberships.map(({ deviceId }) => deviceId));

        return JSON.stringify({ success: true, removed: removedMemberships.length, ...(skipped > 0 ? { skipped } : {}), message: `Device(s) removed from group "${group.name}"${skipped > 0 ? ` (${skipped} skipped — outside org/site scope)` : ''}` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 5. manage_maintenance_windows — Scheduled suppression
  // ============================================

  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'maintenance windows: list, get, check active now',
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'manage_maintenance_windows',
      description: 'Query maintenance windows (read-only): list windows, get details with occurrences, check what is in maintenance right now. To create or modify maintenance windows, use manage_policy_feature_link with featureType "maintenance".',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'active_now'], description: 'The action to perform. This tool is read-only — to create/modify maintenance windows, use manage_policy_feature_link with featureType "maintenance".' },
          windowId: { type: 'string', description: 'Maintenance window UUID (required for get/update/delete)' },
          name: { type: 'string', description: 'Window name (for create/update)' },
          description: { type: 'string', description: 'Window description' },
          startTime: { type: 'string', description: 'ISO start time' },
          endTime: { type: 'string', description: 'ISO end time' },
          timezone: { type: 'string', description: 'Timezone (default UTC)' },
          recurrence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'custom'], description: 'Recurrence pattern' },
          recurrenceRule: { type: 'object', description: 'Custom recurrence rule' },
          targetType: { type: 'string', description: 'Target type: site, group, device' },
          siteIds: { type: 'array', items: { type: 'string' }, description: 'Target site UUIDs' },
          groupIds: { type: 'array', items: { type: 'string' }, description: 'Target group UUIDs' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Target device UUIDs' },
          suppressAlerts: { type: 'boolean', description: 'Suppress alerts during window' },
          suppressPatching: { type: 'boolean', description: 'Suppress patching during window' },
          suppressAutomations: { type: 'boolean', description: 'Suppress automations during window' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_maintenance_windows', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      // NOTE (#3654): the create/update/delete blocks further down are dead —
      // this guard and the `action` enum both exclude them. If they are ever
      // re-enabled they MUST route through
      // `checkMaintenanceTargetsWithinSiteScope` (services/maintenanceSiteScope),
      // exactly as routes/maintenance.ts does: `maintenanceWindowWhere` below is
      // org/partner only and does not defend the site axis.
      if (action === 'create' || action === 'update' || action === 'delete') {
        return JSON.stringify({
          error: `Action "${action}" is disabled. Maintenance windows must be managed through configuration policies. Use manage_policy_feature_link with featureType "maintenance" to configure maintenance windows on a policy.`,
        });
      }

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = maintenanceWindowWhere(auth);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        // The SQL limit lands before the site filter, so a site-restricted
        // caller scans a wider (still bounded) page and the result is sliced to
        // `limit` after filtering — otherwise other sites' windows crowd out the
        // ones actually suppressing this caller's own fleet (#3654).
        const scanLimit = auth.allowedSiteIds ? Math.min(Math.max(limit * 5, 100), 500) : limit;
        const rows = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          recurrence: maintenanceWindows.recurrence,
          targetType: maintenanceWindows.targetType,
          status: maintenanceWindows.status,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
          // Site-axis inputs (#3654) — stripped from the reply below.
          orgId: maintenanceWindows.orgId,
          siteIds: maintenanceWindows.siteIds,
          groupIds: maintenanceWindows.groupIds,
          deviceIds: maintenanceWindows.deviceIds,
        }).from(maintenanceWindows)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(maintenanceWindows.startTime))
          .limit(scanLimit);

        // `maintenanceWindowWhere` is org/partner only; narrow to the caller's
        // sites the same way GET /maintenance/windows does (#3654).
        const visibleRows = (await filterWindowsToSiteScope(rows, { allowedSiteIds: auth.allowedSiteIds })).slice(0, limit);
        const windows = visibleRows.map(({ orgId: _orgId, siteIds: _siteIds, groupIds: _groupIds, deviceIds: _deviceIds, ...rest }) => rest);

        return JSON.stringify({ windows, showing: windows.length });
      }

      if (action === 'get') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const conditions: SQL[] = [eq(maintenanceWindows.id, input.windowId as string)];
        const oc = maintenanceWindowWhere(auth);
        if (oc) conditions.push(oc);

        const [win] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!win) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        // Site axis (#3654): a window reaching none of the caller's sites is not
        // theirs to read, and its occurrences would disclose it too. A visible
        // one comes back with its target arrays narrowed to the caller's scope.
        const scopedWin = await scopeWindowForRead(win, { allowedSiteIds: auth.allowedSiteIds });
        if (!scopedWin) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        // Exact-device axis (#6096): `scopeWindowForRead` redacts the target
        // arrays on the SITE axis only, so a window in the run's own site still
        // hands back every sibling device id it targets. `list`/`active_now`
        // strip the arrays entirely; `get` returns them, so narrow them here.
        // Null/absent stays null — never turn "no device targets" into "[]".
        const visibleWin = scopedWin.deviceIds
          ? { ...scopedWin, deviceIds: filterToDeviceScope(auth, scopedWin.deviceIds, (id) => id) }
          : scopedWin;

        const occurrences = await db.select()
          .from(maintenanceOccurrences)
          .where(eq(maintenanceOccurrences.windowId, win.id))
          .orderBy(desc(maintenanceOccurrences.startTime))
          .limit(10);

        return JSON.stringify({ window: visibleWin, occurrences });
      }

      if (action === 'active_now') {
        const now = new Date();
        const conditions: SQL[] = [
          lte(maintenanceWindows.startTime, now),
          gte(maintenanceWindows.endTime, now),
          eq(maintenanceWindows.status, 'active'),
        ];
        const oc = maintenanceWindowWhere(auth);
        if (oc) conditions.push(oc);

        const active = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          targetType: maintenanceWindows.targetType,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
          // Site-axis inputs (#3654) — stripped from the reply below.
          orgId: maintenanceWindows.orgId,
          siteIds: maintenanceWindows.siteIds,
          groupIds: maintenanceWindows.groupIds,
          deviceIds: maintenanceWindows.deviceIds,
        }).from(maintenanceWindows)
          .where(and(...conditions));

        // Also check scheduled windows that should be active
        const scheduledConditions: SQL[] = [
          lte(maintenanceWindows.startTime, now),
          gte(maintenanceWindows.endTime, now),
          eq(maintenanceWindows.status, 'scheduled'),
        ];
        const oc2 = maintenanceWindowWhere(auth);
        if (oc2) scheduledConditions.push(oc2);

        const scheduled = await db.select({
          id: maintenanceWindows.id,
          name: maintenanceWindows.name,
          startTime: maintenanceWindows.startTime,
          endTime: maintenanceWindows.endTime,
          targetType: maintenanceWindows.targetType,
          suppressAlerts: maintenanceWindows.suppressAlerts,
          suppressPatching: maintenanceWindows.suppressPatching,
          // Site-axis inputs (#3654) — stripped from the reply below.
          orgId: maintenanceWindows.orgId,
          siteIds: maintenanceWindows.siteIds,
          groupIds: maintenanceWindows.groupIds,
          deviceIds: maintenanceWindows.deviceIds,
        }).from(maintenanceWindows)
          .where(and(...scheduledConditions));

        // `maintenanceWindowWhere` is org/partner only; narrow to the caller's
        // sites (#3654) before reporting what is suppressing their fleet.
        const visibleActive = await filterWindowsToSiteScope(
          [...active, ...scheduled],
          { allowedSiteIds: auth.allowedSiteIds },
        );
        const activeWindows = visibleActive.map(
          ({ orgId: _orgId, siteIds: _siteIds, groupIds: _groupIds, deviceIds: _deviceIds, ...rest }) => rest,
        );

        return JSON.stringify({ activeWindows, count: activeWindows.length });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [win] = await db.insert(maintenanceWindows).values({
          orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          startTime: new Date(input.startTime as string),
          endTime: new Date(input.endTime as string),
          timezone: (input.timezone as string) ?? 'UTC',
          recurrence: (input.recurrence as 'once' | 'daily' | 'weekly' | 'monthly' | 'custom') ?? 'once',
          recurrenceRule: (input.recurrenceRule as Record<string, unknown>) ?? null,
          targetType: input.targetType as string,
          siteIds: (input.siteIds as string[]) ?? null,
          groupIds: (input.groupIds as string[]) ?? null,
          deviceIds: (input.deviceIds as string[]) ?? null,
          suppressAlerts: (input.suppressAlerts as boolean) ?? false,
          suppressPatching: (input.suppressPatching as boolean) ?? false,
          suppressAutomations: (input.suppressAutomations as boolean) ?? false,
          status: 'scheduled',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, windowId: win?.id, name: win?.name });
      }

      if (action === 'update') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const windowId = input.windowId as string;
        const conditions: SQL[] = [eq(maintenanceWindows.id, windowId)];
        const oc = maintenanceWindowWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        // Partner-wide windows are administrable only with the partner-wide
        // capability (same gate as the HTTP route, #2131).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide maintenance window requires full partner org access (orgAccess must be "all")' });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (typeof input.startTime === 'string') updates.startTime = new Date(input.startTime as string);
        if (typeof input.endTime === 'string') updates.endTime = new Date(input.endTime as string);
        if (typeof input.timezone === 'string') updates.timezone = input.timezone;
        if (typeof input.recurrence === 'string') updates.recurrence = input.recurrence;
        if (typeof input.suppressAlerts === 'boolean') updates.suppressAlerts = input.suppressAlerts;
        if (typeof input.suppressPatching === 'boolean') updates.suppressPatching = input.suppressPatching;
        if (typeof input.suppressAutomations === 'boolean') updates.suppressAutomations = input.suppressAutomations;

        await db.update(maintenanceWindows).set(updates).where(eq(maintenanceWindows.id, existing.id));
        return JSON.stringify({ success: true, message: `Maintenance window "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.windowId) return JSON.stringify({ error: 'windowId is required' });
        const windowId = input.windowId as string;
        const conditions: SQL[] = [eq(maintenanceWindows.id, windowId)];
        const oc = maintenanceWindowWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(maintenanceWindows).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Maintenance window not found or access denied' });

        // Partner-wide windows are administrable only with the partner-wide
        // capability (same gate as the HTTP route, #2131).
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide maintenance window requires full partner org access (orgAccess must be "all")' });
        }

        await db.transaction(async (tx) => {
          await tx.delete(maintenanceOccurrences).where(eq(maintenanceOccurrences.windowId, existing.id));
          await tx.delete(maintenanceWindows).where(eq(maintenanceWindows.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Maintenance window "${existing.name}" deleted` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 6. manage_automations — Full automation lifecycle
  // ============================================

  registerTool({
    tier: 1,
    domain: 'scripts',
    searchHint: 'automations: list, get, history, enable, disable, run',
    definition: {
      name: 'manage_automations',
      description: 'Query and operate on automations: list, get details, view run history, enable/disable, or manually trigger a run. To create, update, or delete automations, use manage_policy_feature_link with featureType "automation".',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'history', 'enable', 'disable', 'run'], description: 'The action to perform. To create/update/delete automations, use manage_policy_feature_link with featureType "automation".' },
          automationId: { type: 'string', description: 'Automation UUID (required for get/history/update/delete/enable/disable/run)' },
          name: { type: 'string', description: 'Automation name (for create/update)' },
          description: { type: 'string', description: 'Automation description' },
          trigger: { type: 'object', description: 'Trigger config (for create/update)' },
          conditions: { type: 'object', description: 'Conditions (for create/update)' },
          actions: { type: 'array', items: { type: 'object' }, description: 'Action list (for create/update)' },
          onFailure: { type: 'string', enum: ['stop', 'continue', 'notify'], description: 'Failure behavior' },
          enabled: { type: 'boolean', description: 'Enable state' },
          triggerType: { type: 'string', enum: ['schedule', 'event', 'webhook', 'manual'], description: 'Filter by trigger type (for list)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_automations', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      // Site axis (app-layer only; RLS does NOT enforce it): an automation may
      // target devices/sites outside a restricted caller's allowlist. Reuse the
      // runtime target-scope check the REST route wires via enforceAutomationSiteScope
      // (routes/automations.ts:807/815). Returns a denial message or null (allow).
      const automationSiteDenied = async (
        auto: { orgId: string | null; partnerId: string | null; trigger: unknown; conditions: unknown; id: string },
      ): Promise<string | null> => {
        // Exact-device axis first (#6096). The site check below is blind to it:
        // a device-bound run shares its site with every sibling device, and a
        // device-LESS analysis run has no site axis at all, so an automation
        // that fans out to other devices would pass. `resolveAutomationTargetDeviceIds`
        // resolves an UNBOUNDED (org-wide) automation to every org device, so
        // that shape is denied here by construction; an empty/unresolvable
        // target set fails closed rather than reading as "targets nothing".
        if (auth.allowedDeviceIds) {
          const allowed = new Set(auth.allowedDeviceIds);
          const targets = await resolveAutomationTargetDeviceIds(auto as any);
          if (targets.length === 0 || targets.some((id) => !allowed.has(id))) {
            return DEVICE_SCOPE_FLEET_DENIED_MESSAGE;
          }
        }
        const check = await checkAutomationTargetsWithinSiteScope(auto as any, siteScopePerms(auth));
        if (check.ok) return null;
        return check.unbounded
          ? 'Site-restricted users cannot operate on automations that target all devices in the organization'
          : 'Access to one or more target sites denied';
      };

      if (action === 'create' || action === 'update' || action === 'delete') {
        return JSON.stringify({
          error: `Action "${action}" is disabled. Automations must be managed through configuration policies. Use manage_policy_feature_link with featureType "automation" to configure automations on a policy.`,
        });
      }

      if (action === 'list') {
        const conditions: SQL[] = [];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);
        if (typeof input.triggerType === 'string') {
          conditions.push(sql`${automations.trigger}->>'type' = ${input.triggerType}`);
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const selectRows = () => db.select({
          id: automations.id,
          name: automations.name,
          description: automations.description,
          enabled: automations.enabled,
          trigger: automations.trigger,
          onFailure: automations.onFailure,
          lastRunAt: automations.lastRunAt,
          runCount: automations.runCount,
          createdAt: automations.createdAt,
          // Needed to resolve target site-scope below; also harmless in output.
          orgId: automations.orgId,
          partnerId: automations.partnerId,
          conditions: automations.conditions,
          // #5289 — lets the caller render a compiled automation read-only.
          managedByMonitorId: automations.managedByMonitorId,
        }).from(automations)
          .where(conditions.length > 0 ? and(...conditions) : undefined);

        // Site axis: omit automations whose resolvable target set escapes the
        // caller's site allowlist (only queries the DB for restricted callers).
        let visible: any[];
        if (isScopeNarrowedCaller(auth)) {
          visible = [];
          const scanSize = 100;
          let databaseOffset = 0;
          while (visible.length < limit) {
            const batch = await selectRows()
              .orderBy(desc(automations.createdAt), desc(automations.id))
              .limit(scanSize).offset(databaseOffset);
            if (batch.length === 0) break;
            for (const row of batch) {
              // Both axes, via the same helper the by-id actions use (#6096 C2):
              // the site-only check no-ops for a device-LESS analysis run, which
              // then received every automation in the org.
              if ((await automationSiteDenied(row as any)) === null) {
                visible.push(row);
                if (visible.length === limit) break;
              }
            }
            databaseOffset += batch.length;
            if (batch.length < scanSize) break;
          }
          visible = visible.map((automation: any) => {
            const { lastRunAt: _lastRunAt, runCount: _runCount, ...row } = automation;
            return row;
          });
        } else {
          visible = await selectRows()
            .orderBy(desc(automations.createdAt), desc(automations.id))
            .limit(limit);
        }

        return JSON.stringify({ automations: visible, showing: visible.length });
      }

      if (action === 'get') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });

        const getDenied = await automationSiteDenied(auto);
        if (getDenied) return JSON.stringify({ error: getDenied });

        if (isScopeNarrowedCaller(auth)) {
          const { lastRunAt: _lastRunAt, runCount: _runCount, ...restricted } = auto;
          return JSON.stringify({ automation: restricted });
        }
        return JSON.stringify({ automation: auto });
      }

      if (action === 'history') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });

        const historyDenied = await automationSiteDenied(auto);
        if (historyDenied) return JSON.stringify({ error: historyDenied });

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const page = auth.allowedSiteIds === undefined
          ? await db.select()
            .from(automationRuns)
            .where(eq(automationRuns.automationId, auto.id))
            .orderBy(desc(automationRuns.startedAt))
            .limit(limit)
          : (await scanProjectedAutomationRuns({
            automationId: auto.id,
            allowedSiteIds: auth.allowedSiteIds,
            limit,
          })).rows;

        return JSON.stringify({ automationId: auto.id, runs: page, showing: page.length });
      }

      if (action === 'create') {
        // Defence behind the disabled-action gate in case create is re-enabled.
        if (containsAiTriageAction(input.actions)) {
          return JSON.stringify({ error: AI_TRIAGE_SYSTEM_MANAGED_ERROR_CODE });
        }
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const [auto] = await db.insert(automations).values({
          orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          enabled: (input.enabled as boolean) ?? false,
          trigger: input.trigger as Record<string, unknown>,
          conditions: (input.conditions as Record<string, unknown>) ?? null,
          actions: input.actions as Record<string, unknown>[],
          onFailure: (input.onFailure as 'stop' | 'continue' | 'notify') ?? 'stop',
          createdBy: auth.user.id,
        }).returning();

        return JSON.stringify({ success: true, automationId: auto?.id, name: auto?.name });
      }

      if (action === 'update') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });
        if (isManagedAutomation(existing)) {
          return JSON.stringify({ error: MANAGED_AUTOMATION_ERROR_CODE, agentId: existing.managedByAgentId });
        }
        // Mirrors the create branch: an ai_triage action is seeded per agent,
        // never authored onto an existing row.
        if (containsAiTriageAction(input.actions)) {
          return JSON.stringify({ error: AI_TRIAGE_SYSTEM_MANAGED_ERROR_CODE });
        }

        // Defense-in-depth (#2133): this action is disabled by the early
        // return above, but if it is ever re-enabled, mutating a partner-wide
        // automation must require the partner-wide capability.
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide automation requires full partner org access' });
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (input.trigger) updates.trigger = input.trigger;
        if (input.conditions) updates.conditions = input.conditions;
        if (Array.isArray(input.actions)) updates.actions = input.actions;
        if (typeof input.onFailure === 'string') updates.onFailure = input.onFailure;
        if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;

        await db.update(automations).set(updates).where(eq(automations.id, existing.id));
        return JSON.stringify({ success: true, message: `Automation "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });
        // Mirrors the REST delete route: a managed row becomes deletable once
        // its agent is soft-disabled, because nothing else can ever remove it.
        if (isManagedAutomation(existing)
          && await managedAutomationOwnerIsLive(existing.managedByAgentId as string)) {
          return JSON.stringify({ error: MANAGED_AUTOMATION_ERROR_CODE, agentId: existing.managedByAgentId });
        }

        // Defense-in-depth (#2133): see the update-action gate above.
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Deleting a partner-wide automation requires full partner org access' });
        }

        await db.transaction(async (tx) => {
          await tx.delete(automationRuns).where(eq(automationRuns.automationId, existing.id));
          await tx.delete(automations).where(eq(automations.id, existing.id));
        });
        return JSON.stringify({ success: true, message: `Automation "${existing.name}" deleted` });
      }

      if (action === 'enable' || action === 'disable') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [existing] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Automation not found or access denied' });
        if (isManagedAutomation(existing)) {
          return JSON.stringify({ error: MANAGED_AUTOMATION_ERROR_CODE, agentId: existing.managedByAgentId });
        }
        // #5289 — a row compiled from a monitor definition must be edited
        // only by the compiler; a side edit here would silently drift from
        // the definition until the next compile pass overwrote it.
        if (existing.managedByMonitorId) {
          return JSON.stringify({ error: MANAGED_BY_MONITOR_ERROR.automations, monitorId: existing.managedByMonitorId });
        }

        // Toggling a partner-wide automation mutates behavior across every
        // org under the partner (#2133) — requires the partner-wide capability.
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide automation requires full partner org access' });
        }

        const toggleDenied = await automationSiteDenied(existing);
        if (toggleDenied) return JSON.stringify({ error: toggleDenied });

        const enabled = action === 'enable';
        await db.update(automations)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(automations.id, existing.id));

        return JSON.stringify({ success: true, message: `Automation "${existing.name}" ${enabled ? 'enabled' : 'disabled'}` });
      }

      if (action === 'run') {
        if (!input.automationId) return JSON.stringify({ error: 'automationId is required' });
        const conditions: SQL[] = [eq(automations.id, input.automationId as string)];
        const oc = automationWhere(auth);
        if (oc) conditions.push(oc);

        const [auto] = await db.select().from(automations).where(and(...conditions)).limit(1);
        if (!auto) return JSON.stringify({ error: 'Automation not found or access denied' });
        if (isManagedAutomation(auto)) {
          return JSON.stringify({ error: MANAGED_AUTOMATION_ERROR_CODE, agentId: auto.managedByAgentId });
        }
        // #5289 — see the guard in the enable/disable branch above.
        if (auto.managedByMonitorId) {
          return JSON.stringify({ error: MANAGED_BY_MONITOR_ERROR.automations, monitorId: auto.managedByMonitorId });
        }

        // Running a partner-wide automation fans actions out across every org
        // under the partner (#2133) — requires the partner-wide capability.
        if (auto.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Running a partner-wide automation requires full partner org access' });
        }

        // Re-validate against the CURRENT resolved target set (mirrors the REST
        // run path, routes/automations.ts:815) in case devices/sites drifted.
        const runDenied = await automationSiteDenied(auto);
        if (runDenied) return JSON.stringify({ error: runDenied });

        const [run] = await db.insert(automationRuns).values({
          automationId: auto.id,
          triggeredBy: `ai-user:${auth.user.id}`,
          status: 'running',
        }).returning();

        await db.update(automations)
          .set({ lastRunAt: new Date(), runCount: sql`${automations.runCount} + 1` })
          .where(eq(automations.id, auto.id));

        return JSON.stringify({ success: true, runId: run?.id, message: `Automation "${auto.name}" triggered` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 7. manage_alert_rules — Alert rule + escalation management
  // ============================================

  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'alert rules: list templates, list rules, get rule, test rule, list channels, alert summary',
    definition: {
      name: 'manage_alert_rules',
      description: 'Query alert rules, templates, and notification channels (read-only). Alert rules are managed through configuration policies — use manage_policy_feature_link with featureType "alert_rule" to create or modify alert rules. This tool is for querying only: list_templates to discover available templates, list_rules/get_rule to inspect existing rules, test_rule to check rule state, list_channels for notification channels, alert_summary for overview. Actions: list_templates, list_rules, get_rule, test_rule, list_channels, alert_summary.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list_templates', 'list_rules', 'get_rule', 'test_rule', 'list_channels', 'alert_summary'], description: 'The action to perform. This tool is read-only — to create/modify alert rules, use manage_policy_feature_link with featureType "alert_rule".' },
          ruleId: { type: 'string', description: 'Alert rule UUID (required for get_rule/test_rule)' },
          category: { type: 'string', description: 'Filter templates by category (for list_templates)' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Filter by severity (for list_templates/alert_summary)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_alert_rules', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list_templates') {
        const conditions: SQL[] = [];
        // Show built-in templates (orgId IS NULL) + custom templates for accessible orgs
        const oc = orgWhere(auth, alertTemplates.orgId);
        if (oc) {
          // Org/partner scope: built-in OR belonging to accessible org(s)
          // `is_built_in AND org_id IS NULL` — policyAlertBridge creates
          // ORG-OWNED built-in rows, so a bare is_built_in disjunct would show
          // another org's template (security review 2026-08-16 §1.5, same class).
          conditions.push(sql`((${alertTemplates.isBuiltIn} = true AND ${alertTemplates.orgId} IS NULL) OR ${oc})`);
        }
        // System scope (oc undefined): no filter — show all templates
        if (typeof input.category === 'string') conditions.push(eq(alertTemplates.category, input.category as string));
        if (typeof input.severity === 'string') conditions.push(eq(alertTemplates.severity, input.severity as any));

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const rows = await db.select({
          id: alertTemplates.id,
          name: alertTemplates.name,
          description: alertTemplates.description,
          category: alertTemplates.category,
          severity: alertTemplates.severity,
          conditions: alertTemplates.conditions,
          isBuiltIn: alertTemplates.isBuiltIn,
          autoResolve: alertTemplates.autoResolve,
          cooldownMinutes: alertTemplates.cooldownMinutes,
        }).from(alertTemplates)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(alertTemplates.isBuiltIn), alertTemplates.name)
          .limit(limit);

        return JSON.stringify({
          templates: rows,
          showing: rows.length,
          hint: 'Alert rules are managed through configuration policies. Use manage_policy_feature_link with featureType "alert_rule" and inlineSettings to add alert rules to a policy.',
        });
      }

      if (action === 'list_rules') {
        const conditions: SQL[] = [];
        const oc = alertRuleWhere(auth);
        if (oc) conditions.push(oc);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: alertRules.id,
          name: alertRules.name,
          templateId: alertRules.templateId,
          targetType: alertRules.targetType,
          targetId: alertRules.targetId,
          isActive: alertRules.isActive,
          createdAt: alertRules.createdAt,
        }).from(alertRules)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(alertRules.createdAt))
          .limit(limit);

        // Site axis (app-layer only; RLS does NOT enforce it): omit rules whose
        // target resolves to a site outside the caller's allowlist (only queries
        // for restricted callers).
        let visibleRules = rows;
        if (auth.allowedSiteIds || auth.allowedDeviceIds) {
          const denied = await Promise.all(rows.map((r) => alertRuleTargetDenied(auth, r)));
          visibleRules = rows.filter((_, i) => !denied[i]);
        }

        return JSON.stringify({ rules: visibleRules, showing: visibleRules.length });
      }

      if (action === 'get_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = alertRuleWhere(auth);
        if (oc) conditions.push(oc);

        const [rule] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!rule) return JSON.stringify({ error: 'Alert rule not found or access denied' });
        // Site axis: hide a rule whose target is outside the caller's sites.
        if (await alertRuleTargetDenied(auth, rule)) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        // Get recent alerts for this rule. Org condition (previously absent) plus
        // the canonical alert site predicate (device leftJoin + isNull escape
        // hatch, mirrors routes/alerts/alerts.ts:188-210).
        const recentAlertConds: SQL[] = [eq(alerts.ruleId, rule.id)];
        const recentOrg = orgWhere(auth, alerts.orgId);
        if (recentOrg) recentAlertConds.push(recentOrg);
        const recentSite = alertSiteCondition(auth);
        if (recentSite) recentAlertConds.push(recentSite);
        const recentAlertsCols = {
          id: alerts.id,
          severity: alerts.severity,
          status: alerts.status,
          title: alerts.title,
          triggeredAt: alerts.triggeredAt,
        };
        const recentAlertsBase = db.select(recentAlertsCols).from(alerts);
        const recentAlerts = await (recentSite
          ? recentAlertsBase.leftJoin(devices, eq(alerts.deviceId, devices.id)).where(and(...recentAlertConds))
          : recentAlertsBase.where(and(...recentAlertConds)))
          .orderBy(desc(alerts.triggeredAt))
          .limit(5);

        return JSON.stringify({ rule, recentAlerts });
      }

      if (action === 'create_rule' || action === 'update_rule' || action === 'delete_rule') {
        return JSON.stringify({
          error: `Action "${action}" is disabled. Alert rules must be managed through configuration policies. Use manage_policy_feature_link with featureType "alert_rule" to add, update, or remove alert rules on a configuration policy.`,
        });
      }

      if (action === 'test_rule') {
        if (!input.ruleId) return JSON.stringify({ error: 'ruleId is required' });
        const conditions: SQL[] = [eq(alertRules.id, input.ruleId as string)];
        const oc = alertRuleWhere(auth);
        if (oc) conditions.push(oc);

        const [rule] = await db.select().from(alertRules).where(and(...conditions)).limit(1);
        if (!rule) return JSON.stringify({ error: 'Alert rule not found or access denied' });
        // Site axis: hide a rule whose target is outside the caller's sites.
        if (await alertRuleTargetDenied(auth, rule)) return JSON.stringify({ error: 'Alert rule not found or access denied' });

        // Count current matching alerts. Org condition (previously absent) plus
        // the canonical alert site predicate (device leftJoin + isNull escape).
        const testConds: SQL[] = [eq(alerts.ruleId, rule.id)];
        const testOrg = orgWhere(auth, alerts.orgId);
        if (testOrg) testConds.push(testOrg);
        const testSite = alertSiteCondition(auth);
        if (testSite) testConds.push(testSite);
        const testCountCols = {
          total: sql<number>`count(*)`,
          active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
        };
        const testCountBase = db.select(testCountCols).from(alerts);
        const [alertCount] = await (testSite
          ? testCountBase.leftJoin(devices, eq(alerts.deviceId, devices.id)).where(and(...testConds))
          : testCountBase.where(and(...testConds)));

        return JSON.stringify({
          ruleId: rule.id,
          name: rule.name,
          isActive: rule.isActive,
          currentAlerts: alertCount,
          message: 'Rule test completed — showing current alert state',
        });
      }

      if (action === 'list_channels') {
        const conditions: SQL[] = [];
        const oc = notificationChannelWhere(auth);
        if (oc) conditions.push(oc);

        const rows = await db.select({
          id: notificationChannels.id,
          name: notificationChannels.name,
          type: notificationChannels.type,
          enabled: notificationChannels.enabled,
          createdAt: notificationChannels.createdAt,
        }).from(notificationChannels)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(notificationChannels.createdAt));

        return JSON.stringify({ channels: rows, showing: rows.length });
      }

      if (action === 'alert_summary') {
        const conditions: SQL[] = [];
        const oc = orgWhere(auth, alerts.orgId);
        if (oc) conditions.push(oc);
        if (typeof input.severity === 'string') conditions.push(eq(alerts.severity, input.severity as any));
        // Site axis: narrow the summary to alerts on in-scope devices (canonical
        // predicate — device leftJoin + isNull escape hatch for org-wide alerts).
        const summarySite = alertSiteCondition(auth);
        if (summarySite) conditions.push(summarySite);

        const summaryCols = {
          total: sql<number>`count(*)`,
          active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
          acknowledged: sql<number>`count(*) filter (where ${alerts.status} = 'acknowledged')`,
          resolved: sql<number>`count(*) filter (where ${alerts.status} = 'resolved')`,
          suppressed: sql<number>`count(*) filter (where ${alerts.status} = 'suppressed')`,
          dismissed: sql<number>`count(*) filter (where ${alerts.status} = 'dismissed')`,
          critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical' and ${alerts.status} = 'active')`,
          high: sql<number>`count(*) filter (where ${alerts.severity} = 'high' and ${alerts.status} = 'active')`,
          medium: sql<number>`count(*) filter (where ${alerts.severity} = 'medium' and ${alerts.status} = 'active')`,
          low: sql<number>`count(*) filter (where ${alerts.severity} = 'low' and ${alerts.status} = 'active')`,
          info: sql<number>`count(*) filter (where ${alerts.severity} = 'info' and ${alerts.status} = 'active')`,
        };
        const summaryBase = db.select(summaryCols).from(alerts);
        const [summary] = await (summarySite
          ? summaryBase.leftJoin(devices, eq(alerts.deviceId, devices.id)).where(conditions.length > 0 ? and(...conditions) : undefined)
          : summaryBase.where(conditions.length > 0 ? and(...conditions) : undefined));

        return JSON.stringify({ summary });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 8. generate_report — On-demand and scheduled reports
  // ============================================

  registerTool({
    tier: 1,
    domain: 'admin',
    searchHint: 'reports: list, generate, data, create, update, delete, history, download',
    definition: {
      name: 'generate_report',
      description: 'Manage reports: list saved definitions, generate on-demand, get report data directly, download a completed report run, create/update/delete report definitions, or view generation history.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'generate', 'data', 'create', 'update', 'delete', 'history', 'download'], description: 'The action to perform' },
          reportId: { type: 'string', description: 'Report UUID (for generate/update/delete/history)' },
          reportRunId: { type: 'string', description: 'Report run UUID (required for download)' },
          reportType: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'], description: 'Report type (for generate/data/create)' },
          name: { type: 'string', description: 'Report name (for create/update)' },
          config: { type: 'object', description: 'Report configuration (filters, options)' },
          schedule: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'], description: 'Schedule (for create/update)' },
          format: { type: 'string', enum: ['csv', 'pdf', 'excel'], description: 'Output format (for create/update)' },
          limit: { type: 'number', description: 'Max results (default 25)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('generate_report', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        const conditions: SQL[] = [];
        let definitionPredicate: SQL;
        if (auth.scope === 'organization') {
          if (!auth.orgId) return JSON.stringify({ error: 'Organization context required' });
          const authority = await aiLiveReportAuthority(auth, auth.orgId, 'read');
          if (!authority) {
            return JSON.stringify({ reports: [], showing: 0 });
          }
          conditions.push(eq(reports.orgId, auth.orgId));
          definitionPredicate = reportDefinitionScopeSqlPredicate(
            reports,
            authority.scope,
          );
        } else if (auth.scope === 'partner') {
          const orgIds = auth.accessibleOrgIds ?? [];
          const authorityMap = await resolveRequestReportAuthorityMap(
            auth,
            orgIds,
            'read',
          );
          const scopes: LiveSiteScopeV1[] = [];
          for (const result of authorityMap.values()) {
            if (result.ok && result.authority.scope.kind !== 'legacy_unscoped') {
              scopes.push(result.authority.scope);
            }
          }
          if (orgIds.length > 0) conditions.push(inArray(reports.orgId, orgIds));
          definitionPredicate = reportDefinitionMultiOrgScopeSqlPredicate(
            reports.orgId,
            reports,
            scopes,
          );
        } else {
          definitionPredicate = unrestrictedReportDefinitionScopeSqlPredicate(reports);
        }
        conditions.push(definitionPredicate);

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const rows = await db.select({
          id: reports.id,
          name: reports.name,
          type: reports.type,
          schedule: reports.schedule,
          format: reports.format,
          lastGeneratedAt: reports.lastGeneratedAt,
          createdAt: reports.createdAt,
        }).from(reports)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(reports.createdAt))
          .limit(limit);

        return JSON.stringify({ reports: rows, showing: rows.length });
      }

      if (action === 'generate') {
        // A report run is authorized end to end by SITE scope: `generate`
        // persists site ids onto the run row and the generator re-reads them,
        // with no device axis anywhere. A run pinned to a frozen device set
        // therefore cannot mint one without covering every sibling device in
        // its site — deny with a reason instead of leaking (#6096).
        if (auth.allowedDeviceIds) return JSON.stringify({ error: DEVICE_SCOPE_REPORT_DENIED_MESSAGE });
        if (!input.reportId && !input.reportType) return JSON.stringify({ error: 'reportId or reportType is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });

        let reportDef;
        let executionAuthority: ReportExecutionAuthority | null = null;
        if (input.reportId) {
          const access = await aiReportDefinitionAccess(
            auth,
            input.reportId as string,
            'read',
          );
          if (!access) return JSON.stringify({ error: 'Report not found or access denied' });
          reportDef = access.report;
          try {
            const persistedScope = decodeSiteScope(
              reportDef as unknown as PersistedSiteScopeColumns,
              reportDef.orgId,
            );
            const effectiveScope = intersectSiteScopes(
              persistedScope,
              access.authority.scope,
            );
            if (
              !effectiveScope
              || effectiveScope.kind === 'legacy_unscoped'
              || (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0)
            ) {
              return JSON.stringify({ error: 'Report not found or access denied' });
            }
            executionAuthority = {
              principalKind: 'user',
              scope: effectiveScope,
              principalUserId: access.authority.principalUserId,
              capturedAt: access.authority.capturedAt,
              fingerprint: siteScopeFingerprint(effectiveScope),
            };
          } catch {
            return JSON.stringify({ error: 'Report not found or access denied' });
          }
        } else {
          executionAuthority = await aiLiveReportAuthority(auth, orgId, 'read');
          if (
            !executionAuthority
            || executionAuthority.scope.kind === 'legacy_unscoped'
            || (executionAuthority.scope.kind === 'restricted'
              && executionAuthority.scope.siteIds.length === 0)
          ) {
            return JSON.stringify({ error: 'Access to report scope denied' });
          }
        }

        const reportConfig = (reportDef?.config ?? input.config ?? {}) as Record<string, unknown>;
        try {
          assertReportExecutionPreflight(orgId, reportConfig, executionAuthority);
        } catch {
          return JSON.stringify({ error: 'Report not found or access denied' });
        }

        // Only create a run record if we have a saved report definition
        const reportId = reportDef?.id ?? null;
        let runId: string | null = null;

        if (reportId) {
          const [run] = await db.insert(reportRuns).values({
            reportId,
            status: 'pending',
            requestedByKind: 'user',
            requestedByUserId: auth.user.id,
            requestedByPortalUserId: null,
            ...persistedSiteScopeValues(executionAuthority),
          }).returning();
          runId = run?.id ?? null;
          await db.update(reports).set({ lastGeneratedAt: new Date() }).where(eq(reports.id, reportId));
        }

        return JSON.stringify({
          success: true,
          runId,
          reportType: reportDef?.type ?? input.reportType,
          message: reportId ? 'Report generation initiated' : 'Ad-hoc report generation initiated',
        });
      }

      if (action === 'data') {
        if (!input.reportType) return JSON.stringify({ error: 'reportType is required' });
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const executionAuthority = await aiLiveReportAuthority(auth, orgId, 'read');
        if (!executionAuthority) {
          return JSON.stringify({ error: 'Access to report scope denied' });
        }

        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 100);
        const reportType = input.reportType as string;

        if (reportType === 'device_inventory') {
          const inventoryConditions: SQL[] = [eq(devices.orgId, orgId)];
          // Site axis: a site-restricted caller may only enumerate devices in
          // their allowed sites (RLS does NOT enforce site).
          if (executionAuthority.scope.kind === 'restricted') {
            if (executionAuthority.scope.siteIds.length === 0) {
              return JSON.stringify({ reportType, data: [], showing: 0 });
            }
            inventoryConditions.push(
              inArray(devices.siteId, executionAuthority.scope.siteIds),
            );
          }
          // Exact-device axis, applied whether or not the authority is site
          // restricted (a device-LESS analysis run resolves to `unrestricted`).
          const inventoryDeviceScope = deviceScopeCondition(auth, devices.id);
          if (inventoryDeviceScope) inventoryConditions.push(inventoryDeviceScope);
          const rows = await db.select({
            id: devices.id,
            hostname: devices.hostname,
            osType: devices.osType,
            osVersion: devices.osVersion,
            status: devices.status,
            agentVersion: devices.agentVersion,
            lastSeenAt: devices.lastSeenAt,
            siteName: sites.name,
          }).from(devices)
            .leftJoin(sites, eq(devices.siteId, sites.id))
            .where(and(...inventoryConditions))
            .orderBy(desc(devices.lastSeenAt))
            .limit(limit);

          return JSON.stringify({ reportType, data: rows, showing: rows.length });
        }

        if (reportType === 'alert_summary') {
          const summaryConditions: SQL[] = [eq(alerts.orgId, orgId)];
          // Site AND exact-device axes: mirror device_inventory — narrow to the
          // devices this caller may actually aggregate over. `null` means
          // unrestricted on both axes; `[]` means restricted with nothing in
          // scope, which must zero the response rather than widen it.
          {
            const allowed = await aiAuthorityDeviceIds(orgId, executionAuthority, auth);
            if (allowed && allowed.length === 0) {
              return JSON.stringify({ reportType, data: { total: 0, active: 0, critical: 0, high: 0, resolved24h: 0 } });
            }
            if (allowed) summaryConditions.push(inArray(alerts.deviceId, allowed));
          }
          const [summary] = await db.select({
            total: sql<number>`count(*)`,
            active: sql<number>`count(*) filter (where ${alerts.status} = 'active')`,
            critical: sql<number>`count(*) filter (where ${alerts.severity} = 'critical' and ${alerts.status} = 'active')`,
            high: sql<number>`count(*) filter (where ${alerts.severity} = 'high' and ${alerts.status} = 'active')`,
            resolved24h: sql<number>`count(*) filter (where ${alerts.status} = 'resolved' and ${alerts.resolvedAt} > now() - interval '24 hours')`,
          }).from(alerts)
            .where(and(...summaryConditions));

          return JSON.stringify({ reportType, data: summary });
        }

        if (reportType === 'compliance') {
          // Get policy compliance summary (dual-axis, #2129)
          const oc = automationPolicyWhere(auth);
          const conditions: SQL[] = [];
          if (oc) conditions.push(oc);

          // Site axis: narrow the per-device compliance rows to the caller's
          // in-scope devices. Added to the JOIN condition (not WHERE) so policies
          // still appear with in-scope counts rather than being dropped entirely.
          let complianceJoin: SQL = eq(automationPolicies.id, automationPolicyCompliance.policyId);
          {
            const allowed = await aiAuthorityDeviceIds(orgId, executionAuthority, auth);
            if (allowed && allowed.length === 0) {
              return JSON.stringify({ reportType, data: [] });
            }
            if (allowed) {
              complianceJoin = and(complianceJoin, inArray(automationPolicyCompliance.deviceId, allowed))!;
            }
          }

          const rows = await db.select({
            policyId: automationPolicies.id,
            policyName: automationPolicies.name,
            enforcement: automationPolicies.enforcement,
            total: sql<number>`count(${automationPolicyCompliance.id})`,
            compliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'compliant')`,
            nonCompliant: sql<number>`count(*) filter (where ${automationPolicyCompliance.status} = 'non_compliant')`,
          }).from(automationPolicies)
            .leftJoin(automationPolicyCompliance, complianceJoin)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .groupBy(automationPolicies.id);

          return JSON.stringify({ reportType, data: rows });
        }

        return JSON.stringify({ reportType, data: [], message: `Report type "${reportType}" data retrieval — use generate action for full report` });
      }

      if (action === 'create') {
        if (!orgId) return JSON.stringify({ error: 'Organization context required' });
        const authority = await aiLiveReportAuthority(auth, orgId, 'write');
        if (
          !authority
          || (authority.scope.kind === 'restricted' && authority.scope.siteIds.length === 0)
        ) {
          return JSON.stringify({ error: 'Access to report scope denied' });
        }
        const [report] = await db.insert(reports).values({
          orgId,
          name: input.name as string,
          type: input.reportType as 'device_inventory' | 'software_inventory' | 'alert_summary' | 'compliance' | 'performance' | 'executive_summary',
          config: (input.config as Record<string, unknown>) ?? {},
          schedule: (input.schedule as 'one_time' | 'daily' | 'weekly' | 'monthly') ?? 'one_time',
          format: (input.format as 'csv' | 'pdf' | 'excel') ?? 'csv',
          createdBy: auth.user.id,
          ...persistedSiteScopeValues(authority),
        }).returning();

        return JSON.stringify({ success: true, reportId: report?.id, name: report?.name });
      }

      if (action === 'update') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const access = await aiReportDefinitionAccess(
          auth,
          input.reportId as string,
          'write',
        );
        if (!access) return JSON.stringify({ error: 'Report not found or access denied' });
        const existing = access.report;

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof input.name === 'string') updates.name = input.name;
        if (input.config) updates.config = input.config;
        if (typeof input.schedule === 'string') updates.schedule = input.schedule;
        if (typeof input.format === 'string') updates.format = input.format;

        const updated = await db.update(reports).set(updates).where(and(
          eq(reports.id, existing.id),
          eq(reports.orgId, existing.orgId),
          access.predicate,
        )).returning({ id: reports.id });
        if (updated.length !== 1) {
          return JSON.stringify({ error: 'Report not found or access denied' });
        }
        return JSON.stringify({ success: true, message: `Report "${existing.name}" updated` });
      }

      if (action === 'delete') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const access = await aiReportDefinitionAccess(
          auth,
          input.reportId as string,
          'delete',
        );
        if (!access) return JSON.stringify({ error: 'Report not found or access denied' });
        const existing = access.report;

        const deleted = await db.transaction(async (tx) => {
          await tx.delete(reportRuns).where(eq(reportRuns.reportId, existing.id));
          const deletedRows = await tx.delete(reports).where(and(
            eq(reports.id, existing.id),
            eq(reports.orgId, existing.orgId),
            access.predicate,
          )).returning({ id: reports.id });
          if (deletedRows.length !== 1) {
            throw new Error('AI_REPORT_DELETE_SCOPE_CHANGED');
          }
          return deletedRows[0];
        }).catch((error) => {
          if (error instanceof Error && error.message === 'AI_REPORT_DELETE_SCOPE_CHANGED') {
            return null;
          }
          throw error;
        });
        if (!deleted) {
          return JSON.stringify({ error: 'Report not found or access denied' });
        }
        return JSON.stringify({ success: true, message: `Report "${existing.name}" deleted` });
      }

      if (action === 'history') {
        if (!input.reportId) return JSON.stringify({ error: 'reportId is required' });
        const access = await aiReportDefinitionAccess(
          auth,
          input.reportId as string,
          'read',
        );
        if (!access) return JSON.stringify({ error: 'Report not found or access denied' });
        const report = access.report;
        const runPredicate = reportRunScopeSqlPredicate(
          reportRuns,
          access.authority.scope,
        );

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const runs = await db.select({
          id: reportRuns.id,
          reportId: reportRuns.reportId,
          status: reportRuns.status,
          startedAt: reportRuns.startedAt,
          completedAt: reportRuns.completedAt,
          outputUrl: reportRuns.outputUrl,
          errorMessage: reportRuns.errorMessage,
          rowCount: reportRuns.rowCount,
          createdAt: reportRuns.createdAt,
        })
          .from(reportRuns)
          .where(and(eq(reportRuns.reportId, report.id), runPredicate))
          .orderBy(desc(reportRuns.createdAt))
          .limit(limit);

        return JSON.stringify({ reportId: report.id, runs, showing: runs.length });
      }

      if (action === 'download') {
        // Same reasoning as `generate`: the artifact behind the run was built
        // from a site scope, so handing it to a device-bound run discloses
        // every other device in that scope.
        if (auth.allowedDeviceIds) return JSON.stringify({ error: DEVICE_SCOPE_REPORT_DENIED_MESSAGE });
        if (!input.reportRunId) return JSON.stringify({ error: 'reportRunId is required' });
        const access = await aiReportRunAccess(
          auth,
          input.reportRunId as string,
          'export',
        );
        if (!access) return JSON.stringify({ error: 'Report run not found' });

        const [run] = await db.select({
          id: reportRuns.id,
          reportId: reportRuns.reportId,
          status: reportRuns.status,
          startedAt: reportRuns.startedAt,
          completedAt: reportRuns.completedAt,
          outputUrl: reportRuns.outputUrl,
          errorMessage: reportRuns.errorMessage,
          rowCount: reportRuns.rowCount,
          createdAt: reportRuns.createdAt,
          reportName: reports.name,
          reportType: reports.type,
          reportFormat: reports.format,
          reportOrgId: reports.orgId,
          executionScopeVersion: reportRuns.executionScopeVersion,
          executionScopeKind: reportRuns.executionScopeKind,
          executionScopeSiteIds: reportRuns.executionScopeSiteIds,
          executionScopeUserId: reportRuns.executionScopeUserId,
          executionScopeFingerprint: reportRuns.executionScopeFingerprint,
          executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
          executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
        }).from(reportRuns)
          .innerJoin(reports, eq(reportRuns.reportId, reports.id))
          .where(and(
            eq(reportRuns.id, input.reportRunId as string),
            eq(reports.orgId, access.metadata.orgId),
            access.predicate,
          ))
          .limit(1);

        if (!run) return JSON.stringify({ error: 'Report run not found' });
        try {
          const storedScope = decodeSiteScope(
            run as unknown as PersistedSiteScopeColumns,
            run.reportOrgId,
          );
          if (!isSiteScopeSubset(storedScope, access.authority.scope)) {
            return JSON.stringify({ error: 'Report run not found' });
          }
        } catch {
          return JSON.stringify({ error: 'Report run not found' });
        }

        if (run.status !== 'completed') {
          return JSON.stringify({
            error: `Report run is not completed (status: ${run.status})`,
            runId: run.id,
            status: run.status,
            errorMessage: run.errorMessage
          });
        }

        return JSON.stringify({
          runId: run.id,
          reportName: run.reportName,
          reportType: run.reportType,
          format: run.reportFormat,
          outputUrl: run.outputUrl,
          rowCount: run.rowCount,
          completedAt: run.completedAt
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });

  // ============================================
  // 9. manage_service_monitors — Service/process monitoring setup
  // ============================================

  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'service and process monitoring watches: list',
    definition: {
      name: 'manage_service_monitors',
      description: 'Query service and process monitoring watches (read-only). To add or remove monitoring watches, use manage_policy_feature_link with featureType "monitoring" and action "update" to configure watches on a configuration policy.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list'], description: 'The action to perform. To add/remove monitors, use manage_policy_feature_link with featureType "monitoring".' },
          configPolicyId: { type: 'string', description: 'Configuration policy UUID. For list, shows all monitors across policies if omitted.' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_service_monitors', async (input, auth) => {
      const action = input.action as string;
      const orgId = getOrgId(auth);

      if (action === 'list') {
        // List all monitoring watches, optionally filtered by policy.
        //
        // `policyAccessCondition`, not a bare `orgWhere` on
        // configurationPolicies.orgId (#3493): a partner-wide policy stores
        // `org_id NULL`, so the org-equality form silently omits every
        // partner-owned monitoring policy — including from the partner-scoped
        // techs who authored them. The helper adds the dual-axis branch and is
        // gated on partner scope so the app layer never claims more than RLS
        // grants.
        const conditions: SQL[] = [];
        const oc = policyAccessCondition(auth);
        if (oc) conditions.push(oc);
        if (typeof input.configPolicyId === 'string') {
          conditions.push(eq(configPolicyFeatureLinks.configPolicyId, input.configPolicyId as string));
        }
        conditions.push(eq(configPolicyFeatureLinks.featureType, 'monitoring'));

        const rows = await db.select({
          watchId: configPolicyMonitoringWatches.id,
          watchType: configPolicyMonitoringWatches.watchType,
          name: configPolicyMonitoringWatches.name,
          displayName: configPolicyMonitoringWatches.displayName,
          enabled: configPolicyMonitoringWatches.enabled,
          alertOnStop: configPolicyMonitoringWatches.alertOnStop,
          alertSeverity: configPolicyMonitoringWatches.alertSeverity,
          cpuThresholdPercent: configPolicyMonitoringWatches.cpuThresholdPercent,
          memoryThresholdMb: configPolicyMonitoringWatches.memoryThresholdMb,
          autoRestart: configPolicyMonitoringWatches.autoRestart,
          policyId: configurationPolicies.id,
          policyName: configurationPolicies.name,
          checkIntervalSeconds: configPolicyMonitoringSettings.checkIntervalSeconds,
        }).from(configPolicyMonitoringWatches)
          .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id))
          .innerJoin(configPolicyFeatureLinks, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
          .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(configurationPolicies.name, configPolicyMonitoringWatches.sortOrder);

        // Site + exact-device axes (#6096). `policyAccessCondition` is org/
        // partner only, so this listing is otherwise ORG-WIDE config: a run
        // pinned to one device could enumerate the monitoring watches of
        // policies that only ever reach OTHER sites and OTHER devices.
        //
        // A policy is visible when at least one of its assignments REACHES the
        // caller. Partner/organization assignments reach every device under
        // them — including the run's own — so they stay visible; site, device
        // and group assignments must name something the caller can see. A
        // policy with no assignment at all reaches nothing and drops out.
        const visibleMonitors = await narrowMonitorsToCallerReach(auth, rows);

        return JSON.stringify({ monitors: visibleMonitors, showing: visibleMonitors.length });
      }

      return JSON.stringify({ error: `Unknown action: ${action}. Only "list" is supported. Use manage_policy_feature_link to add/update/remove monitors.` });
    }),
  });

  // ============================================
  // 10. get_fleet_findings — Fleet hygiene findings feed (read-only)
  // ============================================

  registerTool({
    tier: 1,
    domain: 'devices',
    searchHint: 'fleet hygiene findings, metric anomaly patterns, log correlations and reliability offenders',
    definition: {
      name: 'get_fleet_findings',
      description: 'List fleet hygiene findings: deduplicated, aggregate issues detected across the fleet (metric anomaly patterns, log correlations, reliability offenders). Read-only — use manage_deployments/manage_patches/run_script etc. to act on a finding\'s remediation.',
      input_schema: {
        type: 'object' as const,
        properties: {
          kind: { type: 'string', enum: [...FLEET_FINDING_KIND_VALUES], description: 'Filter by finding kind' },
          severity: { type: 'string', enum: [...FLEET_FINDING_SEVERITY_VALUES], description: 'Filter by severity' },
          status: { type: 'string', description: `Comma-separated statuses to include, e.g. "open,acknowledged". Allowed values: ${FLEET_FINDING_STATUS_VALUES.join(', ')}. Default: open,acknowledged.` },
          orgId: { type: 'string', description: 'Organization UUID to scope to (must be accessible to the caller). Omit to use the caller\'s own org/partner scope.' },
          limit: { type: 'number', description: 'Max findings to return (default 25, max 50)' },
        },
      },
    },
    handler: safeHandler('get_fleet_findings', async (input, auth) => {
      const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
      if (orgId && !auth.canAccessOrg(orgId)) {
        return JSON.stringify({ error: 'Access to this organization denied' });
      }

      const kind = typeof input.kind === 'string' ? (input.kind as FleetFindingKind) : undefined;
      if (kind && !(FLEET_FINDING_KIND_VALUES as readonly string[]).includes(kind)) {
        return JSON.stringify({ error: `Invalid kind. Allowed values: ${FLEET_FINDING_KIND_VALUES.join(', ')}` });
      }

      const severity = typeof input.severity === 'string' ? (input.severity as FleetFindingSeverity) : undefined;
      if (severity && !(FLEET_FINDING_SEVERITY_VALUES as readonly string[]).includes(severity)) {
        return JSON.stringify({ error: `Invalid severity. Allowed values: ${FLEET_FINDING_SEVERITY_VALUES.join(', ')}` });
      }

      const statuses = parseFleetFindingStatusCsv(typeof input.status === 'string' ? input.status : undefined);
      if (!statuses) {
        return JSON.stringify({ error: `Invalid status filter. Allowed values: ${FLEET_FINDING_STATUS_VALUES.join(', ')}` });
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 50);

      // listFleetFindings owns ALL scoping: org (RLS/orgCondition or the
      // access-checked orgId above) and site-axis narrowing (app-layer,
      // recomputes deviceCount and omits zero-in-scope-member findings for a
      // site-restricted caller). Not re-derived here — see CLAUDE.md's
      // AI-tool/route dual-map drift warning.
      const result = await listFleetFindings(auth, {
        orgId,
        kind,
        severity,
        statuses,
        limit,
        offset: 0,
      });

      return JSON.stringify({
        findings: result.findings.map((f) => ({
          id: f.id,
          title: f.title,
          kind: f.kind,
          severity: f.severity,
          status: f.status,
          deviceCount: f.deviceCount,
          orgName: f.orgName,
          lastSeenAt: f.lastSeenAt,
        })),
        total: result.total,
        showing: result.findings.length,
      });
    }),
  });
}
