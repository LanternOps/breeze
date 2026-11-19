/**
 * Backup verification and VSS tools (full-control W17, #6788):
 *
 *  - `manage_backup_verification`: `health`, `list`, `readiness` are tier-1 reads;
 *    `run` is supervised (it queues a command on the machine). Twin of
 *    routes/backup/verification.ts, over the same exported services.
 *  - `get_vss_status`: tier 2 read-only (`TIER2_READONLY_TOOLS`). It runs
 *    VSS_WRITER_LIST on the machine and waits, so it is not tier 1, and it changes
 *    nothing, so a supervised card per lookup would be noise.
 *
 * Scope:
 *  - These services take any org they are handed and filter by org and site only, so
 *    the org and exact-device axes are decided HERE, before any service call. A
 *    foreign `orgId` is refused, and a device-bound run names one of its own
 *    devices (`list`, `readiness`) or is refused (`health`, which has no device
 *    axis at all). RLS also bounds the org under a tool call, because the services'
 *    nested system context keeps the ambient one. It knows nothing of the other axes.
 *  - No input maps to `refresh`: `GET /backup/health?refresh` calls
 *    `recalculateReadinessScores`, which writes, and these are tier-1 reads.
 *
 * Outputs are allow-listed. A verification row's `details` is agent-controlled
 * (restore paths, failed-file names, raw result internals) and never reaches the
 * model: only the list projection's `reason` and `simulated` are lifted out of it.
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { aiExecuteCommand, requireAiOrigin } from './aiDispatch';
import { CommandTypes } from './commandTypes';
import { sanitizeThrownToolError } from './aiToolErrors';
import { mfaGatedToolError } from './aiToolMfaGate';
import { BACKUP_VERIFICATION_ACTIONS, BACKUP_VERIFICATION_STATUSES, BACKUP_VERIFICATION_TYPES } from './aiToolSchemasBackupVerification';
import { WRITE_ORG_AMBIGUOUS_ERROR, resolveReadableToolOrgScope } from './aiToolWriteOrg';
import { SITE_SCOPE_EMPTY_NOTE, siteAllowlistOf } from './aiToolsSiteScope';
import { auditToolWrite } from './aiToolsSecurityPolicyShared';
import { bounded, clampLimit, clip, jsonError, notFound, thrown, verifiedUserIdOrNull } from './aiToolsSoftwareShared';
import { attachDeviceNames } from '../routes/backup/deviceNames';
import { toDateOrNull } from '../routes/backup/helpers';
import type { BackupVerification, RecoveryReadiness } from '../routes/backup/types';
import {
  classifyVerificationRunError,
  emptyHealthSummary,
  summarizeRecoveryReadiness,
  verificationHealthStatus,
} from '../routes/backup/verification';
import {
  getBackupHealthSummary,
  listBackupVerifications,
  listRecoveryReadiness,
  runBackupVerification,
  toVerificationListItem,
} from '../routes/backup/verificationService';

type Action = (typeof BACKUP_VERIFICATION_ACTIONS)[number];

const TOOL = 'manage_backup_verification';
const DEVICE_BOUND_NEEDS_DEVICE = 'A session bound to specific devices must name one of its devices (deviceId)';

/** The agent's raw reply, when it is not the writer list, is shown at most this long. */
const VSS_RAW_MAX_CHARS = 4096;
const VSS_WRITERS_SHOWN = 200;
const VSS_WRITER_NAME_MAX_CHARS = 256;
const VSS_LAST_ERROR_MAX_CHARS = 500;

/**
 * The shared device gate (org, site and exact-device axes, never a parked device), loaded lazily:
 * aiTools.ts imports this module, so a static value import would be a cycle.
 */
async function gatedDevice(...args: Parameters<typeof import('./aiTools').verifyDeviceAccess>) {
  const { verifyDeviceAccess } = await import('./aiTools');
  return verifyDeviceAccess(...args);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Exactly one org for these single-org services: the named one, else the caller's
 * only one. A partner with several must name it. Nothing is guessed.
 */
function resolveOneOrg(auth: AuthContext, inputOrgId: string | undefined): { orgId: string } | { error: string } {
  const scope = resolveReadableToolOrgScope(auth, inputOrgId);
  if (!scope.ok) return { error: jsonError(scope.error, inputOrgId ? 'ACCESS_DENIED' : 'VALIDATION_ERROR') };
  const [orgId, ...others] = scope.orgIds;
  if (!orgId || others.length > 0) return { error: jsonError(WRITE_ORG_AMBIGUOUS_ERROR, 'VALIDATION_ERROR') };
  return { orgId };
}

/** Org, site and exact-device axes through the shared gate; a named org must be the device's. One answer for every miss. */
async function resolveDeviceOrg(
  auth: AuthContext,
  deviceId: string,
  inputOrgId: string | undefined,
): Promise<{ orgId: string } | { error: string }> {
  const access = await gatedDevice(deviceId, auth);
  if ('error' in access) return { error: notFound('Device') };
  if (inputOrgId && access.device.orgId !== inputOrgId) return { error: notFound('Device') };
  return { orgId: access.device.orgId };
}

/** A named org is checked first, so a foreign one is refused whatever else the input says. */
function foreignOrgDenied(auth: AuthContext, inputOrgId: string | undefined): string | null {
  if (!inputOrgId) return null;
  const scope = resolveReadableToolOrgScope(auth, inputOrgId);
  return scope.ok ? null : jsonError(scope.error, 'ACCESS_DENIED');
}

function projectVerification(row: BackupVerification & { deviceName?: string | null }) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.deviceName ?? null,
    backupJobId: row.backupJobId,
    snapshotId: row.snapshotId ?? null,
    verificationType: row.verificationType,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    restoreTimeSeconds: row.restoreTimeSeconds ?? null,
    filesVerified: row.filesVerified,
    filesFailed: row.filesFailed,
    sizeBytes: row.sizeBytes ?? null,
    simulated: row.details?.simulated === true,
    reason: typeof row.details?.reason === 'string' ? row.details.reason : null,
    createdAt: row.createdAt,
  };
}

function projectReadiness(row: RecoveryReadiness & { deviceName?: string | null }) {
  return {
    deviceId: row.deviceId,
    deviceName: row.deviceName ?? null,
    readinessScore: row.readinessScore,
    estimatedRtoMinutes: row.estimatedRtoMinutes ?? null,
    estimatedRpoMinutes: row.estimatedRpoMinutes ?? null,
    riskFactors: row.riskFactors.map((factor) => ({ code: factor.code, severity: factor.severity, message: factor.message })),
    calculatedAt: row.calculatedAt,
  };
}

async function readHealth(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  // The summary has no device axis, so a device-bound run cannot be shown it.
  if (auth.allowedDeviceIds !== undefined) {
    return jsonError('Verification health covers the whole organization; a session bound to specific devices cannot read it', 'ACCESS_DENIED');
  }
  const org = resolveOneOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;
  const siteIds = siteAllowlistOf(auth);
  if (siteIds?.length === 0) return bounded({ status: 'unknown', ...emptyHealthSummary() });
  const summary = await getBackupHealthSummary(org.orgId, siteIds);
  return bounded({ status: verificationHealthStatus(summary), ...summary });
}

async function listVerifications(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const deviceId = str(input.deviceId);
  const denied = foreignOrgDenied(auth, str(input.orgId));
  if (denied) return denied;
  if (!deviceId && auth.allowedDeviceIds !== undefined) return jsonError(DEVICE_BOUND_NEEDS_DEVICE, 'ACCESS_DENIED');

  const fromInput = str(input.from);
  const toInput = str(input.to);
  const from = toDateOrNull(fromInput);
  const to = toDateOrNull(toInput);
  if ((fromInput && from === null) || (toInput && to === null)) {
    return jsonError('from and to must be ISO dates', 'VALIDATION_ERROR');
  }

  const org = deviceId ? await resolveDeviceOrg(auth, deviceId, str(input.orgId)) : resolveOneOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;
  const siteIds = siteAllowlistOf(auth);
  if (siteIds?.length === 0) return bounded({ count: 0, verifications: [], note: SITE_SCOPE_EMPTY_NOTE });

  const rows = await listBackupVerifications(org.orgId, {
    deviceId,
    backupJobId: str(input.backupJobId),
    verificationType: str(input.verificationType) as BackupVerification['verificationType'] | undefined,
    status: str(input.status) as BackupVerification['status'] | undefined,
    from,
    to,
    limit: clampLimit(input.limit, 25, 100),
    allowedSiteIds: siteIds,
  });
  const verifications = (await attachDeviceNames(org.orgId, rows)).map(projectVerification);
  return bounded({ count: verifications.length, verifications });
}

async function readReadiness(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const deviceId = str(input.deviceId);
  const denied = foreignOrgDenied(auth, str(input.orgId));
  if (denied) return denied;
  if (!deviceId && auth.allowedDeviceIds !== undefined) return jsonError(DEVICE_BOUND_NEEDS_DEVICE, 'ACCESS_DENIED');

  const org = deviceId ? await resolveDeviceOrg(auth, deviceId, str(input.orgId)) : resolveOneOrg(auth, str(input.orgId));
  if ('error' in org) return org.error;
  const siteIds = siteAllowlistOf(auth);
  if (siteIds?.length === 0) return bounded({ summary: summarizeRecoveryReadiness([]), devices: [], note: SITE_SCOPE_EMPTY_NOTE });

  const all = await listRecoveryReadiness(org.orgId, siteIds);
  const rows = deviceId ? all.filter((row) => row.deviceId === deviceId) : all;
  // Lowest first: the question this answers is "which could we least recover".
  const limit = clampLimit(input.limit, 25, 100);
  const shown = [...rows].sort((a, b) => a.readinessScore - b.readinessScore).slice(0, limit);
  const devices = (await attachDeviceNames(org.orgId, shown)).map(projectReadiness);
  return bounded({
    summary: summarizeRecoveryReadiness(rows),
    devices,
    ...(shown.length < rows.length ? { truncated: true } : {}),
  });
}

async function runVerification(auth: AuthContext, input: Record<string, unknown>): Promise<string> {
  const deviceId = str(input.deviceId);
  const denied = foreignOrgDenied(auth, str(input.orgId));
  if (denied) return denied;
  if (!deviceId) return jsonError('deviceId is required for run', 'VALIDATION_ERROR');

  const org = await resolveDeviceOrg(auth, deviceId, str(input.orgId));
  if ('error' in org) return org.error;

  let started: Awaited<ReturnType<typeof runBackupVerification>>;
  try {
    started = await runBackupVerification({
      orgId: org.orgId,
      deviceId,
      verificationType: (str(input.verificationType) ?? 'integrity') as BackupVerification['verificationType'],
      backupJobId: str(input.backupJobId),
      snapshotId: str(input.snapshotId),
      source: 'ai.verify',
      // An approved agent proposal releases under the agent's own auth, so its id is not a users row.
      requestedBy: await verifiedUserIdOrNull(auth),
      aiOrigin: requireAiOrigin(auth, TOOL),
    });
  } catch (error) {
    const classified = classifyVerificationRunError(error);
    if (classified.code === 'INTERNAL') {
      console.error(`[${TOOL}]`, sanitizeThrownToolError(TOOL, error));
      return jsonError('Operation failed. Check server logs for details.', 'INTERNAL');
    }
    return jsonError(classified.message, classified.code);
  }

  // The command is queued from here on. Nothing below may turn that into a failure the model would retry.
  const { verification, readiness } = started;
  try {
    auditToolWrite(auth, {
      orgId: org.orgId,
      action: 'backup.verification.run',
      resourceType: 'backup_verification',
      resourceId: verification.id,
      details: {
        deviceId: verification.deviceId,
        backupJobId: verification.backupJobId,
        snapshotId: verification.snapshotId,
        verificationType: verification.verificationType,
        status: verification.status,
      },
    });
  } catch (error) {
    console.error(`[${TOOL}] audit write failed after the command was queued`, sanitizeThrownToolError(TOOL, error));
  }
  return bounded({
    // The list projection's rules (reason only when failed or partial, normalized and capped) apply to a fresh row too.
    verification: projectVerification(toVerificationListItem(verification)),
    readiness: readiness ? projectReadiness(readiness) : null,
  });
}

function projectWriter(entry: unknown): { name: string | null; state: string | null; lastError: string | null } | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const writer = entry as Record<string, unknown>;
  return {
    name: clip(writer.name, VSS_WRITER_NAME_MAX_CHARS),
    state: clip(writer.state, 32),
    lastError: clip(writer.lastError, VSS_LAST_ERROR_MAX_CHARS),
  };
}

/**
 * `vss_writer_list` marshals the bare writer slice (agent/cmd/breeze-backup/
 * exec_backup.go, `execVSS`): an array, or `null` for a nil slice. `vss_status`
 * wraps it as `{ writers }`; both are accepted so the two cannot be confused.
 */
function parseWriters(stdout: string | undefined): { writers: unknown[] | null } | { raw: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || 'null');
  } catch {
    return { raw: clip(stdout, VSS_RAW_MAX_CHARS) };
  }
  if (parsed === null) return { writers: null };
  if (Array.isArray(parsed)) return { writers: parsed };
  const wrapped = (parsed as { writers?: unknown }).writers;
  if (Array.isArray(wrapped)) return { writers: wrapped };
  return { raw: clip(stdout, VSS_RAW_MAX_CHARS) };
}

export function registerBackupVerificationTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_backup_verification', {
    tier: 1,
    domain: 'backup',
    searchHint: 'backup verification history, integrity check, test restore, recovery readiness, who could we least recover',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_backup_verification',
      description:
        'Backup verification. Actions: health (org summary), list (past checks), readiness (recovery score per device, lowest first), run (deviceId; queues an integrity or test_restore check on the machine and needs approval).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...BACKUP_VERIFICATION_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (required when you can reach several and name no device)' },
          deviceId: { type: 'string', description: 'Device UUID (required for run; narrows list and readiness)' },
          backupJobId: { type: 'string', description: 'list: filter to a backup job. run: the job to verify' },
          snapshotId: { type: 'string', description: 'run: the snapshot to verify (test_restore needs one)' },
          verificationType: { type: 'string', enum: [...BACKUP_VERIFICATION_TYPES], description: 'run: the check (default integrity). list: filter' },
          status: { type: 'string', enum: [...BACKUP_VERIFICATION_STATUSES], description: 'list: status filter' },
          from: { type: 'string', description: 'list: started at or after this ISO date' },
          to: { type: 'string', description: 'list: started at or before this ISO date' },
          limit: { type: 'number', description: 'Max rows for list and readiness (default 25, max 100)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!BACKUP_VERIFICATION_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError(TOOL, action, auth);
      if (mfa) return mfa;
      try {
        if (action === 'health') return await readHealth(auth, input);
        if (action === 'list') return await listVerifications(auth, input);
        if (action === 'readiness') return await readReadiness(auth, input);
        return await runVerification(auth, input);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });

  aiTools.set('get_vss_status', {
    tier: 2,
    domain: 'backup',
    searchHint: 'VSS writers, volume shadow copy health on a Windows device, why a backup cannot quiesce',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_vss_status',
      description: 'Read the Volume Shadow Copy writers on one online Windows device, live from its agent: each writer\'s name, state and last error. Changes nothing on the machine.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Device UUID (online, Windows)' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const mfa = mfaGatedToolError('get_vss_status', undefined, auth);
      if (mfa) return mfa;
      const deviceId = str(input.deviceId);
      if (!deviceId) return jsonError('deviceId is required', 'VALIDATION_ERROR');
      try {
        const access = await gatedDevice(deviceId, auth, true);
        if ('error' in access) {
          return access.error.includes('not online') ? jsonError(access.error, 'DEVICE_OFFLINE') : notFound('Device');
        }
        const device = access.device;
        if (device.osType !== 'windows') {
          return jsonError(`VSS is a Windows feature; this device runs ${device.osType}.`, 'UNSUPPORTED_OS');
        }
        // aiExecuteCommand applies the AI remote-tools policy and stamps the AI origin; a denial comes back as a failed result.
        const result = await aiExecuteCommand(auth, 'get_vss_status', device.id, CommandTypes.VSS_WRITER_LIST, {}, {
          userId: auth.user.id,
          timeoutMs: 30000,
        });
        if (result.status !== 'completed') return jsonError(result.error ?? 'Failed to get VSS status', 'COMMAND_FAILED');

        const parsed = parseWriters(result.stdout);
        if ('raw' in parsed) return bounded({ deviceId: device.id, writers: null, raw: parsed.raw });
        if (!parsed.writers) {
          // Never a clean bill of health: a Windows machine normally reports several writers.
          return bounded({ deviceId: device.id, writers: null, note: 'The agent reported no VSS writers; the writer list could not be read.' });
        }
        const shown = parsed.writers.slice(0, VSS_WRITERS_SHOWN).map(projectWriter);
        const writers = shown.filter(Boolean);
        return bounded({
          deviceId: device.id,
          writers,
          ...(writers.length < shown.length ? { droppedMalformed: shown.length - writers.length } : {}),
          ...(parsed.writers.length > VSS_WRITERS_SHOWN ? { truncated: true } : {}),
        });
      } catch (error) {
        return thrown('get_vss_status', error);
      }
    },
  });
}
