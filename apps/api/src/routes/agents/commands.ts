import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { dbWriteExpectingRows } from '../../db/dbWriteExpectingRows';
import { commandCasPriorStatusTags } from '../../services/commandCasDiagnostics';
import { deviceCommands } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import {
  commandResultSchema,
  securityCommandTypes,
  filesystemAnalysisCommandType,
  sensitiveDataCommandTypes,
  uuidRegex
} from './schemas';
import {
  handleSecurityCommandResult,
  handleFilesystemAnalysisCommandResult,
  handleSensitiveDataCommandResult,
  handleSoftwareRemediationCommandResult,
  handleCisCommandResult,
} from './helpers';
import { captureException } from '../../services/sentry';
import { markCommandResultProcessingFailed } from '../../services/commandResultProcessingFailure';
import { processCollectedAuditPolicyCommandResult } from '../../services/auditBaselineService';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { redactResultAgainstCommandSecrets } from '../../services/commandSecretRedaction';
import { terminalPayloadErasureSet } from '../../services/sensitiveCommandPayload';
import { applyCommandAutomationTerminal } from '../../services/automationTerminalEvidence';
import { applyVaultSyncCommandResult } from '../../services/vaultSyncPersistence';
import { processBackupVerificationResult } from '../backup/verificationService';
import { updateRestoreJobByCommandId } from '../../services/restoreResultPersistence';
import { detectResultValidationFamily, validateCriticalCommandResult, DR_COMMAND_TYPES } from '../../services/agentCommandResultValidation';
import { redactSecretsFromOutput, redactAgentResultErrorFields } from '../../services/secretRedaction';
import { isRawStdoutArtifactCommand } from '../../services/commandAudit';
import {
  reconcileSoftwareInstallResult,
} from '../../services/softwareDeploymentResult';

import {
  ACCEPTED_COMMAND_RESULT_STATUSES,
  BACKUP_QUEUE_ACK_RESULT_STATUS,
  commandAcceptsAgentResult,
  commandAcceptsAgentResultCondition,
  collapseAgentReportedTimeoutStatus,
} from '../../services/commandResultAcceptance';
import { QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES } from '../../services/commandTypes';
import { tryParseBackupResultPayload, isBackupQueuedAck, isBackupStartedAck } from '../../services/backupProgress';
import {
  pamAgentResultV2Schema,
  type PamActuationResultClassification,
} from '../../services/pamActuationResult';
import { consumePamReconciliationRateLimit } from '../../services/pamReconciliationRateLimit';

export type PamResultAcknowledgement = {
  protocolVersion: 1;
  classification: PamActuationResultClassification;
};

export const commandsRoutes = new Hono();

/**
 * #3097 — registry-backed command types this route dispatches to the shared
 * handlers in `services/commandResultHandlers.ts`.
 *
 * Those handlers used to live inside `agentWs.ts` and were only ever reachable
 * over the websocket, so a result submitted over HTTP silently skipped them.
 * For `script` that meant `script_executions` was never updated: measured on a
 * live instance, 394 of 1070 executions (37%) carried a `timeout` status that
 * did not match reality, 89 of them having completed successfully with output
 * sitting in `device_commands.result`.
 *
 * This set is deliberately NOT the whole registry. Thirteen of its eighteen
 * keys already have an equivalent inline block further down this handler
 * (backup_verify, backup_test_restore, backup_restore, bmr_recover,
 * vm_restore_from_backup, vm_instant_boot, vault_sync, sensitive_data_scan,
 * encrypt_file, secure_delete_file, quarantine_file, cis_benchmark,
 * apply_cis_remediation) — dispatching those here as well would run each of
 * them twice. Only the five the HTTP path never handled at all are listed.
 *
 * Converging the overlapping thirteen onto the registry is left as follow-up
 * rather than folded in here: the CIS and sensitive-data handlers forward the
 * *derived* stdout while this route's inline blocks forward `normalizedData`
 * verbatim, so replacing them would change what those two post-processors
 * receive — a behaviour change beyond this PR's one intentional one.
 */
const REGISTRY_DISPATCHED_COMMAND_TYPES = new Set([
  // Disk Cleanup v2 W04. Listed here because this route has NO inline block
  // for it — the handler is registry-only precisely so both transports run
  // exactly the same code.
  'system_cleanup_run',
  'file_delete',
  'network_discovery',
  'hyperv_backup',
  'mssql_backup',
  'snmp_poll',
  'script',
  // #3525: the agent's script_cancel ack is the ONLY evidence that lets an
  // execution terminalise as `cancelled`. Omitting it here drops that evidence
  // on the HTTP-polling transport specifically, leaving the row stuck in
  // `cancelling` until a sweep gives up on it.
  'script_cancel',
  'peripheral_policy_sync_v2',
  'pam_apply_v2',
  'pam_cleanup_v2',
  // W05a: the handler both closes the restore job AND applies the terminal
  // status to the bare_metal_recoveries row, so it is dispatched here rather
  // than through the inline restore branch below (which would only do the
  // first half and, if listed in both, do it twice).
  'bare_metal_rebuild',
]);

const PAM_COMMAND_TYPES = new Set(['pam_apply_v2', 'pam_cleanup_v2']);

function commandResultToStdout(data: z.infer<typeof commandResultSchema>): string | undefined {
  return data.stdout ??
    (data.result !== undefined ? JSON.stringify(data.result) : undefined);
}

function buildStoredCommandResult(
  commandType: string,
  data: z.infer<typeof commandResultSchema>,
  stdout: string | undefined,
) {
  // Defense-in-depth: strip full PEM private-key blocks from agent output
  // before it is persisted and later shown to scripts:read users. Pre-update
  // agents don't redact server-side-visible output, so we redact here.
  // Preserve null/undefined (don't coerce to '') to keep the stored shape stable.
  //
  // Exception: artifact-bearing stdout (capture_pprof base64 profiles) must be
  // stored byte-for-byte -- the redaction patterns statistically fire inside
  // megabytes of random base64 and would silently corrupt the artifact (#2401).
  const skipStdoutRedaction = isRawStdoutArtifactCommand(commandType);
  return {
    // See collapseAgentReportedTimeoutStatus: an agent-reported 'timeout'
    // must never be stored verbatim — that literal string doubles as the
    // server's own reopen marker.
    status: collapseAgentReportedTimeoutStatus(data.status),
    exitCode: data.exitCode,
    stdout: stdout != null && !skipStdoutRedaction ? redactSecretsFromOutput(stdout) : stdout,
    stderr: data.stderr != null ? redactSecretsFromOutput(data.stderr) : data.stderr,
    durationMs: data.durationMs,
    error: data.error != null
      ? redactSecretsFromOutput(data.error)
      : data.status === 'timeout' ? 'Agent reported a timeout' : data.error,
  };
}

function normalizeCriticalResultIfNeeded(
  commandType: string,
  commandId: string,
  data: z.infer<typeof commandResultSchema>,
  commandPayload?: unknown
) {
  if (!detectResultValidationFamily(commandType)) {
    return {
      normalizedData: data,
      stdout: commandResultToStdout(data),
      validationError: null as string | null,
    };
  }

  try {
    const validated = validateCriticalCommandResult(commandType, {
      commandId,
      status: data.status,
      exitCode: data.exitCode,
      stdout: data.stdout,
      stderr: data.stderr,
      durationMs: data.durationMs,
      error: data.error,
      result: data.result,
    }, { commandPayload });

    if (!validated) {
      return {
        normalizedData: data,
        stdout: commandResultToStdout(data),
        validationError: null as string | null,
      };
    }

    const stdout = validated.normalizedStdout ?? data.stdout;
    return {
      normalizedData: {
        ...data,
        stdout,
        result: validated.structuredResult,
      },
      stdout,
      validationError: null as string | null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown validation error';
    return {
      normalizedData: {
        ...data,
        status: 'failed' as const,
        error: `Rejected malformed ${commandType} result: ${message}`,
      },
      stdout: commandResultToStdout(data),
      validationError: `Rejected malformed ${commandType} result: ${message}`,
    };
  }
}

const commandResultParamSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1),
});

commandsRoutes.get('/:id/commands', async (c) => {
  const agent = c.get('agent') as AgentAuthContext | undefined;

  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
  }

  // #2414 — decrypt just-in-time; a command whose payload fails decryption is
  // released back to `pending` (not stranded as `sent`) while its siblings
  // still deliver.
  //
  // Both the claim AND the delivery pass run inside the SAME system context.
  // This route is self-managed-context (agentAuth leaves no ambient context
  // behind on the REST paths), and since #3409 PR4c-2 the delivery pass is no
  // longer pure CPU: `prepareClaimedCommandsForDelivery` first runs the
  // secret-delivery claim gate, which reads `devices` (RLS-scoped) and drives
  // offending `device_commands` / `script_executions` rows terminal. Called
  // outside the closure those would be contextless bare-pool queries (#1375).
  // Unlike the heartbeat there is no capability report on this path, so the
  // gate reads the stored column.
  const deliverableCommands = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const commands = await claimPendingCommandsForDevice(
        agent.deviceId,
        10,
        agent.role,
        // #2774 / #3986 — drain narrowing (tenant offboarding OR device
        // remove). Derived ONCE in agentAuthMiddleware; `undefined` here means
        // "not draining, claim anything", which is also this parameter's
        // default — so read the context value, never restate the literal.
        agent.claimTypeAllowlist
      );
      return prepareClaimedCommandsForDelivery(commands);
    })
  );

  return c.json({ commands: deliverableCommands });
});

// #2774 / #3986 — drain narrowing for the result endpoint below. This prose
// lives ABOVE the route declaration on purpose: the site-scope route scanner
// (apps/api/src/__tests__/helpers/routeScan.ts) reads a fixed
// HANDLER_SLICE_BYTES window from the route declaration, comments included, and
// a handler whose device-table condition falls past that window silently reads
// as "touches no device data" — dropping it out of the scan and marking its
// SITE_SCOPE_INPUT_EXEMPT entry stale. Keeping the explanation outside the
// window keeps the handler visible to the scanner. See #4019.
//
// The endpoint accepts results ONLY for the command types the claim allowlist
// permits while the agent sits on a narrowed drain surface.
// Draining agents may only report results for persisted, UUID-keyed commands
// whose type can be checked against their claim allowlist.
commandsRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('param', commandResultParamSchema),
  zValidator('json', commandResultSchema),
  async (c) => {
    const { id: agentId, commandId } = c.req.valid('param');
    const data = c.req.valid('json');
    const agent = c.get('agent') as AgentAuthContext | undefined;

    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    const deviceId = agent.deviceId;

    const drainClaimAllowlist = agent.claimTypeAllowlist;
    if (drainClaimAllowlist && !uuidRegex.test(commandId)) {
      return c.json({ error: 'drain_restricted' }, 403);
    }

    // Commands dispatched directly over WebSocket can use non-UUID IDs and
    // intentionally have no device_commands row.
    if (!uuidRegex.test(commandId)) {
      return c.json({ success: true });
    }

    // Query device_commands OUTSIDE the agentAuth transaction.
    // device_commands has no RLS; querying via the pool (auto-commit)
    // guarantees visibility of recently committed rows.
    //
    // The READ deliberately stays on the bare pool while the write below takes
    // an explicit system context. Only insert/update/delete are instrumented by
    // the contextless-write guard (CONTEXTLESS_WRITE_GUARD_METHODS, db/index.ts),
    // and a bare-pool read of an RLS-free table returns the same rows a
    // system-context read would — so wrapping it would buy nothing and cost a
    // full BEGIN + set_config×6 + COMMIT round-trip on a hot agent path we are
    // actively trying to keep off the connection pool (#1105). If
    // device_commands ever gains an RLS policy, this read becomes a silent
    // 0-row no-op and MUST move into withSystemDbAccessContext — same caveat as
    // services/commandDispatch.ts.
    const [command] = await runOutsideDbContext(() =>
      db
        .select()
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.id, commandId),
            eq(deviceCommands.deviceId, deviceId)
          )
        )
        .limit(1)
    );

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    // The type half of the drain narrowing (the id-shape half ran above). The
    // claim allowlist already stops a draining agent from being HANDED anything
    // but `self_uninstall`, but a row it claimed before the drain started — or
    // one pushed over some other path — must not be ackable either: the result
    // handlers below are a large fan-out (security findings, filesystem
    // analysis, vault sync, backup verification, restore jobs, CIS, software
    // remediation) that all write tenant data.
    if (drainClaimAllowlist && !drainClaimAllowlist.includes(command.type)) {
      return c.json({ error: 'drain_restricted' }, 403);
    }

    const commandTargetRole = command.targetRole === 'watchdog' ? 'watchdog' : 'agent';
    if (commandTargetRole !== agent.role) {
      return c.json({ error: 'Command role mismatch' }, 403);
    }

    // Supplemental PAM evidence for every terminal command state, including a
    // server-side timeout, enters only the frozen PAM result transaction. It
    // must never use #3607's timeout exception to rewrite the command row.
    const isTerminalPamCommand = PAM_COMMAND_TYPES.has(command.type)
      && !(ACCEPTED_COMMAND_RESULT_STATUSES as readonly string[]).includes(command.status);
    const parsedTerminalPamResult = isTerminalPamCommand
      ? pamAgentResultV2Schema.safeParse(data.result)
      : null;
    if (parsedTerminalPamResult?.success) {
      const rate = await consumePamReconciliationRateLimit(deviceId);
      if (!rate.allowed) {
        return c.json({
          error: 'Rate limit exceeded',
          resetAt: rate.resetAt.toISOString(),
        }, 429);
      }

      const { commandResultHandlers } = await import('../../services/commandResultHandlers');
      const handler = commandResultHandlers[command.type];
      if (!handler) {
        throw new Error(`Missing PAM result handler for ${command.type}`);
      }
      const outcome = await handler({
        agentId: agent.agentId ?? agentId,
        command,
        commandId,
        result: { ...data, result: parsedTerminalPamResult.data },
        resolvedDeviceId: command.deviceId,
        stdout: commandResultToStdout({ ...data, result: parsedTerminalPamResult.data }),
      });
      if (!outcome || outcome.kind !== 'pam') {
        throw new Error(`PAM result handler returned no acknowledgement for ${command.type}`);
      }
      return c.json<PamResultAcknowledgement>({
        protocolVersion: 1,
        classification: outcome.classification,
      });
    }
    if (isTerminalPamCommand) {
      return c.json({ success: true });
    }

    // #3607: a row terminalized by a SERVER-SIDE timeout (`result.status ===
    // 'timeout'`, written by the wait deadline in commandQueue or by the stale
    // reaper) remains acceptable for non-PAM commands. Every other terminal
    // result preserves the historical short circuit.
    const acceptsResult = commandAcceptsAgentResult(command.status, command.result, command.type);
    if (!acceptsResult && command.type !== 'file_delete' && command.type !== 'system_cleanup_run') {
      return c.json({ success: true });
    }

    const {
      normalizedData: rawNormalizedData,
      stdout: rawStdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, commandId, data, command.payload);

    // #2434 chokepoint (REST twin of agentWs.processCommandResult): redact
    // agent-supplied error/stderr ONCE before the device_commands write and
    // the per-type post-processing handlers (security, CIS, sensitive-data,
    // backup verification, restore, vault sync) so every persisted surface
    // receives redacted text. stdout stays raw here (structured-JSON parsers
    // + capture_pprof artifacts); persisted stdout is redacted per-site.
    const heuristicallyRedacted = redactAgentResultErrorFields(rawNormalizedData);

    // #3409 PR4a — REST twin of the WS exact-value pass: redact against the
    // secrets THIS command carried, before the device_commands write below and
    // before the per-type handlers persist anything. Unlike the heuristic above
    // this DOES touch stdout, because a script that echoes a credential is
    // exactly the case it exists for. Live since PR4c-2: scriptDispatch sets
    // `secretEnv` for `tenantSecret` parameters, so a script command can carry
    // a sealed envelope whose values this pass strips from both bindings.
    const { result: normalizedData, stdout } = redactResultAgainstCommandSecrets(
      { id: commandId, type: command.type, deviceId, payload: command.payload },
      heuristicallyRedacted,
      rawStdout,
    );

    // Cleanup evidence can arrive after cancellation or a terminal result.
    // Authorize using the stored command above and redact before persisting;
    // this supplements the run without reopening the command.
    const recordSupplementalCleanup = async () => {
      const payload = command.payload as { cleanupRunId?: unknown; runId?: unknown } | null;
      const runId = command.type === 'system_cleanup_run' ? payload?.runId : payload?.cleanupRunId;
      if (!['file_delete', 'system_cleanup_run'].includes(command.type) || typeof runId !== 'string' || !runId) return;
      const { commandResultHandlers } = await import('../../services/commandResultHandlers');
      await commandResultHandlers[command.type]!({
        agentId: agent.agentId ?? agentId, command, commandId, result: normalizedData,
        resolvedDeviceId: command.deviceId, stdout,
      });
    };
    if (!acceptsResult) {
      await recordSupplementalCleanup();
      return c.json({ success: true });
    }

    // D20-D (REST twin of agentWs.ts processCommandResult): mssql_backup and
    // hyperv_backup's FIRST reply can be a non-terminal queue-admission/
    // started ack rather than the real outcome. Detected the same way the
    // WS twin and the backup_run orphaned-result branch already do
    // (tryParseBackupResultPayload + isBackupQueuedAck/isBackupStartedAck).
    const isQueuedBackupWorkload = QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES.includes(
      command.type as (typeof QUEUED_BACKUP_WORKLOAD_COMMAND_TYPES)[number],
    );
    const isBackupAck =
      isQueuedBackupWorkload &&
      (() => {
        const parsed = tryParseBackupResultPayload(normalizedData.result, stdout);
        return isBackupQueuedAck(parsed) || isBackupStartedAck(parsed);
      })();

    // #3530 — the terminal compare-and-set and the per-type persistence now run
    // in ONE savepoint (withDbTransaction) on the request transaction that
    // agentAuthMiddleware already holds open for this route (org-scoped; this
    // path is not one of SELF_MANAGED_DB_CONTEXT_ACTIONS). Previously the CAS
    // committed in its own system transaction first and every persistence
    // failure below was caught and answered `{success:true}`, so the history
    // said "completed" while the feature record was missing and the row
    // refused any resubmission. Now a persistence failure rolls back to the
    // savepoint — CAS included — the row is parked as a reopenable
    // `result_processing_failed`, and the agent gets a 500.
    //
    // The CAS moved off `runOutsideDbContext + withSystemDbAccessContext`:
    // device_commands has no RLS (intentionally system-scoped), so the org
    // request context changes nothing about what the write can touch, and it is
    // still an explicit context (#1375). READ COMMITTED re-evaluates the
    // predicate against the latest committed row, so the CAS semantics are
    // unchanged; a concurrent duplicate simply waits on the row lock and then
    // matches 0 rows. Holding that lock for the rest of the request is safe: no
    // handler writes this row on a separate connection (swept for #3530).
    //
    // BREEZE-X: the 0-row branch gets its own `cas_label` and the same
    // `prior_status` tag as the WS twin, so a cross-transport race can be
    // confirmed from either side. It should be RARER than the WS twin because
    // the terminal pre-read above usually short-circuits first — which is
    // itself a useful signal.
    const terminalCompletedAt = new Date();
    const storedCommandResult = buildStoredCommandResult(command.type, normalizedData, stdout);
    const commandPayload =
      command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
        ? command.payload as Record<string, unknown>
        : {};
    const drExecutionId =
      DR_COMMAND_TYPES.has(command.type) && typeof commandPayload.drExecutionId === 'string'
        ? commandPayload.drExecutionId
        : null;
    let pamAcknowledgement: PamResultAcknowledgement | undefined;

    let finalized: 'stale' | 'queue_ack' | 'rejected' | 'recorded';
    try {
      finalized = await withDbTransaction(async () => {
        let updated: unknown;
        const updatedRows = await dbWriteExpectingRows(
          'device_commands.rest_result_terminal_cas',
          async () => {
            const query = db
              .update(deviceCommands)
              .set({
                status: normalizedData.status === 'completed' ? 'completed' : 'failed',
                completedAt: terminalCompletedAt,
                // D20-D: a queue-ack stays 'completed' at the top level (the
                // caller — e.g. a HTTP-polling agent's dispatch loop — must
                // still see it as delivered) but the STORED result.status is
                // overridden to the marker so commandAcceptsAgentResultCondition
                // reopens the row for the real terminal result later.
                result: isBackupAck
                  ? { ...storedCommandResult, status: BACKUP_QUEUE_ACK_RESULT_STATUS }
                  : storedCommandResult,
                // Credentials ride the payload for some command types (FileVault
                // rotation, and the #3409 script secret envelope); strip them
                // once the command is terminal. Shared with the ten other
                // terminal writers that previously retained them.
                ...terminalPayloadErasureSet(),
              })
              .where(and(
                eq(deviceCommands.id, commandId),
                eq(deviceCommands.deviceId, deviceId),
                eq(deviceCommands.targetRole, agent.role),
                commandAcceptsAgentResultCondition()
              )) as any;

            updated = typeof query.returning === 'function'
              ? await query.returning({ id: deviceCommands.id })
              : await query;

            return Array.isArray(updated) ? updated : [];
          },
          () => commandCasPriorStatusTags(commandId)
        );

        if (updated === undefined) {
          console.warn(`[agents] command result update returned undefined for ${commandId} — treating as failed update`);
        }
        if (updatedRows.length === 0) return 'stale';

        if (isBackupAck) {
          // D20-D: non-terminal signal — no applyCommandAutomationTerminal, no
          // per-type handler dispatch. Without this guard,
          // handleProviderBackedBackupResult would parse {"queued":true}/
          // {"started":true} against the all-optional backupCommandResultSchema,
          // "succeed" vacuously, and mark the backup_jobs row completed with no
          // snapshot at all — a false-positive this fix would otherwise
          // introduce now that the command payload carries jobId (D20-E).
          return 'queue_ack';
        }

        if (validationError) return 'rejected';

        // Per-type persistence. Every failure PROPAGATES (#3530) — the
        // catch below turns it into a rollback + park + 500. Genuinely
        // best-effort follow-ups (the post-apply audit-policy re-collect, DR
        // reconcile enqueue, topology telemetry) run after the savepoint.
        if (
          command.type === securityCommandTypes.collectStatus ||
          command.type === securityCommandTypes.scan ||
          command.type === securityCommandTypes.quarantine ||
          command.type === securityCommandTypes.remove ||
          command.type === securityCommandTypes.restore
        ) {
          await handleSecurityCommandResult(command, normalizedData);
        }

        if (command.type === filesystemAnalysisCommandType) {
          await handleFilesystemAnalysisCommandResult(command, normalizedData, agent.orgId);
        }

        if (
          command.type === sensitiveDataCommandTypes.scan ||
          command.type === sensitiveDataCommandTypes.encrypt ||
          command.type === sensitiveDataCommandTypes.secureDelete ||
          command.type === sensitiveDataCommandTypes.quarantine
        ) {
          await handleSensitiveDataCommandResult(command, normalizedData);
        }

        // Software-install results carry the persisted command UUID. Reconcile
        // deployment_results using the authenticated device and the
        // server-written deploymentId/retryCount payload. The helper's
        // pending-status and attempt guards make replays and retry-superseded
        // results a no-op.
        if (command.type === 'software_install') {
          // #5128: shared with the websocket transport so the two cannot drift.
          await reconcileSoftwareInstallResult(command, deviceId, normalizedData);
        }

        if (command.type === 'software_uninstall') {
          await handleSoftwareRemediationCommandResult(command, normalizedData);
        }

        if (command.type === 'collect_audit_policy' && normalizedData.status === 'completed') {
          await processCollectedAuditPolicyCommandResult(command.deviceId, stdout);
        }

        if (command.type === 'cis_benchmark' || command.type === 'apply_cis_remediation') {
          await handleCisCommandResult(command, normalizedData);
        }

        if (command.type === 'backup_verify' || command.type === 'backup_test_restore') {
          await processBackupVerificationResult(commandId, {
            status: normalizedData.status,
            stdout,
            error: normalizedData.error,
          });
        }

        if (
          command.type === 'backup_restore' ||
          command.type === 'bmr_recover' ||
          command.type === 'vm_restore_from_backup' ||
          command.type === 'vm_instant_boot'
        ) {
          await updateRestoreJobByCommandId({
            commandId,
            deviceId: command.deviceId,
            commandType: command.type,
            result: normalizedData,
          });
        }

        if (command.type === CommandTypes.VAULT_SYNC) {
          await applyVaultSyncCommandResult({
            deviceId: command.deviceId,
            command,
            resultStatus: normalizedData.status,
            stdout,
            stderr: normalizedData.stderr,
            error: normalizedData.error,
          });
        }

        if (drExecutionId) {
          const { handleDrCommandResult } = await import('../backup/drResultHandler');
          await handleDrCommandResult({
            commandId,
            commandType: command.type,
            deviceId: command.deviceId,
            status: normalizedData.status,
            result: normalizedData.result,
            payload: commandPayload,
          });
        }

        // #3097 — the shared per-type handlers this transport never registered.
        //
        // No extra DB-context wrap: agentAuthMiddleware's request-long org
        // context (scope 'organization', the device's orgId, accessibleOrgIds
        // [orgId], no partner access) is the one this savepoint sits in — the
        // same shape the websocket's finalize wrap builds. Opening a second real
        // transaction would be the #1105 double-hold this route was cleaned up
        // to avoid.
        if (REGISTRY_DISPATCHED_COMMAND_TYPES.has(command.type)) {
          // Imported dynamically: the registry pulls in the discovery and SNMP
          // workers, and through them the Drizzle schema module, which is more
          // than this hot route should carry in its static graph — and enough
          // to break suites that partially mock `db/schema`.
          const { commandResultHandlers } = await import('../../services/commandResultHandlers');
          const handler = commandResultHandlers[command.type];
          if (handler) {
            const outcome = await handler({
              // Handlers use this for log lines and one audit `actorId`, never
              // a lookup. Prefer the authenticated agent record over the path
              // param, matching this route's own writeAuditEvent actor below.
              agentId: agent.agentId ?? agentId,
              command,
              commandId,
              result: normalizedData,
              // The lookup above constrains deviceId to the authenticated
              // agent's device, so these are the same value the websocket
              // resolves.
              resolvedDeviceId: command.deviceId,
              stdout,
            });
            if (PAM_COMMAND_TYPES.has(command.type)) {
              if (!outcome || outcome.kind !== 'pam') {
                throw new Error(`PAM result handler returned no acknowledgement for ${command.type}`);
              }
              pamAcknowledgement = {
                protocolVersion: 1,
                classification: outcome.classification,
              };
            }
          }
        }
        return 'recorded';
      });
    } catch (persistErr) {
      // The savepoint rolled back: the CAS and any partial persistence are
      // gone and the request transaction is usable again. Park the row as
      // failed + reopenable on it (committed with the request), so the history
      // is honest and a resubmission is reprocessed. No terminal audit and no
      // automation terminal — neither describes what happened.
      console.error(
        `[agents] failed to record ${command.type} result ${commandId}; command parked as result_processing_failed:`,
        persistErr,
      );
      captureException(persistErr, undefined, {
        command_result_phase: 'rest_result_persistence',
        commandType: command.type,
        commandId,
      });
      try {
        await markCommandResultProcessingFailed({
          commandId,
          deviceId,
          targetRole: agent.role,
          storedResult: storedCommandResult,
        });
      } catch (markErr) {
        // The row keeps its pre-result state and the stale reaper will fail
        // it; the persistence failure above is already reported.
        console.error(`[agents] failed to park command ${commandId} as result_processing_failed:`, markErr);
        captureException(markErr, undefined, {
          command_result_phase: 'rest_result_processing_failed_mark',
          commandId,
        });
      }
      return c.json({ error: 'result_processing_failed' }, 500);
    }

    if (finalized === 'stale') {
      await recordSupplementalCleanup();
      return c.json({ success: true });
    }
    if (finalized === 'queue_ack') return c.json({ success: true });

    // The guarded command transition is the authority, so the automation
    // ledger follows it only once it (and its persistence) succeeded. Before
    // the validation-error return so malformed terminal frames cannot strand an
    // automation action after the command itself became terminal.
    await applyCommandAutomationTerminal({
      commandId,
      result: normalizedData,
      output: stdout ?? null,
      error: normalizedData.error ?? normalizedData.stderr ?? null,
      completedAt: terminalCompletedAt,
    });

    if (finalized === 'rejected') {
      console.warn(`[agents] ${validationError}`);
      return c.json({ success: true });
    }

    if (command.type === CommandTypes.APPLY_AUDIT_POLICY_BASELINE && normalizedData.status === 'completed') {
      // Best-effort follow-up (#3530 classification): this enqueues a NEW
      // verification command; it persists nothing about this result.
      try {
        // Break out of the request-scoped transaction so the follow-up command
        // row is committed before the agent can submit its result.
        const collectResult = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            queueCommandForExecution(
              command.deviceId,
              CommandTypes.COLLECT_AUDIT_POLICY,
              {},
              { preferHeartbeat: false }
            )
          )
        );
        if (!collectResult.command) {
          const errMsg = `failed to enqueue post-apply audit policy collection for ${commandId}: ${collectResult.error ?? 'unknown error'}`;
          console.error(`[agents] ${errMsg}`);
          captureException(new Error(errMsg));
        }
      } catch (err) {
        console.error(`[agents] post-apply verification enqueue failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    // Topology ingestion stays best-effort and outside the savepoint (#3530
    // classification): both sinks deliberately open their own bounded system
    // transaction, so they cannot share the CAS's, and they are observational
    // telemetry re-collected on the next diagnostic / poll cycle.
    if (command.type === 'network_diagnostic') {
      try {
        const { ingestTopologyDiagnosticCommandResult } = await import(
          '../../services/topology/diagnosticResults'
        );
        await ingestTopologyDiagnosticCommandResult({
          commandType: command.type,
          deviceId: command.deviceId,
          agentId: agent?.agentId ?? agentId,
          commandId,
          result: normalizedData.result,
        });
      } catch (err) {
        console.error(`[agents] topology diagnostic post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'topology_interface_poll') {
      try {
        const { ingestTopologyInterfacePollResult } = await import('../../services/topology/snmpInterfaceMetrics');
        await ingestTopologyInterfacePollResult({
          commandType: command.type,
          commandId,
          deviceId: command.deviceId,
          status: normalizedData.status,
          result: normalizedData.result,
          stdout: normalizedData.stdout,
        });
      } catch (err) {
        console.error(`[agents] topology interface poll post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    // Best-effort: the DR worker also reconciles on its own schedule.
    if (drExecutionId) {
      try {
        const { enqueueDrExecutionReconcile } = await import('../../jobs/drExecutionWorker');
        await enqueueDrExecutionReconcile(drExecutionId);
      } catch (err) {
        console.error(`[agents] DR reconcile enqueue failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    writeAuditEvent(c, {
      orgId: agent?.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: commandId,
      details: {
        commandType: command.type,
        status: normalizedData.status,
        exitCode: normalizedData.exitCode ?? null,
      },
      result: normalizedData.status === 'completed' ? 'success' : 'failure',
    });

    return c.json(pamAcknowledgement ?? { success: true });
  }
);
