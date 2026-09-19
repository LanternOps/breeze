import { eq } from 'drizzle-orm';
import type { TouchClass } from '@breeze/shared';
import { db } from '../../db';
import { devices, deviceCommands } from '../../db/schema/devices';
import { dispatchScriptToDevice } from '../scriptDispatch';
import { captureException } from '../sentry';

/**
 * Windows System Restore checkpoint, taken before an UNATTENDED script run
 * whose classifier output touches something a restore point can undo
 * (spec §4.6 invariant 11).
 *
 * WHY A FIXED SCRIPT AND NOT A NEW DEVICE COMMAND. The agent has no System
 * Restore handler and adding one is an agent-binary change this wave's
 * constraints forbid. The existing `script` primitive already carries exactly
 * the payload this needs. The first-class version (a `system_protection`
 * policy feature type, `agent/internal/systemrestore`, a
 * `restore_point_attempts` ledger) is issue #4609; it replaces THIS function
 * behind the same `ensureRestoreCheckpoint` seam, so nothing else in the lane
 * needs to change when it lands.
 *
 * The script body is a CONSTANT. It is never composed from caller input, so
 * this function cannot become a general-purpose remote-execution hole.
 *
 * NON-WINDOWS RETURNS `unsupported_platform`. That is not a soft failure: it
 * makes the `registry`, `services` and `files_system` classes lane-INELIGIBLE
 * on Linux and macOS in v1 (spec §4.6 invariant 11, §10), because the lane
 * refuses when the checkpoint is unavailable. An operator who wants
 * `services` unattended on Linux must approve by hand.
 *
 * Runs in whatever DB context the caller holds: the release worker calls it
 * under its own system context; a request-path caller reads through RLS.
 */
export const RESTORE_CHECKPOINT_CLASSES: ReadonlySet<TouchClass> = new Set<TouchClass>([
  'registry',
  'services',
  'files_system',
]);

/** Provenance label stamped on the raw dispatch (`device_commands.payload.scriptId`). */
export const RESTORE_CHECKPOINT_PROVENANCE = 'ai_script_lane_checkpoint';

/**
 * Enables System Restore on the system drive if it is off, clears the 1440-
 * minute creation throttle for this call, creates the checkpoint, and prints
 * the new sequence number. `$ErrorActionPreference = "Stop"` + the explicit
 * exit codes mean a silently-skipped checkpoint reports failure instead of
 * success (Checkpoint-Computer only WARNS when throttled).
 */
export const RESTORE_CHECKPOINT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  Enable-ComputerRestore -Drive "$env:SystemDrive\\"',
  '  New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore" ' +
    '-Name "SystemRestorePointCreationFrequency" -Value 0 -PropertyType DWord -Force | Out-Null',
  '  $before = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Measure-Object -Property SequenceNumber -Maximum).Maximum',
  '  Checkpoint-Computer -Description "Breeze AI script lane" -RestorePointType "APPLICATION_INSTALL"',
  '  $after = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Measure-Object -Property SequenceNumber -Maximum).Maximum',
  '  if ($null -eq $after -or $after -eq $before) { Write-Error "no restore point was created"; exit 1 }',
  '  Write-Output "BREEZE_CHECKPOINT_OK seq=$after"',
  '  exit 0',
  '} catch { Write-Error $_.Exception.Message; exit 1 }',
].join('\n');

const CHECKPOINT_TIMEOUT_MS = 180_000;
const CHECKPOINT_POLL_MS = 3_000;
/** Statuses under which the agent may still report. Anything else is terminal. */
const NON_TERMINAL_COMMAND_STATUSES = new Set(['pending', 'sent', 'running', 'queued']);

export type RestoreCheckpointRefusal =
  | 'unsupported_platform'
  | 'device_unavailable'
  | 'dispatch_failed'
  | 'timeout'
  | 'checkpoint_failed';

export type RestoreCheckpointResult =
  | { ok: true; checkpointRef: string }
  | { ok: false; reason: RestoreCheckpointRefusal };

export async function ensureRestoreCheckpoint(
  deviceId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RestoreCheckpointResult> {
  const timeoutMs = opts.timeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CHECKPOINT_POLL_MS;
  try {
    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        osType: devices.osType,
        status: devices.status,
        agentId: devices.agentId,
        hostname: devices.hostname,
        siteId: devices.siteId,
        customFields: devices.customFields,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) return { ok: false, reason: 'device_unavailable' };
    if (device.osType !== 'windows') return { ok: false, reason: 'unsupported_platform' };

    const dispatch = await dispatchScriptToDevice({
      device,
      source: {
        kind: 'raw',
        content: RESTORE_CHECKPOINT_SCRIPT,
        language: 'powershell',
        provenance: RESTORE_CHECKPOINT_PROVENANCE,
      },
      runAs: 'system',
      timeoutSeconds: 150,
      // The lane already decided this run happens; a maintenance window must
      // not strip the run of its rollback point while letting the run itself
      // proceed. The RUN's own window check is unchanged (invariant 14).
      bypassMaintenanceWindow: true,
      offlinePolicy: { kind: 'reject' },
    });
    if (!dispatch.ok) {
      return {
        ok: false,
        reason:
          dispatch.code === 'device_offline' || dispatch.code === 'device_decommissioned'
            ? 'device_unavailable'
            : 'dispatch_failed',
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ status: deviceCommands.status, result: deviceCommands.result })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, dispatch.commandId))
        .limit(1);
      if (!row) return { ok: false, reason: 'dispatch_failed' };
      const result = row.result as { exitCode?: number | null; stdout?: string | null } | null;
      if (result && typeof result.exitCode === 'number') {
        if (result.exitCode !== 0) return { ok: false, reason: 'checkpoint_failed' };
        const seq = /BREEZE_CHECKPOINT_OK seq=(\d+)/.exec(result.stdout ?? '')?.[1];
        return seq ? { ok: true, checkpointRef: seq } : { ok: false, reason: 'checkpoint_failed' };
      }
      // Terminal without an exit code (server-side timeout, expiry, failed
      // delivery): nothing more will arrive.
      if (!NON_TERMINAL_COMMAND_STATUSES.has(row.status)) {
        return { ok: false, reason: 'checkpoint_failed' };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: false, reason: 'timeout' };
  } catch (err) {
    console.error('[restoreCheckpoint] failed — denying the lane (fail-closed):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { ok: false, reason: 'dispatch_failed' };
  }
}
