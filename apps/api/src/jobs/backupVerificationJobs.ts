import { Job, Queue, Worker } from 'bullmq';
import * as dbModule from '../db';
import { getRedisConnection } from '../services/redis';
import {
  ensurePostBackupIntegrityChecks,
  recalculateReadinessScores,
  runWeeklyTestRestore,
  timeoutStaleVerifications
} from '../routes/backup/verificationService';

const BACKUP_VERIFICATION_QUEUE = 'backup-verification';
const POST_BACKUP_EVERY_MS = 10 * 60 * 1000;
const DAILY_READINESS_CRON = '0 2 * * *'; // 02:00 UTC daily
const WEEKLY_RESTORE_CRON = '0 3 * * 0'; // 03:00 UTC Sundays

type BackupVerificationJobData =
  | { type: 'post-backup-integrity-check'; queuedAt: string }
  | { type: 'readiness-score-calculator'; queuedAt: string }
  | { type: 'weekly-test-restore'; queuedAt: string }
  | { type: 'verification-timeout-check'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

let backupVerificationQueue: Queue<BackupVerificationJobData> | null = null;
let backupVerificationWorker: Worker<BackupVerificationJobData> | null = null;

function getBackupVerificationQueue(): Queue<BackupVerificationJobData> {
  if (!backupVerificationQueue) {
    backupVerificationQueue = new Queue<BackupVerificationJobData>(BACKUP_VERIFICATION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return backupVerificationQueue;
}

function createBackupVerificationWorker(): Worker<BackupVerificationJobData> {
  return new Worker<BackupVerificationJobData>(
    BACKUP_VERIFICATION_QUEUE,
    async (job: Job<BackupVerificationJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'post-backup-integrity-check') {
          const created = await ensurePostBackupIntegrityChecks();
          return { created };
        }
        if (job.data.type === 'weekly-test-restore') {
          const queued = await runWeeklyTestRestore();
          return { queued };
        }
        if (job.data.type === 'verification-timeout-check') {
          const timedOut = await timeoutStaleVerifications();
          return { timedOut };
        }
        const computed = await recalculateReadinessScores();
        return { computed };
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );
}

async function scheduleRepeatableJobs(): Promise<void> {
  const queue = getBackupVerificationQueue();
  const repeatables = await queue.getRepeatableJobs();

  for (const job of repeatables) {
    if (
      job.name === 'post-backup-integrity-check'
      || job.name === 'readiness-score-calculator'
      || job.name === 'weekly-test-restore'
      || job.name === 'verification-timeout-check'
    ) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'post-backup-integrity-check',
    { type: 'post-backup-integrity-check', queuedAt: new Date().toISOString() },
    {
      jobId: 'backup-verification-post-backup',
      repeat: { every: POST_BACKUP_EVERY_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    }
  );

  await queue.add(
    'readiness-score-calculator',
    { type: 'readiness-score-calculator', queuedAt: new Date().toISOString() },
    {
      jobId: 'backup-verification-readiness-daily',
      repeat: { pattern: DAILY_READINESS_CRON },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    }
  );

  await queue.add(
    'weekly-test-restore',
    { type: 'weekly-test-restore', queuedAt: new Date().toISOString() },
    {
      jobId: 'backup-verification-weekly-restore',
      repeat: { pattern: WEEKLY_RESTORE_CRON },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    }
  );

  await queue.add(
    'verification-timeout-check',
    { type: 'verification-timeout-check', queuedAt: new Date().toISOString() },
    {
      jobId: 'backup-verification-timeout-check',
      repeat: { every: 5 * 60 * 1000 }, // every 5 minutes
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    }
  );
}

export async function initializeBackupVerificationJobs(): Promise<void> {
  if (backupVerificationWorker) {
    return;
  }

  backupVerificationWorker = createBackupVerificationWorker();
  backupVerificationWorker.on('error', (error) => {
    console.error('[BackupVerificationJobs] Worker error:', error);
  });
  backupVerificationWorker.on('failed', (job, error) => {
    console.error(`[BackupVerificationJobs] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });

  await scheduleRepeatableJobs();
  console.log('[BackupVerificationJobs] Initialized');
}

export async function shutdownBackupVerificationJobs(): Promise<void> {
  if (backupVerificationWorker) {
    await backupVerificationWorker.close();
    backupVerificationWorker = null;
  }
  if (backupVerificationQueue) {
    await backupVerificationQueue.close();
    backupVerificationQueue = null;
  }
}
