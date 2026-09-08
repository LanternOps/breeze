import { eq, and, inArray } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
} from '../db';
import { deviceCommands, devices, auditLogs, users } from '../db/schema';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { captureException, captureMessage } from './sentry';
import { recordBackupCommandTimeout, recordRestoreTimeout } from './backupMetrics';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { commandAuditDetails } from './commandAudit';
import {
  AGENT_BINARY_UPDATE_COMMAND_TYPES,
  agentBinaryUpdateDispatchRefusal,
} from './agentEditionCompat';
import { assertDeviceExecuteAllowed, TrustDeniedError } from './partnerTrust.commands';
import { recordCommandDispatch } from './anomalyMetrics';
// #5128. `dispatchDeviceCommand` imports back from this module; both uses are
// function-level (neither evaluates the other's exports at module load), so the
// ESM cycle resolves.
import { dispatchDeviceCommand } from './dispatchDeviceCommand';
import { deliverByFor, type OfflinePolicy } from './commandOfflinePolicy';
import {
  decryptCommandForDelivery,
  terminalPayloadErasureSet,
  toAgentCommandFrame,
} from './sensitiveCommandPayload';

// Sentinel error string for the WS-pre-check fast-fail path. The fileBrowser
// route (and any other interactive caller) matches on this substring to map
// the failure to a "transiently unreachable" UI message distinct from offline.
export const DEVICE_UNREACHABLE_ERROR =
  'Device is not currently reachable over the live connection. Please try again in a moment.';

// How fresh `watchdogLastSeen` must be for a watchdog-targeted command to be
// dispatched. The watchdog only heartbeats while supervising/failing over a
// silent agent, so a stale value means either the agent is healthy (no
// watchdog to receive the command) or the whole box is down — in both cases
// the command can't be delivered, so fail fast instead of queueing forever.
export const WATCHDOG_STALE_MS = 10 * 60 * 1000;

// Number of times we attempt sendCommandToAgent before releasing the claim
// and short-circuiting with DEVICE_UNREACHABLE_ERROR. With a 500 ms gap this
// gives a transient WS hiccup ~1s of grace before the user sees a failure.
// Exported so tests can derive the expected call count.
export const SEND_RETRY_ATTEMPTS = 3;
export const SEND_RETRY_DELAY_MS = 500;

// Command types for system tools.
// #5128: the table itself now lives in the leaf module ./commandTypes so the
// fail-closed offline-policy registry can build from it at module load without
// forming an initialisation cycle through this file. Re-exported here so every
// existing `import { CommandTypes } from './commandQueue'` keeps working.
export { CommandTypes, type CommandType } from './commandTypes';
import { CommandTypes, type CommandType } from './commandTypes';

export interface CommandPayload {
  [key: string]: unknown;
}

export interface CommandResult {
  status: 'completed' | 'failed' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  data?: unknown;
  trust?: { capability: 'device_execute'; reason: string };
  /**
   * The device_commands row id, attached by executeCommand once a command row
   * exists (success or failure). Lets callers point at the persisted result
   * (e.g. the AI pprof tool references GET /devices/:id/commands/:commandId
   * instead of inlining the artifact). Absent only on failures that occur
   * before the row is created (device missing/offline, insert failure).
   */
  commandId?: string;
}

export interface QueuedCommand {
  id: string;
  deviceId: string;
  type: string;
  payload: CommandPayload | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  executedAt: Date | null;
  completedAt: Date | null;
  result: CommandResult | null;
}

type CommandQueueTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Persist a command inside a caller-owned transaction without dispatch side effects. */
export async function insertQueuedCommandInTransaction(
  tx: CommandQueueTx,
  input: {
    id: string;
    deviceId: string;
    type: CommandType;
    payload: CommandPayload;
    /**
     * `device_commands.created_by` is a NULLABLE uuid. Pass `null` for a
     * synthetic principal that `resolveCommandCreatedBy` degraded — NOT `''`,
     * which Postgres rejects with `22P02 invalid input syntax for type uuid`
     * and which rolls back the caller's whole transaction (#3525 W02b).
     */
    createdBy: string | null;
  },
): Promise<QueuedCommand> {
  const [command] = await tx.insert(deviceCommands).values({
    id: input.id,
    deviceId: input.deviceId,
    type: input.type,
    payload: input.payload,
    status: 'pending',
    createdBy: input.createdBy,
  }).returning();
  if (!command) throw new Error('failed to persist queued command');
  return command as QueuedCommand;
}

// Use the directly-imported runOutsideDbContext, NOT db.runOutsideDbContext.
// The `db` proxy delegates property lookups to the active transaction when
// inside withDbAccessContext, so db.runOutsideDbContext resolves to
// tx.runOutsideDbContext (undefined), causing the fallback to run fn()
// inside the transaction — which is exactly what we're trying to avoid.
const runOutsideDbContextSafe = runOutsideDbContext;

export interface QueueCommandForExecutionResult {
  command?: QueuedCommand;
  error?: string;
  trust?: { capability: 'device_execute'; reason: string };
  /**
   * #5128. `delivered` = pushed over the live socket. `queued_live` = device
   * online, waiting for the next heartbeat. `queued_offline` = the device was
   * not online and the command is waiting for it to come back.
   */
  delivery?: 'delivered' | 'queued_offline' | 'queued_live';
  /**
   * #5128. The instant after which the row expires undelivered. NULL for a
   * `reject` policy — those rows stay on the legacy execution clock.
   */
  deliverBy?: Date | null;
}

export type RearmIdempotentCommandResult =
  | { delivered: true }
  | {
      delivered: false;
      reason: 'agent_disconnected' | 'delivery_failed' | 'command_conflict';
    };

/**
 * Re-arm and immediately redeliver only the intrinsically idempotent,
 * finalization-ID-bound desktop stop command. The stable command row remains
 * the durable identity across API/agent restarts; this helper never allocates
 * or replaces it.
 */
export async function rearmIdempotentCommandForDelivery(input: {
  commandId: string;
  deviceId: string;
  type: 'desktop_stream_stop';
  payload: { sessionId: string; finalizationId: string };
}): Promise<RearmIdempotentCommandResult> {
  const prepared = await withSystemDbAccessContext(async () => {
    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, input.commandId))
      .limit(1);
    if (
      !command
      || command.deviceId !== input.deviceId
      || command.type !== input.type
      || command.targetRole !== 'agent'
      || !command.payload
      || typeof command.payload !== 'object'
      || Array.isArray(command.payload)
      || Object.keys(command.payload as Record<string, unknown>).length !== 2
      || (command.payload as Record<string, unknown>).sessionId !== input.payload.sessionId
      || (command.payload as Record<string, unknown>).finalizationId
        !== input.payload.finalizationId
    ) {
      return { ok: false as const };
    }

    const [device] = await db
      .select({ agentId: devices.agentId })
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .limit(1);
    if (!device?.agentId) return { ok: true as const, agentId: null };

    // A confirmed result is filtered by ensureDesktopStreamStopped before this
    // helper is called. Re-arm every other state using the same row identity.
    //
    // #3409 PR4a: this resurrects a row that may already be TERMINAL, and a
    // terminal row has had its sensitive payload keys stripped
    // (terminalPayloadErasureSet) — re-delivering a command whose secrets are
    // gone would be a silent wrong run. Safe here only because the guard above
    // admits exactly one type (`desktop_stream_stop`) whose payload must be
    // exactly `{sessionId, finalizationId}` — neither key is ever stripped.
    // Widening that guard to another command type requires re-checking this.
    await db
      .update(deviceCommands)
      .set({
        status: 'pending',
        executedAt: null,
        completedAt: null,
        result: null,
      })
      .where(and(
        eq(deviceCommands.id, input.commandId),
        inArray(deviceCommands.status, ['pending', 'sent', 'failed', 'completed']),
      ));
    return { ok: true as const, agentId: device.agentId };
  });

  if (!prepared.ok) {
    return { delivered: false, reason: 'command_conflict' };
  }
  if (!prepared.agentId || !isAgentConnected(prepared.agentId)) {
    return { delivered: false, reason: 'agent_disconnected' };
  }

  const claimed = await withSystemDbAccessContext(() =>
    claimPendingCommandForDelivery(input.commandId),
  );
  if (!claimed) {
    return { delivered: false, reason: 'delivery_failed' };
  }
  const delivered = sendCommandToAgent(prepared.agentId, {
    id: input.commandId,
    type: input.type,
    payload: input.payload,
  });
  if (!delivered) {
    await withSystemDbAccessContext(() =>
      releaseClaimedCommandDelivery(input.commandId, claimed.executedAt),
    );
    return { delivered: false, reason: 'delivery_failed' };
  }
  return { delivered: true };
}

// Backup-related command types — used to guard backup-specific Prometheus metrics
const BACKUP_COMMAND_TYPES = new Set([
  'backup_run', 'backup_stop', 'backup_restore', 'backup_verify',
  'backup_test_restore', 'backup_cleanup', 'vm_restore_from_backup',
  'vm_instant_boot', 'bmr_recover', 'mssql_backup', 'mssql_restore',
  'hyperv_backup', 'hyperv_restore',
]);

// Commands that modify system state or access sensitive data (e.g., screen capture) and should always be audit-logged
const AUDITED_COMMANDS: Set<string> = new Set([
  CommandTypes.KILL_PROCESS,
  CommandTypes.START_SERVICE,
  CommandTypes.STOP_SERVICE,
  CommandTypes.RESTART_SERVICE,
  CommandTypes.TASK_RUN,
  CommandTypes.TASK_ENABLE,
  CommandTypes.TASK_DISABLE,
  CommandTypes.REGISTRY_SET,
  CommandTypes.REGISTRY_DELETE,
  CommandTypes.REGISTRY_KEY_CREATE,
  CommandTypes.REGISTRY_KEY_DELETE,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.TERMINAL_START,
  CommandTypes.SCRIPT,
  // #3525: stopping someone else's running script on a customer endpoint is an
  // operator action with a real blast radius — audit the dispatch, same as the
  // run it interrupts. Note this covers the queueCommand/executeCommand insert
  // sites only; insertQueuedCommandInTransaction has no audit block at all.
  CommandTypes.SCRIPT_CANCEL,
  CommandTypes.PATCH_SCAN,
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.ROLLBACK_PATCHES,
  CommandTypes.SOFTWARE_INSTALL,
  CommandTypes.SOFTWARE_UNINSTALL,
  CommandTypes.SOFTWARE_UPDATE,
  // Installing a package manager onto an endpoint is a privileged,
  // state-changing action — always audited.
  CommandTypes.HOMEBREW_BOOTSTRAP,
  CommandTypes.CIS_BENCHMARK,
  CommandTypes.APPLY_CIS_REMEDIATION,
  CommandTypes.SECURITY_SCAN,
  CommandTypes.SECURITY_THREAT_QUARANTINE,
  CommandTypes.SECURITY_THREAT_REMOVE,
  CommandTypes.SECURITY_THREAT_RESTORE,
  CommandTypes.SENSITIVE_DATA_SCAN,
  CommandTypes.ENCRYPT_FILE,
  CommandTypes.SECURE_DELETE_FILE,
  CommandTypes.QUARANTINE_FILE,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
  // Runtime diagnostics — profiling the agent process is a privileged
  // diagnostic action; keep a durable audit trail of who triggered it (#2401).
  CommandTypes.CAPTURE_PPROF,
  CommandTypes.MANAGE_STARTUP_ITEM,
  CommandTypes.APPLY_AUDIT_POLICY_BASELINE,
  // Peripheral control — pushes full active policy set to agent
  CommandTypes.PERIPHERAL_POLICY_SYNC,
  CommandTypes.PERIPHERAL_POLICY_SYNC_V2,
  // Reboots — manual and maintenance-window-automated
  'reboot',
  'schedule_reboot',
  // Safe mode reboot
  CommandTypes.REBOOT_SAFE_MODE,
  // (Wake-on-LAN audit is written by the wakeOnLan service against the target device,
  // not by the auto-audit path. The deviceCommands row is addressed to the relay agent
  // so the result handler in agentWs matches, but the user-visible action belongs to
  // the target. See apps/api/src/services/wakeOnLan.ts.)
  // Self-uninstall (remote wipe)
  CommandTypes.SELF_UNINSTALL,
  CommandTypes.BACKUP_RUN,
  CommandTypes.BACKUP_STOP,
  CommandTypes.BACKUP_RESTORE,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  // VSS
  CommandTypes.VSS_WRITER_LIST,
  // MSSQL
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.MSSQL_VERIFY,
  // Hyper-V
  CommandTypes.HYPERV_BACKUP,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.HYPERV_CHECKPOINT,
  CommandTypes.HYPERV_VM_STATE,
  // BMR
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
  // Vault
  CommandTypes.VAULT_SYNC,
  CommandTypes.VAULT_CONFIGURE,
  // Incident response
  CommandTypes.COLLECT_EVIDENCE,
  CommandTypes.EXECUTE_CONTAINMENT,
]);

// User-interactive command types — the UI is actively waiting on the result
// and a 15–30 s silent timeout is a bad experience. For these, executeCommand
// pre-checks the WS pool and short-circuits with DEVICE_UNREACHABLE_ERROR if
// no live connection exists, instead of queueing and waiting for the timeout.
const INTERACTIVE_COMMAND_TYPES: Set<string> = new Set([
  CommandTypes.FILE_LIST,
  CommandTypes.FILE_LIST_DRIVES,
  CommandTypes.FILE_READ,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_LIST,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.TERMINAL_START,
  CommandTypes.TERMINAL_DATA,
  CommandTypes.TERMINAL_RESIZE,
  CommandTypes.TERMINAL_STOP,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
]);

/**
 * Resolve the value to stamp into `device_commands.created_by`.
 *
 * `created_by` carries a FK to `users(id)`, but several synthetic-auth classes
 * reach the command-queue insert sites with an `auth.user.id` that is NOT a
 * `users` row:
 *
 *  - **Helper sessions** — `auth.user.id` IS the device id (settled by the
 *    equality check below, no DB read needed).
 *  - **`ai_agent` principals** (wave 3b, #3824) — `buildAgentAuthContext` sets
 *    `auth.user.id` to the agent's `ai_agents` id. The intent release worker
 *    executes approved agent intents through the same tool handlers every human
 *    path uses, and they all pass `auth.user.id` verbatim.
 *
 * The handlers cannot cheaply know which ids resolve to users, so it is settled
 * here: one indexed PK probe per dispatch, and any id that is not a `users` row
 * degrades to `created_by NULL` rather than raising a 23503 FK violation. For an
 * agent-released intent that violation would land AFTER a human approved the
 * action, at execution time — the worst possible moment (#3978). Attribution for
 * agent commands lives on the intent/run (`requesting_agent_run_id`), not this
 * column.
 *
 * **Why the probe must open its own system context.** `users` is RLS-protected:
 *
 *     breeze_has_partner_access(partner_id)
 *     OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *     OR id = breeze_current_user_id()
 *
 * `withSystemDbAccessContext` alone is NOT enough: `withDbAccessContext`
 * short-circuits when a context store already exists (`db/index.ts`, "if
 * (dbContextStorage.getStore()) return fn()"), so inside a caller's context the
 * probe would silently run under the CALLER's scope instead of system scope.
 *
 * The shape that actually breaks is an already-open **org-scoped** context. The
 * AI-tool handlers run under exactly that: `dbAccessContextFromAuth`
 * (`middleware/auth.ts`) keeps `scope: 'organization'` while forcing
 * `userId: null` for an `ai_agent` principal. A partner-level user
 * (`users.org_id IS NULL`) then matches NO branch of the policy above —
 * partner access is not granted to an org-scoped caller, the org branch is
 * skipped on a NULL `org_id`, and `breeze_current_user_id()` is null. The probe
 * reads zero rows and degrades a REAL human to NULL, silently destroying
 * attribution while an agent-only test suite still passes.
 *
 * (The other two caller shapes happen to be safe on their own — a contextless
 * call opens a genuine system context, and most BullMQ workers already wrap
 * their dispatch in `withSystemDbAccessContext` — but that is incidental, not a
 * guarantee any caller is obliged to preserve.)
 *
 * So exit the caller's context first: `runOutsideDbContext` clears both stores,
 * which is what lets the nested `withSystemDbAccessContext` open a genuinely
 * fresh system-scoped transaction. This mirrors the audit block below, which
 * escapes the caller's context for the same reason.
 *
 * This is the one probe for both `device_commands` insert sites (`queueCommand`
 * and `executeCommand`) so neither can drift back to a verbatim stamp. Note
 * `services/scriptDispatch.ts` still carries its own independent copy of this
 * probe for `script_executions.triggered_by`/`created_by`; it is FK-safe today
 * but is NOT wired to this helper, so a new synthetic-principal class added here
 * must be mirrored there until the two are converged.
 */
export async function resolveCommandCreatedBy(
  deviceId: string,
  userId?: string | null
): Promise<string | null> {
  const candidateUserId = userId && userId !== deviceId ? userId : null;
  if (!candidateUserId) {
    return null;
  }

  return runOutsideDbContextSafe(() =>
    withSystemDbAccessContext(async () => {
      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, candidateUserId))
        .limit(1);
      // NOT logged here, deliberately. For an `ai_agent` or other synthetic
      // principal this degrade is the DESIGNED outcome, not an anomaly, so a
      // per-dispatch warn would fire on every agent-issued command — the
      // cry-wolf shape that buried `db/index.ts`'s contextless-write reporter
      // under thousands of events/day. Telling an expected degrade apart from a
      // genuinely anomalous one (a stale or deleted user id) needs the caller's
      // principal kind, which `queueCommand` does not receive; plumbing it
      // through ~50 call sites is the very coupling this helper exists to
      // avoid.
      //
      // The degrade is still observable without it: `dispatchActor` below keys
      // on this resolved value, so every degraded dispatch is counted with
      // actor="system" instead of actor="user" on the existing
      // `commandsDispatchedTotal` counter. A spike there is the signal; a log
      // line per command is not.
      return userRow ? candidateUserId : null;
    })
  );
}

/**
 * Queue a command for execution on a device
 */
export async function queueCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  userId?: string,
  // #3409 PR4a: the script secret envelope's AAD binds the command id, so the
  // id has to exist BEFORE the payload is encrypted. Callers that seal a
  // payload reserve a UUID and pass it here; everyone else keeps the column
  // default. Never accept a client-supplied value.
  // #5128: `deliverBy` is the DELIVERY deadline (the instant by which an agent
  // must have CLAIMED the row) and `submittedOrgId` is the device's org at
  // enqueue, compared at claim time to cancel rows whose device has since moved
  // org. Both are optional so legacy callers keep today's semantics
  // (deliver_by NULL = the reaper's created_at + execution-timeout rule).
  options: { commandId?: string; deliverBy?: Date | null; submittedOrgId?: string } = {}
): Promise<QueuedCommand> {
  // #4093 — agent-binary updates must not be created here. This insert site
  // cannot set target_role (the row would default to 'agent', which has no
  // handler for these types) and has no device row to evaluate the
  // artifact-edition gate against. `executeCommand` is the one dispatch path
  // that does both; refuse loudly rather than let this become the ungated
  // back door. Checked FIRST: it is a pure Set lookup, so a refused type never
  // pays for the `resolveCommandCreatedBy` users probe below.
  if (AGENT_BINARY_UPDATE_COMMAND_TYPES.has(type)) {
    throw new Error(
      `${type} cannot be queued through queueCommand — dispatch it via ` +
        `executeCommand(deviceId, '${type}', payload, { targetRole: 'watchdog' }) ` +
        `so the artifact-edition gate (#4093) and the watchdog target role are applied.`,
    );
  }

  await assertDeviceExecuteAllowed(deviceId, type, userId);

  // Never stamp `userId` verbatim — it may be a synthetic-auth id with no
  // `users` row, which would fail the created_by FK with 23503 (#3978).
  const safeUserId = await resolveCommandCreatedBy(deviceId, userId);

  // Insert under a system context (device_commands has no RLS, but a bare-pool
  // write with no access context trips the #1375 contextless-write guard, which
  // CI runs in strict mode). BullMQ workers and other background callers reach
  // here with no request context; when a caller context IS open this is a no-op
  // and the insert stays on the caller's transaction, exactly as before. Matches
  // executeCommand's insert site, which was already wrapped for this reason.
  const [command] = await withSystemDbAccessContext(() =>
    db
      .insert(deviceCommands)
      .values({
        ...(options.commandId ? { id: options.commandId } : {}),
        deviceId,
        type,
        payload,
        status: 'pending',
        createdBy: safeUserId,
        ...(options.deliverBy ? { deliverBy: options.deliverBy } : {}),
        ...(options.submittedOrgId ? { submittedOrgId: options.submittedOrgId } : {}),
      })
      .returning(),
  );

  // Audit log for mutating commands — fire-and-forget under a system-scope
  // connection outside any caller tx, matching `services/auditService.ts`.
  // Both the `devices` lookup and the `audit_logs` insert must run under
  // system scope: BullMQ workers (e.g. `jobs/softwareRemediationWorker.ts`,
  // `jobs/cisJobs.ts`, `jobs/peripheralJobs.ts`) call `queueCommand` with no
  // request DB context, so an org-scoped `devices` SELECT would be rejected
  // by RLS and the audit block would silently no-op before ever reaching
  // the insert. `runOutsideDbContext` escapes any caller tx so a failed
  // audit can't poison the caller's transaction.
  // Anomaly signal (launch-readiness #5): count every dispatch so a command
  // flood is visible regardless of command type. Tenant attribution happens
  // in the audited block below (where the device's org is already loaded) to
  // avoid adding a devices lookup to the dispatch hot path. Non-audited
  // dispatches are still counted, just with an unattributed tenant label.
  // Keyed on the RESOLVED id, matching executeCommand: an id that is not a
  // users row is not a human actor, so labelling it 'user' would misreport the
  // dispatch (and, below, write an audit row claiming a user acted).
  const dispatchActor: 'user' | 'system' = safeUserId ? 'user' : 'system';
  if (!AUDITED_COMMANDS.has(type)) {
    recordCommandDispatch(type, dispatchActor);
  }

  if (command && AUDITED_COMMANDS.has(type)) {
    const commandId = command.id;
    runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [device] = await db
          .select({ orgId: devices.orgId, hostname: devices.hostname })
          .from(devices)
          .where(eq(devices.id, deviceId))
          .limit(1);

        if (!device) {
          recordCommandDispatch(type, dispatchActor);
          return;
        }

        recordCommandDispatch(type, dispatchActor, device.orgId);

        await db.insert(auditLogs).values({
          orgId: device.orgId,
          actorType: safeUserId ? 'user' : 'system',
          actorId: safeUserId || '00000000-0000-0000-0000-000000000000',
          action: `agent.command.${type}`,
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: commandAuditDetails(commandId, type, payload),
          // Dispatch-time row: the agent hasn't reported back yet, so this
          // cannot claim 'success' (#4225). A completion-time audit event
          // DOES exist (action: 'agent.command.result.submit', written in
          // agentWs.ts and routes/agents/commands.ts with a real success/
          // failure result) — but it can't join THIS device's feed: it's
          // keyed on resourceId = commandId with no deviceId in `details`,
          // while the device feed matches on resourceId = deviceId OR
          // details->>'deviceId' (events.ts). Adding a deviceId to that
          // existing event's details would close the loop; this PR does not
          // do that — out of scope per the issue.
          result: 'dispatched',
        });
      })
    ).catch((err) => {
      console.error('Failed to write audit log', {
        commandId,
        deviceId,
        type,
        error: err,
      });
      captureException(err);
    });
  }

  return command as QueuedCommand;
}

/**
 * Wait for a command to complete with polling
 */
export async function waitForCommandResult(
  commandId: string,
  timeoutMs: number = 30000,
  pollIntervalMs: number = 500
): Promise<QueuedCommand> {
  const startTime = Date.now();
  let lastObservedCommand: QueuedCommand | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);

    if (!command) {
      throw new Error(`Command ${commandId} not found`);
    }

    lastObservedCommand = command as QueuedCommand;

    // Check if command is complete
    if (command.status === 'completed' || command.status === 'failed') {
      return command as QueuedCommand;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout - update command status. device_commands is system-scoped and this
  // can run from a runOutsideDbContext poll loop — wrap in a system context so
  // the write isn't a contextless bare-pool write (#1375).
  const completedAt = new Date();
  const [timedOutUpdate] = await withSystemDbAccessContext(() =>
    db
      .update(deviceCommands)
      .set({
        status: 'failed',
        completedAt,
        result: {
          status: 'timeout',
          error: `Command timed out after ${timeoutMs}ms`
        },
        ...terminalPayloadErasureSet(),
      })
      .where(and(
        eq(deviceCommands.id, commandId),
        inArray(deviceCommands.status, ['pending', 'sent']),
      ))
      .returning({
        id: deviceCommands.id,
        status: deviceCommands.status,
      }),
  );

  const timedOutType = lastObservedCommand?.type;
  if (timedOutUpdate && timedOutType) {
    if (BACKUP_COMMAND_TYPES.has(timedOutType)) {
      recordBackupCommandTimeout(timedOutType, 'sync_wait');
    }
    if (
      timedOutType === CommandTypes.BACKUP_RESTORE
      || timedOutType === CommandTypes.VM_RESTORE_FROM_BACKUP
      || timedOutType === CommandTypes.VM_INSTANT_BOOT
      || timedOutType === CommandTypes.BMR_RECOVER
    ) {
      recordRestoreTimeout(timedOutType);
    }
  }

  const [timedOutCommand] = await db
    .select()
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);

  return timedOutCommand as QueuedCommand;
}

/**
 * Queue a command and attempt immediate dispatch to the agent websocket.
 *
 * #5128: this is now a thin adapter over `dispatchDeviceCommand`, the single
 * enqueue seam. Every caller of this function hard-rejected offline devices
 * before #5128, so it passes `previouslyRejected: true` — the
 * DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED flag (default ON since W4; set it to
 * `false` to opt out) is what decides whether their offline devices reject as
 * they used to or queue with a deadline. The error strings are unchanged, so
 * callers that surface `error` verbatim behave identically with the flag off.
 */
export async function queueCommandForExecution(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: {
    userId?: string;
    preferHeartbeat?: boolean;
    expectedOrgId?: string;
    /** Explicit override; wins over the registry default and the flag. */
    offlinePolicy?: OfflinePolicy;
  } = {}
): Promise<QueueCommandForExecutionResult> {
  const res = await dispatchDeviceCommand({
    deviceId,
    type,
    payload,
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
    ...(options.preferHeartbeat !== undefined ? { preferHeartbeat: options.preferHeartbeat } : {}),
    ...(options.expectedOrgId !== undefined ? { expectedOrgId: options.expectedOrgId } : {}),
    ...(options.offlinePolicy !== undefined ? { offlinePolicy: options.offlinePolicy } : {}),
    previouslyRejected: true,
  });

  if (!res.ok) {
    return res.code === 'trust_denied' && res.trust
      ? { error: res.error, trust: res.trust }
      : { error: res.error };
  }

  return { command: res.command, delivery: res.delivery, deliverBy: res.deliverBy };
}

export async function queueBackupStopCommand(
  deviceId: string,
  options: {
    userId?: string;
    jobId?: string;
  } = {}
): Promise<QueueCommandForExecutionResult> {
  return runOutsideDbContextSafe(() =>
    withSystemDbAccessContext(async () => {
      const result = await queueCommandForExecution(
        deviceId,
        CommandTypes.BACKUP_STOP,
        // jobId targets one workload on a queue-capable helper
        // (BACKUP_QUEUE_MIN_HELPER_VERSION). Older helpers ignore the field
        // and stop every backup on the device — the pre-queue behaviour.
        { reason: 'cancelled', ...(options.jobId ? { jobId: options.jobId } : {}) },
        options
      );

      if (result.error) {
        return result;
      }

      if (result.command?.status !== 'sent' && result.command?.id) {
        await db
          .delete(deviceCommands)
          .where(
            and(
              eq(deviceCommands.id, result.command.id),
              eq(deviceCommands.status, 'pending')
            )
          );
        return {
          error: 'Backup stop could not be dispatched immediately',
        };
      }

      return result;
    })
  );
}

export interface ExecuteCommandOptions {
  userId?: string;
  timeoutMs?: number;
  preferHeartbeat?: boolean;
  /**
   * Which polling consumer on the device picks up this command.
   * - 'agent' (default): the long-lived Go agent. Has a WS connection, so
   *   executeCommand dispatches over WS for low latency.
   * - 'watchdog': the separate breeze-watchdog process. Has NO WebSocket —
   *   it polls via heartbeat (`claimPendingCommandsForDevice(..., 'watchdog')`
   *   in routes/agents/heartbeat.ts). When targetRole is 'watchdog' we
   *   MUST skip the WS dispatch path entirely and just write the row;
   *   otherwise the command is sent to the agent WS (wrong consumer) and
   *   the row's default target_role='agent' hides it from the heartbeat
   *   claim query, leaving it pending forever.
   *
   * NOTE: because the watchdog polls every heartbeat (~5–10s per device,
   * sometimes slower), callers targeting the watchdog should pass a larger
   * timeoutMs than they would for an agent command.
   */
  targetRole?: 'agent' | 'watchdog';
}

/**
 * Watchdog-targeted commands have no WS consumer; the WS pre-check and the
 * dispatch path must be skipped entirely for them. The heartbeat poll path in
 * routes/agents/heartbeat.ts picks them up. Derived in ONE place so the
 * precheck and the dispatch phase can never disagree about it.
 */
function dispatchesViaWs(options: ExecuteCommandOptions): boolean {
  return (options.targetRole ?? 'agent') === 'agent' && !(options.preferHeartbeat ?? false);
}

/**
 * The columns of the device row the dispatch phase still needs once the
 * precheck's DB context has closed — the WS target, and the org/hostname the
 * audit row is stamped with. Deliberately just these three: everything else
 * the precheck selects (status, the watchdog freshness fields, the
 * agent-edition triple) is consumed by a gate that runs BEFORE the context
 * closes, and carrying it forward would invite the dispatch phase to start
 * reasoning about a snapshot whose gate has already passed.
 */
interface PreparedCommandDevice {
  agentId: string;
  orgId: string;
  hostname: string;
}

type CommandPrecheckOutcome =
  | { ok: true; device: PreparedCommandDevice }
  | { ok: false; result: CommandResult };

/**
 * Phase 1 of `executeCommand` — every gate that must clear BEFORE a
 * `device_commands` row exists: the device lookup, the partner-trust
 * capability check, the artifact-edition gate, the liveness gates and the
 * interactive WS fast-fail, in exactly that order.
 *
 * Reads `devices` and evaluates partner trust, so it needs an RLS access
 * context — and deliberately does NOT open one of its own, because which
 * context is correct belongs to the caller: a request route runs this inside
 * its auth transaction (RLS-gated, the security property `executeCommand` has
 * always had), while a background caller uses
 * `executeCommandWithSystemPrecheck` to get a short system context that closes
 * before anything waits on the device.
 *
 * Every terminal `CommandResult` returned here predates the row, so none of
 * them carries a `commandId` — that preserves the "commandId present ⇔ row
 * exists" contract the dispatch phase relies on.
 */
async function precheckCommandExecution(
  deviceId: string,
  type: CommandType | string,
  options: ExecuteCommandOptions,
): Promise<CommandPrecheckOutcome> {
  const { userId } = options;
  const targetRole = options.targetRole ?? 'agent';
  const dispatchViaWs = dispatchesViaWs(options);

  // 1. Verify device inside the caller's transaction (RLS-protected).
  // agentEdition/agentVersion/watchdogVersion feed the artifact-edition gate
  // below (#4093) — cheap here because this SELECT already runs.
  const [device] = await db
    .select({
      id: devices.id,
      status: devices.status,
      agentId: devices.agentId,
      orgId: devices.orgId,
      hostname: devices.hostname,
      watchdogLastSeen: devices.watchdogLastSeen,
      agentEdition: devices.agentEdition,
      agentVersion: devices.agentVersion,
      watchdogVersion: devices.watchdogVersion,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return { ok: false, result: { status: 'failed', error: 'Device not found' } };
  }

  try {
    await assertDeviceExecuteAllowed(deviceId, type, userId);
  } catch (e) {
    if (e instanceof TrustDeniedError) {
      return {
        ok: false,
        result: {
          status: 'failed',
          error: e.code,
          trust: { capability: e.capability, reason: e.reason },
        },
      };
    }
    throw e;
  }

  // #4093 — artifact-edition gate for agent-binary updates, at the dispatch
  // chokepoint. Runs BEFORE the liveness gates below on purpose: an edition
  // mismatch is a permanent property of the installed build, so reporting the
  // transient "watchdog is not reporting" first would send the operator back
  // to retry a dispatch that can never succeed. Inert for every other command
  // type (see AGENT_BINARY_UPDATE_COMMAND_TYPES).
  const editionRefusal = agentBinaryUpdateDispatchRefusal({
    commandType: type,
    targetRole,
    device,
  });
  if (editionRefusal) {
    console.warn(
      `[commandQueue] ${type} dispatch refused for device ${deviceId} (#4093): ${editionRefusal}`,
    );
    return { ok: false, result: { status: 'failed', error: editionRefusal } };
  }

  if (targetRole === 'watchdog') {
    // `device.status` reflects the MAIN agent's liveness (only the main-agent
    // heartbeat branch writes status/lastSeenAt; the watchdog branch does
    // not — see routes/agents/heartbeat.ts). A wedged/silent agent is exactly
    // when a watchdog restart is needed, so gating watchdog commands on
    // `status === 'online'` would reject the entire population this path
    // exists for. Gate on the WATCHDOG's own liveness instead. Nothing ever
    // sets watchdogStatus='offline', so freshness of watchdogLastSeen is the
    // only reliable signal — and the watchdog only heartbeats while in
    // FAILOVER (when it actually polls for these commands), so a fresh
    // watchdogLastSeen also means the command will be claimed.
    const watchdogAgeMs = device.watchdogLastSeen
      ? Date.now() - device.watchdogLastSeen.getTime()
      : Infinity;
    if (watchdogAgeMs > WATCHDOG_STALE_MS) {
      return {
        ok: false,
        result: {
          status: 'failed',
          error: 'Watchdog is not reporting; cannot dispatch watchdog command',
        },
      };
    }
  } else if (device.status !== 'online') {
    return {
      ok: false,
      result: { status: 'failed', error: `Device is ${device.status}, cannot execute command` },
    };
  }

  // Fast-fail interactive commands when the WS is known-dead. The user is
  // actively waiting in the UI; queueing and burning the full timeout when
  // we already know the connection is gone wastes ~15–30 s and surfaces a
  // misleading error. Non-interactive callers (and the heartbeat fallback)
  // can still queue normally.
  if (
    device.agentId &&
    dispatchViaWs &&
    INTERACTIVE_COMMAND_TYPES.has(type) &&
    !isAgentConnected(device.agentId)
  ) {
    // Log so ops can correlate spikes of unreachable-fast-fails with WS pool
    // health. This is the single most useful signal for diagnosing recurrences
    // of issue #391 — without it the failure is invisible until users complain.
    console.warn('[commandQueue] interactive command fast-fail (WS not connected)', {
      deviceId,
      agentId: device.agentId,
      type,
    });
    return { ok: false, result: { status: 'failed' as const, error: DEVICE_UNREACHABLE_ERROR } };
  }

  return { ok: true, device };
}

/**
 * Phase 2 of `executeCommand` — queue, dispatch, and poll. Runs entirely
 * OUTSIDE the caller's DB context so the INSERT commits immediately and is
 * visible to the WebSocket handler that processes the agent's response
 * (a separate transaction); its own short system contexts cover the writes
 * that would otherwise be contextless bare-pool writes (#1375).
 *
 * `device` is the snapshot the precheck resolved. Re-reading it here would
 * defeat the point of the split, and there was never an atomic
 * authorisation-to-insert guarantee to lose: the precheck's SELECT has always
 * been a non-locking read.
 */
async function dispatchPreparedCommand(
  device: PreparedCommandDevice,
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload,
  options: ExecuteCommandOptions,
): Promise<CommandResult> {
  const { timeoutMs = 30000, userId } = options;
  const targetRole = options.targetRole ?? 'agent';
  const dispatchViaWs = dispatchesViaWs(options);

  return runOutsideDbContextSafe(async () => {
    // Validate userId for the created_by FK. Shared with queueCommand — see
    // `resolveCommandCreatedBy` for why synthetic-auth ids degrade to NULL and
    // why the probe opens its own system context. The sibling drift this used
    // to warn about (queueCommand/queueCommandForExecution stamping verbatim,
    // breaking the hyperv/backup/vault/mssql/incident/agent-logs tools) is
    // closed: both insert sites now go through that one helper (#3978).
    const safeUserId = await resolveCommandCreatedBy(deviceId, userId);

    // #3112: the caller's budget has to travel WITH the command, not merely bound
    // the server-side wait below. The agent's helper-IPC path used a hardcoded
    // per-attempt timeout, so raising `timeoutMs` here changed only how long the
    // server waited while the device gave up on its own schedule underneath.
    // Publishing it as `timeoutSeconds` — the key the agent's script path already
    // reads — lets the device bound its own work by what the caller is waiting for.
    //
    // Never clobber an explicit value: callers that set their own `timeoutSeconds`
    // (script execution, for one) carry the more specific intent.
    //
    // Agent-targeted only. The watchdog is a different consumer with no helper-IPC
    // path to bound, and its callers are explicitly told to pass a LARGER
    // timeoutMs than they would for an agent command (see the targetRole doc
    // above) — publishing that inflated number into its payload would be
    // misleading rather than useful.
    const payloadWithBudget = (
      targetRole === 'agent'
      && payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && (payload as Record<string, unknown>).timeoutSeconds === undefined
    )
      ? { ...(payload as Record<string, unknown>), timeoutSeconds: Math.ceil(timeoutMs / 1000) }
      : payload;

    // Insert command (device_commands — no RLS, but establish a system context
    // so it isn't a contextless bare-pool write under runOutsideDbContext, #1375).
    const [command] = await withSystemDbAccessContext(() =>
      db
        .insert(deviceCommands)
        .values({
          deviceId,
          type,
          payload: payloadWithBudget,
          status: 'pending',
          createdBy: safeUserId,
          targetRole,
          // #5128. executeCommand is synchronous by contract (the caller waits
          // via waitForCommandResult), so it stays `reject` — and a `reject`
          // row gets NO `deliver_by`. Review round 2 (J): stamping the
          // 5-minute race grace here cut every executeCommand row's pending
          // window from the legacy 30-minute execution clock to 5 minutes,
          // including watchdog-targeted binary/restart work and other
          // `preferHeartbeat` callers, and it expired a barrier-held reboot
          // while the power-state barrier was deliberately holding it. NULL
          // keeps the legacy clock, so nothing changes for reject callers.
          // (Deliberately no literal command-type names here: the #4093 scan in
          // agentEditionCompat.test.ts greps raw file text, and this hub file
          // must stay off its allowlist so a real raw insert still trips it.)
          deliverBy: deliverByFor({ kind: 'reject' }),
          submittedOrgId: device.orgId,
        })
        .returning(),
    );

    if (!command) {
      return { status: 'failed' as const, error: 'Failed to create command' };
    }

    // Audit log for mutating commands (fire-and-forget).
    // Uses device info fetched in step 1 to avoid an RLS-gated query.
    if (AUDITED_COMMANDS.has(type)) {
      withDbAccessContext(
        { scope: 'organization', orgId: device.orgId, accessibleOrgIds: [device.orgId] },
        () =>
          db
            .insert(auditLogs)
            .values({
              orgId: device.orgId,
              actorType: safeUserId ? 'user' : 'system',
              actorId: safeUserId || '00000000-0000-0000-0000-000000000000',
              action: `agent.command.${type}`,
              resourceType: 'device',
              resourceId: deviceId,
              resourceName: device.hostname,
              details: commandAuditDetails(command.id, type, payload),
              // Dispatch-time row: the agent hasn't reported back yet, so
              // this cannot claim 'success' (#4225).
              result: 'dispatched',
            })
            .execute()
      )
        .catch((err) => {
          console.error('Failed to write audit log', {
            commandId: command.id,
            deviceId,
            type,
            orgId: device.orgId,
            error: err,
          });
          captureException(err);
        });
    }

    // Dispatch via WebSocket. Retry briefly on send failure: a transient WS
    // hiccup (e.g. mid-reconnect) can fail a single send even when the
    // connection comes back ~hundreds of ms later. Retrying gives the pool a
    // chance to recover before we fall through to the multi-second timeout.
    // Watchdog-targeted commands skip this entirely — the watchdog has no WS
    // and is picked up by the heartbeat claim query in heartbeat.ts.
    if (device.agentId && dispatchViaWs) {
      const claimed = await claimPendingCommandForDelivery(command.id);
      if (claimed) {
        // Decrypt once up-front; null means the payload can't be decrypted, so
        // there's nothing deliverable to retry — skip the send loop and release.
        const delivered = decryptCommandForDelivery({ id: command.id, type, deviceId, payload });
        let sent = false;
        for (let attempt = 0; delivered && attempt < SEND_RETRY_ATTEMPTS; attempt++) {
          sent = sendCommandToAgent(device.agentId, toAgentCommandFrame(delivered));
          if (sent) {
            if (attempt > 0) {
              console.warn('[commandQueue] sendCommandToAgent recovered after retry', {
                commandId: command.id,
                deviceId,
                agentId: device.agentId,
                type,
                attempt: attempt + 1,
              });
            }
            break;
          }
          console.warn('[commandQueue] sendCommandToAgent failed, will retry', {
            commandId: command.id,
            deviceId,
            agentId: device.agentId,
            type,
            attempt: attempt + 1,
            maxAttempts: SEND_RETRY_ATTEMPTS,
          });
          if (attempt < SEND_RETRY_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
          }
        }
        if (!sent) {
          await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
          console.warn('[commandQueue] sendCommandToAgent exhausted retries', {
            commandId: command.id,
            deviceId,
            agentId: device.agentId,
            type,
            attempts: SEND_RETRY_ATTEMPTS,
          });
          // All retries exhausted with no successful send. For interactive
          // commands the user is staring at a spinner — short-circuit with
          // the unreachable error rather than burning the full poll timeout.
          // For non-interactive commands, fall through to polling: the agent
          // may still pick the command up via the heartbeat path before the
          // timeout fires, in which case the user gets a real result.
          if (INTERACTIVE_COMMAND_TYPES.has(type)) {
            // Row already exists at this point — attach its id so the
            // "commandId present ⇔ row exists" contract holds on this path too.
            return { status: 'failed' as const, error: DEVICE_UNREACHABLE_ERROR, commandId: command.id };
          }
        }
      }
    }

    // Poll for result
    const result = await waitForCommandResult(command.id, timeoutMs);

    const finalResult = result.result ?? {
      status: 'failed' as const,
      error: 'Command did not complete',
    };
    return { ...finalResult, commandId: command.id };
  });
}

/**
 * Execute a command and wait for result (convenience wrapper).
 *
 * When called from routes protected by authMiddleware, the entire request
 * handler runs inside a long-lived PostgreSQL transaction (via
 * withDbAccessContext).  If the device_commands INSERT stays inside that
 * transaction it is invisible to the WebSocket handler that processes the
 * agent's response (separate transaction) — so the result is silently
 * dropped and waitForCommandResult times out after 30 s.
 *
 * Fix: fetch the device (needs RLS → runs in the auth transaction), then
 * break out of the DB context for the device_commands lifecycle.
 * device_commands has no org_id column so RLS does not apply.
 *
 * NOTE for background callers (workers, schedulers, AI-agent runs): the
 * `runOutsideDbContext` inside the dispatch phase exits the AsyncLocalStorage,
 * but it CANNOT release a transaction the caller opened — so wrapping this
 * call in `withSystemDbAccessContext` just to satisfy the precheck pins a
 * pooled connection idle-in-transaction for the whole `timeoutMs` wait (#1105).
 * Use `executeCommandWithSystemPrecheck` instead.
 */
export async function executeCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: ExecuteCommandOptions = {}
): Promise<CommandResult> {
  const precheck = await precheckCommandExecution(deviceId, type, options);
  if (!precheck.ok) return precheck.result;
  return dispatchPreparedCommand(precheck.device, deviceId, type, payload, options);
}

/**
 * At most one Sentry event per scope per window for the held-context guard
 * below. The same `db_operation_inside_held_context` code is deduped by call
 * site in `db/index.ts` for exactly this reason: a hot path emitting it per
 * call has previously burned thousands of events/day off the org quota, and
 * the Nth event from a scope you have already seen tells you nothing the first
 * did not. Bounded by construction — there are three scopes.
 *
 * The console line is deliberately NOT throttled: it carries the deviceId and
 * command type that attribute the violation to a caller, neither of which can
 * ride a Sentry tag (`commandType` is not in `ALLOWED_TAG_NAMES` and would be
 * scrubbed; a device id never belongs in one). Logs have no quota. So the
 * Sentry event is the alert and the log line is the attribution — the same
 * division of labour `reportContextlessWrite` uses.
 *
 * Deliberately NOT `db/index.ts`'s exported `shouldCaptureHeldContext`, even
 * though it is the same per-scope shape: its map is shared with the
 * `db_context_held_too_long` capture, so one signal would silently suppress the
 * other for a whole window. These are different problems — "a context was held
 * too long" vs "this dispatch was made from inside one" — and an operator needs
 * to see both. The cost of keeping them apart is the six lines below.
 */
const HELD_CONTEXT_DISPATCH_CAPTURE_THROTTLE_MS = 15 * 60 * 1000;
const heldContextDispatchLastCapture = new Map<string, number>();

function reportHeldContextDispatch(
  scope: string,
  deviceId: string,
  type: CommandType | string,
): void {
  // Invariant text: it is the Sentry grouping key, so the varying part rides
  // the allowlisted `scope` tag rather than the message.
  const message = '[commandQueue] executeCommandWithSystemPrecheck was called from inside an '
    + "existing DB access context. The caller's pooled connection stays pinned "
    + 'idle-in-transaction for the whole device round-trip (#1105/#4150) — call it at depth 0, '
    + 'or use executeCommand if the caller genuinely wants its own context to gate the precheck.';
  console.warn(message, { deviceId, type, scope });

  const now = Date.now();
  const last = heldContextDispatchLastCapture.get(scope);
  if (last !== undefined && now - last < HELD_CONTEXT_DISPATCH_CAPTURE_THROTTLE_MS) return;
  heldContextDispatchLastCapture.set(scope, now);
  captureMessage(message, {
    eventCode: 'db_operation_inside_held_context',
    tags: { scope },
  });
}

/**
 * `executeCommand` for callers that hold NO DB access context of their own —
 * BullMQ workers, schedulers, and the AI-agent run loop (which deliberately
 * runs contextless; see jobs/aiAgentRunner.ts).
 *
 * Such a caller cannot invoke `executeCommand` directly: the precheck's
 * `devices` SELECT would run on the bare pool, RLS would deny it, and every
 * dispatch would report "Device not found". Wrapping the whole call in a
 * system context makes it work — and pins a pooled Postgres connection
 * idle-in-transaction for the entire device round-trip, which is the #1105
 * pool-exhaustion shape (#4150, and #4133/3ec0439d2 before it in the workers).
 *
 * This entry point opens a system context for the PRECHECK ONLY and closes it
 * before anything waits on the device. The dispatch phase — the WS send and
 * the `waitForCommandResult` poll — runs at depth 0, holding nothing.
 *
 * Scope is system, matching what the background callers already passed. A
 * caller that needs the command gated by a specific tenant's RLS must open
 * that context itself and call `executeCommand` — but see the note there
 * about how long it will then hold a connection.
 *
 * PRECONDITION: no ambient DB access context. It is reported (not thrown) when
 * broken, because from inside someone else's transaction the no-held-context
 * promise is unrecoverable — see the guard below.
 */
export async function executeCommandWithSystemPrecheck(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: ExecuteCommandOptions = {}
): Promise<CommandResult> {
  const ambient = getCurrentDbAccessContext();
  if (ambient) {
    reportHeldContextDispatch(ambient.scope, deviceId, type);
  }

  // ANY ambient context is joined, never nested inside. Two reasons, and the
  // second is why this is not just `scope === 'system'`:
  //
  //  - A nested `withSystemDbAccessContext` checks out a SECOND pooled
  //    connection while the caller's is still held for the whole round-trip —
  //    strictly worse than the bug this entry point exists to fix.
  //  - Escaping a caller's 'organization'/'partner' context to open a system
  //    one would run the precheck's `devices` read and trust check with FULL
  //    cross-tenant visibility, i.e. more permissively than the caller's own
  //    scope allows. Joining instead degrades toward "Device not found" — the
  //    fail-CLOSED direction, and the repo's standing contract that too little
  //    context denies rather than bypasses.
  //
  // Reaching here with an ambient context is a caller bug either way; the
  // guard above says so out loud. It must not also widen what the caller can
  // reach while it is being wrong.
  const precheck = ambient
    ? await precheckCommandExecution(deviceId, type, options)
    : await runOutsideDbContextSafe(() =>
      withSystemDbAccessContext(
        () => precheckCommandExecution(deviceId, type, options),
        'commandQueue.executeCommandWithSystemPrecheck',
      ));

  if (!precheck.ok) return precheck.result;
  return dispatchPreparedCommand(precheck.device, deviceId, type, payload, options);
}

/**
 * Get pending commands for a device (used by heartbeat endpoint)
 */
export async function getPendingCommands(
  deviceId: string,
  limit: number = 10
): Promise<QueuedCommand[]> {
  const commands = await db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending')
      )
    )
    .orderBy(deviceCommands.createdAt)
    .limit(limit);

  return commands as QueuedCommand[];
}

/**
 * Mark commands as sent (called after returning to agent)
 */
export async function markCommandsSent(commandIds: string[]): Promise<void> {
  if (commandIds.length === 0) return;

  for (const id of commandIds) {
    await db
      .update(deviceCommands)
      .set({
        status: 'sent',
        executedAt: new Date()
      })
      .where(and(
        eq(deviceCommands.id, id),
        eq(deviceCommands.status, 'pending'),
      ));
  }
}

/**
 * Submit command result (called by agent)
 */
export async function submitCommandResult(
  commandId: string,
  result: CommandResult
): Promise<void> {
  await db
    .update(deviceCommands)
    .set({
      status: result.status === 'completed' ? 'completed' : 'failed',
      completedAt: new Date(),
      result,
      ...terminalPayloadErasureSet(),
    })
    .where(and(
      eq(deviceCommands.id, commandId),
      eq(deviceCommands.status, 'sent'),
    ));
}
