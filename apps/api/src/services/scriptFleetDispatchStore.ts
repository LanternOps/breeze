/**
 * Tool Catalog W06 (#5221) Task A5 — the DB half of the flow lane of fleet
 * script dispatch (scriptFleetDispatch.ts). Every function runs in the flow
 * principal's run-org context: `inRunOrgTransaction` opens it, and the
 * per-device helpers run inside it, so RLS bounds every read and write to the
 * run org on top of the explicit org predicates.
 *
 * Per-device rows are `flow_run_steps` rows of the fleet step with
 * `item_index` = the device's position in the sorted checked set and
 * `attempt` = 1 (the W05 unique key makes the claim). They are written in
 * their final state inside the dispatch transaction, so a `running` device
 * row is never visible to the runner's stalled-row rule.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FlowStepErrorCode, FlowValue } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { deviceCommands, devices, flowRuns, flowRunSteps, scriptExecutions } from '../db/schema';
import { flowDbAccessContext } from './flows/flowAuthContext';

export interface FleetRun {
  id: string;
  orgId: string;
  partnerId: string;
}

export type RunFence = 'cancelled' | 'lease_lost';

export type FleetLockedDevice = Pick<
  typeof devices.$inferSelect,
  'id' | 'orgId' | 'osType' | 'status' | 'agentId' | 'hostname' | 'siteId' | 'customFields'
>;

export interface DeviceStepRow {
  id: string;
  status: string;
  renderedInput: unknown;
  output: unknown;
}

export function inRunOrgTransaction<T>(run: Pick<FleetRun, 'orgId' | 'partnerId'>, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(flowDbAccessContext(run.orgId, run.partnerId), fn));
}

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'expired']);

/** Null when dispatch may go on: the run is live, not cancel-requested, and (runner path) still holds this lease. */
export async function readRunFence(runId: string, leaseToken: string | null): Promise<RunFence | null> {
  const [run] = await db
    .select({ status: flowRuns.status, cancelRequestedAt: flowRuns.cancelRequestedAt, leaseToken: flowRuns.leaseToken })
    .from(flowRuns)
    .where(eq(flowRuns.id, runId))
    .limit(1)
    .for('share');
  if (!run || run.cancelRequestedAt || TERMINAL_RUN.has(run.status)) return 'cancelled';
  if (leaseToken !== null && run.leaseToken !== leaseToken) return 'lease_lost';
  return null;
}

/**
 * The device's claim row on this step, found by DEVICE (not position), so a
 * re-resolved set whose positions shifted can never dispatch a device twice.
 */
export async function findDeviceStepRow(runId: string, stepId: string, deviceId: string): Promise<DeviceStepRow | null> {
  const [row] = await db
    .select({ id: flowRunSteps.id, status: flowRunSteps.status, renderedInput: flowRunSteps.renderedInput, output: flowRunSteps.output })
    .from(flowRunSteps)
    .where(and(
      eq(flowRunSteps.runId, runId),
      eq(flowRunSteps.stepId, stepId),
      isNotNull(flowRunSteps.itemIndex),
      eq(flowRunSteps.attempt, 1),
      sql`${flowRunSteps.renderedInput}->>'deviceId' = ${deviceId}`,
    ))
    .limit(1);
  return row ?? null;
}

/** A dispatched command's delivery status (`pending` = still queued for the agent). Null when the row is gone. */
export async function readCommandStatus(run: FleetRun, commandId: string): Promise<string | null> {
  const [row] = await inRunOrgTransaction(run, () => db
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1));
  return row ? String(row.status) : null;
}

/** The device, locked, when it is in the run org; null otherwise (moved, deleted or foreign). */
export async function lockRunOrgDevice(orgId: string, deviceId: string): Promise<FleetLockedDevice | null> {
  const [row] = await db
    .select({
      id: devices.id, orgId: devices.orgId, osType: devices.osType, status: devices.status, agentId: devices.agentId,
      hostname: devices.hostname, siteId: devices.siteId, customFields: devices.customFields,
    })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** The device's claim: its step row, inserted before the dispatch in the same transaction. */
export async function insertDeviceStepRow(i: {
  runId: string;
  orgId: string;
  stepId: string;
  itemIndex: number;
  deviceId: string;
  scriptId: string;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(flowRunSteps).values({
    id,
    runId: i.runId,
    orgId: i.orgId,
    stepId: i.stepId,
    itemIndex: i.itemIndex,
    attempt: 1,
    tool: 'run_script_on_targets',
    toolSource: 'builtin',
    tier: 3,
    status: 'running',
    approvalMode: 'none',
    renderedInput: { deviceId: i.deviceId, scriptId: i.scriptId },
  });
  return id;
}

export interface DeviceStepRowFinish {
  status: 'completed' | 'skipped' | 'failed';
  output: FlowValue;
  errorCode?: FlowStepErrorCode;
  error?: string;
}

/**
 * Close a device row. Inside the dispatch transaction pass `run: null` (the
 * ambient context); after commit (a claim-time refusal at delivery) pass the
 * run so the write opens its own run-org context.
 */
export async function finishDeviceStepRow(rowId: string, values: DeviceStepRowFinish, run: FleetRun | null): Promise<void> {
  const write = () => db
    .update(flowRunSteps)
    .set({
      status: values.status,
      output: values.output,
      errorCode: values.errorCode ?? null,
      error: values.error ? values.error.slice(0, 500) : null,
      finishedAt: new Date(),
    })
    .where(eq(flowRunSteps.id, rowId));
  if (run) await inRunOrgTransaction(run, write);
  else await write();
}

/** Undelivered-but-queued: the legacy `queued` bookkeeping on the execution row (pending → queued only). */
export async function markExecutionQueued(run: FleetRun, executionId: string): Promise<void> {
  await inRunOrgTransaction(run, () => db
    .update(scriptExecutions)
    .set({ status: 'queued' })
    .where(and(eq(scriptExecutions.id, executionId), eq(scriptExecutions.status, 'pending'))));
}
