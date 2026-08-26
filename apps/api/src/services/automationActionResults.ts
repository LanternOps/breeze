import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import {
  automationActionResults,
  automationRunDeviceResults,
  automationRuns,
} from '../db/schema';
import { publishEvent } from './eventBus';

export type AutomationActionResultStatus =
  | 'pending' | 'queued' | 'delivered' | 'running'
  | 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';

export type AutomationActionTerminalSource =
  | 'command' | 'script_execution' | 'deployment_result'
  | 'timeout' | 'cancellation' | 'reaper' | 'dispatch';

type Correlations = {
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
};

type ActionState = {
  status: AutomationActionResultStatus;
  terminalSource: AutomationActionTerminalSource | null;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
};

type ActionPatch = Partial<{
  status: AutomationActionResultStatus;
  terminalSource: AutomationActionTerminalSource | null;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
  message: string | null;
  output: string | null;
  error: string | null;
  completedAt: Date | null;
}>;

const NONTERMINAL_RANK: Partial<Record<AutomationActionResultStatus, number>> = {
  pending: 0,
  queued: 1,
  delivered: 2,
  running: 3,
};
const TERMINAL = new Set<AutomationActionResultStatus>([
  'succeeded', 'failed', 'skipped', 'timed_out', 'cancelled',
]);
const REAL_TERMINAL_SOURCES = new Set<AutomationActionTerminalSource>([
  'command', 'script_execution', 'deployment_result',
]);

function correlationsPatch(state: ActionState, input: Correlations): ActionPatch | null {
  const patch: ActionPatch = {};
  for (const key of ['commandId', 'scriptExecutionId', 'deploymentResultId'] as const) {
    const proposed = input[key];
    if (proposed === undefined) continue;
    const current = state[key];
    if (current !== null && current !== proposed) return null;
    if (current === null) patch[key] = proposed;
  }
  return patch;
}

function decideDispatchTransition(
  state: ActionState,
  input: Correlations & {
    status: 'pending' | 'queued' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'skipped';
    message?: string;
  },
): ActionPatch | null {
  if (TERMINAL.has(state.status)) return null;
  const correlationPatch = correlationsPatch(state, input);
  if (!correlationPatch) return null;

  if (input.status === 'succeeded' || input.status === 'failed' || input.status === 'skipped') {
    return {
      ...correlationPatch,
      status: input.status,
      terminalSource: 'dispatch',
      message: input.message ?? null,
      completedAt: new Date(),
    };
  }

  const currentRank = NONTERMINAL_RANK[state.status];
  const proposedRank = NONTERMINAL_RANK[input.status];
  if (currentRank === undefined || proposedRank === undefined || proposedRank < currentRank) return null;
  const statusChanged = proposedRank > currentRank;
  const correlationChanged = Object.keys(correlationPatch).length > 0;
  if (!statusChanged && !correlationChanged) return null;
  return {
    ...correlationPatch,
    ...(statusChanged ? { status: input.status } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
}

function decideTerminalTransition(
  state: ActionState,
  input: {
    source: AutomationActionTerminalSource;
    terminalStatus: 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';
    output?: string | null;
    error?: string | null;
    completedAt: Date;
  },
): ActionPatch | null {
  if (TERMINAL.has(state.status)) {
    const replacesProvisionalReaper = state.status === 'timed_out'
      && state.terminalSource === 'reaper'
      && REAL_TERMINAL_SOURCES.has(input.source);
    if (!replacesProvisionalReaper) return null;
  }
  return {
    status: input.terminalStatus,
    terminalSource: input.source,
    output: input.output ?? null,
    error: input.error ?? null,
    completedAt: input.completedAt,
  };
}

function aggregateActionStatuses(statuses: AutomationActionResultStatus[]): {
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
} {
  if (statuses.some((status) => !TERMINAL.has(status))) {
    return { status: statuses.every((status) => status === 'pending') ? 'pending' : 'running' };
  }
  if (statuses.some((status) => status === 'failed' || status === 'timed_out' || status === 'cancelled')) {
    return { status: 'failed' };
  }
  if (statuses.every((status) => status === 'skipped')) return { status: 'skipped' };
  return { status: 'success' };
}

function aggregateDeviceStatuses(statuses: Array<'pending' | 'running' | 'success' | 'failed' | 'skipped'>): {
  status: 'running' | 'completed' | 'failed' | 'partial';
  devicesSucceeded: number;
  devicesFailed: number;
} {
  const devicesSucceeded = statuses.filter((status) => status === 'success').length;
  const devicesFailed = statuses.filter((status) => status === 'failed').length;
  if (statuses.some((status) => status === 'pending' || status === 'running')) {
    return { status: 'running', devicesSucceeded, devicesFailed };
  }
  if (devicesFailed === 0) return { status: 'completed', devicesSucceeded, devicesFailed };
  if (devicesSucceeded === 0) return { status: 'failed', devicesSucceeded, devicesFailed };
  return { status: 'partial', devicesSucceeded, devicesFailed };
}

function aggregateActionDetails(actions: Array<{
  actionIndex: number;
  status: AutomationActionResultStatus;
  message: string | null;
  output: string | null;
  error: string | null;
}>): { output: string | null; error: string | null } {
  const ordered = [...actions].sort((a, b) => a.actionIndex - b.actionIndex);
  const output = ordered
    .map((action) => action.output ?? action.message)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
  const MAX_OUTPUT_CHARS = 16_000;
  const trimmedOutput = output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : output;
  const failed = ordered.find((action) => (
    action.status === 'failed'
    || action.status === 'timed_out'
    || action.status === 'cancelled'
  ));
  return {
    output: trimmedOutput.length > 0 ? trimmedOutput : null,
    error: failed?.error ?? failed?.message ?? null,
  };
}

async function inDeliberateSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function stateCas(row: ActionState & { id: string }): SQL[] {
  return [
    eq(automationActionResults.id, row.id),
    eq(automationActionResults.status, row.status),
    row.terminalSource === null
      ? isNull(automationActionResults.terminalSource)
      : eq(automationActionResults.terminalSource, row.terminalSource),
    row.commandId === null
      ? isNull(automationActionResults.commandId)
      : eq(automationActionResults.commandId, row.commandId),
    row.scriptExecutionId === null
      ? isNull(automationActionResults.scriptExecutionId)
      : eq(automationActionResults.scriptExecutionId, row.scriptExecutionId),
    row.deploymentResultId === null
      ? isNull(automationActionResults.deploymentResultId)
      : eq(automationActionResults.deploymentResultId, row.deploymentResultId),
  ];
}

type Publication = {
  type: 'automation.completed' | 'automation.failed';
  orgId: string;
  payload: Record<string, unknown>;
};

type ProvisionalTimeoutRepair = {
  actionResultId: string;
};

async function publishAll(publications: Publication[]): Promise<void> {
  for (const publication of publications) {
    await runOutsideDbContext(() => publishEvent(
      publication.type,
      publication.orgId,
      publication.payload,
      'automation-action-results',
    ));
  }
}

async function reconcileInCurrentContext(
  runId: string,
  provisionalTimeoutRepair?: ProvisionalTimeoutRepair,
): Promise<Publication[]> {
  const [run] = await db.select({
    id: automationRuns.id,
    automationId: automationRuns.automationId,
    configPolicyId: automationRuns.configPolicyId,
    configItemName: automationRuns.configItemName,
    triggeredBy: automationRuns.triggeredBy,
    status: automationRuns.status,
  }).from(automationRuns).where(eq(automationRuns.id, runId)).limit(1).for('update');
  if (!run) return [];

  const actionRows = await db.select({
    id: automationActionResults.id,
    deviceId: automationActionResults.deviceId,
    orgId: automationActionResults.orgId,
    actionIndex: automationActionResults.actionIndex,
    status: automationActionResults.status,
    message: automationActionResults.message,
    output: automationActionResults.output,
    error: automationActionResults.error,
    completedAt: automationActionResults.completedAt,
  }).from(automationActionResults).where(eq(automationActionResults.runId, runId));
  if (actionRows.length === 0) return [];

  const byDevice = new Map<string, typeof actionRows>();
  for (const row of actionRows) {
    const group = byDevice.get(row.deviceId) ?? [];
    group.push(row);
    byDevice.set(row.deviceId, group);
  }
  for (const [deviceId, actions] of byDevice) {
    const aggregate = aggregateActionStatuses(actions.map((action) => action.status));
    const details = aggregateActionDetails(actions);
    const terminal = aggregate.status === 'success' || aggregate.status === 'failed' || aggregate.status === 'skipped';
    const completedAt = terminal
      ? new Date(Math.max(...actions.map((action) => action.completedAt?.getTime() ?? 0), Date.now()))
      : null;
    const updated = await db.update(automationRunDeviceResults).set({
      status: aggregate.status,
      startedAt: aggregate.status === 'pending'
        ? undefined
        : sql`COALESCE(${automationRunDeviceResults.startedAt}, now())`,
      completedAt,
      output: details.output,
      error: details.error,
      updatedAt: new Date(),
    }).where(and(
      eq(automationRunDeviceResults.runId, runId),
      eq(automationRunDeviceResults.deviceId, deviceId),
    )).returning({ id: automationRunDeviceResults.id });
    if (updated.length !== 1) {
      throw new Error(`Automation action result has no parent device result for run=${runId} device=${deviceId}`);
    }
  }

  const deviceRows = await db.select({
    deviceId: automationRunDeviceResults.deviceId,
    status: automationRunDeviceResults.status,
  })
    .from(automationRunDeviceResults)
    .where(eq(automationRunDeviceResults.runId, runId));
  const aggregate = aggregateDeviceStatuses(deviceRows.map((row) => row.status));
  const repairedAction = provisionalTimeoutRepair
    ? actionRows.find((row) => row.id === provisionalTimeoutRepair.actionResultId)
    : undefined;
  const priorDeviceAggregate = repairedAction
    ? aggregateActionStatuses((byDevice.get(repairedAction.deviceId) ?? []).map((action) => (
      action.id === repairedAction.id ? 'timed_out' : action.status
    )))
    : undefined;
  const priorAggregate = repairedAction && priorDeviceAggregate
    ? aggregateDeviceStatuses(deviceRows.map((row) => (
      row.deviceId === repairedAction.deviceId ? priorDeviceAggregate.status : row.status
    )))
    : undefined;
  const common = {
    devicesTargeted: deviceRows.length,
    devicesSucceeded: aggregate.devicesSucceeded,
    devicesFailed: aggregate.devicesFailed,
  };
  if (aggregate.status === 'running') {
    await db.update(automationRuns).set({ ...common, completedAt: null })
      .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'running')));
    return [];
  }

  const isRepairingPriorTerminal = priorAggregate?.status === run.status;
  if (run.status !== 'running' && !isRepairingPriorTerminal) return [];
  const statusChanged = run.status !== aggregate.status;

  const transitioned = await db.update(automationRuns).set({
    ...common,
    ...(statusChanged ? { status: aggregate.status, completedAt: new Date() } : {}),
  }).where(and(eq(automationRuns.id, runId), eq(automationRuns.status, run.status)))
    .returning({ id: automationRuns.id });
  if (transitioned.length === 0 || !statusChanged) return [];

  const orgIds = [...new Set(actionRows.map((row) => row.orgId))];
  return orgIds.map((orgId) => ({
    type: aggregate.status === 'completed' ? 'automation.completed' : 'automation.failed',
    orgId,
    payload: {
      ...(run.automationId ? { automationId: run.automationId } : {
        configPolicyAutomationId: run.configPolicyId,
        configItemName: run.configItemName,
      }),
      runId,
      triggeredBy: run.triggeredBy,
      status: aggregate.status,
      ...common,
    },
  }));
}

export async function seedAutomationActionResults(input: {
  runId: string;
  device: { id: string; orgId: string };
  actions: Array<{ actionIndex: number; actionType: string }>;
}): Promise<void> {
  const indexes = new Set(input.actions.map((action) => action.actionIndex));
  if (indexes.size !== input.actions.length) throw new Error('Automation action indexes must be unique per device');
  if (input.actions.some((action) => action.actionIndex < 0)) throw new Error('Automation action indexes must be non-negative');
  if (input.actions.length === 0) return;

  await inDeliberateSystemContext(async () => {
    const locked = await db.execute(sql`
      SELECT id, org_id
      FROM devices
      WHERE id = ${input.device.id}::uuid
      FOR KEY SHARE
    `) as unknown as Array<{ id: string; org_id: string }>;
    const device = locked[0];
    if (!device) throw new Error('Automation action result device not found');
    if (device.org_id !== input.device.orgId) throw new Error('Automation action result device organization mismatch');

    await db.insert(automationActionResults).values(input.actions.map((action) => ({
      runId: input.runId,
      deviceId: device.id,
      orgId: device.org_id,
      actionIndex: action.actionIndex,
      actionType: action.actionType,
    }))).onConflictDoNothing({
      target: [automationActionResults.runId, automationActionResults.deviceId, automationActionResults.actionIndex],
    });

    const persisted = await db.select({
      actionIndex: automationActionResults.actionIndex,
      actionType: automationActionResults.actionType,
    }).from(automationActionResults).where(and(
      eq(automationActionResults.runId, input.runId),
      eq(automationActionResults.deviceId, input.device.id),
      inArray(automationActionResults.actionIndex, input.actions.map((action) => action.actionIndex)),
    ));
    const persistedByIndex = new Map(persisted.map((action) => [action.actionIndex, action.actionType]));
    for (const action of input.actions) {
      if (persistedByIndex.get(action.actionIndex) !== action.actionType) {
        throw new Error(`Automation action seed conflict at index ${action.actionIndex}`);
      }
    }
  });
}

export async function recordAutomationActionDispatch(input: {
  runId: string;
  deviceId: string;
  actionIndex: number;
  status: 'queued' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'skipped';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  message?: string;
}): Promise<boolean> {
  const result = await inDeliberateSystemContext(async () => {
    const [row] = await db.select().from(automationActionResults).where(and(
      eq(automationActionResults.runId, input.runId),
      eq(automationActionResults.deviceId, input.deviceId),
      eq(automationActionResults.actionIndex, input.actionIndex),
    )).limit(1).for('update');
    if (!row) return { changed: false, publications: [] as Publication[] };
    const patch = decideDispatchTransition(row, input);
    if (!patch) return { changed: false, publications: [] as Publication[] };
    const changed = await db.update(automationActionResults).set({ ...patch, updatedAt: new Date() })
      .where(and(...stateCas(row))).returning({ id: automationActionResults.id });
    if (changed.length === 0) return { changed: false, publications: [] as Publication[] };
    return { changed: true, publications: await reconcileInCurrentContext(input.runId) };
  });
  await publishAll(result.publications);
  return result.changed;
}

export async function applyAutomationActionTerminal(input: {
  source: 'command' | 'script_execution' | 'deployment_result' | 'timeout' | 'cancellation' | 'reaper';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  output?: string | null;
  error?: string | null;
  completedAt: Date;
}): Promise<boolean> {
  const supplied = [input.commandId, input.scriptExecutionId, input.deploymentResultId]
    .filter((value): value is string => value !== undefined);
  if (supplied.length !== 1) throw new Error('Exactly one automation action correlation id is required');
  const identity = input.commandId
    ? eq(automationActionResults.commandId, input.commandId)
    : input.scriptExecutionId
      ? eq(automationActionResults.scriptExecutionId, input.scriptExecutionId)
      : eq(automationActionResults.deploymentResultId, input.deploymentResultId!);

  const result = await inDeliberateSystemContext(async () => {
    const [row] = await db.select().from(automationActionResults).where(identity).limit(1).for('update');
    if (!row) return { changed: false, publications: [] as Publication[] };
    const patch = decideTerminalTransition(row, input);
    if (!patch) return { changed: false, publications: [] as Publication[] };
    const changed = await db.update(automationActionResults).set({ ...patch, updatedAt: new Date() })
      .where(and(...stateCas(row))).returning({ id: automationActionResults.id });
    if (changed.length === 0) return { changed: false, publications: [] as Publication[] };
    const provisionalTimeoutRepair = row.status === 'timed_out'
      && row.terminalSource === 'reaper'
      && REAL_TERMINAL_SOURCES.has(input.source)
      ? { actionResultId: row.id }
      : undefined;
    return {
      changed: true,
      publications: await reconcileInCurrentContext(row.runId, provisionalTimeoutRepair),
    };
  });
  await publishAll(result.publications);
  return result.changed;
}

export async function reconcileAutomationRun(runId: string): Promise<void> {
  const publications = await inDeliberateSystemContext(() => reconcileInCurrentContext(runId));
  await publishAll(publications);
}

export const __testOnly = {
  decideDispatchTransition,
  decideTerminalTransition,
  aggregateActionStatuses,
  aggregateDeviceStatuses,
  aggregateActionDetails,
};
