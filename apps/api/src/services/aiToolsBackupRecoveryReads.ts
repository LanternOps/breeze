/**
 * Recovery and backup-health reads (full-control W17, #6788). Both are tier 1.
 *
 *  - `list_bmr_recoveries`: bare-metal recoveries, the read half of
 *    routes/backup/bmrRecoveries.ts. Create, cancel and reissue stay human: the
 *    one-time code goes to a person at the machine.
 *  - `get_backup_health`: the unified feed of routes/backup/health.ts, first-party
 *    backup jobs and provider-sourced rows together, which `get_backup_status`
 *    does not see.
 *
 * `target`, `plan` and `result` are console-reported JSON of up to 768 KiB
 * (`bmrProgressSchema`), so they are never selected, let alone projected: the
 * model gets `hasTarget` / `hasPlan` / `hasResult`. The one-time code is stored
 * only as a hash and `recoveryTokenId` stays out too. `failureReason` and
 * `warnings` are console-reported as well, so they are clipped and fenced.
 *
 * A device-bound run sees only its own devices' recoveries. It cannot read the
 * health feed at all, because the rows span devices.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { EXTERNAL_BACKUP_STATUSES, type BackupHealthRow } from '@breeze/shared';
import { db } from '../db';
import { backupSnapshots, bareMetalRecoveries, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  BACKUP_HEALTH_LEVELS,
  BACKUP_HEALTH_SOURCES,
  BMR_RECOVERY_ACTIONS,
} from './aiToolSchemasBackupRecoveryReads';
import { READ_ORG_UNBOUNDED_ERROR, resolveReadableToolOrgScope } from './aiToolWriteOrg';
import { SITE_SCOPE_EMPTY_NOTE, deviceScopeCondition, orgIdIn, siteAllowlistOf, siteScopeCondition } from './aiToolsSiteScope';
import { bounded, clampLimit, clip, jsonError, notFound, thrown } from './aiToolsSoftwareShared';
import { isOverdue } from './bareMetalRecoveryCodes';
import { listBackupHealthRows, summarizeBackupHealth, type BackupHealthListOptions } from './backupHealthReadModel';
import { emptyBackupHealthSummary } from './backupHealthRows';
import { ResilienceAuthorizationError, authorizeResilienceResources } from './resilienceSiteAuthorization';
import { resolveUnmappedDevices } from '../routes/backup/health';

const FAILURE_REASON_MAX_CHARS = 2000;
const WARNINGS_SHOWN = 10;
const WARNING_MAX_CHARS = 500;

/**
 * The shared device gate (org, site and exact-device axes, never a parked device), loaded lazily:
 * aiTools.ts imports this module, so a static value import would be a cycle.
 */
async function gatedDevice(...args: Parameters<typeof import('./aiTools').verifyDeviceAccess>) {
  const { verifyDeviceAccess } = await import('./aiTools');
  return verifyDeviceAccess(...args);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function strings<T extends string>(value: unknown): T[] | undefined {
  return Array.isArray(value) && value.length > 0 ? (value as T[]) : undefined;
}

const RECOVERY_COLUMNS = {
  id: bareMetalRecoveries.id,
  orgId: bareMetalRecoveries.orgId,
  deviceId: bareMetalRecoveries.deviceId,
  snapshotId: bareMetalRecoveries.snapshotId,
  identity: bareMetalRecoveries.identity,
  status: bareMetalRecoveries.status,
  platform: bareMetalRecoveries.platform,
  codeExpiresAt: bareMetalRecoveries.codeExpiresAt,
  codeUsedAt: bareMetalRecoveries.codeUsedAt,
  failureReason: bareMetalRecoveries.failureReason,
  warnings: bareMetalRecoveries.warnings,
  // Presence only: the JSON itself never leaves the database for this tool.
  hasTarget: sql<boolean>`${bareMetalRecoveries.target} IS NOT NULL`,
  hasPlan: sql<boolean>`${bareMetalRecoveries.plan} IS NOT NULL`,
  hasResult: sql<boolean>`${bareMetalRecoveries.result} IS NOT NULL`,
  // The snapshot's server-side file index; null once the snapshot row is gone (the FK is ON DELETE SET NULL).
  fileIndexStatus: backupSnapshots.fileIndexStatus,
  createdAt: bareMetalRecoveries.createdAt,
  updatedAt: bareMetalRecoveries.updatedAt,
  mediaBootedAt: bareMetalRecoveries.mediaBootedAt,
  plannedAt: bareMetalRecoveries.plannedAt,
  restoringAt: bareMetalRecoveries.restoringAt,
  validatedAt: bareMetalRecoveries.validatedAt,
  rebootedAt: bareMetalRecoveries.rebootedAt,
  checkedInAt: bareMetalRecoveries.checkedInAt,
  completedAt: bareMetalRecoveries.completedAt,
};

/** Every read carries the caller's site ceiling (through the recovered device) and exact-device axis in SQL. */
function selectRecoveries(auth: AuthContext, where: SQL | undefined) {
  return db
    .select(RECOVERY_COLUMNS)
    .from(bareMetalRecoveries)
    .innerJoin(devices, eq(devices.id, bareMetalRecoveries.deviceId))
    .leftJoin(backupSnapshots, eq(backupSnapshots.id, bareMetalRecoveries.snapshotId))
    .where(and(
      where,
      siteScopeCondition(auth, devices.siteId),
      deviceScopeCondition(auth, bareMetalRecoveries.deviceId),
    ));
}

type RecoveryRow = Awaited<ReturnType<typeof selectRecoveries>>[number];

/** Exact keys, never a spread: the column accepts any JSON, so `warnings` is treated as hostile too. */
function projectRecovery(row: RecoveryRow) {
  const warnings: unknown[] = Array.isArray(row.warnings) ? row.warnings : [];
  return {
    id: row.id,
    deviceId: row.deviceId,
    snapshotId: row.snapshotId,
    identity: row.identity,
    status: row.status,
    platform: row.platform ?? null,
    overdue: isOverdue(row.status, row.rebootedAt),
    codeExpiresAt: iso(row.codeExpiresAt),
    codeUsedAt: iso(row.codeUsedAt),
    failureReason: clip(row.failureReason, FAILURE_REASON_MAX_CHARS),
    warnings: warnings.slice(0, WARNINGS_SHOWN).map((warning) => clip(warning, WARNING_MAX_CHARS)).filter(Boolean),
    hasTarget: row.hasTarget,
    hasPlan: row.hasPlan,
    hasResult: row.hasResult,
    fileIndexStatus: row.fileIndexStatus ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    mediaBootedAt: iso(row.mediaBootedAt),
    plannedAt: iso(row.plannedAt),
    restoringAt: iso(row.restoringAt),
    validatedAt: iso(row.validatedAt),
    rebootedAt: iso(row.rebootedAt),
    checkedInAt: iso(row.checkedInAt),
    completedAt: iso(row.completedAt),
  };
}

function readOrgs(auth: AuthContext, inputOrgId: string | undefined): { orgIds: string[] } | { error: string } {
  const scope = resolveReadableToolOrgScope(auth, inputOrgId);
  if (!scope.ok) return { error: jsonError(scope.error, inputOrgId ? 'ACCESS_DENIED' : 'VALIDATION_ERROR') };
  return { orgIds: scope.orgIds };
}

async function listRecoveries(auth: AuthContext, input: Record<string, unknown>, orgIds: string[]): Promise<string> {
  const deviceId = str(input.deviceId);
  if (deviceId) {
    const access = await gatedDevice(deviceId, auth);
    if ('error' in access || !orgIds.includes(access.device.orgId)) return notFound('Device');
  }
  if (siteAllowlistOf(auth)?.length === 0) {
    return bounded({ count: 0, recoveries: [], note: SITE_SCOPE_EMPTY_NOTE });
  }
  const rows = await selectRecoveries(auth, and(
    orgIdIn(bareMetalRecoveries.orgId, orgIds),
    deviceId ? eq(bareMetalRecoveries.deviceId, deviceId) : undefined,
  ))
    .orderBy(desc(bareMetalRecoveries.createdAt))
    .limit(clampLimit(input.limit, 25, 50));
  const recoveries = rows.map(projectRecovery);
  return bounded({ count: recoveries.length, recoveries });
}

async function getRecovery(auth: AuthContext, input: Record<string, unknown>, orgIds: string[]): Promise<string> {
  const recoveryId = str(input.recoveryId);
  if (!recoveryId) return jsonError('recoveryId is required for get', 'VALIDATION_ERROR');

  const [row] = await selectRecoveries(auth, and(
    eq(bareMetalRecoveries.id, recoveryId),
    orgIdIn(bareMetalRecoveries.orgId, orgIds),
  )).limit(1);
  if (!row) return notFound('Recovery');
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(row.deviceId)) return notFound('Recovery');

  // The SQL above already applies both axes; the route's own lineage check (loadAuthorizedRecovery) runs too, so
  // the tool refuses at least everything the route refuses.
  try {
    await authorizeResilienceResources({
      orgId: row.orgId,
      principal: {
        kind: auth.principal.kind,
        permissions: {
          permissions: [],
          partnerId: auth.partnerId,
          orgId: auth.orgId,
          roleId: '',
          scope: auth.scope,
          allowedSiteIds: auth.allowedSiteIds,
        },
      },
      refs: [{ kind: 'device', id: row.deviceId, role: 'target' }],
      operation: 'read',
    });
  } catch (error) {
    if (error instanceof ResilienceAuthorizationError) return notFound('Recovery');
    throw error;
  }
  return bounded({ recovery: projectRecovery(row) });
}

/** Exact keys: the 28-day history and byte counts would multiply every row, and the overview answers those. */
function projectHealthRow(row: BackupHealthRow) {
  return {
    key: row.key,
    source: row.source,
    providerKey: row.providerKey,
    providerLabel: row.providerLabel,
    orgId: row.orgId,
    orgName: row.orgName,
    siteId: row.siteId,
    deviceId: row.deviceId,
    name: row.name,
    computerName: row.computerName,
    osType: row.osType,
    accountType: row.accountType,
    status: row.status,
    health: row.health,
    recency: row.recency,
    covered: row.covered,
    stale: row.stale,
    lastSuccessAt: row.lastSuccessAt,
    lastSessionAt: row.lastSessionAt,
    errorsCount: row.errorsCount,
    agentOnline: row.agentOnline,
  };
}

async function readBackupHealth(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  if (auth.allowedDeviceIds !== undefined) {
    return jsonError('Backup health rows span devices; a session bound to specific devices cannot read them', 'ACCESS_DENIED');
  }
  const inputOrgId = str(input.orgId);
  let orgIds: string[];
  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) return jsonError('Access to this organization denied', 'ACCESS_DENIED');
    orgIds = [inputOrgId];
  } else if (Array.isArray(auth.accessibleOrgIds)) {
    orgIds = auth.accessibleOrgIds;
  } else {
    // System scope reaches every org with no finite list. Ask for one rather than scan across partners.
    return jsonError(READ_ORG_UNBOUNDED_ERROR, 'VALIDATION_ERROR');
  }

  const siteIds = siteAllowlistOf(auth);
  if (orgIds.length === 0 || siteIds?.length === 0) {
    // A caller who can see nothing has not observed a healthy fleet; the all-zero summary says exactly that.
    return bounded({ rows: [], summary: emptyBackupHealthSummary(), nextCursor: null, stale: false, unmappedDevices: 0, note: SITE_SCOPE_EMPTY_NOTE });
  }

  const opts: BackupHealthListOptions = {
    sources: strings<(typeof BACKUP_HEALTH_SOURCES)[number]>(input.source),
    onlyWithBackup: typeof input.withBackup === 'boolean' ? input.withBackup : true,
    filter: {
      health: strings(input.health),
      status: strings(input.status),
      search: str(input.search),
    },
    page: { limit: clampLimit(input.limit, 25, 100), cursor: str(input.cursor) ?? null },
  };
  const scope = { orgIds, siteIds: siteIds ? [...siteIds] : undefined };
  const [page, summary, unmappedDevices] = await Promise.all([
    listBackupHealthRows(scope, opts),
    summarizeBackupHealth(scope, { sources: opts.sources, onlyWithBackup: opts.onlyWithBackup, filter: opts.filter }),
    resolveUnmappedDevices(auth),
  ]);
  return bounded({
    rows: page.rows.map(projectHealthRow),
    summary,
    nextCursor: page.nextCursor,
    stale: page.rows.some((row) => row.stale),
    unmappedDevices,
  });
}

export function registerBackupRecoveryReadTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_bmr_recoveries', {
    tier: 1,
    domain: 'backup',
    searchHint: 'bare metal recovery progress: where did a rebuild get to, status, failure reason, overdue check-in',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'list_bmr_recoveries',
      description: 'Read bare-metal recoveries. Actions: list (newest first, optional deviceId), get (recoveryId). Status, phase times, failure reason and warnings; whether a target, plan or result exists, not their contents.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...BMR_RECOVERY_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (narrows to one you can reach)' },
          deviceId: { type: 'string', description: 'list: only this device\'s recoveries' },
          recoveryId: { type: 'string', description: 'get: recovery UUID from list' },
          limit: { type: 'number', description: 'Max rows for list (default 25, max 50)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as (typeof BMR_RECOVERY_ACTIONS)[number];
      if (!BMR_RECOVERY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const orgs = readOrgs(auth, str(input.orgId));
      if ('error' in orgs) return orgs.error;
      try {
        return action === 'list'
          ? await listRecoveries(auth, input, orgs.orgIds)
          : await getRecovery(auth, input, orgs.orgIds);
      } catch (error) {
        return thrown('list_bmr_recoveries', error);
      }
    },
  });

  aiTools.set('get_backup_health', {
    tier: 1,
    domain: 'backup',
    searchHint: 'backup health across customers including Cove and other providers, failing or stale backups, unprotected devices',
    definition: {
      name: 'get_backup_health',
      description: 'Backup health per device across the organizations you reach, from Breeze jobs and connected backup providers together, with totals. Filter by source, health, status or search; withBackup false adds devices with no backup at all.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization UUID (required for a system-wide session)' },
          source: { type: 'array', items: { type: 'string', enum: [...BACKUP_HEALTH_SOURCES] }, description: 'Row source filter' },
          health: { type: 'array', items: { type: 'string', enum: [...BACKUP_HEALTH_LEVELS] }, description: 'Health filter' },
          status: { type: 'array', items: { type: 'string', enum: [...EXTERNAL_BACKUP_STATUSES] }, description: 'Backup status filter' },
          withBackup: { type: 'boolean', description: 'Default true: only rows with backup evidence. False adds devices with none' },
          search: { type: 'string', description: 'Device, computer or organization name contains (max 200 chars)' },
          cursor: { type: 'string', description: 'nextCursor from the previous page' },
          limit: { type: 'number', description: 'Max rows (default 25, max 100)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        return await readBackupHealth(auth, input);
      } catch (error) {
        return thrown('get_backup_health', error);
      }
    },
  });
}
