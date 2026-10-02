import { and, asc, countDistinct, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupProviderDevices,
  backupSlaEvents,
  backupVerifications,
  devices,
  portalBranding,
  recoveryReadiness,
  DEGRADED_BACKUP_JOB_STATUSES,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import type {
  BackupDeviceRow,
  BackupDevicesDto,
  BackupHealth,
  BackupHealthRow,
  BackupOverviewDto,
  ExternalBackupStatus,
} from '@breeze/shared';
import { getFirstPartyCoverageForDevices, listBackupHealthRows } from '../backupHealthReadModel';
import { sqlTimestamp } from './sqlTimestamp';

/**
 * A device counts as "configured" for first-party backup when it has a job
 * under one of the org's ACTIVE configs. Shared by the tile's third-party
 * count and the device ledger so the two never disagree about which devices
 * first-party backup already covers.
 */
function firstPartyConfiguredSql(orgId: string, deviceId: SQL) {
  return sql<boolean>`
    exists (
      select 1
      from backup_jobs bj
      join backup_configs bc
        on bc.id = bj.config_id
       and bc.org_id = ${orgId}
       and bc.is_active = true
      where bj.org_id = ${orgId}
        and bj.device_id = ${deviceId}
    )
  `;
}

/**
 * "Backed up" (#7505) means covered by ANY backup source — Breeze's own or a
 * connected third-party provider — counted over the same population the Backups
 * table lists: managed devices plus unlinked third-party rows. The dashboard's
 * "Devices protected" tile is a different concept (endpoint security) and is
 * labelled as such.
 *
 * The dashboard tile is built for every org unconditionally
 * (`portal/dashboard.ts`), so third-party backup rows fold in only when the
 * org has turned portal Backups on — the same gate as the Backups page (spec
 * "Client portal"). With it off, or with no third-party rows, the tile is
 * exactly what it was before #6012.
 *
 * `completedAt`/`verificationType` stay first-party only: a vendor's
 * successful session is not a verification, and the tile reads "Last backup
 * verified".
 */
export async function backupTile(orgId: string, now: Date) {
  const [totalRows, activeConfigRows, configuredRows, latestRows, brandingRows] = await Promise.all([
    db
      .select({ total: countDistinct(devices.id) })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(and(
        eq(backupConfigs.orgId, orgId),
        eq(backupConfigs.isActive, true),
      ))
      .limit(1),
    db
      .select({ configured: countDistinct(backupJobs.deviceId) })
      .from(backupJobs)
      .innerJoin(
        backupConfigs,
        and(
          eq(backupJobs.configId, backupConfigs.id),
          eq(backupConfigs.orgId, orgId),
          eq(backupConfigs.isActive, true),
        ),
      )
      .where(eq(backupJobs.orgId, orgId)),
    db
      .select({
        completedAt: backupVerifications.completedAt,
        verificationType: backupVerifications.verificationType,
      })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.status, 'passed'),
      ))
      .orderBy(desc(backupVerifications.completedAt))
      .limit(1),
    db
      .select({ enableBackups: portalBranding.enableBackups })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, orgId))
      .limit(1),
  ]);

  let total = Number(totalRows[0]?.total ?? 0);
  const hasActiveConfig = activeConfigRows.length > 0;
  let configured = Number(configuredRows[0]?.configured ?? 0);
  const latest = latestRows[0];

  let hasThirdPartyBackup = false;
  if (brandingRows[0]?.enableBackups === true) {
    // `linkedOnly`: managed devices a third party backs up that first-party
    // backup does not already count. `unlinked`: third-party rows with no
    // managed device. The device join is pinned to this org as well as the
    // row, so a link can never count one org's device toward another's.
    const [counts] = await db
      .select({
        linkedOnly: sql<number>`(count(distinct ${backupProviderDevices.breezeDeviceId}) filter (
          where ${devices.id} is not null
            and ${devices.isEphemeral} = false
            and not ${firstPartyConfiguredSql(orgId, sql`${devices.id}`)}
        ))::int`,
        unlinked: sql<number>`(count(*) filter (where ${backupProviderDevices.breezeDeviceId} is null))::int`,
      })
      .from(backupProviderDevices)
      .leftJoin(
        devices,
        and(eq(devices.id, backupProviderDevices.breezeDeviceId), eq(devices.orgId, orgId)),
      )
      .where(eq(backupProviderDevices.orgId, orgId));
    const linkedOnly = Number(counts?.linkedOnly ?? 0);
    const unlinked = Number(counts?.unlinked ?? 0);
    // One population for the count AND the Backups table (#7505): the table
    // lists every managed device plus each unlinked third-party row, and each
    // of those rows is by definition backed up. Counting them in both numerator
    // and denominator keeps "N of M" equal to the table's row total.
    configured += linkedOnly + unlinked;
    total += unlinked;
    hasThirdPartyBackup = linkedOnly > 0 || unlinked > 0;
  }

  return {
    status:
      !hasActiveConfig && !hasThirdPartyBackup
        ? 'not_configured' as const
        : latest
          ? 'ok' as const
          : 'no_data' as const,
    completedAt: latest?.completedAt?.toISOString() ?? null,
    verificationType: latest?.verificationType ?? null,
    configured,
    total,
    asOf: now.toISOString(),
  };
}

// ── third-party rows, merged onto the device ledger (#6012) ────────────────

const PROVIDER_PAGE_SIZE = 500;
const PROVIDER_MAX_PAGES = 20;

/**
 * Every third-party backup row for the org, from the unified read model with
 * CUSTOMER labels (`labels: 'portal'`): the vendor is named only where the
 * MSP turned the per-connection toggle on (spec D5). The portal runs under an
 * org token, so the read model's own org + RLS scoping already fences this;
 * the `orgId` filter here is defence in depth on a customer-facing surface.
 * Portal users carry no site restriction, so unlinked rows are theirs to see.
 */
async function loadPortalProviderRows(orgId: string, now: Date): Promise<BackupHealthRow[]> {
  const out: BackupHealthRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PROVIDER_MAX_PAGES; page += 1) {
    const result = await listBackupHealthRows(
      { orgIds: [orgId] },
      { sources: ['provider'], labels: 'portal', page: { limit: PROVIDER_PAGE_SIZE, cursor }, now },
    );
    for (const row of result.rows) {
      if (row.orgId === orgId) out.push(row);
    }
    if (!result.nextCursor) return out;
    cursor = result.nextCursor;
  }
  console.warn(
    `[portal/backupReadModel] org ${orgId} has more than ${PROVIDER_PAGE_SIZE * PROVIDER_MAX_PAGES} third-party backup rows; the portal shows the first ${out.length}`,
  );
  return out;
}

/** The third-party row that speaks for a managed device. Two rows per device is
 *  a post-acquisition corner; the covered one, then the fresher one, wins. */
function linkedProviderByDevice(rows: BackupHealthRow[]): Map<string, BackupHealthRow> {
  const out = new Map<string, BackupHealthRow>();
  for (const row of rows) {
    if (!row.deviceId) continue;
    const existing = out.get(row.deviceId);
    if (
      !existing ||
      (row.covered && !existing.covered) ||
      (row.covered === existing.covered && (row.lastSuccessAt ?? '') > (existing.lastSuccessAt ?? ''))
    ) {
      out.set(row.deviceId, row);
    }
  }
  return out;
}

type FirstPartyState = { status: ExternalBackupStatus; health: BackupHealth; lastSuccessAt: string | null };

/** ISO-8601 strings in one format compare lexicographically in time order. */
function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * One portal row per managed device. First-party backup is the headline when
 * it has any evidence (Breeze's own product is what the MSP runs and answers
 * for); a device only a third party backs up takes the third party's status.
 * A device with no backup from any source is `no_backups` / `unknown` — the
 * page states that plainly rather than painting every unprotected workstation
 * "Critical" on the customer's screen.
 */
function mergeDeviceBackup(firstParty: FirstPartyState | undefined, provider: BackupHealthRow | undefined) {
  const firstPartyHasEvidence = firstParty !== undefined && firstParty.status !== 'no_backups';
  const headline = firstPartyHasEvidence ? firstParty : provider;
  return {
    hasEvidence: firstPartyHasEvidence || provider !== undefined,
    /** Which product the headline status comes from. */
    source: !firstPartyHasEvidence && provider !== undefined ? ('external' as const) : ('breeze' as const),
    status: headline?.status ?? ('no_backups' as const),
    health: headline?.health ?? ('unknown' as const),
    lastSuccessAt: maxIso(firstParty?.lastSuccessAt, provider?.lastSuccessAt),
    providerLabel: provider?.providerLabel ?? null,
  };
}

function emptyByHealth(): Record<BackupHealth, number> {
  return { healthy: 0, warning: 0, critical: 0, unknown: 0 };
}

/** The health breakdown and provider labels for the WHOLE org's ledger. */
async function loadLedgerHealth(orgId: string, now: Date) {
  const [idRows, providerRows] = await Promise.all([
    db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    loadPortalProviderRows(orgId, now),
  ]);
  const deviceIds = idRows.map((row) => row.id);
  const firstParty = deviceIds.length > 0
    ? await getFirstPartyCoverageForDevices(orgId, deviceIds, { now })
    : new Map<string, FirstPartyState>();
  const linked = linkedProviderByDevice(providerRows);

  // Rows with backup evidence only — the same default as the technician
  // overview ("like the Cove email"); unprotected devices are counted by the
  // Protected-devices line, not as a health bucket.
  const byHealth = emptyByHealth();
  for (const deviceId of deviceIds) {
    const merged = mergeDeviceBackup(firstParty.get(deviceId), linked.get(deviceId));
    if (merged.hasEvidence) byHealth[merged.health] += 1;
  }
  for (const row of providerRows) {
    if (!row.deviceId) byHealth[row.health] += 1;
  }

  const externalProviders = [
    ...new Set(providerRows.map((row) => row.providerLabel).filter((label): label is string => label !== null)),
  ].sort();

  return { byHealth, externalProviders };
}

// W06 — backup overview + per-device backup evidence

export async function backupOverview(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<BackupOverviewDto> {
  const [tile, restoreRows, breachRows, readinessRows, ledger] = await Promise.all([
    backupTile(orgId, args.now),
    db
      .select({
        completedAt: backupVerifications.completedAt,
        status: backupVerifications.status,
      })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.verificationType, 'test_restore'),
      ))
      .orderBy(sql`${backupVerifications.completedAt} desc nulls last`)
      .limit(1),
    db
      .select({ eventType: backupSlaEvents.eventType })
      .from(backupSlaEvents)
      .where(and(
        eq(backupSlaEvents.orgId, orgId),
        isNull(backupSlaEvents.resolvedAt),
      )),
    // Do not call getBackupHealthSummary here; it exits to a system DB context.
    db
      .select({
        readinessCount: sql<number>`count(${recoveryReadiness.readinessScore})::int`,
        totalDevices: sql<number>`count(${devices.id})::int`,
        meanReadinessScore: sql<number | null>`avg(${recoveryReadiness.readinessScore})::float`,
      })
      .from(devices)
      .leftJoin(
        recoveryReadiness,
        and(
          eq(recoveryReadiness.deviceId, devices.id),
          eq(recoveryReadiness.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    // The overview route is already gated on enable_backups (routes/portal/index.ts).
    loadLedgerHealth(orgId, args.now),
  ]);

  // Mirrors apps/api/src/jobs/backupSlaWorker.ts: 'missed_backup' is an RPO-family event.
  const RPO_EVENT_TYPES = new Set(['rpo_breach', 'missed_backup']);
  const RTO_EVENT_TYPES = new Set(['rto_breach']);
  const countBreach = (family: 'rpo' | 'rto') =>
    breachRows.filter((row) =>
      (family === 'rpo' ? RPO_EVENT_TYPES : RTO_EVENT_TYPES).has(row.eventType),
    ).length;
  const openRpoBreaches = countBreach('rpo');
  const openRtoBreaches = countBreach('rto');
  const readiness = readinessRows[0];
  const readinessScoredDevices = readiness
    ? Number(readiness.readinessCount ?? 0)
    : null;
  const readinessTotalDevices = readiness
    ? Number(readiness.totalDevices ?? 0)
    : null;

  return {
    asOf: args.now.toISOString(),
    dataStatus: tile.status,
    protected: tile.configured,
    unprotected:
      tile.total == null || tile.configured == null
        ? null
        : tile.total - tile.configured,
    total: tile.total,
    lastPassedVerification:
      tile.completedAt && tile.verificationType
        ? { completedAt: tile.completedAt, verificationType: tile.verificationType }
        : null,
    lastTestRestoreAt: restoreRows[0]?.completedAt?.toISOString() ?? null,
    lastTestRestoreStatus: restoreRows[0]?.status ?? null,
    openRpoBreaches:
      openRpoBreaches > 0 || tile.status === 'ok' ? openRpoBreaches : null,
    openRtoBreaches:
      openRtoBreaches > 0 || tile.status === 'ok' ? openRtoBreaches : null,
    meanReadinessScore:
      readinessScoredDevices != null &&
      readinessScoredDevices > 0 &&
      readiness?.meanReadinessScore != null
        ? Number(readiness.meanReadinessScore)
        : null,
    readinessScoredDevices,
    readinessTotalDevices,
    byHealth: ledger.byHealth,
    externalProviders: ledger.externalProviders,
  };
}

/**
 * The ledger is managed devices (hostname order, SQL-paged exactly as before)
 * followed by third-party rows with no managed device (the read model's name
 * order). Pages are offsets into that concatenation, so a row is never
 * repeated or dropped between pages and `total` is the same on every page.
 */
export async function backupDevicesPage(
  orgId: string,
  args: { page: number; limit: number; timezone: string; now: Date },
): Promise<BackupDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const restorableStatuses = sql.join(
    RESTORABLE_BACKUP_JOB_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const [countRows, rows, providerRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        configured: firstPartyConfiguredSql(orgId, sql`${devices.id}`),
        lastBackupAt: sql<Date | string | null>`(
          select max(bj.completed_at)
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
        )`,
        lastBackupStatus: sql<string | null>`(
          select bj.status
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
          order by bj.completed_at desc nulls last
          limit 1
        )`,
        testRestoreStatus: sql<string | null>`(
          select bv.status
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        testRestoreAt: sql<Date | string | null>`(
          select max(bv.completed_at)
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
        )`,
        restoreTimeSeconds: sql<number | null>`(
          select bv.restore_time_seconds
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        openBreaches: sql<string[]>`
          coalesce((
            select array_agg(distinct bse.event_type)
            from backup_sla_events bse
            where bse.org_id = ${orgId}
              and bse.device_id = ${devices.id}
              and bse.resolved_at is null
          ), array[]::text[])
        `,
        readinessScore: recoveryReadiness.readinessScore,
        estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes,
        estimatedRpoMinutes: recoveryReadiness.estimatedRpoMinutes,
      })
      .from(devices)
      .leftJoin(
        recoveryReadiness,
        and(
          eq(recoveryReadiness.deviceId, devices.id),
          eq(recoveryReadiness.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(devices.hostname), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
    loadPortalProviderRows(orgId, args.now),
  ]);

  const pageDeviceIds = rows.map((row) => row.id);
  const firstParty = pageDeviceIds.length > 0
    ? await getFirstPartyCoverageForDevices(orgId, pageDeviceIds, { now: args.now })
    : new Map<string, FirstPartyState>();
  const linked = linkedProviderByDevice(providerRows);

  const data: BackupDeviceRow[] = rows.map((row) => {
    const provider = linked.get(row.id);
    const merged = mergeDeviceBackup(firstParty.get(row.id), provider);
    const firstPartyRestorePoint = sqlTimestamp(row.lastBackupAt)?.toISOString() ?? null;
    const providerIsNewer =
      provider?.lastSuccessAt != null &&
      (firstPartyRestorePoint == null || provider.lastSuccessAt > firstPartyRestorePoint);
    return {
      id: row.id,
      name: row.displayName ?? row.hostname,
      configured: row.configured || provider !== undefined,
      lastRestorePointAt: providerIsNewer ? provider!.lastSuccessAt : firstPartyRestorePoint,
      // #5396: any restore point that missed files is degraded, whether under
      // the threshold (completed_with_errors) or over it (partial). When the
      // newest restore point is the third party's, its own status decides.
      lastRestorePointDegraded: providerIsNewer
        ? provider!.status === 'completed_with_errors'
        : (DEGRADED_BACKUP_JOB_STATUSES as readonly string[]).includes(row.lastBackupStatus ?? ''),
      lastTestRestore: row.testRestoreStatus
        ? {
            status: row.testRestoreStatus,
            completedAt: sqlTimestamp(row.testRestoreAt)?.toISOString() ?? null,
            restoreTimeSeconds: row.restoreTimeSeconds,
          }
        : null,
      openBreaches: row.openBreaches,
      readinessScore: row.readinessScore,
      estimatedRtoMinutes: row.estimatedRtoMinutes,
      estimatedRpoMinutes: row.estimatedRpoMinutes,
      source: merged.source,
      providerLabel: merged.providerLabel,
      status: merged.status,
      health: merged.health,
      lastSuccessAt: merged.lastSuccessAt,
    };
  });

  // Verification, test-restore, breach and readiness are first-party facts; a
  // third-party success proves none of them, so an external row carries none.
  const external = providerRows.filter((row) => !row.deviceId);
  const deviceTotal = Number(countRows[0]?.count ?? 0);
  const externalStart = Math.max(0, offset - deviceTotal);
  const externalCount = Math.max(0, offset + args.limit - Math.max(offset, deviceTotal));
  const externalRows: BackupDeviceRow[] = external
    .slice(externalStart, externalStart + externalCount)
    .map((row) => ({
      id: row.key,
      name: row.name,
      configured: true,
      lastRestorePointAt: row.lastSuccessAt,
      lastRestorePointDegraded: row.status === 'completed_with_errors',
      lastTestRestore: null,
      openBreaches: [],
      readinessScore: null,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
      source: 'external',
      providerLabel: row.providerLabel,
      status: row.status,
      health: row.health,
      lastSuccessAt: row.lastSuccessAt,
    }));

  const total = deviceTotal + external.length;

  return {
    dataStatus: total === 0 ? 'no_data' : 'ok',
    asOf: args.now.toISOString(),
    data: [...data, ...externalRows],
    pagination: {
      page: args.page,
      limit: args.limit,
      total,
    },
  };
}
