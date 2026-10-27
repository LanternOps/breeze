/**
 * Tool Catalog W06 (#5221) Task A5 — fleet script dispatch for the flow
 * `run_script_on_targets` built-in, with the legacy run_script guarantees.
 *
 * The dispatch itself is the single script seam every caller uses
 * (`dispatchScriptToDevice`, through the AI lane `aiDispatchScriptToDevice`
 * so the execution and command rows carry `ai_initiator_kind = 'flow'`, W04
 * Decision 16): the script_executions row, sensitive-field encryption, the
 * maintenance-window gate, the offline policy (queue with the legacy standard
 * delivery deadline, or reject for `skip`), and deferred delivery. What this
 * module adds around it, per device, mirrors the legacy action loop
 * (automationRuntime `executeAutomationActionsInOrder`):
 *
 *  - a cancellation fence (the flow run's cancel request / terminal status)
 *    and, on the runner path, the slice's lease, read under lock before each
 *    device — a cancelled run stops before the next device;
 *  - a per-device lock on the device row, in the run org (a device moved out
 *    of the run org is refused, never dispatched);
 *  - a durable per-device claim before the dispatch: the device's
 *    `flow_run_steps` row, written in the SAME transaction as the dispatch
 *    rows, so either both commit or neither does — a redelivered release or a
 *    resumed attempt finds the row and never dispatches the device twice;
 *  - commit before delivery: the agent send runs only after the transaction
 *    commits (#3445), then the legacy `queued` bookkeeping for an undelivered
 *    command.
 *
 * Legacy automations keep their own loop (claims in automation_action_results)
 * and call the same seam; W06 does not move that loop (plan deviation, stated
 * in the PR: the loop is shared by every action type and every managed class).
 *
 * Outcomes follow the legacy action results: dispatched or queued is success
 * (`queued_is_success`); an offline device under `skip` is `skipped_offline`
 * (legacy records it failed — the fleet output lists it in both sets); a
 * maintenance-window suppression is `skipped` (not a failure, like legacy).
 */
import { deliveryTtlMs, type OfflinePolicy } from './commandOfflinePolicy';
import { aiDispatchScriptToDevice } from './aiDispatch';
import type { DispatchScriptResult } from './scriptDispatch';
import type { TenantVariableScope } from './tenantVariableResolution';
import type { AuthContext } from '../middleware/auth';
import type { scripts } from '../db/schema';
import { captureException } from './sentry';
import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  findDeviceStepRow,
  finishDeviceStepRow,
  inRunOrgTransaction,
  insertDeviceStepRow,
  lockRunOrgDevice,
  markExecutionQueued,
  readCommandStatus,
  readRunFence,
  type DeviceStepRow,
  type FleetRun,
  type RunFence,
} from './scriptFleetDispatchStore';

export type FleetDeviceOutcome = 'dispatched' | 'queued' | 'skipped_offline' | 'skipped' | 'failed';

export interface FleetDeviceResult {
  deviceId: string;
  outcome: FleetDeviceOutcome;
  executionId: string | null;
  commandId: string | null;
  error: string | null;
}

export interface FleetDispatchArgs {
  run: FleetRun;
  stepId: string;
  /** The runner slice's lease (fenced per device); null on the release-worker path. */
  leaseToken: string | null;
  /** The run's flow principal (its `aiOrigin` attributes every dispatch). */
  auth: Pick<AuthContext, 'aiOrigin'> & Partial<Pick<AuthContext, 'user'>>;
  /** The flow's delegator — recorded as the execution's trigger and creator. */
  delegatorUserId: string | null;
  script: typeof scripts.$inferSelect;
  parameters: Record<string, unknown>;
  /** Explicit run context; null ⇒ the script's saved default. Never `elevated` (the caller refuses it). */
  runAs: 'system' | 'user' | null;
  offlinePolicy: 'queue' | 'skip';
  /** The checked device set, sorted; a device's position is its row's item_index. */
  deviceIds: readonly string[];
  variableScope: TenantVariableScope | undefined;
  /** Devices dispatched at once (legacy runs five). */
  concurrency?: number;
}

export interface FleetDispatchResult {
  /** One entry per device reached, in set order; devices after a stop are absent. */
  perDevice: FleetDeviceResult[];
  stopped: RunFence | null;
}

const NOT_IN_RUN_ORG = 'The device is no longer in the run\'s organization; it was not dispatched.';
const OS_MISMATCH = 'Script OS type does not match target device';
const ROW_MISMATCH = 'This device position was already recorded for a different device; nothing was dispatched.';

function offlinePolicyFor(when: 'queue' | 'skip'): OfflinePolicy {
  return when === 'skip' ? { kind: 'reject' } : { kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') };
}

function result(deviceId: string, outcome: FleetDeviceOutcome, extra: Partial<FleetDeviceResult> = {}): FleetDeviceResult {
  return { deviceId, outcome, executionId: null, commandId: null, error: null, ...extra };
}

const RECORDED_OUTCOMES: ReadonlySet<string> = new Set(['dispatched', 'queued', 'skipped_offline', 'skipped', 'failed']);

/** A device row an earlier attempt committed: reuse what it recorded, never dispatch again. */
function replayed(row: DeviceStepRow, deviceId: string): FleetDeviceResult {
  const input = (row.renderedInput ?? {}) as { deviceId?: unknown };
  const out = (row.output ?? {}) as { outcome?: unknown; executionId?: unknown; commandId?: unknown; error?: unknown };
  if (input.deviceId !== deviceId) return result(deviceId, 'failed', { error: ROW_MISMATCH });
  const outcome = typeof out.outcome === 'string' && RECORDED_OUTCOMES.has(out.outcome) ? out.outcome as FleetDeviceOutcome : 'failed';
  return result(deviceId, outcome, {
    executionId: typeof out.executionId === 'string' ? out.executionId : null,
    commandId: typeof out.commandId === 'string' ? out.commandId : null,
    error: outcome === 'failed' ? (typeof out.error === 'string' ? out.error : 'The device failed in an earlier attempt.') : null,
  });
}

type Staged =
  | { kind: 'stop'; fence: RunFence }
  | { kind: 'done'; result: FleetDeviceResult }
  | { kind: 'dispatched'; rowId: string; dispatch: Extract<DispatchScriptResult, { ok: true }> };

async function stage(args: FleetDispatchArgs, index: number): Promise<Staged> {
  const deviceId = args.deviceIds[index]!;
  return inRunOrgTransaction(args.run, async () => {
    const fence = await readRunFence(args.run.id, args.leaseToken);
    if (fence) return { kind: 'stop', fence };
    // Lock FIRST, then look for the claim: a concurrent attempt on the same
    // device waits here and then finds the winner's committed claim.
    const device = await lockRunOrgDevice(args.run.orgId, deviceId);
    const existing = await findDeviceStepRow(args.run.id, args.stepId, deviceId);
    if (existing) return { kind: 'done', result: replayed(existing, deviceId) };

    const rowId = await insertDeviceStepRow({
      runId: args.run.id, orgId: args.run.orgId, stepId: args.stepId, itemIndex: index, deviceId, scriptId: args.script.id,
    });
    const fail = async (error: string): Promise<Staged> => {
      await finishDeviceStepRow(rowId, {
        status: 'failed', output: { deviceId, outcome: 'failed', error }, errorCode: 'script_dispatch_failed', error,
      }, null);
      return { kind: 'done', result: result(deviceId, 'failed', { error }) };
    };
    if (!device) return fail(NOT_IN_RUN_ORG);
    if (!args.script.osTypes.includes(device.osType)) return fail(OS_MISMATCH);

    const dispatch = await aiDispatchScriptToDevice(args.auth, 'run_script_on_targets', {
      device,
      source: { kind: 'saved', script: args.script },
      parameters: args.parameters,
      triggerType: 'automation',
      triggeredBy: args.delegatorUserId,
      createdBy: args.delegatorUserId,
      runAs: args.runAs ?? undefined,
      offlinePolicy: offlinePolicyFor(args.offlinePolicy),
      variableScope: args.variableScope,
      deferDelivery: true,
    });
    if (!dispatch.ok) {
      if (dispatch.code === 'device_offline' || dispatch.code === 'maintenance_suppressed') {
        const outcome: FleetDeviceOutcome = dispatch.code === 'device_offline' ? 'skipped_offline' : 'skipped';
        await finishDeviceStepRow(rowId, { status: 'skipped', output: { deviceId, outcome, error: dispatch.error } }, null);
        return { kind: 'done', result: result(deviceId, outcome, { error: dispatch.error }) };
      }
      return fail(dispatch.error);
    }
    await finishDeviceStepRow(rowId, {
      status: 'completed',
      output: {
        deviceId, outcome: 'queued', executionId: dispatch.executionId, commandId: dispatch.commandId,
        deliverBy: dispatch.deliverBy ? dispatch.deliverBy.toISOString() : null,
      },
    }, null);
    return { kind: 'dispatched', rowId, dispatch };
  });
}

const UNDELIVERED_AFTER_CLAIM = 'The command was claimed for delivery but could not be sent; it will not run.';
const UNEXPECTED = 'Dispatch failed unexpectedly; see the server log.';

function report(err: unknown, args: FleetDispatchArgs, deviceId: string, site: string): void {
  captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
    flow_run_id: args.run.id, flow_step_id: args.stepId, device_id: deviceId, flow_site: `scriptFleetDispatch.${site}`,
  });
}

/** Rewrite a committed device row as failed. Best effort: the result reported to the step is what decides. */
async function markRowFailed(args: FleetDispatchArgs, deviceId: string, rowId: string, base: Partial<FleetDeviceResult>, error: string): Promise<void> {
  try {
    await finishDeviceStepRow(rowId, {
      status: 'failed', output: { deviceId, outcome: 'failed', ...base, error }, errorCode: 'script_dispatch_failed', error,
    }, args.run);
  } catch (err) {
    report(err, args, deviceId, 'markRowFailed');
  }
}

/**
 * After commit: the agent send, then the legacy queued bookkeeping. Never
 * throws — the device was dispatched (its rows committed), so a failure here
 * must not abort the rest of the fleet or lose the device's result.
 */
async function deliver(args: FleetDispatchArgs, deviceId: string, rowId: string, dispatch: Extract<DispatchScriptResult, { ok: true }>): Promise<FleetDeviceResult> {
  const base = { executionId: dispatch.executionId, commandId: dispatch.commandId };
  if (!dispatch.deliver) return result(deviceId, dispatch.delivered ? 'dispatched' : 'queued', base);
  let delivered: DispatchScriptResult;
  try {
    delivered = await dispatch.deliver();
  } catch (err) {
    report(err, args, deviceId, 'deliver');
    // A command still `pending` waits for the agent's next check-in (queued is
    // success). One already claimed for delivery that threw will not run.
    let status: string | null = 'pending';
    try {
      status = await readCommandStatus(args.run, dispatch.commandId);
    } catch (readErr) {
      report(readErr, args, deviceId, 'readCommandStatus');
    }
    if (status === 'pending') return result(deviceId, 'queued', base);
    await markRowFailed(args, deviceId, rowId, base, UNDELIVERED_AFTER_CLAIM);
    return result(deviceId, 'failed', { ...base, error: UNDELIVERED_AFTER_CLAIM });
  }
  if (!delivered.ok) {
    await markRowFailed(args, deviceId, rowId, base, delivered.error);
    return result(deviceId, 'failed', { ...base, error: delivered.error });
  }
  if (!delivered.delivered && delivered.executionId) {
    try {
      await markExecutionQueued(args.run, delivered.executionId);
    } catch (err) {
      report(err, args, deviceId, 'markExecutionQueued');
    }
  }
  return result(deviceId, delivered.delivered ? 'dispatched' : 'queued', base);
}

/** After a claim collision: the winner's committed row decides; never a second dispatch. */
async function replayAfterCollision(args: FleetDispatchArgs, deviceId: string): Promise<FleetDeviceResult> {
  try {
    const row = await inRunOrgTransaction(args.run, () => findDeviceStepRow(args.run.id, args.stepId, deviceId));
    if (row) return replayed(row, deviceId);
  } catch (err) {
    report(err, args, deviceId, 'replayAfterCollision');
  }
  // The position is held by another device's claim: an invariant violation (positions come from a frozen, sorted set).
  report(new Error('fleet claim position collision'), args, deviceId, 'positionCollision');
  return result(deviceId, 'failed', { error: ROW_MISMATCH });
}

async function dispatchOne(args: FleetDispatchArgs, index: number): Promise<FleetDeviceResult | { stop: RunFence }> {
  const deviceId = args.deviceIds[index]!;
  let staged: Staged;
  try {
    staged = await stage(args, index);
  } catch (err) {
    // A concurrent attempt committed this device's claim first: replay it.
    if (isPgUniqueViolation(err)) return replayAfterCollision(args, deviceId);
    // The transaction rolled back: no claim, no dispatch rows. The device is
    // reported failed (a fixed message — driver text can carry parameters);
    // a later attempt (a redelivered release) may claim it.
    report(err, args, deviceId, 'stage');
    return result(deviceId, 'failed', { error: UNEXPECTED });
  }
  if (staged.kind === 'stop') return { stop: staged.fence };
  if (staged.kind === 'done') return staged.result;
  return deliver(args, deviceId, staged.rowId, staged.dispatch);
}

export async function dispatchScriptToDevices(args: FleetDispatchArgs): Promise<FleetDispatchResult> {
  const concurrency = Math.max(1, args.concurrency ?? 5);
  const reached: Array<FleetDeviceResult | undefined> = new Array(args.deviceIds.length);
  let stopped: RunFence | null = null;
  for (let start = 0; start < args.deviceIds.length && !stopped; start += concurrency) {
    const batch: number[] = [];
    for (let i = start; i < Math.min(start + concurrency, args.deviceIds.length); i++) batch.push(i);
    await Promise.all(batch.map(async (i) => {
      if (stopped) return;
      const r = await dispatchOne(args, i);
      if ('stop' in r) {
        stopped ??= r.stop;
        return;
      }
      reached[i] = r;
    }));
  }
  return { perDevice: reached.filter((r): r is FleetDeviceResult => r !== undefined), stopped };
}
