import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq, and, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { devices, deviceCommands, discoveryJobs, scriptExecutions, scriptExecutionBatches, remoteSessions, backupJobs, restoreJobs, tunnelSessions } from '../db/schema';
import { handleTerminalOutput, getActiveTerminalSession, unregisterTerminalOutputCallback } from './terminalWs';
import { handleDesktopFrame, isDesktopSessionOwnedByAgent } from './desktopWs';
import { handleTunnelDataFromAgent, isTunnelOwnedByAgent, registerTunnelOwnership } from './tunnelWs';
import { enqueueDiscoveryResults, type DiscoveredHostResult, type DeviceAdjacency } from '../jobs/discoveryWorker';
import { enqueueBackupResults } from '../jobs/backupWorker';
import { enqueueSnmpPollResults, type SnmpMetricResult } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult, recordMonitorCheckResult, type MonitorCheckResult } from '../jobs/monitorWorker';
import { isRedisAvailable } from '../services/redis';
import { isIP } from 'node:net';
import { processDeviceIPHistoryUpdate } from '../services/deviceIpHistory';
import { processBackupVerificationResult } from './backup/verificationService';
import { applyBackupCommandResultToJob } from '../services/backupResultPersistence';
import {
  applyVaultSyncCommandResult,
  findRecentCompletedSnapshotForDevice,
  resolveVaultForResult,
} from '../services/vaultSyncPersistence';
import { claimConsumeOnce, consumeDispatchedExpectation, recordDispatchedExpectation } from '../services/agentWorkExpectation';
import {
  applyBackupProgress,
  applyBackupStartedAck,
  isBackupStartedAck,
  isLegacyBackupTimeoutResult,
  tryParseBackupResultPayload,
} from '../services/backupProgress';
import { backupCommandResultSchema } from './backup/resultSchemas';
import { matchRoleScopedAgentTokenHash, suspendAgentToken, type AgentCredentialRole } from '../middleware/agentAuth';
import { AGENT_TOKEN_SUSPEND_REASON } from '../services/agentTokenSuspension';
import { isAgentTenantActive } from '../services/tenantStatus';
import { createAuditLogAsync } from '../services/auditService';
import { ANONYMOUS_ACTOR_ID, writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { redactSecretsFromOutput, redactOptionalSecretText, redactAgentResultErrorFields } from '../services/secretRedaction';
import { isRawStdoutArtifactCommand } from '../services/commandAudit';
import { detectResultValidationFamily, validateCriticalCommandResult, DR_COMMAND_TYPES, type CriticalResultFamily } from '../services/agentCommandResultValidation';
import { updateRestoreJobByCommandId, updateRestoreJobFromResult } from '../services/restoreResultPersistence';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import { revokeViewerSession } from '../services/viewerTokenRevocation';
import { logSessionAudit, classifyConsentDenyAction, resolveConsentMarkerSessionId } from './remote/helpers';
import { getActiveTrustKeyset } from '../services/manifestSigning';
import { resolvePendingAgentCommand } from '../services/agentCommandAwait';
import { UUID_REGEX } from '../utils/uuid';

/** Capabilities advertised to agents in the post-connect `connected` message. */
export const AGENT_WS_CAPABILITIES = ['terminal_output_base64', 'backup_run_async'] as const;

declare module 'hono' {
  interface ContextVariableMap {
    agentDb: AgentDbContext;
  }
}

const VALID_MONITOR_STATUSES = new Set(['online', 'offline', 'degraded']);
const PROVIDER_BACKED_BACKUP_COMMAND_TYPES = new Set(['hyperv_backup', 'mssql_backup']);
const MAX_DESKTOP_SESSION_ID_BYTES = 128;
const ACCEPTED_COMMAND_RESULT_STATUSES = ['pending', 'sent'] as const;
type TunnelSessionStatus = 'pending' | 'connecting' | 'active' | 'disconnected' | 'failed';

function normalizeMonitorStatus(raw: string | undefined): 'online' | 'offline' | 'degraded' {
  if (raw && VALID_MONITOR_STATUSES.has(raw)) return raw as 'online' | 'offline' | 'degraded';
  return 'offline';
}

async function updateTunnelSessionForAuthenticatedDevice(
  tunnelId: string,
  authenticatedDeviceId: string,
  values: Partial<typeof tunnelSessions.$inferInsert>,
  statusGuard?: TunnelSessionStatus
): Promise<{ id: string; deviceId: string } | null> {
  if (!authenticatedDeviceId) return null;

  const conditions = [
    eq(tunnelSessions.id, tunnelId),
    eq(tunnelSessions.deviceId, authenticatedDeviceId),
  ];
  if (statusGuard) {
    conditions.push(eq(tunnelSessions.status, statusGuard));
  }

  const [row] = await withSystemDbAccessContext(() =>
    db
      .update(tunnelSessions)
      .set(values)
      .where(and(...conditions))
      .returning({
        id: tunnelSessions.id,
        deviceId: tunnelSessions.deviceId,
      })
  );

  return row ?? null;
}

function extractDesktopSessionId(commandId: string, prefix: 'desk-start-' | 'desk-stop-' | 'desk-disconnect-'): string | null {
  if (!commandId.startsWith(prefix)) return null;
  const sessionId = commandId.slice(prefix.length);
  if (!sessionId || sessionId.length > MAX_DESKTOP_SESSION_ID_BYTES) {
    return null;
  }
  return sessionId;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inferRestoreCommandType(restoreJob: {
  restoreType?: string | null;
  targetConfig?: unknown;
}): string {
  const targetConfig = asObjectRecord(restoreJob.targetConfig);
  const result = asObjectRecord(targetConfig.result);

  if (typeof result.commandType === 'string' && result.commandType.trim()) {
    return result.commandType;
  }
  if (restoreJob.restoreType === 'bare_metal') {
    return 'bmr_recover';
  }
  if (targetConfig.mode === 'instant_boot') {
    return 'vm_instant_boot';
  }
  if (typeof targetConfig.hypervisor === 'string' && targetConfig.hypervisor.trim()) {
    return 'vm_restore_from_backup';
  }
  return 'backup_restore';
}

/**
 * Signature for per-command-type result handlers dispatched from processCommandResult.
 */
type CommandResultHandler = (params: {
  agentId: string;
  command: typeof deviceCommands.$inferSelect;
  result: z.infer<typeof commandResultSchema>;
  resolvedDeviceId: string;
  stdout: string | undefined;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Per-command-type result handlers (used by the dispatch map in processCommandResult)
// ---------------------------------------------------------------------------

/** Coerce Date instances in host firstSeen/lastSeen to ISO strings so Zod datetime validation passes. */
function normalizeDiscoveryHosts(hosts: DiscoveredHostResult[]): DiscoveredHostResult[] {
  return hosts.map(h => ({
    ...h,
    firstSeen: (h.firstSeen as any) instanceof Date ? (h.firstSeen as any).toISOString() : h.firstSeen,
    lastSeen: (h.lastSeen as any) instanceof Date ? (h.lastSeen as any).toISOString() : h.lastSeen,
  }));
}

async function handleDiscoveryResult({ agentId, command, result }: Parameters<CommandResultHandler>[0]): Promise<void> {
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
          `[AgentWs] Rejecting mismatched discovery result ${result.commandId} from agent ${agentId}: ` +
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
        await enqueueDiscoveryResults(
          expectedJobId,
          job.orgId,
          job.siteId,
          normalizeDiscoveryHosts(discoveryData.hosts),
          discoveryData.hostsScanned ?? 0,
          discoveryData.hostsDiscovered ?? 0,
          undefined,
          discoveryData.adjacency ?? [],
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:script-network-scan',
          }
        );
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

async function handleBackupVerificationResult({ agentId, result, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    await processBackupVerificationResult(result.commandId, {
      status: result.status,
      stdout,
      error: result.error,
    });
  } catch (err) {
    console.error(`[AgentWs] Failed to process backup verification result for ${agentId}:`, err);
    captureException(err);
  }
}

async function handleVmRestoreResult({ agentId, command, result, resolvedDeviceId }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    await updateRestoreJobByCommandId({
      commandId: result.commandId,
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
              error: `Malformed backup result payload: ${parsedBackup.error.issues.map((issue) => issue.message).join(', ')}`,
            },
          });
        } else {
          await applyBackupCommandResultToJob({
            jobId: backupJob.id,
            orgId: backupJob.orgId,
            deviceId: backupJob.deviceId,
            resultStatus: result.status,
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

async function handleSnmpPollResult({ agentId, command, result }: Parameters<CommandResultHandler>[0]): Promise<void> {
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
          `[AgentWs] Rejecting mismatched SNMP result ${result.commandId} from agent ${agentId}: ` +
          `sentDevice=${snmpData.deviceId} expected=${expectedDeviceId ?? 'none'}`
        );
        return;
      }
      if (isRedisAvailable()) {
        await enqueueSnmpPollResults(expectedDeviceId, snmpData.metrics);
      } else {
        // Redis not available — log warning about dropped metrics and mark status
        console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${expectedDeviceId}`);
        const { snmpDevices } = await import('../db/schema');
        await db
          .update(snmpDevices)
          .set({ lastPolled: new Date(), lastStatus: 'warning' })
          .where(eq(snmpDevices.id, expectedDeviceId));
      }
    }
  } catch (err) {
    console.error(`[AgentWs] Failed to process SNMP poll results for ${agentId}:`, err);
  }
}

async function handleScriptResult({ agentId, command, result, resolvedDeviceId, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const payload = command.payload as Record<string, unknown> | null;
    const executionId = payload?.executionId as string | undefined;
    if (executionId) {
      let scriptStatus: 'completed' | 'failed' | 'timeout';
      if (result.status === 'completed') {
        scriptStatus = result.exitCode && result.exitCode !== 0 ? 'failed' : 'completed';
      } else if (result.status === 'timeout') {
        scriptStatus = 'timeout';
      } else {
        scriptStatus = 'failed';
      }

      const updatedExecutions = await db
        .update(scriptExecutions)
        .set({
          status: scriptStatus,
          completedAt: new Date(),
          exitCode: result.exitCode ?? null,
          // #2434: script output/errors surface to scripts:read users in the
          // web UI — redact secrets before persistence (idempotent when the
          // ingest chokepoint already redacted error/stderr).
          stdout: stdout != null ? redactSecretsFromOutput(stdout) : null,
          stderr: redactOptionalSecretText(result.stderr) ?? null,
          errorMessage: redactOptionalSecretText(result.error) ?? null,
        })
        .where(and(
          eq(scriptExecutions.id, executionId),
          eq(scriptExecutions.deviceId, resolvedDeviceId),
          inArray(scriptExecutions.status, ['pending', 'queued', 'running'])
        ))
        .returning({
          id: scriptExecutions.id,
          scriptId: scriptExecutions.scriptId,
        });

      // Update batch counters if this is part of a batch
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
    console.error(`[AgentWs] Failed to process script result for ${agentId}:`, err);
  }
}

async function handleSensitiveDataResult({ agentId, command, result, stdout }: Parameters<CommandResultHandler>[0]): Promise<void> {
  try {
    const { handleSensitiveDataCommandResult } = await import('./agents/helpers');
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
    const { handleCisCommandResult } = await import('./agents/helpers');
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

const commandResultHandlers: Record<string, CommandResultHandler> = {
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
};

// IMPORTANT #1 (#2556): when a verify/restore result is REJECTED by validation
// (malformed payload deepJsonParse can't rescue, or oversize stdout tripping the
// size limits), device_commands transitions to 'failed' but the per-type handler
// dispatch is skipped by the early return below — stranding the associated
// backup_verifications / restore_jobs row in 'running'/'pending' until the 30-min
// stale-timeout sweep. For these families we still run the handler on rejection
// so it drives the linked record to a terminal 'failed' via its normal failure
// path (normalizedResult.status === 'failed', error === the validation reason).
// Scoped to the verify (backup_verify / backup_test_restore) and restore
// (backup_restore) families — exactly the command types whose handlers finalize
// a linked record. The 'dr' family is deliberately excluded: its records are
// reconciled by the separate drExecution path above, not by a single handler.
const TERMINAL_TRANSITION_FAMILIES_ON_VALIDATION_FAILURE = new Set<CriticalResultFamily>([
  'verification',
  'restore',
]);

// Store active WebSocket connections by agentId
// Map<agentId, WSContext>
const activeConnections = new Map<string, WSContext>();

// Track per-agent ping/pong state for stale connection detection
interface AgentPingState {
  pingInterval: ReturnType<typeof setInterval>;
  lastPongAt: number;
  // Finding #4: the socket this ping state belongs to. onClose/onError use it to
  // delete ONLY their own ping state — a superseded orphan closing must never
  // clobber the live (newer) socket's ping state, mirroring the
  // `activeConnections.get(agentId) === ws` guard on the connection map.
  ws: WSContext;
}
const agentPingStates = new Map<string, AgentPingState>();
const AGENT_PING_INTERVAL_MS = 30_000;
const AGENT_PONG_TIMEOUT_MS = 10_000;
const ORPHANED_RESULT_EXPECTATION_TTL_MS = 30 * 60 * 1000;

// F5: a `vault-auto-sync-<snapshotID>` result is only honored if a real,
// recently-COMPLETED backup snapshot exists for the authenticated device with
// that snapshot id. Auto-sync runs right after a backup, but the agent may be
// slow or reconnect, so the window is generous; dropping a legitimate late
// result only degrades vault state to "not-synced" (fail-safe).
const VAULT_AUTO_SYNC_SNAPSHOT_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h
const MONITOR_COMMAND_TYPES = new Set(['network_ping', 'network_tcp_check', 'network_http_check', 'network_dns_check']);

type OrphanedResultExpectation =
  | {
      agentId: string;
      kind: 'snmp';
      targetId: string;
      expiresAt: number;
    }
  | {
      agentId: string;
      kind: 'monitor';
      targetId: string;
      expiresAt: number;
    };

const orphanedResultExpectations = new Map<string, OrphanedResultExpectation>();

function pruneOrphanedResultExpectations(now = Date.now()): void {
  for (const [commandId, expectation] of orphanedResultExpectations.entries()) {
    if (expectation.expiresAt <= now) {
      orphanedResultExpectations.delete(commandId);
    }
  }
}

function recordOrphanedResultExpectation(agentId: string, command: AgentCommand): void {
  const payload = command.payload ?? {};
  const expiresAt = Date.now() + ORPHANED_RESULT_EXPECTATION_TTL_MS;

  if (command.type === 'snmp_poll') {
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : null;
    if (!deviceId) return;
    orphanedResultExpectations.set(command.id, {
      agentId,
      kind: 'snmp',
      targetId: deviceId,
      expiresAt,
    });
    return;
  }

  if (MONITOR_COMMAND_TYPES.has(command.type)) {
    const monitorId = typeof payload.monitorId === 'string' ? payload.monitorId : null;
    if (!monitorId) return;
    orphanedResultExpectations.set(command.id, {
      agentId,
      kind: 'monitor',
      targetId: monitorId,
      expiresAt,
    });
  }
}

function consumeOrphanedResultExpectation(agentId: string, commandId: string): OrphanedResultExpectation | null {
  pruneOrphanedResultExpectations();
  const expectation = orphanedResultExpectations.get(commandId);
  if (!expectation || expectation.agentId !== agentId) {
    return null;
  }
  orphanedResultExpectations.delete(commandId);
  return expectation;
}

// Message types from agent
const commandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string(),
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().max(5_000_000).optional(),
  stderr: z.string().max(5_000_000).optional(),
  durationMs: z.number().int().optional(),
  // RFC3339 timestamp captured by the agent at the moment the command's
  // primary work began. Optional for back-compat with pre-startedAt agents,
  // which the server falls back to reconstructing from durationMs.
  startedAt: z.string().datetime().optional(),
  error: z.string().max(10_000).optional(),
  result: z.any().optional().refine(
    (val) => {
      if (val === undefined || val === null) return true;
      try { return JSON.stringify(val).length <= 1_048_576; } catch { return false; }
    },
    { message: 'Command result payload exceeds 1 MB limit' }
  )
});

type AgentCommandResult = z.infer<typeof commandResultSchema>;

function commandResultToStdout(result: AgentCommandResult): string | undefined {
  return result.stdout ??
    (result.result !== undefined ? JSON.stringify(result.result) : undefined);
}

function buildStoredCommandResult(
  commandType: string,
  result: AgentCommandResult,
  stdout: string | undefined,
) {
  // Finding #5 (WS leg): strip full PEM private-key blocks from agent output
  // BEFORE it is persisted into device_commands.result and later shown to
  // scripts:read users. Mirrors the REST ingest path
  // (routes/agents/commands.ts). Pre-update agents don't redact
  // server-side-visible output, so we redact here as defense-in-depth.
  // Preserve null/undefined (don't coerce to '') to keep the stored shape
  // stable; exitCode/status/durationMs are untouched.
  //
  // Exception: artifact-bearing stdout (capture_pprof base64 profiles) must be
  // stored byte-for-byte -- the redaction patterns statistically fire inside
  // megabytes of random base64 and would silently corrupt the artifact (#2401).
  const skipStdoutRedaction = isRawStdoutArtifactCommand(commandType);
  return {
    status: result.status,
    exitCode: result.exitCode,
    stdout: stdout != null && !skipStdoutRedaction ? redactSecretsFromOutput(stdout) : stdout,
    stderr: result.stderr != null ? redactSecretsFromOutput(result.stderr) : result.stderr,
    durationMs: result.durationMs,
    error: result.error != null ? redactSecretsFromOutput(result.error) : result.error,
  };
}

function rejectMalformedCriticalResult(
  commandType: string,
  result: AgentCommandResult,
  error: unknown
): { normalizedResult: AgentCommandResult; stdout: string | undefined; message: string } {
  const message = error instanceof Error ? error.message : 'unknown validation error';
  const reason = `Rejected malformed ${commandType} result: ${message}`;
  return {
    normalizedResult: {
      ...result,
      status: 'failed',
      error: reason,
    },
    stdout: commandResultToStdout(result),
    message: reason,
  };
}

function normalizeCriticalResultIfNeeded(
  commandType: string,
  result: AgentCommandResult
): { normalizedResult: AgentCommandResult; stdout: string | undefined; validationError: string | null } {
  if (!detectResultValidationFamily(commandType)) {
    return {
      normalizedResult: result,
      stdout: commandResultToStdout(result),
      validationError: null,
    };
  }

  try {
    const validated = validateCriticalCommandResult(commandType, {
      commandId: result.commandId,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      error: result.error,
      result: result.result,
    });
    if (!validated) {
      return {
        normalizedResult: result,
        stdout: commandResultToStdout(result),
        validationError: null,
      };
    }

    const stdout = validated.normalizedStdout ?? result.stdout;
    return {
      normalizedResult: {
        ...result,
        stdout,
        result: validated.structuredResult,
      },
      stdout,
      validationError: null,
    };
  } catch (error) {
    const rejected = rejectMalformedCriticalResult(commandType, result, error);
    return {
      normalizedResult: rejected.normalizedResult,
      stdout: rejected.stdout,
      validationError: rejected.message,
    };
  }
}

const ipHistoryEntrySchema = z.object({
  interfaceName: z.string().min(1).max(100),
  ipAddress: z.string().trim().max(45).refine(
    (value) => {
      const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
      return isIP(withoutZone) !== 0;
    },
    { message: 'Invalid IP address format' }
  ),
  ipType: z.enum(['ipv4', 'ipv6']).optional(),
  assignmentType: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
  macAddress: z.string().max(17).optional(),
  subnetMask: z.string().max(45).optional(),
  gateway: z.string().max(45).optional(),
  dnsServers: z.array(z.string().max(45)).max(8).optional()
});

const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number(),
  ipHistoryUpdate: z.object({
    deviceId: z.string().optional(),
    currentIPs: z.array(ipHistoryEntrySchema).max(100).optional(),
    changedIPs: z.array(ipHistoryEntrySchema).max(100).optional(),
    removedIPs: z.array(ipHistoryEntrySchema).max(100).optional(),
    detectedAt: z.string().datetime({ offset: true }).optional(),
  }).optional()
});

const terminalOutputSchema = z.object({
  type: z.literal('terminal_output'),
  sessionId: z.string(),
  data: z.string(),
  encoding: z.enum(['base64']).optional(),
});

function decodeTerminalOutput(data: string, encoding?: 'base64'): string | null {
  if (encoding !== 'base64') {
    return data;
  }
  const decoded = Buffer.from(data, 'base64');
  const roundTrip = decoded.toString('base64');
  const normalizeBase64 = (value: string) => value.replace(/\s/g, '').replace(/=+$/, '');
  if (normalizeBase64(roundTrip) !== normalizeBase64(data)) {
    return null;
  }
  return decoded.toString('utf8');
}

// Live upload-progress ping for an in-flight backup_run (agent side:
// websocket.Client.SendBackupProgress in agent/internal/websocket/client.go).
// `progress` is intentionally loose here (z.record/z.any-ish) —
// applyBackupProgress does the strict field-level validation so a malformed
// progress body is dropped rather than failing the whole WS message parse.
const backupProgressMessageSchema = z.object({
  type: z.literal('backup_progress'),
  commandId: z.string(),
  progress: z.record(z.string(), z.unknown()).optional(),
});

const agentMessageSchema = z.discriminatedUnion('type', [
  commandResultSchema,
  heartbeatMessageSchema,
  terminalOutputSchema,
  backupProgressMessageSchema
]);

// Command types sent to agent
export interface AgentCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

type AgentDbContext = {
  deviceId: string;
  orgId: string;
  role?: AgentCredentialRole;
};

type AgentTokenValidation =
  | { ok: true; ctx: AgentDbContext }
  | { ok: false; reason: 'unauthorized' | 're_enrollment_required' };

// Finding #8: WS command-result ingest has no Hono request context. The
// header-less shim returns undefined for all client-IP/user-agent headers, so
// client IP is simply absent on the WS audit path (expected on a persistent
// socket). This lets the WS path emit the same append-only audit as the REST
// path via the canonical snapshot-backed RequestLike helper.
const WS_AUDIT_REQUEST = requestLikeFromSnapshot({});

/**
 * Finding #3 (defense-in-depth): re-verify a live agent's device lifecycle
 * state with ONE lightweight indexed SELECT, so a socket that outlived a
 * containment change (decommission, quarantine, or org/partner/token
 * suspension) stops acting on the next sensitive operation.
 *
 * Fail-OPEN on a transient DB error or a missing row: the pre-upgrade auth gate
 * already proved the device existed, and the authoritative containment paths
 * (credential suspension + disconnectAgent) still fail closed on the next
 * (re)connect. Failing closed here would let a DB blip mass-drop the fleet. We
 * only sever on a POSITIVE containment signal (terminal status / suspend
 * timestamp). System DB context because `devices` is RLS-guarded and this can
 * run outside a tenant context.
 */
async function isAgentDeviceStillAuthorized(agentId: string): Promise<boolean> {
  try {
    const [row] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ status: devices.status, agentTokenSuspendedAt: devices.agentTokenSuspendedAt })
          .from(devices)
          .where(eq(devices.agentId, agentId))
          .limit(1)
      )
    );
    if (!row) return true; // fail-open: existence already validated pre-upgrade
    if (row.status === 'decommissioned' || row.status === 'quarantined') return false;
    if (row.agentTokenSuspendedAt) return false;
    return true;
  } catch (err) {
    console.error(`[AgentWs] lifecycle recheck query failed for ${agentId}; failing open:`, err);
    return true;
  }
}

/**
 * Validate agent token by hashing it and comparing against the stored hash.
 * Returns `re_enrollment_required` when the device row exists but predates the
 * token-hash migration so the agent can prompt the operator instead of looping.
 */
export async function validateAgentToken(agentId: string, token: string): Promise<AgentTokenValidation> {
  if (!token || !token.startsWith('brz_')) {
    return { ok: false, reason: 'unauthorized' };
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  // Authentication must work even when tenant RLS is deny-by-default.
  // Use system DB context for lookup, then scope all downstream queries to this org.
  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        agentTokenHash: devices.agentTokenHash,
        previousTokenHash: devices.previousTokenHash,
        previousTokenExpiresAt: devices.previousTokenExpiresAt,
        watchdogTokenHash: devices.watchdogTokenHash,
        previousWatchdogTokenHash: devices.previousWatchdogTokenHash,
        previousWatchdogTokenExpiresAt: devices.previousWatchdogTokenExpiresAt,
        status: devices.status,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);
    return row ?? null;
  });

  if (!device) {
    return { ok: false, reason: 'unauthorized' };
  }

  if (!device.agentTokenHash && !device.watchdogTokenHash) {
    console.warn(
      `[agentWs] Device ${agentId} has no token hash — predates hash migration; signaling re_enrollment_required`
    );
    return { ok: false, reason: 're_enrollment_required' };
  }

  if (device.status === 'decommissioned') {
    return { ok: false, reason: 'unauthorized' };
  }

  if (device.status === 'quarantined') {
    return { ok: false, reason: 'unauthorized' };
  }

  // Task 18: tokens auto-suspended for cross-tenant probing fail closed.
  // The reconnect loop is the intended ops alarm signal.
  if (device.agentTokenSuspendedAt) {
    return { ok: false, reason: 'unauthorized' };
  }

  const match = matchRoleScopedAgentTokenHash({
    agentTokenHash: device.agentTokenHash,
    previousTokenHash: device.previousTokenHash,
    previousTokenExpiresAt: device.previousTokenExpiresAt,
    watchdogTokenHash: device.watchdogTokenHash,
    previousWatchdogTokenHash: device.previousWatchdogTokenHash,
    previousWatchdogTokenExpiresAt: device.previousWatchdogTokenExpiresAt,
    tokenHash,
  });
  if (!match || match.role !== 'agent') {
    return { ok: false, reason: 'unauthorized' };
  }

  // Tenant-status gate (mirror of the REST agent-auth path): refuse the WS
  // upgrade for a suspended/churned/soft-deleted org or partner before we
  // accept the persistent control channel.
  if (!(await isAgentTenantActive(device.orgId))) {
    return { ok: false, reason: 'unauthorized' };
  }

  return {
    ok: true,
    ctx: {
      deviceId: device.id,
      orgId: device.orgId,
      role: match.role,
    },
  };
}

// Statuses that agent-driven writes must never overwrite. Mirrored inline in
// routes/agents/heartbeat.ts (the REST polling counterpart).
const TERMINAL_DEVICE_STATUSES = ['decommissioned', 'quarantined'] as const;

/**
 * Update device status when WebSocket connects/disconnects.
 *
 * Never overwrites terminal lifecycle statuses: decommission/quarantine are
 * only enforced at WS connect time, so an agent whose socket was already open
 * when the device was decommissioned keeps sending heartbeats — an unguarded
 * write here flipped the row back to 'online' and resurrected the device in
 * the dashboard (#2230). The disconnect path has the same hole
 * ('decommissioned' → 'offline' makes the row visible again).
 */
async function updateDeviceStatus(agentId: string, status: 'online' | 'offline'): Promise<void> {
  try {
    await db
      .update(devices)
      .set({
        status,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(and(
        eq(devices.agentId, agentId),
        notInArray(devices.status, [...TERMINAL_DEVICE_STATUSES])
      ));
  } catch (error) {
    console.error(`Failed to update device status for ${agentId}:`, error);
  }
}

/**
 * Handle command results for commands dispatched directly via WebSocket
 * (without a deviceCommands DB record). This covers discovery scans
 * and SNMP polls which use their own job tracking tables.
 */
export async function processOrphanedCommandResult(
  agentId: string,
  authenticatedDeviceId: string,
  result: z.infer<typeof commandResultSchema>
): Promise<void> {
  // #2434 chokepoint: redact agent-supplied error/stderr ONCE at ingest so
  // every persistence branch below (discovery job errors, tunnel session
  // errorMessage, backup job errorLog, restore metadata, vault sync state)
  // stores redacted text. stdout is left raw — structured-JSON consumers
  // (vault sync resolution) parse it; its persisted forms are redacted at
  // their write sites.
  result = redactAgentResultErrorFields(result);

  // Check if this is an SNMP poll result
  const snmpData = result.result as {
    deviceId?: string;
    metrics?: SnmpMetricResult[];
  } | undefined;

  if (snmpData?.deviceId && snmpData.metrics && snmpData.metrics.length > 0) {
    const expectation = consumeOrphanedResultExpectation(agentId, result.commandId);
    if (!expectation || expectation.kind !== 'snmp' || expectation.targetId !== snmpData.deviceId) {
      console.warn(
        `[AgentWs] Rejecting unexpected SNMP result ${result.commandId} from agent ${agentId}: ` +
        `sentDevice=${snmpData.deviceId} expected=${expectation?.kind === 'snmp' ? expectation.targetId : 'none'} authDevice=${authenticatedDeviceId}`
      );
      return;
    }
    console.log(`[AgentWs] Processing SNMP poll result for device ${snmpData.deviceId} from agent ${agentId}`);
    try {
      if (isRedisAvailable()) {
        await enqueueSnmpPollResults(snmpData.deviceId, snmpData.metrics, result.commandId);
      } else {
        console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${snmpData.deviceId}`);
        const { snmpDevices } = await import('../db/schema');
        await db
          .update(snmpDevices)
          .set({ lastPolled: new Date(), lastStatus: 'warning' })
          .where(eq(snmpDevices.id, snmpData.deviceId));
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process SNMP poll results for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }

  // Check if this is a network monitor result
  const monitorData = result.result as {
    monitorId?: string;
    status?: string;
    responseMs?: number;
    statusCode?: number;
    error?: string;
  } | undefined;

  if (monitorData?.monitorId && monitorData.status) {
    const expectation = consumeOrphanedResultExpectation(agentId, result.commandId);
    if (!expectation || expectation.kind !== 'monitor' || expectation.targetId !== monitorData.monitorId) {
      console.warn(
        `[AgentWs] Rejecting unexpected monitor result ${result.commandId} from agent ${agentId}: ` +
        `sentMonitor=${monitorData.monitorId} expected=${expectation?.kind === 'monitor' ? expectation.targetId : 'none'}`
      );
      return;
    }
    console.log(`[AgentWs] Processing monitor check result for monitor ${monitorData.monitorId} from agent ${agentId}`);
    try {
      const status = normalizeMonitorStatus(monitorData.status);
      if (isRedisAvailable()) {
        await enqueueMonitorCheckResult(monitorData.monitorId, {
          monitorId: monitorData.monitorId,
          checkId: result.commandId,
          status,
          responseMs: monitorData.responseMs ?? 0,
          statusCode: monitorData.statusCode,
          error: monitorData.error,
          details: monitorData as Record<string, unknown>
        }, {
          actorType: 'agent',
          actorId: agentId,
          source: 'route:agentWs:monitor-result',
        });
      } else {
        console.warn(`[AgentWs] Redis unavailable, recording monitor result directly for ${monitorData.monitorId}`);
        await recordMonitorCheckResult(monitorData.monitorId, {
          monitorId: monitorData.monitorId,
          checkId: result.commandId,
          status,
          responseMs: monitorData.responseMs ?? 0,
          statusCode: monitorData.statusCode,
          error: monitorData.error,
          details: monitorData as Record<string, unknown>
        });
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process monitor check result for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }

  // Ignore non-persistent command IDs that are expected to have no DB row.
  if (result.commandId.startsWith('dev-push-')) {
    return;
  }

  if (result.commandId.startsWith('vault-auto-sync-')) {
    try {
      // Integrity gate (F5): the `vault-auto-sync-<snapshotID>` command id is
      // agent-generated — there is no server dispatch to bind to. Derive
      // legitimacy from a server-known event instead: a real, recently-completed
      // backup snapshot for THIS device carrying that snapshot id. Without a
      // matching snapshot, a compromised agent could forge sync-completed/failed
      // state on the device's vault, so we log + drop (mutate nothing).
      const snapshotId = result.commandId.slice('vault-auto-sync-'.length);
      if (!snapshotId) {
        console.warn(`[AgentWs] Dropping vault auto-sync result from agent ${agentId}: empty snapshot id. reason=empty-snapshot-id`);
        return;
      }

      const snapshot = await findRecentCompletedSnapshotForDevice(
        authenticatedDeviceId,
        snapshotId,
        VAULT_AUTO_SYNC_SNAPSHOT_FRESHNESS_MS,
      );
      if (!snapshot) {
        console.warn(
          `[AgentWs] Dropping vault auto-sync result for snapshot ${snapshotId} from agent ${agentId} ` +
          `(device ${authenticatedDeviceId}): no recent completed backup snapshot matches. reason=no-matching-snapshot`
        );
        return;
      }

      const { normalizedResult, stdout, validationError } = normalizeCriticalResultIfNeeded('vault_sync', result);

      // Resolve the target vault unambiguously (no single-active-vault fallback)
      // so we can key consume-once on (deviceId, snapshotId, vaultId) and refuse
      // to guess which vault a forged result is "for".
      const vault = await resolveVaultForResult(authenticatedDeviceId, stdout);
      if (!vault) {
        console.warn(
          `[AgentWs] Dropping vault auto-sync result for snapshot ${snapshotId} from agent ${agentId} ` +
          `(device ${authenticatedDeviceId}): vault could not be unambiguously derived. reason=ambiguous-vault`
        );
        return;
      }

      // Consume-once on the derived tuple: the same snapshot can't drive repeated
      // or overwriting vault-state updates. Fail-closed (Redis down ⇒ dropped).
      const claim = await claimConsumeOnce('vault_sync', authenticatedDeviceId, `${snapshotId}:${vault.id}`);
      if (!claim.ok) {
        console.warn(
          `[AgentWs] Dropping vault auto-sync result for snapshot ${snapshotId} (vault ${vault.id}) from agent ${agentId}: ` +
          `already consumed or Redis unavailable. reason=consume-once-rejected`
        );
        return;
      }

      if (validationError) {
        console.warn(`[AgentWs] ${validationError} for orphaned auto-sync ${result.commandId}`);
        // Snapshot-correlated + consumed: a malformed payload from an otherwise
        // legitimate sync is surfaced to operators as a failure on the resolved vault.
        await applyVaultSyncCommandResult({
          deviceId: authenticatedDeviceId,
          resultStatus: 'failed',
          error: validationError,
          allowSingleVaultFallback: false,
        });
        return;
      }
      await applyVaultSyncCommandResult({
        deviceId: authenticatedDeviceId,
        resultStatus: normalizedResult.status,
        stdout,
        stderr: normalizedResult.stderr,
        error: normalizedResult.error,
        allowSingleVaultFallback: false,
      });
    } catch (err) {
      console.error(`[AgentWs] Failed to process vault auto-sync result for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }

  // Tunnel open results: update tunnel session status on failure.
  if (result.commandId.startsWith('tun-open-')) {
    const tunnelId = result.commandId.slice('tun-open-'.length);
    if (result.status !== 'completed') {
      try {
        const updated = await updateTunnelSessionForAuthenticatedDevice(tunnelId, authenticatedDeviceId, {
          status: 'failed',
          errorMessage: result.error || result.stderr || 'Agent failed to open tunnel',
          endedAt: new Date(),
        });
        if (!updated) {
          console.warn(
            `[AgentWs] Rejected tunnel ${tunnelId} open failure from agent ${agentId}: ` +
            `authenticatedDevice=${authenticatedDeviceId}`
          );
          return;
        }
        await revokeViewerSession(tunnelId);
        console.warn(`[AgentWs] Tunnel ${tunnelId} open failed: ${result.error || result.stderr}`);
      } catch (err) {
        console.error(`[AgentWs] Failed to update tunnel session ${tunnelId}:`, err);
      }
    } else {
      try {
        const updated = await updateTunnelSessionForAuthenticatedDevice(
          tunnelId,
          authenticatedDeviceId,
          { status: 'connecting' },
          'pending'
        );
        if (updated) {
          // Register ownership so agent binary frames are accepted
          // and early data can be buffered before the browser connects.
          registerTunnelOwnership(tunnelId, agentId);
        } else {
          console.warn(
            `[AgentWs] Rejected tunnel ${tunnelId} open success from agent ${agentId}: ` +
            `authenticatedDevice=${authenticatedDeviceId}`
          );
        }
      } catch (err) {
        console.error(`[AgentWs] Failed to update tunnel session ${tunnelId}:`, err);
      }
    }
    return;
  }

  // Tunnel close/data command results are fire-and-forget.
  if (result.commandId.startsWith('tun-close-') || result.commandId.startsWith('tun-data-')) {
    return;
  }

  // Agent-initiated tunnel close notification (TCP peer disconnected or idle reaper).
  if (result.commandId.startsWith('tun-closed-')) {
    const tunnelId = result.commandId.slice('tun-closed-'.length);
    try {
      const updated = await updateTunnelSessionForAuthenticatedDevice(tunnelId, authenticatedDeviceId, {
        status: 'disconnected',
        endedAt: new Date(),
        errorMessage: result.error || null,
      });
      if (!updated) {
        console.warn(
          `[AgentWs] Rejected tunnel ${tunnelId} close from agent ${agentId}: ` +
          `authenticatedDevice=${authenticatedDeviceId}`
        );
        return;
      }
      await revokeViewerSession(tunnelId);
      console.log(`[AgentWs] Tunnel ${tunnelId} closed by agent${result.error ? ': ' + result.error : ''}`);
    } catch (err) {
      console.error(`[AgentWs] Failed to update tunnel session ${tunnelId} on close:`, err);
    }
    return;
  }

  // Discovery jobs use UUID IDs; skip lookup for non-UUID command IDs.
  if (!UUID_REGEX.test(result.commandId)) {
    console.warn(`[AgentWs] Command ${result.commandId} not found in deviceCommands or discovery jobs for agent ${agentId}`);
    return;
  }

  // Check if this is a discovery job result
  const [discoveryJob] = await db
    .select({ id: discoveryJobs.id, orgId: discoveryJobs.orgId, siteId: discoveryJobs.siteId, agentId: discoveryJobs.agentId })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.id, result.commandId))
    .limit(1);

  if (discoveryJob) {
    if (!discoveryJob.agentId || discoveryJob.agentId !== agentId) {
      console.warn(`[AgentWs] Rejecting discovery result for job ${discoveryJob.id} from unexpected agent ${agentId}`);
      return;
    }
    console.log(`[AgentWs] Processing discovery result for job ${discoveryJob.id} from agent ${agentId}`);
    try {
      const discoveryData = result.result as {
        jobId?: string;
        hosts?: DiscoveredHostResult[];
        hostsScanned?: number;
        hostsDiscovered?: number;
        adjacency?: DeviceAdjacency[];
      } | undefined;

      if (result.status !== 'completed' || !discoveryData?.hosts) {
        const errorMsg = result.error || result.stderr || `Agent returned status: ${result.status}`;
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: { message: errorMsg },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, discoveryJob.id));
        console.warn(`[AgentWs] Discovery job ${discoveryJob.id} failed: ${errorMsg}`);
        return;
      }

      if (isRedisAvailable()) {
        await enqueueDiscoveryResults(
          discoveryJob.id,
          discoveryJob.orgId,
          discoveryJob.siteId,
          normalizeDiscoveryHosts(discoveryData.hosts),
          discoveryData.hostsScanned ?? 0,
          discoveryData.hostsDiscovered ?? 0,
          undefined,
          discoveryData.adjacency ?? [],
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:discovery-result',
          }
        );
      } else {
        console.warn(`[AgentWs] Redis unavailable, cannot process ${discoveryData.hosts.length} discovery hosts for job ${discoveryJob.id}`);
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
          .where(eq(discoveryJobs.id, discoveryJob.id));
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process discovery results for ${agentId}:`, err);
      captureException(err);
      try {
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: { message: err instanceof Error ? err.message : 'Failed to enqueue discovery results' },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, discoveryJob.id));
      } catch (dbErr) {
        console.error(`[AgentWs] Additionally failed to mark discovery job ${discoveryJob.id} as failed:`, dbErr);
      }
    }
    return;
  }

  // Check if this is a backup job result
  const [backupJob] = await db
    .select({ id: backupJobs.id, orgId: backupJobs.orgId, deviceId: backupJobs.deviceId, agentId: devices.agentId })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(eq(backupJobs.id, result.commandId))
    .limit(1);

  if (backupJob) {
    if (!backupJob.agentId || backupJob.agentId !== agentId) {
      console.warn(`[AgentWs] Rejecting backup result for job ${backupJob.id} from unexpected agent ${agentId}`);
      return;
    }

    // Both guards below MUST run before consumeDispatchedExpectation: it is
    // one-shot, and consuming it for a non-terminal signal would cause the
    // real terminal result to be dropped later as a "replay".

    // Started-ack guard: an async-capable agent (backup_run_async) reports an
    // immediate `{"started":true}` result right after dispatch, well before
    // the backup completes. Treat it as a progress ping, not a terminal
    // result.
    const startedAckPayload = tryParseBackupResultPayload(result.result, result.stdout);
    if (isBackupStartedAck(startedAckPayload)) {
      // applyBackupStartedAck's guarded update no-ops (returns false) when the
      // job is already terminal — only log the "started-ack" line when it
      // actually applied, so an incident timeline isn't misled by a started-ack
      // that landed after the job had already completed/failed/been reaped.
      const startedAckApplied = await applyBackupStartedAck({ jobId: backupJob.id, deviceId: backupJob.deviceId });
      if (startedAckApplied) {
        console.log(`[AgentWs] Backup job ${backupJob.id} started-ack from agent ${agentId}`);
      } else {
        console.debug(`[AgentWs] Ignoring started-ack for already-terminal backup job ${backupJob.id} from agent ${agentId} (no-op)`);
      }
      return;
    }

    // Legacy timed-out guard: old agents' forwardToBackupHelper
    // (agent/internal/heartbeat/backup_forwarder.go, timing out via
    // sessionbroker Session.SendCommand) surfaces a "command timed out" result
    // at exactly 10 minutes while the upload helper is still running. This
    // falsely fails every backup over 10 minutes today; the stale-backup-job
    // reaper now owns deciding when a silent job is actually dead.
    if (isLegacyBackupTimeoutResult({ status: result.status, error: result.error, stderr: result.stderr })) {
      console.warn(
        `[AgentWs] Ignoring legacy 10-minute timed-out result for backup job ${backupJob.id} from agent ${agentId}: ` +
        `agent may still be uploading; the stale-backup reaper owns deciding when this job is actually dead.`
      );
      return;
    }

    // Integrity gate (F6): accept a backup completion only if it corresponds to a
    // dispatch we recorded and hasn't already been consumed. This blocks a
    // compromised agent that preemptively reports `completed` with fabricated
    // metadata, replays a result, or re-drives an already-terminal/never-dispatched
    // job UUID. Fail-closed: Redis unavailable ⇒ dropped (not trusted).
    const backupExpectation = await consumeDispatchedExpectation('backup', backupJob.deviceId, backupJob.id);
    if (!backupExpectation.ok) {
      console.warn(
        `[AgentWs] Dropping backup result for job ${backupJob.id} from agent ${agentId}: ` +
        `no outstanding dispatch expectation (forged, replayed, or already-consumed). reason=expectation-not-consumed`
      );
      return;
    }
    console.log(`[AgentWs] Processing backup result for job ${backupJob.id} from agent ${agentId}`);
    try {
      // backup_run is not a "critical family", so the WS layer does not populate
      // result.result from the agent's stdout. Fall back to parsing stdout JSON so
      // snapshot id / total size / file count get recorded (F13 — otherwise a
      // completed backup shows Size "-" and Storage Used stays 0 B).
      // The agent forwards backup stdout as a JSON *string* in result.result (or
      // result.stdout), never a pre-parsed object. Decode it so the schema can
      // read snapshot id / total size / file count (F13). Without this a
      // completed backup shows Size "-" and Storage Used stays 0 B.
      let backupStructured: unknown = result.result ?? result.stdout;
      if (typeof backupStructured === 'string') {
        try {
          backupStructured = JSON.parse(backupStructured);
        } catch {
          backupStructured = undefined;
        }
      }
      const parsedBackup = backupCommandResultSchema.safeParse(backupStructured ?? {});
      const backupData = parsedBackup.success ? parsedBackup.data : undefined;
      const malformedPayloadError = parsedBackup.success
        ? null
        : `Malformed backup result payload: ${parsedBackup.error.issues.map((issue) => issue.message).join(', ')}`;

      if (isRedisAvailable()) {
        await enqueueBackupResults(
          backupJob.id,
          backupJob.orgId,
          backupJob.deviceId,
          {
            // A malformed stdout must not ride an agent-reported 'completed'
            // through to a completed job with no snapshot (mirrors the inline
            // path below). Without this, a truncated/invalid system_image
            // result completes green and the parse error is discarded.
            status: result.status === 'completed' && parsedBackup.success ? 'completed' : 'failed',
            snapshotId: backupData?.snapshotId,
            filesBackedUp: backupData?.filesBackedUp,
            bytesBackedUp: backupData?.bytesBackedUp,
            warning: backupData?.warning,
            errorCount: backupData?.errorCount,
            referencedFiles: backupData?.referencedFiles,
            referencedBytes: backupData?.referencedBytes,
            backupType: backupData?.backupType,
            systemStateManifest: backupData?.systemStateManifest,
            snapshot: backupData?.snapshot,
            error: malformedPayloadError || result.error || result.stderr,
          },
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:backup-result',
          }
        );
      } else {
        console.warn(`[AgentWs] Redis unavailable, marking backup job ${backupJob.id} with inline result`);
        const persisted = await applyBackupCommandResultToJob({
          jobId: backupJob.id,
          orgId: backupJob.orgId,
          deviceId: backupJob.deviceId,
          resultStatus: result.status === 'completed' && parsedBackup.success ? 'completed' : 'failed',
          result: {
            ...(backupData ?? {}),
            error: malformedPayloadError || result.error || result.stderr,
          },
        });
        if (!persisted.applied) {
          console.warn(`[AgentWs] Ignoring stale inline backup result for job ${backupJob.id} from agent ${agentId}`);
        }
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process backup results for ${agentId}:`, err);
      captureException(err);
      // We already consumed the dispatch expectation but persistence failed
      // (e.g. transient BullMQ/DB error). Re-record it so a legitimate agent
      // retry of this same result can be accepted instead of being permanently
      // dropped as "already-consumed". Best-effort; safe to no-op on Redis down.
      await recordDispatchedExpectation('backup', backupJob.deviceId, backupJob.id);
    }
    return;
  }

  // Check if this is a restore job result
  const [restoreJob] = await db
    .select({
      id: restoreJobs.id,
      orgId: restoreJobs.orgId,
      agentId: devices.agentId,
      status: restoreJobs.status,
      restoreType: restoreJobs.restoreType,
      targetConfig: restoreJobs.targetConfig,
    })
    .from(restoreJobs)
    .innerJoin(devices, eq(restoreJobs.deviceId, devices.id))
    .where(eq(restoreJobs.commandId, result.commandId))
    .limit(1);

  if (restoreJob) {
    if (!restoreJob.agentId || restoreJob.agentId !== agentId) {
      console.warn(`[AgentWs] Rejecting restore result for job ${restoreJob.id} from unexpected agent ${agentId}`);
      return;
    }
    console.log(`[AgentWs] Processing restore result for job ${restoreJob.id} from agent ${agentId}`);
    try {
      const commandType = inferRestoreCommandType(restoreJob);
      const { normalizedResult, validationError } = normalizeCriticalResultIfNeeded(commandType, result);
      if (validationError) {
        console.warn(`[AgentWs] ${validationError} for restore job ${restoreJob.id}`);
        // Mark restore job as failed so it doesn't stay stuck in pending/running
        await updateRestoreJobFromResult(restoreJob, commandType, {
          ...normalizedResult,
          status: 'failed',
          error: validationError,
        });
        return;
      }
      await updateRestoreJobFromResult(restoreJob, commandType, normalizedResult);
    } catch (err) {
      console.error(`[AgentWs] Failed to process restore results for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }

  console.warn(`[AgentWs] Command ${result.commandId} not found in deviceCommands, discovery/backup jobs, or restore jobs for agent ${agentId}`);
}

/**
 * Process command result from agent
 */
async function processCommandResult(
  agentId: string,
  result: z.infer<typeof commandResultSchema>,
  deviceId?: string,
  orgId?: string
): Promise<void> {
  try {
    // #2434 chokepoint — FIRST statement, so "any agent result that enters this
    // function is redacted" is a true invariant for every exit path below
    // (in-process awaiter, orphaned-result branch, device_commands write, and
    // the per-type handler dispatch). Mirrors processOrphanedCommandResult,
    // which redacts at its own top. Idempotent, so downstream re-redaction of
    // the same text is harmless.
    result = redactAgentResultErrorFields(result);

    // Resolve any in-process promise awaiting this command id (e.g. http_request
    // sent via sendCommandToAgentAwaitResult). No-op for all other result types.
    // When consumed, the result has no device_commands row and needs no further
    // dispatch — short-circuit to avoid 3 needless DB lookups + a console.warn
    // per result (matters for a proxy issuing many http_request commands).
    const consumed = resolvePendingAgentCommand(result.commandId, {
      status: result.status,
      result: result.result,
      stdout: result.stdout,
      error: result.error,
    });
    if (consumed) return;

    // Non-UUID command IDs (for example mon-* and snmp-*) are dispatched directly
    // over WebSocket and do not have a device_commands row.
    if (!UUID_REGEX.test(result.commandId)) {
      await processOrphanedCommandResult(agentId, deviceId ?? '', result);
      return;
    }

    // Look up command by ID + deviceId directly (device_commands has no RLS).
    // Previous approach JOINed through devices table which has RLS and could
    // fail when the DB context didn't grant access to the org's devices.
    let command: typeof deviceCommands.$inferSelect | undefined;
    let resolvedDeviceId: string | undefined = deviceId;

    if (resolvedDeviceId) {
      // Query device_commands OUTSIDE the current transaction context.
      // device_commands has no RLS; querying via the pool (auto-commit)
      // guarantees visibility of recently committed rows.
      const did = resolvedDeviceId;
      const [row] = await runOutsideDbContext(() =>
        db
          .select()
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.id, result.commandId),
              eq(deviceCommands.deviceId, did),
              eq(deviceCommands.targetRole, 'agent'),
              inArray(deviceCommands.status, ACCEPTED_COMMAND_RESULT_STATUSES)
            )
          )
          .limit(1)
      );
      command = row;
    } else {
      // Fallback: resolve deviceId from agentId via devices table
      const [ownedCommand] = await db
        .select({
          command: deviceCommands,
          deviceId: devices.id
        })
        .from(deviceCommands)
        .innerJoin(devices, eq(deviceCommands.deviceId, devices.id))
        .where(
          and(
            eq(deviceCommands.id, result.commandId),
            eq(devices.agentId, agentId),
            eq(deviceCommands.targetRole, 'agent'),
            inArray(deviceCommands.status, ACCEPTED_COMMAND_RESULT_STATUSES)
          )
        )
        .limit(1);
      command = ownedCommand?.command;
      resolvedDeviceId = ownedCommand?.deviceId;
    }

    if (!command || !resolvedDeviceId) {
      // Discovery and SNMP commands are dispatched directly via WebSocket
      // without creating a deviceCommands record. Handle them here.
      await processOrphanedCommandResult(agentId, deviceId ?? '', result);
      return;
    }

    if (command.targetRole && command.targetRole !== 'agent') {
      console.warn(`[AgentWs] Ignoring ${command.targetRole} command result ${result.commandId} on agent websocket for ${agentId}`);
      return;
    }

    // Finding #3 (defense-in-depth): before terminally updating a device-bound
    // command row + firing downstream handlers, re-verify the device wasn't
    // decommissioned/quarantined or its token suspended (org/partner tenant
    // suspension denormalizes onto devices.agentTokenSuspendedAt) after this
    // long-lived socket was established. Cost: one extra indexed row read per
    // device-bound (UUID) command result — acceptable, and NOT run on the
    // high-frequency pong/terminal-output frames. If contained, sever
    // the authoritative socket and abort without persisting the result.
    if (!(await isAgentDeviceStillAuthorized(agentId))) {
      console.warn(
        `[AgentWs] Aborting command result ${result.commandId} for ${agentId}: device contained (decommissioned/quarantined/suspended). Severing socket.`
      );
      disconnectAgent(agentId, 4001, 'Device no longer authorized');
      return;
    }

    // `result` was already redacted at the top of this function (#2434), and
    // normalizeCriticalResultIfNeeded only ever REPLACES `error` with a
    // server-generated rejection reason — so normalizedResult.error/stderr are
    // redacted by construction and feed both the device_commands write and the
    // per-type handler dispatch below.
    const {
      normalizedResult,
      stdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, result);

    // Update outside transaction for same visibility reasons as the lookup.
    const updatedCommands = await runOutsideDbContext(() =>
      db
        .update(deviceCommands)
        .set({
            status: normalizedResult.status === 'completed' ? 'completed' : 'failed',
            completedAt: new Date(),
            result: buildStoredCommandResult(command.type, normalizedResult, stdout)
        })
        .where(
          and(
            eq(deviceCommands.id, result.commandId),
            eq(deviceCommands.deviceId, resolvedDeviceId!),
            eq(deviceCommands.targetRole, 'agent'),
            inArray(deviceCommands.status, ACCEPTED_COMMAND_RESULT_STATUSES)
          )
        )
        .returning({ id: deviceCommands.id })
    );

    if (updatedCommands.length === 0) {
      console.warn(`[AgentWs] Ignoring stale or already-processed command result ${result.commandId} for agent ${agentId}`);
      return;
    }

    // Finding #8: emit the append-only audit event for a WS-ingested command
    // result, matching the REST path (routes/agents/commands.ts). Placed
    // immediately after the compare-and-set above so it fires EXACTLY ONCE and
    // ONLY when the row actually transitioned to a terminal state — a
    // duplicate/late result no-ops the UPDATE and returns above, never audited.
    // Emitted before the validationError early-return because a
    // validation-rejected result still transitioned the row to 'failed'.
    writeAuditEvent(WS_AUDIT_REQUEST, {
      orgId: orgId ?? null,
      actorType: 'agent',
      actorId: agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: result.commandId,
      details: {
        commandType: command.type,
        status: normalizedResult.status,
        exitCode: normalizedResult.exitCode ?? null,
      },
      result: normalizedResult.status === 'completed' ? 'success' : 'failure',
    });

    if (validationError) {
      console.warn(`[AgentWs] ${validationError} — command ${result.commandId} rejected for agent ${agentId}`);
      // Still dispatch to the per-type handler for verify/restore families so
      // the linked backup_verifications / restore_jobs record transitions to a
      // terminal 'failed' state instead of stranding until the stale-timeout
      // sweep. normalizedResult already carries status 'failed' + the rejection
      // reason as `error`, so the handler's normal failure path applies.
      const rejectedFamily = detectResultValidationFamily(command.type);
      if (rejectedFamily && TERMINAL_TRANSITION_FAMILIES_ON_VALIDATION_FAILURE.has(rejectedFamily)) {
        const rejectedHandler = commandResultHandlers[command.type];
        if (rejectedHandler) {
          try {
            await rejectedHandler({ agentId, command, result: normalizedResult, resolvedDeviceId: resolvedDeviceId!, stdout });
          } catch (handlerErr) {
            console.error(`[AgentWs] Failed to finalize rejected ${command.type} result ${result.commandId}:`, handlerErr);
            captureException(handlerErr);
          }
        }
      }
      return;
    }

    console.log(`Command ${result.commandId} ${normalizedResult.status} for agent ${agentId}`);

    const commandPayload =
      command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
        ? command.payload as Record<string, unknown>
        : {};
    if (DR_COMMAND_TYPES.has(command.type) && typeof commandPayload.drExecutionId === 'string') {
      try {
        const { handleDrCommandResult } = await import('./backup/drResultHandler');
        await handleDrCommandResult({
          commandId: result.commandId,
          commandType: command.type,
          deviceId: resolvedDeviceId,
          status: normalizedResult.status,
          result: normalizedResult.result,
          payload: commandPayload,
        });
      } catch (err) {
        console.error(`[AgentWs] Failed to persist DR result state for ${result.commandId}:`, err);
        captureException(err);
      }

      try {
        const { enqueueDrExecutionReconcile } = await import('../jobs/drExecutionWorker');
        await enqueueDrExecutionReconcile(commandPayload.drExecutionId);
      } catch (err) {
        console.error(`[AgentWs] Failed to enqueue DR reconciliation for ${result.commandId}:`, err);
        captureException(err);
      }
    }

    // Dispatch to per-command-type handler if one is registered
    const handler = commandResultHandlers[command.type];
    if (handler) {
      await handler({ agentId, command, result: normalizedResult, resolvedDeviceId: resolvedDeviceId!, stdout });
    }
  } catch (error) {
    console.error(`[AgentWs] Failed to process command result for ${agentId}:`, error);
    captureException(error);
  }
}

/**
 * Create WebSocket handlers for a given agentId with a pre-validated context.
 * Authentication is done BEFORE the WebSocket upgrade in the HTTP middleware,
 * so onOpen no longer needs to validate the token.
 */
export function createAgentWsHandlers(agentId: string, preValidatedAgent: AgentDbContext) {
  const agentDb = preValidatedAgent;

  const runWithAgentDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
    return withDbAccessContext(
      {
        scope: 'organization',
        orgId: agentDb.orgId,
        accessibleOrgIds: [agentDb.orgId],
        // Agents are org-scoped; they have no access to partner-level tables.
        accessiblePartnerIds: [],
        // Agents don't browse the catalog as org users; null disables the
        // partner-wide read branch (safe).
        currentPartnerId: null
      },
      fn
    );
  };

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      // Finding #4: enforce the one-socket-per-agent invariant. A second socket
      // for the same agentId would otherwise overwrite the map entry WITHOUT
      // closing the previous socket, leaving an orphaned-but-authorized socket
      // whose onMessage handler + captured authorization keep working while
      // revocation/disconnect (which only act on the mapped socket) miss it.
      // Close the previous socket before replacing it so `activeConnections`
      // stays authoritative and disconnectAgent can never miss a live socket.
      const previousWs = activeConnections.get(agentId);
      if (previousWs && previousWs !== ws) {
        try {
          previousWs.close(4002, 'Superseded by newer connection');
        } catch {
          // Best-effort: the orphan may already be torn down.
        }
      }

      // Clean up any existing ping state from a previous connection
      const existingPingState = agentPingStates.get(agentId);
      if (existingPingState) {
        clearInterval(existingPingState.pingInterval);
        agentPingStates.delete(agentId);
      }

      // Store connection
      activeConnections.set(agentId, ws);
      console.log(`Agent ${agentId} connected via WebSocket. Active connections: ${activeConnections.size}`);

      // Update device status under tenant DB context. Pending commands are
      // deliberately NOT claimed here (#2407): no agent version has ever
      // parsed `pendingCommands` out of the welcome frame
      // (handleConnectedMessage negotiates capabilities only), so claiming
      // them marked rows 'sent' that were never delivered or executed —
      // they sat falsely 'sent' until the stale-command reaper flipped them
      // to 'failed' with a misleading agent-timeout error. Queued commands
      // stay 'pending' and reach the agent through the working paths: the
      // HTTP heartbeat claim (the agent heartbeats immediately on startup)
      // and executeCommand's direct per-command push while the socket is
      // live.
      await runWithAgentDbAccess(async () => {
        await updateDeviceStatus(agentId, 'online');
      });

      // Publish device.online event for real-time UI updates
      if (agentDb) {
        try {
          const [deviceInfo] = await runWithAgentDbAccess(async () =>
            db.select({ id: devices.id, siteId: devices.siteId, hostname: devices.hostname, agentVersion: devices.agentVersion })
              .from(devices)
              .where(eq(devices.agentId, agentId))
              .limit(1)
          );
          if (deviceInfo) {
            publishEvent('device.online', agentDb.orgId, {
              deviceId: deviceInfo.id,
              hostname: deviceInfo.hostname,
              agentVersion: deviceInfo.agentVersion,
              status: 'online',
            }, 'agent-ws', { siteId: deviceInfo.siteId }).catch(err => {
              console.error('[AgentWs] Failed to publish device.online:', err);
              captureException(err);
            });
          }
        } catch (err) {
          console.error('[AgentWs] Failed to query device for online event:', err);
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
      }

      // Send welcome message (capabilities negotiation only — see the
      // pending-commands note above).
      ws.send(JSON.stringify({
        type: 'connected',
        agentId,
        timestamp: Date.now(),
        capabilities: [...AGENT_WS_CAPABILITIES],
      }));

      // Start server-side ping/pong for stale connection detection
      const now = Date.now();
      const pingInterval = setInterval(() => {
        const state = agentPingStates.get(agentId);
        if (!state) {
          clearInterval(pingInterval);
          return;
        }
        const elapsed = Date.now() - state.lastPongAt;
        if (elapsed > AGENT_PING_INTERVAL_MS + AGENT_PONG_TIMEOUT_MS) {
          console.warn(`Agent ${agentId} pong timeout (${elapsed}ms), closing`);
          clearInterval(pingInterval);
          agentPingStates.delete(agentId);
          ws.close(4008, 'Pong timeout');
          return;
        }
        try {
          ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        } catch (err) {
          console.warn(`[AgentWs] Ping send failed for agent ${agentId}, cleaning up`, err);
          clearInterval(pingInterval);
          agentPingStates.delete(agentId);
        }
      }, AGENT_PING_INTERVAL_MS);
      agentPingStates.set(agentId, { pingInterval, lastPongAt: now, ws });
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      try {
        const authenticatedAgent = agentDb;

        // Binary fast-path for desktop frames: [0x02][36-byte sessionId][JPEG data]
        if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
          const buf = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data);
          // Size limit: 5MB max for binary frames
          if (buf.length > 5_000_000) {
            console.warn(`[AgentWs] Dropping oversized binary frame from agent ${agentId}: ${buf.length} bytes`);
            return;
          }
          if (buf.length > 37 && buf[0] === 0x02) {
            const sessionId = buf.subarray(1, 37).toString('utf8');
            if (!isDesktopSessionOwnedByAgent(sessionId, agentId)) {
              return; // agent does not own this desktop session
            }
            const frameData = buf.subarray(37);
            handleDesktopFrame(sessionId, new Uint8Array(frameData));
            return;
          }
          // Tunnel data frames: [0x03][36-byte tunnelId][payload]
          if (buf.length > 37 && buf[0] === 0x03) {
            // Tighter size limit for tunnel data: 1MB
            if (buf.length > 1_000_000) {
              console.warn(`[AgentWs] Dropping oversized tunnel frame from agent ${agentId}: ${buf.length} bytes`);
              return;
            }
            const tunnelId = buf.subarray(1, 37).toString('utf8');
            if (!isTunnelOwnedByAgent(tunnelId, agentId)) {
              return;
            }
            handleTunnelDataFromAgent(tunnelId, new Uint8Array(buf.subarray(37)));
            return;
          }
        }

        const data = typeof event.data === 'string'
          ? event.data
          : event.data.toString();

        const message = JSON.parse(data);

        // Handle pong responses for server-initiated ping
        if (message.type === 'pong') {
          const state = agentPingStates.get(agentId);
          if (state) {
            state.lastPongAt = Date.now();
          }
          return;
        }

        // Agent heartbeats also prove the connection is alive
        if (message.type === 'heartbeat') {
          const state = agentPingStates.get(agentId);
          if (state) {
            state.lastPongAt = Date.now();
          }
        }

        // Handle terminal_output messages directly (high-frequency streaming
        // data that doesn't need full schema validation, but H5: validate the
        // shape before any field access).
        if (message?.type === 'terminal_output') {
          const parsed = terminalOutputFastPathSchema.safeParse(message);
          if (!parsed.success) {
            console.warn(`[AgentWs] Dropping malformed terminal_output from agent ${agentId}: ${parsed.error.issues[0]?.message}`);
            return;
          }
          const { sessionId, data: termData, encoding } = parsed.data;
          const termSession = getActiveTerminalSession(sessionId);
          if (!termSession || termSession.agentId !== agentId) {
            console.warn(`[AgentWs] Dropping terminal_output for unowned session ${sessionId} from agent ${agentId}`);
            recordCrossTenantDrop(agentId, authenticatedAgent?.deviceId, 'terminal_output');
            return;
          }
          const decodedOutput = decodeTerminalOutput(termData, encoding);
          if (decodedOutput === null) {
            console.warn(`[AgentWs] Dropping terminal_output with invalid base64 from agent ${agentId} session ${sessionId}`);
            return;
          }
          handleTerminalOutput(
            sessionId,
            decodedOutput,
          );
          return;
        }

        // Handle update_status messages: agent is about to self-update
        if (message.type === 'update_status' && typeof message.targetVersion === 'string') {
          if (agentDb) {
            await runWithAgentDbAccess(async () => {
              try {
                // Same terminal-status guard as updateDeviceStatus (#2230):
                // this write must not resurrect a decommissioned/quarantined
                // row to 'updating'.
                await db
                  .update(devices)
                  .set({
                    status: 'updating',
                    lastSeenAt: new Date(),
                    updatedAt: new Date()
                  })
                  .where(and(
                    eq(devices.agentId, agentId),
                    notInArray(devices.status, [...TERMINAL_DEVICE_STATUSES])
                  ));
                console.log(`[AgentWs] Agent ${agentId} entering update to ${message.targetVersion}`);
              } catch (error) {
                console.error(`[AgentWs] Failed to set updating status for ${agentId}:`, error);
              }
            });
          }
          return;
        }

        // Handle command_result for terminal/desktop commands (non-UUID IDs).
        // H5: validate the message shape with Zod BEFORE any field access. On
        // parse failure we drop + log without touching the DB or downstream.
        if (message?.type === 'command_result' && typeof message.commandId === 'string' &&
            (message.commandId.startsWith('term-') || message.commandId.startsWith('desk-'))) {
          const isTerm = message.commandId.startsWith('term-');
          const fastPathParse = isTerm
            ? terminalCommandResultSchema.safeParse(message)
            : desktopCommandResultSchema.safeParse(message);
          if (!fastPathParse.success) {
            console.warn(
              `[AgentWs] Dropping malformed ${isTerm ? 'term-' : 'desk-'}command_result from agent ${agentId}: ` +
              `${fastPathParse.error.issues[0]?.message ?? 'invalid shape'}`
            );
            return;
          }
          const fastMsg = fastPathParse.data;
          const fastCommandId = fastMsg.commandId;
          const fastStatus = fastMsg.status;
          // Narrow to a uniform record so downstream desk-* / term-* handlers
          // can read fields the schema already validated.
          const fastResult: Record<string, unknown> | undefined =
            fastMsg.result as Record<string, unknown> | undefined;
          const fastError = fastMsg.error;
          if (isTerm && fastStatus === 'failed') {
            // Extract sessionId from commandId (e.g. "term-start-<sessionId>")
            const parts = fastCommandId.split('-');
            // Format: term-<action>-<sessionId>, sessionId may contain hyphens (UUID)
            const termSessionId = parts.length >= 3 ? parts.slice(2).join('-') : null;
            if (termSessionId) {
              const termSession = getActiveTerminalSession(termSessionId);
              if (termSession && termSession.agentId === agentId) {
                const errorDetail = fastError ?? 'Unknown error';
                try {
                  termSession.userWs.send(JSON.stringify({
                    type: 'error',
                    code: 'TERMINAL_START_FAILED',
                    message: `Agent failed to start terminal: ${errorDetail}`
                  }));
                  termSession.userWs.close(4003, 'Terminal start failed');
                } catch (sendErr) {
                  console.error(`[AgentWs] Failed to notify user of terminal failure for session ${termSessionId}:`, sendErr);
                }
                unregisterTerminalOutputCallback(termSessionId);
                console.warn(`[AgentWs] Terminal start failed for session ${termSessionId}: ${errorDetail}`);
              } else if (termSession) {
                // Schema-passing but ownership-failing — count as probe drop.
                recordCrossTenantDrop(agentId, authenticatedAgent?.deviceId, 'term_failed');
              }
            }
          }
          // Handle WebRTC peer disconnect notifications from agent
          if (fastCommandId.startsWith('desk-disconnect-') &&
              fastStatus === 'completed' &&
              fastResult) {
            const expectedSessionId = extractDesktopSessionId(fastCommandId, 'desk-disconnect-');
            const resultSessionId = typeof fastResult.sessionId === 'string' && fastResult.sessionId.length <= MAX_DESKTOP_SESSION_ID_BYTES
              ? fastResult.sessionId
              : null;
            const sessionId =
              expectedSessionId && (!resultSessionId || resultSessionId === expectedSessionId)
                ? expectedSessionId
                : null;
            if (sessionId && fastResult.event === 'peer_disconnected') {
              try {
                await runWithAgentDbAccess(async () => {
                  const result = await db
                    .update(remoteSessions)
                    .set({ status: 'disconnected', endedAt: new Date() })
                    .where(
                      and(
                        eq(remoteSessions.id, sessionId),
                        eq(remoteSessions.deviceId, authenticatedAgent.deviceId),
                        eq(remoteSessions.status, 'active')
                      )
                    )
                    .returning({ id: remoteSessions.id });
                  if (result.length > 0) {
                    // Kill the viewer token too: a peer drop (tab crash, network
                    // blip, agent restart) must not leave a still-valid token that
                    // can resurrect the session via /viewer/offer. Finding #5.
                    await revokeViewerSession(sessionId);
                    console.log(`[AgentWs] Session ${sessionId} marked disconnected (peer dropped)`);
                  }
                });
              } catch (err) {
                console.error(`[AgentWs] Failed to update session disconnect:`, err);
              }
            }
          }

          // Consent denial from the agent's consent gate (Task 9). The agent
          // returns a COMPLETED desk-start result carrying a `consent_denied`
          // marker (no capture started) when the end user declined, the prompt
          // timed out, or the consent-unavailable policy chose to block. Finalize
          // the session as `denied` and audit the decision. Mirrors the
          // operator-facing POST /sessions/:id/deny path (remote/sessions.ts).
          if (fastCommandId.startsWith('desk-start-') &&
              fastStatus === 'completed' &&
              fastResult &&
              fastResult.event === 'consent_denied') {
            const expectedSessionId = extractDesktopSessionId(fastCommandId, 'desk-start-');
            const resultSessionId = typeof fastResult.sessionId === 'string' && fastResult.sessionId.length <= MAX_DESKTOP_SESSION_ID_BYTES
              ? fastResult.sessionId
              : null;
            const sessionId = resolveConsentMarkerSessionId(expectedSessionId, resultSessionId);
            const reason = typeof fastResult.reason === 'string' ? fastResult.reason : 'no_user';
            if (sessionId) {
              try {
                await runWithAgentDbAccess(async () => {
                  const [updated] = await db
                    .update(remoteSessions)
                    .set({ status: 'denied', endedAt: new Date() })
                    .where(
                      and(
                        eq(remoteSessions.id, sessionId),
                        eq(remoteSessions.deviceId, authenticatedAgent.deviceId),
                        eq(remoteSessions.status, 'connecting')
                      )
                    )
                    .returning({ id: remoteSessions.id, orgId: remoteSessions.orgId, userId: remoteSessions.userId, type: remoteSessions.type });

                  if (updated) {
                    // Kill the viewer token so a lingering token can't resurrect
                    // a denied session via /viewer/offer.
                    await revokeViewerSession(sessionId);
                    // A genuine user denial or a consent timeout is a "denied"
                    // decision; any other reason (no user present, helper absent,
                    // malformed reply) is a bypass/unavailable path, audited
                    // distinctly. Shared classifier keeps this in lockstep with
                    // the operator deny route (remote/sessions.ts).
                    const action = classifyConsentDenyAction(reason);
                    await logSessionAudit(
                      action,
                      updated.userId,
                      updated.orgId,
                      { sessionId, type: updated.type, reason }
                    );
                    console.log(`[AgentWs] Session ${sessionId} denied by consent gate (reason=${reason})`);
                  } else {
                    console.warn(`[AgentWs] Consent-denied session ${sessionId} not found or not in connecting state`);
                  }
                });
              } catch (err) {
                console.error(`[AgentWs] Failed to mark session denied:`, err);
              }
            }
          }

          // Store WebRTC answer from start_desktop command results
          if (fastCommandId.startsWith('desk-start-') &&
              fastStatus === 'completed' &&
              fastResult &&
              fastResult.event !== 'consent_denied') {
            const expectedSessionId = extractDesktopSessionId(fastCommandId, 'desk-start-');
            const resultSessionId = typeof fastResult.sessionId === 'string' && fastResult.sessionId.length <= MAX_DESKTOP_SESSION_ID_BYTES
              ? fastResult.sessionId
              : null;
            const sessionId = resolveConsentMarkerSessionId(expectedSessionId, resultSessionId);
            const answer = typeof fastResult.answer === 'string' ? fastResult.answer : null;
            if (sessionId && answer && answer.length < 65536) {
              try {
                await runWithAgentDbAccess(async () => {
                  const [updated] = await db
                    .update(remoteSessions)
                    .set({
                      webrtcAnswer: answer,
                      status: 'active',
                      startedAt: new Date()
                    })
                    .where(
                      and(
                        eq(remoteSessions.id, sessionId),
                        eq(remoteSessions.deviceId, authenticatedAgent.deviceId),
                        eq(remoteSessions.status, 'connecting')
                      )
                    )
                    .returning({ id: remoteSessions.id, orgId: remoteSessions.orgId, userId: remoteSessions.userId, type: remoteSessions.type });

                  if (updated) {
                    console.log(`[AgentWs] Stored WebRTC answer for session ${sessionId}`);
                    // When the session was gated by a `consent` prompt that the
                    // user allowed, the agent rides a `consentReason: 'user'`
                    // marker alongside the answer. Emit a dedicated
                    // `session_consent_granted` audit so the grant is recorded
                    // independently of activation. Mirrors the /answer route.
                    if (fastResult.consentReason === 'user') {
                      await logSessionAudit(
                        'session_consent_granted',
                        updated.userId,
                        updated.orgId,
                        { sessionId, type: updated.type, reason: 'user' }
                      );
                    }
                  } else {
                    console.warn(`[AgentWs] Session ${sessionId} not found or not owned by agent ${agentId}`);
                  }
                });
              } catch (err) {
                console.error(`[AgentWs] Failed to store WebRTC answer:`, err);
              }
            }
          }

          // Propagate start_desktop failures to the session so the viewer
          // sees the error immediately instead of polling until timeout.
          if (fastCommandId.startsWith('desk-start-') &&
              fastStatus === 'failed') {
            const failResult = fastResult ?? {};
            const expectedSessionId = extractDesktopSessionId(fastCommandId, 'desk-start-');
            const resultSessionId = typeof failResult.sessionId === 'string' && failResult.sessionId.length <= MAX_DESKTOP_SESSION_ID_BYTES
              ? failResult.sessionId
              : null;
            const sessionId =
              expectedSessionId && (!resultSessionId || resultSessionId === expectedSessionId)
                ? expectedSessionId
                : null;
            // #2434: agent-supplied failure text is persisted to
            // remote_sessions.errorMessage and shown to viewers — redact
            // secrets first (fast path bypasses the command-result chokepoint).
            const errorMsg = redactSecretsFromOutput(
              typeof failResult.error === 'string'
                ? failResult.error.slice(0, 1024)
                : fastError
                  ? fastError.slice(0, 1024)
                  : 'Desktop capture failed on agent'
            );
            if (sessionId) {
              try {
                await runWithAgentDbAccess(async () => {
                  const result = await db
                    .update(remoteSessions)
                    .set({
                      status: 'failed',
                      errorMessage: errorMsg,
                      endedAt: new Date()
                    })
                    .where(
                      and(
                        eq(remoteSessions.id, sessionId),
                        eq(remoteSessions.deviceId, authenticatedAgent.deviceId),
                        eq(remoteSessions.status, 'connecting')
                      )
                    )
                    .returning({ id: remoteSessions.id });

                  if (result.length > 0) {
                    await revokeViewerSession(sessionId);
                    console.log(`[AgentWs] Session ${sessionId} marked failed: ${errorMsg}`);
                  } else {
                    console.warn(`[AgentWs] Failed session ${sessionId} not found or not in connecting state`);
                  }
                });
              } catch (err) {
                console.error(`[AgentWs] Failed to mark session as failed:`, err);
              }
            }
          }

          ws.send(JSON.stringify({
            type: 'ack',
            commandId: fastCommandId
          }));
          return;
        }

        const parsed = agentMessageSchema.safeParse(message);

        if (!parsed.success) {
          console.warn(`Invalid message from agent ${agentId}:`, parsed.error.issues);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Invalid message format',
            details: parsed.error.issues
          }));
          return;
        }

        switch (parsed.data.type) {
          case 'command_result':
            await runWithAgentDbAccess(async () =>
              processCommandResult(agentId, parsed.data as z.infer<typeof commandResultSchema>, authenticatedAgent.deviceId, authenticatedAgent.orgId)
            );
            ws.send(JSON.stringify({
              type: 'ack',
              commandId: parsed.data.commandId
            }));
            break;

          case 'backup_progress': {
            const progressMessage = parsed.data as z.infer<typeof backupProgressMessageSchema>;
            await runWithAgentDbAccess(async () => {
              const applied = await applyBackupProgress({
                agentId,
                commandId: progressMessage.commandId,
                // Default to {} so a bare keepalive ping (no counters) still
                // parses and bumps last_progress_at instead of being dropped as
                // invalid-payload. All fields on the progress schema are
                // optional, so an empty body is a valid "still alive" signal.
                progress: progressMessage.progress ?? {},
              });
              if (!applied.applied) {
                // agent-mismatch is a real anomaly (an agent pinging another
                // device's job) and stays at warn. Everything else is routine
                // traffic — restore progress reuses this WS type with a
                // commandId that matches no backup job (not-found), a garbage
                // or non-UUID commandId is dropped pre-DB
                // (invalid-command-id), and terminal-status is a benign
                // completion race — so those drop quietly at debug.
                const dropLog = applied.reason === 'agent-mismatch' ? console.warn : console.debug;
                dropLog(
                  `[AgentWs] Dropping backup_progress for ${progressMessage.commandId} from agent ${agentId}: reason=${applied.reason}`
                );
              }
            });
            // Fire-and-forget: no ack expected by the agent for progress pings.
            break;
          }

          case 'heartbeat':
            {
              const heartbeatMessage = parsed.data as z.infer<typeof heartbeatMessageSchema>;

              // Finding #3 (defense-in-depth): the heartbeat's command-claim
              // path used to re-verify containment on the device row it
              // fetched. The claim is gone (#2407), but keep the sever so a
              // socket that outlived a containment change (decommission,
              // quarantine, token/tenant suspension) still drops on the next
              // heartbeat instead of staying online.
              if (!(await isAgentDeviceStillAuthorized(agentId))) {
                console.warn(
                  `[AgentWs] Severing heartbeat socket for ${agentId}: device contained (decommissioned/quarantined/suspended).`
                );
                disconnectAgent(agentId, 4001, 'Device no longer authorized');
                break;
              }

            // Update last seen timestamp
              await runWithAgentDbAccess(async () => {
                await updateDeviceStatus(agentId, 'online');
                if (heartbeatMessage.ipHistoryUpdate) {
                  if (heartbeatMessage.ipHistoryUpdate.deviceId && heartbeatMessage.ipHistoryUpdate.deviceId !== authenticatedAgent.deviceId) {
                    console.warn(`[AgentWs] rejecting mismatched ipHistoryUpdate.deviceId from ${agentId}: sent=${heartbeatMessage.ipHistoryUpdate.deviceId} expected=${authenticatedAgent.deviceId}`);
                  } else {
                    try {
                      await processDeviceIPHistoryUpdate(
                        authenticatedAgent.deviceId,
                        authenticatedAgent.orgId,
                        heartbeatMessage.ipHistoryUpdate
                      );
                    } catch (err) {
                      const errorCode = (err as Record<string, unknown>)?.code ?? 'UNKNOWN';
                      console.error(`[AgentWs] failed to process ip history (device=${authenticatedAgent.deviceId}, org=${authenticatedAgent.orgId}, dbError=${errorCode}):`, err);
                    }
                  }
                }
              });

              // Pending commands are deliberately NOT claimed here (#2407).
              // No shipped agent sends WS heartbeats (the agent heartbeats
              // over HTTP), and the agent's readPump skips ID-less frames —
              // heartbeat_ack included — so any commands embedded here would
              // be silently dropped while their rows sat falsely marked
              // 'sent'. `commands` stays in the ack, always empty, for
              // wire-shape stability with the REST heartbeat response.

              // Match the REST heartbeat: ship the active deployment trust
              // keyset on every ack so WS-connected agents (re-)pin the same
              // way REST-polling agents do. runOutsideDbContext is required
              // because the WS handler runs inside a tenant-scoped DB
              // context; the inner withSystemDbAccessContext in
              // getActiveTrustKeyset would otherwise be short-circuited and
              // RLS would return zero rows. Wrapped in try/catch so a
              // transient trust-keyset failure never breaks the ack (#644).
              //
              // On failure we emit `manifestTrustKeys: []` to mirror the REST
              // heartbeat handler in routes/agents/heartbeat.ts. The agent
              // gates pin updates on `len(ManifestTrustKeys) > 0` (see
              // agent/internal/heartbeat/heartbeat.go:2174), so empty and
              // omission are equivalent on the wire — emitting `[]` keeps the
              // two heartbeat paths byte-for-byte consistent and avoids
              // wire-shape divergence between WS and REST.
              let manifestTrustKeys: unknown[] = [];
              try {
                manifestTrustKeys = await runOutsideDbContext(() =>
                  getActiveTrustKeyset(),
                );
              } catch (err) {
                console.error(
                  `[AgentWs] Failed to load manifest trust keyset for agentId=${agentId}:`,
                  err,
                );
                captureException(err);
                manifestTrustKeys = [];
              }

              ws.send(JSON.stringify({
                type: 'heartbeat_ack',
                timestamp: Date.now(),
                commands: [],
                manifestTrustKeys,
              }));
              break;
            }

        }
      } catch (error) {
        console.error(`Error processing message from agent ${agentId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'PROCESSING_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

onClose: async (_event: unknown, ws: WSContext) => {
      // Clean up ping interval — but ONLY this ws's own ping state (Finding #4).
      // A superseded orphan closing must not clear the live (newer) socket's
      // ping state, so gate the delete on connection identity, mirroring the
      // `activeConnections.get(agentId) === ws` guard below.
      const pingState = agentPingStates.get(agentId);
      if (pingState && pingState.ws === ws) {
        clearInterval(pingState.pingInterval);
        agentPingStates.delete(agentId);
      }

      // Reset M-D1 cross-tenant probe counter on disconnect
      clearCrossTenantDropCounter(agentId);


      // Only remove from active connections if this ws is still the current one.
      // A reconnecting agent may have already replaced us in the map — deleting
      // the new connection's entry would make the agent unreachable.
      if (activeConnections.get(agentId) === ws) {
        activeConnections.delete(agentId);
        console.log(`Agent ${agentId} disconnected. Active connections: ${activeConnections.size}`);

        // Update device status to offline (but preserve 'updating' — let
        // the offline detector handle the timeout for stale updating devices)
        if (agentDb) {
          await runWithAgentDbAccess(async () => {
            try {
              const [current] = await db
                .select({ id: devices.id, siteId: devices.siteId, status: devices.status, hostname: devices.hostname })
                .from(devices)
                .where(eq(devices.agentId, agentId))
                .limit(1);
              if (!current) {
                console.warn(`[AgentWs] Device not found for agent ${agentId} on disconnect, skipping status update`);
                return;
              }
              if (current.status === 'updating') {
                console.log(`[AgentWs] Preserving 'updating' status for agent ${agentId} on disconnect`);
                return;
              }
              await updateDeviceStatus(agentId, 'offline');
              publishEvent('device.offline', agentDb.orgId, {
                deviceId: current.id,
                hostname: current.hostname,
              }, 'agent-ws', { siteId: current.siteId }).catch(err => {
                console.error('[AgentWs] Failed to publish device.offline:', err);
                captureException(err);
              });
            } catch (err) {
              console.error(`[AgentWs] Failed to check status for ${agentId} on disconnect, falling back to offline:`, err);
              await updateDeviceStatus(agentId, 'offline');
              publishEvent('device.offline', agentDb.orgId, {
                deviceId: agentId,
                hostname: '',
              }, 'agent-ws').catch(pubErr => {
                console.error('[AgentWs] Failed to publish device.offline:', pubErr);
                captureException(pubErr);
              });
            }
          });
        }
      } else {
        console.log(`Agent ${agentId} stale connection closed (newer connection active). Active connections: ${activeConnections.size}`);
      }
    },

    onError: (event: unknown, ws: WSContext) => {
      console.error(`WebSocket error for agent ${agentId}:`, event);
      // Clean up ping interval — ONLY this ws's own ping state (Finding #4), so a
      // superseded orphan erroring out can't clobber the live socket's state.
      const pingState = agentPingStates.get(agentId);
      if (pingState && pingState.ws === ws) {
        clearInterval(pingState.pingInterval);
        agentPingStates.delete(agentId);
      }
if (activeConnections.get(agentId) === ws) {
        activeConnections.delete(agentId);
      }
      if (agentDb) {
        void runWithAgentDbAccess(async () => {
          try {
            const [current] = await db
              .select({ status: devices.status })
              .from(devices)
              .where(eq(devices.agentId, agentId))
              .limit(1);
            if (!current) {
              console.warn(`[AgentWs] Device not found for agent ${agentId} on error disconnect, skipping status update`);
              return;
            }
            if (current.status === 'updating') {
              console.log(`[AgentWs] Preserving 'updating' status for agent ${agentId} on error disconnect`);
              return;
            }
          } catch (err) {
            console.error(`[AgentWs] Failed to check status for ${agentId} on error disconnect, falling back to offline:`, err);
          }
          await updateDeviceStatus(agentId, 'offline');
        }).catch((err) => {
          console.error(`[AgentWs] Failed to mark agent ${agentId} offline after error:`, err);
        });
      }
    }
  };
}

// M-D2: Distributed sliding-window rate limiter for agent WS connections.
// Uses Redis so multi-replica deployments share the limit. Falls back to a
// per-process in-memory limiter if Redis is degraded so a Redis blip cannot
// stop ALL agents from reconnecting (worse than the rate cap being slightly
// loose for the duration of the outage).
const WS_RATE_WINDOW_SECONDS = 60; // 1 minute window
const WS_RATE_MAX_CONNECTIONS = 6; // max 6 connections per agent per minute
const WS_RATE_WINDOW_MS = WS_RATE_WINDOW_SECONDS * 1000;
const wsConnTimestamps = new Map<string, number[]>(); // in-memory fallback only

// Wrapper around the shared rateLimiter so tests can mock the call surface.
// Lazy-imported to keep the surface trivially mockable without dragging redis
// into unit-test mocks.
async function checkAgentWsRateLimitDistributed(agentId: string): Promise<{ allowed: boolean; degraded: boolean }> {
  // Lazy require to avoid pulling redis client into hot import path / tests.
  const [{ getRedis }, { rateLimiter }] = await Promise.all([
    import('../services/redis'),
    import('../services/rate-limit'),
  ]);
  const redis = getRedis();
  if (!redis) {
    return { allowed: !inMemoryWsRateLimited(agentId), degraded: true };
  }
  try {
    const result = await rateLimiter(redis, `agentws:conn:${agentId}`, WS_RATE_MAX_CONNECTIONS, WS_RATE_WINDOW_SECONDS);
    return { allowed: result.allowed, degraded: false };
  } catch (err) {
    console.error(`[AgentWs] Redis rate-limit error for agent ${agentId}, falling back to in-memory:`, err);
    return { allowed: !inMemoryWsRateLimited(agentId), degraded: true };
  }
}

function inMemoryWsRateLimited(agentId: string): boolean {
  const now = Date.now();
  const cutoff = now - WS_RATE_WINDOW_MS;
  let timestamps = wsConnTimestamps.get(agentId);

  if (timestamps) {
    timestamps = timestamps.filter(t => t > cutoff);
  } else {
    timestamps = [];
  }

  if (timestamps.length >= WS_RATE_MAX_CONNECTIONS) {
    wsConnTimestamps.set(agentId, timestamps);
    return true;
  }

  timestamps.push(now);
  wsConnTimestamps.set(agentId, timestamps);
  return false;
}

// Periodic cleanup of stale in-memory entries (only used when Redis is degraded)
setInterval(() => {
  const cutoff = Date.now() - WS_RATE_WINDOW_MS * 2;
  for (const [agentId, timestamps] of wsConnTimestamps) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1]! < cutoff) {
      wsConnTimestamps.delete(agentId);
    }
  }
}, 120_000);

// H4: One-time deprecation warning per agent for missing Bearer header.
// Long-lived agent WS reconnects often, so debounce per agent.
const missingBearerWarnedAt = new Map<string, number>();
const MISSING_BEARER_WARN_DEBOUNCE_MS = 60 * 60 * 1000; // 1h
function warnAgentMissingBearer(agentId: string) {
  const now = Date.now();
  const last = missingBearerWarnedAt.get(agentId) ?? 0;
  if (now - last < MISSING_BEARER_WARN_DEBOUNCE_MS) return;
  missingBearerWarnedAt.set(agentId, now);
  console.warn(
    `[AgentWs] DEPRECATION: agent ${agentId} attempted WS connection without Authorization: Bearer header. ` +
    `Query-param token is no longer accepted. Update agent to send Bearer header (Go client already does as of v0.x).`
  );
}

// H5: Strict Zod schemas for fast-path command_result messages. We reject
// (drop + log) malformed payloads BEFORE any DB call or downstream side-effect.
const TERMINAL_OUTPUT_MAX_BYTES = 5 * 1024 * 1024; // 5MB ceiling
const SESSION_ID_MIN = 8;
const SESSION_ID_MAX = 128;

const terminalOutputFastPathSchema = z.object({
  type: z.literal('terminal_output'),
  sessionId: z.string().min(SESSION_ID_MIN).max(SESSION_ID_MAX),
  data: z.string().max(TERMINAL_OUTPUT_MAX_BYTES),
  encoding: z.enum(['base64']).optional(),
});

const terminalCommandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string().regex(/^term-[a-zA-Z0-9_-]+$/).max(128),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().max(8192).optional(),
  exitCode: z.number().int().optional(),
  result: z.object({
    event: z.enum(['session_started', 'session_ended', 'session_error']).optional(),
    sessionId: z.string().min(SESSION_ID_MIN).max(SESSION_ID_MAX).optional(),
    exitCode: z.number().int().optional(),
  }).strict().optional(),
}).passthrough();

const desktopCommandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string().regex(/^desk-[a-zA-Z0-9_-]+$/).max(256),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().max(8192).optional(),
  result: z.object({
    event: z.enum(['answer', 'ice_candidate', 'peer_disconnected', 'session_started', 'consent_denied']).optional(),
    sessionId: z.string().min(SESSION_ID_MIN).max(SESSION_ID_MAX).optional(),
    answer: z.string().max(65536).optional(),
    error: z.string().max(8192).optional(),
    candidate: z.unknown().optional(),
    // Consent gate markers (Task 9). `reason` accompanies a `consent_denied`
    // event; `consentReason` rides alongside a successful start when a consent
    // prompt was allowed by the user.
    reason: z.enum(['user', 'timeout', 'no_user', 'helper_absent']).optional(),
    consentReason: z.literal('user').optional(),
    // Desk-stop confirmations from fielded agents send {"stopped": true}
    // (agent/internal/heartbeat/handlers_desktop.go). Not consumed
    // server-side, but must be accepted so the result isn't dropped as
    // malformed (#2307).
    stopped: z.boolean().optional(),
  }).strict().optional(),
}).passthrough();

// M-D1 / Task 18: Cross-tenant probe detection.
//
// Increments per agentId on each schema-passing-but-ownership-failing
// fast-path drop. Two thresholds:
//
//   1. SUSPEND_THRESHOLD (5) — first action. We persistently suspend the
//      agent token in the DB (`agent_token_suspended_at`) and emit one
//      audit row + one Sentry capture. Subsequent reconnects and REST
//      calls fail at the auth gate with 401, producing a noisy reconnect
//      loop that surfaces the suspension to ops. A flaky agent making one
//      mistake every restart could never accumulate 5 in a 5-minute window
//      on a single WS connection.
//
//   2. WARN_THRESHOLD (10) — legacy diagnostic breadcrumb retained for
//      operators who watched for the M-D1 signal. Mostly redundant now
//      that we suspend earlier, but cheap to keep.
//
// The window is per-agent-per-WS-process. A stolen token spraying probes
// will hit threshold 1 within seconds; intentional separation from the
// REST rate limiter avoids polluting the org budget on hostile traffic.
const CROSS_TENANT_DROP_SUSPEND_THRESHOLD = 5;
const CROSS_TENANT_DROP_WARN_THRESHOLD = 10;
const CROSS_TENANT_DROP_WINDOW_MS = 5 * 60 * 1000;
type ProbeCounter = { drops: number; firstAt: number; warned: boolean; suspended: boolean };
const crossTenantDrops = new Map<string, ProbeCounter>();

function recordCrossTenantDrop(agentId: string, deviceId: string | undefined, kind: string) {
  const now = Date.now();
  let counter = crossTenantDrops.get(agentId);
  if (!counter || now - counter.firstAt > CROSS_TENANT_DROP_WINDOW_MS) {
    counter = { drops: 0, firstAt: now, warned: false, suspended: false };
    crossTenantDrops.set(agentId, counter);
  }
  counter.drops += 1;

  // Task 18: suspend the token at the lower threshold + emit one audit row.
  if (
    counter.drops >= CROSS_TENANT_DROP_SUSPEND_THRESHOLD &&
    !counter.suspended &&
    deviceId
  ) {
    counter.suspended = true;
    console.warn(
      `[AgentWs] auto-suspending agent token: agent=${agentId} device=${deviceId} ` +
      `kind=${kind} drops=${counter.drops} window_ms=${now - counter.firstAt}`
    );
    // Fire-and-forget — the DB write must not block the message loop. The
    // suspension is reconciled at the next auth gate, so a delayed write
    // simply means one or two extra probes get through before the token
    // becomes invalid.
    void suspendAgentToken(deviceId, AGENT_TOKEN_SUSPEND_REASON.crossTenantProbe);
    void createAuditLogAsync({
      orgId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'agent.token.suspended',
      resourceType: 'device',
      resourceId: deviceId,
      details: {
        reason: 'cross-tenant-probe',
        kind,
        dropsInWindow: counter.drops,
        agentId,
      },
      result: 'denied',
      initiatedBy: 'automation',
    });
    try {
      captureException(
        new Error(
          `agent_ws auto-suspend (agent=${agentId}, device=${deviceId}, kind=${kind}, drops=${counter.drops})`
        )
      );
    } catch {
      // Sentry capture is best-effort.
    }

    // Close any active WS for this agent so it has to re-auth (and fail).
    const activeWs = activeConnections.get(agentId);
    if (activeWs) {
      try {
        activeWs.close(4001, 'Token suspended');
      } catch {
        // Connection may already be torn down.
      }
      activeConnections.delete(agentId);
    }
  }

  if (counter.drops >= CROSS_TENANT_DROP_WARN_THRESHOLD && !counter.warned) {
    counter.warned = true;
    console.warn(
      `[AgentWs] cross-tenant probe pattern: agent=${agentId} device=${deviceId ?? 'unknown'} ` +
      `kind=${kind} drops=${counter.drops} window_ms=${now - counter.firstAt}`
    );
    try {
      captureException(new Error(`agent_ws cross-tenant drop pattern (agent=${agentId}, kind=${kind})`));
    } catch {
      // Sentry breadcrumb is best-effort; never let it surface.
    }
  }
}

function clearCrossTenantDropCounter(agentId: string) {
  crossTenantDrops.delete(agentId);
}

// Test-only: reset the entire cross-tenant counter map so tests don't bleed
// state across `it()` cases. Not exported for production use.
export function __resetCrossTenantDropsForTest() {
  crossTenantDrops.clear();
}

/**
 * Create the agent WebSocket routes
 * The upgradeWebSocket function must be passed from the main app
 */
export function createAgentWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  // WebSocket route for agent connections
  // GET /api/v1/agent-ws/:id/ws with Authorization: Bearer <agent-token>
  app.get(
    '/:id/ws',
    // Rate limiting middleware (M-D2: Redis-backed sliding window)
    async (c, next) => {
      const agentId = c.req.param('id');
      const { allowed, degraded } = await checkAgentWsRateLimitDistributed(agentId);
      if (!allowed) {
        return c.json({ error: 'Too many connection attempts' }, 429);
      }
      if (degraded) {
        // Best-effort breadcrumb so we can detect Redis blips affecting agent fleets.
        c.set('agentWsRateLimitDegraded' as never, true as never);
      }
      return next();
    },
    // Authentication middleware — validates BEFORE WebSocket upgrade
    async (c, next) => {
      const agentId = c.req.param('id');
      const authHeader = c.req.header('Authorization');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      // H4: Removed `?token=` query-param fallback. Agent token in URL leaks
      // into LB/CDN/proxy access logs and browser history. Bearer header is
      // mandatory; the Go agent (agent/internal/websocket/client.go) sends it.
      if (!token) {
        // One-time deprecation warning so we can detect any field stragglers.
        warnAgentMissingBearer(agentId);
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const result = await validateAgentToken(agentId, token);
      if (!result.ok) {
        if (result.reason === 're_enrollment_required') {
          return c.json({ error: 'Re-enrollment required', code: 're_enrollment_required' }, 401);
        }
        return c.json({ error: 'Unauthorized' }, 401);
      }

      // Store validated device context for the upgrade handler to access
      c.set('agentDb', result.ctx);
      return next();
    },
    upgradeWebSocket((c: { req: { param: (key: string) => string }; get: (key: string) => unknown }) => {
      const agentId = c.req.param('id');
      const agentCtx = c.get('agentDb') as AgentDbContext;
      return createAgentWsHandlers(agentId, agentCtx);
    })
  );

  return app;
}

/**
 * Send a command to a connected agent via WebSocket
 * Returns true if the command was sent, false if agent is not connected
 */
export function sendCommandToAgent(agentId: string, command: AgentCommand): boolean {
  const ws = activeConnections.get(agentId);
  if (!ws) {
    return false;
  }

  try {
    const json = JSON.stringify(command);
    // Send command directly - agent expects {id, type, payload} at top level
    ws.send(json);
    recordOrphanedResultExpectation(agentId, command);
    return true;
  } catch (error) {
    console.error(`Failed to send command to agent ${agentId.slice(0,12)}:`, error);
    activeConnections.delete(agentId);
    return false;
  }
}

export type AgentWsDisconnectResult = 'closed' | 'close-failed' | 'not-connected';

/**
 * Force-close an agent's active WS connection so it reconnects with a fresh
 * handshake (and re-resolves its orgId/siteId via agentAuth). Use this after
 * any server-side change that invalidates the orgId baked into the live
 * connection — e.g. a cross-org move where every per-message
 * runWithAgentDbAccess call would otherwise keep using the stale orgId for
 * RLS (see preValidatedAgent closure capture in createAgentWsHandlers), or a
 * decommission that must sever the live command channel (#2230).
 *
 * Callers that record the outcome (audit trails) must not collapse
 * 'close-failed' into success: a throwing close() plausibly leaves the
 * channel live, which is exactly what e.g. a decommission needs to know.
 *
 * Finding #4: `activeConnections` holds at most ONE socket per agent (onOpen
 * closes any prior socket before replacing it), so closing
 * `activeConnections.get(agentId)` is authoritative — revocation can never miss
 * a live-but-orphaned socket.
 */
export function disconnectAgent(agentId: string, code: number = 4040, reason: string = 'orgId changed, reconnect required'): AgentWsDisconnectResult {
  const ws = activeConnections.get(agentId);
  if (!ws) return 'not-connected';
  try {
    ws.close(code, reason);
  } catch (error) {
    console.error(`disconnectAgent(${agentId.slice(0,12)}) close threw:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    return 'close-failed';
  }
  // Don't delete from map here — the WS onClose handler does that itself
  // (lines ~1905-1907) and we don't want to race with reconnect logic.
  return 'closed';
}

/**
 * Check if an agent is connected via WebSocket
 */
export function isAgentConnected(agentId: string): boolean {
  return activeConnections.has(agentId);
}

/**
 * Get all connected agent IDs
 */
export function getConnectedAgentIds(): string[] {
  return Array.from(activeConnections.keys());
}

/**
 * Get the count of connected agents
 */
export function getConnectedAgentCount(): number {
  return activeConnections.size;
}

/**
 * Broadcast a message to all connected agents
 */
export function broadcastToAgents(
  message: Record<string, unknown>,
  filter?: (agentId: string) => boolean
): number {
  let sent = 0;
  const payload = JSON.stringify(message);

  for (const [agentId, ws] of activeConnections) {
    if (filter && !filter(agentId)) {
      continue;
    }

    try {
      ws.send(payload);
      sent++;
    } catch (error) {
      console.error(`Failed to broadcast to agent ${agentId}:`, error);
      activeConnections.delete(agentId);
    }
  }

  return sent;
}
