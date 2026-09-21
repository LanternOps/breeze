import { and, asc, eq, inArray, notInArray, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  BARE_METAL_RECOVERY_TERMINAL,
  backupSnapshots,
  bareMetalRecoveries,
  deviceCommands,
  drExecutions,
  drPlanGroups,
  type BareMetalRecoveryStatus,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { createAuditLogAsync } from './auditService';
import {
  BareMetalRecoveryError,
  cancelBareMetalRecovery,
  createBareMetalRecovery,
  mintRecoveryTokenForRecovery,
} from './bareMetalRecoveryService';
import { queueBareMetalRebuild } from './bareMetalRebuildCommand';
import { CommandTypes, queueCommandForExecution } from './commandQueue';
import { resolveServerUrl } from './recoveryBootstrap';
import {
  authorizeQueuedRecoveryWork,
  captureRecoveryAuthorizationSubject,
  RecoveryAuthorizationDeniedError,
  RecoveryAuthorizationTransientError,
  type RecoveryAuthorizationIntent,
  type RecoveryAuthorizationSubjectRow,
} from './recoveryAuthorizationSubject';
import {
  ResilienceAuthorizationError,
  type ResilienceResourceRef,
} from './resilienceSiteAuthorization';
import {
  DR_STEP_BARE_METAL_REBUILD,
  drBareMetalRebuildConfigSchema,
  isBareMetalRebuildConfig,
  resolveLatestRestorableSnapshotId as resolveLatestRestorableSnapshotIdWithDb,
  type DrBareMetalRebuildConfig,
} from './drBareMetalRebuildStep';

const DR_ALLOWED_COMMAND_TYPES = new Set<string>([
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.BMR_RECOVER,
  // Not a device command for failover/failback — see dispatchBareMetalRebuildGroup.
  DR_STEP_BARE_METAL_REBUILD,
]);

export type DrPlanGroupRecord = typeof drPlanGroups.$inferSelect;
type DrExecutionRecord = typeof drExecutions.$inferSelect;
type DeviceCommandRecord = typeof deviceCommands.$inferSelect;
type BareMetalRecoveryRecord = typeof bareMetalRecoveries.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DrDb = typeof db | DbTransaction;

export const DR_RECOVERY_AUTHORIZATION_INTENT: RecoveryAuthorizationIntent = {
  operation: 'restore',
  requiredPermission: { resource: 'devices', action: 'execute' },
  requiredDelegatedScopesAny: ['ai:execute', 'devices:execute'],
  requiredAiTool: 'execute_dr_plan',
};

export type DrReconcileOutcome = {
  execution: DrExecutionRecord | null;
  nextDelayMs: number | null;
};

type PlannedGroup = {
  id: string;
  name: string;
  sequence: number;
  deviceCount: number;
  estimatedDurationMinutes: number | null;
  dependsOnGroupId: string | null;
  restoreConfig: Record<string, unknown>;
};

type QueuedDrCommand = {
  groupId: string;
  groupName: string;
  deviceId: string;
  commandId: string;
  commandType: string;
  status: string;
};

/**
 * W05b: one entry per (group, device) whose step created a `bare_metal_recoveries`
 * row instead of (failover/failback) or in addition to (rehearsal) a device
 * command. The dedupe key at dispatch is `(groupId, deviceId)`, so reconcile
 * can never mint a second recovery for a device. `commandId` is the
 * rehearsal's `bare_metal_rebuild` command on the HOST, or null.
 */
export type QueuedDrRecovery = {
  groupId: string;
  groupName: string;
  deviceId: string;
  recoveryId: string;
  executingDeviceId: string | null;
  commandId: string | null;
  createdAt: string;
};

type FailedDispatch = {
  groupId: string;
  groupName: string;
  deviceId?: string;
  commandType?: string;
  error: string;
};

export type GroupDeviceStatus = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  commandId?: string;
  commandType?: string;
  error?: string;
  /** W05b — set when the device's status derives from a recovery row. */
  recoveryId?: string;
  recoveryStatus?: BareMetalRecoveryStatus | null;
  executingDeviceId?: string | null;
  /** `timeout` when `now - createdAt > waitTimeoutMinutes` while the recovery is still non-terminal. */
  reason?: 'timeout';
};

type GroupResult = {
  groupId: string;
  name: string;
  sequence: number;
  dependsOnGroupId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  devices: GroupDeviceStatus[];
};

export type DrExecutionResults = {
  dispatchStatus: 'queued' | 'running' | 'partial' | 'failed' | 'completed';
  queuedAt: string;
  groupCount: number;
  deviceCount: number;
  plannedGroups: PlannedGroup[];
  queuedCommands: QueuedDrCommand[];
  /** W05b. Missing on executions persisted before the field existed — normalised to []. */
  queuedRecoveries: QueuedDrRecovery[];
  failedDispatches: FailedDispatch[];
  groupResults: GroupResult[];
  activeGroupId?: string | null;
  haltReason?: string | null;
  /** Historical audit context only. Never authorization authority. */
  authorizedDeviceIds?: string[] | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeQueuedCommands(value: unknown): QueuedDrCommand[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      groupId: String(entry.groupId ?? ''),
      groupName: String(entry.groupName ?? ''),
      deviceId: String(entry.deviceId ?? ''),
      commandId: String(entry.commandId ?? ''),
      commandType: String(entry.commandType ?? ''),
      status: String(entry.status ?? 'pending'),
    }))
    .filter((entry) => entry.groupId && entry.commandId && entry.deviceId);
}

function normalizeQueuedRecoveries(value: unknown): QueuedDrRecovery[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      groupId: String(entry.groupId ?? ''),
      groupName: String(entry.groupName ?? ''),
      deviceId: String(entry.deviceId ?? ''),
      recoveryId: String(entry.recoveryId ?? ''),
      executingDeviceId: typeof entry.executingDeviceId === 'string' ? entry.executingDeviceId : null,
      commandId: typeof entry.commandId === 'string' ? entry.commandId : null,
      createdAt: String(entry.createdAt ?? ''),
    }))
    .filter((entry) => entry.groupId && entry.recoveryId && entry.deviceId);
}

function normalizeFailedDispatches(value: unknown): FailedDispatch[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      groupId: String(entry.groupId ?? ''),
      groupName: String(entry.groupName ?? ''),
      deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : undefined,
      commandType: typeof entry.commandType === 'string' ? entry.commandType : undefined,
      error: String(entry.error ?? 'Dispatch failed'),
    }))
    .filter((entry) => entry.groupId && entry.error);
}

function normalizePlannedGroups(groups: DrPlanGroupRecord[]): PlannedGroup[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    sequence: group.sequence,
    deviceCount: Array.isArray(group.devices) ? group.devices.length : 0,
    estimatedDurationMinutes: group.estimatedDurationMinutes ?? null,
    dependsOnGroupId: group.dependsOnGroupId ?? null,
    restoreConfig: asRecord(group.restoreConfig),
  }));
}

function buildInitialResults(groups: DrPlanGroupRecord[], queuedAt: Date): DrExecutionResults {
  const plannedGroups = normalizePlannedGroups(groups);
  const groupResults: GroupResult[] = groups.map((group) => ({
    groupId: group.id,
    name: group.name,
    sequence: group.sequence,
    dependsOnGroupId: group.dependsOnGroupId ?? null,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    devices: (Array.isArray(group.devices) ? group.devices : []).map((deviceId) => ({
      id: deviceId,
      status: 'pending',
    })),
  }));

  return {
    dispatchStatus: 'queued',
    queuedAt: queuedAt.toISOString(),
    groupCount: plannedGroups.length,
    deviceCount: plannedGroups.reduce((sum, group) => sum + group.deviceCount, 0),
    plannedGroups,
    queuedCommands: [],
    queuedRecoveries: [],
    failedDispatches: [],
    groupResults,
    activeGroupId: null,
    haltReason: null,
  };
}

function normalizeCommandStatus(command: DeviceCommandRecord | undefined): GroupDeviceStatus['status'] {
  if (!command) return 'running';
  if (command.status === 'completed') return 'completed';
  if (command.status === 'failed') return 'failed';
  return 'running';
}

function extractCommandError(command: DeviceCommandRecord | undefined): string | undefined {
  const result = asRecord(command?.result);
  if (typeof result.error === 'string' && result.error.trim()) return result.error;
  if (typeof result.stderr === 'string' && result.stderr.trim()) return result.stderr;
  return undefined;
}

/** The group's wait budget for a BARE_METAL_REBUILD step (schema default when unset/invalid). */
function bareMetalRebuildWaitTimeoutMs(group: Pick<DrPlanGroupRecord, 'restoreConfig'>): number {
  const parsed = drBareMetalRebuildConfigSchema.safeParse(asRecord(group.restoreConfig));
  const minutes = parsed.success
    ? parsed.data.waitTimeoutMinutes
    : drBareMetalRebuildConfigSchema.parse({ commandType: DR_STEP_BARE_METAL_REBUILD }).waitTimeoutMinutes;
  return minutes * 60_000;
}

function recoveryDeviceStatus(
  deviceId: string,
  queued: QueuedDrRecovery,
  row: BareMetalRecoveryRecord | undefined,
  waitTimeoutMs: number,
  now: Date,
): GroupDeviceStatus {
  const base: GroupDeviceStatus = {
    id: deviceId,
    status: 'running',
    commandType: DR_STEP_BARE_METAL_REBUILD,
    recoveryId: queued.recoveryId,
    recoveryStatus: row?.status ?? null,
    executingDeviceId: queued.executingDeviceId,
    ...(queued.commandId ? { commandId: queued.commandId } : {}),
  };
  const status = row?.status;
  if (status === 'checked_in' || status === 'completed') {
    return { ...base, status: 'completed' };
  }
  if (status === 'failed' || status === 'refused') {
    return { ...base, status: 'failed', ...(row?.failureReason ? { error: row.failureReason } : {}) };
  }
  const createdAt = row?.createdAt ?? new Date(queued.createdAt);
  if (!Number.isNaN(createdAt.getTime()) && now.getTime() - createdAt.getTime() > waitTimeoutMs) {
    return {
      ...base,
      status: 'failed',
      reason: 'timeout',
      error: `Recovery did not complete within ${Math.round(waitTimeoutMs / 60_000)} minutes`,
    };
  }
  return base;
}

function recoveryTerminalAt(row: BareMetalRecoveryRecord): Date {
  return row.completedAt ?? row.checkedInAt ?? row.updatedAt;
}

export function computeGroupResults(
  groups: DrPlanGroupRecord[],
  queuedCommands: QueuedDrCommand[],
  queuedRecoveries: QueuedDrRecovery[],
  failedDispatches: FailedDispatch[],
  commandMap: Map<string, DeviceCommandRecord>,
  recoveryMap: Map<string, BareMetalRecoveryRecord>,
  now: Date = new Date(),
): GroupResult[] {
  return groups.map((group) => {
    const devices = Array.isArray(group.devices) ? group.devices : [];
    const queuedForGroup = queuedCommands.filter((entry) => entry.groupId === group.id);
    const recoveriesForGroup = queuedRecoveries.filter((entry) => entry.groupId === group.id);
    const dispatchFailures = failedDispatches.filter((entry) => entry.groupId === group.id);
    const waitTimeoutMs = recoveriesForGroup.length > 0 ? bareMetalRebuildWaitTimeoutMs(group) : 0;

    const deviceStatuses: GroupDeviceStatus[] = devices.map((deviceId) => {
      const queued = queuedForGroup.find((entry) => entry.deviceId === deviceId);
      const queuedRecovery = recoveriesForGroup.find((entry) => entry.deviceId === deviceId);
      const dispatchFailure = dispatchFailures.find((entry) => entry.deviceId === deviceId);
      const command = queued ? commandMap.get(queued.commandId) : undefined;

      if (dispatchFailure) {
        return {
          id: deviceId,
          status: 'failed',
          commandId: queued?.commandId,
          commandType: queued?.commandType ?? dispatchFailure.commandType,
          error: dispatchFailure.error,
        };
      }

      if (queuedRecovery) {
        return recoveryDeviceStatus(deviceId, queuedRecovery, recoveryMap.get(queuedRecovery.recoveryId), waitTimeoutMs, now);
      }

      if (!queued) {
        return { id: deviceId, status: 'pending' };
      }

      return {
        id: deviceId,
        status: normalizeCommandStatus(command),
        commandId: queued.commandId,
        commandType: queued.commandType,
        error: extractCommandError(command),
      };
    });

    const commandRows = queuedForGroup
      .map((entry) => commandMap.get(entry.commandId))
      .filter((entry): entry is DeviceCommandRecord => !!entry);
    const recoveryRows = recoveriesForGroup
      .map((entry) => recoveryMap.get(entry.recoveryId))
      .filter((entry): entry is BareMetalRecoveryRecord => !!entry);
    const startedAt = [
      ...commandRows.map((entry) => entry.executedAt ?? entry.createdAt),
      ...recoveryRows.map((entry) => entry.createdAt),
    ]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const allCommandsDone = commandRows.length > 0 && commandRows.every((entry) => entry.completedAt instanceof Date);
    const allRecoveriesDone = recoveryRows.length > 0 && recoveryRows.every((entry) => BARE_METAL_RECOVERY_TERMINAL.has(entry.status));
    const completedAt = (commandRows.length === 0 || allCommandsDone)
      && (recoveryRows.length === 0 || allRecoveriesDone)
      && (commandRows.length > 0 || recoveryRows.length > 0)
      ? [
          ...commandRows.map((entry) => entry.completedAt as Date),
          ...recoveryRows.map(recoveryTerminalAt),
        ].sort((a, b) => b.getTime() - a.getTime())[0] ?? null
      : null;

    let status: GroupResult['status'] = 'pending';
    if (deviceStatuses.some((entry) => entry.status === 'failed')) {
      status = deviceStatuses.some((entry) => entry.status === 'running') ? 'running' : 'failed';
    } else if (deviceStatuses.length > 0 && deviceStatuses.every((entry) => entry.status === 'completed')) {
      status = 'completed';
    } else if (deviceStatuses.some((entry) => entry.status === 'running' || entry.status === 'completed')) {
      status = 'running';
    }

    if (dispatchFailures.length > 0 && !deviceStatuses.some((entry) => entry.status === 'running')) {
      status = 'failed';
    }

    return {
      groupId: group.id,
      name: group.name,
      sequence: group.sequence,
      dependsOnGroupId: group.dependsOnGroupId ?? null,
      status,
      startedAt: startedAt ? startedAt.toISOString() : null,
      completedAt: completedAt ? completedAt.toISOString() : null,
      devices: deviceStatuses,
    };
  });
}

async function loadDrPlanGroups(planId: string, orgId: string, tx: DrDb = db): Promise<DrPlanGroupRecord[]> {
  return tx
    .select()
    .from(drPlanGroups)
    .where(and(eq(drPlanGroups.planId, planId), eq(drPlanGroups.orgId, orgId)))
    .orderBy(asc(drPlanGroups.sequence));
}

export class DrRecoveryAuthorizationDeniedError extends Error {
  readonly retriable = false;

  constructor(readonly code: string) {
    super(code);
    this.name = 'DrRecoveryAuthorizationDeniedError';
  }
}

/**
 * Denial codes that mean "a prerequisite resource is missing", which the route
 * renders as 404. Every other `DrRecoveryAuthorizationDeniedError` code is a
 * malformed plan/step configuration — a 400.
 *
 * #6382: these codes reach the operator verbatim in the DR dashboard, so a
 * single overloaded `resource_not_found` was unactionable ("what is missing —
 * the snapshot? the host? the device?"). Each refusal now names its own
 * prerequisite so the console can print a sentence for it. `resource_not_found`
 * is retained only for a snapshot reference that resolves to nothing, which is
 * the one case where it is literally accurate.
 */
export const DR_MISSING_PREREQUISITE_DENIAL_CODES: ReadonlySet<string> = new Set([
  'resource_not_found',
  'no_restorable_snapshot',
  'no_recovery_source',
]);

export type DrExecutionAuthorizationFailure = {
  status: 400 | 403 | 404 | 503;
  code: string;
};

/**
 * Translate an authorization failure raised while starting a DR execution into
 * the status the caller should see, or null when the error is not one.
 *
 * `createDrExecutionAndEnqueue` authorizes every group device against the
 * caller's site grant before an execution row exists, so a denial is a normal,
 * expected outcome for a site-restricted technician. Left uncaught it reaches
 * the global Hono handler, which renders anything that is not an HTTPException
 * as a 500 and reports it to Sentry — telling the caller the server broke and
 * burying a genuine authorization signal in fault noise (#3653).
 *
 * Returning null for an unrecognised error is deliberate: the caller must
 * rethrow it so real faults keep failing loudly.
 */
export function classifyDrExecutionAuthorizationError(
  error: unknown,
): DrExecutionAuthorizationFailure | null {
  if (error instanceof ResilienceAuthorizationError) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof RecoveryAuthorizationTransientError) {
    // The subject could not be re-verified. Not a denial — a retryable outage.
    return { status: 503, code: error.code };
  }
  if (error instanceof RecoveryAuthorizationDeniedError) {
    return { status: 403, code: error.code };
  }
  if (error instanceof DrRecoveryAuthorizationDeniedError) {
    return {
      status: DR_MISSING_PREREQUISITE_DENIAL_CODES.has(error.code) ? 404 : 400,
      code: error.code,
    };
  }
  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DrAuthorizationRefDependencies = {
  resolveProviderSnapshotId(orgId: string, snapshotId: string): Promise<string>;
  /**
   * W05b: a device's newest bare-metal-restorable snapshot, or null when it
   * has none. Optional so pre-W05b callers/tests keep their shape; the DB
   * resolver is the fallback.
   */
  resolveLatestRestorableSnapshotId?(orgId: string, deviceId: string): Promise<string | null>;
};

function defaultAuthorizationRefDependencies(tx?: DrDb): DrAuthorizationRefDependencies {
  return {
    resolveProviderSnapshotId: (ownerOrgId, snapshotId) => resolveProviderSnapshotIdWithDb(ownerOrgId, snapshotId, tx),
    resolveLatestRestorableSnapshotId: (ownerOrgId, deviceId) =>
      resolveLatestRestorableSnapshotIdWithDb(ownerOrgId, deviceId, tx),
  };
}

async function resolveProviderSnapshotIdWithDb(
  orgId: string,
  snapshotId: string,
  tx: DrDb = db,
): Promise<string> {
  const rows = await tx
    .select({ id: backupSnapshots.id, snapshotId: backupSnapshots.snapshotId })
    .from(backupSnapshots)
    .where(and(
      eq(backupSnapshots.orgId, orgId),
      UUID_PATTERN.test(snapshotId)
        ? or(eq(backupSnapshots.id, snapshotId), eq(backupSnapshots.snapshotId, snapshotId))
        : eq(backupSnapshots.snapshotId, snapshotId),
    ));

  const internal = rows.filter((row) => row.id === snapshotId);
  if (internal.length === 1) return internal[0]!.id;
  const external = rows.filter((row) => row.snapshotId === snapshotId);
  if (external.length !== 1) {
    throw new DrRecoveryAuthorizationDeniedError(
      external.length > 1 ? 'ambiguous_snapshot_reference' : 'resource_not_found',
    );
  }
  return external[0]!.id;
}

const EXPLICIT_SOURCE_FIELDS: ReadonlyArray<{
  field: string;
  kind: ResilienceResourceRef['kind'];
}> = [
  { field: 'sourceSnapshotId', kind: 'snapshot' },
  { field: 'restoreJobId', kind: 'restore_job' },
  { field: 'recoveryTokenId', kind: 'recovery_token' },
  { field: 'mediaArtifactId', kind: 'media_artifact' },
  { field: 'bootMediaArtifactId', kind: 'boot_media_artifact' },
];

/** Parse only identity fields; payload metadata and provider secrets stay unread. */
export async function resolveDrGroupAuthorizationRefs(
  group: Pick<DrPlanGroupRecord, 'devices' | 'restoreConfig'>,
  orgId: string,
  deps: DrAuthorizationRefDependencies = defaultAuthorizationRefDependencies(),
): Promise<ResilienceResourceRef[]> {
  const rawDeviceIds = Array.isArray(group.devices) ? group.devices : [];
  if (
    rawDeviceIds.length === 0
    || rawDeviceIds.some((value) => typeof value !== 'string' || !UUID_PATTERN.test(value))
  ) {
    throw new DrRecoveryAuthorizationDeniedError('group_has_no_valid_devices');
  }
  const deviceIds = [...new Set(rawDeviceIds as string[])];

  const restoreConfig = asRecord(group.restoreConfig);
  const payload = asRecord(restoreConfig.payload);
  const refs: ResilienceResourceRef[] = deviceIds.map((id) => ({ kind: 'device', id, role: 'target' }));
  const sourceKeys = new Set<string>();
  const addSource = (kind: ResilienceResourceRef['kind'], id: string) => {
    const key = `${kind}:${id}`;
    if (!sourceKeys.has(key)) {
      sourceKeys.add(key);
      refs.push({ kind, id, role: 'source' });
    }
  };

  // W05b BARE_METAL_REBUILD: the sources are each device's latest restorable
  // snapshot (a group holds N devices, so one pinned snapshot id cannot
  // describe N sources), and the rebuild host is an authorized target too —
  // a rehearsal writes N disk images onto it.
  if (isBareMetalRebuildConfig(restoreConfig)) {
    const parsed = drBareMetalRebuildConfigSchema.safeParse(restoreConfig);
    if (!parsed.success) {
      throw new DrRecoveryAuthorizationDeniedError('invalid_step_config');
    }
    const host = parsed.data.rebuildHostDeviceId;
    if (host && !deviceIds.includes(host)) {
      refs.push({ kind: 'device', id: host, role: 'target' });
    }
    const resolveLatest = deps.resolveLatestRestorableSnapshotId
      ?? ((ownerOrgId: string, deviceId: string) => resolveLatestRestorableSnapshotIdWithDb(ownerOrgId, deviceId));
    for (const deviceId of deviceIds) {
      const snapshotId = await resolveLatest(orgId, deviceId);
      if (!snapshotId) {
        throw new DrRecoveryAuthorizationDeniedError('no_restorable_snapshot');
      }
      addSource('snapshot', snapshotId);
    }
  }

  for (const { field, kind } of EXPLICIT_SOURCE_FIELDS) {
    for (const container of [restoreConfig, payload]) {
      const value = container[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new DrRecoveryAuthorizationDeniedError('invalid_recovery_source_reference');
      }
      addSource(kind, value);
    }
  }

  if (payload.snapshotId !== undefined) {
    if (typeof payload.snapshotId !== 'string' || !payload.snapshotId.trim()) {
      throw new DrRecoveryAuthorizationDeniedError('invalid_recovery_source_reference');
    }
    addSource('snapshot', await deps.resolveProviderSnapshotId(orgId, payload.snapshotId));
  }

  if (sourceKeys.size === 0) {
    throw new DrRecoveryAuthorizationDeniedError('no_recovery_source');
  }
  return refs;
}

async function resolveAllExecutionRefs(
  groups: readonly DrPlanGroupRecord[],
  orgId: string,
  tx: DrDb,
): Promise<ResilienceResourceRef[]> {
  const refs: ResilienceResourceRef[] = [];
  const deps = defaultAuthorizationRefDependencies(tx);
  for (const group of groups) {
    refs.push(...await resolveDrGroupAuthorizationRefs(group, orgId, deps));
  }
  return refs;
}

export async function createDrExecutionAndEnqueue(input: {
  planId: string;
  orgId: string;
  executionType: 'rehearsal' | 'failover' | 'failback';
  initiatedBy?: string | null;
  auth: AuthContext;
}): Promise<DrExecutionRecord | null> {
  const subject = await captureRecoveryAuthorizationSubject(
    input.auth,
    input.orgId,
    DR_RECOVERY_AUTHORIZATION_INTENT,
  );
  const now = new Date();
  const execution = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const tx = db;
    const groups = await loadDrPlanGroups(input.planId, input.orgId, tx);
    const refs = await resolveAllExecutionRefs(groups, input.orgId, tx);
    await authorizeQueuedRecoveryWork(subject, input.orgId, refs, DR_RECOVERY_AUTHORIZATION_INTENT);
    const [created] = await tx
      .insert(drExecutions)
      .values({
        planId: input.planId,
        orgId: input.orgId,
        executionType: input.executionType,
        status: 'pending',
        startedAt: now,
        initiatedBy: input.initiatedBy ?? null,
        results: buildInitialResults(groups, now),
        createdAt: now,
        ...subject,
      })
      .returning();
    return created ?? null;
  }));

  if (!execution) return null;
  const { enqueueDrExecutionReconcile } = await import('../jobs/drExecutionWorker');
  await runOutsideDbContext(() => enqueueDrExecutionReconcile(execution.id));
  return execution;
}

/**
 * W05b BARE_METAL_REBUILD dispatch. Never a device command for
 * failover/failback: one `bare_metal_recoveries` row per group device
 * (identity `original`), and the operator boots media and types the code.
 * A rehearsal creates the rows with identity `new` on the rebuild host, mints
 * a token per recovery and queues one `bare_metal_rebuild` per device to the
 * HOST, producing `${outputDir}/${deviceId}-${recoveryId}.vhdx`.
 *
 * Dedupe key is `(groupId, deviceId)` in `queuedRecoveries`, so reconcile can
 * never mint a second recovery. Per-device service refusals
 * (`recovery_in_progress`, no restorable snapshot) become `failedDispatches`
 * entries; anything else propagates.
 */
async function dispatchBareMetalRebuildGroup(
  execution: DrExecutionRecord,
  group: DrPlanGroupRecord,
  deviceIds: string[],
  nextResults: DrExecutionResults,
): Promise<DrExecutionResults> {
  const commandType = DR_STEP_BARE_METAL_REBUILD;
  const failGroup = (error: string): DrExecutionResults => {
    nextResults.failedDispatches.push({ groupId: group.id, groupName: group.name, commandType, error });
    nextResults.dispatchStatus = 'failed';
    nextResults.haltReason = `Group ${group.name} did not dispatch cleanly`;
    return nextResults;
  };

  const parsedConfig = drBareMetalRebuildConfigSchema.safeParse(asRecord(group.restoreConfig));
  if (!parsedConfig.success) return failGroup('invalid_step_config');
  const config: DrBareMetalRebuildConfig = parsedConfig.data;

  const rehearsal = execution.executionType === 'rehearsal';
  // Rehearsal invariant (§9): an engine-produced image never resumes the
  // production identity. Not taken from the config — the schema has no field.
  const identity: 'original' | 'new' = rehearsal ? 'new' : 'original';
  const host = rehearsal ? config.rebuildHostDeviceId ?? null : null;
  if (rehearsal && !host) return failGroup('rebuild_host_required');

  // DR dispatch has no request to derive the origin from; the helper on the
  // host needs a reachable server URL in the payload, so refuse before
  // creating rows rather than queue a command that can only fail.
  let serverUrl: string | null = null;
  if (rehearsal) {
    if (!process.env.BREEZE_SERVER && !process.env.PUBLIC_API_URL) return failGroup('server_url_unset');
    serverUrl = resolveServerUrl();
  }

  const alreadyQueued = new Set(
    nextResults.queuedRecoveries
      .filter((entry) => entry.groupId === group.id)
      .map((entry) => entry.deviceId),
  );
  const userId = execution.initiatedBy ?? null;
  const createdRecoveryIds: string[] = [];

  for (const deviceId of deviceIds) {
    if (alreadyQueued.has(deviceId)) continue;

    const failDevice = (error: string) => {
      nextResults.failedDispatches.push({ groupId: group.id, groupName: group.name, deviceId, commandType, error });
    };

    // Re-resolved at dispatch (not taken from the authorization pass) so a
    // snapshot published between trigger and dispatch is the one restored.
    const snapshotId = await resolveLatestRestorableSnapshotIdWithDb(execution.orgId, deviceId);
    if (!snapshotId) {
      failDevice('no_restorable_snapshot');
      continue;
    }

    let recoveryId: string;
    let createdAt: Date;
    try {
      const created = await createBareMetalRecovery({
        orgId: execution.orgId,
        snapshotId,
        identity,
        createdBy: userId,
        source: 'dr',
        executingDeviceId: host,
        drExecutionId: execution.id,
        drGroupId: group.id,
      });
      recoveryId = created.row.id;
      createdAt = created.row.createdAt;
    } catch (error) {
      if (error instanceof BareMetalRecoveryError) {
        failDevice(error.code);
        continue;
      }
      throw error;
    }

    let commandId: string | null = null;
    if (rehearsal && host && serverUrl) {
      const target = { kind: 'vhdx' as const, path: `${config.outputDir.replace(/\/+$/, '')}/${deviceId}-${recoveryId}.vhdx` };
      let token: string;
      try {
        token = (await mintRecoveryTokenForRecovery({ recoveryId, orgId: execution.orgId, createdBy: userId })).token;
      } catch (error) {
        if (!(error instanceof BareMetalRecoveryError)) throw error;
        await cancelBareMetalRecovery({ recoveryId, orgId: execution.orgId, userId, reason: error.code }).catch(() => {});
        failDevice(error.code);
        continue;
      }
      const { command, error } = await queueBareMetalRebuild({
        orgId: execution.orgId,
        hostDeviceId: host,
        ...(userId ? { userId } : {}),
        payload: { recoveryId, token, server: serverUrl, target, identity },
      });
      if (error || !command) {
        const message = error ?? 'Failed to queue bare-metal rebuild';
        // Free the "one non-terminal recovery per device" slot so a retry can proceed.
        await cancelBareMetalRecovery({ recoveryId, orgId: execution.orgId, userId, reason: message }).catch(() => {});
        failDevice(message);
        continue;
      }
      commandId = command.id;
    }

    nextResults.queuedRecoveries.push({
      groupId: group.id,
      groupName: group.name,
      deviceId,
      recoveryId,
      executingDeviceId: host,
      commandId,
      createdAt: createdAt.toISOString(),
    });
    createdRecoveryIds.push(recoveryId);
    alreadyQueued.add(deviceId);
  }

  const groupFailures = nextResults.failedDispatches.filter((entry) => entry.groupId === group.id);
  void createAuditLogAsync({
    orgId: execution.orgId,
    actorType: userId ? 'user' : 'system',
    actorId: userId ?? '00000000-0000-0000-0000-000000000000',
    action: 'dr.step.bare_metal_rebuild.dispatch',
    resourceType: 'dr_execution',
    resourceId: execution.id,
    result: groupFailures.length > 0 ? 'failure' : 'success',
    details: {
      planId: execution.planId,
      groupId: group.id,
      groupName: group.name,
      executionType: execution.executionType,
      identity,
      rebuildHostDeviceId: host,
      recoveryIds: createdRecoveryIds,
      failedDeviceIds: groupFailures.map((entry) => entry.deviceId).filter((id): id is string => !!id),
    },
  }).catch(() => {
    // Already retried + Sentry-captured inside createAuditLogAsync.
  });

  if (groupFailures.length > 0) {
    nextResults.dispatchStatus = nextResults.queuedRecoveries.some((entry) => entry.groupId === group.id)
      ? 'partial'
      : 'failed';
    nextResults.haltReason = `Group ${group.name} did not dispatch cleanly`;
  }

  return nextResults;
}

/** @internal Exported for tests; reconcile is the only production caller. */
export async function dispatchGroup(
  execution: DrExecutionRecord,
  group: DrPlanGroupRecord,
  currentResults: DrExecutionResults,
): Promise<DrExecutionResults> {
  const restoreConfig = asRecord(group.restoreConfig);
  const commandType = typeof restoreConfig.commandType === 'string' ? restoreConfig.commandType : null;
  const payload = restoreConfig.payload && typeof restoreConfig.payload === 'object' && !Array.isArray(restoreConfig.payload)
    ? restoreConfig.payload as Record<string, unknown>
    : {};
  const deviceIds = Array.isArray(group.devices)
    ? group.devices.filter((value): value is string => typeof value === 'string')
    : [];

  const nextResults: DrExecutionResults = {
    ...currentResults,
    queuedCommands: [...currentResults.queuedCommands],
    queuedRecoveries: [...(currentResults.queuedRecoveries ?? [])],
    failedDispatches: [...currentResults.failedDispatches],
    activeGroupId: group.id,
    dispatchStatus: 'running',
    haltReason: currentResults.haltReason ?? null,
  };

  if (!commandType) {
    nextResults.failedDispatches.push({
      groupId: group.id,
      groupName: group.name,
      error: 'restoreConfig.commandType is required to dispatch this DR group',
    });
    nextResults.dispatchStatus = 'failed';
    nextResults.haltReason = `Group ${group.name} is missing a command type`;
    return nextResults;
  }

  if (!DR_ALLOWED_COMMAND_TYPES.has(commandType)) {
    nextResults.failedDispatches.push({
      groupId: group.id,
      groupName: group.name,
      commandType,
      error: `Unsupported DR command type: ${commandType}`,
    });
    nextResults.dispatchStatus = 'failed';
    nextResults.haltReason = `Group ${group.name} uses an unsupported command type`;
    return nextResults;
  }

  if (deviceIds.length === 0) {
    nextResults.failedDispatches.push({
      groupId: group.id,
      groupName: group.name,
      commandType,
      error: 'No devices are assigned to this DR group',
    });
    nextResults.dispatchStatus = 'failed';
    nextResults.haltReason = `Group ${group.name} has no assigned devices`;
    return nextResults;
  }

  if (commandType === DR_STEP_BARE_METAL_REBUILD) {
    return dispatchBareMetalRebuildGroup(execution, group, deviceIds, nextResults);
  }

  // Skip devices that already have a command queued for this group
  const alreadyQueued = new Set(
    currentResults.queuedCommands
      .filter((entry) => entry.groupId === group.id)
      .map((entry) => entry.deviceId),
  );

  for (const deviceId of deviceIds) {
    if (alreadyQueued.has(deviceId)) {
      continue;
    }

    const { command, error } = await queueCommandForExecution(
      deviceId,
      commandType,
      {
        drExecutionId: execution.id,
        drPlanId: execution.planId,
        drGroupId: group.id,
        executionType: execution.executionType,
        groupName: group.name,
        ...payload,
      },
      { userId: execution.initiatedBy ?? undefined, expectedOrgId: execution.orgId }
    );

    if (error || !command) {
      nextResults.failedDispatches.push({
        groupId: group.id,
        groupName: group.name,
        deviceId,
        commandType,
        error: error ?? 'Failed to queue DR command',
      });
      continue;
    }

    nextResults.queuedCommands.push({
      groupId: group.id,
      groupName: group.name,
      deviceId,
      commandId: command.id,
      commandType,
      status: command.status,
    });
    alreadyQueued.add(deviceId);
  }

  if (nextResults.failedDispatches.some((entry) => entry.groupId === group.id)) {
    nextResults.dispatchStatus = nextResults.queuedCommands.some((entry) => entry.groupId === group.id)
      ? 'partial'
      : 'failed';
    nextResults.haltReason = `Group ${group.name} did not dispatch cleanly`;
  }

  return nextResults;
}

function pickNextGroup(groups: DrPlanGroupRecord[], groupResults: GroupResult[]): DrPlanGroupRecord | null {
  const resultsByGroupId = new Map(groupResults.map((group) => [group.groupId, group]));

  for (const group of groups) {
    const result = resultsByGroupId.get(group.id);
    if (!result || result.status !== 'pending') continue;

    const dependency = group.dependsOnGroupId ? resultsByGroupId.get(group.dependsOnGroupId) : null;
    if (dependency && dependency.status !== 'completed') continue;

    const earlierGroups = groups.filter((candidate) => candidate.sequence < group.sequence);
    if (earlierGroups.some((candidate) => resultsByGroupId.get(candidate.id)?.status !== 'completed')) {
      continue;
    }

    return group;
  }

  return null;
}

function isKnownAuthorizationDenial(error: unknown): error is Error & { retriable: false; code?: string } {
  return error instanceof Error
    && 'retriable' in error
    && (error as { retriable?: unknown }).retriable === false;
}

export async function persistDrAuthorizationDenial(
  execution: DrExecutionRecord,
  code: string,
  checkedAt: Date,
): Promise<DrExecutionRecord> {
  const currentResults = asRecord(execution.results);
  const legacyUnknown = execution.authorizationPrincipalKind === 'unknown'
    || execution.authorizationState === 'quarantined_authorization_unknown';
  // Compare-and-swap: only a still-non-terminal row may be moved. Mirrors the
  // write-back guard in reconcileDrExecution (#6322/#6451) — without it, an
  // operator abort landing between the denial check and this write gets
  // silently overwritten back to 'failed' (#6457).
  const [updated] = await db
    .update(drExecutions)
    .set({
      ...(legacyUnknown ? {} : {
        status: 'failed',
        completedAt: checkedAt,
        results: {
          ...currentResults,
          dispatchStatus: 'failed',
          haltReason: `DR authorization denied: ${code}`,
        },
      }),
      authorizationState: legacyUnknown ? 'quarantined_authorization_unknown' : 'denied',
      authorizationDenialCode: legacyUnknown ? 'authorization_subject_unknown' : code,
      authorizationCheckedAt: checkedAt,
    })
    .where(and(
      eq(drExecutions.id, execution.id),
      notInArray(drExecutions.status, [...DR_EXECUTION_TERMINAL]),
    ))
    .returning();

  if (updated) return updated;

  // Another writer terminalised the row between our read and this write. Its
  // state wins — report what is actually in the database rather than the
  // stale row this call started from, and never resurrect it to 'failed'.
  const [current] = await db
    .select()
    .from(drExecutions)
    .where(eq(drExecutions.id, execution.id))
    .limit(1);
  if (current) {
    console.warn(
      `[drExecutionService] persistDrAuthorizationDenial ${execution.id} lost the write-back race; `
      + `another writer left it ${current.status}`,
    );
    return current;
  }
  // Not an expected outcome — dr_executions rows are not deleted under a live
  // reconcile. Loud, because it means the row vanished mid-tick.
  console.error(`[drExecutionService] persistDrAuthorizationDenial ${execution.id}: execution row disappeared mid-tick`);
  return execution;
}

async function authorizeDrGroup(execution: DrExecutionRecord, group: DrPlanGroupRecord): Promise<Date> {
  const refs = await resolveDrGroupAuthorizationRefs(group, execution.orgId);
  await authorizeQueuedRecoveryWork(
    execution as RecoveryAuthorizationSubjectRow,
    execution.orgId,
    refs,
    DR_RECOVERY_AUTHORIZATION_INTENT,
  );
  return new Date();
}

/**
 * Terminal execution statuses: once a row reaches one of these no reconcile
 * tick may move it again.
 */
const DR_EXECUTION_TERMINAL = ['completed', 'failed', 'aborted'] as const;

/**
 * Reconcile one DR execution.
 *
 * **Serialisation contract (#6322).** BullMQ's stable `jobId`
 * (`dr-execution-<id>`) keeps a second *queued* tick for the same execution
 * from being added, which covers the common case — but it is not mutual
 * exclusion: the id is reusable once the job completes, and the worker runs
 * with `concurrency: 4` (see jobs/drExecutionWorker.ts). The real guard is the
 * compare-and-swap write-back at the end of this function.
 *
 * This function used to open with a bare
 * `SELECT id FROM dr_executions ... FOR UPDATE` outside `db.transaction(...)`,
 * which auto-committed and released the lock on the spot — it read as mutual
 * exclusion while providing none. It is not re-added inside a transaction
 * because the body performs external side effects (authorization checks,
 * command dispatch, recovery creation) that must not run with a row lock held
 * open. The compare-and-swap refuses to resurrect an execution another writer
 * has already made terminal, so a second tick that slips through is a no-op
 * rather than a state regression.
 */
export async function reconcileDrExecution(executionId: string): Promise<DrReconcileOutcome> {
  const [execution] = await db
    .select()
    .from(drExecutions)
    .where(eq(drExecutions.id, executionId))
    .limit(1);

  if (!execution || (DR_EXECUTION_TERMINAL as readonly string[]).includes(execution.status)) {
    return { execution: execution ?? null, nextDelayMs: null };
  }

  if (
    execution.authorizationPrincipalKind === 'unknown'
    || execution.authorizationState === 'quarantined_authorization_unknown'
  ) {
    return {
      execution: await persistDrAuthorizationDenial(
        execution,
        'authorization_subject_unknown',
        new Date(),
      ),
      nextDelayMs: null,
    };
  }

  const groups = await loadDrPlanGroups(execution.planId, execution.orgId);
  const currentResultsRecord = asRecord(execution.results);
  let results: DrExecutionResults = {
    ...buildInitialResults(groups, execution.startedAt ?? execution.createdAt),
    ...currentResultsRecord,
    plannedGroups: normalizePlannedGroups(groups),
    queuedCommands: normalizeQueuedCommands(currentResultsRecord.queuedCommands),
    queuedRecoveries: normalizeQueuedRecoveries(currentResultsRecord.queuedRecoveries),
    failedDispatches: normalizeFailedDispatches(currentResultsRecord.failedDispatches),
  };

  const commandIds = results.queuedCommands.map((entry) => entry.commandId);
  const commands = commandIds.length > 0
    ? await db
        .select()
        .from(deviceCommands)
        .where(inArray(deviceCommands.id, commandIds))
    : [];
  const commandMap = new Map(commands.map((command) => [command.id, command]));

  // W05b: recovery rows are the source of truth for BARE_METAL_REBUILD devices.
  const recoveries = results.queuedRecoveries.length > 0
    ? await db
        .select()
        .from(bareMetalRecoveries)
        .where(eq(bareMetalRecoveries.drExecutionId, execution.id))
    : [];
  const recoveryMap = new Map(recoveries.map((row) => [row.id, row]));

  const now = new Date();
  results.groupResults = computeGroupResults(
    groups, results.queuedCommands, results.queuedRecoveries, results.failedDispatches, commandMap, recoveryMap, now,
  );

  // A device that ran out of its wait budget is failed in the results; make
  // the row terminal too so the per-device in-flight slot is released and the
  // helper/media cannot advance a recovery the plan has already given up on.
  for (const group of results.groupResults) {
    for (const device of group.devices) {
      if (device.reason !== 'timeout' || !device.recoveryId) continue;
      const row = recoveryMap.get(device.recoveryId);
      if (row && BARE_METAL_RECOVERY_TERMINAL.has(row.status)) continue;
      await cancelBareMetalRecovery({ recoveryId: device.recoveryId, orgId: execution.orgId, userId: null, reason: 'timeout' })
        .catch(() => {
          // Lost the race with a terminal progress post — the next tick reads the terminal row.
        });
    }
  }

  const hasRunningGroup = results.groupResults.some((group) => group.status === 'running');
  const failedGroup = results.groupResults.find((group) => group.status === 'failed');
  const allCompleted = results.groupResults.length > 0 && results.groupResults.every((group) => group.status === 'completed');

  const activeResult = results.groupResults.find((group) => group.status === 'running');
  const activeGroup = activeResult ? groups.find((group) => group.id === activeResult.groupId) : null;
  let authorizationCheckedAt: Date | null = null;
  try {
    if (activeGroup) authorizationCheckedAt = await authorizeDrGroup(execution, activeGroup);
  } catch (error) {
    if (!isKnownAuthorizationDenial(error)) throw error;
    return {
      execution: await persistDrAuthorizationDenial(
        execution,
        error.code ?? error.message,
        new Date(),
      ),
      nextDelayMs: null,
    };
  }

  let nextStatus: DrExecutionRecord['status'] = hasRunningGroup ? 'running' : 'pending';
  let completedAt: Date | null = null;

  if (groups.length === 0) {
    nextStatus = 'failed';
    completedAt = new Date();
    results.dispatchStatus = 'failed';
    results.haltReason = 'DR plan has no recovery groups';
    results.activeGroupId = null;
  } else if (failedGroup && !hasRunningGroup) {
    nextStatus = 'failed';
    completedAt = new Date();
    results.dispatchStatus = results.failedDispatches.length > 0 ? 'partial' : 'failed';
    results.haltReason = results.haltReason ?? `Group ${failedGroup.name} failed`;
    results.activeGroupId = failedGroup.groupId;
  } else if (allCompleted) {
    nextStatus = 'completed';
    completedAt = new Date();
    results.dispatchStatus = 'completed';
    results.activeGroupId = null;
    results.haltReason = null;
  } else if (!hasRunningGroup) {
    const nextGroup = pickNextGroup(groups, results.groupResults);
    if (nextGroup) {
      try {
        authorizationCheckedAt = await authorizeDrGroup(execution, nextGroup);
      } catch (error) {
        if (!isKnownAuthorizationDenial(error)) throw error;
        return {
          execution: await persistDrAuthorizationDenial(
            execution,
            error.code ?? error.message,
            new Date(),
          ),
          nextDelayMs: null,
        };
      }
      results = await dispatchGroup(execution, nextGroup, results);
      nextStatus = results.dispatchStatus === 'failed' ? 'failed' : 'running';
      results.groupResults = computeGroupResults(
        groups, results.queuedCommands, results.queuedRecoveries, results.failedDispatches, commandMap, recoveryMap, now,
      );
      if (results.dispatchStatus === 'failed') {
        completedAt = new Date();
      }
    } else {
      nextStatus = 'failed';
      completedAt = new Date();
      results.dispatchStatus = 'failed';
      results.haltReason = results.haltReason ?? 'No eligible DR group could be dispatched';
      results.activeGroupId = null;
    }
  } else {
    results.dispatchStatus = results.failedDispatches.length > 0 ? 'partial' : 'running';
    results.activeGroupId = results.groupResults.find((group) => group.status === 'running')?.groupId ?? null;
  }

  // Compare-and-swap: only a still-non-terminal row may be moved. See the
  // serialisation contract on this function (#6322).
  const [updated] = await db
    .update(drExecutions)
    .set({
      status: nextStatus,
      completedAt,
      results,
      ...(authorizationCheckedAt ? {
        authorizationState: 'authorized' as const,
        authorizationDenialCode: null,
        authorizationCheckedAt,
      } : {}),
    })
    .where(and(
      eq(drExecutions.id, execution.id),
      notInArray(drExecutions.status, [...DR_EXECUTION_TERMINAL]),
    ))
    .returning();

  if (!updated) {
    // Another writer terminalised (or deleted) the row between our read and
    // this write. Its state wins — report what is actually in the database
    // rather than the stale row this tick started from, and stop ticking.
    const [current] = await db
      .select()
      .from(drExecutions)
      .where(eq(drExecutions.id, executionId))
      .limit(1);
    if (current) {
      // Expected under a duplicate tick, but never silent: a rising rate here
      // means ticks are overlapping more than the queue is supposed to allow.
      console.warn(
        `[drExecutionService] reconcile ${executionId} lost the write-back race; `
        + `another writer left it ${current.status}`,
      );
    } else {
      // Not an expected outcome — dr_executions rows are not deleted under a
      // live reconcile. Loud, because it means the row vanished mid-tick.
      console.error(`[drExecutionService] reconcile ${executionId}: execution row disappeared mid-tick`);
    }
    return { execution: current ?? null, nextDelayMs: null };
  }

  const finalExecution = updated;
  return {
    execution: finalExecution,
    nextDelayMs: ['pending', 'running'].includes(finalExecution.status)
      ? (hasRunningGroup ? 10_000 : 2_000)
      : null,
  };
}
