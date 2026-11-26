/**
 * An in-flight backup job as the device status endpoint returns it
 * (`GET /backup/status/:deviceId` → `data.activeJobs`, #11027). The web derives
 * phase, speed, ETA and stall state from these fields
 * (apps/web/src/components/backup/backupJobProgress.ts).
 */
export type ActiveBackupJob = {
  id: string;
  status: 'pending' | 'running';
  backupMode: string | null;
  backupType: string | null;
  createdAt: string;
  startedAt: string | null;
  totalSize: number | null;
  transferredSize: number | null;
  fileCount: number | null;
  totalFiles: number | null;
  lastProgressAt: string | null;
  lastKeepaliveAt: string | null;
  /** Latest `resumed_at` of this job's `snapshot_write` storage sessions. */
  resumedAt: string | null;
  /**
   * While a running job waits for an interrupted earlier run to release the
   * snapshot (#12693): when it may start uploading. Null when it is not
   * waiting. Absent on an older API during a rolling deploy.
   */
  writerWaitUntil?: string | null;
};
