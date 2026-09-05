import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type Redis from 'ioredis';
import { z } from 'zod';
import { eq, and, notInArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'crypto';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { dbWriteExpectingRows } from '../db/dbWriteExpectingRows';
import { commandCasPriorStatusTags } from '../services/commandCasDiagnostics';
import { devices, deviceCommands, discoveryJobs, scriptExecutions, scriptExecutionBatches, remoteSessions, backupJobs, restoreJobs, tunnelSessions, supportSessions, organizations } from '../db/schema';
import {
  handleTerminalOutput,
  getActiveTerminalSession,
  failTerminalStartForExactCommand,
} from './terminalWs';
import { handleDesktopFrame, isDesktopSessionOwnedByAgent } from './desktopWs';
import { handleTunnelDataFromAgent, isTunnelOwnedByAgent, registerTunnelOwnership } from './tunnelWs';
import { enqueueDiscoveryResults, type DiscoveredHostResult, type DeviceAdjacency } from '../jobs/discoveryWorker';
import { enqueueBackupResults } from '../jobs/backupWorker';
import { enqueueSnmpPollResults, type SnmpMetricResult } from '../jobs/snmpWorker';
import { enqueueMonitorCheckResult, recordMonitorCheckResult, type MonitorCheckResult } from '../jobs/monitorWorker';
import { getRedis, isRedisAvailable } from '../services/redis';
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
  isBackupQueuedAck,
  isLegacyBackupTimeoutResult,
  tryParseBackupResultPayload,
} from '../services/backupProgress';
import { backupCommandResultSchema } from './backup/resultSchemas';
import { describeZodIssues } from '../lib/zodIssues';
import { matchRoleScopedAgentTokenHash, suspendAgentToken, type AgentCredentialRole } from '../middleware/agentAuth';
import { AGENT_TOKEN_SUSPEND_REASON } from '../services/agentTokenSuspension';
import {
  enforceAgentCertificateBinding,
  readAgentCertificateAssertion,
  type AgentCertificateAssertion,
} from '../services/agentCertificateBinding';
import { getAgentTenantState } from '../services/tenantStatus';
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
import {
  applySoftwareInstallResult,
  SW_INSTALL_COMMAND_ID_REGEX,
} from '../services/softwareDeploymentResult';
import { PG_UUID_REGEX, UUID_REGEX } from '../utils/uuid';
import {
  commandResultSchema as baseCommandResultSchema,
  commandResultResultByteLength,
  MAX_COMMAND_RESULT_BYTES,
} from './agents/schemas';
import { commandResultHandlers, normalizeDiscoveryHosts } from '../services/commandResultHandlers';

import { terminalPayloadErasureSet } from '../services/sensitiveCommandPayload';
import { applyCommandAutomationTerminal } from '../services/automationTerminalEvidence';
import { commandAcceptsAgentResultCondition } from '../services/commandResultAcceptance';
import { redactResultAgainstCommandSecrets } from '../services/commandSecretRedaction';
import { INSTANCE_ID } from '../services/instanceIdentity';
import { clearAgentPresence, clearAgentPresenceUnfenced, setAgentPresence, refreshAgentPresence } from '../services/agentPresence';
import { breezeRole } from '../config/env';
import { partnerTrustMode } from '../config/partnerTrustMode';
import type { PartnerTrustState } from '../db/schema/orgs';
import {
  evaluateCapability,
  isLifecycleCommand,
  loadTrustState,
  partnerIdForDevice,
} from '../services/partnerTrust';
/** Capabilities advertised to agents in the post-connect `connected` message. */
export const AGENT_WS_CAPABILITIES = ['terminal_output_base64', 'backup_run_async', 'backup_queue_async'] as const;

declare module 'hono' {
  interface ContextVariableMap {
    agentDb: AgentDbContext;
  }
}

const VALID_MONITOR_STATUSES = new Set(['online', 'offline', 'degraded']);
const PROVIDER_BACKED_BACKUP_COMMAND_TYPES = new Set(['hyperv_backup', 'mssql_backup']);
const MAX_DESKTOP_SESSION_ID_BYTES = 128;
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
// #3097: the command-result handlers and their registry now live in
// `services/commandResultHandlers.ts` so the HTTP transport can dispatch the
// same code. See that module for the handler bodies.

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

interface ActiveAgentConnection {
  ws: WSContext;
  partnerId: string | null;
  trustState: PartnerTrustState;
}

// Store active WebSocket connections and their connect-time trust snapshot by agentId.
const activeConnections = new Map<string, ActiveAgentConnection>();

const PARTNER_TRUST_CHANGED_CHANNEL = 'partner-trust:changed';
let partnerTrustSubscriber: Redis | null = null;
let partnerTrustSubscriptionPromise: Promise<void> | null = null;

export async function handleTrustChanged(msg: unknown): Promise<void> {
  let parsed: unknown = msg;
  if (typeof msg === 'string') {
    try {
      parsed = JSON.parse(msg);
    } catch {
      return;
    }
  }
  if (!parsed || typeof parsed !== 'object') return;

  const { partnerId, trustState } = parsed as {
    partnerId?: unknown;
    trustState?: unknown;
  };
  if (
    typeof partnerId !== 'string'
    || !['probation', 'trusted', 'restricted'].includes(String(trustState))
  ) {
    return;
  }

  for (const connection of activeConnections.values()) {
    if (connection.partnerId === partnerId) {
      connection.trustState = trustState as PartnerTrustState;
    }
  }
}

function initializePartnerTrustSubscription(): Promise<void> {
  if (partnerTrustSubscriptionPromise) return partnerTrustSubscriptionPromise;
  const redis = getRedis();
  if (!redis || typeof redis.duplicate !== 'function') return Promise.resolve();

  const subscriber = redis.duplicate({ connectionName: 'breeze:agent-ws:partner-trust' });
  partnerTrustSubscriber = subscriber;
  subscriber.on('message', (channel: string, message: string) => {
    if (channel === PARTNER_TRUST_CHANGED_CHANNEL) {
      void handleTrustChanged(message);
    }
  });
  subscriber.on('error', (error: Error) => {
    console.error('[AgentWs] Partner-trust Redis subscriber error:', error.message);
  });
  partnerTrustSubscriptionPromise = subscriber.subscribe(PARTNER_TRUST_CHANGED_CHANNEL)
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error('[AgentWs] Failed to subscribe to partner-trust changes:', error);
      partnerTrustSubscriber = null;
      partnerTrustSubscriptionPromise = null;
    });
  return partnerTrustSubscriptionPromise;
}

// Delivery epoch, monotonic per agent. Bumped every time a socket is installed
// in `activeConnections`, so every command is dispatched on a known epoch.
//
// A superseded socket stays readable for as long as its close frame takes to
// land, and its onMessage closure keeps its original authorization. Without an
// epoch, a result (including a desktop/terminal stop result) submitted on that
// dying socket is indistinguishable from one submitted on the live connection —
// which is exactly how a stale generation gets to speak for the current one.
// Result-bearing frames therefore require proof that they arrived on the same
// epoch the command was delivered on: the socket must still be the mapped one.
const agentSocketEpochs = new Map<string, number>();
let lastAgentSocketEpoch = 0;

function installAgentSocketEpoch(agentId: string): number {
  lastAgentSocketEpoch += 1;
  agentSocketEpochs.set(agentId, lastAgentSocketEpoch);
  return lastAgentSocketEpoch;
}

/**
 * Exact delivery-epoch proof for a frame received on `ws`. Both halves matter:
 * the epoch rules out a socket that was replaced and re-replaced, and the map
 * identity rules out a socket that was never installed at all.
 */
function ownsCurrentAgentSocket(agentId: string, ws: WSContext, epoch: number): boolean {
  return agentSocketEpochs.get(agentId) === epoch && activeConnections.get(agentId)?.ws === ws;
}

/**
 * Drop an agent's connection outright. Both maps move together: leaving an
 * epoch behind is harmless for correctness (the proof ANDs epoch equality with
 * map identity, so it stays closed) but the map would never shrink for an agent
 * that never reconnects.
 */
function evictAgentSocket(agentId: string): void {
  activeConnections.delete(agentId);
  agentSocketEpochs.delete(agentId);
  void clearAgentPresenceUnfenced(agentId);
}

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
// #3097: one definition of the agent command-result payload for BOTH transports.
//
// The shared base lives in `routes/agents/schemas.ts`; the websocket envelope is
// that base plus the two fields only a socket needs — `type` (discriminator) and
// `commandId` (no URL path to read it from). REST consumes the base directly and
// takes its id from the path.
//
// This also retires a real divergence: the copy that used to live here measured
// the 1 MB `result` cap with `.length` (UTF-16 code units), so this path accepted
// roughly 3x the intended budget for CJK-heavy output while REST rejected at
// 1 MB. The base's cap is a `.refine()` on the `result` FIELD rather than on the
// object, which is what makes `.extend()` possible here — a `.refine()` on the
// object would return a `ZodEffects` with no `.extend()`, and we would be back to
// duplicating the very thing this removes.
const commandResultSchema = baseCommandResultSchema.extend({
  type: z.literal('command_result'),
  commandId: z.string(),
});

type AgentCommandResult = z.infer<typeof commandResultSchema>;

/**
 * MAX_PRECISE_RESULT_MEASURE_BYTES bounds when the rejection path is willing to
 * re-serialise a `result` body to report its exact size.
 *
 * `commandResultResultByteLength` runs a synchronous `JSON.stringify` over a
 * just-parsed object, and this branch is reached by definition on messages that
 * failed validation — including unbounded ones. No `maxPayload` is configured
 * on the agent WebSocket server, so `ws` allows frames up to its 100 MiB
 * default, and pre-fix agents still in the field send genuinely unbounded
 * results (#3001's original report was a 64 MB payload). Stringifying that on
 * the event loop to produce a log field is a self-inflicted stall, and this
 * repo has form for exactly that (#3236).
 *
 * Above the threshold the frame size is reported instead — a lower bound that
 * is already enough to diagnose an oversize rejection, and free to compute.
 */
export const MAX_PRECISE_RESULT_MEASURE_BYTES = 8_000_000;

/**
 * MAX_ECHOED_FIELD_CHARS clamps the agent-supplied strings echoed back in a
 * rejection. They come off an UNVALIDATED message — that is the whole point of
 * this branch — so their length is whatever the agent chose to send.
 */
export const MAX_ECHOED_FIELD_CHARS = 200;

/** MAX_ECHOED_ISSUES clamps how many Zod issues ride back in the reply. */
export const MAX_ECHOED_ISSUES = 10;

/**
 * buildAgentMessageRejection assembles the log line and the error frame for a
 * message that failed schema validation.
 *
 * #3001: this branch used to be a bare `console.warn` carrying only the raw Zod
 * issues. When it rejected a `command_result` — the terminal status of a job
 * the server is actively waiting on — the operator saw no commandId, no size
 * and no message type, and none of the downstream backup logs, which live in
 * `processCommandResult` past this early return. The result read as having
 * vanished in transit, and a backup that had succeeded was reaped as stalled 15
 * minutes later.
 *
 * A rejected `command_result` is a LOST TERMINAL STATUS, so it logs at error
 * with everything needed to identify the job; anything else stays a warning.
 *
 * Pure and exported so the frame shape can be pinned by a test: the agent side
 * parses `messageType`/`commandId` off this object (see `logServerErrorFrame`
 * in agent/internal/websocket/client.go), and a rename on either side silently
 * returns the agent to the no-trace state this issue was about.
 */
export function buildAgentMessageRejection(args: {
  agentId: string;
  message: unknown;
  frameBytes: number;
  issues: z.ZodIssue[];
}): {
  level: 'error' | 'warn';
  log: string;
  frame: {
    type: 'error';
    code: 'INVALID_MESSAGE';
    message: string;
    messageType: string;
    commandId?: string;
    details: z.ZodIssue[];
  };
} {
  const { agentId, message, frameBytes, issues } = args;
  // `message` is unvalidated and need not even be an object (a bare JSON number
  // or null both reach here), so every read is guarded.
  const raw = (message ?? {}) as Record<string, unknown>;
  const clamp = (v: unknown): string | undefined =>
    typeof v === 'string' ? v.slice(0, MAX_ECHOED_FIELD_CHARS) : undefined;

  const messageType = clamp(raw.type) ?? 'unknown';
  const commandId = clamp(raw.commandId);
  const details = issues.slice(0, MAX_ECHOED_ISSUES);
  const frame = {
    type: 'error' as const,
    code: 'INVALID_MESSAGE' as const,
    message: 'Invalid message format',
    // Echoed so the agent can attribute the rejection to the command it sent.
    // Without these the agent sees an unattributable error frame and has
    // nothing to log against the job.
    messageType,
    ...(commandId !== undefined ? { commandId } : {}),
    details,
  };

  if (messageType !== 'command_result') {
    return {
      level: 'warn',
      log: `Invalid message from agent ${agentId} (type=${messageType}, frameBytes=${frameBytes}):`,
      frame,
    };
  }

  let resultBytes: string;
  if (frameBytes >= MAX_PRECISE_RESULT_MEASURE_BYTES) {
    resultBytes = `unmeasured(frame ${frameBytes}B exceeds the ${MAX_PRECISE_RESULT_MEASURE_BYTES}B measure threshold)`;
  } else {
    const measured = commandResultResultByteLength(raw.result);
    resultBytes = measured === null ? 'unencodable' : String(measured);
  }

  return {
    level: 'error',
    log:
      `[AgentWs] REJECTED command_result from agent ${agentId} — the job will have no ` +
      `terminal status and will be failed by a reaper. commandId=${commandId ?? 'unknown'} ` +
      `frameBytes=${frameBytes} resultBytes=${resultBytes} ` +
      `resultLimitBytes=${MAX_COMMAND_RESULT_BYTES}:`,
    frame,
  };
}

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
  /**
   * #4673 W02 — the MSP that owns this device's org, from the auth select's
   * join to `organizations` (NOT NULL, so always present after a successful
   * token validation). Feeds `currentPartnerId` on every org context this
   * socket opens, so Wave 1's SELECT-only partner-wide branches can match.
   *
   * Read-only axis. It must never be spread into `accessiblePartnerIds`,
   * which is the write-capable partner-AXIS predicate.
   */
  partnerId: string;
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

// Default: no certificate assertion presented / no trusted source. Safe for
// the (only) production caller below, which always supplies a real one built
// from the pre-upgrade request; also lets existing direct callers of
// validateAgentToken(agentId, token) — e.g. this file's unit tests — omit the
// parameter without affecting behavior (the binding check only ever runs
// when AGENT_MTLS_BINDING_MODE is not `off`; it fails closed on a genuinely
// missing assertion in that case, same as any other caller).
const NO_CERTIFICATE_ASSERTION: AgentCertificateAssertion = {
  assertionTrusted: false,
  assertedVerified: false,
  assertedSerial: null,
};

/**
 * Validate agent token by hashing it and comparing against the stored hash.
 * Returns `re_enrollment_required` when the device row exists but predates the
 * token-hash migration so the agent can prompt the operator instead of looping.
 *
 * Security remediation Wave 5, Task 6: after every other check passes, also
 * runs the shared certificate/device binding decision
 * (services/agentCertificateBinding.ts) — the SAME pure check
 * agentAuthMiddleware calls for REST — so the WS upgrade and REST agent auth
 * agree on the same reason for the same inputs. `device.id` here is the
 * ALREADY bearer-token-matched device row, never client input, so a stolen
 * token cannot bind against a different device's certificate identity.
 */
export async function validateAgentToken(
  agentId: string,
  token: string,
  certAssertion: AgentCertificateAssertion = NO_CERTIFICATE_ASSERTION,
): Promise<AgentTokenValidation> {
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
        pendingTokenHash: devices.pendingTokenHash,
        pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
        pendingTokenExpiresAt: devices.pendingTokenExpiresAt,
        status: devices.status,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
        // #4673 W02 — owning MSP, for `currentPartnerId` on this socket's org
        // contexts. INNER join: org_id and partner_id are both NOT NULL behind
        // an FK, so a device with no org row is not authenticable anyway, and a
        // LEFT join would silently degrade it to the pre-W02 blind behaviour.
        partnerId: organizations.partnerId,
      })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
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
    // Issue #2621 — an agent that persisted a staged rotation and restarted
    // before confirming reconnects with the staged token. The WS path must
    // accept it, or the control channel dies in exactly the crash window the
    // two-phase design exists to make survivable.
    pendingTokenHash: device.pendingTokenHash,
    pendingWatchdogTokenHash: device.pendingWatchdogTokenHash,
    pendingTokenExpiresAt: device.pendingTokenExpiresAt,
    tokenHash,
  });
  if (!match || match.role !== 'agent') {
    return { ok: false, reason: 'unauthorized' };
  }

  // Tenant-status gate (mirror of the REST agent-auth path): refuse the WS
  // upgrade for a suspended/churned/soft-deleted org or partner before we
  // accept the persistent control channel.
  //
  // #2774 — 'draining' (offboarding) is refused here too, even though the
  // REST drain surface stays open: ~20 call sites (terminal, desktop, tunnel,
  // software installs, workers) push commands over this socket WITHOUT a
  // device_commands row, so any WS session is a fully-capable control channel
  // that the drain-mode command filtering can't see. The agent falls back to
  // heartbeat polling, which is the actual self_uninstall delivery path.
  if ((await getAgentTenantState(device.orgId)) !== 'active') {
    return { ok: false, reason: 'unauthorized' };
  }

  // Security remediation Wave 5, Task 6 — shared certificate/device binding
  // decision. Runs after every other auth/lifecycle/tenant check and BEFORE
  // the WS upgrade is accepted. In the default `off` mode this never touches
  // the DB (no extra round trip for the common case).
  const bindingDecision = await enforceAgentCertificateBinding({
    deviceId: device.id,
    assertion: certAssertion,
    pathClass: 'ws',
  });
  if (!bindingDecision.allowed) {
    return { ok: false, reason: 'unauthorized' };
  }

  return {
    ok: true,
    ctx: {
      deviceId: device.id,
      orgId: device.orgId,
      partnerId: device.partnerId,
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
        // Exit the held org-scoped transaction context for the Redis
        // round-trips (#1105) — see the note on the monitor-result branch.
        await runOutsideDbContext(() =>
          enqueueSnmpPollResults(snmpData.deviceId!, snmpData.metrics!, result.commandId)
        );
      } else {
        console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${snmpData.deviceId}`);
        const { snmpDevices } = await import('../db/schema');
        await db
          .update(snmpDevices)
          .set({
            lastPolled: new Date(),
            // See the sibling branch above: the device replied, so the failure
            // backoff must not accumulate on a Redis outage (#3217).
            lastPollAttemptedAt: new Date(),
            consecutiveFailures: 0,
            lastStatus: 'warning'
          })
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
      const monitorId = monitorData.monitorId;
      const checkResult = {
        monitorId,
        checkId: result.commandId,
        status: normalizeMonitorStatus(monitorData.status),
        responseMs: monitorData.responseMs ?? 0,
        statusCode: monitorData.statusCode,
        error: monitorData.error,
        details: monitorData as Record<string, unknown>
      };
      if (isRedisAvailable()) {
        // Orphaned results run inside a SHORT org-scoped transaction
        // (agentWs.commandResult.orphaned, #3021). runOutsideDbContext exits
        // the ALS context so instrumented-queue tripwires pass and any nested
        // DB work routes to the pool — it does NOT release the outer
        // transaction's connection, which stays held for the (normally short)
        // Redis round-trips; the full fix is dispatching enqueues after the
        // context closes (#1105).
        await runOutsideDbContext(() =>
          enqueueMonitorCheckResult(monitorId, checkResult, {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:monitor-result',
          })
        );
      } else {
        console.warn(`[AgentWs] Redis unavailable, recording monitor result directly for ${monitorId}`);
        await recordMonitorCheckResult(monitorId, checkResult);
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process monitor check result for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }

  // Software install results dispatched over WS carry their tracking IDs in
  // the commandId itself: `sw-install-<deploymentUuid>-<deviceUuid>-<attempt>`.
  // The agent normally POSTs these to the HTTP result route
  // (routes/agents/commands.ts), but if that goroutine fails the result can
  // still arrive here — without this branch the deployment_results row
  // strands as 'pending' forever. The helper's status='pending' +
  // retryCount=attempt guard makes double delivery (HTTP + WS) AND a stale
  // result from a retry-superseded attempt a no-op. The attempt suffix is
  // optional (legacy in-flight ids default to 0).
  const swInstallMatch = result.commandId.match(SW_INSTALL_COMMAND_ID_REGEX);
  if (swInstallMatch) {
    const [, swDeploymentId, swDeviceId, swAttempt] = swInstallMatch;
    // Bind to the socket's authenticated device identity, like the other
    // branches: a compromised agent must not write another device's row.
    if (!swDeploymentId || !swDeviceId || swDeviceId !== authenticatedDeviceId) {
      console.warn(
        `[AgentWs] Rejecting software-install result ${result.commandId} from agent ${agentId}: ` +
        `authenticatedDevice=${authenticatedDeviceId}`
      );
      return;
    }
    try {
      await applySoftwareInstallResult({
        deploymentId: swDeploymentId,
        deviceId: authenticatedDeviceId,
        status: result.status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        attemptNumber: swAttempt ? parseInt(swAttempt, 10) : 0,
      });
    } catch (err) {
      console.error(`[AgentWs] Failed to apply software-install result ${result.commandId}:`, err);
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
        const normalizedHosts = normalizeDiscoveryHosts(discoveryData.hosts);
        // Exit the held org-scoped transaction context for the Redis
        // round-trips (#1105) — see the note on the monitor-result branch.
        await runOutsideDbContext(() => enqueueDiscoveryResults(
          discoveryJob.id,
          discoveryJob.orgId,
          discoveryJob.siteId,
          normalizedHosts,
          discoveryData.hostsScanned ?? 0,
          discoveryData.hostsDiscovered ?? 0,
          undefined,
          discoveryData.adjacency ?? [],
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:discovery-result',
          }
        ));
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
    if (isBackupStartedAck(startedAckPayload) || isBackupQueuedAck(startedAckPayload)) {
      // applyBackupStartedAck's guarded update no-ops (returns false) when the
      // job is already terminal — only log the "started-ack" line when it
      // actually applied, so an incident timeline isn't misled by a started-ack
      // that landed after the job had already completed/failed/been reaped.
      const startedAckApplied = await applyBackupStartedAck({ jobId: backupJob.id, deviceId: backupJob.deviceId, queued: isBackupQueuedAck(startedAckPayload) });
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
        : `Malformed backup result payload: ${describeZodIssues(parsedBackup.error)}`;

      if (isRedisAvailable()) {
        // Exit the held org-scoped transaction context for the Redis
        // round-trips (#1105) — see the note on the monitor-result branch.
        await runOutsideDbContext(() => enqueueBackupResults(
          backupJob.id,
          backupJob.orgId,
          backupJob.deviceId,
          {
            // A malformed stdout must not ride an agent-reported 'completed'
            // through to a completed job with no snapshot (mirrors the inline
            // path below). Without this, a truncated/invalid system_image
            // result completes green and the parse error is discarded.
            status: result.status === 'completed' && parsedBackup.success ? 'completed' : 'failed',
            // The agent's own terminal status, carried alongside (not instead
            // of) the outer one — `partial` cannot be expressed by the outer
            // completed/failed pair (#3000).
            agentStatus: backupData?.status,
            snapshotId: backupData?.snapshotId,
            filesBackedUp: backupData?.filesBackedUp,
            bytesBackedUp: backupData?.bytesBackedUp,
            warning: backupData?.warning,
            errorCount: backupData?.errorCount,
            referencedFiles: backupData?.referencedFiles,
            referencedBytes: backupData?.referencedBytes,
            backupType: backupData?.backupType,
            systemStateManifest: backupData?.systemStateManifest,
            vssMetadata: backupData?.vssMetadata,
            snapshot: backupData?.snapshot,
            error: malformedPayloadError || result.error || result.stderr,
          },
          {
            actorType: 'agent',
            actorId: agentId,
            source: 'route:agentWs:backup-result',
          }
        ));
      } else {
        console.warn(`[AgentWs] Redis unavailable, marking backup job ${backupJob.id} with inline result`);
        const persisted = await applyBackupCommandResultToJob({
          jobId: backupJob.id,
          orgId: backupJob.orgId,
          deviceId: backupJob.deviceId,
          resultStatus: result.status === 'completed' && parsedBackup.success ? 'completed' : 'failed',
          agentStatus: backupData?.status,
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
 * Open a SHORT org-scoped DB access context for one agent-message DB
 * operation. Module-level twin of the per-connection `runWithAgentDbAccess`
 * closure in createAgentWsHandlers (which delegates here) so module-level
 * paths like processCommandResult can scope individual operations instead of
 * running under a message-long wrap.
 *
 * #3021: be deliberate about context-opening helpers nested under this wrap —
 * there are two DISTINCT failure modes:
 *
 * - a BARE nested `withSystemDbAccessContext` opens nothing:
 *   withDbAccessContext early-returns when a context is already active
 *   (db/index.ts), so the "system" work silently runs inside THIS org
 *   transaction under org RLS (one connection, wrong-scope hazard).
 * - the `runOutsideDbContext(() => withSystemDbAccessContext(...))` form
 *   genuinely opens a second context, but runOutsideDbContext does NOT
 *   release this context's pooled connection — two connections held at
 *   once, the #1105 class (#2765 is the HTTP twin).
 *
 * The direct callees under the #3021 command-result wraps use neither form.
 * Indirect residues remain (e.g. publishEvent subscribers open system
 * contexts after exiting the ALS, and some desktop-path callees use the
 * outside+system form) — those still double-hold briefly, a known #1105
 * follow-up, now bounded by short per-operation wraps instead of a
 * message-long one.
 */
async function runWithAgentOrgDbAccess<T>(
  label: string,
  orgId: string,
  partnerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      // Partner-AXIS access gates `breeze_has_partner_access`, which admits
      // WRITES to partner-owned rows. Agents get none of it — this stays empty.
      accessiblePartnerIds: [],
      // #4673 W02 — the device org's owning MSP. Feeds the
      // `breeze.current_partner_id` GUC that Wave 1's SELECT-ONLY branches read
      // (`org_id IS NULL AND partner_id = breeze_current_partner_id()`), so an
      // agent socket can see its own MSP's partner-wide config directly.
      // A separate, read-only axis from `accessiblePartnerIds` above.
      currentPartnerId: partnerId,
      label
    },
    fn
  );
}

/**
 * Process command result from agent.
 *
 * #3021: deliberately NOT wrapped in a message-level org context by the
 * `command_result` case (the WS twin of #2765). The primary device_commands
 * lookup deliberately runs contextless on the bare pool (no RLS on that
 * table); the fallback lookup, lifecycle recheck, terminal CAS, and audit
 * write each manage their own short-lived context; and the per-type handler
 * dispatch and orphaned branches get their own short org-scoped wraps — so
 * no step on this path directly acquires a second pooled connection while
 * another context's connection is held open (#1105).
 *
 * Trade-off (deliberate): the terminal CAS commits independently, so a
 * failure AFTER it (e.g. a handler wrap failing to open under pool
 * exhaustion) reaches the function-level catch with the command row already
 * terminal and the ack still sent — the agent won't redeliver, and the
 * downstream org-table transition is left to the stale-timeout sweeps. The
 * catch logs + Sentry-captures, so this is loud, not silent.
 */
async function processCommandResult(
  agentId: string,
  result: z.infer<typeof commandResultSchema>,
  deviceId: string | undefined,
  orgId: string,
  // #4673 W02 — threaded in (rather than re-looked-up) so every short-lived
  // org context this function opens carries the same `currentPartnerId` the
  // socket authenticated with. Without it these contexts would be the one
  // remaining agent path where partner-wide rows stay invisible.
  partnerId: string
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
    // Short org wrap (#3021): the orphaned branches read/write RLS-guarded
    // org tables (discovery jobs, snmp devices, backup/restore jobs) through
    // the ambient db, so they need the tenant context the removed
    // message-level wrap used to provide.
    if (!UUID_REGEX.test(result.commandId)) {
      await runWithAgentOrgDbAccess('agentWs.commandResult.orphaned', orgId, partnerId, () =>
        processOrphanedCommandResult(agentId, deviceId ?? '', result)
      );
      return;
    }

    // Look up command by ID + deviceId directly (device_commands has no RLS).
    // Previous approach JOINed through devices table which has RLS and could
    // fail when the DB context didn't grant access to the org's devices.
    let command: typeof deviceCommands.$inferSelect | undefined;
    let resolvedDeviceId: string | undefined = deviceId;

    if (resolvedDeviceId) {
      // Query device_commands OUTSIDE any ambient transaction context.
      // device_commands has no RLS. Since #3021 removed the message-level org
      // wrap there normally IS no ambient context here, but runOutsideDbContext
      // is kept as defense: if a future caller reintroduces one, escaping it
      // preserves fresh-snapshot visibility of rows the dispatcher committed
      // after that transaction began.
      //
      // The READ deliberately stays on the bare pool while the write below
      // takes an explicit system context. Only insert/update/delete are
      // instrumented by the contextless-write guard
      // (CONTEXTLESS_WRITE_GUARD_METHODS, db/index.ts), and a bare-pool read of
      // an RLS-free table returns exactly the rows a system-context read would
      // — so wrapping it would buy no #1375 coverage while costing a full
      // BEGIN + set_config×6 + COMMIT round-trip per command result on the
      // hottest agent path, against a connection pool we are actively trying to
      // relieve (#1105). Contrast isAgentDeviceStillAuthorized below, which
      // reads `devices` — that table DOES have RLS, so its read genuinely needs
      // the system context. If device_commands ever gains an RLS policy, this
      // read becomes a silent 0-row no-op and MUST move into
      // withSystemDbAccessContext — same caveat as services/commandDispatch.ts.
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
              commandAcceptsAgentResultCondition()
            )
          )
          .limit(1)
      );
      command = row;
    } else {
      // Fallback: resolve deviceId from agentId via devices table. `devices`
      // IS RLS-guarded, so with no ambient tenant context (#3021) this join
      // genuinely needs an explicit system context — a bare-pool read would
      // silently return 0 rows and misroute the result to the orphaned path.
      // System (not org) scope matches isAgentDeviceStillAuthorized: the
      // predicate binds devices.agentId to the socket's authenticated agent,
      // so tenancy is enforced by the key, not the context.
      const [ownedCommand] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
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
                commandAcceptsAgentResultCondition()
              )
            )
            .limit(1)
        )
      );
      command = ownedCommand?.command;
      resolvedDeviceId = ownedCommand?.deviceId;
    }

    if (!command || !resolvedDeviceId) {
      // Discovery and SNMP commands are dispatched directly via WebSocket
      // without creating a deviceCommands record. Handle them here (short org
      // wrap for the same reason as the non-UUID branch above, #3021).
      await runWithAgentOrgDbAccess('agentWs.commandResult.orphaned', orgId, partnerId, () =>
        processOrphanedCommandResult(agentId, deviceId ?? '', result)
      );
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
      normalizedResult: rawNormalizedResult,
      stdout: rawStdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, result);

    // #3409 PR4a — exact-value redaction against the secrets THIS command
    // carried, before either the device_commands.result write below or (via
    // the per-type handler dispatch further down) script_executions. The
    // name-based heuristic pass at the top of this function stays: it catches
    // secrets this command never carried, which the exact pass cannot see.
    // Live since PR4c-2: scriptDispatch sets `secretEnv` for `tenantSecret`
    // parameters, so script commands can carry a sealed envelope.
    const { result: normalizedResult, stdout } = redactResultAgainstCommandSecrets(
      { id: command.id, type: command.type, deviceId: resolvedDeviceId, payload: command.payload },
      rawNormalizedResult,
      rawStdout,
    );

    // Update outside transaction for same visibility reasons as the lookup, and
    // under an explicit system context so the compare-and-set is not a
    // contextless bare-pool write (#1375). device_commands is intentionally
    // system-scoped (no RLS), so this changes nothing about what the write can
    // touch — it just makes the guard's invariant ("device_commands writes run
    // under an explicit system context", db/index.ts) actually true here.
    //
    // dbWriteExpectingRows (#1379 A2): the SELECT above matched this exact
    // predicate and returned a row, so a 0-row result here means another writer
    // drove the command terminal in the intervening window. Several BENIGN
    // writers can, not just the REST twin:
    //   - routes/agents/commands.ts (the REST twin) or a second socket — a
    //     duplicate result: terminal with a real agent result;
    //   - jobs/staleCommandReaper.ts — fleet-wide and on a schedule; an agent
    //     replying just past the timeout boundary is exactly this race, and is
    //     probably the most common non-REST cause;
    //   - the cancellation paths (admin/abuse.ts, software.ts, scripts.ts,
    //     cisHardening.ts, discovery.ts, backup/restore.ts, maintenance.ts,
    //     playbookRetention.ts, backup/verificationScheduled.ts).
    // Every other cause — a contextless/denied write, a future RLS policy on
    // device_commands, a misrouted connection — is a defect that would
    // otherwise vanish into the console.warn below. The prior_status tag
    // (resolved ONLY on the 0-row branch, so the happy path pays nothing) is
    // what tells those apart in Sentry. Non-throwing, so the stale-result
    // early-return keeps its existing behaviour.
    const terminalCompletedAt = new Date();
    const updatedCommands = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        dbWriteExpectingRows(
          'device_commands.ws_result_terminal_cas',
          () =>
            db
              .update(deviceCommands)
              .set({
                  status: normalizedResult.status === 'completed' ? 'completed' : 'failed',
                  completedAt: terminalCompletedAt,
                  result: buildStoredCommandResult(command.type, normalizedResult, stdout),
                  ...terminalPayloadErasureSet(),
              })
              .where(
                and(
                  eq(deviceCommands.id, result.commandId),
                  eq(deviceCommands.deviceId, resolvedDeviceId!),
                  eq(deviceCommands.targetRole, 'agent'),
                  // #3607: re-evaluated here, not just at the lookup. A row
                  // terminalized by a server-side timeout is still acceptable,
                  // but the first late result rewrites `result.status` away
                  // from 'timeout', so a duplicate frame still finds 0 rows.
                  commandAcceptsAgentResultCondition()
                )
              )
              .returning({ id: deviceCommands.id }),
          () => commandCasPriorStatusTags(result.commandId)
        )
      )
    );

    if (updatedCommands.length === 0) {
      console.warn(`[AgentWs] Ignoring stale or already-processed command result ${result.commandId} for agent ${agentId}`);
      return;
    }

    await applyCommandAutomationTerminal({
      commandId: result.commandId,
      result: normalizedResult,
      output: stdout ?? null,
      error: normalizedResult.error ?? normalizedResult.stderr ?? null,
      completedAt: terminalCompletedAt,
    });

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
            // Short org wrap (#3021): handlers touch RLS-guarded org tables
            // through the ambient db (same as the happy-path dispatch below).
            await runWithAgentOrgDbAccess('agentWs.commandResult.handler', orgId, partnerId, () =>
              rejectedHandler({ agentId, command, commandId: result.commandId, result: normalizedResult, resolvedDeviceId: resolvedDeviceId!, stdout })
            );
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
        // Short org wrap (#3021): DR result persistence reads/writes
        // RLS-guarded org tables through the ambient db.
        await runWithAgentOrgDbAccess('agentWs.commandResult.drResult', orgId, partnerId, () =>
          handleDrCommandResult({
            commandId: result.commandId,
            commandType: command.type,
            deviceId: resolvedDeviceId!,
            status: normalizedResult.status,
            result: normalizedResult.result,
            payload: commandPayload,
          })
        );
      } catch (err) {
        console.error(`[AgentWs] Failed to persist DR result state for ${result.commandId}:`, err);
        captureException(err);
      }

      try {
        const { enqueueDrExecutionReconcile } = await import('../jobs/drExecutionWorker');
        const drExecutionId = commandPayload.drExecutionId as string;
        // No ambient context here since #3021; runOutsideDbContext kept so the
        // instrumented-queue tripwire stays satisfied if one is reintroduced.
        await runOutsideDbContext(() => enqueueDrExecutionReconcile(drExecutionId));
      } catch (err) {
        console.error(`[AgentWs] Failed to enqueue DR reconciliation for ${result.commandId}:`, err);
        captureException(err);
      }
    }

    // Dispatch to per-command-type handler if one is registered.
    // Short org wrap (#3021): handlers read/write RLS-guarded org tables
    // (script_executions, discovery_jobs, backup/restore jobs, …) through the
    // ambient db, so they need the tenant context — but ONLY they do, which is
    // why the wrap sits here instead of around the whole message.
    const handler = commandResultHandlers[command.type];
    if (handler) {
      await runWithAgentOrgDbAccess('agentWs.commandResult.handler', orgId, partnerId, () =>
        handler({ agentId, command, commandId: result.commandId, result: normalizedResult, resolvedDeviceId: resolvedDeviceId!, stdout })
      );
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

  /**
   * `label` is REQUIRED, and deliberately so. Every context on this socket
   * funnels through this one closure, so in a minified production build all of
   * them collapse to an anonymous arrow inside `onMessage` — the #1105
   * held-connection warning could not name which agent message was responsible.
   * That is how BREEZE-A became ~7k events that could not be triaged. A
   * required parameter means a handler added later cannot silently rejoin that
   * pile: it will not compile without a label.
   *
   * Keep labels stable and low-cardinality (a handler name, never an id or
   * sessionId) — they become a Sentry tag and part of the grouping message.
   */
  const runWithAgentDbAccess = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    return runWithAgentOrgDbAccess(label, agentDb.orgId, agentDb.partnerId, fn);
  };

  // The delivery epoch this handler set owns, stamped when its socket is
  // installed. Zero until then, which never matches a live epoch.
  let socketEpoch = 0;

  // Fencing token for this connection's presence lease (wave 3.5b, #4084).
  // Generated once per handler set so a superseded socket's delayed
  // onClose/onError can never delete a newer connection's lease — the
  // server-side Lua compare-and-delete only acts when the token matches.
  const connectionToken = randomUUID();

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      const trustMode = partnerTrustMode();
      if (trustMode !== 'off') {
        await initializePartnerTrustSubscription();
      }
      // Finding #4: enforce the one-socket-per-agent invariant. A second socket
      // for the same agentId would otherwise overwrite the map entry WITHOUT
      // closing the previous socket, leaving an orphaned-but-authorized socket
      // whose onMessage handler + captured authorization keep working while
      // revocation/disconnect (which only act on the mapped socket) miss it.
      // Close the previous socket before replacing it so `activeConnections`
      // stays authoritative and disconnectAgent can never miss a live socket.
      const previousWs = activeConnections.get(agentId)?.ws;
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

      // Trust mode off preserves the pre-gate connection path without trust DB reads.
      // Shadow/enforce keep the socket open but fail closed in the cached snapshot
      // whenever partner or trust resolution is missing or unavailable.
      let partnerId: string | null = null;
      let trustState: PartnerTrustState = 'trusted';
      if (trustMode !== 'off') {
        try {
          partnerId = await partnerIdForDevice(agentDb.deviceId);
          const trust = partnerId ? await loadTrustState(partnerId) : null;
          if (!trust) {
            trustState = 'restricted';
            console.warn(`[AgentWs] Partner trust unresolved for device ${agentDb.deviceId}; restricting connection`);
          } else {
            trustState = trust.trustState;
          }
        } catch {
          trustState = 'restricted';
          console.warn(`[AgentWs] Partner trust resolution failed for device ${agentDb.deviceId}; restricting connection`);
        }
      }

      // Store connection and stamp this socket's delivery epoch.
      activeConnections.set(agentId, {
        ws,
        partnerId,
        trustState,
      });
      socketEpoch = installAgentSocketEpoch(agentId);
      void setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken });
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
      await runWithAgentDbAccess('agentWs.onOpen.markOnline', async () => {
        await updateDeviceStatus(agentId, 'online');
      });

      // Publish device.online event for real-time UI updates
      if (agentDb) {
        try {
          const [deviceInfo] = await runWithAgentDbAccess('agentWs.onOpen.loadDevice', async () =>
            db.select({ id: devices.id, siteId: devices.siteId, hostname: devices.hostname, agentVersion: devices.agentVersion, isEphemeral: devices.isEphemeral })
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

          // Quick Support: this socket coming up is the only signal that the
          // ephemeral agent actually installed and reached us, so it is what
          // moves the claimed session to 'ready' for the tech waiting on it.
          //
          // The isEphemeral guard is load-bearing for throughput, not just
          // tidiness: onOpen runs on EVERY agent reconnect across a 10k-device
          // fleet, and a normal device must pay zero extra queries here. The
          // flag is already on the row we just loaded, so the guard costs
          // nothing. The agent's context org IS the hidden Quick Support org
          // that owns the support_sessions row, so org RLS passes.
          if (deviceInfo?.isEphemeral) {
            // Own try/catch: sharing the enclosing one would file this under
            // "failed to query device for online event" and misdirect whoever
            // debugs a session stuck at 'claimed'. Failure is not fatal — the
            // reaper expires claimed-limbo sessions after 20 minutes — so log
            // and let the connection proceed.
            try {
              await runWithAgentDbAccess('agentWs.onOpen.supportSessionReady', async () =>
                db.update(supportSessions)
                  .set({ status: 'ready' })
                  .where(and(
                    eq(supportSessions.deviceId, deviceInfo.id),
                    eq(supportSessions.status, 'claimed'),
                  ))
              );
            } catch (err) {
              console.error('[AgentWs] Failed to mark quick support session ready:', err);
              captureException(err instanceof Error ? err : new Error(String(err)));
            }
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
            void refreshAgentPresence(agentId, connectionToken).then((refreshed) => {
              // Self-heal: an evict-path unconditional delete may have raced a
              // reconnect; if we are still the live socket, re-establish the lease.
              if (!refreshed && activeConnections.get(agentId)?.ws === ws) {
                return setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken });
              }
            });
          }
          return;
        }

        // Agent heartbeats also prove the connection is alive
        if (message.type === 'heartbeat') {
          const state = agentPingStates.get(agentId);
          if (state) {
            state.lastPongAt = Date.now();
            void refreshAgentPresence(agentId, connectionToken).then((refreshed) => {
              if (!refreshed && activeConnections.get(agentId)?.ws === ws) {
                return setAgentPresence(agentId, { instanceId: INSTANCE_ID, connectionToken });
              }
            });
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
          if (!ownsCurrentAgentSocket(agentId, ws, socketEpoch)) {
            console.warn(`[AgentWs] Dropping terminal_output from superseded socket for agent ${agentId}`);
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
            await runWithAgentDbAccess('agentWs.updateStatus', async () => {
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
          // Exact delivery-epoch proof: a stop/start result carries authority
          // to tear down a live session, so a superseded socket may not submit
          // one. (Applies to desk-stop results too — those finalize a desktop.)
          if (!ownsCurrentAgentSocket(agentId, ws, socketEpoch)) {
            console.warn(
              `[AgentWs] Dropping ${message.commandId.slice(0, 12)} result from superseded socket for agent ${agentId}`
            );
            return;
          }
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
            // The start command id embeds the terminal connection generation
            // that issued it, so the failure is resolved against that exact
            // lease rather than against whatever currently holds the session
            // id. A late failure from a superseded generation therefore cannot
            // close, notify, or unregister the generation that owns the
            // session now — the previous identifier-only lookup did exactly
            // that whenever a user reconnected while a start was in flight.
            const errorDetail = fastError ?? 'Unknown error';
            const outcome = await failTerminalStartForExactCommand(
              fastCommandId,
              agentId,
              errorDetail,
            );
            if (outcome === 'delivered') {
              console.warn(`[AgentWs] Terminal start failed for command ${fastCommandId}: ${errorDetail}`);
            } else if (outcome === 'foreign_agent') {
              // A live start claimed by an agent that never received it.
              recordCrossTenantDrop(agentId, authenticatedAgent?.deviceId, 'term_failed');
            } else {
              // Benign: a superseded generation, or a start issued before this
              // instance restarted. Ignored, but NOT counted as a probe — doing
              // so would let a rolling deploy auto-suspend healthy agents.
              console.warn(`[AgentWs] Ignoring terminal start failure for unknown command ${fastCommandId}`);
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
                await runWithAgentDbAccess('agentWs.desktop.peerDisconnected', async () => {
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
                await runWithAgentDbAccess('agentWs.desktop.consentDenied', async () => {
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
                await runWithAgentDbAccess('agentWs.desktop.webrtcAnswer', async () => {
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
                await runWithAgentDbAccess('agentWs.desktop.captureFailed', async () => {
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
          const rejection = buildAgentMessageRejection({
            agentId,
            message,
            frameBytes: Buffer.byteLength(data, 'utf8'),
            issues: parsed.error.issues,
          });
          if (rejection.level === 'error') {
            console.error(rejection.log, rejection.frame.details);
          } else {
            console.warn(rejection.log, rejection.frame.details);
          }
          ws.send(JSON.stringify(rejection.frame));
          return;
        }

        switch (parsed.data.type) {
          case 'command_result':
            // Exact delivery-epoch proof. Desktop finalization stop results
            // arrive here, not on the `desk-` fast path — their command id IS
            // the finalization UUID — so this is the path that actually carries
            // authority to finalize a session. A superseded socket submitting
            // one would let a dying connection speak for the agent.
            if (!ownsCurrentAgentSocket(agentId, ws, socketEpoch)) {
              console.warn(
                `[AgentWs] Dropping command_result ${parsed.data.commandId} from superseded socket for agent ${agentId}`
              );
              return;
            }
            // #3021: NO message-level org wrap here (the WS twin of #2765).
            // processCommandResult manages its own short-lived contexts — the
            // old request-long wrap held one pooled connection idle-in-
            // transaction while the nested system contexts inside acquired a
            // second, doubling pool pressure per command result (#1105).
            await processCommandResult(
              agentId,
              parsed.data as z.infer<typeof commandResultSchema>,
              authenticatedAgent.deviceId,
              authenticatedAgent.orgId,
              authenticatedAgent.partnerId
            );
            ws.send(JSON.stringify({
              type: 'ack',
              commandId: parsed.data.commandId
            }));
            break;

          case 'backup_progress': {
            const progressMessage = parsed.data as z.infer<typeof backupProgressMessageSchema>;
            await runWithAgentDbAccess('agentWs.backupProgress', async () => {
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
                // device's job) and stays at warn. invalid-payload joins it:
                // since #3006 it means an agent is sending progress this server
                // cannot understand, which starves last_progress_at and gets
                // healthy uploads reaped. Everything else is routine traffic —
                // restore progress reuses this WS type with a commandId that
                // matches no backup job (not-found), a garbage or non-UUID
                // commandId is dropped pre-DB (invalid-command-id), and
                // terminal-status is a benign completion race — so those drop
                // quietly at debug.
                const dropLog =
                  applied.reason === 'agent-mismatch' || applied.reason === 'invalid-payload'
                    ? console.warn
                    : console.debug;
                dropLog(
                  `[AgentWs] Dropping backup_progress for ${progressMessage.commandId} from agent ${agentId}: reason=${applied.reason}`
                );
              } else if (applied.snapshotIdDropped) {
                // #3006 mid-run snapshot registration is inert for this agent:
                // if its terminal result is lost, the uploaded objects will be
                // stranded exactly as before the fix. A snapshot-id format that
                // outgrew the column would do this fleet-wide, so it must be
                // louder than a debug line nobody greps.
                console.warn(
                  `[AgentWs] backup_progress for ${progressMessage.commandId} from agent ${agentId} carried an ` +
                    `unusable snapshotId — mid-run snapshot registration is not working for this agent version.`
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
              await runWithAgentDbAccess('agentWs.heartbeat', async () => {
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
      if (activeConnections.get(agentId)?.ws === ws) {
        activeConnections.delete(agentId);
        if (agentSocketEpochs.get(agentId) === socketEpoch) {
          agentSocketEpochs.delete(agentId);
        }
        void clearAgentPresence(agentId, connectionToken);
        console.log(`Agent ${agentId} disconnected. Active connections: ${activeConnections.size}`);

        // Update device status to offline (but preserve 'updating' — let
        // the offline detector handle the timeout for stale updating devices)
        if (agentDb) {
          await runWithAgentDbAccess('agentWs.onClose.markOffline', async () => {
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
if (activeConnections.get(agentId)?.ws === ws) {
        activeConnections.delete(agentId);
        if (agentSocketEpochs.get(agentId) === socketEpoch) {
          agentSocketEpochs.delete(agentId);
        }
        void clearAgentPresence(agentId, connectionToken);
      }
      if (agentDb) {
        void runWithAgentDbAccess('agentWs.onError.markOffline', async () => {
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

export const terminalCommandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string().regex(/^term-[a-zA-Z0-9_-]+$/).max(128),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().max(8192).optional(),
  exitCode: z.number().int().optional(),
  // #3167: this object is `.strict()`, and it used to list only
  // event/sessionId/exitCode — none of which is the shape the agent actually
  // sends. `agent/internal/remote/tools/terminal.go` returns
  // {sessionId, cols, rows, started} for start, {sessionId, written} for write,
  // {sessionId, cols, rows, resized} for resize and {sessionId, stopped} for
  // stop, so EVERY successful terminal command_result failed validation and was
  // dropped as malformed, and the ack below was never sent.
  //
  // The `event` enum here has never had a consumer: the only reads of
  // `fastResult.event` are the desktop path's `peer_disconnected` /
  // `consent_denied`, which come from desktopCommandResultSchema. It is kept
  // (optional, harmless) rather than removed, since removing it would reject any
  // agent build that does start sending it — the same failure this fixes.
  //
  // Kept `.strict()` deliberately. Switching to passthrough would also stop the
  // drops, but this is an unauthenticated-shape fast path on the agent socket and
  // bounding what can be pushed through it is worth keeping; the fix is to
  // describe reality, not to stop checking.
  //
  // cols/rows are bounded generously rather than mirroring the agent's current
  // clamps (20-500 / 5-200). Pinning the server to the agent's exact constants
  // would mean a future agent widening them silently reintroduces this same
  // dropped-result bug.
  result: z.object({
    event: z.enum(['session_started', 'session_ended', 'session_error']).optional(),
    sessionId: z.string().min(SESSION_ID_MIN).max(SESSION_ID_MAX).optional(),
    exitCode: z.number().int().optional(),
    cols: z.number().int().nonnegative().max(10_000).optional(),
    rows: z.number().int().nonnegative().max(10_000).optional(),
    written: z.number().int().nonnegative().optional(),
    started: z.boolean().optional(),
    resized: z.boolean().optional(),
    stopped: z.boolean().optional(),
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
    const activeWs = activeConnections.get(agentId)?.ws;
    if (activeWs) {
      try {
        activeWs.close(4001, 'Token suspended');
      } catch {
        // Connection may already be torn down.
      }
      evictAgentSocket(agentId);
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

// Test-only: install a fake agent socket directly into `activeConnections`
// without going through the real WS upgrade/auth handshake. Needed by the
// wave 3.5b (#4084) relay integration suite, which needs a "locally connected"
// agent on ONE simulated process while dispatching from another. Never usable
// in production — a real socket must come through createAgentWsHandlers.
export function registerConnection(
  agentId: string,
  ws: { send(data: string): void },
  trust: { partnerId: string; trustState: PartnerTrustState } = {
    partnerId: 'test-partner',
    trustState: 'trusted',
  },
): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('registerConnection is test-only');
  }
  activeConnections.set(agentId, { ws: ws as never, ...trust });
  installAgentSocketEpoch(agentId);
}

export function __installAgentSocketForTest(agentId: string, ws: { send(data: string): void }): void {
  registerConnection(agentId, ws);
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

      // Security remediation Wave 5, Task 6 — read the certificate assertion
      // headers HERE, on the real pre-upgrade Hono context (the only place in
      // this flow with header access), and hand the parsed result to
      // validateAgentToken so the binding decision runs before the upgrade.
      const certAssertion = readAgentCertificateAssertion(c);
      const result = await validateAgentToken(agentId, token, certAssertion);
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
 * Wave 3.5b (#4084): a worker-role process never holds agent sockets — this
 * throws rather than letting a socket-local entry point silently return
 * false/empty, which would otherwise read as "every agent is offline" instead
 * of "this process cannot answer that question at all". Callers on a process
 * that may own sockets (`all`/`api`) must route through
 * dispatchCommandToAgent/isAgentConnectedAnywhere (services/agentCommandRelay.ts)
 * once BREEZE_ROLE=worker is actually in use (3.5d, #4086).
 */
function assertSocketLocalDispatchAllowed(fn: string): void {
  if (breezeRole() === 'worker') {
    throw new Error(
      `[BREEZE_ROLE] ${fn} is socket-local and cannot run in the worker role — `
      + 'use dispatchCommandToAgent/isAgentConnectedAnywhere (services/agentCommandRelay.ts)',
    );
  }
}

/**
 * Send a command to a connected agent via WebSocket
 * Returns true if the command was sent, false if agent is not connected
 */
export function sendCommandToAgent(agentId: string, command: AgentCommand): boolean {
  assertSocketLocalDispatchAllowed('sendCommandToAgent');
  const conn = activeConnections.get(agentId);
  if (!conn) {
    return false;
  }

  const mode = partnerTrustMode();
  if (mode !== 'off' && conn.trustState !== 'trusted' && !isLifecycleCommand(command.type)) {
    if (mode === 'enforce') return false;
    if (conn.partnerId) {
      void evaluateCapability('device_execute', {
        partnerId: conn.partnerId,
        commandType: command.type,
        detail: { via: 'ws_fast_path' },
      });
    }
  }

  try {
    const json = JSON.stringify(command);
    // Send command directly - agent expects {id, type, payload} at top level
    conn.ws.send(json);
    recordOrphanedResultExpectation(agentId, command);
    return true;
  } catch (error) {
    console.error(`Failed to send command to agent ${agentId.slice(0,12)}:`, error);
    evictAgentSocket(agentId);
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
  const conn = activeConnections.get(agentId);
  if (!conn) return 'not-connected';
  try {
    conn.ws.close(code, reason);
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
  assertSocketLocalDispatchAllowed('isAgentConnected');
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

  for (const [agentId, conn] of activeConnections) {
    if (filter && !filter(agentId)) {
      continue;
    }

    try {
      conn.ws.send(payload);
      sent++;
    } catch (error) {
      console.error(`Failed to broadcast to agent ${agentId}:`, error);
      evictAgentSocket(agentId);
    }
  }

  return sent;
}
