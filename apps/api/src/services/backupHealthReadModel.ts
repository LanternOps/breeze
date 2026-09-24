// apps/api/src/services/backupHealthReadModel.ts
/**
 * The unified backup read model.
 *
 * One question, asked once: "what is the backup state of every device this
 * caller can see?" — over first-party backup_jobs AND third-party
 * backup_provider_devices. Every surface that used to answer it from
 * backup_jobs alone (the /backup overview, the device tab, the portal, the
 * posture report, the org narrative) reads it from here instead, so a customer
 * protected by Cove stops reading as "unprotected" in one place and
 * "protected" in another.
 *
 * Two contracts this file exists to keep:
 *
 *  1. EVERY active Breeze device in scope is a row. A device with no backup_jobs
 *     row is `status: 'no_backups'`, not an absence. The unprotected population
 *     is the whole point of the view and must never fall out of a join.
 *  2. SITE is enforced here. Postgres RLS defends org and partner; it cannot see
 *     the site axis. Breeze rows are filtered by devices.site_id; unlinked
 *     provider rows have no site at all and are therefore returned only to a
 *     caller with no site restriction.
 *
 * Everything runs on the ambient request transaction via the RLS-aware `db`
 * proxy. Nothing here opens a system context.
 */

import { and, eq, ilike, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';

import {
  deriveBackupHealth,
  type BackupHealth,
  type BackupHealthRow,
  type BackupHealthSummary,
  type ExternalBackupStatus,
} from '@breeze/shared';

import { db } from '../db';
import {
  backupJobs,
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
  organizations,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../db/schema';
import { escapeLike } from '../utils/sql';
import { latestBackupRunWindowOrder } from './backupJobOrdering';
import {
  cursorFromRow,
  decodeBackupHealthCursor,
  encodeBackupHealthCursor,
  type BackupHealthCursor,
} from './backupHealthCursor';
import {
  BACKUP_HISTORY_DAYS,
  buildHistoryWindow,
  fillHistoryWindow,
  foldBackupHealthSummary,
  foldJobsIntoDays,
  emptyBackupHealthSummary,
  invertBackupJobStatus,
  isConnectionStale,
  mergeSortedRows,
  toBreezeHealthRow,
  toProviderHealthRow,
  type BackupJobStatus,
  type BreezeLegRow,
  type ProviderLegRow,
} from './backupHealthRows';

export interface BackupHealthScope {
  orgIds: string[];
  /** The caller's site ceiling. `undefined` = unrestricted; `[]` = sees nothing. */
  siteIds?: string[];
}

export interface BackupHealthFilter {
  health?: BackupHealth[];
  status?: ExternalBackupStatus[];
  search?: string;
}

export interface BackupHealthListOptions {
  sources?: Array<'breeze' | 'provider'>;
  onlyWithBackup?: boolean;
  filter?: BackupHealthFilter;
  /** 'vendor' names the product (technician surfaces); 'portal' obeys the
   *  per-connection toggle (D5). W04's portal read model passes 'portal'. */
  labels?: 'vendor' | 'portal';
  page: { limit: number; cursor?: string | null };
  /** Test seam. Production callers omit it. */
  now?: Date;
}

export type BackupHealthSummaryOptions = Omit<BackupHealthListOptions, 'page' | 'labels'>;

/** Rows pulled per SQL batch while a health filter is narrowing the page. */
export const BACKUP_HEALTH_SCAN_BATCH = 500;
/** Ceiling on batches per request, so a fleet that is 100% healthy cannot make
 *  `?health=critical` walk the whole table in one HTTP request. */
export const BACKUP_HEALTH_MAX_BATCHES = 20;
/** Ceiling on the summary scan. */
export const BACKUP_HEALTH_SUMMARY_MAX_ROWS = 50_000;

// ── shared SQL fragments ───────────────────────────────────────────────────

/** The Breeze leg's display name. `nullif(…, '')` matters: an empty
 *  display_name would otherwise sort every such device to the top under an
 *  empty-string key. */
const breezeNameExpr = sql<string>`coalesce(nullif(${devices.displayName}, ''), ${devices.hostname})`;
const breezeKeyExpr = sql<string>`('breeze:' || ${devices.id}::text)`;
const providerNameExpr = sql<string>`${backupProviderDevices.vendorDeviceName}`;
const providerKeyExpr = sql<string>`('provider:' || ${backupProviderDevices.id}::text)`;

/**
 * D11: a device linked to a provider device must be represented by exactly
 * ONE row — the provider leg row already carries the linked device's id,
 * site and online state (toProviderHealthRow), so it alone satisfies the
 * "every active device is a row" contract. Without this exclusion the same
 * device appeared twice in `/backup` — once from each leg — and was double
 * counted in both status buckets. A raw correlated `sql` fragment rather than
 * `notExists(db.select(...))`: the latter issues its own `db.select()` call,
 * which this file's other subqueries reserve for joined, `.as()`-aliased
 * subqueries (latestJobSubquery/latestSuccessSubquery) — this one is neither
 * joined nor awaited, only referenced inside the WHERE clause.
 */
const notLinkedToProviderDevice = sql`not exists (select 1 from ${backupProviderDevices} where ${backupProviderDevices.breezeDeviceId} = ${devices.id})`;

/**
 * `ORDER BY lower(name) COLLATE "C", key COLLATE "C"` — byte order, which is
 * exactly what the JS comparator in backupHealthCursor does. Without the
 * explicit collation the database sorts under its own locale and the merge
 * disagrees with the walk.
 */
function orderExprs(nameExpr: SQL<string>, keyExpr: SQL<string>): SQL[] {
  return [sql`lower(${nameExpr}) COLLATE "C" asc`, sql`${keyExpr} COLLATE "C" asc`];
}

function keysetPredicate(nameExpr: SQL<string>, keyExpr: SQL<string>, cursor: BackupHealthCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(lower(${nameExpr}) COLLATE "C", ${keyExpr} COLLATE "C") > (${cursor.n}::text COLLATE "C", ${cursor.k}::text COLLATE "C")`;
}

function searchPattern(search: string | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed ? `%${escapeLike(trimmed)}%` : null;
}

// ── Breeze leg ─────────────────────────────────────────────────────────────

/** The device's newest RUN (not newest inserted row — see backupJobOrdering). */
function latestJobSubquery(orgIds: string[]) {
  return db
    .select({
      deviceId: backupJobs.deviceId,
      status: backupJobs.status,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      totalSize: backupJobs.totalSize,
      errorCount: backupJobs.errorCount,
      rn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${latestBackupRunWindowOrder})`.as('rn'),
    })
    .from(backupJobs)
    .where(inArray(backupJobs.orgId, orgIds))
    .as('bh_latest_job');
}

/** The device's newest RESTORABLE run. `partial` counts (#3000): it left a real
 *  restore point, and excluding it would report "never backed up" for a device
 *  that demonstrably has a snapshot. */
function latestSuccessSubquery(orgIds: string[]) {
  return db
    .select({
      deviceId: backupJobs.deviceId,
      completedAt: backupJobs.completedAt,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      // DEVIATION (forced by real Postgres, not caught by the mocked unit
      // test): named `successRn`, not `rn`. Drizzle renders a raw-`sql`
      // `.as()` column reference back out UNQUALIFIED (bare `"rn"`, no
      // subquery prefix) wherever it's read from the subquery object — fine
      // when only one such subquery is joined (routes/backup/dashboard.ts's
      // `ranked_backup_jobs_for_attention` does exactly this safely), but
      // buildBreezeLeg joins TWO row_number()-ranked subqueries
      // (bh_latest_job, bh_last_success) into the SAME outer query, and two
      // bare `"rn"` references in one scope is
      // `PostgresError: column reference "rn" is ambiguous` (42702) — caught
      // by backupHealthReadModel.integration.test.ts against real Postgres,
      // not by the mocked backupHealthReadModel.test.ts. Distinct column
      // names sidestep the ambiguity entirely.
      successRn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${latestBackupRunWindowOrder})`.as('successRn'),
    })
    .from(backupJobs)
    .where(
      and(
        inArray(backupJobs.orgId, orgIds),
        inArray(backupJobs.status, [...RESTORABLE_BACKUP_JOB_STATUSES]),
      ),
    )
    .as('bh_last_success');
}

function buildBreezeLeg(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
  cursor: BackupHealthCursor | null,
  limit: number,
) {
  const latest = latestJobSubquery(scope.orgIds);
  const success = latestSuccessSubquery(scope.orgIds);
  const conditions: Array<SQL | undefined> = [
    inArray(devices.orgId, scope.orgIds),
    // Quick Support devices live in the hidden per-partner org and are not part
    // of anyone's backup posture.
    eq(devices.isEphemeral, false),
    // `devices` carries no deleted_at — offboarding retires a device via
    // status='decommissioned' (see aiToolsTicketing.ts:849-853).
    ne(devices.status, 'decommissioned'),
    // D11: a device linked to a provider device is already represented by
    // that provider leg row — see notLinkedToProviderDevice.
    notLinkedToProviderDevice,
  ];

  if (scope.siteIds) conditions.push(inArray(devices.siteId, scope.siteIds));
  if (opts.onlyWithBackup) conditions.push(sql`${latest.deviceId} is not null`);

  if (opts.filter?.status?.length) {
    const jobStatuses = new Set<BackupJobStatus>();
    let matchNoJobs = false;
    for (const status of opts.filter.status) {
      const inverted = invertBackupJobStatus(status);
      inverted.jobStatuses.forEach((s) => jobStatuses.add(s));
      matchNoJobs ||= inverted.matchNoJobs;
    }
    const branches: SQL[] = [];
    if (jobStatuses.size > 0) branches.push(sql`${latest.status} in ${[...jobStatuses]}`);
    if (matchNoJobs) branches.push(sql`${latest.deviceId} is null`);
    // No first-party spelling for the requested statuses => select nothing.
    conditions.push(branches.length > 0 ? (or(...branches) as SQL) : sql`false`);
  }

  const pattern = searchPattern(opts.filter?.search);
  if (pattern) {
    conditions.push(
      or(
        ilike(devices.displayName, pattern),
        ilike(devices.hostname, pattern),
        ilike(organizations.name, pattern),
      ) as SQL,
    );
  }
  conditions.push(keysetPredicate(breezeNameExpr, breezeKeyExpr, cursor));

  return db
    .select({
      key: breezeKeyExpr.as('key'),
      orgId: devices.orgId,
      orgName: organizations.name,
      siteId: devices.siteId,
      deviceId: devices.id,
      name: breezeNameExpr.as('name'),
      computerName: devices.hostname,
      deviceRole: devices.deviceRole,
      deviceStatus: devices.status,
      jobStatus: sql<BackupJobStatus | null>`${latest.status}`.as('jobStatus'),
      lastSessionAt: sql<Date | null>`coalesce(${latest.startedAt}, ${latest.createdAt})`.as('lastSessionAt'),
      // D-06: a restorable run that never stamped completed_at still happened.
      lastSuccessAt: sql<Date | null>`coalesce(${success.completedAt}, ${success.startedAt})`.as('lastSuccessAt'),
      totalSize: latest.totalSize,
      errorsCount: latest.errorCount,
      hasJobs: sql<boolean>`(${latest.deviceId} is not null)`.as('hasJobs'),
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(latest, and(eq(latest.deviceId, devices.id), eq(latest.rn, 1)))
    .leftJoin(success, and(eq(success.deviceId, devices.id), eq(success.successRn, 1)))
    .where(and(...conditions))
    .orderBy(...orderExprs(breezeNameExpr, breezeKeyExpr))
    .limit(limit);
}

// ── provider leg ───────────────────────────────────────────────────────────

function buildProviderLeg(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
  cursor: BackupHealthCursor | null,
  limit: number,
) {
  const conditions: Array<SQL | undefined> = [inArray(backupProviderDevices.orgId, scope.orgIds)];

  if (scope.siteIds) {
    // A site-restricted caller sees provider rows only through a linked device
    // that is in one of their sites. An unlinked row has no site to attribute,
    // so it is withheld rather than shown to everyone.
    conditions.push(isNotNull(backupProviderDevices.breezeDeviceId));
    conditions.push(inArray(devices.siteId, scope.siteIds));
  }

  if (opts.filter?.status?.length) {
    conditions.push(inArray(backupProviderDevices.status, opts.filter.status));
  }

  const pattern = searchPattern(opts.filter?.search);
  if (pattern) {
    conditions.push(
      or(
        ilike(backupProviderDevices.vendorDeviceName, pattern),
        ilike(backupProviderDevices.computerName, pattern),
        ilike(organizations.name, pattern),
      ) as SQL,
    );
  }
  conditions.push(keysetPredicate(providerNameExpr, providerKeyExpr, cursor));

  return db
    .select({
      key: providerKeyExpr.as('key'),
      id: backupProviderDevices.id,
      orgId: backupProviderDevices.orgId,
      orgName: organizations.name,
      provider: backupProviderDevices.provider,
      portalShowProviderName: backupProviderDevices.portalShowProviderName,
      name: providerNameExpr.as('name'),
      computerName: backupProviderDevices.computerName,
      osType: backupProviderDevices.osType,
      accountType: backupProviderDevices.accountType,
      dataSources: backupProviderDevices.dataSources,
      status: backupProviderDevices.status,
      lastSessionAt: backupProviderDevices.lastSessionAt,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      selectedBytes: backupProviderDevices.selectedBytes,
      usedBytes: backupProviderDevices.usedBytes,
      errorsCount: backupProviderDevices.errorsCount,
      breezeDeviceId: backupProviderDevices.breezeDeviceId,
      deviceStatus: sql<string | null>`${devices.status}`.as('deviceStatus'),
      deviceSiteId: sql<string | null>`${devices.siteId}`.as('deviceSiteId'),
      // LEFT JOIN, and NULL here means "invisible under this caller's RLS", not
      // "inactive" — backup_provider_connections is partner-axis while these
      // rows are org-axis, so an org token legitimately sees one and not the
      // other. isConnectionStale() reads the null accordingly.
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .innerJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
    .leftJoin(devices, eq(devices.id, backupProviderDevices.breezeDeviceId))
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(and(...conditions))
    .orderBy(...orderExprs(providerNameExpr, providerKeyExpr))
    .limit(limit);
}

// ── 28-day history attachment ──────────────────────────────────────────────

async function attachHistory(rows: BackupHealthRow[], now: Date): Promise<void> {
  if (rows.length === 0) return;
  const window = buildHistoryWindow(now, BACKUP_HISTORY_DAYS);
  const windowStart = window[0]!;

  const deviceIds = rows.filter((r) => r.source === 'breeze' && r.deviceId).map((r) => r.deviceId!);
  const providerIds = rows.filter((r) => r.source === 'provider').map((r) => r.key.slice('provider:'.length));

  const [jobRows, ledgerRows] = await Promise.all([
    deviceIds.length === 0
      ? Promise.resolve([] as Array<{ deviceId: string; status: BackupJobStatus; at: Date | string | null }>)
      : db
          .select({
            deviceId: backupJobs.deviceId,
            status: backupJobs.status,
            at: sql<Date>`coalesce(${backupJobs.startedAt}, ${backupJobs.createdAt})`.as('at'),
          })
          .from(backupJobs)
          .where(
            and(
              inArray(backupJobs.deviceId, deviceIds),
              // ISO string, never a Date object, inside a raw fragment.
              sql`coalesce(${backupJobs.startedAt}, ${backupJobs.createdAt}) >= ${windowStart}::date`,
            ),
          ),
    providerIds.length === 0
      ? Promise.resolve([] as Array<{ providerDeviceId: string; day: string; status: ExternalBackupStatus }>)
      : db
          .select({
            providerDeviceId: backupProviderDeviceHistory.providerDeviceId,
            day: sql<string>`to_char(${backupProviderDeviceHistory.day}, 'YYYY-MM-DD')`.as('day'),
            status: backupProviderDeviceHistory.status,
          })
          .from(backupProviderDeviceHistory)
          .where(
            and(
              inArray(backupProviderDeviceHistory.providerDeviceId, providerIds),
              sql`${backupProviderDeviceHistory.day} >= ${windowStart}::date`,
            ),
          ),
  ]);

  const byDevice = new Map<string, Array<{ status: BackupJobStatus; at: Date | string | null }>>();
  for (const job of jobRows) {
    const list = byDevice.get(job.deviceId) ?? [];
    list.push({ status: job.status as BackupJobStatus, at: job.at });
    byDevice.set(job.deviceId, list);
  }

  const byProvider = new Map<string, Map<string, ExternalBackupStatus>>();
  for (const row of ledgerRows) {
    const days = byProvider.get(row.providerDeviceId) ?? new Map<string, ExternalBackupStatus>();
    days.set(row.day, row.status);
    byProvider.set(row.providerDeviceId, days);
  }

  for (const row of rows) {
    const observed =
      row.source === 'breeze'
        ? foldJobsIntoDays(byDevice.get(row.deviceId!) ?? [])
        : (byProvider.get(row.key.slice('provider:'.length)) ?? new Map<string, ExternalBackupStatus>());
    row.history28d = fillHistoryWindow(window, observed);
  }
}

// ── list ───────────────────────────────────────────────────────────────────

function wantsSource(opts: BackupHealthListOptions, source: 'breeze' | 'provider'): boolean {
  return !opts.sources || opts.sources.includes(source);
}

export async function listBackupHealthRows(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }> {
  if (scope.orgIds.length === 0 || scope.siteIds?.length === 0) return { rows: [], nextCursor: null };

  const now = opts.now ?? new Date();
  const labels = opts.labels ?? 'vendor';
  const limit = Math.max(1, opts.page.limit);
  const healthFilter = opts.filter?.health?.length ? new Set(opts.filter.health) : null;
  // No health filter => exactly one batch of limit+1. The over-fetch loop only
  // costs anything when a derived predicate is doing the narrowing.
  const batchSize = healthFilter ? Math.min(BACKUP_HEALTH_SCAN_BATCH, (limit + 1) * 4) : limit + 1;

  let cursor = decodeBackupHealthCursor(opts.page.cursor);
  const kept: BackupHealthRow[] = [];
  let exhausted = false;
  let batches = 0;

  while (kept.length < limit + 1 && !exhausted && batches < BACKUP_HEALTH_MAX_BATCHES) {
    batches += 1;
    const [breezeRaw, providerRaw] = await Promise.all([
      wantsSource(opts, 'breeze')
        ? (buildBreezeLeg(scope, opts, cursor, batchSize) as unknown as Promise<BreezeLegRow[]>)
        : Promise.resolve([] as BreezeLegRow[]),
      wantsSource(opts, 'provider')
        ? (buildProviderLeg(scope, opts, cursor, batchSize) as unknown as Promise<ProviderLegRow[]>)
        : Promise.resolve([] as ProviderLegRow[]),
    ]);

    const breezeRows = breezeRaw.map((r) => toBreezeHealthRow(r, { now }));
    const providerRows = providerRaw.map((r) => toProviderHealthRow(r, { now, labels }));
    const merged = mergeSortedRows(breezeRows, providerRows, batchSize);
    if (merged.length === 0) break;

    // Both legs short AND nothing was dropped by the merge's own limit => the
    // scan reached the end of the feed.
    exhausted =
      breezeRows.length < batchSize &&
      providerRows.length < batchSize &&
      merged.length >= breezeRows.length + providerRows.length;

    cursor = cursorFromRow(merged[merged.length - 1]!);
    for (const row of merged) {
      if (healthFilter && !healthFilter.has(row.health)) continue;
      kept.push(row);
      if (kept.length >= limit + 1) break;
    }
  }

  const hasMore = kept.length > limit;
  const rows = kept.slice(0, limit);
  const last = rows[rows.length - 1];

  let nextCursor: string | null = null;
  if (hasMore && last) {
    nextCursor = encodeBackupHealthCursor(cursorFromRow(last));
  } else if (!exhausted && cursor) {
    // The batch cap stopped a health-filtered scan mid-feed. Hand back where we
    // got to so the client keeps walking rather than believing the fleet ends
    // here.
    nextCursor = encodeBackupHealthCursor(cursor);
  }

  await attachHistory(rows, now);
  return { rows, nextCursor };
}

// ── summary ────────────────────────────────────────────────────────────────

export async function summarizeBackupHealth(
  scope: BackupHealthScope,
  opts: BackupHealthSummaryOptions = {},
): Promise<BackupHealthSummary> {
  if (scope.orgIds.length === 0 || scope.siteIds?.length === 0) return emptyBackupHealthSummary();

  const now = opts.now ?? new Date();
  // Same builders as the list, so a filter can never mean two different things
  // between the bars and the table underneath them.
  const listOpts: BackupHealthListOptions = { ...opts, page: { limit: BACKUP_HEALTH_SUMMARY_MAX_ROWS } };
  const [breezeRaw, providerRaw] = await Promise.all([
    wantsSource(listOpts, 'breeze')
      ? (buildBreezeLeg(scope, listOpts, null, BACKUP_HEALTH_SUMMARY_MAX_ROWS) as unknown as Promise<BreezeLegRow[]>)
      : Promise.resolve([] as BreezeLegRow[]),
    wantsSource(listOpts, 'provider')
      ? (buildProviderLeg(scope, listOpts, null, BACKUP_HEALTH_SUMMARY_MAX_ROWS) as unknown as Promise<ProviderLegRow[]>)
      : Promise.resolve([] as ProviderLegRow[]),
  ]);

  if (breezeRaw.length >= BACKUP_HEALTH_SUMMARY_MAX_ROWS || providerRaw.length >= BACKUP_HEALTH_SUMMARY_MAX_ROWS) {
    // Not silent: a partial fleet reported as the whole one is exactly the kind
    // of false assurance this feature exists to remove.
    console.warn(
      `[backupHealthReadModel] summary hit the ${BACKUP_HEALTH_SUMMARY_MAX_ROWS}-row cap for orgs ${scope.orgIds.length}`,
    );
  }

  const rows = [
    ...breezeRaw.map((r) => toBreezeHealthRow(r, { now })),
    ...providerRaw.map((r) => toProviderHealthRow(r, { now, labels: 'vendor' })),
  ].filter((row) => !opts.filter?.health?.length || opts.filter.health.includes(row.health));

  return foldBackupHealthSummary(rows);
}

// ── coverage helpers ───────────────────────────────────────────────────────

export async function getProviderCoverageForDevices(
  orgId: string,
  deviceIds: string[],
  opts: { now?: Date } = {},
): Promise<Map<string, { covered: boolean; health: BackupHealth }>> {
  const out = new Map<string, { covered: boolean; health: BackupHealth }>();
  if (deviceIds.length === 0) return out;

  const rows = await db
    .select({
      breezeDeviceId: backupProviderDevices.breezeDeviceId,
      status: backupProviderDevices.status,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      errorsCount: backupProviderDevices.errorsCount,
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(
      and(
        eq(backupProviderDevices.orgId, orgId),
        inArray(backupProviderDevices.breezeDeviceId, deviceIds),
      ),
    );

  const now = opts.now ?? new Date();
  for (const row of rows) {
    if (!row.breezeDeviceId) continue;
    const stale = isConnectionStale(
      {
        isActive: row.connectionIsActive,
        lastSyncAt: row.connectionLastSyncAt,
        syncIntervalMinutes: row.connectionSyncIntervalMinutes,
      },
      now,
    );
    const derived = deriveBackupHealth({
      status: row.status,
      lastSuccessAt: row.lastSuccessAt,
      errorsCount: row.errorsCount,
      now,
    });
    const next = { covered: stale ? false : derived.covered, health: stale ? ('unknown' as const) : derived.health };
    const existing = out.get(row.breezeDeviceId);
    // The partial unique index makes two rows per device a post-acquisition
    // corner, not the norm — but if it happens, coverage is the OR.
    out.set(
      row.breezeDeviceId,
      existing ? { covered: existing.covered || next.covered, health: existing.covered ? existing.health : next.health } : next,
    );
  }
  return out;
}

export async function getFirstPartyCoverageForDevices(
  orgId: string,
  deviceIds: string[],
  opts: { now?: Date } = {},
): Promise<Map<string, { covered: boolean; health: BackupHealth; status: ExternalBackupStatus; lastSuccessAt: string | null }>> {
  const out = new Map<string, { covered: boolean; health: BackupHealth; status: ExternalBackupStatus; lastSuccessAt: string | null }>();
  if (deviceIds.length === 0) return out;

  const latest = latestJobSubquery([orgId]);
  const success = latestSuccessSubquery([orgId]);
  const rows = await db
    .select({
      deviceId: devices.id,
      jobStatus: sql<BackupJobStatus | null>`${latest.status}`.as('jobStatus'),
      lastSuccessAt: sql<Date | null>`coalesce(${success.completedAt}, ${success.startedAt})`.as('lastSuccessAt'),
      errorsCount: latest.errorCount,
    })
    .from(devices)
    .leftJoin(latest, and(eq(latest.deviceId, devices.id), eq(latest.rn, 1)))
    .leftJoin(success, and(eq(success.deviceId, devices.id), eq(success.successRn, 1)))
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  const now = opts.now ?? new Date();
  for (const row of rows) {
    const projected = toBreezeHealthRow(
      {
        key: `breeze:${row.deviceId}`,
        orgId,
        orgName: '',
        siteId: null,
        deviceId: row.deviceId,
        name: '',
        computerName: null,
        deviceRole: null,
        deviceStatus: 'offline',
        jobStatus: row.jobStatus,
        lastSessionAt: null,
        lastSuccessAt: row.lastSuccessAt,
        totalSize: null,
        errorsCount: row.errorsCount,
        hasJobs: row.jobStatus != null,
      },
      { now },
    );
    out.set(row.deviceId, {
      covered: projected.covered,
      health: projected.health,
      status: projected.status,
      lastSuccessAt: projected.lastSuccessAt,
    });
  }
  return out;
}

// ── attention items ────────────────────────────────────────────────────────

export async function getProviderAttentionItems(
  orgId: string,
  opts: { allowedDeviceIds: string[] | null; limit: number; now?: Date },
): Promise<Array<{ id: string; title: string; description: string; severity: 'critical' }>> {
  const conditions: Array<SQL | undefined> = [eq(backupProviderDevices.orgId, orgId)];
  if (opts.allowedDeviceIds) {
    // Site-restricted: only rows attributable to a device this caller may see.
    // `allowedSiteIds` was already resolved into device ids by the route.
    conditions.push(
      opts.allowedDeviceIds.length > 0
        ? inArray(backupProviderDevices.breezeDeviceId, opts.allowedDeviceIds)
        : sql`false`,
    );
  }

  const rows = await db
    .select({
      id: backupProviderDevices.id,
      name: backupProviderDevices.vendorDeviceName,
      // Partner-axis LEFT JOIN: null under an org token (D-11).
      customerName: sql<string | null>`${backupProviderCustomers.vendorCustomerName}`.as('customerName'),
      orgName: organizations.name,
      status: backupProviderDevices.status,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      errorsCount: backupProviderDevices.errorsCount,
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .innerJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
    .leftJoin(backupProviderCustomers, eq(backupProviderCustomers.id, backupProviderDevices.customerId))
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(and(...conditions))
    .limit(opts.limit * 4);

  const now = opts.now ?? new Date();
  const items: Array<{ id: string; title: string; description: string; severity: 'critical' }> = [];
  for (const row of rows) {
    const stale = isConnectionStale(
      {
        isActive: row.connectionIsActive,
        lastSyncAt: row.connectionLastSyncAt,
        syncIntervalMinutes: row.connectionSyncIntervalMinutes,
      },
      now,
    );
    const health = stale
      ? 'unknown'
      : deriveBackupHealth({ status: row.status, lastSuccessAt: row.lastSuccessAt, errorsCount: row.errorsCount, now }).health;
    if (health !== 'critical') continue;
    items.push({
      id: `provider:${row.id}`,
      title: `${row.name}: external backup needs attention`,
      // D-11: the customer name is partner-axis, so it is null for an org
      // token. The mapped org's name is the faithful stand-in — it IS the
      // customer, spelled the way Breeze spells it.
      description: `${row.name} (${row.customerName ?? row.orgName}) — ${row.status}`,
      severity: 'critical',
    });
    if (items.length >= opts.limit) break;
  }
  return items;
}
