/**
 * Live progress math for in-flight backup jobs, shared by the org job list
 * (BackupJobList) and the device Backup tab (DeviceBackupActiveJobs) so the two
 * compute speed, ETA and stall state the same way (#11027).
 */
import type { ActiveBackupJob } from '@breeze/shared';

/**
 * A running job whose agent has been silent for this long is flagged as
 * stalled. Keyed on liveness (lastKeepaliveAt), not lastProgressAt: since #2798
 * lastProgressAt moves only when bytes/files advance, and a single large file
 * legitimately holds it still for its whole upload.
 */
export const STALL_MS = 120_000;

export type { ActiveBackupJob };

export type ProgressSample = { bytes: number; at: number };

/**
 * Transfer speed (bytes/sec) from consecutive poll samples. The running-average
 * fallback fires ONLY when there is no prior sample; once a sample exists, a
 * zero/negative delta (a stalled job) yields no speed at all rather than a
 * misleading average. Returns no sample when the job reports no transferred
 * size, so the caller drops any sample it held.
 */
export function nextSpeedSample(
  prev: ProgressSample | undefined,
  job: { transferredSize: number | null; startedAt: string | null },
  now: number,
): { bps: number | undefined; sample: ProgressSample | undefined } {
  if (job.transferredSize == null) return { bps: undefined, sample: undefined };
  let bps: number | undefined;
  if (prev) {
    if (now > prev.at && job.transferredSize > prev.bytes) {
      bps = (job.transferredSize - prev.bytes) / ((now - prev.at) / 1000);
    }
  } else if (job.startedAt) {
    const elapsedSec = (now - new Date(job.startedAt).getTime()) / 1000;
    if (elapsedSec > 0) bps = job.transferredSize / elapsedSec;
  }
  if (bps == null || !Number.isFinite(bps) || bps <= 0) bps = undefined;
  return { bps, sample: { bytes: job.transferredSize, at: now } };
}

export function stallState(
  job: { status: string; lastKeepaliveAt: string | null; lastProgressAt: string | null },
  now: number,
): { stalled: boolean; minutes: number } {
  // Rows from a server predating #2798 carry no lastKeepaliveAt; their
  // lastProgressAt was liveness then.
  const livenessAt = job.lastKeepaliveAt ?? job.lastProgressAt;
  if (job.status !== 'running' || !livenessAt) return { stalled: false, minutes: 0 };
  const silentMs = now - new Date(livenessAt).getTime();
  return {
    stalled: silentMs > STALL_MS,
    minutes: Math.max(1, Math.floor(silentMs / 60_000)),
  };
}

/** Null unless there is a positive total, a positive speed and bytes still to go. */
export function estimateRemainingMs(
  job: { transferredSize: number | null; totalSize: number | null },
  bps: number | undefined,
): number | null {
  const total = job.totalSize ?? 0;
  const done = job.transferredSize ?? 0;
  if (total <= 0 || bps == null || !(bps > 0) || done >= total) return null;
  return ((total - done) / bps) * 1000;
}

export type ActivePhase = 'waiting_for_device' | 'queued_on_device' | 'resuming' | 'scanning' | 'backing_up';

/**
 * The phase worth showing, derived from columns that already exist (plan
 * Design 4): the agent's own phase is not persisted.
 */
export function deriveActivePhase(
  job: Pick<ActiveBackupJob, 'status' | 'lastKeepaliveAt' | 'resumedAt' | 'transferredSize' | 'totalSize'>,
): ActivePhase {
  if (job.status === 'pending') {
    // A keepalive on a pending job means the device has it and is running
    // another backup first (one mode at a time per device, #11012).
    return job.lastKeepaliveAt ? 'queued_on_device' : 'waiting_for_device';
  }
  if (job.resumedAt && !job.transferredSize) return 'resuming';
  if (!((job.totalSize ?? 0) > 0)) return 'scanning';
  return 'backing_up';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Compact duration for an ETA: "<1m", "45m", "3h 10m", "2d 4h". */
export function formatEta(ms: number): string {
  if (!(ms >= MINUTE_MS)) return '<1m';
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ${Math.floor((ms % HOUR_MS) / MINUTE_MS)}m`;
  return `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / HOUR_MS)}h`;
}
