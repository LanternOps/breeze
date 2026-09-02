import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
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
import { processCollectedAuditPolicyCommandResult } from '../../services/auditBaselineService';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { decryptClaimedCommandsForDelivery } from '../../services/commandDelivery';
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
  applySoftwareInstallResult,
  SW_INSTALL_COMMAND_ID_REGEX,
} from '../../services/softwareDeploymentResult';

import {
  ACCEPTED_COMMAND_RESULT_STATUSES,
  commandAcceptsAgentResult,
  commandAcceptsAgentResultCondition,
} from '../../services/commandResultAcceptance';
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
  'network_discovery',
  'hyperv_backup',
  'mssql_backup',
  'snmp_poll',
  'script',
  'peripheral_policy_sync_v2',
  'pam_apply_v2',
  'pam_cleanup_v2',
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
    status: data.status,
    exitCode: data.exitCode,
    stdout: stdout != null && !skipStdoutRedaction ? redactSecretsFromOutput(stdout) : stdout,
    stderr: data.stderr != null ? redactSecretsFromOutput(data.stderr) : data.stderr,
    durationMs: data.durationMs,
    error: data.error != null ? redactSecretsFromOutput(data.error) : data.error,
  };
}

function normalizeCriticalResultIfNeeded(
  commandType: string,
  commandId: string,
  data: z.infer<typeof commandResultSchema>
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
    });

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
  // longer pure CPU: `decryptClaimedCommandsForDelivery` first runs the
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
      return decryptClaimedCommandsForDelivery(commands);
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
// permits while the agent sits on a narrowed drain surface. Being on the drain
// ROUTE allowlist is not the same as being harmless: this route has a second,
// id-shaped entrance.
//
// A NON-UUID commandId short-circuits into the `sw-install-…` branch, which
// writes deployment history via `applySoftwareInstallResult` with NO
// `device_commands` row to consult — its only gate is that the device UUID
// embedded in the caller-supplied id matches the authenticated device. A
// command-type allowlist cannot see that path at all, so a draining agent could
// keep stamping deployment_results rows for its org. Refuse the whole shape
// while draining; the drain only ever delivers real, UUID-keyed
// `device_commands` rows.
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
      // Software install commands carry their tracking IDs in the commandId
      // itself: `sw-install-<deploymentUuid>-<deviceUuid>-<attemptNumber>`.
      // Persist the outcome to deployment_results so the dashboard reflects
      // reality. The attempt suffix is optional (legacy ids default to 0);
      // applySoftwareInstallResult rejects results whose attempt no longer
      // matches the row's current retryCount (superseded by a retry).
      const swInstallMatch = commandId.match(SW_INSTALL_COMMAND_ID_REGEX);
      if (swInstallMatch) {
        const [, deploymentIdFromCmd, deviceIdFromCmd, attemptFromCmd] = swInstallMatch;
        if (deploymentIdFromCmd && deviceIdFromCmd && deviceIdFromCmd === deviceId) {
          await applySoftwareInstallResult({
            deploymentId: deploymentIdFromCmd,
            deviceId,
            status: data.status,
            exitCode: data.exitCode,
            stdout: data.stdout,
            stderr: data.stderr,
            error: data.error,
            startedAt: data.startedAt,
            durationMs: data.durationMs,
            attemptNumber: attemptFromCmd ? parseInt(attemptFromCmd, 10) : 0,
          });
        }
      }
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
    if (!commandAcceptsAgentResult(command.status, command.result)) {
      return c.json({ success: true });
    }

    const {
      normalizedData: rawNormalizedData,
      stdout: rawStdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, commandId, data);

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

    // Terminal compare-and-set, outside the agentAuth transaction for the same
    // visibility reasons as the lookup above, and under an explicit system
    // context so this is not a contextless bare-pool write (#1375). Mirrors the
    // WS twin in agentWs.processCommandResult; device_commands is intentionally
    // system-scoped (no RLS), so the context changes nothing about what the
    // write can touch — it makes the guard's invariant in db/index.ts true on
    // this path too. Without it, this route was the largest remaining source of
    // BREEZE-7 events after the WS path was fixed.
    //
    // BREEZE-X: this branch used to return `{success:true}` silently on 0 rows,
    // so the WS twin's Sentry warning had no REST-side counterpart to correlate
    // against — you could not confirm a cross-transport race from one side
    // alone. It gets its own `cas_label` and the same `prior_status` tag. It
    // should be RARER than the WS twin because the terminal pre-read above
    // usually short-circuits first — which is itself a useful signal.
    let updated: unknown;
    const terminalCompletedAt = new Date();
    const updatedRows = await runOutsideDbContext(async () => withSystemDbAccessContext(async () =>
      dbWriteExpectingRows(
        'device_commands.rest_result_terminal_cas',
        async () => {
          const query = db
            .update(deviceCommands)
            .set({
              status: normalizedData.status === 'completed' ? 'completed' : 'failed',
              completedAt: terminalCompletedAt,
              result: buildStoredCommandResult(command.type, normalizedData, stdout),
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
      )
    ));

    if (updated === undefined) {
      console.warn(`[agents] command result update returned undefined for ${commandId} — treating as failed update`);
    }

    if (updatedRows.length === 0) {
      return c.json({ success: true });
    }

    // The guarded command transition is the authority. Reconcile before the
    // validation-error return so malformed terminal frames cannot strand an
    // automation action after the command itself became terminal.
    await applyCommandAutomationTerminal({
      commandId,
      result: normalizedData,
      output: stdout ?? null,
      error: normalizedData.error ?? normalizedData.stderr ?? null,
      completedAt: terminalCompletedAt,
    });

    if (validationError) {
      console.warn(`[agents] ${validationError}`);
      return c.json({ success: true });
    }

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === filesystemAnalysisCommandType) {
      try {
        await handleFilesystemAnalysisCommandResult(command, normalizedData, agent.orgId);
      } catch (err) {
        console.error(`[agents] filesystem analysis post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (
      command.type === sensitiveDataCommandTypes.scan ||
      command.type === sensitiveDataCommandTypes.encrypt ||
      command.type === sensitiveDataCommandTypes.secureDelete ||
      command.type === sensitiveDataCommandTypes.quarantine
    ) {
      try {
        await handleSensitiveDataCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] sensitive data post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    // Offline-queued software installs (dispatchSoftwareInstallToDevice
    // fallback): the result arrives with the device_commands UUID instead of
    // the sw-install-<deployment>-<device>-<attempt> id, so reconcile the
    // matching deployment_results row here. deviceId comes from the
    // authenticated agent context; the payload's deploymentId/retryCount were
    // written server-side at queue time (see buildAndDispatchSoftwareInstalls).
    // The status='pending' + retryCount=attempt guard in the helper makes
    // replays AND results from a retry-superseded queued command a no-op.
    if (command.type === 'software_install') {
      try {
        const payload =
          command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
            ? (command.payload as Record<string, unknown>)
            : {};
        if (typeof payload.deploymentId === 'string') {
          await applySoftwareInstallResult({
            deploymentId: payload.deploymentId,
            deviceId,
            status: normalizedData.status,
            exitCode: normalizedData.exitCode,
            stdout: normalizedData.stdout,
            stderr: normalizedData.stderr,
            error: normalizedData.error,
            startedAt: normalizedData.startedAt,
            durationMs: normalizedData.durationMs,
            attemptNumber: typeof payload.retryCount === 'number' ? payload.retryCount : 0,
          });
        }
      } catch (err) {
        console.error(`[agents] software install deployment-result reconciliation failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'software_uninstall') {
      try {
        await handleSoftwareRemediationCommandResult(command, normalizedData);
      } catch (err) {
        const policyId = command.payload && typeof command.payload === 'object'
          ? (command.payload as Record<string, unknown>).policyId ?? 'unknown'
          : 'unknown';
        console.error(
          `[agents] software remediation post-processing failed for command ${commandId} ` +
          `(device ${command.deviceId}, policy ${policyId}) — device may be stuck in_progress:`,
          err
        );
        captureException(err);
      }
    }

    if (command.type === 'collect_audit_policy' && normalizedData.status === 'completed') {
      try {
        await processCollectedAuditPolicyCommandResult(command.deviceId, stdout);
      } catch (err) {
        console.error(`[agents] audit policy command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === CommandTypes.APPLY_AUDIT_POLICY_BASELINE && normalizedData.status === 'completed') {
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

    if (command.type === 'cis_benchmark' || command.type === 'apply_cis_remediation') {
      try {
        await handleCisCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] CIS command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'backup_verify' || command.type === 'backup_test_restore') {
      try {
        await processBackupVerificationResult(commandId, {
          status: normalizedData.status,
          stdout,
          error: normalizedData.error,
        });
      } catch (err) {
        console.error(`[agents] backup verification post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (
      command.type === 'backup_restore' ||
      command.type === 'bmr_recover' ||
      command.type === 'vm_restore_from_backup' ||
      command.type === 'vm_instant_boot'
    ) {
      try {
        await updateRestoreJobByCommandId({
          commandId,
          deviceId: command.deviceId,
          commandType: command.type,
          result: normalizedData,
        });
      } catch (err) {
        console.error(`[agents] restore job post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === CommandTypes.VAULT_SYNC) {
      try {
        await applyVaultSyncCommandResult({
          deviceId: command.deviceId,
          command,
          resultStatus: normalizedData.status,
          stdout,
          stderr: normalizedData.stderr,
          error: normalizedData.error,
        });
      } catch (err) {
        console.error(`[agents] vault sync post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (DR_COMMAND_TYPES.has(command.type)) {
      try {
        const commandPayload =
          command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
            ? command.payload as Record<string, unknown>
            : {};
        if (typeof commandPayload.drExecutionId === 'string') {
          const { handleDrCommandResult } = await import('../backup/drResultHandler');
          await handleDrCommandResult({
            commandId,
            commandType: command.type,
            deviceId: command.deviceId,
            status: normalizedData.status,
            result: normalizedData.result,
            payload: commandPayload,
          });

          const { enqueueDrExecutionReconcile } = await import('../../jobs/drExecutionWorker');
          await enqueueDrExecutionReconcile(commandPayload.drExecutionId);
        }
      } catch (err) {
        console.error(`[agents] DR command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    // #3097 — the shared per-type handlers this transport never registered.
    //
    // No DB-context wrap here, unlike the websocket twin's
    // `runWithAgentOrgDbAccess`: agentAuthMiddleware already holds an
    // org-scoped `withDbAccessContext` open around this whole request, with the
    // same shape the websocket wrap builds (scope 'organization', the device's
    // orgId, accessibleOrgIds [orgId], no partner access). The websocket needs
    // its own wrap only because that path deliberately runs contextless (#3021).
    // This route is not one of the SELF_MANAGED_DB_CONTEXT_ACTIONS — those match
    // on the final path segment, which here is `result`, not `commands` — so the
    // request-long wrap is active. Adding a nested one would be a no-op anyway:
    // `withDbAccessContext` returns `fn()` unchanged when a context is already
    // on the async-local store, and opening a second real transaction is the
    // #1105 double-hold this route was explicitly cleaned up to avoid.
    let pamAcknowledgement: PamResultAcknowledgement | undefined;
    if (REGISTRY_DISPATCHED_COMMAND_TYPES.has(command.type)) {
      // Imported dynamically, like the DR handler below: the registry pulls in
      // the discovery and SNMP workers, and through them the Drizzle schema
      // module, which is more than this hot route should carry in its static
      // graph — and enough to break suites that partially mock `db/schema`.
      const { commandResultHandlers } = await import('../../services/commandResultHandlers');
      const handler = commandResultHandlers[command.type];
      if (handler) {
        try {
          const outcome = await handler({
            // Handlers use this for log lines and one audit `actorId`, never a
            // lookup. Prefer the authenticated agent record over the path
            // param, matching this route's own writeAuditEvent actor below.
            agentId: agent.agentId ?? agentId,
            command,
            commandId,
            result: normalizedData,
            // The lookup above constrains deviceId to the authenticated agent's
            // device, so these are the same value the websocket resolves.
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
        } catch (err) {
          console.error(`[agents] shared ${command.type} result handler failed for ${commandId}:`, err);
          captureException(err);
          if (PAM_COMMAND_TYPES.has(command.type)) throw err;
        }
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
