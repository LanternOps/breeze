import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { devices, deviceCommands, discoveryJobs, scriptExecutions, scriptExecutionBatches, remoteSessions, backupJobs, restoreJobs, tunnelSessions } from '../db/schema';
import { handleTerminalOutput, getActiveTerminalSession, unregisterTerminalOutputCallback } from './terminalWs';
import { handleDesktopFrame, isDesktopSessionOwnedByAgent } from './desktopWs';
import { handleTunnelDataFromAgent, isTunnelOwnedByAgent, registerTunnelOwnership } from './tunnelWs';
import { enqueueDiscoveryResults, type DiscoveredHostResult } from '../jobs/discoveryWorker';
import { enqueueBackupResults } from '../jobs/backupWorker';
import { enqueueSnmpPollResults, type SnmpMetricResult } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult, recordMonitorCheckResult, type MonitorCheckResult } from '../jobs/monitorWorker';
import { isRedisAvailable } from '../services/redis';
import { isIP } from 'node:net';
import { processDeviceIPHistoryUpdate } from '../services/deviceIpHistory';
import { processBackupVerificationResult } from './backup/verificationService';
import { applyBackupCommandResultToJob } from '../services/backupResultPersistence';
import { applyVaultSyncCommandResult } from '../services/vaultSyncPersistence';
import { backupCommandResultSchema } from './backup/resultSchemas';
import { claimPendingCommandsForDevice } from '../services/commandDispatch';
import { matchRoleScopedAgentTokenHash, type AgentCredentialRole } from '../middleware/agentAuth';
import { detectResultValidationFamily, validateCriticalCommandResult, DR_COMMAND_TYPES } from '../services/agentCommandResultValidation';
import { updateRestoreJobByCommandId, updateRestoreJobFromResult } from '../services/restoreResultPersistence';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import { revokeViewerSession } from '../services/viewerTokenRevocation';

declare module 'hono' {
  interface ContextVariableMap {
    agentDb: AgentDbContext;
  }
}

const VALID_MONITOR_STATUSES = new Set(['online', 'offline', 'degraded']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
          stdout: stdout ?? null,
          stderr: result.stderr ?? null,
          errorMessage: result.error ?? null,
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

// Store active WebSocket connections by agentId
// Map<agentId, WSContext>
const activeConnections = new Map<string, WSContext>();

// Track per-agent ping/pong state for stale connection detection
interface AgentPingState {
  pingInterval: ReturnType<typeof setInterval>;
  lastPongAt: number;
}
const agentPingStates = new Map<string, AgentPingState>();
const AGENT_PING_INTERVAL_MS = 30_000;
const AGENT_PONG_TIMEOUT_MS = 10_000;
const ORPHANED_RESULT_EXPECTATION_TTL_MS = 30 * 60 * 1000;
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

function buildStoredCommandResult(result: AgentCommandResult, stdout: string | undefined) {
  return {
    status: result.status,
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    error: result.error,
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
  data: z.string()
});

const agentMessageSchema = z.discriminatedUnion('type', [
  commandResultSchema,
  heartbeatMessageSchema,
  terminalOutputSchema
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

/**
 * Validate agent token by hashing it and comparing against the stored hash.
 * Returns `re_enrollment_required` when the device row exists but predates the
 * token-hash migration so the agent can prompt the operator instead of looping.
 */
async function validateAgentToken(agentId: string, token: string): Promise<AgentTokenValidation> {
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
        status: devices.status
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

  return {
    ok: true,
    ctx: {
      deviceId: device.id,
      orgId: device.orgId,
      role: match.role,
    },
  };
}

/**
 * Update device status when WebSocket connects/disconnects
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
      .where(eq(devices.agentId, agentId));
  } catch (error) {
    console.error(`Failed to update device status for ${agentId}:`, error);
  }
}

/**
 * Handle command results for commands dispatched directly via WebSocket
 * (without a deviceCommands DB record). This covers discovery scans
 * and SNMP polls which use their own job tracking tables.
 */
async function processOrphanedCommandResult(
  agentId: string,
  authenticatedDeviceId: string,
  result: z.infer<typeof commandResultSchema>
): Promise<void> {
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
      const { normalizedResult, stdout, validationError } = normalizeCriticalResultIfNeeded('vault_sync', result);
      if (validationError) {
        console.warn(`[AgentWs] ${validationError} for orphaned auto-sync ${result.commandId}`);
        // Update vault state to reflect the validation failure so it's visible to operators
        await applyVaultSyncCommandResult({
          deviceId: authenticatedDeviceId,
          resultStatus: 'failed',
          error: validationError,
        });
        return;
      }
      await applyVaultSyncCommandResult({
        deviceId: authenticatedDeviceId,
        resultStatus: normalizedResult.status,
        stdout,
        stderr: normalizedResult.stderr,
        error: normalizedResult.error,
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
    console.log(`[AgentWs] Processing backup result for job ${backupJob.id} from agent ${agentId}`);
    try {
      const parsedBackup = backupCommandResultSchema.safeParse(result.result ?? {});
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
            status: result.status ?? 'failed',
            snapshotId: backupData?.snapshotId,
            filesBackedUp: backupData?.filesBackedUp,
            bytesBackedUp: backupData?.bytesBackedUp,
            warning: backupData?.warning,
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
  deviceId?: string
): Promise<void> {
  try {
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
            result: buildStoredCommandResult(normalizedResult, stdout)
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

    if (validationError) {
      console.warn(`[AgentWs] ${validationError} — command ${result.commandId} rejected for agent ${agentId}`);
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
 * Get pending commands for an agent
 */
async function getPendingCommands(agentId: string): Promise<AgentCommand[]> {
  try {
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return [];
    }

    const commands = await claimPendingCommandsForDevice(device.id, 10);

    return commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: (cmd.payload as Record<string, unknown>) || {}
    }));
  } catch (error) {
    console.error(`Failed to get pending commands for ${agentId}:`, error);
    return [];
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
        accessiblePartnerIds: []
      },
      fn
    );
  };

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      // Clean up any existing ping state from a previous connection
      const existingPingState = agentPingStates.get(agentId);
      if (existingPingState) {
        clearInterval(existingPingState.pingInterval);
        agentPingStates.delete(agentId);
      }

      // Store connection
      activeConnections.set(agentId, ws);
      console.log(`Agent ${agentId} connected via WebSocket. Active connections: ${activeConnections.size}`);

      // Update device status and load pending commands under tenant DB context.
      const pendingCommands = await runWithAgentDbAccess(async () => {
        await updateDeviceStatus(agentId, 'online');
        return getPendingCommands(agentId);
      });

      // Publish device.online event for real-time UI updates
      if (agentDb) {
        try {
          const [deviceInfo] = await runWithAgentDbAccess(async () =>
            db.select({ id: devices.id, hostname: devices.hostname, agentVersion: devices.agentVersion })
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
            }, 'agent-ws').catch(err => {
              console.error('[AgentWs] Failed to publish device.online:', err);
              captureException(err);
            });
          }
        } catch (err) {
          console.error('[AgentWs] Failed to query device for online event:', err);
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
      }

      // Send welcome message with any pending commands
      ws.send(JSON.stringify({
        type: 'connected',
        agentId,
        timestamp: Date.now(),
        pendingCommands
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
      agentPingStates.set(agentId, { pingInterval, lastPongAt: now });
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
            console.warn(`[AgentWs] Dropping malformed terminal_output from agent ${agentId}: ${parsed.error.errors[0]?.message}`);
            return;
          }
          const { sessionId, data: termData } = parsed.data;
          const termSession = getActiveTerminalSession(sessionId);
          if (!termSession || termSession.agentId !== agentId) {
            console.warn(`[AgentWs] Dropping terminal_output for unowned session ${sessionId} from agent ${agentId}`);
            recordCrossTenantDrop(agentId, authenticatedAgent?.deviceId, 'terminal_output');
            return;
          }
          handleTerminalOutput(sessionId, termData);
          return;
        }

        // Handle update_status messages: agent is about to self-update
        if (message.type === 'update_status' && typeof message.targetVersion === 'string') {
          if (agentDb) {
            await runWithAgentDbAccess(async () => {
              try {
                await db
                  .update(devices)
                  .set({
                    status: 'updating',
                    lastSeenAt: new Date(),
                    updatedAt: new Date()
                  })
                  .where(eq(devices.agentId, agentId));
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
              `${fastPathParse.error.errors[0]?.message ?? 'invalid shape'}`
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
                    console.log(`[AgentWs] Session ${sessionId} marked disconnected (peer dropped)`);
                  }
                });
              } catch (err) {
                console.error(`[AgentWs] Failed to update session disconnect:`, err);
              }
            }
          }

          // Store WebRTC answer from start_desktop command results
          if (fastCommandId.startsWith('desk-start-') &&
              fastStatus === 'completed' &&
              fastResult) {
            const expectedSessionId = extractDesktopSessionId(fastCommandId, 'desk-start-');
            const resultSessionId = typeof fastResult.sessionId === 'string' && fastResult.sessionId.length <= MAX_DESKTOP_SESSION_ID_BYTES
              ? fastResult.sessionId
              : null;
            const sessionId =
              expectedSessionId && (!resultSessionId || resultSessionId === expectedSessionId)
                ? expectedSessionId
                : null;
            const answer = typeof fastResult.answer === 'string' ? fastResult.answer : null;
            if (sessionId && answer && answer.length < 65536) {
              try {
                await runWithAgentDbAccess(async () => {
                  const result = await db
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
                    .returning({ id: remoteSessions.id });

                  if (result.length > 0) {
                    console.log(`[AgentWs] Stored WebRTC answer for session ${sessionId}`);
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
            const errorMsg = typeof failResult.error === 'string'
              ? failResult.error.slice(0, 1024)
              : fastError
                ? fastError.slice(0, 1024)
                : 'Desktop capture failed on agent';
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
          console.warn(`Invalid message from agent ${agentId}:`, parsed.error.errors);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Invalid message format',
            details: parsed.error.errors
          }));
          return;
        }

        switch (parsed.data.type) {
          case 'command_result':
            await runWithAgentDbAccess(async () =>
              processCommandResult(agentId, parsed.data as z.infer<typeof commandResultSchema>, authenticatedAgent.deviceId)
            );
            ws.send(JSON.stringify({
              type: 'ack',
              commandId: parsed.data.commandId
            }));
            break;

          case 'heartbeat':
            {
              const heartbeatMessage = parsed.data as z.infer<typeof heartbeatMessageSchema>;

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

              // Check for pending commands and send them
              const pendingCommands = await runWithAgentDbAccess(async () => getPendingCommands(agentId));
              ws.send(JSON.stringify({
                type: 'heartbeat_ack',
                timestamp: Date.now(),
                commands: pendingCommands
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
      // Clean up ping interval
      const pingState = agentPingStates.get(agentId);
      if (pingState) {
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
                .select({ id: devices.id, status: devices.status, hostname: devices.hostname })
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
              }, 'agent-ws').catch(err => {
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
      // Clean up ping interval
      const pingState = agentPingStates.get(agentId);
      if (pingState) {
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
    event: z.enum(['answer', 'ice_candidate', 'peer_disconnected', 'session_started']).optional(),
    sessionId: z.string().min(SESSION_ID_MIN).max(SESSION_ID_MAX).optional(),
    answer: z.string().max(65536).optional(),
    error: z.string().max(8192).optional(),
    candidate: z.unknown().optional(),
  }).strict().optional(),
}).passthrough();

// M-D1: Cross-tenant probe detection. Increments per agentId on each
// schema-passing-but-ownership-failing fast-path drop. After N drops in M
// minutes we emit ONE warn + Sentry breadcrumb. Diagnostic only — never
// auto-bans (legitimate session-rebalance races would false-positive).
const CROSS_TENANT_DROP_THRESHOLD = 10;
const CROSS_TENANT_DROP_WINDOW_MS = 5 * 60 * 1000;
type ProbeCounter = { drops: number; firstAt: number; warned: boolean };
const crossTenantDrops = new Map<string, ProbeCounter>();

function recordCrossTenantDrop(agentId: string, deviceId: string | undefined, kind: string) {
  const now = Date.now();
  let counter = crossTenantDrops.get(agentId);
  if (!counter || now - counter.firstAt > CROSS_TENANT_DROP_WINDOW_MS) {
    counter = { drops: 0, firstAt: now, warned: false };
    crossTenantDrops.set(agentId, counter);
  }
  counter.drops += 1;
  if (counter.drops >= CROSS_TENANT_DROP_THRESHOLD && !counter.warned) {
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
