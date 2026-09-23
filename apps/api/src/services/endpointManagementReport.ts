/**
 * Endpoint Management Review — service-plan evidence for an "Intune management"
 * deliverable (#5784 W03).
 *
 * This is the FIRST real consumer of the #5327 M365 sync tables: until now the
 * only reader was `loadSyncSummary`'s connection card. Everything here is a
 * pure aggregate over persisted rows — `m365_intune_devices`,
 * `m365_posture_rollups` and `m365_license_skus`, left-joined to `devices` on
 * `breeze_device_id`. **No Graph call happens inside a report run**, and no new
 * consent is required (`DeviceManagementManagedDevices.Read.All` is already in
 * `customer-graph-read` v3).
 *
 * ## What this report deliberately does NOT show
 *
 * **Device-level "what changed since last period" does not exist and is not
 * faked here.** Two independently sufficient reasons:
 *
 *  1. `m365_intune_devices.last_changed_at` is not configuration-change
 *     history. The domain's `core_hash` projection includes `lastSyncDateTime`
 *     on purpose (`services/m365Sync/domains/intuneDevices.ts`), so the hash —
 *     and therefore `last_changed_at` — churns on every routine check-in.
 *     `first_seen_at` likewise means *first observed by Breeze*, not *newly
 *     enrolled*.
 *  2. Upserts overwrite in place with no prior-value record, and
 *     `m365SyncRetentionWorker` deletes entities stale for 30 days, so the
 *     population cannot be reconstructed backwards.
 *
 * The report therefore ships CURRENT INVENTORY plus the `m365_posture_rollups`
 * daily trend — a genuine time series — and states `historyCaveat` on every
 * artifact so no reader infers history that is not there. Intune *compliance
 * policy definitions* are likewise out of scope: they are not persisted.
 *
 * ## Freshness
 *
 * `asOf` is `last_complete_snapshot_at`, NEVER `last_success_at`: a `partial`
 * outcome advances the latter without enumerating the tenant. Staleness is
 * judged against the domain's 6 h sync cadence, NOT against the reporting
 * period — a 29-day-old inventory in a monthly report is stale.
 *
 * An unmeasured domain (never completed, `needs_consent`, `throttled`,
 * `unlicensed`, or the tenant-sync feature switched off) renders a DATA GAP.
 * Its numbers stay `null`; its tables are not queried. Unmeasured is never zero.
 *
 * ## Restricted authority
 *
 * `m365_intune_devices.breeze_device_id` site-attributes the linked subset only.
 * Under a restricted authority the report enumerates linked devices in
 * permitted sites and discloses the unlinked population as a COUNT ONLY —
 * those rows have no site, so listing them would serve devices outside the
 * technician's sites.
 *
 * Every REPORTED number is scoped the same way. `enrolment.intuneDevices` is
 * the in-scope linked population plus that unlinked count — never the org-wide
 * row count, which would disclose the whole tenant's enrolment scale to a
 * site-restricted technician beside a correctly-scoped Breeze device count.
 */
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  ENDPOINT_MANAGEMENT_HISTORY_CAVEAT,
  ENDPOINT_MANAGEMENT_NO_SITES_GAP,
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  complianceBreakdown,
  emptyEndpointManagementSummary,
  freshnessLine,
  isStaleSnapshot,
  type ComplianceState,
  type ComplianceTrendPoint,
  type EndpointFreshness,
  type EndpointManagementSummary,
  type IntuneDeviceRow,
  type LicenceSeatRow,
} from '@breeze/shared';
import { isM365TenantSyncEnabled } from '../config/env';
import { db } from '../db';
import {
  devices,
  m365IntuneDevices,
  m365LicenseSkus,
  m365PostureRollups,
  organizations,
} from '../db/schema';
import { endpointManagementConfigSchema } from './reportConfigSchemas';
import { loadDomainFreshness } from './m365Sync/summary';
import {
  assertReportExecutionPreflight,
  type EvidenceRunContext,
  type ReportResult,
} from './reportGenerationService';
import type { ReportGenerationAuthority } from './siteScope';

const INTUNE_CADENCE_HOURS = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.intune_devices / 3600;
const SKUS_CADENCE_HOURS = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.skus / 3600;

/** A domain is measured only when it has a COMPLETE snapshot and its own
 *  primary source reported neither a consent gap nor throttling. Anything else
 *  is a data gap: its section renders "N/A" with a reason, and its table is
 *  never queried — printing zeros for an unenumerated tenant is the failure
 *  mode this whole report is written against. */
// `unlicensed` is computed from the domain's PRIMARY source key only
// (m365Sync/summary.ts). Both domains this report reads emit exactly one,
// primary-keyed source today, so that is complete. If either later grows a
// secondary source the way `secure_score` has, add it here — otherwise a
// non-primary `unlicensed` would print a gap note while the numbers beside it
// were still reported as measured.
function isMeasured(freshness: { asOf: string | null; sources: Record<string, string> | null; unlicensed: boolean }): boolean {
  if (!freshness.asOf) return false;
  if (freshness.unlicensed) return false;
  const outcomes = Object.values(freshness.sources ?? {});
  return !outcomes.some((o) => o === 'needs_consent' || o === 'throttled' || o === 'error');
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function int(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function complianceState(value: unknown): ComplianceState | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value === 'compliant' || value === 'noncompliant' || value === 'inGracePeriod'
    ? value
    : 'unknown';
}

function isoDate(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '';
}

export async function generateEndpointManagementReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const cfg = endpointManagementConfigSchema.parse(rawConfig ?? {});
  // The window comes from the occurrence, never from now() (W01, OD-11).
  const generatedAt = evidence?.generatedAt ?? new Date().toISOString();
  const now = new Date(generatedAt);
  const period = evidence
    ? { start: evidence.periodStart, end: evidence.periodEnd }
    : undefined;

  assertReportExecutionPreflight(orgId, cfg, authority, 'endpoint_management_review');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptyEndpointManagementSummary({
        orgId, generatedAt, period,
        thresholdDays: cfg.staleEnrolmentDays,
        dataGap: ENDPOINT_MANAGEMENT_NO_SITES_GAP,
      }),
    };
  }

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // --- freshness first -------------------------------------------------------
  const syncEnabled = isM365TenantSyncEnabled();
  const domainFreshness = syncEnabled
    ? await loadDomainFreshness(orgId, ['intune_devices', 'skus'])
    : {
      intune_devices: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
      skus: { asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false },
    };

  const dataGaps: string[] = [];
  if (!syncEnabled) {
    dataGaps.push(
      'Microsoft 365 tenant sync is not enabled for this deployment, so no Intune data was collected.',
    );
  }

  const freshness: Record<string, EndpointFreshness> = {};
  for (const [domain, cadenceHours] of [
    ['intune_devices', INTUNE_CADENCE_HOURS],
    ['skus', SKUS_CADENCE_HOURS],
  ] as const) {
    const raw = domainFreshness[domain];
    const note = freshnessLine(raw, cadenceHours, now);
    freshness[domain] = {
      asOf: raw.asOf,
      lastStatus: raw.lastStatus,
      truncated: raw.truncated,
      sources: raw.sources,
      stale: isStaleSnapshot(raw.asOf, cadenceHours, now),
      note,
    };
    if (note && syncEnabled) dataGaps.push(`${domain}: ${note}`);
  }

  const intuneMeasured = isMeasured(domainFreshness.intune_devices);
  const skusMeasured = isMeasured(domainFreshness.skus);

  // --- Breeze-side population (always measurable — it is our own data) --------
  // The site filter is pushed independently into EVERY query branch below.
  // Deliberately NOT computed once and reused: a shared device-id list is how a
  // branch silently loses its filter when someone edits one query later.
  const breezeConditions = [eq(devices.orgId, orgId)];
  if (cfg.sites.length > 0) breezeConditions.push(inArray(devices.siteId, cfg.sites));
  if (restrictedScope) breezeConditions.push(inArray(devices.siteId, restrictedScope.siteIds));
  const breezeRows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(...breezeConditions));
  const breezeIds = new Set((breezeRows ?? []).map((r) => r.id));

  // --- Intune enrolment coverage --------------------------------------------
  // This read is org-wide, and ONLY these two derivations may be: the unlinked
  // count, because those rows carry no site at all and are disclosed as a count
  // (see the module doc), and `linkedIds`, which is never reported — it is only
  // subtracted from the already-in-scope `breezeIds`, so nothing out of scope
  // survives into the output.
  //
  // `enrolment.intuneDevices` is deliberately NOT this read's row count.
  // Deriving it here reported the whole tenant's enrolment scale to a
  // site-restricted technician — linked rows joined to devices outside their
  // permitted sites were counted in, beside a correctly-scoped "Devices managed
  // by Breeze" figure, with nothing saying the two had different scopes. It is
  // computed from the enumerable population below instead.
  let unlinkedCount: number | null = null;
  let linkedIds = new Set<string>();
  if (intuneMeasured) {
    const coverageRows = await db
      .select({ id: m365IntuneDevices.id, breezeDeviceId: m365IntuneDevices.breezeDeviceId })
      .from(m365IntuneDevices)
      .where(eq(m365IntuneDevices.orgId, orgId));
    unlinkedCount = (coverageRows ?? []).filter((r) => !r.breezeDeviceId).length;
    linkedIds = new Set(
      (coverageRows ?? [])
        .map((r) => r.breezeDeviceId)
        .filter((id): id is string => typeof id === 'string'),
    );
  }

  // --- the enumerable (linked, in-scope) population --------------------------
  let rows: IntuneDeviceRow[] = [];
  if (intuneMeasured) {
    const rowConditions = [
      eq(m365IntuneDevices.orgId, orgId),
      isNotNull(m365IntuneDevices.breezeDeviceId),
    ];
    if (cfg.sites.length > 0) rowConditions.push(inArray(devices.siteId, cfg.sites));
    if (restrictedScope) rowConditions.push(inArray(devices.siteId, restrictedScope.siteIds));

    const entityRows = await db
      .select({
        id: m365IntuneDevices.id,
        deviceName: m365IntuneDevices.deviceName,
        operatingSystem: m365IntuneDevices.operatingSystem,
        osVersion: m365IntuneDevices.osVersion,
        userPrincipalName: m365IntuneDevices.userPrincipalName,
        ownerType: m365IntuneDevices.ownerType,
        lastIntuneSyncAt: m365IntuneDevices.lastIntuneSyncAt,
        complianceState: m365IntuneDevices.complianceState,
        jailBroken: m365IntuneDevices.jailBroken,
        isStale: m365IntuneDevices.isStale,
        breezeDeviceId: m365IntuneDevices.breezeDeviceId,
      })
      .from(m365IntuneDevices)
      .innerJoin(devices, eq(devices.id, m365IntuneDevices.breezeDeviceId))
      .where(and(...rowConditions));

    rows = (entityRows ?? []).map((r) => ({
      id: r.id,
      deviceName: r.deviceName ?? null,
      operatingSystem: r.operatingSystem ?? null,
      osVersion: r.osVersion ?? null,
      userPrincipalName: r.userPrincipalName ?? null,
      ownerType: r.ownerType ?? null,
      lastIntuneSyncAt: iso(r.lastIntuneSyncAt),
      complianceState: complianceState(r.complianceState),
      jailBroken: r.jailBroken ?? null,
      isStale: r.isStale === true,
      breezeDeviceId: r.breezeDeviceId ?? null,
    }));
    rows.sort((a, b) => (a.deviceName ?? '').localeCompare(b.deviceName ?? ''));
  }

  // Enrolled devices this authority may actually account for: the linked,
  // in-scope population it can enumerate, plus the unlinked population it may
  // only count. Under an unrestricted authority with no site filter this is
  // every Intune row in the org, exactly as before.
  const intuneTotal = intuneMeasured ? rows.length + (unlinkedCount ?? 0) : null;

  // --- compliance trend, from the rollups and ONLY from the rollups ----------
  let trend: ComplianceTrendPoint[] = [];
  if (intuneMeasured) {
    const since = new Date(now.getTime() - cfg.trendDays * 86_400_000).toISOString().slice(0, 10);
    const rollupRows = await db
      .select({
        rollupDate: m365PostureRollups.rollupDate,
        devicesCompliant: m365PostureRollups.devicesCompliant,
        devicesNoncompliant: m365PostureRollups.devicesNoncompliant,
        devicesInGrace: m365PostureRollups.devicesInGrace,
        devicesUnknown: m365PostureRollups.devicesUnknown,
      })
      .from(m365PostureRollups)
      .where(and(eq(m365PostureRollups.orgId, orgId), gte(m365PostureRollups.rollupDate, since)))
      .orderBy(m365PostureRollups.rollupDate);

    trend = (rollupRows ?? []).map((r) => ({
      date: isoDate(r.rollupDate),
      compliant: int(r.devicesCompliant),
      noncompliant: int(r.devicesNoncompliant),
      inGrace: int(r.devicesInGrace),
      unknown: int(r.devicesUnknown),
    }));
  }

  // --- licence seats ---------------------------------------------------------
  let licences: LicenceSeatRow[] | null | undefined;
  if (cfg.includeLicences) {
    if (!skusMeasured) {
      licences = null;
    } else {
      const skuRows = await db
        .select({
          skuPartNumber: m365LicenseSkus.skuPartNumber,
          consumedUnits: m365LicenseSkus.consumedUnits,
          prepaidEnabled: m365LicenseSkus.prepaidEnabled,
          prepaidWarning: m365LicenseSkus.prepaidWarning,
          prepaidSuspended: m365LicenseSkus.prepaidSuspended,
          capabilityStatus: m365LicenseSkus.capabilityStatus,
        })
        .from(m365LicenseSkus)
        .where(and(eq(m365LicenseSkus.orgId, orgId), eq(m365LicenseSkus.isStale, false)));
      licences = (skuRows ?? []).map((r) => ({
        skuPartNumber: r.skuPartNumber ?? null,
        consumedUnits: int(r.consumedUnits),
        prepaidEnabled: int(r.prepaidEnabled),
        prepaidWarning: int(r.prepaidWarning),
        prepaidSuspended: int(r.prepaidSuspended),
        capabilityStatus: r.capabilityStatus ?? null,
      }));
    }
  }

  // --- stale enrolments ------------------------------------------------------
  // Judged against `staleEnrolmentDays` — an absolute age, not a slice of the
  // reporting period. An `is_stale` row (present in Breeze, gone from the
  // tenant) counts too.
  const staleBefore = now.getTime() - cfg.staleEnrolmentDays * 86_400_000;
  const staleCount = intuneMeasured
    ? rows.filter((r) => {
      if (r.isStale) return true;
      if (!r.lastIntuneSyncAt) return true;
      return new Date(r.lastIntuneSyncAt).getTime() < staleBefore;
    }).length
    : null;

  const summary = {
    orgId: orgRow?.id ?? orgId,
    orgName: orgRow?.name ?? null,
    generatedAt,
    period,
    freshness,
    enrolment: {
      intuneDevices: intuneTotal,
      breezeDevices: breezeIds.size,
      breezeWithoutIntune: intuneMeasured
        ? [...breezeIds].filter((id) => !linkedIds.has(id)).length
        : null,
      intuneWithoutBreezeLink: unlinkedCount,
    },
    compliance: {
      // `intuneMeasured`, not `rows.length`: a measured domain whose in-scope
      // population happens to be empty is a truthful zero, not "not measured".
      byState: complianceBreakdown(rows, intuneMeasured),
      trend,
    },
    staleEnrolments: { count: staleCount, thresholdDays: cfg.staleEnrolmentDays },
    ...(cfg.includeLicences ? { licences } : {}),
    rows,
    dataGaps,
    historyCaveat: ENDPOINT_MANAGEMENT_HISTORY_CAVEAT,
  } satisfies EndpointManagementSummary;

  return { rows, rowCount: rows.length, generatedAt, summary };
}
