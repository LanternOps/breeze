/**
 * The ONE writer of a per-device patch outcome (#5128 §F.2, W3).
 *
 * Before this module a patch device could only finish one way: the per-device
 * BullMQ task polled `device_commands` for up to 30 minutes and then wrote the
 * rows itself (`recordDeviceExecution`). Offline devices never got that far —
 * they were recorded `skipped` and the job finished green.
 *
 * With the offline queue an `install_patches` command can now finish LONG after
 * its BullMQ task has exited, through four different doors:
 *
 *   - the agent's result, days later, via `commandResultHandlers`;
 *   - delivery expiry / execution timeout, via the stale-command reaper;
 *   - a cancel (user, org move, decommission, claim-time ineligibility);
 *   - supersession by the next scheduled occurrence of the same policy.
 *
 * Every one of those has to write the same `patch_job_results` rows and move the
 * same `patch_jobs` counters, so they all come through here. The synchronous
 * path (`recordDeviceExecution`) is just the `kind: 'result'` caller that
 * happens to already know the job context.
 *
 * IDEMPOTENCY IS THE POINT. The rows for `(jobId, deviceId)` are the key: the
 * finalizer applies only while at least one of them is non-terminal (or there
 * are none yet, the synchronous first-write case). A second arrival — a late
 * agent result racing the reaper, a cancel racing a result — returns
 * `{ applied: false }` and touches no counter. Never move a `patch_jobs`
 * counter outside this module.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { patchJobResults, patchJobs, patches, deviceCommands } from '../db/schema';
import { evaluateRebootPolicy, executeReboot } from './patchRebootHandler';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { registerTypeHold } from './commandClaimEligibility';
import { captureException } from './sentry';
import type { CommandResultHandler } from './commandResultHandlers';

/**
 * Anything that can run the finalizer's statements: the ambient `db`, or a
 * caller's open transaction handle (the cancel-on-event sweeps terminalise the
 * owning records inside the transaction that cancels the command).
 */
export type PatchFinalizerExecutor = Pick<typeof db, 'select' | 'update' | 'insert'>;

/**
 * Non-terminal `patch_job_results` states. `queued` joins `pending`/`running`
 * here: it is waiting on the DELIVERY clock (the `device_commands` reaper via
 * `deliver_by`) rather than on an agent that already has the work, but it is
 * every bit as unfinished.
 */
const NON_TERMINAL_RESULT_STATUSES = ['pending', 'running', 'queued'] as const;
type NonTerminalResultStatus = (typeof NON_TERMINAL_RESULT_STATUSES)[number];

function isNonTerminal(status: string): status is NonTerminalResultStatus {
  return (NON_TERMINAL_RESULT_STATUSES as readonly string[]).includes(status);
}

/** The nil UUID `markDeviceSkipped` uses for a whole-device summary row. */
export const PATCH_SUMMARY_PATCH_ID = '00000000-0000-0000-0000-000000000000';

/** The agent's install summary, normalised across both result transports. */
export type PatchCommandOutcome = {
  status: string;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
};

export type PatchDeviceTerminal =
  /** The agent answered. `commandResult: null` = the command never came back. */
  | { kind: 'result'; commandResult: PatchCommandOutcome | null }
  /** Delivery deadline passed undelivered, or the execution clock ran out. */
  | { kind: 'expired' | 'timeout'; message: string }
  /** User cancel, org move, decommission, claim-time ineligibility. */
  | { kind: 'cancelled'; reason: string }
  /** The next occurrence of the same policy created a fresh job for this device. */
  | { kind: 'superseded'; byJobId: string };

export type ApprovedPatchRef = {
  patchId: string;
  externalId: string | null;
  requiresReboot: boolean;
};

/**
 * What the finalizer needs beyond the rows themselves. The synchronous executor
 * already holds all of it, so it passes it in rather than re-reading the job;
 * every deferred path omits it and the finalizer loads it.
 */
export type PatchDeviceContext = {
  orgId: string;
  rebootPolicy: string;
  approvedPatches: readonly ApprovedPatchRef[];
};

export const SUPERSEDED_ERROR_MESSAGE = 'superseded_by_next_occurrence';

// ---------------------------------------------------------------------------
// Claim-time hold: never deliver an install inside a suppression window
// ---------------------------------------------------------------------------

/**
 * #5128 §E predicate 3. Breeze maintenance windows are SUPPRESSION windows, and
 * the scheduler already refuses to target a device inside one — but a queued
 * install can reconnect at any hour, including inside a window opened after it
 * was enqueued. The hold leaves the row `pending` and re-evaluates on the next
 * heartbeat; it never cancels, because the window will close.
 */
export async function installPatchesClaimHold(deviceId: string): Promise<boolean> {
  const maintenance = await checkDeviceMaintenanceWindow(deviceId);
  return maintenance.active && maintenance.suppressPatching;
}

// Registered at module load. `commandResultHandlers` imports this module, and
// `agentWs` imports that, so the hold is installed at boot on every process
// that can serve a heartbeat claim.
registerTypeHold('install_patches', installPatchesClaimHold);

// ---------------------------------------------------------------------------
// Result parsing (moved from patchJobExecutor.recordDeviceExecution)
// ---------------------------------------------------------------------------

type ParsedAgentSummary = {
  success?: boolean;
  results?: Array<{
    /** The agent's own patch reference, keyed off `patches.id` server-side —
     *  NOT `patchId`, which the agent never sends. Kept as a fallback. */
    id?: string;
    patchId?: string;
    externalId?: string;
    success?: boolean;
    /** Agent's per-patch outcome: 'installed' | 'failed' | 'rolled_back'. */
    status?: string;
    error?: string;
    rebootRequired?: boolean;
  }>;
  rebootRequired?: boolean;
  installedCount?: number;
  failedCount?: number;
};

/**
 * Shared per-patch success predicate (#4267, factoring the #4228 gate and the
 * `patch_job_results` row status onto one rule).
 *
 * The Windows agent's `results[]` entries (`patchCommandResultFields` in
 * `agent/internal/heartbeat/heartbeat.go`) carry a
 * `status: 'installed' | 'failed' | 'rolled_back'` field and never emit a
 * boolean `success` — so keying off `entry.success` alone leaves it permanently
 * `undefined` and the caller's `fallback` (the *batch's* overall status) wins
 * for every patch. One failed patch in a 13-patch batch then reads as 13
 * failures.
 */
export function isPatchResultSuccessful(
  entry: { success?: boolean; status?: string } | undefined,
  fallback: boolean,
): boolean {
  if (entry === undefined) return fallback;
  if (typeof entry.success === 'boolean') return entry.success;
  if (entry.status) return entry.status === 'installed' || entry.status === 'rolled_back';
  return fallback;
}

// ---------------------------------------------------------------------------
// The finalizer
// ---------------------------------------------------------------------------

type ExistingResultRow = {
  id: string;
  patchId: string;
  status: string;
  rebootRequired: boolean;
};

type RowWrite = {
  patchId: string;
  status: 'completed' | 'failed' | 'skipped';
  exitCode: number | null;
  output: string | null;
  errorMessage: string | null;
  rebootRequired: boolean;
};

export async function finalizePatchJobDevice(input: {
  patchJobId: string;
  deviceId: string;
  commandId: string;
  terminal: PatchDeviceTerminal;
  completedAt: Date;
  context?: PatchDeviceContext;
  executor?: PatchFinalizerExecutor;
}): Promise<{ applied: boolean }> {
  const { patchJobId, deviceId, terminal, completedAt } = input;
  const executor: PatchFinalizerExecutor = input.executor ?? db;

  const existing: ExistingResultRow[] = await executor
    .select({
      id: patchJobResults.id,
      patchId: patchJobResults.patchId,
      status: patchJobResults.status,
      rebootRequired: patchJobResults.rebootRequired,
    })
    .from(patchJobResults)
    .where(and(eq(patchJobResults.jobId, patchJobId), eq(patchJobResults.deviceId, deviceId)));

  const active = existing.filter((row) => isNonTerminal(row.status));

  // The double-write fence. Rows exist and every one of them is already
  // terminal ⇒ some other door closed this device first. Return without
  // touching a counter — a second decrement is how `devices_pending` goes
  // negative and the job never finalises.
  if (existing.length > 0 && active.length === 0) {
    return { applied: false };
  }

  // THE DEFERRED DOORS ONLY OWN A DEVICE THAT WAS QUEUED.
  //
  // A caller that supplies `context` is the synchronous executor: it holds the
  // approved set, it is the one that writes the device's rows for the first
  // time, and zero existing rows is its normal state. Every other caller (agent
  // result, delivery expiry, cancel, supersession) reaches this function with a
  // command id and nothing else, and can only rebuild the approved set from the
  // `queued` rows the executor wrote when it deferred the install.
  //
  // With no rows AND no context there is nothing to close — and applying anyway
  // is actively wrong: an ONLINE device's install still belongs to the running
  // `pollForPatchCommandResult` task, so counting it here would move
  // `devices_pending` a second time when that poll records the same result.
  if (!input.context && active.length === 0) {
    return { applied: false };
  }

  // Which counter this device is leaving. A `queued` row was moved out of
  // `devices_pending` into `devices_queued` when it was enqueued, so it must
  // come back out of `devices_queued`.
  const wasQueued = active.some((row) => row.status === 'queued');

  const context = input.context ?? (await loadDeviceContext(executor, patchJobId, active, terminal));
  if (!context) {
    // No job row: the job was hard-deleted under us. Nothing to count.
    return { applied: false };
  }

  const writes = buildRowWrites(terminal, context, active);

  await applyRowWrites(executor, patchJobId, deviceId, active, writes.rows, completedAt);

  // Reboot evaluation is a property of what actually INSTALLED, so it only runs
  // when the agent actually reported (#4228). An expired / cancelled /
  // superseded device installed nothing.
  if (terminal.kind === 'result') {
    await evaluateRebootForResult({
      patchJobId,
      deviceId,
      orgId: context.orgId,
      rebootPolicy: context.rebootPolicy,
      approvedPatches: context.approvedPatches,
      parsed: writes.parsed,
      overallSuccess: writes.countsAsCompleted,
      resultUnparsable: writes.resultUnparsable,
    });
  }

  await executor
    .update(patchJobs)
    .set({
      ...(writes.countsAsCompleted
        ? { devicesCompleted: sql`${patchJobs.devicesCompleted} + 1` }
        : { devicesFailed: sql`${patchJobs.devicesFailed} + 1` }),
      ...(wasQueued
        ? { devicesQueued: sql`${patchJobs.devicesQueued} - 1` }
        : { devicesPending: sql`${patchJobs.devicesPending} - 1` }),
    })
    .where(eq(patchJobs.id, patchJobId));

  await checkAndFinalizeJob(patchJobId, executor);

  return { applied: true };
}

/**
 * Loads the job context for a DEFERRED terminal, where the caller has only the
 * command. The approved set comes from the rows the executor wrote when it
 * queued the install — re-resolving approvals days later could return a
 * different set than the one the device was actually handed.
 */
async function loadDeviceContext(
  executor: PatchFinalizerExecutor,
  patchJobId: string,
  active: ExistingResultRow[],
  terminal: PatchDeviceTerminal,
): Promise<PatchDeviceContext | null> {
  const [job] = await executor
    .select({ orgId: patchJobs.orgId, targets: patchJobs.targets })
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);
  if (!job) return null;

  const rebootPolicy =
    (job.targets as { deployment?: { rebootPolicy?: string } } | null)?.deployment?.rebootPolicy ??
    'if_required';

  const patchIds = active.map((row) => row.patchId).filter((id) => id !== PATCH_SUMMARY_PATCH_ID);

  // externalId is only needed to match the agent's per-patch entries, so the
  // join is skipped entirely for the terminals that carry no agent payload.
  let externalIds = new Map<string, string | null>();
  if (terminal.kind === 'result' && patchIds.length > 0) {
    const rows = await executor
      .select({ id: patches.id, externalId: patches.externalId })
      .from(patches)
      .where(inArray(patches.id, patchIds));
    externalIds = new Map(rows.map((r) => [r.id, r.externalId ?? null]));
  }

  return {
    orgId: job.orgId,
    rebootPolicy,
    approvedPatches: active
      .filter((row) => row.patchId !== PATCH_SUMMARY_PATCH_ID)
      .map((row) => ({
        patchId: row.patchId,
        externalId: externalIds.get(row.patchId) ?? null,
        requiresReboot: row.rebootRequired,
      })),
  };
}

function buildRowWrites(
  terminal: PatchDeviceTerminal,
  context: PatchDeviceContext,
  active: ExistingResultRow[],
): {
  rows: RowWrite[];
  countsAsCompleted: boolean;
  parsed: ParsedAgentSummary | null;
  resultUnparsable: boolean;
} {
  if (terminal.kind !== 'result') {
    // A device that never ran is `failed` when the work was lost to a deadline
    // and `skipped` when a human (or the scheduler) took it away. `skipped`
    // counts toward devicesCompleted, matching markDeviceSkipped.
    const isSkip = terminal.kind === 'cancelled' || terminal.kind === 'superseded';
    const status = isSkip ? ('skipped' as const) : ('failed' as const);
    const errorMessage =
      terminal.kind === 'cancelled'
        ? terminal.reason
        : terminal.kind === 'superseded'
          ? SUPERSEDED_ERROR_MESSAGE
          : terminal.message;

    const targets =
      active.length > 0
        ? active.map((row) => ({ patchId: row.patchId, rebootRequired: row.rebootRequired }))
        : // Nothing recorded yet (the command was still in flight on the
          // synchronous path) — leave the same one-row summary markDeviceSkipped
          // writes, so the device is still accounted for.
          [{ patchId: PATCH_SUMMARY_PATCH_ID, rebootRequired: false }];

    return {
      rows: targets.map((t) => ({
        patchId: t.patchId,
        status,
        exitCode: null,
        output: null,
        errorMessage,
        rebootRequired: t.rebootRequired,
      })),
      countsAsCompleted: isSkip,
      parsed: null,
      resultUnparsable: false,
    };
  }

  const commandResult = terminal.commandResult;

  // A well-formed agent ALWAYS emits the install summary as JSON
  // (`executePatchInstallCommand` marshals it on both the success and the
  // failure return), so unparsable stdout is an anomaly, not a shrug. It is
  // also load-bearing since #4228: the reboot decision is read out of this
  // payload, so a parse failure is the one way a genuine partial success can
  // still look like "nothing installed". It must leave a trail.
  let parsed: ParsedAgentSummary | null = null;
  let resultUnparsable = false;
  if (commandResult?.stdout) {
    try {
      parsed = JSON.parse(commandResult.stdout) as ParsedAgentSummary;
    } catch (err) {
      resultUnparsable = true;
      console.warn(`[PatchJobFinalizer] unparsable patch result stdout: ${String(err)}`);
      captureException(new Error('[PatchJobFinalizer] unparsable patch install result'));
    }
  }

  const overallSuccess =
    commandResult?.status === 'completed' &&
    (parsed?.success ?? true) &&
    (typeof commandResult?.exitCode !== 'number' || commandResult.exitCode === 0);

  const rows: RowWrite[] = context.approvedPatches.map((patch) => {
    // The agent echoes the id back as `id` (mirroring the `patches.id` this job
    // sent it), not `patchId` — matching on `r.patchId` alone would always be
    // undefined and silently degrade to the `externalId` branch (#4267).
    const perPatch = parsed?.results?.find(
      (r) =>
        r.id === patch.patchId ||
        r.patchId === patch.patchId ||
        (patch.externalId !== null && r.externalId === patch.externalId),
    );

    // Per-patch status, not the batch aggregate (#4267): a batch with one
    // failure among twelve successes records twelve `completed` rows and one
    // `failed` row, not thirteen `failed` rows.
    const patchSuccess = isPatchResultSuccessful(perPatch, overallSuccess);

    return {
      patchId: patch.patchId,
      status: !commandResult
        ? ('failed' as const)
        : patchSuccess
          ? ('completed' as const)
          : ('failed' as const),
      exitCode: commandResult?.exitCode ?? null,
      output: perPatch?.error ?? commandResult?.stdout?.substring(0, 2000) ?? null,
      errorMessage: !commandResult
        ? 'Command timed out'
        : !patchSuccess
          ? (perPatch?.error ?? commandResult?.error ?? commandResult?.stderr ?? null)
          : null,
      rebootRequired: perPatch?.rebootRequired ?? patch.requiresReboot,
    };
  });

  // Any leftover non-terminal row whose patch is not in the approved set (a
  // summary row, or a patch dropped from the set) still has to be closed, or
  // the job would never reach zero.
  const covered = new Set(rows.map((r) => r.patchId));
  for (const row of active) {
    if (covered.has(row.patchId)) continue;
    rows.push({
      patchId: row.patchId,
      status: overallSuccess ? 'completed' : 'failed',
      exitCode: commandResult?.exitCode ?? null,
      output: null,
      errorMessage: overallSuccess ? null : (commandResult?.error ?? 'Command timed out'),
      rebootRequired: row.rebootRequired,
    });
  }

  return { rows, countsAsCompleted: overallSuccess, parsed, resultUnparsable };
}

/**
 * Writes each per-patch outcome, updating the row the queue path already wrote
 * when there is one and inserting otherwise. The UPDATE is fenced on the row
 * still being non-terminal so two racing finalisers cannot both write it.
 */
async function applyRowWrites(
  executor: PatchFinalizerExecutor,
  patchJobId: string,
  deviceId: string,
  active: ExistingResultRow[],
  rows: RowWrite[],
  completedAt: Date,
): Promise<void> {
  const byPatchId = new Map(active.map((row) => [row.patchId, row]));

  for (const write of rows) {
    const existingRow = byPatchId.get(write.patchId);
    if (existingRow) {
      await executor
        .update(patchJobResults)
        .set({
          status: write.status,
          completedAt,
          exitCode: write.exitCode,
          output: write.output,
          errorMessage: write.errorMessage,
          rebootRequired: write.rebootRequired,
        })
        .where(
          and(
            eq(patchJobResults.id, existingRow.id),
            inArray(patchJobResults.status, [...NON_TERMINAL_RESULT_STATUSES]),
          ),
        );
      continue;
    }

    await executor.insert(patchJobResults).values({
      jobId: patchJobId,
      deviceId,
      patchId: write.patchId,
      status: write.status,
      startedAt: new Date(),
      completedAt,
      exitCode: write.exitCode,
      output: write.output,
      errorMessage: write.errorMessage,
      rebootRequired: write.rebootRequired,
    });
  }
}

async function evaluateRebootForResult(params: {
  patchJobId: string;
  deviceId: string;
  orgId: string;
  rebootPolicy: string;
  approvedPatches: readonly ApprovedPatchRef[];
  parsed: ParsedAgentSummary | null;
  overallSuccess: boolean;
  resultUnparsable: boolean;
}): Promise<void> {
  const { patchJobId, deviceId, orgId, rebootPolicy, approvedPatches, parsed, overallSuccess } =
    params;

  // Did the run actually change anything on the device? Deliberately NOT
  // `overallSuccess`: the agent returns Status "failed" / exit 1 the moment ONE
  // patch in the batch fails, while the other twelve are installed and pending a
  // reboot (#4228).
  const installedCount = parsed?.installedCount;
  const anyPatchInstalled =
    (typeof installedCount === 'number' && installedCount > 0) ||
    (parsed?.results?.some((r) => isPatchResultSuccessful(r, false)) ?? false);

  // The agent ORs `rebootRequired` across every SUCCESSFUL install, so a partial
  // failure still carries an accurate value — use it verbatim, including a
  // reported `false`. The fallback only covers a result we could not parse at
  // all: reading the static flags off the approved set assumes every one of them
  // installed, which is only sound for a success-shaped run.
  const anyRebootRequired =
    parsed?.rebootRequired ??
    (overallSuccess ? approvedPatches.some((p) => p.requiresReboot) : false);

  const rebootLog = `[PatchJobExecutor] job ${patchJobId} device ${deviceId} reboot policy "${rebootPolicy}"`;

  if (!overallSuccess && !anyPatchInstalled) {
    // Say which of the two it is. "No patch installed" is a fact when the agent
    // told us so; when its output was unparsable it is an assumption, and an
    // operator chasing a device that did not reboot needs to tell them apart.
    console.log(
      `${rebootLog}: not evaluated — ${
        params.resultUnparsable
          ? 'result unparsable, cannot confirm any install (see prior warning)'
          : 'no patch installed successfully'
      } (rebootRequired=${anyRebootRequired})`,
    );
    return;
  }

  const rebootEval = await evaluateRebootPolicy(deviceId, rebootPolicy, anyRebootRequired);
  if (!rebootEval.shouldReboot) {
    console.log(
      `${rebootLog}: no reboot — ${rebootEval.reason}${rebootEval.deferred ? ' (deferred)' : ''}`,
    );
    return;
  }

  // No delay passed: executeReboot resolves it from the device's effective patch
  // policy (#3197). It used to default to 5 minutes, which reached none of the
  // agent's warning thresholds, so the user got no notice.
  const rebootResult = await executeReboot(deviceId, rebootEval.reason, {
    expectedOrgId: orgId,
    // #3207: a reboot fired inside a maintenance window may not be postponed
    // past the close of that window. Null for every other policy.
    windowEndsAt: rebootEval.windowEndsAt,
  });
  const partialSuffix = overallSuccess
    ? ''
    : ' (job partially failed; successfully installed patches still require a reboot)';
  if (!rebootResult.success) {
    // captureException, not just a console line: a failure here leaves the
    // device patched but never restarted while the job still records success.
    console.warn(
      `[PatchJobExecutor] reboot dispatch failed for device ${deviceId}: ${rebootResult.error}`,
    );
    captureException(
      new Error(
        `[PatchJobExecutor] reboot dispatch failed for device ${deviceId}: ${rebootResult.error}`,
      ),
    );
    return;
  }
  console.log(
    `${rebootLog}: scheduled reboot in ${rebootResult.delayMinutes}m — ${rebootEval.reason}${partialSuffix}`,
  );
}

/**
 * Terminalises the job once nothing is outstanding.
 *
 * #5128 W3: `devices_queued` joins `devices_pending` in the guard. A job with a
 * device still waiting to reconnect is NOT finished, and calling it `completed`
 * would report unfinished patching as done (OD-9). Lives here rather than in
 * `patchJobExecutor` so the deferred paths can reach it without importing the
 * BullMQ workers.
 */
export async function checkAndFinalizeJob(
  patchJobId: string,
  executor: PatchFinalizerExecutor = db,
): Promise<void> {
  const [job] = await executor
    .select({
      status: patchJobs.status,
      devicesPending: patchJobs.devicesPending,
      devicesQueued: patchJobs.devicesQueued,
      devicesFailed: patchJobs.devicesFailed,
    })
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!job || job.status !== 'running') return;
  if (job.devicesPending > 0) return;
  if ((job.devicesQueued ?? 0) > 0) return;

  const finalStatus = job.devicesFailed > 0 ? 'failed' : 'completed';
  await executor
    .update(patchJobs)
    .set({ status: finalStatus, completedAt: new Date() })
    .where(and(eq(patchJobs.id, patchJobId), eq(patchJobs.status, 'running')));
}

// ---------------------------------------------------------------------------
// Entry points for the deferred doors
// ---------------------------------------------------------------------------

/** Reads a `patchJobId` out of an arbitrary command payload, or null. */
export function patchJobIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).patchJobId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Finalise the patch device that owns `commandId`.
 *
 * The reaper and the cancel propagator hold a command, not a device: neither
 * `propagateTimedOutDeviceCommand` nor `propagateCancelledDeviceCommand` is
 * given a device id, and the `install_patches` payload does not carry one
 * either (it is addressed BY the row). So the device is read back off the
 * command row — a primary-key lookup, and only for commands that actually carry
 * a `patchJobId`.
 */
export async function finalizePatchDeviceForCommand(params: {
  commandId: string;
  payload: unknown;
  terminal: PatchDeviceTerminal;
  completedAt: Date;
  executor?: PatchFinalizerExecutor;
}): Promise<{ applied: boolean }> {
  const patchJobId = patchJobIdFromPayload(params.payload);
  if (!patchJobId) return { applied: false };

  const executor: PatchFinalizerExecutor = params.executor ?? db;
  const [row] = await executor
    .select({ deviceId: deviceCommands.deviceId })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, params.commandId))
    .limit(1);
  if (!row?.deviceId) return { applied: false };

  return finalizePatchJobDevice({
    patchJobId,
    deviceId: row.deviceId,
    commandId: params.commandId,
    terminal: params.terminal,
    completedAt: params.completedAt,
    executor,
  });
}

/**
 * `install_patches` result handler for BOTH agent transports. Registered in
 * `commandResultHandlers`, so a result that arrives days after the per-device
 * BullMQ task exited still closes the device out.
 */
export const handleInstallPatchesResult: CommandResultHandler = async ({
  command,
  commandId,
  result,
  resolvedDeviceId,
  stdout,
}) => {
  const patchJobId = patchJobIdFromPayload(command.payload);
  if (!patchJobId) {
    // Pre-W3 commands were enqueued without a patchJobId; the synchronous
    // executor poll is still their owner, so there is nothing to do here.
    return;
  }

  await finalizePatchJobDevice({
    patchJobId,
    deviceId: resolvedDeviceId,
    commandId,
    terminal: {
      kind: 'result',
      commandResult: {
        status: result.status,
        exitCode: result.exitCode ?? null,
        stdout: stdout ?? result.stdout ?? null,
        stderr: result.stderr ?? null,
        error: result.error ?? null,
      },
    },
    completedAt: new Date(),
  });
};
