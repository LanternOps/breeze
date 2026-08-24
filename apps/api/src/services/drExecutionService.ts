import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupSnapshots, deviceCommands, drExecutions, drPlanGroups } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { CommandTypes, queueCommandForExecution } from './commandQueue';
import {
  authorizeQueuedRecoveryWork,
  captureRecoveryAuthorizationSubject,
  type RecoveryAuthorizationIntent,
  type RecoveryAuthorizationSubjectRow,
} from './recoveryAuthorizationSubject';
import type { ResilienceResourceRef } from './resilienceSiteAuthorization';

const DR_ALLOWED_COMMAND_TYPES = new Set<string>([
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.BMR_RECOVER,
]);

export type DrPlanGroupRecord = typeof drPlanGroups.$inferSelect;
type DrExecutionRecord = typeof drExecutions.$inferSelect;
type DeviceCommandRecord = typeof deviceCommands.$inferSelect;
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

type FailedDispatch = {
  groupId: string;
  groupName: string;
  deviceId?: string;
  commandType?: string;
  error: string;
};

type GroupDeviceStatus = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  commandId?: string;
  commandType?: string;
  error?: string;
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

function computeGroupResults(
  groups: DrPlanGroupRecord[],
  queuedCommands: QueuedDrCommand[],
  failedDispatches: FailedDispatch[],
  commandMap: Map<string, DeviceCommandRecord>,
): GroupResult[] {
  return groups.map((group) => {
    const devices = Array.isArray(group.devices) ? group.devices : [];
    const queuedForGroup = queuedCommands.filter((entry) => entry.groupId === group.id);
    const dispatchFailures = failedDispatches.filter((entry) => entry.groupId === group.id);

    const deviceStatuses: GroupDeviceStatus[] = devices.map((deviceId) => {
      const queued = queuedForGroup.find((entry) => entry.deviceId === deviceId);
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
    const startedAt = commandRows
      .map((entry) => entry.executedAt ?? entry.createdAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const completedAt = commandRows.length > 0 && commandRows.every((entry) => entry.completedAt instanceof Date)
      ? commandRows
          .map((entry) => entry.completedAt as Date)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
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

class DrRecoveryAuthorizationDeniedError extends Error {
  readonly retriable = false;

  constructor(readonly code: string) {
    super(code);
    this.name = 'DrRecoveryAuthorizationDeniedError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DrAuthorizationRefDependencies = {
  resolveProviderSnapshotId(orgId: string, snapshotId: string): Promise<string>;
};

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
  deps: DrAuthorizationRefDependencies = {
    resolveProviderSnapshotId: (ownerOrgId, snapshotId) => resolveProviderSnapshotIdWithDb(ownerOrgId, snapshotId),
  },
): Promise<ResilienceResourceRef[]> {
  const rawDeviceIds = Array.isArray(group.devices) ? group.devices : [];
  if (
    rawDeviceIds.length === 0
    || rawDeviceIds.some((value) => typeof value !== 'string' || !UUID_PATTERN.test(value))
  ) {
    throw new DrRecoveryAuthorizationDeniedError('resource_not_found');
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

  for (const { field, kind } of EXPLICIT_SOURCE_FIELDS) {
    for (const container of [restoreConfig, payload]) {
      const value = container[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new DrRecoveryAuthorizationDeniedError('resource_not_found');
      }
      addSource(kind, value);
    }
  }

  if (payload.snapshotId !== undefined) {
    if (typeof payload.snapshotId !== 'string' || !payload.snapshotId.trim()) {
      throw new DrRecoveryAuthorizationDeniedError('resource_not_found');
    }
    addSource('snapshot', await deps.resolveProviderSnapshotId(orgId, payload.snapshotId));
  }

  if (sourceKeys.size === 0) {
    throw new DrRecoveryAuthorizationDeniedError('resource_not_found');
  }
  return refs;
}

async function resolveAllExecutionRefs(
  groups: readonly DrPlanGroupRecord[],
  orgId: string,
  tx: DrDb,
): Promise<ResilienceResourceRef[]> {
  const refs: ResilienceResourceRef[] = [];
  for (const group of groups) {
    refs.push(...await resolveDrGroupAuthorizationRefs(group, orgId, {
      resolveProviderSnapshotId: (ownerOrgId, snapshotId) =>
        resolveProviderSnapshotIdWithDb(ownerOrgId, snapshotId, tx),
    }));
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

async function dispatchGroup(
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

async function persistDrAuthorizationDenial(
  execution: DrExecutionRecord,
  code: string,
  checkedAt: Date,
): Promise<DrExecutionRecord> {
  const currentResults = asRecord(execution.results);
  const legacyUnknown = execution.authorizationPrincipalKind === 'unknown'
    || execution.authorizationState === 'quarantined_authorization_unknown';
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
    .where(eq(drExecutions.id, execution.id))
    .returning();
  return updated ?? execution;
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

export async function reconcileDrExecution(executionId: string): Promise<DrReconcileOutcome> {
  await db.execute(sql`SELECT id FROM dr_executions WHERE id = ${executionId} FOR UPDATE`);
  const [execution] = await db
    .select()
    .from(drExecutions)
    .where(eq(drExecutions.id, executionId))
    .limit(1);

  if (!execution || ['completed', 'failed', 'aborted'].includes(execution.status)) {
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

  results.groupResults = computeGroupResults(groups, results.queuedCommands, results.failedDispatches, commandMap);

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
      results.groupResults = computeGroupResults(groups, results.queuedCommands, results.failedDispatches, new Map(commands.map((command) => [command.id, command])));
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
    .where(eq(drExecutions.id, execution.id))
    .returning();

  const finalExecution = updated ?? execution;
  return {
    execution: finalExecution,
    nextDelayMs: ['pending', 'running'].includes(finalExecution.status)
      ? (hasRunningGroup ? 10_000 : 2_000)
      : null,
  };
}
