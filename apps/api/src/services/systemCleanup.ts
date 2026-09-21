/**
 * Server-side contract for the OS-native cleanup engine (Disk Cleanup v2 §5.3).
 *
 * Two jobs, both about not trusting things:
 *   1. the agent-version gate, which fails CLOSED, and
 *   2. Zod shapes for the two agent payloads, so nothing the agent sends
 *      reaches the UI (and therefore a subsequent run request) unvalidated.
 */

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, type DbAccessContext } from '../db';
import { devices, deviceCommands, deviceFilesystemCleanupRuns } from '../db/schema';
import { queueCommandForExecutionWithSystemPrecheck, CommandTypes } from './commandQueue';
import { SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from './commandTimeouts';
import { SYSTEM_CLEANUP_ACTION_IDS, SYSTEM_CLEANUP_RISK_FLAGS, systemCleanupRunBodySchema, systemCleanupRunBudgetMs } from '@breeze/shared/validators';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';
import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
import type { AiOriginRef } from '@breeze/shared';

/**
 * The agent release that introduced system_cleanup_list / system_cleanup_run.
 *
 * Newest tag on the branch this wave was planned from is v0.114.0 (verified
 * 2026-09-19), so W04 ships in the next minor. If a release lands before this
 * merges, bump it here in the same PR — the pin in systemCleanup.test.ts is
 * its only other mention.
 */
export const MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0';

/** Machine token both system-cleanup routes answer a stale agent with. */
export const AGENT_UPDATE_REQUIRED_ERROR = 'agent_update_required';

/** The agent's fallback for a command type it has no handler for. */
export const UNKNOWN_COMMAND_TYPE_PREFIX = 'unknown command type:';

/**
 * Does this device's agent understand the two command types?
 *
 * Fails CLOSED on anything unparseable. That is not defensive padding:
 * `compareAgentVersions` returns 0 when either side fails to parse, so the
 * obvious `compareAgentVersions(device.agentVersion, MIN) >= 0` lets '' and
 * 'dev' through as "equal to the minimum" — and `devices.agent_version` is
 * `varchar(50) NOT NULL`, so '' is a real value.
 *
 * Only the CORE is compared (spec §5.3's "core semver"): `0.115.0-rc1` is the
 * lab build W05 runs the acceptance gate on, and a prerelease-aware comparison
 * would rank it below `0.115.0` and gate the gate out.
 */
export function agentSupportsSystemCleanup(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const core = agentVersion.trim().split('-', 1)[0] ?? '';
  if (!parseComparableVersion(core)) return false;
  return compareAgentVersions(core, MIN_AGENT_VERSION_SYSTEM_CLEANUP) >= 0;
}

/**
 * Defensive half of the 409 (spec §5.3). A device can report a new-enough
 * version and still lack the handler — a hand-built binary, an update that
 * reported success and rolled back. Matching the agent's own fallback string
 * turns "the command failed for an unreadable reason" into "update the agent",
 * which is the only action that helps.
 *
 * Prefix-anchored on the TRIMMED string: the phrase appearing mid-message in
 * some other error is not this condition.
 */
export function isUnknownCommandTypeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.trimStart().startsWith(UNKNOWN_COMMAND_TYPE_PREFIX);
}

/** Shared 409-or-go decision for routes and the AI lane. */
export function systemCleanupAgentGate(device: { agentVersion: string | null }):
  | { ok: true }
  | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string } {
  if (agentSupportsSystemCleanup(device.agentVersion)) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: AGENT_UPDATE_REQUIRED_ERROR,
    minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  };
}

const actionIdSchema = z.enum(SYSTEM_CLEANUP_ACTION_IDS);
const riskFlagSchema = z.enum(SYSTEM_CLEANUP_RISK_FLAGS);

const subActionSchema = z.object({
  riskFlags: z.array(riskFlagSchema).max(SYSTEM_CLEANUP_RISK_FLAGS.length).default([]),
  id: actionIdSchema,
  label: z.string().max(200),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
});

const catalogActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().max(200),
  description: z.string().max(1000),
  os: z.enum(['windows', 'darwin', 'linux']),
  subActions: z.array(subActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
  available: z.boolean(),
  unavailableReason: z.string().max(500).optional(),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
  estimateDetail: z.string().max(500).optional(),
  riskFlags: z.array(riskFlagSchema).max(SYSTEM_CLEANUP_RISK_FLAGS.length),
  affectsVolumes: z.array(z.string().max(500)).max(64),
});

/** system_cleanup_list's result (spec §7.3). */
export const systemCleanupCatalogSchema = z.object({
  catalogVersion: z.number().int().min(1),
  actions: z.array(catalogActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumesBefore: z.array(z.object({
    mount: z.string().max(500),
    freeBytes: z.number().int().min(0),
  })).max(64),
});

export type SystemCleanupCatalog = z.infer<typeof systemCleanupCatalogSchema>;

/** system_cleanup_run's result (spec §7.3). */
export const systemCleanupRunResultSchema = z.object({
  runId: z.string().max(64),
  actions: z.array(z.object({
    id: actionIdSchema,
    subActions: z.array(z.object({
      id: actionIdSchema,
      status: z.enum(['completed', 'failed', 'timed_out', 'unavailable', 'busy', 'not_started']),
    })).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
    status: z.enum(['completed', 'failed', 'timed_out', 'unavailable', 'busy', 'not_started']),
    exitCode: z.number().int(),
    durationMs: z.number().int().min(0).optional(),
    outputTail: z.string().max(64_000).optional(),
    error: z.string().max(4_000).optional(),
  })).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumes: z.array(z.object({
    mount: z.string().max(500),
    freeBefore: z.number().int().min(0),
    freeAfter: z.number().int().min(0),
  })).max(64),
  freedBytes: z.number().int().min(0),
});

export type SystemCleanupRunResult = z.infer<typeof systemCleanupRunResultSchema>;

/**
 * Parse an agent stdout payload, or null.
 *
 * NULL, not an empty object. The W01 lesson (spec defect 5) is that a blank
 * record written on unparseable output becomes the "latest" answer and zeroes
 * everything downstream; here it would present an empty catalogue as "this
 * device has no cleanup actions", which is indistinguishable from the truth
 * and wrong.
 */
export function parseAgentJson<T>(schema: z.ZodType<T>, stdout: string | null | undefined): T | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}


export interface QueueSystemCleanupListArgs {
  device: { id: string; orgId: string; agentVersion: string | null; status: string };
  requestedBy: string | null;
  /**
   * #5022 W01 — who DECIDED this command, when an AI surface did. Absent on
   * the human route path; REQUIRED on the AI path, where
   * `requireAiOrigin(auth, 'system_cleanup')` throws rather than letting an
   * unattributed device command through. This module sits outside
   * `aiDispatch.contract.test.ts`'s AI_FILE scan, so nothing else enforces it.
   */
  aiOrigin?: AiOriginRef;
}
export interface StartSystemCleanupRunArgs extends QueueSystemCleanupListArgs {
  actionIds: string[];
  params?: { journalVacuumBytes?: number };
}
export type SystemCleanupQueueResult =
  | { ok: true; commandId: string }
  | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string }
  | { ok: false; status: 400 | 503; error: string };
export type SystemCleanupStartResult =
  | { ok: true; commandId: string; cleanupRunId: string; deadlineAt: string }
  | Exclude<SystemCleanupQueueResult, { ok: true }>
  | { ok: false; status: 409; error: 'run_in_progress'; cleanupRunId: string };

async function queueSystemCleanupListOutsideContext(
  args: QueueSystemCleanupListArgs,
): Promise<SystemCleanupQueueResult> {
  // Gate BEFORE queuing: a stale agent must never receive a command it can
  // only answer with a bare failure the UI cannot explain.
  const gate = systemCleanupAgentGate(args.device);
  if (!gate.ok) return gate;

  const queued = await queueCommandForExecutionWithSystemPrecheck(
    args.device.id,
    CommandTypes.SYSTEM_CLEANUP_LIST,
    {},
    {
      userId: args.requestedBy ?? undefined,
      expectedOrgId: args.device.orgId,
      ...(args.aiOrigin ? { aiOrigin: args.aiOrigin } : {}),
    },
  );
  if (!queued.command) {
    return { ok: false, status: 503, error: queued.error || 'Failed to queue the cleanup catalog request' };
  }
  return { ok: true, commandId: queued.command.id };
}

async function startSystemCleanupRunOutsideContext(
  args: StartSystemCleanupRunArgs,
): Promise<SystemCleanupStartResult> {
  const gate = systemCleanupAgentGate(args.device);
  if (!gate.ok) return gate;

  const selection = systemCleanupRunBodySchema.safeParse({ actionIds: args.actionIds, params: args.params });
  if (!selection.success) return { ok: false, status: 400, error: 'Invalid system cleanup selection' };

  const deadlineAt = new Date(Date.now() + systemCleanupRunBudgetMs(args.actionIds));

  // CLAIM in a short COMMITTED transaction, then dispatch outside it
  // (spec §13 #5). Three things this buys that the ambient request
  // transaction did not:
  //
  //   1. the single-run-per-device rule is actually enforced. Inside the
  //      request transaction the `running` row a concurrent request had just
  //      written was invisible, so two techs clicking Run a second apart both
  //      passed the check and both queued;
  //   2. a crash after the agent started deleting cannot roll the row away —
  //      the claim is committed before anything is dispatched;
  //   3. the WebSocket push in `queueCommandForExecutionWithSystemPrecheck` cannot beat the
  //      commit, so the result handler can never arrive at a row that does
  //      not exist yet.
  //
  // This is why the two POST routes are registered in
  // SELF_MANAGED_DB_CONTEXT_ROUTES: the auth middleware must NOT have an
  // ambient transaction open around any of it.
  const claim = await withDbAccessContext(dbContextFor(args.device), async () =>
    db.transaction(async (tx) => {
      // Single run per device (spec §13 #4): a second run would rewrite the
      // StateFlags5555 profile the first one is executing from. The agent's
      // maintenance lock catches it too, but reporting `run_in_progress`
      // here is the answer a tech can act on; `busy` from the agent arrives
      // minutes later attached to a run row that should not exist.
      // Lock the device even when no run exists; a check alone races.
      const [lockedDevice] = await tx.select({ id: devices.id }).from(devices)
        .where(and(eq(devices.id, args.device.id), eq(devices.orgId, args.device.orgId)))
        .for('update');
      if (!lockedDevice) return { runId: null } as const;

      const [inFlight] = await tx
        .select({ id: deviceFilesystemCleanupRuns.id, plan: deviceFilesystemCleanupRuns.plan })
        .from(deviceFilesystemCleanupRuns)
        .where(and(
          eq(deviceFilesystemCleanupRuns.deviceId, args.device.id),
          eq(deviceFilesystemCleanupRuns.kind, 'system'),
          eq(deviceFilesystemCleanupRuns.status, 'running'),
        ))
        .limit(1);
      if (inFlight) {
        const plan = inFlight.plan as { deadlineAt?: string } | null;
        const expired = plan?.deadlineAt && new Date(plan.deadlineAt).getTime() < Date.now();
        if (!expired) return { conflict: inFlight.id } as const;
        await failSystemCleanupRunInTransaction(tx, {
          runId: inFlight.id, deviceId: args.device.id, orgId: args.device.orgId, error: 'run_expired',
        });
      }

      const [row] = await tx
        .insert(deviceFilesystemCleanupRuns)
        .values({
          deviceId: args.device.id,
          orgId: args.device.orgId,
          requestedBy: args.requestedBy,
          kind: 'system',
          status: 'running',
          plan: {
            actionIds: args.actionIds,
            params: args.params ?? {},
            catalogVersion: null,
            // Stored, not recomputed: the poll route's lazy timeout and any
            // future reaper read THIS number, so neither has to re-derive a
            // budget from a selection it would have to re-parse (§13 #14).
            deadlineAt: deadlineAt.toISOString(),
          },
        })
        .returning({ id: deviceFilesystemCleanupRuns.id });
      return { runId: row?.id ?? null } as const;
    }),
  );

  if (claim.conflict !== undefined) {
    return {
      ok: false,
      status: 409,
      error: 'run_in_progress',
      cleanupRunId: claim.conflict,
    };
  }
  if (!claim.runId) return { ok: false, status: 503, error: 'Failed to record the cleanup run' };
  const runId = claim.runId;

  // Dispatch OUTSIDE any transaction. queueCommandForExecutionWithSystemPrecheck pushes over the
  // websocket, and a push inside a held transaction is both the #1105
  // connection hold and a message the agent can answer before the row commits.
  const queued = await queueCommandForExecutionWithSystemPrecheck(
    args.device.id,
    CommandTypes.SYSTEM_CLEANUP_RUN,
    { runId, actionIds: args.actionIds, params: args.params ?? {} },
    {
      userId: args.requestedBy ?? undefined,
      expectedOrgId: args.device.orgId,
      ...(args.aiOrigin ? { aiOrigin: args.aiOrigin } : {}),
    },
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : 'Failed to queue the cleanup run', command: undefined }));

  // Finalise in a SEPARATE short transaction, either way.
  if (!queued.command) {
    // A `running` row nobody will ever close is worse than no row: the panel
    // would spin until the stored deadline caught it.
    await withDbAccessContext(dbContextFor(args.device), async () =>
      db
        .update(deviceFilesystemCleanupRuns)
        .set({ status: 'failed', error: queued.error || 'Failed to queue the cleanup run', updatedAt: new Date() })
        .where(and(
          eq(deviceFilesystemCleanupRuns.id, runId),
          eq(deviceFilesystemCleanupRuns.status, 'running'),
        )),
    );
    return { ok: false, status: 503, error: queued.error || 'Failed to queue the cleanup run' };
  }

  await withDbAccessContext(dbContextFor(args.device), async () =>
    db
      .update(deviceFilesystemCleanupRuns)
      .set({ commandId: queued.command!.id, updatedAt: new Date() })
      .where(eq(deviceFilesystemCleanupRuns.id, runId)),
  );

  return { ok: true, commandId: queued.command.id, cleanupRunId: runId, deadlineAt: deadlineAt.toISOString() };
}

/**
 * Cancel a run's pending command and mark the run failed, ATOMICALLY
 * (spec §13 #6, #13).
 *
 * The two halves must not be separable. Marking the run failed while its
 * command is still deliverable is the exact hazard the `live_only` TTL class
 * narrows but does not close: the operator is told the run failed, and the
 * device then claims the command and starts deleting. Cancelling the command
 * without failing the run leaves a row spinning forever.
 *
 * Shared by the poll route's lazy timeout and by the org-move cancel branch
 * (Task 12b), so there is one implementation of "this run is over".
 */
type FailSystemCleanupArgs = {
  runId: string;
  deviceId: string;
  orgId: string;
  error: string;
};

export async function failSystemCleanupRunAndCancelCommand(args: FailSystemCleanupArgs): Promise<boolean> {
  return withDbAccessContext(dbContextFor({ orgId: args.orgId }), () =>
    db.transaction((tx) => failSystemCleanupRunInTransaction(tx, args)),
  );
}

async function failSystemCleanupRunInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: FailSystemCleanupArgs,
): Promise<boolean> {
  const [run] = await tx
    .update(deviceFilesystemCleanupRuns)
    .set({ status: 'failed', error: args.error, updatedAt: new Date() })
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, args.runId),
      eq(deviceFilesystemCleanupRuns.deviceId, args.deviceId),
      eq(deviceFilesystemCleanupRuns.orgId, args.orgId),
      eq(deviceFilesystemCleanupRuns.kind, 'system'),
      // CAS: a real result that landed first must win.
      eq(deviceFilesystemCleanupRuns.status, 'running'),
    ))
    .returning({ id: deviceFilesystemCleanupRuns.id, commandId: deviceFilesystemCleanupRuns.commandId });
  if (!run) return false;

  {
    const completedAt = new Date();
    const [cancelled] = await tx
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt,
        result: { status: 'cancelled', reason: 'cleanup_run_finalised' },
        // Terminal writers strip payload secrets in the same statement
        // (terminalPayloadErasure.coverage.test.ts, #3409 PR4a).
        ...terminalPayloadErasureSet(),
      })
      .where(and(
        run.commandId ? eq(deviceCommands.id, run.commandId) : and(
          eq(deviceCommands.type, CommandTypes.SYSTEM_CLEANUP_RUN),
          sql`${deviceCommands.payload}->>'runId' = ${args.runId}`,
        ),
        eq(deviceCommands.deviceId, args.deviceId),
        eq(deviceCommands.status, 'pending'),
      ))
      .returning({ id: deviceCommands.id });
    // Losing this CAS is fine and expected: the agent already claimed it,
    // so a real result is on its way and the late-result branch in the
    // handler records it without flipping the status back.
    void cancelled;
  }
  return true;
}

function dbContextFor(device: { orgId: string }): DbAccessContext {
  return { scope: 'organization', orgId: device.orgId, accessibleOrgIds: [device.orgId] };
}

export function queueSystemCleanupList(args: QueueSystemCleanupListArgs): Promise<SystemCleanupQueueResult> {
  return runOutsideDbContext(() => queueSystemCleanupListOutsideContext(args));
}

export function startSystemCleanupRun(args: StartSystemCleanupRunArgs): Promise<SystemCleanupStartResult> {
  return runOutsideDbContext(() => startSystemCleanupRunOutsideContext(args));
}

/**
 * Wait (bounded) for a system-cleanup command to terminalise.
 *
 * The routes stay async (the web panel polls W04's own
 * `GET /devices/:id/filesystem/system-cleanup/list/:commandId`); the AI
 * `list` action is the one caller that waits, and only briefly — a caller
 * that hits `timeout` re-checks the same command later rather than holding on.
 *
 * Each poll is its own short org-scoped context — never the caller's request
 * transaction (#1105). NOTE that this buys nothing for the lookup itself:
 * `device_commands` is intentionally RLS-free (the agent WS path writes it
 * under system scope), so the org context filters NOTHING here. The only
 * isolation is the WHERE: the command must match by id AND by the device the
 * caller already verified access to AND by the command type it expects. A
 * caller must never pass an unverified deviceId.
 *
 * `result` is the agent's stdout JSON, decoded but NOT schema-validated here:
 * the caller knows whether it asked for a catalog or a run and applies the
 * matching Zod shape. An unreadable payload is a failure, never `{}` — an
 * empty catalog is indistinguishable from the truth (spec defect 5).
 */
export interface AwaitSystemCleanupResultArgs {
  commandId: string;
  /** The device the caller has ALREADY verified access to. */
  deviceId: string;
  orgId: string;
  type: typeof CommandTypes.SYSTEM_CLEANUP_LIST | typeof CommandTypes.SYSTEM_CLEANUP_RUN;
}

export async function awaitSystemCleanupResult(
  args: AwaitSystemCleanupResultArgs,
  timeoutMs: number,
  intervalMs = 5_000,
): Promise<{ status: 'completed' | 'failed' | 'timeout' | 'not_found'; result?: unknown; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  // Poll at least once, so a 0 ms budget still reads the row.
  do {
    const [row] = await runOutsideDbContext(() =>
      withDbAccessContext(dbContextFor({ orgId: args.orgId }), () =>
        db
          .select({ status: deviceCommands.status, result: deviceCommands.result })
          .from(deviceCommands)
          .where(and(
            eq(deviceCommands.id, args.commandId),
            eq(deviceCommands.deviceId, args.deviceId),
            eq(deviceCommands.type, args.type),
          ))
          .limit(1),
      ),
    );
    // The command row is inserted before dispatch returns, so a miss on the
    // first poll is a wrong id/device/type, not a race — answer now rather
    // than spend the whole budget on a row that can never appear.
    if (!row) return { status: 'not_found', error: 'command not found' };
    if (row.status !== 'pending' && row.status !== 'sent' && row.status !== 'running') {
      const payload = (row.result && typeof row.result === 'object' ? row.result : {}) as Record<string, unknown>;
      const error = typeof payload.error === 'string' ? payload.error : undefined;
      // Defensive fallback from spec §5.3: an agent that does not know the
      // command type answers with this exact prefix, which must resolve to the
      // same 409 the version gate produces rather than an opaque failure.
      if (isUnknownCommandTypeError(error)) {
        return { status: 'failed', error: AGENT_UPDATE_REQUIRED_ERROR };
      }
      if (row.status !== 'completed') {
        return { status: 'failed', error: error ?? `command ${row.status}` };
      }
      const result = parseAgentJson(z.unknown(), typeof payload.stdout === 'string' ? payload.stdout : undefined);
      if (result === null || result === undefined) {
        return { status: 'failed', error: 'The agent returned an unreadable cleanup payload' };
      }
      return { status: 'completed', result, error };
    }
    if (Date.now() + intervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return { status: 'timeout', error: 'timed out' };
}

// --- Run status -------------------------------------------------------------

/** The poll projection of a `kind = 'system'` cleanup run. */
export interface SystemCleanupRunStatus {
  cleanupRunId: string;
  commandId: string | null;
  status: 'previewed' | 'executed' | 'failed' | 'running';
  error: string | null;
  freedBytes: number;
  actions: unknown[];
  volumes: unknown[];
  requestedAt: Date;
  /** The per-selection deadline STORED on the row at claim time, or null for a row written before it existed. */
  deadlineAt: string | null;
}

export type SystemCleanupRunStatusResult =
  | { ok: true; run: SystemCleanupRunStatus }
  | { ok: false; status: 404; error: 'run_not_found' }
  | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string };

function readCommandResult(result: unknown): { error?: string; stdout?: string } {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  return {
    error: typeof record.error === 'string' ? record.error : undefined,
    stdout: typeof record.stdout === 'string' ? record.stdout : undefined,
  };
}

/**
 * What state is this system run in? ONE implementation, shared by the human
 * poll route (`GET /devices/:id/filesystem/system-cleanup/run/:cleanupRunId`)
 * and the AI tool's `status` action, so the two lanes cannot drift.
 *
 * Runs in the CALLER's DB context (the route's ambient request transaction,
 * the SDK's per-tool context): two short reads and, at most, one short
 * finalising transaction. `device` must be a device the caller has already
 * verified access to — the run lookup is scoped to it and its org, and the
 * command lookup (RLS-free table) to it and the command type.
 *
 * The persisted status is authoritative: the agent result handler decides
 * `executed` vs `failed` (a run whose every action failed is `failed`), and
 * nothing here re-derives it from the payload.
 *
 * Lazy timeout. Nothing else transitions a `running` system run: the stale
 * command reaper terminalises the COMMAND, not this row, so a device that
 * never answers would otherwise leave the panel — or an AI session — polling
 * indefinitely. The deadline is the one STORED on the row at claim time
 * (spec §13 #14), not a constant and not a recomputation: the budget depends
 * on what was selected, and two places deriving it independently is how they
 * drift. A row written before this field existed falls back to the maximum,
 * which is the conservative direction. Cancelling the command and failing the
 * row are ONE transaction (spec §13 #6/#13): telling the operator a run failed
 * while its command is still deliverable is the hazard the live_only TTL
 * narrows but does not close.
 */
export async function resolveSystemCleanupRunStatus(args: {
  device: { id: string; orgId: string };
  cleanupRunId: string;
}): Promise<SystemCleanupRunStatusResult> {
  const { device, cleanupRunId } = args;
  const [run] = await db
    .select()
    .from(deviceFilesystemCleanupRuns)
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, cleanupRunId),
      eq(deviceFilesystemCleanupRuns.deviceId, device.id),
      eq(deviceFilesystemCleanupRuns.orgId, device.orgId),
      eq(deviceFilesystemCleanupRuns.kind, 'system'),
    ))
    .limit(1);
  if (!run) return { ok: false, status: 404, error: 'run_not_found' };

  const agentUpdateRequired: SystemCleanupRunStatusResult = {
    ok: false, status: 409, error: AGENT_UPDATE_REQUIRED_ERROR, minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  };
  if (isUnknownCommandTypeError(run.error)) return agentUpdateRequired;
  if (run.commandId) {
    const [command] = await db.select().from(deviceCommands).where(and(
      eq(deviceCommands.id, run.commandId), eq(deviceCommands.deviceId, device.id),
      eq(deviceCommands.type, CommandTypes.SYSTEM_CLEANUP_RUN),
    )).limit(1);
    if (isUnknownCommandTypeError(readCommandResult(command?.result).error)) return agentUpdateRequired;
  }

  let status = run.status;
  let error = run.error;

  const plan = (run.plan ?? {}) as { deadlineAt?: unknown };
  const storedDeadline = typeof plan.deadlineAt === 'string' ? plan.deadlineAt : null;
  const deadlineAt = storedDeadline !== null
    ? new Date(storedDeadline).getTime()
    : new Date(run.requestedAt).getTime() + SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS;

  if (status === 'running' && Number.isFinite(deadlineAt) && Date.now() > deadlineAt) {
    const finalised = await failSystemCleanupRunAndCancelCommand({
      runId: run.id, deviceId: device.id, orgId: device.orgId, error: 'timed out',
    });
    // Losing the CAS means a real result landed first; report what the row
    // said and let the next poll read the handler's answer.
    if (finalised) {
      status = 'failed';
      error = 'timed out';
    }
  }

  const executed = (run.executedActions ?? {}) as { actions?: unknown[]; volumes?: unknown[] };
  return {
    ok: true,
    run: {
      cleanupRunId: run.id,
      commandId: run.commandId ?? null,
      status,
      error: error ?? null,
      freedBytes: run.bytesReclaimed ?? 0,
      actions: Array.isArray(executed.actions) ? executed.actions : [],
      volumes: Array.isArray(executed.volumes) ? executed.volumes : [],
      requestedAt: run.requestedAt,
      deadlineAt: storedDeadline,
    },
  };
}
