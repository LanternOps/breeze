import type { RemediationTrigger } from '@breeze/shared';
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
  automations,
} from '../db/schema';
import { publishEvent } from './eventBus';
import { captureException } from './sentry';
import { recordEpisodeResponse } from './monitors/episodeService';
import type { MonitorResponseOutcome } from '../db/schema/monitorEpisodes';

export type AutomationActionResultStatus =
  | 'pending' | 'dispatching' | 'queued' | 'delivered' | 'running'
  | 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';

export type AutomationActionTerminalSource =
  | 'command' | 'script_execution' | 'deployment_result'
  | 'timeout' | 'cancellation' | 'reaper' | 'dispatch'
  // #5290 — a child ai_triage agent run reported terminal through
  // ai.agent.run.completed / .failed / .skipped.
  | 'agent_run';

/**
 * One value of `automation_device_result_status` (#3525 W05 added `cancelled`).
 * Named rather than inlined so the aggregation functions and the device-row
 * writer cannot drift apart when the enum grows again.
 */
export type AutomationDeviceResultStatus =
  | 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';

/** One value of `automation_run_status` (#3525 W05 added `cancelled`). */
export type AutomationRunStatus =
  | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

/** Device-result statuses that mean the device is done, whatever the outcome. */
const TERMINAL_DEVICE_STATUSES = new Set<AutomationDeviceResultStatus>([
  'success', 'failed', 'skipped', 'cancelled',
]);

type Correlations = {
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  /** #5290 — the child ai_triage agent run this action is waiting on. */
  agentRunId?: string;
};

type ActionState = {
  status: AutomationActionResultStatus;
  terminalSource: AutomationActionTerminalSource | null;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
  /**
   * #5290 — optional on the READ shape so the many existing callers/fixtures
   * that predate the column keep compiling; a row selected from the table
   * always carries it (null when unset). `correlationsPatch` normalises
   * `undefined` to null before comparing.
   */
  agentRunId?: string | null;
};

type ActionPatch = Partial<{
  status: AutomationActionResultStatus;
  terminalSource: AutomationActionTerminalSource | null;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
  agentRunId: string | null;
  message: string | null;
  output: string | null;
  error: string | null;
  completedAt: Date | null;
}>;

// #3189 — `dispatching` is the claim: one attempt owns the action and is
// creating its effect. It ranks above `pending` (a claimed row is never walked
// back) and below `queued` (the stamped outcome always advances it).
const NONTERMINAL_RANK: Partial<Record<AutomationActionResultStatus, number>> = {
  pending: 0,
  dispatching: 1,
  queued: 2,
  delivered: 3,
  running: 4,
};
const TERMINAL = new Set<AutomationActionResultStatus>([
  'succeeded', 'failed', 'skipped', 'timed_out', 'cancelled',
]);
const REAL_TERMINAL_SOURCES = new Set<AutomationActionTerminalSource>([
  'command', 'script_execution', 'deployment_result',
  // #5290 — the child run finishing IS the real evidence for an ai_triage
  // action, so it may replace a provisional reaper timeout like the others.
  'agent_run',
]);

function correlationsPatch(state: ActionState, input: Correlations): ActionPatch | null {
  const patch: ActionPatch = {};
  for (const key of ['commandId', 'scriptExecutionId', 'deploymentResultId', 'agentRunId'] as const) {
    const proposed = input[key];
    if (proposed === undefined) continue;
    const current = state[key] ?? null;
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
    // #5128 W4: clear the dispatch-time message, exactly as
    // `decideDispatchTransition`'s terminal branch already does. `message` is
    // the "why is this not finished yet" field; once the action IS finished,
    // `output`/`error` own the story. Leaving it set matters because
    // `aggregateActionDetails` falls back to it (`output ?? message`, and
    // `failed.error ?? failed.message`), so a stale value leaks into the
    // device row: a script that queued while the device was offline, then
    // reconnected and succeeded printing nothing, would report its output as
    // "Queued — device offline", and one that later failed with no stderr
    // would show that string as the red failure reason for a run that
    // demonstrably executed.
    message: null,
    completedAt: input.completedAt,
  };
}

function aggregateActionStatuses(statuses: AutomationActionResultStatus[]): {
  status: AutomationDeviceResultStatus;
} {
  if (statuses.some((status) => !TERMINAL.has(status))) {
    return { status: statuses.every((status) => status === 'pending') ? 'pending' : 'running' };
  }
  // OD6-A: a REAL failure outranks a stop, so the failed lane is tested first
  // and `cancelled` gets its own lane after it. Before #3525 W05 `cancelled`
  // was folded into this predicate, which reported every stopped device as a
  // failure and poisoned automation health and any devicesFailed alerting.
  if (statuses.some((status) => status === 'failed' || status === 'timed_out')) {
    return { status: 'failed' };
  }
  if (statuses.some((status) => status === 'cancelled')) return { status: 'cancelled' };
  if (statuses.every((status) => status === 'skipped')) return { status: 'skipped' };
  return { status: 'success' };
}

function aggregateDeviceStatuses(statuses: AutomationDeviceResultStatus[]): {
  status: AutomationRunStatus;
  devicesSucceeded: number;
  devicesFailed: number;
  devicesCancelled: number;
} {
  const devicesSucceeded = statuses.filter((status) => status === 'success').length;
  const devicesFailed = statuses.filter((status) => status === 'failed').length;
  const devicesCancelled = statuses.filter((status) => status === 'cancelled').length;
  const counts = { devicesSucceeded, devicesFailed, devicesCancelled };
  if (statuses.some((status) => status === 'pending' || status === 'running')) {
    return { status: 'running', ...counts };
  }
  // A run is `cancelled` only when nothing actually failed. One real failure
  // and the run reports that failure — a stop never hides it.
  if (devicesFailed === 0 && devicesCancelled > 0) return { status: 'cancelled', ...counts };
  if (devicesFailed === 0) return { status: 'completed', ...counts };
  if (devicesSucceeded === 0) return { status: 'failed', ...counts };
  return { status: 'partial', ...counts };
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

/**
 * #3189 — every ledger mutator takes the run row BEFORE any action row.
 *
 * Reconciliation needs the run `FOR UPDATE`, and the dispatch claim holds the
 * run `FOR KEY SHARE` while it CASes an action row
 * (`claimAutomationActionDispatches`), as does `cancelAutomationRun` (run
 * `FOR UPDATE`, then its bulk `pending` update). A writer that locked an action
 * row first and asked for the run second would deadlock against a claimer that
 * read that row as `pending` just before. Taking the run first makes the order
 * the same everywhere; `reconcileInCurrentContext` re-locking it is a no-op.
 */
async function lockRunForLedgerWrite(runId: string): Promise<void> {
  await db.select({ id: automationRuns.id }).from(automationRuns)
    .where(eq(automationRuns.id, runId)).limit(1).for('update');
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
  type: 'automation.completed' | 'automation.failed' | 'automation.cancelled';
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

/**
 * #5290 — map a terminal automation-run status onto the episode's
 * `response_outcome`.
 *
 * `cancelled` returns null deliberately: an operator stop is not evidence that
 * the remediation succeeded or failed, so the outcome already on the episode
 * (usually `queued`) stands. `running` returns null because the run is not
 * terminal yet.
 */
function decideMonitorEpisodeOutcome(
  runStatus: AutomationRunStatus,
): MonitorResponseOutcome | null {
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'failed' || runStatus === 'partial') return 'failed';
  return null;
}

/**
 * Write the run's terminal outcome onto the open breach episode of every device
 * the run touched, when the run belongs to a monitor-compiled automation.
 *
 * Never allowed to abort reconciliation: a monitor bookkeeping failure must not
 * strand an automation run mid-transition.
 */
async function recordMonitorEpisodeOutcomes(
  automationId: string | null,
  runStatus: AutomationRunStatus,
  deviceIds: string[],
): Promise<void> {
  const outcome = decideMonitorEpisodeOutcome(runStatus);
  if (!automationId || !outcome || deviceIds.length === 0) return;

  let monitorId: string | null | undefined;
  try {
    const [automation] = await db
      .select({ monitorId: automations.managedByMonitorId })
      .from(automations)
      .where(eq(automations.id, automationId))
      .limit(1);
    monitorId = automation?.monitorId;
  } catch (error) {
    captureException(error, undefined, {
      errorId: 'monitor-episode-response-outcome-failed',
      automationId,
      runStatus,
    });
    console.error(
      `[AutomationActionResults] Failed to resolve the monitor for automation ${automationId}:`,
      error,
    );
    return;
  }
  if (!monitorId) return;

  // Per-device, not per-batch: this runs exactly once per terminal transition
  // with no retry, so one bad device must not strand the rest at `queued` —
  // and the capture has to name the device to be actionable.
  for (const deviceId of deviceIds) {
    try {
      await recordEpisodeResponse({ monitorId, deviceId, outcome });
    } catch (error) {
      captureException(error, undefined, {
        errorId: 'monitor-episode-response-outcome-failed',
        automationId,
        runStatus,
        deviceId,
      });
      console.error(
        `[AutomationActionResults] Failed to record monitor episode outcome for automation ${automationId} device ${deviceId}:`,
        error,
      );
    }
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

  if (run.status === 'cancelled') {
    // #8104 — a device whose `pending` result row was seeded but whose action
    // rows never were (the cancel committed between the two seeds) can never
    // gain an action row now: `seedAutomationActionResults` refuses to insert
    // for a cancelled run. Nothing else would ever close it, and a `pending`
    // device row keeps the run aggregate `running`, so the cancelled run would
    // never get its completed_at. Settle it here, under the run lock.
    await db.update(automationRunDeviceResults).set({
      status: 'cancelled',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(automationRunDeviceResults.runId, runId),
      eq(automationRunDeviceResults.status, 'pending'),
      sql`NOT EXISTS (
        SELECT 1 FROM automation_action_results aar
        WHERE aar.run_id = ${automationRunDeviceResults.runId}
          AND aar.device_id = ${automationRunDeviceResults.deviceId}
      )`,
    ));
  }

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

  // #3525 W05 — the device rewrite below is unconditional, so a device that
  // already proved it STOPPED must not be walked back to pending/running just
  // because a sibling action of the same device is still in flight. Read the
  // current statuses once (the run row is held FOR UPDATE above, so nothing
  // else is rewriting them) and clamp.
  const currentDeviceStatuses = new Map(
    (await db.select({
      deviceId: automationRunDeviceResults.deviceId,
      status: automationRunDeviceResults.status,
    })
      .from(automationRunDeviceResults)
      .where(eq(automationRunDeviceResults.runId, runId)))
      .map((row) => [row.deviceId, row.status] as const),
  );

  for (const [deviceId, actions] of byDevice) {
    const derived = aggregateActionStatuses(actions.map((action) => action.status));
    const aggregate = currentDeviceStatuses.get(deviceId) === 'cancelled'
      && !TERMINAL_DEVICE_STATUSES.has(derived.status)
      ? { status: 'cancelled' as const }
      : derived;
    const details = aggregateActionDetails(actions);
    const terminal = TERMINAL_DEVICE_STATUSES.has(aggregate.status);
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
    devicesCancelled: aggregate.devicesCancelled,
  };

  // #3525 W05 — `cancelled` is stamped on the run by the CANCEL REQUEST (that
  // write is the dispatch fence), long before its children close. So a
  // cancelled run is NOT "already terminal, stop reconciling": it keeps
  // counting children home, and only its completed_at marks the end. It is
  // also never transitioned to anything else — an operator who stopped a run
  // must not later find it labelled `completed`.
  const runWasCancelled = run.status === 'cancelled';

  const publicationsOfType = (type: Publication['type'], status: AutomationRunStatus): Publication[] => {
    const orgIds = [...new Set(actionRows.map((row) => row.orgId))];
    return orgIds.map((orgId) => ({
      type,
      orgId,
      payload: {
        ...(run.automationId ? { automationId: run.automationId } : {
          configPolicyAutomationId: run.configPolicyId,
          configItemName: run.configItemName,
        }),
        runId,
        triggeredBy: run.triggeredBy,
        status,
        ...common,
      },
    }));
  };

  const buildPublications = (status: AutomationRunStatus): Publication[] => publicationsOfType(
    status === 'completed'
      ? 'automation.completed'
      : status === 'cancelled'
        ? 'automation.cancelled'
        : 'automation.failed',
    status,
  );

  if (aggregate.status === 'running') {
    if (runWasCancelled) {
      await db.update(automationRuns).set(common)
        .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'cancelled')));
      return [];
    }
    await db.update(automationRuns).set({ ...common, completedAt: null })
      .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'running')));
    return [];
  }

  if (runWasCancelled) {
    // Every child is terminal now, so the cancelled run is finished. The
    // completed_at IS NULL guard is the transition: exactly one reconcile wins
    // it, so `automation.cancelled` is published exactly once.
    const finished = await db.update(automationRuns)
      .set({ ...common, completedAt: new Date() })
      .where(and(
        eq(automationRuns.id, runId),
        eq(automationRuns.status, 'cancelled'),
        isNull(automationRuns.completedAt),
      ))
      .returning({ id: automationRuns.id });
    if (finished.length === 0) {
      await db.update(automationRuns).set(common)
        .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'cancelled')));
      return [];
    }
    // The run KEEPS the `cancelled` label: a deliberate human stop is the most
    // specific explanation of why it ended, and relabelling it `failed` would
    // page an MSP for every cancel whose SIGKILL produced a nonzero exit.
    //
    // But a stop must not HIDE a failure either, so when devices failed we
    // publish `automation.failed` alongside. There is no false-alarm cost:
    // W03's closers stamp a PROVEN post-cancel kill as `cancelled`, never
    // `failed`, so a device still reading `failed` on a cancelled run is a
    // failure the cancellation machinery did not account for — exactly what
    // failure alerting exists for. Both events ride the same
    // `completed_at IS NULL` transition, so each fires exactly once.
    return [
      ...publicationsOfType('automation.cancelled', 'cancelled'),
      ...(aggregate.devicesFailed > 0 ? publicationsOfType('automation.failed', 'cancelled') : []),
    ];
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

  await recordMonitorEpisodeOutcomes(
    run.automationId,
    aggregate.status,
    deviceRows.map((row) => row.deviceId),
  );

  return buildPublications(aggregate.status);
}

/**
 * Seed one `pending` ledger row per action for one device of a run.
 *
 * #8104 — the seed is itself a dispatch-side write, so it is FENCED against a
 * run-wide cancel in the same transaction as the insert. `cancelAutomationRun`
 * terminalises only rows that are `pending` when it commits; a row inserted
 * after that commit would sit `pending` forever, since the runtime's next
 * fence check just stops dispatching. The runtime's own pre-seed check runs in
 * an earlier transaction and cannot close that window, so the run row is read
 * here `FOR KEY SHARE`, which conflicts with the cancel's `FOR UPDATE`: either
 * this seed commits first and the cancel's sweep sees its rows, or the cancel
 * commits first and this returns `run_cancelled` without inserting anything.
 * The run row is locked BEFORE the device row, matching the run-before-action
 * order every other dispatch path uses.
 */
export async function seedAutomationActionResults(input: {
  trigger?: RemediationTrigger;
  runId: string;
  device: { id: string; orgId: string };
  actions: Array<{ actionIndex: number; actionType: string }>;
}): Promise<'seeded' | 'run_cancelled'> {
  const indexes = new Set(input.actions.map((action) => action.actionIndex));
  if (indexes.size !== input.actions.length) throw new Error('Automation action indexes must be unique per device');
  if (input.actions.some((action) => action.actionIndex < 0)) throw new Error('Automation action indexes must be non-negative');
  if (input.actions.length === 0) return 'seeded';

  return inDeliberateSystemContext(async () => {
    const runRows = await db.execute(sql`
      SELECT status
      FROM automation_runs
      WHERE id = ${input.runId}::uuid
      FOR KEY SHARE
    `) as unknown as Array<{ status: string }>;
    const run = runRows[0];
    if (!run) throw new Error(`Automation run ${input.runId} not found`);
    if (run.status === 'cancelled') return 'run_cancelled' as const;

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
      triggerKind: input.trigger?.kind ?? null,
      triggerRefId: input.trigger?.refId ?? null,
      triggerKey: input.trigger?.key ?? null,
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
    return 'seeded' as const;
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
  /** #5290 — set by the ai_triage action so its child run can terminalise it. */
  agentRunId?: string;
  message?: string;
  /**
   * #3189 — write only if nobody has claimed the action yet. Every writer that
   * is NOT the attempt holding the claim (trailing skips, authority loss,
   * catch-block failures, deterministic deploy skips) sets this, so it can
   * never overwrite an action another attempt of the same run dispatched.
   * Returns false when the row is past `pending`; the caller then treats the
   * action as owned elsewhere.
   */
  onlyFromPending?: boolean;
}): Promise<boolean> {
  const result = await inDeliberateSystemContext(async () => {
    await lockRunForLedgerWrite(input.runId);
    const [row] = await db.select().from(automationActionResults).where(and(
      eq(automationActionResults.runId, input.runId),
      eq(automationActionResults.deviceId, input.deviceId),
      eq(automationActionResults.actionIndex, input.actionIndex),
    )).limit(1).for('update');
    if (!row) return { changed: false, publications: [] as Publication[] };
    if (input.onlyFromPending && row.status !== 'pending') {
      return { changed: false, publications: [] as Publication[] };
    }
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

/** #3189 — what a replaying attempt needs to reuse an already-claimed action. */
export type AutomationActionLedgerState = {
  status: AutomationActionResultStatus;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
  agentRunId: string | null;
  message: string | null;
  error: string | null;
};

async function readLedgerStates(
  runId: string,
  actionIndex: number,
  deviceIds: readonly string[],
): Promise<Map<string, AutomationActionLedgerState>> {
  if (deviceIds.length === 0) return new Map();
  const rows = await db.select({
    deviceId: automationActionResults.deviceId,
    status: automationActionResults.status,
    commandId: automationActionResults.commandId,
    scriptExecutionId: automationActionResults.scriptExecutionId,
    deploymentResultId: automationActionResults.deploymentResultId,
    agentRunId: automationActionResults.agentRunId,
    message: automationActionResults.message,
    error: automationActionResults.error,
  }).from(automationActionResults).where(and(
    eq(automationActionResults.runId, runId),
    eq(automationActionResults.actionIndex, actionIndex),
    inArray(automationActionResults.deviceId, [...deviceIds]),
  ));
  return new Map(rows.map(({ deviceId, ...state }) => [deviceId, state]));
}

/** #3189 — read one action's ledger state (null when it was never seeded). */
export async function readAutomationActionState(input: {
  runId: string;
  deviceId: string;
  actionIndex: number;
}): Promise<AutomationActionLedgerState | null> {
  return inDeliberateSystemContext(async () => (
    (await readLedgerStates(input.runId, input.actionIndex, [input.deviceId])).get(input.deviceId) ?? null
  ));
}

function assertInDispatchTransaction(what: string): void {
  // The claim is only worth anything when it commits or rolls back TOGETHER
  // with the effect it guards. A claim on the pooled db would autocommit and
  // could strand a `dispatching` row with no effect behind it.
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error(`${what} must run inside the system-scoped dispatch transaction`);
  }
}

export type AutomationActionClaims = {
  /** The run was cancelled: nothing was claimed and nothing may be dispatched. */
  runCancelled: boolean;
  /** Devices this attempt now owns (pending -> dispatching), in claim order. */
  claimed: string[];
  /** Devices whose action another attempt already claimed, with its state. */
  alreadyClaimed: Map<string, AutomationActionLedgerState>;
};

/**
 * #3189 — claim one action for a set of devices before dispatching it.
 *
 * MUST run inside the transaction that then creates the action's effect and
 * stamps its outcome (`stampClaimedAutomationActionOutcome`), so the claim,
 * the effect rows and the stamped correlation ids commit or roll back as one.
 * A BullMQ stalled-job replay of the same run then finds the row past
 * `pending` and reuses what is stored instead of dispatching again.
 *
 * Lock order is run row, then action rows: the order `cancelAutomationRun`
 * uses (run FOR UPDATE, then its bulk `pending` update). Taking the action row
 * first and the run's FK KEY SHARE later (the script_executions insert) would
 * deadlock against a concurrent cancel.
 *
 * Each device is read without a lock first. A row already past `pending` is
 * reported without waiting on its lock, which the owning attempt may hold
 * across its own reconcile (action row, then run FOR UPDATE). Only a row that
 * still reads `pending` is claimed with the CAS; a concurrent claimer blocks on
 * it, re-evaluates after the owner commits, and loses. Devices are claimed one
 * at a time in ascending id order so two batch claimers lock in the same order.
 */
export async function claimAutomationActionDispatches(input: {
  runId: string;
  actionIndex: number;
  deviceIds: readonly string[];
}): Promise<AutomationActionClaims> {
  assertInDispatchTransaction('claimAutomationActionDispatches');
  const claims: AutomationActionClaims = { runCancelled: false, claimed: [], alreadyClaimed: new Map() };
  const deviceIds = [...new Set(input.deviceIds)].sort();
  if (deviceIds.length === 0) return claims;

  const runRows = await db.execute(sql`
    SELECT status
    FROM automation_runs
    WHERE id = ${input.runId}::uuid
    FOR KEY SHARE
  `) as unknown as Array<{ status: string }>;
  const run = runRows[0];
  if (!run) throw new Error(`Automation run ${input.runId} not found`);
  if (run.status === 'cancelled') return { ...claims, runCancelled: true };

  const before = await readLedgerStates(input.runId, input.actionIndex, deviceIds);
  for (const deviceId of deviceIds) {
    const state = before.get(deviceId);
    if (!state) {
      // Seeding always precedes dispatch. A missing row means the ledger that
      // makes this action idempotent does not exist, so refuse rather than
      // send an effect nothing can deduplicate.
      throw new Error(
        `Automation action result missing for run=${input.runId} device=${deviceId} action=${input.actionIndex}`,
      );
    }
    if (state.status !== 'pending') {
      claims.alreadyClaimed.set(deviceId, state);
      continue;
    }
    const won = await db.update(automationActionResults)
      .set({ status: 'dispatching', updatedAt: new Date() })
      .where(and(
        eq(automationActionResults.runId, input.runId),
        eq(automationActionResults.deviceId, deviceId),
        eq(automationActionResults.actionIndex, input.actionIndex),
        eq(automationActionResults.status, 'pending'),
      ))
      .returning({ id: automationActionResults.id });
    if (won.length === 1) {
      claims.claimed.push(deviceId);
      continue;
    }
    const after = (await readLedgerStates(input.runId, input.actionIndex, [deviceId])).get(deviceId);
    if (!after) {
      throw new Error(
        `Automation action result vanished for run=${input.runId} device=${deviceId} action=${input.actionIndex}`,
      );
    }
    claims.alreadyClaimed.set(deviceId, after);
  }
  return claims;
}

/** #3189 — single-device form of `claimAutomationActionDispatches`. */
export async function claimAutomationActionDispatch(input: {
  runId: string;
  deviceId: string;
  actionIndex: number;
}): Promise<
  | { kind: 'claimed' }
  | { kind: 'already_claimed'; state: AutomationActionLedgerState }
  | { kind: 'run_cancelled' }
> {
  const claims = await claimAutomationActionDispatches({
    runId: input.runId,
    actionIndex: input.actionIndex,
    deviceIds: [input.deviceId],
  });
  if (claims.runCancelled) return { kind: 'run_cancelled' };
  const state = claims.alreadyClaimed.get(input.deviceId);
  if (state) return { kind: 'already_claimed', state };
  return { kind: 'claimed' };
}

/**
 * #3189 — record a claimed action's dispatch outcome INSIDE the claim
 * transaction, so a committed claim always carries either its correlation ids
 * (command / script execution / deployment result / agent run) or its terminal
 * status. Without this, a crash between commit and the post-commit
 * `recordAutomationActionDispatch` would leave a `dispatching` row that no
 * result path can find and no replay may redo.
 *
 * Deliberately does not reconcile or publish: this transaction has not
 * committed, and an `automation.completed` event must never describe state
 * that could still roll back. The caller reconciles after commit.
 *
 * Only moves a row this attempt holds in `dispatching`; returns false (and
 * writes nothing) otherwise.
 */
export async function stampClaimedAutomationActionOutcome(input: {
  runId: string;
  deviceId: string;
  actionIndex: number;
  status: 'queued' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'skipped';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  agentRunId?: string;
  message?: string;
}): Promise<boolean> {
  assertInDispatchTransaction('stampClaimedAutomationActionOutcome');
  const [row] = await db.select().from(automationActionResults).where(and(
    eq(automationActionResults.runId, input.runId),
    eq(automationActionResults.deviceId, input.deviceId),
    eq(automationActionResults.actionIndex, input.actionIndex),
  )).limit(1).for('update');
  if (!row || row.status !== 'dispatching') return false;
  const patch = decideDispatchTransition(row, input);
  if (!patch) return false;
  const changed = await db.update(automationActionResults).set({ ...patch, updatedAt: new Date() })
    .where(and(...stateCas(row))).returning({ id: automationActionResults.id });
  return changed.length === 1;
}

export async function applyAutomationActionTerminal(input: {
  source: 'command' | 'script_execution' | 'deployment_result' | 'timeout' | 'cancellation' | 'reaper' | 'agent_run';
  commandId?: string;
  scriptExecutionId?: string;
  deploymentResultId?: string;
  /** #5290 — correlation for an ai_triage action's child agent run. */
  agentRunId?: string;
  terminalStatus: 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';
  output?: string | null;
  error?: string | null;
  completedAt: Date;
}): Promise<boolean> {
  const supplied = [input.commandId, input.scriptExecutionId, input.deploymentResultId, input.agentRunId]
    .filter((value): value is string => value !== undefined);
  if (supplied.length !== 1) throw new Error('Exactly one automation action correlation id is required');
  const identity = input.commandId
    ? eq(automationActionResults.commandId, input.commandId)
    : input.scriptExecutionId
      ? eq(automationActionResults.scriptExecutionId, input.scriptExecutionId)
      : input.deploymentResultId
        ? eq(automationActionResults.deploymentResultId, input.deploymentResultId)
        : eq(automationActionResults.agentRunId, input.agentRunId!);

  const result = await inDeliberateSystemContext(async () => {
    // #3189 — run row before action row, like every other ledger mutator. The
    // correlation id is all we have, so find the run first without a lock.
    const [located] = await db.select({ runId: automationActionResults.runId })
      .from(automationActionResults).where(identity).limit(1);
    if (!located) return { changed: false, publications: [] as Publication[] };
    await lockRunForLedgerWrite(located.runId);
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
  decideMonitorEpisodeOutcome,
  decideDispatchTransition,
  decideTerminalTransition,
  aggregateActionStatuses,
  aggregateDeviceStatuses,
  aggregateActionDetails,
};
