// apps/api/src/services/backupHealthRows.ts
/**
 * Pure assembly for the unified backup-health feed.
 *
 * Everything in this file is I/O-free so the rules that decide what a
 * technician is told about a customer's backups are testable without a
 * database. The queries live in backupHealthReadModel.ts; the health VERDICT
 * lives in @breeze/shared's deriveBackupHealth and is never re-derived here —
 * a second implementation is how "protected" and "critical" drift apart
 * between the overview, the portal and the posture report.
 */

import {
  deriveBackupHealth,
  mapBackupJobStatus,
  worstBackupStatus,
  EXTERNAL_BACKUP_STATUSES,
  type BackupHealthRow,
  type BackupHealthSummary,
  type ExternalBackupStatus,
} from '@breeze/shared';

import { getBackupProvider } from './backupProviders/registry';
import { compareRowKeys } from './backupHealthCursor';

export type BackupJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

/** What a customer is told in the portal when the connection's
 *  `show_provider_name_in_portal` toggle is off (spec D5). */
export const GENERIC_PROVIDER_LABEL = 'Managed cloud backup';

/** Width of the observed-health bar, in whole UTC days ending today. */
export const BACKUP_HISTORY_DAYS = 28;

/** Fallback poll cadence when a connection row carries no interval. Mirrors
 *  `backup_provider_connections.sync_interval_minutes DEFAULT 30`. */
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;

// ── Leg row shapes (what the two queries in the read model select) ──────────

export interface BreezeLegRow {
  key: string;
  orgId: string;
  orgName: string;
  siteId: string | null;
  deviceId: string;
  name: string;
  computerName: string | null;
  deviceRole: string | null;
  deviceStatus: string;
  /** Status of the device's newest RUN (latestBackupRunOrderBy), null when it has none. */
  jobStatus: BackupJobStatus | null;
  lastSessionAt: Date | string | null;
  /** coalesce(completed_at, started_at) of the newest RESTORABLE run (D-06). */
  lastSuccessAt: Date | string | null;
  /** backup_jobs.total_size of the newest run — the closest first-party analogue
   *  of the vendor's "used storage". */
  totalSize: number | string | null;
  errorsCount: number | null;
  hasJobs: boolean;
}

export interface ProviderLegRow {
  key: string;
  id: string;
  orgId: string;
  orgName: string;
  provider: string;
  portalShowProviderName: boolean;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  accountType: 'backup_manager' | 'm365' | 'unknown';
  dataSources: string[];
  status: ExternalBackupStatus;
  lastSessionAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  selectedBytes: number | string | null;
  usedBytes: number | string | null;
  errorsCount: number;
  breezeDeviceId: string | null;
  /** From the LEFT JOIN on devices — null when the row is unlinked. */
  deviceStatus: string | null;
  deviceSiteId: string | null;
  /** From the LEFT JOIN on backup_provider_connections. NULL means the row was
   *  invisible to this caller (partner-axis RLS under an org token), NOT that
   *  the connection is inactive — see isConnectionStale. */
  connectionIsActive: boolean | null;
  connectionLastSyncAt: Date | string | null;
  connectionSyncIntervalMinutes: number | null;
}

export interface ConnectionFreshness {
  isActive: boolean | null;
  lastSyncAt: Date | string | null;
  syncIntervalMinutes: number | null;
}

// ── Small shared helpers ───────────────────────────────────────────────────

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** UTC calendar day of a timestamp, as `YYYY-MM-DD`. */
function utcDay(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// ── Status inversion (external status -> first-party job statuses) ──────────

/**
 * The inverse of {@link mapBackupJobStatus}, so `?status=` can filter the
 * Breeze leg in SQL without duplicating the forward mapping's judgement.
 *
 * `matchNoJobs` is the one case that is not a job status at all: `no_backups`
 * means the device has NO backup_jobs row, which the query expresses as
 * "the latest-job join produced nothing".
 *
 * Four external statuses (`over_quota`, `no_selection`, `not_started`,
 * `unknown`) have no first-party spelling — they are vendor concepts. Asking
 * for one of those selects zero Breeze rows, which is correct and is what the
 * round-trip test pins.
 */
export function invertBackupJobStatus(
  status: ExternalBackupStatus,
): { jobStatuses: BackupJobStatus[]; matchNoJobs: boolean } {
  switch (status) {
    case 'completed':
      return { jobStatuses: ['completed'], matchNoJobs: false };
    case 'completed_with_errors':
      // #3000: `partial` is a real, restorable, degraded run — never `failed`.
      return { jobStatuses: ['partial'], matchNoJobs: false };
    case 'failed':
      return { jobStatuses: ['failed'], matchNoJobs: false };
    case 'in_progress':
      return { jobStatuses: ['running', 'pending'], matchNoJobs: false };
    case 'interrupted':
      return { jobStatuses: ['cancelled'], matchNoJobs: false };
    case 'no_backups':
      return { jobStatuses: [], matchNoJobs: true };
    default:
      return { jobStatuses: [], matchNoJobs: false };
  }
}

// ── Connection freshness ───────────────────────────────────────────────────

/**
 * Is the evidence behind a provider row too old to be believed?
 *
 * `isActive === null` means the connection row itself was invisible to this
 * caller. That is the NORMAL case for an org token: connections are
 * partner-axis (RLS shape 3) while device rows are org-axis (shape 1), so an
 * org legitimately sees its own devices and none of the partner's connector
 * config. Treating that as "unknown, therefore stale" would blank out every
 * provider row for every customer-scoped user; treating it as fresh is right,
 * because RLS handed us the device rows precisely because the org owns them.
 *
 * A VISIBLE connection with no `last_sync_at` is stale: we have no evidence
 * that any sync ever completed, and D4 requires positive evidence.
 */
export function isConnectionStale(c: ConnectionFreshness, now: Date): boolean {
  if (c.isActive === null) return false;
  if (c.isActive === false) return true;
  const lastSync = c.lastSyncAt == null ? null : new Date(c.lastSyncAt);
  if (!lastSync || Number.isNaN(lastSync.getTime())) return true;
  const intervalMinutes = c.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
  return now.getTime() - lastSync.getTime() > 2 * intervalMinutes * 60_000;
}

// ── Labels ─────────────────────────────────────────────────────────────────

/**
 * `labels: 'vendor'` — the technician-facing surfaces (web overview, device
 * tab, integrations hub) always name the product.
 * `labels: 'portal'`  — the customer-facing surface obeys the per-connection
 * toggle (D5), defaulting to the generic label.
 */
export function providerLabelFor(
  providerKey: string | null,
  opts: { portalShowProviderName: boolean; labels: 'vendor' | 'portal' },
): string | null {
  if (!providerKey) return null;
  if (opts.labels === 'portal' && !opts.portalShowProviderName) return GENERIC_PROVIDER_LABEL;
  try {
    return getBackupProvider(providerKey).label;
  } catch {
    // A row written by a provider this build no longer registers is data, not a
    // crash: show the raw key rather than 500 the whole overview.
    return providerKey;
  }
}

/** `devices.device_role` -> the row's device class (D-19). */
export function deviceRoleToRowType(role: string | null | undefined): 'workstation' | 'server' | 'unknown' {
  return role === 'workstation' || role === 'server' ? role : 'unknown';
}

// ── Row projection ─────────────────────────────────────────────────────────

export function toBreezeHealthRow(row: BreezeLegRow, opts: { now: Date }): BackupHealthRow {
  const status = mapBackupJobStatus(row.jobStatus);
  const lastSuccessAt = toIso(row.lastSuccessAt);
  const errorsCount = row.errorsCount ?? 0;
  const { health, recency, covered } = deriveBackupHealth({
    status,
    lastSuccessAt,
    errorsCount,
    now: opts.now,
  });
  return {
    key: row.key,
    source: 'breeze',
    providerKey: null,
    providerLabel: null,
    orgId: row.orgId,
    orgName: row.orgName,
    siteId: row.siteId,
    deviceId: row.deviceId,
    name: row.name,
    computerName: row.computerName,
    osType: deviceRoleToRowType(row.deviceRole),
    accountType: 'endpoint',
    status,
    health,
    recency,
    covered,
    stale: false,
    lastSuccessAt,
    lastSessionAt: toIso(row.lastSessionAt),
    // First-party runs report one size (what was written). Mapping it to
    // `usedBytes` and leaving `selectedBytes` null keeps the table column
    // honest rather than repeating one number under two headings.
    selectedBytes: null,
    usedBytes: toNumber(row.totalSize),
    errorsCount,
    dataSources: [],
    history28d: [],
    agentOnline: row.deviceStatus === 'online',
  };
}

export function toProviderHealthRow(
  row: ProviderLegRow,
  opts: { now: Date; labels: 'vendor' | 'portal' },
): BackupHealthRow {
  const lastSuccessAt = toIso(row.lastSuccessAt);
  const derived = deriveBackupHealth({
    status: row.status,
    lastSuccessAt,
    errorsCount: row.errorsCount,
    now: opts.now,
  });
  const stale = isConnectionStale(
    {
      isActive: row.connectionIsActive,
      lastSyncAt: row.connectionLastSyncAt,
      syncIntervalMinutes: row.connectionSyncIntervalMinutes,
    },
    opts.now,
  );
  return {
    key: row.key,
    source: 'provider',
    providerKey: row.provider,
    providerLabel: providerLabelFor(row.provider, {
      portalShowProviderName: row.portalShowProviderName,
      labels: opts.labels,
    }),
    orgId: row.orgId,
    orgName: row.orgName,
    // A provider row has no site of its own; it borrows the linked device's.
    siteId: row.breezeDeviceId ? row.deviceSiteId : null,
    deviceId: row.breezeDeviceId,
    name: row.name,
    computerName: row.computerName,
    osType: row.osType,
    accountType: row.accountType === 'm365' ? 'm365' : 'endpoint',
    status: row.status,
    // Stale evidence is not a verdict. The status and timestamps stay as last
    // observed so the UI can still say WHAT it last saw and WHEN, but the
    // health/coverage claims are withdrawn.
    health: stale ? 'unknown' : derived.health,
    recency: derived.recency,
    covered: stale ? false : derived.covered,
    stale,
    lastSuccessAt,
    lastSessionAt: toIso(row.lastSessionAt),
    selectedBytes: toNumber(row.selectedBytes),
    usedBytes: toNumber(row.usedBytes),
    errorsCount: row.errorsCount,
    dataSources: row.dataSources ?? [],
    history28d: [],
    agentOnline: row.breezeDeviceId ? row.deviceStatus === 'online' : null,
  };
}

// ── 28-day observed-health bar ─────────────────────────────────────────────

/** The 28 UTC days ending today, ascending, as `YYYY-MM-DD` (D-16). A fixed
 *  inclusive window means cell `i` is the same calendar day on every row, so
 *  the bars in a table line up vertically. */
export function buildHistoryWindow(now: Date, days: number = BACKUP_HISTORY_DAYS): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    window.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return window;
}

/** A day with no observation is `null`, rendered grey — NOT "healthy". */
export function fillHistoryWindow(
  window: string[],
  observed: ReadonlyMap<string, ExternalBackupStatus>,
): Array<{ day: string; status: ExternalBackupStatus | null }> {
  return window.map((day) => ({ day, status: observed.get(day) ?? null }));
}

/**
 * Fold first-party jobs into one status per UTC day, keeping the WORST
 * (D-20) — the same rule the provider ledger applies, so a bar means the same
 * thing on both sources. A nightly run that failed and was retried
 * successfully is a day that needed attention, not a clean day.
 */
export function foldJobsIntoDays(
  jobs: Array<{ status: BackupJobStatus; at: Date | string | null }>,
): Map<string, ExternalBackupStatus> {
  const days = new Map<string, ExternalBackupStatus>();
  for (const job of jobs) {
    if (job.at == null) continue;
    const day = utcDay(job.at);
    if (!day) continue;
    const observed = mapBackupJobStatus(job.status);
    const existing = days.get(day);
    days.set(day, existing ? worstBackupStatus(existing, observed) : observed);
  }
  return days;
}

// ── Merge + summary ────────────────────────────────────────────────────────

/** Merge two legs that are each already ordered by `(lower(name), key)`.
 *  Stops as soon as `limit` rows are taken. */
export function mergeSortedRows<T extends { key: string; name: string }>(
  left: readonly T[],
  right: readonly T[],
  limit: number,
): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < left.length || j < right.length)) {
    if (i >= left.length) {
      out.push(right[j++]!);
    } else if (j >= right.length) {
      out.push(left[i++]!);
    } else {
      out.push(compareRowKeys(left[i]!, right[j]!) <= 0 ? left[i++]! : right[j++]!);
    }
  }
  return out;
}

export function emptyBackupHealthSummary(): BackupHealthSummary {
  const byStatus = Object.fromEntries(
    EXTERNAL_BACKUP_STATUSES.map((s) => [s, 0]),
  ) as BackupHealthSummary['byStatus'];
  return {
    endpoints: { total: 0, covered: 0, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus,
    byHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
    byRecency: { under_24h: 0, under_48h: 0, over_48h: 0, never: 0 },
  };
}

/**
 * Fold rows into the overview's counters.
 *
 * The bars count ROWS (a device backed up twice is two facts a technician can
 * act on). `endpoints` counts DISTINCT Breeze devices, because "how many of my
 * machines have a backup" must not double from switching a customer onto Cove.
 * Coverage for such a device is the OR of its rows: a stale first-party job
 * plus a fresh Cove restore point is a covered machine.
 */
export function foldBackupHealthSummary(rows: readonly BackupHealthRow[]): BackupHealthSummary {
  const summary = emptyBackupHealthSummary();
  const endpointCoverage = new Map<string, boolean>();

  for (const row of rows) {
    summary.byStatus[row.status] += 1;
    summary.byHealth[row.health] += 1;
    summary.byRecency[row.recency] += 1;

    if (row.accountType === 'm365') {
      summary.m365Accounts += 1;
      continue;
    }
    if (row.deviceId) {
      endpointCoverage.set(row.deviceId, (endpointCoverage.get(row.deviceId) ?? false) || row.covered);
      continue;
    }
    // An endpoint the vendor protects that Breeze does not manage.
    summary.providerOnly += 1;
  }

  summary.endpoints.total = endpointCoverage.size;
  for (const covered of endpointCoverage.values()) {
    if (covered) summary.endpoints.covered += 1;
  }
  summary.endpoints.uncovered = summary.endpoints.total - summary.endpoints.covered;
  return summary;
}
