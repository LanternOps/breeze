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
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, min } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  huntressAgents,
  huntressIncidents,
  huntressIntegrations,
  organizations,
} from '../db/schema';
import { threatDetectionConfigSchema } from './reportConfigSchemas';
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
import type { OrgReportGenerationAuthority } from './siteScope';

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
  authority: OrgReportGenerationAuthority,
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
  //
  // `dispatchReportGeneration` short-circuits this case into `zeroSafeReport`
  // before the generator is reached, so this is defensive today — but it must
  // not lie if a later path calls the generator directly. The reason the result
  // is empty is the READER'S SCOPE, not source availability, so the note says
  // that rather than reusing `coverageGapLine`'s "Huntress is not connected"
  // sentence, which would blame the wrong thing.
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    const scopeNote = 'This report covers no sites, because the account viewing it has access to none. It is not a statement about threat detection.';
    const scoped = emptySummary(orgId, null, generatedAt, {
      ...baseCoverage,
      unattributableExcluded: 0,
      withheld: 0,
    }, 0);
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: {
        ...scoped,
        coverage: { ...scoped.coverage, note: scopeNote },
        dataGaps: [scopeNote],
      } as unknown as Record<string, unknown>,
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
  // A missing org is a DATA-INTEGRITY failure, not a configuration state. Left
  // alone it would fall through to the partner lookup below with an undefined
  // partnerId, short-circuit to `not_connected`, and tell the reader "Huntress
  // is not connected for this partner" — a sentence that blames the customer's
  // setup for a deleted tenant and is indistinguishable from the routine case.
  // It is surfaced to operators here and labelled honestly in the artifact
  // below rather than thrown, because the generator must still return the
  // empty-but-shaped result its callers (and the per-type site-scope contract
  // test) expect.
  const orgMissing = !orgRow;
  if (orgMissing) {
    console.error('[threatDetectionReport] organization not found; reporting a data-integrity gap', { orgId });
  }
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
        // The floor on what could POSSIBLY be held. Load-bearing for an org
        // with zero incidents — see the coveredFrom derivation below.
        createdAt: huntressIntegrations.createdAt,
      })
      .from(huntressIntegrations)
      .where(and(
        eq(huntressIntegrations.partnerId, orgRow.partnerId),
        eq(huntressIntegrations.isActive, true),
      ))
      .limit(1)
    : [];

  if (!integration) {
    const gap = emptySummary(orgId, orgName, generatedAt, {
      ...baseCoverage,
      sourceStatus: 'not_connected',
      lastSyncAt: null,
      lastSyncStatus: null,
      unattributableExcluded: 0,
      withheld: 0,
    }, deviceRows.length);
    // Say which absence this is. "Huntress is not connected" is true of a
    // customer who has not set it up; it is a lie about a tenant that no
    // longer exists.
    const summary = orgMissing
      ? (() => {
        const note = 'This organization could not be read, so nothing about its threat detection could be established. This is a fault on our side, not a finding about the period.';
        return { ...gap, coverage: { ...gap.coverage, note }, dataGaps: [note] };
      })()
      : gap;
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: summary as unknown as Record<string, unknown>,
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
  // Redundant with the LEFT JOIN + site predicate below (which already drops
  // NULL-device rows), but stated explicitly so the intent survives someone
  // later changing the join or removing the site filter.
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

  // Every row that survived the query above is attributable by construction:
  // the site predicate is evaluated against a LEFT JOIN, so an incident with
  // `device_id IS NULL` yields `devices.site_id = NULL`, `NULL IN (...)` is
  // UNKNOWN, and Postgres drops it in the WHERE.
  const attributable = windowRows;

  // Which is exactly why the excluded count CANNOT be recovered from
  // `windowRows`: the rows it is meant to count were removed by the database
  // before any of this ran, so filtering the result set would report 0 forever
  // and the disclosure sentence would never print — the silent drop this field
  // exists to prevent. Count them with their own query that does not join
  // devices at all.
  //
  // It applies whenever site predicates are in play, not only under a
  // restricted authority: an unrestricted run that narrowed by `cfg.sites`
  // drops unattributable incidents the same way and owes the reader the same
  // disclosure.
  const siteScoped = sitePredicates(filter).length > 0;
  let unattributableExcluded = 0;
  if (siteScoped) {
    const [unattributableRow] = await db
      .select({ total: count() })
      .from(huntressIncidents)
      .where(and(
        eq(huntressIncidents.orgId, orgId),
        gte(huntressIncidents.reportedAt, window.start),
        lte(huntressIncidents.reportedAt, window.end),
        isNull(huntressIncidents.deviceId),
      ));
    unattributableExcluded = Number(unattributableRow?.total ?? 0);
  }

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
    .orderBy(desc(huntressIncidents.reportedAt))
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
      // Drizzle operators, never a raw `sql` fragment: postgres-js refuses to
      // bind a JS Date inside sql`` and throws at bind time
      // ("The \"string\" argument must be ... Received an instance of Date").
      lt(huntressIncidents.reportedAt, window.start),
      isNull(huntressIncidents.resolvedAt),
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
      .orderBy(desc(huntressIncidents.reportedAt))
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

  // `MIN(reported_at)` is the earliest thing we HOLD — but an org with no
  // incidents at all has no minimum, and a null there would skip the
  // shortfall check entirely and print "0 detections" over a period that
  // mostly predates the integration. That is the precise lie this report type
  // exists to prevent, and it is the most likely org to hit it: the quiet one.
  //
  // So when nothing is held, fall back to when collection could have started
  // at the earliest — the integration row's own `created_at`. A held incident
  // older than that is still honoured (the first sync reaches back a day), so
  // the held value wins whenever there is one.
  const earliestHeld = isoOrNull(earliestRow?.earliest as Date | string | null | undefined);
  const collectionFloor = isoOrNull(integration.createdAt) ?? lastSyncAt;

  const coverage: ThreatCoverage = {
    ...baseCoverage,
    coveredFrom: earliestHeld ?? collectionFloor,
    coveredTo: lastSyncAt,
    sourceStatus,
    lastSyncAt,
    lastSyncStatus: integration.lastSyncStatus ?? null,
    unattributableExcluded,
    withheld,
    carriedInIncluded: cfg.includeCarriedIn,
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
