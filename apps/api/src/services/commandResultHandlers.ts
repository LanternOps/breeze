/**
 * Shared agent command-result handlers (#3097).
 *
 * These handlers were defined inside `routes/agentWs.ts`, where only the
 * WebSocket transport could reach them. Results submitted over the HTTP path
 * (`routes/agents/commands.ts`) therefore never ran them at all — most visibly,
 * `script` results never reached `script_executions`, leaving rows pending until
 * the stale reaper stamped them `timeout`.
 *
 * Nothing here is new: the handler bodies below are the ones that were in
 * `agentWs.ts`, moved verbatim so both transports dispatch the same code. The
 * module boundary is the only thing that changed.
 */

import { z } from 'zod';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import {
  deviceCommands,
  discoveryJobs,
  scriptExecutions,
  scriptExecutionBatches,
  backupJobs,
} from '../db/schema';
import { enqueueDiscoveryResults, type DiscoveredHostResult, type DeviceAdjacency } from '../jobs/discoveryWorker';
import { enqueueSnmpPollResults, type SnmpMetricResult } from '../jobs/snmpWorker';
import { isRedisAvailable } from './redis';
import { processBackupVerificationResult } from '../routes/backup/verificationService';
import { applyBackupCommandResultToJob } from './backupResultPersistence';
import { applyVaultSyncCommandResult } from './vaultSyncPersistence';
import { backupCommandResultSchema } from '../routes/backup/resultSchemas';
import { describeZodIssues } from '../lib/zodIssues';
import { redactSecretsFromOutput, redactOptionalSecretText } from './secretRedaction';
import { updateRestoreJobByCommandId } from './restoreResultPersistence';
import { captureException } from './sentry';
import { applyScriptCustomFieldWrites } from './customFields/scriptWriteBack';
import type { ScriptCustomFieldWriteSummary } from '../db/schema/scripts';
import { PG_UUID_REGEX, UUID_REGEX } from '../utils/uuid';
// #3097: one definition of the agent command-result shape for BOTH transports.
// `schemas.ts` measures the 1 MB cap with `Buffer.byteLength` (bytes); the copy
// that used to live in `agentWs.ts` used `.length` (UTF-16 code units), so the
// websocket path accepted roughly 3x the intended budget for CJK-heavy output
// while the REST path rejected at 1 MB. The byte-accurate one wins.
import { commandResultSchema } from '../routes/agents/schemas';
import { applyAutomationActionTerminal } from './automationActionResults';
import { handlePeripheralPolicyResultV2 } from './peripheralPolicyState';
import {
  pamAgentResultV2Schema,
  recordPamActuationResult,
  type PamActuationResultClassification,
} from './pamActuationResult';

export type CommandResultHandlerOutcome =
  | { kind: 'pam'; classification: PamActuationResultClassification }
  | void;

export type CommandResultHandler = (params: {
  agentId: string;
  command: typeof deviceCommands.$inferSelect;
  /**
   * #3097: supplied by the transport, never read off the payload.
   *
   * The websocket envelope carries `commandId` inline; the REST route takes it
   * from the path (`/:id/commands/:commandId/result`) and authorizes against
   * that path value. Accepting an agent-supplied id in the body would let a
   * handler act on one command while ownership was checked against another —
   * so there is exactly one id here, and the transport that authorized it is
   * the transport that passes it.
   */
  commandId: string;
  result: z.infer<typeof commandResultSchema>;
  resolvedDeviceId: string;
  stdout: string | undefined;
}) => Promise<CommandResultHandlerOutcome>;

// ---------------------------------------------------------------------------
// Per-command-type result handlers (used by the dispatch map in processCommandResult)
// ---------------------------------------------------------------------------

/** Coerce Date instances in host firstSeen/lastSeen to ISO strings so Zod datetime validation passes. */
export function normalizeDiscoveryHosts(hosts: DiscoveredHostResult[]): DiscoveredHostResult[] {
  return hosts.map(h => ({
    ...h,
    firstSeen: (h.firstSeen as any) instanceof Date ? (h.firstSeen as any).toISOString() : h.firstSeen,
    lastSeen: (h.lastSeen as any) instanceof Date ? (h.lastSeen as any).toISOString() : h.lastSeen,
  }));
}

async function handleDiscoveryResult({ agentId, command, result, commandId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  const payload = command.payload as Record<string, unknown> | null;
  const expectedJobId = typeof payload?.jobId === 'string' ? payload.jobId : null;
  try {
    const discoveryData = result.result as {
      jobId?: string;
      hosts?: DiscoveredHostResult[];
      hostsScanned?: number;
      hostsDiscovered?: number;
      adjacency?: DeviceAdjacency[];
    } | undefined;

    if (discoveryData?.hosts) {
      if (!expectedJobId || discoveryData.jobId !== expectedJobId) {
        console.warn(
          `[AgentWs] Rejecting mismatched discovery result ${commandId} from agent ${agentId}: ` +
          `sentJob=${discoveryData.jobId ?? 'none'} expected=${expectedJobId ?? 'none'}`
        );
        return;
      }
    }

    if (expectedJobId && discoveryData?.hosts) {
      // Look up the job to get orgId and siteId
      const [job] = await db
        .select({ orgId: discoveryJobs.orgId, siteId: discoveryJobs.siteId })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, expectedJobId))
        .limit(1);

      if (job && isRedisAvailable()) {
        const normalizedHosts = normalizeDiscoveryHosts(discoveryData.hosts);
        // Exit the held org-scoped transaction context for the Redis
        // round-trips (#1105) — see the note on the monitor-result branch.
        await runOutsideDbContext(() => enqueueDiscoveryResults(
          expectedJobId,
          job.orgId,
          job.siteId,
          normalizedHosts,
          discoveryData.hostsScanned ?? 0,
          discoveryData.hostsDiscovered ?? 0,
          undefined,
          discoveryData.adjacency ?? [],
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:script-network-scan',
          }
        ));
      } else if (job) {
        // Redis not available — mark job failed so user knows results weren't processed
        console.warn(`[AgentWs] Redis unavailable, cannot process ${discoveryData.hosts.length} discovery hosts for job ${expectedJobId}`);
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            hostsDiscovered: discoveryData.hostsDiscovered ?? 0,
            hostsScanned: discoveryData.hostsScanned ?? 0,
            errors: { message: 'Results received but could not be processed: job queue unavailable' },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, expectedJobId));
      } else {
        console.warn(
          `[AgentWs] Discovery job ${expectedJobId} not found in DB — ` +
          `discarding ${discoveryData.hosts.length} host(s) from agent ${agentId}`
        );
      }
    }
  } catch (err) {
    console.error(`[AgentWs] Failed to process discovery results for ${agentId}:`, err);
    captureException(err);
    if (expectedJobId) {
      try {
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: { message: err instanceof Error ? err.message : 'Failed to enqueue discovery results' },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, expectedJobId));
      } catch (dbErr) {
        console.error(`[AgentWs] Additionally failed to mark discovery job ${expectedJobId} as failed:`, dbErr);
      }
    }
  }
}

async function handleBackupVerificationResult({ agentId, result, stdout, commandId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    await processBackupVerificationResult(commandId, {
      status: result.status,
      stdout,
      error: result.error,
    });
  } catch (err) {
    console.error(`[AgentWs] Failed to process backup verification result for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleVmRestoreResult({ agentId, command, result, resolvedDeviceId, commandId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    await updateRestoreJobByCommandId({
      commandId: commandId,
      deviceId: resolvedDeviceId,
      commandType: command.type,
      result,
    });
  } catch (err) {
    console.error(`[AgentWs] Failed to process queued restore result for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleProviderBackedBackupResult({ agentId, command, result, resolvedDeviceId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const payload =
      command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
        ? command.payload as Record<string, unknown>
        : {};
    const backupJobId =
      typeof payload.backupJobId === 'string'
        ? payload.backupJobId
        : typeof payload.jobId === 'string' && UUID_REGEX.test(payload.jobId)
          ? payload.jobId
          : null;

    if (backupJobId) {
      const [backupJob] = await db
        .select({
          id: backupJobs.id,
          orgId: backupJobs.orgId,
          deviceId: backupJobs.deviceId,
        })
        .from(backupJobs)
        .where(
          and(
            eq(backupJobs.id, backupJobId),
            eq(backupJobs.deviceId, resolvedDeviceId)
          )
        )
        .limit(1);

      if (backupJob) {
        const parsedBackup = backupCommandResultSchema.safeParse(result.result ?? {});
        if (!parsedBackup.success) {
          await applyBackupCommandResultToJob({
            jobId: backupJob.id,
            orgId: backupJob.orgId,
            deviceId: backupJob.deviceId,
            resultStatus: 'failed',
            result: {
              error: `Malformed backup result payload: ${describeZodIssues(parsedBackup.error)}`,
            },
          });
        } else {
          await applyBackupCommandResultToJob({
            jobId: backupJob.id,
            orgId: backupJob.orgId,
            deviceId: backupJob.deviceId,
            resultStatus: result.status,
            // Provider-backed backups do not report `partial` today, but this
            // path parses the agent's status and must not be the one place
            // that silently discards it.
            agentStatus: parsedBackup.data.status,
            result: {
              ...parsedBackup.data,
              error: result.error || result.stderr,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error(`[AgentWs] Failed to process ${command.type} backup result for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleVaultSyncResult({ agentId, command, result, resolvedDeviceId, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    await applyVaultSyncCommandResult({
      deviceId: resolvedDeviceId,
      command,
      resultStatus: result.status,
      stdout,
      stderr: result.stderr,
      error: result.error,
    });
  } catch (err) {
    console.error(`[AgentWs] Failed to process vault sync result for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleSnmpPollResult({ agentId, command, result, commandId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const payload = command.payload as Record<string, unknown> | null;
    const expectedDeviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : null;
    const snmpData = result.result as {
      deviceId?: string;
      metrics?: SnmpMetricResult[];
    } | undefined;

    if (snmpData?.deviceId && snmpData.metrics && snmpData.metrics.length > 0) {
      if (!expectedDeviceId || snmpData.deviceId !== expectedDeviceId) {
        console.warn(
          `[AgentWs] Rejecting mismatched SNMP result ${commandId} from agent ${agentId}: ` +
          `sentDevice=${snmpData.deviceId} expected=${expectedDeviceId ?? 'none'}`
        );
        return;
      }
      if (isRedisAvailable()) {
        const metrics = snmpData.metrics;
        // Exit the held org-scoped transaction context for the Redis
        // round-trips (#1105) — see the note on the monitor-result branch.
        await runOutsideDbContext(() => enqueueSnmpPollResults(expectedDeviceId, metrics));
      } else {
        // Redis not available — log warning about dropped metrics and mark status
        console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${expectedDeviceId}`);
        const { snmpDevices } = await import('../db/schema');
        await db
          .update(snmpDevices)
          .set({
            lastPolled: new Date(),
            // The device answered; only our own pipeline failed. Clear the
            // failure backoff (#3217) so a Redis outage doesn't march every
            // healthy SNMP target to 'offline' and a one-hour interval.
            lastPollAttemptedAt: new Date(),
            consecutiveFailures: 0,
            lastStatus: 'warning'
          })
          .where(eq(snmpDevices.id, expectedDeviceId));
      }
    }
  } catch (err) {
    console.error(`[AgentWs] Failed to process SNMP poll results for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const payload = command.payload as Record<string, unknown> | null;
    const executionId = payload?.executionId as string | undefined;

    // #2698 — a script may write its own device's custom fields by emitting
    // `::breeze:custom-fields:: {...}` on stdout (or, from agent Wave 3, a
    // versioned `result.customFieldWrites` envelope). Deliberately placed
    // ahead of the executionId guards and outside the exit-code branch: a
    // script that discovers a fact and then exits non-zero, or that was
    // dispatched without a (valid) executionId, has still discovered it.
    //
    // Its own try/catch: losing a custom-field write must never cost the
    // stdout persistence this handler exists for. That is exactly the
    // regression class documented at length below (#3162, #3607).
    let customFieldResult: ScriptCustomFieldWriteSummary | null = null;
    try {
      customFieldResult = await applyScriptCustomFieldWrites({
        deviceId: resolvedDeviceId,
        agentId,
        commandId: command.id,
        stdout,
        resultEnvelope: result.result,
      });
      if (customFieldResult && customFieldResult.rejected.length > 0) {
        console.warn('[AgentWs] script custom-field write-back rejected entries', {
          commandId: command.id,
          deviceId: resolvedDeviceId,
          rejected: customFieldResult.rejected,
        });
      }
    } catch (err) {
      // The summary is discarded rather than partially persisted: a half-built
      // summary would misreport what actually landed. Engineering still sees
      // the failure via Sentry; the operator sees a run with no write-back,
      // which is the honest reading of "we do not know what happened".
      console.error(`[AgentWs] Custom-field write-back failed for command ${command.id}:`, err);
      captureException(err, undefined, { commandId: command.id, agentId });
      customFieldResult = null;
    }

    // #3162: `script_executions.id` is a uuid column, so a non-uuid
    // executionId makes the UPDATE below throw with `invalid input syntax for
    // type uuid` — swallowed by the catch at the bottom of this function,
    // taking the agent's stdout with it.
    //
    // Nothing should mint a non-uuid executionId any more (the automation
    // `execute_command` action, the only producer, now omits the field
    // entirely). This guard is for commands queued BEFORE that deploy and still
    // in flight, so it reports rather than silently skipping: a fresh non-uuid
    // id means an unknown producer is sending garbage.
    if (executionId && !PG_UUID_REGEX.test(executionId)) {
      console.warn(
        `[AgentWs] Skipping script_executions update for non-uuid executionId ${executionId} (command ${command.id})`
      );
      captureException(
        new Error('Non-uuid executionId in script command payload'),
        undefined,
        { commandId: command.id, agentId, executionId },
      );
      return;
    }
    if (executionId) {
      let scriptStatus: 'completed' | 'failed' | 'timeout';
      if (result.status === 'completed') {
        scriptStatus = result.exitCode && result.exitCode !== 0 ? 'failed' : 'completed';
      } else if (result.status === 'timeout') {
        scriptStatus = 'timeout';
      } else {
        scriptStatus = 'failed';
      }

      const executionValues = {
        status: scriptStatus,
        completedAt: new Date(),
        exitCode: result.exitCode ?? null,
        // #2434: script output/errors surface to scripts:read users in the
        // web UI — redact secrets before persistence (idempotent when the
        // ingest chokepoint already redacted error/stderr).
        stdout: stdout != null ? redactSecretsFromOutput(stdout) : null,
        stderr: redactOptionalSecretText(result.stderr) ?? null,
        errorMessage: redactOptionalSecretText(result.error) ?? null,
        // #2698 — null for every run that wrote nothing, the vast majority.
        customFieldResult,
      };

      const updatedExecutions = await db
        .update(scriptExecutions)
        .set(executionValues)
        .where(and(
          eq(scriptExecutions.id, executionId),
          eq(scriptExecutions.deviceId, resolvedDeviceId),
          inArray(scriptExecutions.status, ['pending', 'queued', 'running'])
        ))
        .returning({
          id: scriptExecutions.id,
          scriptId: scriptExecutions.scriptId,
        });
      let effectiveExecution = updatedExecutions[0] ?? null;

      // #3607 — second chance for an execution a server-side sweep already
      // stamped terminal.
      //
      // Widening the device_commands acceptance predicate lets a result that
      // arrives after the 60s `waitForCommandResult` deadline reach this
      // handler at all, but the execution row can meanwhile have been stamped
      // by `jobs/staleCommandReaper.ts`. The guard above would then drop the
      // real stdout at the last step — the same defect one table over.
      //
      // The predicate is NOT `status = 'timeout'`. The reaper derives the
      // execution status from the COMMAND row, and in exactly the #3607
      // scenario that row is `failed` with `result.status = 'timeout'`, so the
      // reaper stamps the execution **'failed'** (with its "#3097 delivered but
      // never recorded" message), not 'timeout'. Keying on 'timeout' alone
      // would leave the dominant path still losing output.
      //
      // So the discriminator is "this execution never received the agent's
      // output": no exit code and no stdout. Every server-side sweep leaves
      // both NULL; the only writer that fills them is this function, and it is
      // only reachable once the caller's compare-and-set has already
      // transitioned the command row — so a duplicate frame cannot get here to
      // overwrite a genuine earlier result.
      //
      // Deliberately does NOT touch the batch counters. Every writer of a
      // terminal execution status already incremented one of them for this
      // device, so the batch's slot is spent — bumping again would push
      // devicesCompleted + devicesFailed past devicesTargeted and corrupt the
      // batch's completion accounting. The cost is that a recovered success
      // stays attributed to devicesFailed in the batch summary, which is the
      // approximation the reaper already made; the per-execution row (the one
      // the UI and the AI read) is now correct.
      if (updatedExecutions.length === 0) {
        const recovered = await db
          .update(scriptExecutions)
          .set(executionValues)
          .where(and(
            eq(scriptExecutions.id, executionId),
            eq(scriptExecutions.deviceId, resolvedDeviceId),
            inArray(scriptExecutions.status, ['timeout', 'failed']),
            isNull(scriptExecutions.exitCode),
            isNull(scriptExecutions.stdout)
          ))
          .returning({
            id: scriptExecutions.id,
            scriptId: scriptExecutions.scriptId,
          });

        if (recovered.length > 0) {
          effectiveExecution = recovered[0] ?? null;
          console.warn(
            `[AgentWs] #3607 recovered late script result onto swept execution ${executionId} (command ${command.id})`
          );
        } else {
          // Both updates matched nothing. Before this PR that outcome was
          // unreachable for a late result — the command lookup rejected it
          // upstream and `processOrphanedCommandResult` logged the drop. Now
          // that acceptance is widened, this is the ONE remaining way an
          // agent's real output can be discarded here, so it must not be
          // silent (the #3162 lesson, two blocks down: report, never skip
          // quietly).
          const [current] = await db
            .select({
              status: scriptExecutions.status,
              exitCode: scriptExecutions.exitCode,
              deviceId: scriptExecutions.deviceId,
            })
            .from(scriptExecutions)
            .where(eq(scriptExecutions.id, executionId))
            .limit(1);
          const currentStatus = current?.status ?? 'row-missing';

          // `cancelled` is a BENIGN race, not a defect, and must not page.
          // routes/scripts.ts's cancel handler sets the execution to
          // 'cancelled' but only cancels the paired command `WHERE status =
          // 'pending'`. A command already 'sent' survives that, later gets the
          // reaper's provisional timeout marker, and its real result now
          // reaches this function — where 'cancelled' matches neither update.
          // Dropping the output is the CORRECT outcome there: the operator
          // asked for the run to be abandoned. Log the trail, don't alert.
          const message = 'Late script result matched no script_executions row';
          console.warn(`[AgentWs] ${message}`, {
            executionId,
            commandId: command.id,
            resolvedDeviceId,
            currentStatus,
            currentExitCode: current?.exitCode ?? null,
            currentDeviceId: current?.deviceId ?? null,
          });
          if (currentStatus !== 'cancelled') {
            captureException(new Error(message), undefined, {
              executionId,
              commandId: command.id,
              resolvedDeviceId,
              currentStatus,
            });
          }
        }
      }

      if (effectiveExecution) {
        await applyAutomationActionTerminal({
          source: 'script_execution',
          scriptExecutionId: effectiveExecution.id,
          terminalStatus: scriptStatus === 'completed' ? 'succeeded' : 'failed',
          output: executionValues.stdout,
          error: executionValues.errorMessage ?? executionValues.stderr,
          completedAt: executionValues.completedAt,
        });
      }

      // Update batch counters if this is part of a batch. `updatedExecutions`
      // is intentionally the FIRST update's rows only — the #3607 recovery
      // above is excluded from counting for the reason documented there.
      const batchId = payload?.batchId as string | undefined;
      if (batchId && updatedExecutions[0]) {
        const counterField = scriptStatus === 'completed' ? 'devicesCompleted' : 'devicesFailed';
        await db
          .update(scriptExecutionBatches)
          .set({
            [counterField]: sql`${scriptExecutionBatches[counterField]} + 1`
          })
          .where(and(
            eq(scriptExecutionBatches.id, batchId),
            eq(scriptExecutionBatches.scriptId, updatedExecutions[0].scriptId)
          ));
      }
    }
  } catch (err) {
    // #3162 lived undetected because this catch logged to the container and
    // nothing else — a swallowed 22P02 silently discarded every automation's
    // script output. Report it like the SNMP handler does so the next failure
    // in here (schema drift, a redaction throw, a batch-counter FK violation)
    // surfaces instead of quietly eating results.
    console.error(`[AgentWs] Failed to process script result for ${agentId}:`, err);
    captureException(err, undefined, {
      commandId: command.id,
      agentId,
      executionId: String((command.payload as Record<string, unknown> | null)?.executionId ?? ''),
    });
  }
}

async function handleSensitiveDataResult({ agentId, command, result, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const { handleSensitiveDataCommandResult } = await import('../routes/agents/helpers');
    await handleSensitiveDataCommandResult(command, {
      status: result.status,
      exitCode: result.exitCode,
      stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      error: result.error,
    } as any);
  } catch (err) {
    console.error(`[AgentWs] Failed to process sensitive data result for ${agentId}:`, err);
  }
}

async function handleCisResult({ agentId, command, result, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const { handleCisCommandResult } = await import('../routes/agents/helpers');
    await handleCisCommandResult(command, {
      status: result.status,
      exitCode: result.exitCode,
      stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      error: result.error,
    } as any);
  } catch (err) {
    console.error(`[AgentWs] Failed to process CIS result for ${agentId}:`, err);
  }
}

const peripheralPolicyResultV2Schema = z.object({
  schemaVersion: z.literal(2),
  phase: z.enum(['clear_legacy', 'enforce']),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  outcome: z.enum(['applied', 'rejected']),
  reasonCode: z.enum([
    'wrong_identity',
    'lower_revision',
    'revision_digest_conflict',
    'malformed_digest',
    'invalid_payload',
    'detection_failed',
    'enforcement_failed',
    'persistence_failed',
  ]).optional(),
});

async function handlePeripheralPolicyV2Result({
  commandId,
  result,
  resolvedDeviceId,
}: Parameters<CommandResultHandler>[0]): Promise<void> {
  const parsed = peripheralPolicyResultV2Schema.safeParse(result.result);
  if (!parsed.success) {
    console.warn(`[AgentWs] Ignoring malformed peripheral v2 result for command ${commandId}`);
    return;
  }
  await handlePeripheralPolicyResultV2(resolvedDeviceId, commandId, parsed.data);
}

async function handlePamActuationV2Result({
  agentId,
  commandId,
  result,
  resolvedDeviceId,
}: Parameters<CommandResultHandler>[0]): Promise<CommandResultHandlerOutcome> {
  const parsed = pamAgentResultV2Schema.safeParse(result.result);
  if (!parsed.success) {
    console.warn(`[AgentWs] Ignoring malformed PAM v2 result for command ${commandId}`);
    return;
  }
  const classification = await recordPamActuationResult({
    agentId,
    deviceId: resolvedDeviceId,
    commandId,
    result: parsed.data,
  });
  return { kind: 'pam', classification };
}

export const commandResultHandlers: Record<string, CommandResultHandler> = {
  network_discovery: handleDiscoveryResult,
  backup_verify: handleBackupVerificationResult,
  backup_test_restore: handleBackupVerificationResult,
  backup_restore: handleVmRestoreResult,
  vm_restore_from_backup: handleVmRestoreResult,
  vm_instant_boot: handleVmRestoreResult,
  bmr_recover: handleVmRestoreResult,
  hyperv_backup: handleProviderBackedBackupResult,
  mssql_backup: handleProviderBackedBackupResult,
  vault_sync: handleVaultSyncResult,
  snmp_poll: handleSnmpPollResult,
  script: handleScriptResult,
  sensitive_data_scan: handleSensitiveDataResult,
  encrypt_file: handleSensitiveDataResult,
  secure_delete_file: handleSensitiveDataResult,
  quarantine_file: handleSensitiveDataResult,
  cis_benchmark: handleCisResult,
  apply_cis_remediation: handleCisResult,
  peripheral_policy_sync_v2: handlePeripheralPolicyV2Result,
  pam_apply_v2: handlePamActuationV2Result,
  pam_cleanup_v2: handlePamActuationV2Result,
};
