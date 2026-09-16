/**
 * Threat Detection Review report (#5784 W02) — the service-plan evidence
 * artifact for a Huntress-monitored month.
 *
 * WHAT IT IS. A record of the threat detections Breeze *holds* for the
 * occurrence's period, with the window it actually covers printed on the face
 * of it. It is generated review EVIDENCE, not a claim that a human reviewed
 * anything: the review record is the technician resolving the ticket.
 *
 * THREE RULES THIS MODULE EXISTS TO KEEP.
 *
 *  1. PERSISTED DATA ONLY. No Huntress HTTP call happens here. A run triggered
 *     by the nightly deliverable sweep must be deterministic and must not
 *     couple artifact generation to a third party's availability. Freshness is
 *     a property the artifact PRINTS, never something it fetches.
 *
 *  2. UNMEASURED IS NOT ZERO. When the org's partner has no active
 *     `huntress_integrations` row — or has one that has never synced — every
 *     count is `null` and the artifact renders as a data-gap page. Printing
 *     "0 incidents" for a source that was never connected is a lie the
 *     customer will act on.
 *
 *  3. COMPLETENESS IS NEVER CLAIMED. The first Huntress sync fetches 24 hours
 *     only (`DEFAULT_LOOKBACK_MS`, jobs/huntressSync.ts) and later runs resume
 *     from `lastSyncAt - 60s`, so a period beginning before the integration was
 *     connected is covered in part. `coverage.coveredFrom` is the earliest
 *     `reported_at` actually held and `coveredTo` is `last_sync_at`;
 *     `coverageGapLine` turns the difference into one printed sentence.
 *
 * SITE SCOPE is pushed independently in every query branch. A device-id list
 * computed once and reused is how a branch silently loses its filter when
 * someone edits one query later. Under a RESTRICTED authority an incident with
 * a NULL `device_id` is unattributable — it cannot be proven to belong to a
 * site the reader may see — so it is excluded and the excluded count is
 * disclosed in `coverage.unattributableExcluded`.
 *
 * The raw `details` jsonb is NEVER selected, let alone rendered: it is
 * `excludedOpen` in the tenant export policy for exactly this reason. Section 3
 * shows Huntress's normalized `recommendation` text instead.
 */
import { and, eq, gte, inArray, isNotNull, lte, min, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  huntressAgents,
  huntressIncidents,
  huntressIntegrations,
  organizations,
} from '../db/schema';
import { threatDetectionConfigSchema } from '../routes/reports/schemas';
import type {
  ThreatCoverage,
  ThreatDetectionSummary,
  ThreatIncidentRow,
  ThreatSourceStatus,
} from '@breeze/shared';
import { countBy, coverageGapLine, resolutionStats } from '@breeze/shared';
import { HUNTRESS_OFFLINE_STATUSES, HUNTRESS_RESOLVED_STATUSES } from './huntressConstants';
import {
  assertReportExecutionPreflight,
  type EvidenceRunContext,
  type ReportResult,
} from './reportGenerationService';
import type { ReportGenerationAuthority } from './siteScope';

/** A sync older than this makes the source `stale`: the artifact still prints
 *  what it holds, but says plainly that anything after the last sync is not in
 *  it. Two days rather than one, so a single missed nightly run does not cry
 *  wolf on an otherwise healthy integration. */
const STALE_SYNC_MS = 48 * 60 * 60 * 1000;

type SiteFilter = {
  /** Sites the config narrowed to, if any. */
  configSites: string[];
  /** Sites the authority permits, when the authority is restricted. */
  authoritySites: string[] | null;
};

/**
 * The site predicates for ONE query branch, applied to that branch's own
 * `devices.site_id` column. Returns an empty array when nothing narrows —
 * never a cached device-id list.
 */
function sitePredicates(filter: SiteFilter) {
  const conditions = [];
  if (filter.configSites.length > 0) conditions.push(inArray(devices.siteId, filter.configSites));
  if (filter.authoritySites) conditions.push(inArray(devices.siteId, filter.authoritySites));
  return conditions;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Inclusive period end: a `YYYY-MM-DD` end date means the whole of that day. */
function endOfDay(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T23:59:59.999Z`);
}

function startOfDay(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * The window to report on. `EvidenceRunContext` wins whenever it is present —
 * the occurrence's period is the contract, and deriving one from `now()` would
 * make a re-run of a late occurrence quietly report a different month. An
 * ad-hoc staff run falls back to the config's date range, and failing that to
 * the trailing 30 days, and says which in `coverage`.
 */
function resolveWindow(
  evidence: EvidenceRunContext | undefined,
  rawConfig: Record<string, unknown>,
  generatedAt: string,
): { start: Date; end: Date; periodStart: string; periodEnd: string } {
  if (evidence?.periodStart && evidence?.periodEnd) {
    return {
      start: startOfDay(evidence.periodStart),
      end: endOfDay(evidence.periodEnd),
      periodStart: evidence.periodStart,
      periodEnd: evidence.periodEnd,
    };
  }
  const range = (rawConfig?.dateRange ?? {}) as { start?: string; end?: string };
  const end = range.end ? endOfDay(range.end) : new Date(generatedAt);
  const start = range.start
    ? startOfDay(range.start)
    : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

/**
 * The whole-report data gap. Every HUNTRESS-derived count is null because it
 * was not measured — but `breezeDevices` is Breeze's own, site-scoped count and
 * stays a real number, so the reader learns how large the unmonitored fleet is
 * instead of being shown nothing at all.
 */
function emptySummary(
  orgId: string,
  orgName: string | null,
  generatedAt: string,
  coverage: ThreatCoverage,
  breezeDevices: number | null,
): ThreatDetectionSummary {
  const note = coverageGapLine(coverage);
  return {
    orgId,
    orgName,
    generatedAt,
    coverage: { ...coverage, note },
    // Every count null: nothing was measured, and zero would read as "clean".
    agentCoverage: {
      huntressAgents: null,
      breezeDevices,
      agentsOffline: null,
      devicesWithoutAgent: null,
    },
    incidents: {
      opened: null,
      resolved: null,
      bySeverity: null,
      byStatus: null,
      meanResolveHours: null,
      medianResolveHours: null,
      carriedIn: null,
    },
    rows: [],
    dataGaps: note ? [note] : [],
  } satisfies ThreatDetectionSummary;
}

type WindowIncident = {
  id: string;
  deviceId: string | null;
  severity: string | null;
  status: string | null;
  reportedAt: Date | string | null;
  resolvedAt: Date | string | null;
};

type DetailIncident = WindowIncident & {
  hostname: string | null;
  category: string | null;
  title: string | null;
  recommendation: string | null;
};

function toIncidentRow(row: DetailIncident, carriedIn = false): ThreatIncidentRow {
  return {
    id: row.id,
    reportedAt: isoOrNull(row.reportedAt) ?? '',
    hostname: row.hostname ?? null,
    severity: row.severity ?? null,
    category: row.category ?? null,
    title: row.title ?? null,
    status: row.status ?? null,
    resolvedAt: isoOrNull(row.resolvedAt),
    recommendation: row.recommendation ?? null,
    ...(carriedIn ? { carriedIn: true } : {}),
  };
}

export async function generateThreatDetectionReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const cfg = threatDetectionConfigSchema.parse(rawConfig ?? {});
  const generatedAt = evidence?.generatedAt ?? new Date().toISOString();

  assertReportExecutionPreflight(orgId, cfg, authority, 'threat_detection_review');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  const window = resolveWindow(evidence, rawConfig ?? {}, generatedAt);
  const baseCoverage: ThreatCoverage = {
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    generatedAt,
  };

  // A restricted authority with no sites can see nothing. Empty-but-shaped
  // rather than a throw: the reader has a legitimate, empty scope.
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgId, null, generatedAt, {
        ...baseCoverage,
        sourceStatus: 'not_connected',
        unattributableExcluded: 0,
        withheld: 0,
      }, 0) as unknown as Record<string, unknown>,
    };
  }

  const filter: SiteFilter = {
    configSites: cfg.sites,
    authoritySites: restrictedScope ? restrictedScope.siteIds : null,
  };

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const orgName = orgRow?.name ?? null;

  // --- 1. Breeze's own fleet, site-scoped -------------------------------------
  // Run BEFORE the source check so the restricted site scope reaches a query on
  // every path, including the data-gap paths below — a report that returns
  // early without ever binding the reader's scope has not been proven to honour
  // it (reportGenerationService.test.ts pins this for every report type).
  const deviceConditions = [eq(devices.orgId, orgId), ...sitePredicates(filter)];
  const deviceRows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(...deviceConditions));

  // --- 2. Source availability -------------------------------------------------
  // `huntress_integrations` is PARTNER-scoped; incidents and agents are
  // ORG-scoped. The partner axis is read for FRESHNESS only — never to widen
  // which rows the report may see.
  const [integration] = orgRow?.partnerId
    ? await db
      .select({
        id: huntressIntegrations.id,
        lastSyncAt: huntressIntegrations.lastSyncAt,
        lastSyncStatus: huntressIntegrations.lastSyncStatus,
      })
      .from(huntressIntegrations)
      .where(and(
        eq(huntressIntegrations.partnerId, orgRow.partnerId),
        eq(huntressIntegrations.isActive, true),
      ))
      .limit(1)
    : [];

  if (!integration) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgId, orgName, generatedAt, {
        ...baseCoverage,
        sourceStatus: 'not_connected',
        lastSyncAt: null,
        lastSyncStatus: null,
        unattributableExcluded: 0,
        withheld: 0,
      }, deviceRows.length) as unknown as Record<string, unknown>,
    };
  }

  const lastSyncAt = isoOrNull(integration.lastSyncAt);
  if (!lastSyncAt) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgId, orgName, generatedAt, {
        ...baseCoverage,
        sourceStatus: 'never_synced',
        lastSyncAt: null,
        lastSyncStatus: integration.lastSyncStatus ?? null,
        unattributableExcluded: 0,
        withheld: 0,
      }, deviceRows.length) as unknown as Record<string, unknown>,
    };
  }

  const sourceStatus: ThreatSourceStatus =
    Date.parse(generatedAt) - Date.parse(lastSyncAt) > STALE_SYNC_MS ? 'stale' : 'ok';

  // --- 3. Agent coverage ------------------------------------------------------
  // Its OWN site predicates, joined through devices. A Huntress agent with no
  // matched Breeze device cannot be site-scoped, so under a restricted
  // authority it is not counted — the same unattributable rule as incidents.
  const agentConditions = [eq(huntressAgents.orgId, orgId)];
  const agentSitePredicates = sitePredicates(filter);
  if (agentSitePredicates.length > 0) agentConditions.push(...agentSitePredicates);
  const agentRows = await db
    .select({ deviceId: huntressAgents.deviceId, status: huntressAgents.status })
    .from(huntressAgents)
    .leftJoin(devices, eq(huntressAgents.deviceId, devices.id))
    .where(and(...agentConditions));

  const agentDeviceIds = new Set(
    agentRows.map((a) => a.deviceId).filter((id): id is string => Boolean(id)),
  );
  const offlineStatuses = new Set<string>(HUNTRESS_OFFLINE_STATUSES);
  const agentCoverage = {
    huntressAgents: agentRows.length,
    breezeDevices: deviceRows.length,
    agentsOffline: agentRows.filter((a) => a.status && offlineStatuses.has(a.status)).length,
    devicesWithoutAgent: deviceRows.filter((d) => !agentDeviceIds.has(d.id)).length,
  };

  // --- 4. Incidents opened in the window --------------------------------------
  // Metrics come from the FULL window set, never from the capped table below —
  // a summary computed off the visible rows would understate a noisy month by
  // exactly the number withheld.
  const windowConditions = [
    eq(huntressIncidents.orgId, orgId),
    gte(huntressIncidents.reportedAt, window.start),
    lte(huntressIncidents.reportedAt, window.end),
    ...sitePredicates(filter),
  ];
  if (restrictedScope) windowConditions.push(isNotNull(huntressIncidents.deviceId));
  const windowRows = (await db
    .select({
      id: huntressIncidents.id,
      deviceId: huntressIncidents.deviceId,
      severity: huntressIncidents.severity,
      status: huntressIncidents.status,
      reportedAt: huntressIncidents.reportedAt,
      resolvedAt: huntressIncidents.resolvedAt,
    })
    .from(huntressIncidents)
    .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
    .where(and(...windowConditions))) as WindowIncident[];

  // Under a restricted authority the query above already excluded NULL-device
  // incidents; count them separately so the exclusion is DISCLOSED rather than
  // silent. Under an unrestricted authority nothing is excluded.
  const attributable = restrictedScope
    ? windowRows.filter((r) => r.deviceId !== null)
    : windowRows;
  const unattributableExcluded = restrictedScope
    ? windowRows.filter((r) => r.deviceId === null).length
    : 0;

  const resolvedStatuses = new Set<string>(HUNTRESS_RESOLVED_STATUSES);
  const resolvedCount = attributable.filter(
    (r) => r.resolvedAt !== null || (r.status !== null && resolvedStatuses.has(r.status)),
  ).length;
  const stats = resolutionStats(
    attributable.map((r) => ({
      reportedAt: isoOrNull(r.reportedAt),
      resolvedAt: isoOrNull(r.resolvedAt),
    })),
  );

  // --- 5. The incident table, capped ------------------------------------------
  const detailConditions = [...windowConditions];
  const detailRows = (await db
    .select({
      id: huntressIncidents.id,
      deviceId: huntressIncidents.deviceId,
      hostname: devices.hostname,
      severity: huntressIncidents.severity,
      category: huntressIncidents.category,
      title: huntressIncidents.title,
      status: huntressIncidents.status,
      reportedAt: huntressIncidents.reportedAt,
      resolvedAt: huntressIncidents.resolvedAt,
      // `details` is deliberately absent: excludedOpen, never rendered.
      recommendation: huntressIncidents.recommendation,
    })
    .from(huntressIncidents)
    .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
    .where(and(...detailConditions))
    .orderBy(sql`${huntressIncidents.reportedAt} DESC`)
    .limit(cfg.topIncidents)) as DetailIncident[];

  const visibleRows = detailRows
    .filter((r) => !restrictedScope || r.deviceId !== null)
    .slice(0, cfg.topIncidents)
    .map((r) => toIncidentRow(r));
  const withheld = Math.max(0, attributable.length - visibleRows.length);

  // --- 6. Carried in: opened BEFORE the period and still unresolved ------------
  let carriedInRows: ThreatIncidentRow[] = [];
  let carriedInCount: number | null = null;
  if (cfg.includeCarriedIn) {
    const carriedConditions = [
      eq(huntressIncidents.orgId, orgId),
      sql`${huntressIncidents.reportedAt} < ${window.start}`,
      sql`${huntressIncidents.resolvedAt} IS NULL`,
      ...sitePredicates(filter),
    ];
    if (restrictedScope) carriedConditions.push(isNotNull(huntressIncidents.deviceId));
    const carried = (await db
      .select({
        id: huntressIncidents.id,
        deviceId: huntressIncidents.deviceId,
        hostname: devices.hostname,
        severity: huntressIncidents.severity,
        category: huntressIncidents.category,
        title: huntressIncidents.title,
        status: huntressIncidents.status,
        reportedAt: huntressIncidents.reportedAt,
        resolvedAt: huntressIncidents.resolvedAt,
        recommendation: huntressIncidents.recommendation,
      })
      .from(huntressIncidents)
      .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
      .where(and(...carriedConditions))
      .orderBy(sql`${huntressIncidents.reportedAt} DESC`)
      .limit(cfg.topIncidents)) as DetailIncident[];
    carriedInRows = carried
      .filter((r) => !restrictedScope || r.deviceId !== null)
      .map((r) => toIncidentRow(r, true));
    carriedInCount = carriedInRows.length;
  }

  // --- 7. The window actually covered -----------------------------------------
  const earliestConditions = [eq(huntressIncidents.orgId, orgId), ...sitePredicates(filter)];
  const [earliestRow] = await db
    .select({ earliest: min(huntressIncidents.reportedAt) })
    .from(huntressIncidents)
    .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
    .where(and(...earliestConditions));

  const coverage: ThreatCoverage = {
    ...baseCoverage,
    coveredFrom: isoOrNull(earliestRow?.earliest as Date | string | null | undefined),
    coveredTo: lastSyncAt,
    sourceStatus,
    lastSyncAt,
    lastSyncStatus: integration.lastSyncStatus ?? null,
    unattributableExcluded,
    withheld,
  };
  coverage.note = coverageGapLine(coverage);

  const summary: ThreatDetectionSummary = {
    orgId,
    orgName,
    generatedAt,
    coverage,
    agentCoverage,
    incidents: {
      opened: attributable.length,
      resolved: resolvedCount,
      bySeverity: countBy(attributable as unknown as Record<string, unknown>[], 'severity'),
      byStatus: countBy(attributable as unknown as Record<string, unknown>[], 'status'),
      meanResolveHours: stats.meanResolveHours,
      medianResolveHours: stats.medianResolveHours,
      carriedIn: carriedInCount,
    },
    rows: [...visibleRows, ...carriedInRows],
    dataGaps: coverage.note ? [coverage.note] : [],
  } satisfies ThreatDetectionSummary;

  return {
    rows: visibleRows as unknown as Record<string, unknown>[],
    rowCount: visibleRows.length,
    generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}
