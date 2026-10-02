import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceCommands,
  devicePatches,
  devices,
  patchJobResults,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
} from '../db/schema';

/**
 * The deployment axis of a patch, as opposed to its approval axis (#4223).
 *
 * Approval (`patch_approvals`, plus ring auto-approval evaluated in memory at
 * dispatch) says whether a patch MAY be installed. It says nothing about what
 * happened when an install was attempted. When a scheduled job fails on the
 * device — the Windows agent's battery preflight, low disk, a WUA error — the
 * only record is `patch_job_results.error_message`, so both patch views kept
 * rendering "Pending approval" and hid the reason.
 */
export type PatchInstallFailure = {
  /** Devices whose MOST RECENT attempt at this patch failed and still need it. */
  deviceCount: number;
  /** Reason from the most recent of those failures (may be null if the agent sent none). */
  error: string | null;
  /** ISO timestamp of the most recent of those failures. */
  failedAt: string;
};

/**
 * How a device's most recent install attempt at a patch ended.
 *
 * `installed` is the agent saying the install ran and succeeded — which, for a
 * Windows update that needs a restart to finish, is NOT the same as the next
 * scan no longer offering it: WUA keeps such an update `IsInstalled=0` until
 * the device restarts (#7680). `other` is everything that is neither a failure
 * nor an install: queued, running, skipped (already current / not offered).
 */
export type PatchInstallAttempt = {
  deviceId: string;
  patchId: string;
  outcome: 'failed' | 'installed' | 'other';
  error: string | null;
  /** The install reported that a restart is needed to finish it. */
  rebootRequired: boolean;
  /** When it finished, or started if it has not — the "which attempt is newer" key. */
  at: Date;
};

type Scope = { orgId?: string; deviceId?: string };

/**
 * How far back a per-device `install_patches` command is still read as an
 * install attempt (#7680). Bounds the `device_commands` read on the fleet
 * patch list; job attempts in `patch_job_results` are not bounded.
 */
const DEVICE_INSTALL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** `device_commands.status` values that are an attempt. `cancelled` is not — the user withdrew it. */
const DEVICE_INSTALL_ATTEMPT_STATUSES = ['pending', 'sent', 'completed', 'failed', 'timeout'] as const;

/**
 * For each patch id, the devices whose LATEST install attempt at that patch
 * failed, restricted to devices that still have the patch outstanding
 * (`device_patches.status = 'pending'`).
 *
 * An attempt is either a `patch_job_results` row (scheduled / bulk jobs) or a
 * per-device `install_patches` command with no `patchJobId` — the device
 * Patches tab's Install button and vulnerability remediation (#7680). Those
 * never write `patch_job_results`, so before #7680 a newer per-device install
 * could not supersede an older job failure, and its own failure was invisible
 * here.
 *
 * "Latest" is per (device, patch): a newer attempt of any status — a retry
 * that is queued/running, a success, or a superseded/skipped row — replaces an
 * older failure, so a stale failure never outlives a newer attempt. Installed
 * patches are excluded by the outstanding join, so a failure that the agent
 * later fixed out of band (manual install, next scan) also disappears.
 *
 * Runs in the caller's request DB context: `patch_job_results` is device-join
 * RLS and `device_commands` is read only through an inner join on `devices`
 * and `device_patches` (both RLS), so partner/org visibility is enforced by
 * the database; `orgId` / `deviceId` only narrow further.
 */
export async function loadPatchInstallFailures(
  patchIds: readonly string[],
  scope: Scope = {},
): Promise<Map<string, PatchInstallFailure>> {
  return summarizeInstallFailures(await loadLatestAttempts(patchIds, scope, { allJobAttempts: false }));
}

/**
 * The device Patches tab's view of one device: the failure overlay above plus
 * every outstanding patch's latest install attempt, whatever its outcome —
 * which is what tells "installed, waiting for a restart" apart from a patch
 * nothing has tried to install (#7680).
 */
export async function loadDevicePatchInstallState(
  deviceId: string,
  patchIds: readonly string[],
): Promise<{ failures: Map<string, PatchInstallFailure>; latestByPatch: Map<string, PatchInstallAttempt> }> {
  const attempts = await loadLatestAttempts(patchIds, { deviceId }, { allJobAttempts: true });
  return {
    failures: summarizeInstallFailures(attempts),
    latestByPatch: new Map(attempts.map((attempt) => [attempt.patchId, attempt])),
  };
}

function summarizeInstallFailures(attempts: readonly PatchInstallAttempt[]): Map<string, PatchInstallFailure> {
  const byPatch = new Map<string, { deviceCount: number; latest: PatchInstallAttempt }>();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'failed') continue;
    const entry = byPatch.get(attempt.patchId);
    if (!entry) {
      byPatch.set(attempt.patchId, { deviceCount: 1, latest: attempt });
      continue;
    }
    entry.deviceCount++;
    if (attempt.at.getTime() > entry.latest.at.getTime()) entry.latest = attempt;
  }

  const result = new Map<string, PatchInstallFailure>();
  for (const [patchId, { deviceCount, latest }] of byPatch) {
    result.set(patchId, { deviceCount, error: latest.error, failedAt: latest.at.toISOString() });
  }
  return result;
}

/**
 * The latest attempt per outstanding (device, patch), merged across both
 * sources. With `allJobAttempts: false` (the fleet-wide failure overlay) the
 * job side returns only failed latest rows, plus every latest row on a device
 * that also has a per-device install — enough to decide which attempt is newer
 * without reading every completed job row in the org.
 */
async function loadLatestAttempts(
  patchIds: readonly string[],
  scope: Scope,
  opts: { allJobAttempts: boolean },
): Promise<PatchInstallAttempt[]> {
  if (patchIds.length === 0) return [];

  const deviceAttempts = await loadDeviceCommandAttempts(patchIds, scope);
  const jobAttempts = await loadJobAttempts(
    patchIds,
    scope,
    opts.allJobAttempts ? null : [...new Set(deviceAttempts.map((attempt) => attempt.deviceId))],
  );

  // Across the two sources "newer" is the attempt that moved last: its finish
  // time, or its start while it is still in flight. Start time alone would be
  // wrong here — a job's result row is created at dispatch, so a job queued
  // for an offline device that fails AFTER a later per-device install would
  // lose to it and its newer failure would be hidden. (Within one source the
  // DISTINCT ON keeps ordering by start, as #4223 did.)
  const latest = new Map<string, PatchInstallAttempt>();
  // Job attempts first: on an exact tie the job row stands.
  for (const attempt of [...jobAttempts, ...deviceAttempts]) {
    const key = `${attempt.deviceId}:${attempt.patchId}`;
    const current = latest.get(key);
    if (!current || attempt.at.getTime() > current.at.getTime()) {
      latest.set(key, attempt);
    }
  }
  return [...latest.values()];
}

/**
 * Latest `patch_job_results` row per outstanding (device, patch).
 * `alsoDevices === null` returns every latest row; otherwise only failed ones
 * and those on the listed devices.
 */
async function loadJobAttempts(
  patchIds: readonly string[],
  scope: Scope,
  alsoDevices: readonly string[] | null,
): Promise<PatchInstallAttempt[]> {
  const conditions: SQL[] = [inArray(patchJobResults.patchId, [...patchIds])];
  if (scope.deviceId) conditions.push(eq(patchJobResults.deviceId, scope.deviceId));
  if (scope.orgId) conditions.push(eq(devices.orgId, scope.orgId));

  const latest = db
    .selectDistinctOn([patchJobResults.deviceId, patchJobResults.patchId], {
      deviceId: patchJobResults.deviceId,
      patchId: patchJobResults.patchId,
      status: patchJobResults.status,
      errorMessage: patchJobResults.errorMessage,
      rebootRequired: patchJobResults.rebootRequired,
      rebootedAt: patchJobResults.rebootedAt,
      createdAt: patchJobResults.createdAt,
      completedAt: patchJobResults.completedAt,
    })
    .from(patchJobResults)
    .innerJoin(devices, eq(devices.id, patchJobResults.deviceId))
    .innerJoin(
      devicePatches,
      and(
        eq(devicePatches.deviceId, patchJobResults.deviceId),
        eq(devicePatches.patchId, patchJobResults.patchId),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      patchJobResults.deviceId,
      patchJobResults.patchId,
      desc(patchJobResults.createdAt),
      desc(patchJobResults.id),
    )
    .as('latest');

  const filter =
    alsoDevices === null
      ? undefined
      : alsoDevices.length > 0
        ? or(eq(latest.status, 'failed'), inArray(latest.deviceId, [...alsoDevices]))
        : eq(latest.status, 'failed');

  const rows = await db.select().from(latest).where(filter);

  const attempts: PatchInstallAttempt[] = [];
  for (const row of rows) {
    if (!row.patchId) continue;
    const outcome: PatchInstallAttempt['outcome'] =
      row.status === 'failed' ? 'failed' : row.status === 'completed' ? 'installed' : 'other';
    attempts.push({
      deviceId: row.deviceId,
      patchId: row.patchId,
      outcome,
      error: outcome === 'failed' ? row.errorMessage : null,
      // A restart the patch-reboot handler already carried out has finished the install.
      rebootRequired: outcome === 'installed' && row.rebootRequired && row.rebootedAt === null,
      at: row.completedAt ?? row.createdAt,
    });
  }
  return attempts;
}

/**
 * Latest per-device `install_patches` command (no `patchJobId`) per
 * outstanding (device, patch) it names in `payload.patchIds` (#7680).
 */
async function loadDeviceCommandAttempts(
  patchIds: readonly string[],
  scope: Scope,
): Promise<PatchInstallAttempt[]> {
  const conditions: SQL[] = [
    // A SQL literal, not a bound parameter: it is what lets the planner match
    // the partial index idx_device_commands_install_patches_device_created
    // (WHERE type = 'install_patches') under a generic prepared-statement plan.
    sql`${deviceCommands.type} = 'install_patches'`,
    sql`${deviceCommands.payload}->>'patchJobId' IS NULL`,
    inArray(deviceCommands.status, [...DEVICE_INSTALL_ATTEMPT_STATUSES]),
    gte(deviceCommands.createdAt, new Date(Date.now() - DEVICE_INSTALL_LOOKBACK_MS)),
    // A command queued while the device belonged to another org is that org's
    // history, not this one's (NULL = written before provenance existed).
    or(isNull(deviceCommands.submittedOrgId), eq(deviceCommands.submittedOrgId, devices.orgId))!,
  ];
  if (scope.deviceId) conditions.push(eq(deviceCommands.deviceId, scope.deviceId));
  if (scope.orgId) conditions.push(eq(devices.orgId, scope.orgId));

  const rows = await db
    .selectDistinctOn([deviceCommands.deviceId, devicePatches.patchId], {
      id: deviceCommands.id,
      deviceId: deviceCommands.deviceId,
      patchId: devicePatches.patchId,
      status: deviceCommands.status,
      result: deviceCommands.result,
      createdAt: deviceCommands.createdAt,
      completedAt: deviceCommands.completedAt,
    })
    .from(deviceCommands)
    // device_commands has no RLS; these two joins are what scope it.
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .innerJoin(
      devicePatches,
      and(
        eq(devicePatches.deviceId, deviceCommands.deviceId),
        inArray(devicePatches.patchId, [...patchIds]),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]),
        sql`${deviceCommands.payload}->'patchIds' @> jsonb_build_array(${devicePatches.patchId}::text)`,
      ),
    )
    .where(and(...conditions))
    .orderBy(
      deviceCommands.deviceId,
      devicePatches.patchId,
      desc(deviceCommands.createdAt),
      desc(deviceCommands.id),
    );

  return rows.map((row) => ({
    deviceId: row.deviceId,
    patchId: row.patchId,
    ...deviceCommandOutcome(row.status, row.result, row.patchId, row.id),
    at: row.completedAt ?? row.createdAt,
  }));
}

type CommandOutcome = Pick<PatchInstallAttempt, 'outcome' | 'error' | 'rebootRequired'>;

/**
 * One patch's outcome from a stored `install_patches` result. The stored row
 * is the agent's envelope (`{status, exitCode, stdout, error}`) with the
 * handler's summary as a JSON STRING in `stdout`; its `results[]` entries are
 * keyed by `id` = `patches.id` and carry `status: 'installed' | 'failed' |
 * 'skipped'` (agent `executePatchInstallCommand`).
 */
export function deviceCommandOutcome(
  commandStatus: string,
  result: unknown,
  patchId: string,
  commandId?: string,
): CommandOutcome {
  const envelope = asRecord(result);
  const envelopeError = nonEmptyString(envelope?.error) ?? nonEmptyString(envelope?.errorMessage);

  if (commandStatus === 'timeout') {
    return { outcome: 'failed', error: envelopeError, rebootRequired: false };
  }
  if (commandStatus !== 'completed' && commandStatus !== 'failed') {
    return { outcome: 'other', error: null, rebootRequired: false };
  }

  const summary = parseStdout(envelope?.stdout, commandId);
  const entries = Array.isArray(summary?.results) ? summary.results : [];
  const entry = entries
    .map(asRecord)
    .find((candidate) => candidate !== null && (candidate.id === patchId || candidate.patchId === patchId));

  if (!entry) {
    // No per-patch line: a whole-command failure (preflight, no provider)
    // failed every patch it named; a completed one says nothing about this one.
    return commandStatus === 'failed'
      ? { outcome: 'failed', error: envelopeError, rebootRequired: false }
      : { outcome: 'other', error: null, rebootRequired: false };
  }

  const status = typeof entry.status === 'string' ? entry.status : null;
  if (status === 'failed' || entry.success === false) {
    return {
      outcome: 'failed',
      error: nonEmptyString(entry.error) ?? nonEmptyString(entry.message) ?? envelopeError,
      rebootRequired: false,
    };
  }
  if (status === 'installed' || (status === null && entry.success === true)) {
    return { outcome: 'installed', error: null, rebootRequired: entry.rebootRequired === true };
  }
  return { outcome: 'other', error: null, rebootRequired: false };
}

function parseStdout(stdout: unknown, commandId?: string): Record<string, unknown> | null {
  if (typeof stdout !== 'string') return asRecord(stdout);
  try {
    return asRecord(JSON.parse(stdout));
  } catch (err) {
    // Plain text (an older agent, a bare error) has no per-patch lines and is
    // expected. A summary that looks like JSON but does not parse is not: the
    // patches it names fall back to the command-level outcome, so say so.
    if (stdout.trimStart().startsWith('{')) {
      console.warn(
        `[patchInstallFailures] install_patches command ${commandId ?? '(unknown)'}: stored summary is not valid JSON; using the command-level outcome for its patches:`,
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
