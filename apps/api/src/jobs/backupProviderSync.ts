import { Job, type JobsOptions, Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, ne, sql } from 'drizzle-orm';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import * as dbModule from '../db';
import { backupProviderConnections } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { decryptProviderCredentials } from '../services/backupProviders/credentials';
import { getBackupProvider } from '../services/backupProviders/registry';
import { ProviderRequestError } from '../services/backupProviders/types';
import { persistVendorSnapshot } from '../services/backupProviders/persist';
import { evaluateProviderAlerts } from '../services/backupProviders/alerts';
import { attachWorkerObservability } from './workerObservability';

/**
 * External backup provider sync (#6008).
 *
 * W01 ships ONLY the queue handle and the enqueue helper — the connection
 * create route and "Sync now" both call `enqueueBackupProviderSync`, and the
 * job waits in Redis until W02 adds the worker, the repeatable `sync-all`
 * ticker and `syncConnectionById` to this same file. Shipping a route that
 * claims to sync with nothing behind it would be worse than a visibly queued
 * job.
 */
export const BACKUP_PROVIDER_SYNC_QUEUE = 'backup-provider-sync';

export interface SyncAllJobData { type: 'sync-all' }
export interface SyncConnectionJobData { type: 'sync-connection'; connectionId: string }
export type BackupProviderSyncJobData = SyncAllJobData | SyncConnectionJobData;

/**
 * Three attempts with exponential backoff, matching huntressSync: a
 * per-connection sync is one enumeration plus one idempotent upsert
 * transaction, so a transient managed-Postgres connection drop or a vendor 503
 * is worth retrying. W02's `reauth` failures throw `UnrecoverableError`, which
 * BullMQ does not retry regardless of this setting.
 */
export const BACKUP_PROVIDER_SYNC_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let queue: Queue<BackupProviderSyncJobData> | null = null;

/**
 * `createInstrumentedQueue`, not a bare `new Queue`: it wraps `add`/`addBulk`
 * in `assertOutsideHeldDbContext`, which throws in CI when an enqueue happens
 * inside a held request transaction (#1105). Every call site of
 * `enqueueBackupProviderSync` therefore runs it under `runOutsideDbContext`.
 */
export function getBackupProviderSyncQueue(): Queue<BackupProviderSyncJobData> {
  if (!queue) {
    queue = createInstrumentedQueue<BackupProviderSyncJobData>(BACKUP_PROVIDER_SYNC_QUEUE);
  }
  return queue;
}

/** The ONE job id for a connection, so a scheduled sync and "Sync now" coalesce. */
export function backupProviderSyncJobId(connectionId: string): string {
  return `backup-provider-sync-${connectionId}`;
}

/**
 * Queue a sync for one connection, returning the job id.
 *
 * Goes through `enqueueOrReplaceStale` rather than a bare `queue.add`: BullMQ's
 * jobId dedup keys on "a record with this id EXISTS", and `removeOnFail`
 * deliberately keeps recent failures around — so after a failed sync every
 * later `add` under the same id is silently discarded and the operator's "Sync
 * now" does nothing, forever. The helper reuses a genuinely in-flight job
 * (active/waiting/delayed/prioritized) and replaces a spent record.
 */
export async function enqueueBackupProviderSync(connectionId: string): Promise<string> {
  if (!connectionId) {
    throw new Error('enqueueBackupProviderSync requires a connection id');
  }
  const { id } = await enqueueOrReplaceStale(
    getBackupProviderSyncQueue(),
    'sync-connection',
    backupProviderSyncJobId(connectionId),
    { type: 'sync-connection', connectionId } satisfies SyncConnectionJobData,
    BACKUP_PROVIDER_SYNC_JOB_OPTS,
    '[BackupProviderSync]',
  );
  return id;
}

/** Close the queue connection (tests, and W02's `shutdownBackupProviderSyncJob`). */
export async function shutdownBackupProviderSyncQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[BackupProviderSync] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn, label);
};

/** How often the scan runs. Per-connection cadence is sync_interval_minutes. */
const SYNC_ALL_INTERVAL_MINUTES = 5;
const ADVISORY_LOCK_NAMESPACE = 'backup-provider-sync';
const MAX_SYNC_ERROR_LENGTH = 2000;

/**
 * Sentinel prefix on an UnrecoverableError raised for a rejected credential.
 * The typed ProviderRequestError does not survive BullMQ's round-trip into the
 * 'failed' event (the same reason huntressSync.ts:1136-1140 re-matches on the
 * message), and a marker cannot drift the way vendor error wording can.
 */
const BACKUP_PROVIDER_REAUTH_MARKER = '[backup-provider-reauth]';

let backupProviderSyncWorker: Worker<BackupProviderSyncJobData> | null = null;

export interface DueConnectionRow {
  id: string;
  lastSyncAt: Date | null;
  syncIntervalMinutes: number;
}

/**
 * PURE due-ness rule. The SQL pre-filters the two FLAG columns only (is_active,
 * status) and this decides the schedule, so the rule has one home and a unit
 * test (huntressSync.ts:980-985 is the same split).
 */
export function selectDueConnections(rows: DueConnectionRow[], now: Date): DueConnectionRow[] {
  return rows.filter((row) => {
    if (!row.lastSyncAt) return true;
    const elapsedMinutes = (now.getTime() - row.lastSyncAt.getTime()) / 60_000;
    return elapsedMinutes >= row.syncIntervalMinutes;
  });
}

async function processSyncAll(): Promise<{ queued: number }> {
  // Read inside a short DB context: backup_provider_connections is partner-axis,
  // so a contextless read silently returns 0 rows (#1375). A `reauth_required`
  // connection is skipped entirely — only "Sync now" retries it, and only after
  // a credentials PATCH has reset status to 'connected' (spec, Sync job).
  const candidates = await runWithSystemDbAccess(() => db
    .select({
      id: backupProviderConnections.id,
      lastSyncAt: backupProviderConnections.lastSyncAt,
      syncIntervalMinutes: backupProviderConnections.syncIntervalMinutes,
    })
    .from(backupProviderConnections)
    .where(and(
      eq(backupProviderConnections.isActive, true),
      ne(backupProviderConnections.status, 'reauth_required'),
    )), 'backupProviderSync.scan');

  // The enqueue runs with NO transaction held — Redis-inside-a-context is the
  // #1105 anti-pattern. Goes through the SAME enqueueBackupProviderSync every
  // other caller uses, so a scheduled sync and a "Sync now" click coalesce on
  // the same job id.
  const due = selectDueConnections(candidates, new Date());
  await Promise.all(due.map((connection) => enqueueBackupProviderSync(connection.id)));
  return { queued: due.length };
}

function isProviderReauthFailure(error: unknown): boolean {
  if (error instanceof ProviderRequestError) return error.reauth;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(BACKUP_PROVIDER_REAUTH_MARKER);
}

async function recordSyncFailure(
  connectionId: string,
  message: string,
  reauth: boolean,
): Promise<void> {
  // A FRESH transaction: phase 3's transaction is rolling back as we unwind, so
  // recording the failure on that connection would be undone and the row would
  // keep its stale 'running'. Escape the context and open a new one
  // (huntressSync.ts:932-950).
  try {
    await dbModule.runOutsideDbContext(() => runWithSystemDbAccess(() => db
      .update(backupProviderConnections)
      .set({
        lastSyncStatus: 'error',
        lastSyncError: message.slice(0, MAX_SYNC_ERROR_LENGTH),
        ...(reauth ? { status: 'reauth_required' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(backupProviderConnections.id, connectionId)), 'backupProviderSync.recordError'));
  } catch (dbError) {
    console.error(`[BackupProviderSync] Failed to record sync error for ${connectionId}:`, dbError);
    captureException(dbError instanceof Error ? dbError : new Error(String(dbError)));
  }
}

/**
 * Sync ONE connection.
 *
 * Phase 1 — load + mark running in a short system context. The `running` write
 * returns the row's new `updated_at`, which is the fence phase 3 compares
 * against.
 * Phase 2 — vendor HTTP under runOutsideDbContext, holding no pooled
 * connection. Any failure aborts BEFORE a single row is written; the adapter
 * throws on a partial page, so "absent from the snapshot" always means "gone".
 * Phase 3 — one system transaction holding the per-connection advisory lock:
 * re-read FOR UPDATE, abort if deleted/deactivated/credentials changed, then
 * persist and write the counters.
 * Step 4 — after that commit, evaluate alerts and events. A failure there marks
 * the sync `partial` and never fails the job.
 */
export async function syncConnectionById(
  connectionId: string,
  options: { isFinalAttempt?: boolean } = {},
): Promise<void> {
  const isFinalAttempt = options.isFinalAttempt ?? true;

  // ---- phase 1 ---------------------------------------------------------
  const loaded = await runWithSystemDbAccess(async () => {
    const [row] = await db
      .select()
      .from(backupProviderConnections)
      .where(eq(backupProviderConnections.id, connectionId))
      .limit(1);
    if (!row) return null;
    if (!row.isActive) return { row, fence: null, inactive: true as const };

    const [marked] = await db
      .update(backupProviderConnections)
      .set({ lastSyncStatus: 'running', lastSyncError: null, updatedAt: new Date() })
      .where(eq(backupProviderConnections.id, connectionId))
      .returning({ updatedAt: backupProviderConnections.updatedAt });
    return { row, fence: marked?.updatedAt ?? null, inactive: false as const };
  }, 'backupProviderSync.load');

  if (!loaded) {
    console.warn(`[BackupProviderSync] Connection ${connectionId} not found, skipping sync`);
    return;
  }
  if (loaded.inactive) {
    console.warn(`[BackupProviderSync] Connection ${connectionId} is inactive, skipping sync`);
    return;
  }
  if (!loaded.fence) {
    // The `running` write matched no row. Unlike Huntress's cosmetic badge this
    // value IS the optimistic-concurrency fence, so there is nothing to detect a
    // mid-sync credential change with — refuse rather than sync blind.
    throw new Error(`[BackupProviderSync] Could not mark connection ${connectionId} as running`);
  }

  const connection = loaded.row;
  const fence = loaded.fence;

  try {
    if (!connection.vendorRootId) {
      throw new UnrecoverableError(
        `${BACKUP_PROVIDER_REAUTH_MARKER} connection ${connectionId} has no vendor root id — re-test the connection`,
      );
    }

    const adapter = getBackupProvider(connection.provider);
    const credentials = decryptProviderCredentials(connectionId, connection.credentialsEncrypted);

    // ---- phase 2 -------------------------------------------------------
    const [customers, vendorDevices] = await dbModule.runOutsideDbContext(() => Promise.all([
      adapter.listCustomers(credentials, connection.baseUrl, connection.vendorRootId!),
      adapter.listDevices(credentials, connection.baseUrl, connection.vendorRootId!),
    ]));

    // ---- phase 3 -------------------------------------------------------
    const counters = await runWithSystemDbAccess(async () => {
      await db.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${connectionId}))
      `);

      const [current] = await db
        .select({
          id: backupProviderConnections.id,
          partnerId: backupProviderConnections.partnerId,
          provider: backupProviderConnections.provider,
          isActive: backupProviderConnections.isActive,
          showProviderNameInPortal: backupProviderConnections.showProviderNameInPortal,
          updatedAt: backupProviderConnections.updatedAt,
        })
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, connectionId))
        .for('update')
        .limit(1);

      if (!current || !current.isActive) return null;
      if (current.updatedAt.getTime() !== fence.getTime()) return null;

      const result = await persistVendorSnapshot(
        db,
        {
          id: current.id,
          partnerId: current.partnerId,
          provider: current.provider,
          showProviderNameInPortal: current.showProviderNameInPortal,
        },
        { customers, devices: vendorDevices },
      );

      // Counters commit in the SAME transaction as the rows they describe, so
      // "succeeded at <lastSyncAt>" can never disagree with the numbers shown.
      await db
        .update(backupProviderConnections)
        .set({
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncError: null,
          status: 'connected',
          lastSyncCustomers: result.customers,
          lastSyncUnmappedCustomers: result.unmappedCustomers,
          lastSyncDevices: result.devices,
          lastSyncUnmappedDevices: result.unmappedDevices,
          lastSyncLinkedDevices: result.linked,
          lastSyncAmbiguousDevices: result.ambiguous,
          updatedAt: new Date(),
        })
        .where(eq(backupProviderConnections.id, connectionId));

      return result;
    }, 'backupProviderSync.persist');

    if (!counters) {
      console.warn(
        `[BackupProviderSync] Connection ${connectionId} changed during the vendor fetch `
        + '(deleted, deactivated or re-credentialled); nothing written, the next poll retries',
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reauth = isProviderReauthFailure(error);
    // Only the FINAL attempt records a terminal 'error' (#1736): an earlier
    // attempt leaves the row 'running' so the UI keeps showing "Syncing" while
    // BullMQ backs off. A rejected credential is terminal at any attempt.
    if (isFinalAttempt || reauth) {
      await recordSyncFailure(connectionId, message, reauth);
    }
    if (reauth) {
      throw error instanceof UnrecoverableError ? error : new UnrecoverableError(
        `${BACKUP_PROVIDER_REAUTH_MARKER} ${message}`,
      );
    }
    throw error;
  }

  // ---- step 4 (after the inventory commit) -----------------------------
  try {
    await evaluateProviderAlerts(connectionId);
  } catch (error) {
    // Idempotent, so the next sync redoes it. The inventory is committed and
    // correct — degrade to 'partial', never fail the job (spec, Sync job).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[BackupProviderSync] Alert evaluation failed for ${connectionId}:`, error);
    captureException(error instanceof Error ? error : new Error(message), undefined, {
      service: 'backupProviders',
      operation: 'evaluateProviderAlerts',
      connectionId,
    });
    try {
      await dbModule.runOutsideDbContext(() => runWithSystemDbAccess(() => db
        .update(backupProviderConnections)
        .set({
          lastSyncStatus: 'partial',
          lastSyncError: `alerts: ${message}`.slice(0, MAX_SYNC_ERROR_LENGTH),
          updatedAt: new Date(),
        })
        .where(eq(backupProviderConnections.id, connectionId)), 'backupProviderSync.markPartial'));
    } catch (dbError) {
      console.error(`[BackupProviderSync] Failed to mark ${connectionId} partial:`, dbError);
      captureException(dbError instanceof Error ? dbError : new Error(String(dbError)));
    }
  }
}

async function processSyncConnection(
  data: { connectionId: string },
  job: Job<BackupProviderSyncJobData>,
): Promise<void> {
  // BullMQ increments attemptsMade on move-to-active, so inside the processor it
  // is 1-based: the final attempt is `attemptsMade >= attempts`
  // (huntressSync.ts:1002-1007).
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  await syncConnectionById(data.connectionId, { isFinalAttempt });
}

function createBackupProviderSyncWorker(): Worker<BackupProviderSyncJobData> {
  return new Worker<BackupProviderSyncJobData>(
    BACKUP_PROVIDER_SYNC_QUEUE,
    async (job: Job<BackupProviderSyncJobData>) => {
      // No blanket withSystemDbAccessContext wrap: each path manages its own
      // short contexts so the vendor fetch holds no pooled connection
      // (#1105/#1697).
      switch (job.data.type) {
        case 'sync-all':
          return processSyncAll();
        case 'sync-connection':
          return processSyncConnection(job.data, job);
        default:
          throw new Error(`Unknown backup provider sync job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function scheduleRepeatSyncAll(): Promise<void> {
  const q = getBackupProviderSyncQueue();
  for (const repeatable of await q.getRepeatableJobs()) {
    if (repeatable.name === 'sync-all') {
      await q.removeRepeatableByKey(repeatable.key);
    }
  }
  await q.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { every: SYNC_ALL_INTERVAL_MINUTES * 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 30 },
    },
  );
}

export async function initializeBackupProviderSyncJob(): Promise<void> {
  backupProviderSyncWorker = createBackupProviderSyncWorker();
  attachWorkerObservability(backupProviderSyncWorker, 'backupProviderSyncWorker');
  backupProviderSyncWorker.on('error', (error) => {
    console.error('[BackupProviderSync] Worker error:', error);
    captureException(error);
  });
  backupProviderSyncWorker.on('failed', (job, error) => {
    // A rejected vendor credential is a config issue already recorded on the
    // connection row — not a code bug. Capturing it once per scheduled run is
    // what flooded the org's Sentry quota for Huntress (BREEZE-1, ~508 events).
    // Log it; don't report.
    if (isProviderReauthFailure(error)) {
      console.warn(
        `[BackupProviderSync] Job ${job?.id} failed: provider credentials rejected — `
        + 'update them on the connection. Not retried, not reported to Sentry.',
      );
      return;
    }
    console.error(`[BackupProviderSync] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRepeatSyncAll();
  console.log('[BackupProviderSync] Backup provider sync worker initialized');
}

export async function shutdownBackupProviderSyncJob(): Promise<void> {
  if (backupProviderSyncWorker) {
    await backupProviderSyncWorker.close();
    backupProviderSyncWorker = null;
  }
  await shutdownBackupProviderSyncQueue();
  console.log('[BackupProviderSync] Backup provider sync worker shut down');
}
