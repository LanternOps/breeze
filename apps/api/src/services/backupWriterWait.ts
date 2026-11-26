/**
 * When a running backup job is held back by an earlier, interrupted writer of
 * the same snapshot (#12693). The write-session service refuses new uploads
 * until every URL the earlier session issued, plus the transfer margin, has
 * lapsed (and until an in-flight delete has settled). This reads that same
 * horizon from the stored sessions so the job can say why it sits at 0 bytes;
 * it changes nothing about the wait itself.
 *
 * Pure: the caller loads the rows and passes the two margins that
 * backupStorageWriteSessions.ts enforces, so the display cannot drift from the
 * gate.
 */

/**
 * How long an upload may still be running after the URL it started with has
 * expired (see backupStorageWriteSessions.ts, which enforces it and re-exports
 * it). Defined here so the display reads the same number as the gate.
 */
export const STORAGE_WRITE_TRANSFER_MARGIN_MS = 15 * 60 * 1000;

/** A delete marker older than this was left by a call that never finished. */
export const STORAGE_DELETE_SETTLE_MS = 5 * 60 * 1000;

export type WriterWaitSession = {
  id: string;
  jobId: string | null;
  reservationSnapshotId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  urlHorizonAt: Date | null;
  deletingSince: Date | null;
  readOnly: boolean;
  resumedAt: Date | null;
};

export type WriterWaitMargins = {
  /** Added to the latest URL expiry of another session. */
  transferMarginMs: number;
  /** Added to the delete marker of another session. */
  deleteSettleMs: number;
};

/**
 * For each job, the instant its newest write session may start uploading, when
 * that is still in the future. Jobs that are not waiting have no entry.
 */
export function computeWriterWaits(
  sessions: WriterWaitSession[],
  jobIds: string[],
  now: Date,
  margins: WriterWaitMargins,
): Map<string, Date> {
  const waits = new Map<string, Date>();
  for (const jobId of jobIds) {
    let own: WriterWaitSession | undefined;
    for (const s of sessions) {
      if (s.jobId !== jobId || !s.reservationSnapshotId) continue;
      if (!own || s.createdAt.getTime() > own.createdAt.getTime()) own = s;
    }
    // Only a live session is waiting; a revoked newest one is not running,
    // and a read-only completion session never uploads.
    if (!own || own.revokedAt || own.readOnly) continue;

    let until = 0;
    for (const s of sessions) {
      if (s.id === own.id || s.reservationSnapshotId !== own.reservationSnapshotId) continue;
      if (s.urlHorizonAt) until = Math.max(until, s.urlHorizonAt.getTime() + margins.transferMarginMs);
      // The gate checks another session's in-flight delete only when a
      // session resumes, so only a resumed session waits on it.
      if (s.deletingSince && own.resumedAt) until = Math.max(until, s.deletingSince.getTime() + margins.deleteSettleMs);
    }
    if (until > now.getTime()) waits.set(jobId, new Date(until));
  }
  return waits;
}
