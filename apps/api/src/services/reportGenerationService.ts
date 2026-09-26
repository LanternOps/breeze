import { and, eq, sql, desc, gte, lte, inArray, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import {
  devices,
  manualAssets,
  deviceSoftware,
  deviceMetrics,
  deviceHardware,
  alerts,
  alertRules,
  sites,
  organizations,
  reportRuns
} from '../db/schema';
import type { ExecutiveSummary, ReportType as SharedReportType } from '@breeze/shared';
import { emptyVulnerabilityManagementSummary } from '@breeze/shared';
import {
  ENDPOINT_MANAGEMENT_NO_SITES_GAP,
  emptyEndpointManagementSummary,
} from '@breeze/shared';
import {
  BUSINESS_REPORT_TYPES,
  emptyArAgingSummary,
  emptyTechnicianTimeSummary,
  emptyTicketSlaSummary,
} from '@breeze/shared';
import {
  systemReportAuthorityFor,
  type OrgReportExecutionAuthority,
  type OrgReportGenerationAuthority,
  type ReportExecutionAuthority,
  type ReportGenerationAuthority,
  type ReportOwner,
} from './siteScope';
import { isManagedEvidenceType, type ManagedEvidenceType } from './managedEvidenceRegistry';
import { reportTypeDef } from './reportRegistry';
import { endpointManagementConfigSchema } from './reportConfigSchemas';
import { organizationScope, reportOwnerOfScope, type ReportScope } from './reportScope';
import { alertSiteScopeByDeviceIds } from '../routes/alerts/helpers';
// #3198 W02: shared with the business generators, which refuse a restricted
// authority with a non-empty site list themselves (the zero-safe branch below
// only sees the empty-list case).
import { SITE_RESTRICTED_NOTE } from './businessReports/common';
import {
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
} from './reportErrors';

export {
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
} from './reportErrors';

/** `endpointManagementConfigSchema`'s own default, read from the schema so the
 *  zero-safe shape can never drift from what the generator applies. (The
 *  schema lives in the zod-only `reportConfigSchemas` module, so there is no
 *  cycle to duplicate around any more.) */
const ENDPOINT_MANAGEMENT_DEFAULT_STALE_DAYS =
  endpointManagementConfigSchema.parse({}).staleEnrolmentDays;

// `ReportType` is derived from the canonical tuple in `@breeze/shared`
// (`packages/shared/src/reportTypes.ts` carries the abridged per-type notes:
// which types are STORED artifacts never generated on demand
// (`ai_org_narrative`, `ai_fleet_design`), which are #5784 service-plan
// evidence, and which are the #3198 business trio). Kept as a re-export
// rather than an inline import at every call site: `managedEvidenceRegistry.ts`,
// this file's own tests, and several route files import `ReportType` from
// this module. `reportGenerationService.test.ts` pins the tuple's members
// against `reportTypeEnum` so the two can never drift.
export type ReportType = SharedReportType;

export type ReportResult = {
  rows?: unknown[];
  rowCount?: number;
  summary?: Record<string, unknown>;
  generatedAt?: string;
  /** Slim baseline from the previous completed run of the same report, copied
   * into the snapshot at generation time so trend deltas ("79, up from 74")
   * render from the stored result alone. Only `summary` is copied — never
   * `previous` — so baselines don't chain. */
  previous?: { generatedAt: string | null; summary?: Record<string, unknown> };
};

/** Baseline from the most recent completed run of this report, if it captured
 * a summary. Call BEFORE marking the new run completed.
 *
 * Projects only `result->summary` / `result->>generatedAt` instead of the full
 * `result` JSONB (which can be many MB — it includes every row) and never
 * throws: this sits in the success path of both generation call sites, so a
 * lookup failure must degrade to "no baseline" rather than fail an otherwise
 * good run. */
export async function previousBaselineFor(
  reportId: string,
  scopeFingerprint: string,
): Promise<ReportResult['previous']> {
  try {
    const [prior] = await db
      .select({
        summary: sql<Record<string, unknown> | null>`${reportRuns.result}->'summary'`,
        generatedAt: sql<string | null>`${reportRuns.result}->>'generatedAt'`,
        completedAt: reportRuns.completedAt,
      })
      .from(reportRuns)
      .where(and(
        eq(reportRuns.reportId, reportId),
        eq(reportRuns.status, 'completed'),
        eq(reportRuns.executionScopeFingerprint, scopeFingerprint),
      ))
      .orderBy(desc(reportRuns.completedAt))
      .limit(1);
    if (!prior?.summary || typeof prior.summary !== 'object') return undefined;
    return {
      generatedAt: prior.generatedAt ?? prior.completedAt?.toISOString() ?? null,
      summary: prior.summary,
    };
  } catch (err) {
    console.error('[reports] previous-baseline lookup failed', { reportId }, err);
    return undefined;
  }
}

export async function resolveSiteAllowedDeviceIds(
  orgId: string,
  authority: ReportExecutionAuthority,
): Promise<string[] | null> {
  assertExecutableAuthority(orgId, authority);
  if (authority.scope.kind === 'unrestricted') return null;
  if (authority.scope.kind !== 'restricted') {
    throw new UnexecutableReportScopeError();
  }
  if (authority.scope.siteIds.length === 0) return [];
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      inArray(devices.siteId, authority.scope.siteIds),
    ));
  return orgDevices.map((device) => device.id);
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function filtersFor(config: Record<string, unknown>): Record<string, unknown> {
  return (config.filters as Record<string, unknown> | undefined) ?? {};
}

function emptyRowsReport() {
  return { rows: [], rowCount: 0 };
}


/**
 * Push the authority's allowed-site predicate onto `conditions`, returning true
 * when the authority can see nothing at all (restricted to zero sites).
 *
 * `siteColumn` exists because `device_inventory` now queries two tables
 * (#4622): the predicate must be applied to EACH branch against that branch's
 * own site column. Defaulting to `devices.siteId` keeps every existing caller
 * unchanged — a branch that forgets to pass its own column would silently
 * return every row in the org.
 */
function addAllowedSiteCondition(
  conditions: SQL[],
  authority: ReportGenerationAuthority,
  siteColumn: AnyPgColumn = devices.siteId,
): boolean {
  if (authority.scope.kind === 'unrestricted') return false;
  if (authority.scope.kind !== 'restricted') {
    throw new UnexecutableReportScopeError();
  }
  if (authority.scope.siteIds.length === 0) return true;
  conditions.push(inArray(siteColumn, authority.scope.siteIds));
  return false;
}

function assertExecutableAuthority(
  orgId: string,
  authority: ReportGenerationAuthority | null | undefined,
): asserts authority is ReportGenerationAuthority {
  if (!authority || !authority.scope) {
    throw new UnexecutableReportScopeError('Report execution authority is required');
  }
  // #3198 W01: a partner_wide scope has no org, so it never matches an org
  // owner. Partner-owned execution is asserted in assertReportExecutionPreflight.
  if (authority.scope.kind === 'partner_wide' || authority.scope.orgId !== orgId) {
    throw new UnexecutableReportScopeError('Report execution authority organization mismatch');
  }
  if (authority.scope.kind === 'legacy_unscoped') {
    throw new UnexecutableReportScopeError('Legacy report scope cannot execute');
  }
  switch (authority.principalKind) {
    case 'user':
      if (!authority.principalUserId) {
        throw new UnexecutableReportScopeError('User report execution authority requires a principal user');
      }
      break;
    case 'portal_user':
      if (authority.scope.kind !== 'unrestricted') {
        throw new UnexecutableReportScopeError('Portal-user report execution authority must be unrestricted');
      }
      if (
        'principalUserId' in authority
        && authority.principalUserId !== null
        && authority.principalUserId !== undefined
      ) {
        throw new UnexecutableReportScopeError('Portal-user report execution authority cannot carry a staff principal');
      }
      break;
    case 'system':
      // #5784 OD-5 = B. A system authority is org-wide by construction; a
      // restricted one would stamp a scoped fingerprint on an org-wide result.
      if (authority.scope.kind !== 'unrestricted') {
        throw new UnexecutableReportScopeError(
          'System report execution authority must be org-wide unrestricted',
        );
      }
      break;
    default: {
      const exhaustive: never = authority;
      throw new UnexecutableReportScopeError(
        `Unsupported report execution authority: ${String(exhaustive)}`,
      );
    }
  }
}

function assertRequestedScopeWithinAuthority(
  config: Record<string, unknown>,
  authority: ReportExecutionAuthority,
): void {
  if (authority.scope.kind === 'unrestricted') return;
  if (authority.scope.kind !== 'restricted') {
    throw new UnexecutableReportScopeError();
  }
  const restrictedScope = authority.scope;

  const filters = filtersFor(config);
  const siteIds = asStringArray(filters.siteIds);
  if (siteIds?.some((siteId) => !restrictedScope.siteIds.includes(siteId))) {
    throw new UnexecutableReportScopeError('Requested site is outside report execution authority');
  }

  const postureSiteIds = asStringArray(config.sites);
  if (postureSiteIds?.some((siteId) => !restrictedScope.siteIds.includes(siteId))) {
    throw new UnexecutableReportScopeError('Requested site is outside report execution authority');
  }
}

/** #3198 W02 (addendum B5): the config keys that select orgs, sites or
 *  devices. Absent / null / an empty array all mean "no filter"; anything else
 *  (including a malformed non-array value) is refused on a partner owner. */
const PARTNER_SCOPE_REFUSED_TOP_LEVEL_SELECTORS = ['sites', 'orgId', 'orgIds'] as const;
const PARTNER_SCOPE_REFUSED_FILTER_SELECTORS = ['siteIds', 'deviceIds'] as const;

function selectsSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return !(Array.isArray(value) && value.length === 0);
}

function assertNoPartnerScopeSelectors(config: Record<string, unknown>): void {
  const refused: string[] = PARTNER_SCOPE_REFUSED_TOP_LEVEL_SELECTORS
    .filter((key) => selectsSomething(config?.[key]));
  const filters = config?.filters;
  if (filters !== undefined && filters !== null) {
    if (typeof filters !== 'object' || Array.isArray(filters)) {
      refused.push('filters');
    } else {
      for (const key of PARTNER_SCOPE_REFUSED_FILTER_SELECTORS) {
        if (selectsSomething((filters as Record<string, unknown>)[key])) refused.push(`filters.${key}`);
      }
    }
  }
  if (refused.length > 0) {
    throw new UnexecutableReportScopeError(
      `partner-scope report config cannot select organizations, sites or devices (${refused.join(', ')})`,
    );
  }
}

/**
 * `owner` is the definition's single tenancy axis (#3198 W01). A bare string
 * still means an ORG owner, so every pre-existing caller keeps its exact
 * behaviour (same convention as `decodeSiteScope`).
 */
export function assertReportExecutionPreflight(
  ownerOrOrgId: string | ReportOwner,
  config: Record<string, unknown>,
  authority: ReportGenerationAuthority | null | undefined,
  reportType?: ReportType,
): asserts authority is ReportGenerationAuthority {
  const owner: ReportOwner =
    typeof ownerOrOrgId === 'string' ? { orgId: ownerOrOrgId } : ownerOrOrgId;
  if (owner.partnerId !== undefined) {
    if (
      !authority
      || authority.principalKind !== 'user'
      || !authority.principalUserId
      || authority.scope?.kind !== 'partner_wide'
      || authority.scope.partnerId !== owner.partnerId
    ) {
      throw new UnexecutableReportScopeError('partner authority mismatch');
    }
    // #3198 W02 (addendum B5). A partner-scope generator runs in a context
    // wider than one org, and binds its org set from the LIVE partner
    // membership (`reportScopeFromAuthority`). A stored org/site selector must
    // never widen or re-target that, so any non-empty one is refused rather
    // than silently ignored.
    assertNoPartnerScopeSelectors(config);
    // #3198 W02 (ruling T3e). The denylist stays (every schema is loose, so a
    // parse alone refuses no undeclared key); on top of it the config must be
    // one the report type itself accepts. A stored config its own type rejects
    // never reaches a generator running wider than one org.
    if (reportType !== undefined && !reportTypeDef(reportType).configSchema.safeParse(config).success) {
      throw new UnexecutableReportScopeError(
        `partner-scope report config is not valid for report type ${reportType}`,
      );
    }
    return;
  }
  assertExecutableAuthority(owner.orgId, authority);
  if (
    reportType
    && authority.principalKind === 'portal_user'
    && reportType !== 'executive_summary'
    && reportType !== 'security_compliance_posture'
    && reportType !== 'hardware_lifecycle'
  ) {
    throw new UnexecutableReportScopeError(
      `Portal-user authority cannot generate report type ${reportType}`,
    );
  }
  switch (authority.principalKind) {
    case 'user':
      assertRequestedScopeWithinAuthority(config, authority);
      return;
    case 'portal_user':
      return;
    case 'system':
      // The type gate lives in dispatchReportGeneration, which sees the type on
      // every call; here we only re-assert the scope invariant.
      if (authority.scope.kind !== 'unrestricted') {
        throw new UnexecutableReportScopeError(
          'System report execution authority must be org-wide unrestricted',
        );
      }
      return;
    default: {
      const exhaustive: never = authority;
      throw new UnexecutableReportScopeError(
        `Unsupported report execution authority: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * One `device_inventory` row. Both branches (#4622: agent devices and manual
 * assets) project onto exactly these thirteen columns — a report consumer
 * reads one header row, so a second shape would silently truncate.
 *
 * `deviceId` is null on manual-asset rows: they live in `manualAssets`, not
 * `devices`, and have no device id to give. #5776 — this column (plus the
 * `filters.deviceIds` branch below) replaces the hostname-based post-filter
 * `export_dataset`'s device_inventory adapter used to enforce run-target
 * restriction with, since hostnames are not unique within an org.
 */
type DeviceInventoryRow = {
  deviceId: string | null;
  hostname: string | null;
  displayName: string | null;
  osType: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  status: string | null;
  lastSeenAt: Date | null;
  enrolledAt: Date | null;
  cpuModel: string | null;
  ramTotalMb: number | null;
  diskTotalGb: number | null;
  serialNumber: string | null;
};

/** Shared row query; callers retain their own authority checks and narrowing. */
export async function readDeviceInventoryRows(orgId: string, conditions: SQL[]) {
  return db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      enrolledAt: devices.enrolledAt,
      cpuModel: deviceHardware.cpuModel,
      ramTotalMb: deviceHardware.ramTotalMb,
      diskTotalGb: deviceHardware.diskTotalGb,
      serialNumber: deviceHardware.serialNumber
    })
    .from(devices)
    .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false), ...conditions))
    .orderBy(devices.hostname);
}

export async function generateDeviceInventoryReport(
  orgId: string,
  config: Record<string, unknown>,
  // `ReportGenerationAuthority`, not the request-path union: this generator
  // reads only `authority.scope`, so it is the one existing type that can run
  // under a system authority — which is what lets
  // managedEvidenceFoundations.integration.test.ts prove the #5784 system path
  // end to end on real Postgres before W02 ships the first registry type.
  // Reaching it with a system authority still requires the closed registry to
  // name 'device_inventory', which production never does.
  authority: OrgReportGenerationAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'device_inventory');
  // `isEphemeral = false` on every device predicate in this file: Quick Support
  // devices live in the partner's hidden 'quick_support' org, which deliberately
  // stays inside accessibleOrgIds so RLS lets a tech reach their own session.
  // Nothing filters them out for us — reports must exclude them explicitly.
  const conditions: SQL[] = [eq(devices.orgId, orgId), eq(devices.isEphemeral, false)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.deviceIds && Array.isArray(filters.deviceIds) && filters.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, filters.deviceIds));
  }

  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (addAllowedSiteCondition(conditions, authority)) {
    return emptyRowsReport();
  }

  if (filters?.osTypes && Array.isArray(filters.osTypes) && filters.osTypes.length > 0) {
    conditions.push(inArray(devices.osType, filters.osTypes));
  }

  const data = await readDeviceInventoryRows(orgId, conditions);

  const rows: DeviceInventoryRow[] = [...data];

  // #4622 — hand-entered assets are a third class of inventory and belong in an
  // inventory report. They are projected onto the agent column shape rather
  // than given columns of their own: a report consumer (CSV, PDF, the portal
  // table) reads one header row, and a second shape would silently truncate.
  //
  // An OS-type or device-id filter drops the branch entirely: a hand-entered
  // asset has no OS and no device id to match, so keeping it would widen a
  // report the requester explicitly narrowed.
  const includeManualAssets = filters?.includeManualAssets !== false
    && !(Array.isArray(filters?.osTypes) && filters.osTypes.length > 0)
    && !(Array.isArray(filters?.deviceIds) && filters.deviceIds.length > 0);

  if (includeManualAssets) {
    const manualConditions: SQL[] = [
      eq(manualAssets.orgId, orgId),
      // Retired assets are history, not current inventory.
      isNull(manualAssets.retiredAt),
    ];

    if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
      manualConditions.push(inArray(manualAssets.siteId, filters.siteIds));
    }

    // Applied against manual_assets.site_id, NOT devices.site_id — the branches
    // are independent queries and a site-restricted authority must be honoured
    // in each one.
    addAllowedSiteCondition(manualConditions, authority, manualAssets.siteId);

    const manualData = await db
      .select({
        name: manualAssets.name,
        serialNumber: manualAssets.serialNumber,
        createdAt: manualAssets.createdAt,
      })
      .from(manualAssets)
      .where(and(...manualConditions))
      .orderBy(manualAssets.name);

    for (const asset of manualData) {
      rows.push({
        deviceId: null,
        hostname: asset.name,
        displayName: asset.name,
        osType: null,
        osVersion: null,
        agentVersion: null,
        // Not 'offline': a hand-entered asset has no agent to be offline. The
        // honest answer is that its state is unknown.
        status: 'unknown',
        lastSeenAt: null,
        enrolledAt: asset.createdAt,
        cpuModel: null,
        ramTotalMb: null,
        diskTotalGb: null,
        serialNumber: asset.serialNumber,
      });
    }

    rows.sort((a, b) => (a.hostname ?? '').localeCompare(b.hostname ?? ''));
  }

  return { rows, rowCount: rows.length };
}

/** Shared row query; the org/non-ephemeral predicates are mandatory. */
export async function readSoftwareInventoryRows(orgId: string, conditions: SQL[]) {
  return db
    .select({
      softwareName: deviceSoftware.name,
      version: deviceSoftware.version,
      publisher: deviceSoftware.publisher,
      installDate: deviceSoftware.installDate,
      deviceHostname: devices.hostname
    })
    .from(deviceSoftware)
    .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false), ...conditions))
    .orderBy(deviceSoftware.name, devices.hostname);
}

export async function generateSoftwareInventoryReport(
  orgId: string,
  config: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'software_inventory');
  const conditions: SQL[] = [eq(devices.orgId, orgId), eq(devices.isEphemeral, false)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.deviceIds && Array.isArray(filters.deviceIds) && filters.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, filters.deviceIds));
  }

  if (addAllowedSiteCondition(conditions, authority)) {
    return emptyRowsReport();
  }

  const data = await readSoftwareInventoryRows(orgId, conditions);

  return { rows: data, rowCount: data.length };
}

export async function generateAlertSummaryReport(
  orgId: string,
  config: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'alert_summary');
  const conditions: SQL[] = [eq(alerts.orgId, orgId)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.severity && Array.isArray(filters.severity) && filters.severity.length > 0) {
    conditions.push(inArray(alerts.severity, filters.severity));
  }

  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, authority);
  if (allowedDeviceIds && authority.scope.kind === 'restricted') {
    if (authority.scope.siteIds.length === 0) {
      return { rows: [], rowCount: 0, summary: {} };
    }
    // Device alerts by in-scope device; site-owned topology alerts by their
    // owning topology site (M3-D6), never the origin device's site.
    conditions.push(alertSiteScopeByDeviceIds({ allowedSiteIds: authority.scope.siteIds, allowedDeviceIds })!);
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      title: alerts.title,
      severity: alerts.severity,
      status: alerts.status,
      triggeredAt: alerts.triggeredAt,
      acknowledgedAt: alerts.acknowledgedAt,
      resolvedAt: alerts.resolvedAt,
      deviceHostname: devices.hostname,
      ruleName: alertRules.name
    })
    .from(alerts)
    .leftJoin(devices, eq(alerts.deviceId, devices.id))
    .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
    .where(whereCondition)
    .orderBy(desc(alerts.triggeredAt));

  // Summary stats
  const summary = await db
    .select({
      severity: alerts.severity,
      count: sql<number>`count(*)`
    })
    .from(alerts)
    .where(whereCondition)
    .groupBy(alerts.severity);

  return {
    rows: data,
    rowCount: data.length,
    summary: Object.fromEntries(summary.map(s => [s.severity, Number(s.count)]))
  };
}

export async function generateComplianceReport(
  orgId: string,
  config: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'compliance');
  const conditions: SQL[] = [eq(devices.orgId, orgId), eq(devices.isEphemeral, false)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (addAllowedSiteCondition(conditions, authority)) {
    return {
      rows: [],
      rowCount: 0,
      summary: {
        totalDevices: 0,
        compliantDevices: 0,
        nonCompliantDevices: 0,
        complianceRate: 100
      }
    };
  }

  const whereCondition = and(...conditions);

  // Get device compliance status
  const deviceList = await db
    .select({
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(whereCondition)
    .orderBy(devices.hostname);

  // Determine compliance status for each device
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const rows = deviceList.map(device => ({
    ...device,
    isCompliant: device.status !== 'decommissioned' &&
      device.lastSeenAt != null &&
      new Date(device.lastSeenAt) > sevenDaysAgo,
    issues: [
      device.status === 'offline' ? 'Device offline' : null,
      device.lastSeenAt && new Date(device.lastSeenAt) < sevenDaysAgo ? 'Not seen in 7+ days' : null
    ].filter(Boolean)
  }));

  const compliantCount = rows.filter(r => r.isCompliant).length;

  return {
    rows,
    rowCount: rows.length,
    summary: {
      totalDevices: rows.length,
      compliantDevices: compliantCount,
      nonCompliantDevices: rows.length - compliantCount,
      complianceRate: rows.length > 0 ? Math.round((compliantCount / rows.length) * 100) : 100
    }
  };
}

export async function generatePerformanceReport(
  orgId: string,
  config: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'performance');
  const deviceConditions: SQL[] = [eq(devices.orgId, orgId), eq(devices.isEphemeral, false)];
  if (addAllowedSiteCondition(deviceConditions, authority)) {
    return emptyRowsReport();
  }

  const orgDevices = await db
    .select({ id: devices.id, hostname: devices.hostname })
    .from(devices)
    .where(and(...deviceConditions));

  const deviceIds = orgDevices.map(d => d.id);

  if (deviceIds.length === 0) {
    return { rows: [], rowCount: 0 };
  }

  const conditions: SQL[] = [inArray(deviceMetrics.deviceId, deviceIds)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(deviceMetrics.timestamp, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(deviceMetrics.timestamp, new Date(dateRange.end)));
  }

  const whereCondition = and(...conditions);

  // Get aggregated metrics per device
  const data = await db
    .select({
      deviceId: deviceMetrics.deviceId,
      hostname: devices.hostname,
      avgCpu: sql<number>`avg(${deviceMetrics.cpuPercent})`,
      maxCpu: sql<number>`max(${deviceMetrics.cpuPercent})`,
      avgRam: sql<number>`avg(${deviceMetrics.ramPercent})`,
      maxRam: sql<number>`max(${deviceMetrics.ramPercent})`,
      avgDisk: sql<number>`avg(${deviceMetrics.diskPercent})`,
      maxDisk: sql<number>`max(${deviceMetrics.diskPercent})`
    })
    .from(deviceMetrics)
    .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
    .where(whereCondition)
    .groupBy(deviceMetrics.deviceId, devices.hostname)
    .orderBy(devices.hostname);

  const rows = data.map(d => ({
    hostname: d.hostname,
    avgCpu: Math.round(d.avgCpu * 10) / 10,
    maxCpu: Math.round(d.maxCpu * 10) / 10,
    avgRam: Math.round(d.avgRam * 10) / 10,
    maxRam: Math.round(d.maxRam * 10) / 10,
    avgDisk: Math.round(d.avgDisk * 10) / 10,
    maxDisk: Math.round(d.maxDisk * 10) / 10
  }));

  return { rows, rowCount: rows.length };
}

export async function generateExecutiveSummaryReport(
  orgId: string,
  config: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
) {
  assertReportExecutionPreflight(orgId, config, authority, 'executive_summary');
  if (authority.scope.kind === 'restricted' && authority.scope.siteIds.length === 0) {
    return zeroSafeReport('executive_summary', orgId);
  }
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const dateRange = config.dateRange as Record<string, string> | undefined;
  const deviceConditions: SQL[] = [eq(devices.orgId, orgId), eq(devices.isEphemeral, false)];
  const emptyDeviceScope = addAllowedSiteCondition(deviceConditions, authority);
  const deviceWhereCondition = and(...deviceConditions);

  // Device stats
  const deviceStats = emptyDeviceScope
    ? [{ total: 0, online: 0, offline: 0 }]
    : await db
      .select({
        total: sql<number>`count(*)`,
        online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
        offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`
      })
      .from(devices)
      .where(deviceWhereCondition);

  // Alert stats
  const alertConditions: SQL[] = [eq(alerts.orgId, orgId)];
  if (dateRange?.start) {
    alertConditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    alertConditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, authority);
  const restrictedSiteIds = allowedDeviceIds && authority.scope.kind === 'restricted' ? authority.scope.siteIds : null;
  if (allowedDeviceIds && restrictedSiteIds) {
    // Site-owned topology alerts follow their owning topology site (M3-D6).
    alertConditions.push(alertSiteScopeByDeviceIds({ allowedSiteIds: restrictedSiteIds, allowedDeviceIds })!);
  }

  const alertStats = restrictedSiteIds?.length === 0
    ? [{ total: 0, critical: 0, high: 0, resolved: 0 }]
    : await db
      .select({
        total: sql<number>`count(*)`,
        critical: sql<number>`sum(case when ${alerts.severity} = 'critical' then 1 else 0 end)`,
        high: sql<number>`sum(case when ${alerts.severity} = 'high' then 1 else 0 end)`,
        resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`
      })
      .from(alerts)
      .where(and(...alertConditions));

  // OS distribution
  const osDistribution = emptyDeviceScope
    ? []
    : await db
      .select({
        osType: devices.osType,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(deviceWhereCondition)
      .groupBy(devices.osType);

  // Site breakdown
  const siteBreakdown = emptyDeviceScope
    ? []
    : await db
      .select({
        siteName: sites.name,
        deviceCount: sql<number>`count(*)`
      })
      .from(devices)
      .innerJoin(sites, eq(devices.siteId, sites.id))
      .where(deviceWhereCondition)
      .groupBy(sites.name)
      .orderBy(desc(sql`count(*)`));

  return {
    summary: {
      org: { id: orgId, name: orgRow?.name ?? '' },
      devices: {
        total: Number(deviceStats[0]?.total ?? 0),
        online: Number(deviceStats[0]?.online ?? 0),
        offline: Number(deviceStats[0]?.offline ?? 0),
        healthPercentage: deviceStats[0]?.total
          ? Math.round((Number(deviceStats[0]?.online ?? 0) / Number(deviceStats[0]?.total)) * 100)
          : 100
      },
      alerts: {
        total: Number(alertStats[0]?.total ?? 0),
        critical: Number(alertStats[0]?.critical ?? 0),
        high: Number(alertStats[0]?.high ?? 0),
        resolved: Number(alertStats[0]?.resolved ?? 0),
        resolutionRate: alertStats[0]?.total
          ? Math.round((Number(alertStats[0]?.resolved ?? 0) / Number(alertStats[0]?.total)) * 100)
          : 100
      },
      osDistribution: Object.fromEntries(osDistribution.map(o => [o.osType, Number(o.count)])),
      siteBreakdown: siteBreakdown.map(s => ({ site: s.siteName, count: Number(s.deviceCount) }))
    } satisfies ExecutiveSummary,
    generatedAt: new Date().toISOString()
  };
}

/**
 * The occurrence-derived window an evidence run covers, passed in rather than
 * derived from `now()` (#5784, OD-11 = A). Absent for an ordinary staff-initiated
 * run, in which case the generator falls back to its config's date range.
 */
export type EvidenceRunContext = {
  /** Occurrence `period_start` (ISO date, inclusive). */
  periodStart: string;
  /** Occurrence `period_end` (ISO date, inclusive) — equals the due date. */
  periodEnd: string;
  /** When generation actually ran. Generation stays on the DUE DAY, so this is
   *  normally EARLIER than `periodEnd` ends; the artifact must say so. */
  generatedAt: string;
  /** The deliverable this run is evidence for; the baseline selector's key. */
  deliverableId: string;
};

/**
 * ONE dispatcher for both execution paths. The 14-arm switch this replaced is
 * now `REPORT_GENERATORS` (#3198 spec §6); exhaustiveness is preserved because
 * the record is keyed by the closed `ReportType` union — a missing key is a
 * compile error, the same guarantee the switch's `never` default gave.
 * `zeroSafeReport` still ends in a `never` default. A system authority is
 * refused here for any type the closed MANAGED_EVIDENCE_REGISTRY does not name
 * (#5784 OD-5 = B; the registry test pins that set equal to the entries whose
 * `execution` is 'managed_evidence').
 *
 * GATE ORDER IS LOAD-BEARING. `supportedScopes` is checked immediately after
 * the system-authority refusal and BEFORE `assertReportExecutionPreflight`:
 * the preflight compares the authority's owner axis against the report's, so
 * a partner scope against an org-only type would die there as an authority
 * mismatch — a 403 shape — instead of the 400 `unsupported_report_scope` the
 * routes translate.
 *
 * `evidence` is threaded to generators that accept it (the #5784 types); the
 * existing generators do not take it.
 */
async function dispatchReportGeneration(
  type: ReportType,
  scope: ReportScope,
  config: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const def = reportTypeDef(type);

  // Gated on the closed MANAGED_EVIDENCE_REGISTRY itself (unchanged from the
  // switch this replaced), not on `def.execution`: reportRegistry.test.ts pins
  // the two sets equal, and the registry is what integration suites stand a
  // type into (managedEvidenceFoundations mocks it with device_inventory).
  if (authority?.principalKind === 'system' && !isManagedEvidenceType(type)) {
    throw new UnexecutableReportScopeError(
      `${type} is not a managed evidence type and cannot run under system authority`,
    );
  }

  // BEFORE the preflight — see the gate-order note above.
  if (!def.supportedScopes.includes(scope.kind)) {
    throw new UnsupportedReportScopeError(type, scope.kind);
  }

  assertReportExecutionPreflight(reportOwnerOfScope(scope), config, authority, type);
  if (
    authority.principalKind === 'portal_user'
    && type !== 'executive_summary'
    && type !== 'security_compliance_posture'
    && type !== 'hardware_lifecycle'
  ) {
    throw new UnexecutableReportScopeError(
      `Portal-user authority cannot generate report type ${type}`,
    );
  }
  if (authority.scope.kind === 'restricted' && authority.scope.siteIds.length === 0) {
    return zeroSafeReport(type, authority.scope.orgId);
  }
  // #3198 W02 ruling T7a: tickets, time entries and invoices have no site
  // axis, so a site-restricted authority with ANY number of sites would read
  // the whole org through a business generator. Zero-safe it here for every
  // business type; each generator also refuses it (defense in depth).
  if (authority.scope.kind === 'restricted' && isBusinessReportType(type)) {
    return zeroSafeReport(type, authority.scope.orgId);
  }

  return def.generate(scope, config, authority, evidence);
}

/** Dispatch to the matching report generator by type (request path).
 *
 *  #3198 W02 (spec §3.2, ruling P10): the second parameter is a `ReportScope`,
 *  not an org id. Org-scope call sites read
 *  `generateReport(type, organizationScope(orgId), config, authority)`; a
 *  partner scope comes only from `reportScopeFromAuthority`. */
export async function generateReport(
  type: ReportType,
  scope: ReportScope,
  config: Record<string, unknown>,
  authority: ReportExecutionAuthority,
): Promise<ReportResult> {
  return dispatchReportGeneration(type, scope, config, authority);
}

/**
 * The managed-evidence execution path (#5784, OD-5 = B). The ONLY entry point
 * that accepts a `SystemReportExecutionAuthority`, and it accepts one only for a
 * type the closed `MANAGED_EVIDENCE_REGISTRY` names. An org-owned recurring
 * obligation must not stop producing evidence because one technician changed
 * jobs, which is what the user-principal path did.
 *
 * Signature UNCHANGED by #3198: managed evidence is org-owned by construction
 * (a service deliverable belongs to one customer), so it keeps taking an org id
 * and builds the scope itself.
 */
export async function generateManagedEvidenceReport(
  type: ManagedEvidenceType,
  orgId: string,
  config: Record<string, unknown>,
  evidence: EvidenceRunContext | undefined,
): Promise<ReportResult> {
  if (!isManagedEvidenceType(type)) {
    throw new UnexecutableReportScopeError(`${type} is not a managed evidence type`);
  }
  return dispatchReportGeneration(
    type, organizationScope(orgId), config, systemReportAuthorityFor(orgId), evidence,
  );
}

const BUSINESS_REPORT_TYPE_SET: ReadonlySet<string> = new Set(BUSINESS_REPORT_TYPES);
function isBusinessReportType(type: ReportType): boolean {
  return BUSINESS_REPORT_TYPE_SET.has(type);
}

function zeroSafeReport(type: ReportType, orgId: string): ReportResult {
  switch (type) {
    case 'alert_summary':
      return { rows: [], rowCount: 0, summary: {} };
    case 'compliance':
      return {
        rows: [],
        rowCount: 0,
        summary: {
          totalDevices: 0,
          compliantDevices: 0,
          nonCompliantDevices: 0,
          complianceRate: 100,
        },
      };
    case 'executive_summary':
      return {
        summary: {
          org: { id: orgId, name: '' },
          devices: { total: 0, online: 0, offline: 0, healthPercentage: 100 },
          alerts: { total: 0, critical: 0, high: 0, resolved: 0, resolutionRate: 100 },
          osDistribution: {},
          siteBreakdown: [],
        },
        generatedAt: new Date().toISOString(),
      };
    case 'device_inventory':
    case 'software_inventory':
    case 'performance':
    case 'security_compliance_posture':
    case 'hardware_lifecycle':
    // #5784 W02 — NOT stored-artifact-only: a restricted authority with zero
    // sites gets an empty-but-shaped result rather than a throw.
    case 'threat_detection_review':
    // #5784 W06 — NOT stored-artifact-only either. This arm is load-bearing for
    // identity_access_review in a way it is not for the types above: the
    // generator routes EVERY restricted authority into the same empty-but-shaped
    // result, not only the zero-sites case.
    case 'identity_access_review':
      return emptyRowsReport();
    // #5784 W03 — generated on demand, so a restricted-empty authority gets a
    // zero-safe shape rather than a stored-artifact refusal. It needs its OWN
    // case, not `emptyRowsReport()`: that returns no `summary` at all, and
    // `buildReportPdf`'s endpoint-management arm is guarded on the summary
    // being present, so the artifact would fall through to renderGenericReport
    // and print one line — "No data available for the selected filters" — which
    // reads as "nothing to report" to a technician whose real situation is
    // "your access scope contains no sites". This short-circuit runs BEFORE the
    // dispatch switch, so the generator's own empty branch never sees it.
    case 'endpoint_management_review':
      return {
        rows: [],
        rowCount: 0,
        summary: emptyEndpointManagementSummary({
          orgId,
          generatedAt: new Date().toISOString(),
          thresholdDays: ENDPOINT_MANAGEMENT_DEFAULT_STALE_DAYS,
          dataGap: ENDPOINT_MANAGEMENT_NO_SITES_GAP,
        }) as unknown as Record<string, unknown>,
      };
    // #5784 W04. NOT `emptyRowsReport()`: that returns no `summary`, and
    // `buildReportPdf`'s vulnerability_management arm requires one — a
    // summary-less result falls through to `renderGenericReport`, which prints
    // "No data available for the selected filters.", phrasing indistinguishable
    // from "we checked every device and found none". A site-restricted
    // authority with zero sites queried nothing, so the counts are NOT
    // MEASURED and the artifact says which of the two happened.
    case 'vulnerability_management': {
      const generatedAt = new Date().toISOString();
      return {
        rows: [],
        rowCount: 0,
        generatedAt,
        summary: emptyVulnerabilityManagementSummary(
          orgId,
          generatedAt,
          'This report ran under a site-restricted authority with no sites in scope, so no device was queried. The counts below are not measured — they are not zero.',
        ) as unknown as Record<string, unknown>,
      };
    }
    // P2-3 (#4190) — refused HERE too, not only in the dispatch switch above.
    // A restricted-empty authority short-circuits into this function before
    // dispatch ever runs, and an empty zero-safe shape would read as "the
    // narrative is empty" for a document that exists and is downloadable.
    case 'ai_org_narrative':
      throw new StoredArtifactOnlyReportError(type);
    // Fleet Designer W01 (#5651) — refused HERE too, same reason as above.
    case 'ai_fleet_design':
      throw new StoredArtifactOnlyReportError(type);
    // #3198 W02. Tickets, time entries and invoices carry no site axis, so a
    // site-restricted authority queried NOTHING. Each empty*Summary() prints
    // that sentence on the artifact rather than a reassuring zero — a zero here
    // would read as "you had no overdue invoices", which is a lie.
    case 'ticket_sla_attainment':
      return { rows: [], rowCount: 0, summary: emptyTicketSlaSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
    case 'technician_time_billability':
      return { rows: [], rowCount: 0, summary: emptyTechnicianTimeSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
    case 'ar_aging':
      return { rows: [], rowCount: 0, summary: emptyArAgingSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
    default: {
      const exhaustive: never = type;
      throw new Error(`Invalid report type: ${String(exhaustive)}`);
    }
  }
}
