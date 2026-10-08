import { Job, type JobsOptions, Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, ne, sql } from 'drizzle-orm';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import * as dbModule from '../db';
import { edrConnections, edrTenants } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { decryptEdrSecret } from '../services/edrProviders/credentials';
import { getEdrProvider } from '../services/edrProviders/registry';
import { buildEdrAdapterContext } from '../services/edrProviders/context';
import { isStreamDue, planCadence } from '../services/edrProviders/scheduler';
import {
  EdrProviderRequestError,
  type EdrAdapterContext,
  type EdrDetectionPage,
  type EdrProviderAdapter,
} from '../services/edrProviders/types';
import {
  isDeadlockError,
  persistDetections,
  persistInventory,
  pruneMissingTenantEndpoints,
  refreshDetectionDeviceLinks,
  upsertTenants,
  type EdrSyncTx,
  type InventoryFetch,
  type TenantFetch,
} from '../services/edrProviders/persist';
import { autoMapEdrTenants } from '../services/edrProviders/mapping';
import { matchEdrEndpoints } from '../services/edrProviders/deviceMatching';
import { attachWorkerObservability } from './workerObservability';

/**
 * External EDR provider sync (#8164 W01b). Two independent streams per
 * connection -- inventory (tenants + endpoints) and detections -- each with its
 * own job id so neither coalesces the other away. Mirrors backupProviderSync.ts
 * (three phases, final-attempt error recording, reauth marker).
 */
export const EDR_PROVIDER_SYNC_QUEUE = 'edr-provider-sync';

export type EdrSyncStream = 'inventory' | 'detections';
export type EdrSyncJobData =
  | { type: 'sync-all' }
  | { type: 'sync-inventory'; connectionId: string }
  | { type: 'sync-detections'; connectionId: string };

export const EDR_PROVIDER_SYNC_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let queue: Queue<EdrSyncJobData> | null = null;

/** `createInstrumentedQueue` so an enqueue inside a held request transaction trips the #1105 tripwire. */
export function getEdrProviderSyncQueue(): Queue<EdrSyncJobData> {
  if (!queue) queue = createInstrumentedQueue<EdrSyncJobData>(EDR_PROVIDER_SYNC_QUEUE);
  return queue;
}

export function edrSyncJobId(stream: EdrSyncStream, connectionId: string): string {
  return `edr-${stream}-${connectionId}`;
}

/** Queue one stream for one connection (scheduled sync and "Sync now" coalesce on the job id). */
export async function enqueueEdrSync(connectionId: string, stream: EdrSyncStream): Promise<string> {
  if (!connectionId) throw new Error('enqueueEdrSync requires a connection id');
  const type = stream === 'inventory' ? 'sync-inventory' : 'sync-detections';
  const { id } = await enqueueOrReplaceStale(
    getEdrProviderSyncQueue(),
    type,
    edrSyncJobId(stream, connectionId),
    { type, connectionId } as EdrSyncJobData,
    EDR_PROVIDER_SYNC_JOB_OPTS,
    '[EdrProviderSync]',
  );
  return id;
}

export async function shutdownEdrProviderSyncQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[EdrProviderSync] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn, label);
};

const SYNC_ALL_INTERVAL_MINUTES = 5;
const ADVISORY_LOCK_NAMESPACE = 'edr-provider-sync';
const MAX_SYNC_ERROR_LENGTH = 2000;
/** Endpoints re-enriched per mapped tenant per inventory run, stalest first. */
const DETAIL_ENRICH_PER_RUN = 50;
/** Phase 3 retries on a Postgres deadlock (40P01) -- see persist.ts LOCK ORDER note. */
const MAX_DEADLOCK_RETRIES = 3;

/** Sentinel on an UnrecoverableError for a rejected credential (the typed error does not survive BullMQ). */
const EDR_REAUTH_MARKER = '[edr-provider-reauth]';

let edrProviderSyncWorker: Worker<EdrSyncJobData> | null = null;

// ---------------------------------------------------------------------------
// Due-ness
// ---------------------------------------------------------------------------

export interface DueRow {
  connectionId: string;
  lastInventorySyncAt: Date | null;
  lastDetectionSyncAt: Date | null;
  inventoryIntervalMinutes: number;
  detectionIntervalMinutes: number;
}

/** PURE: which (connection, stream) pairs are due now. Each stream uses its own interval. */
export function selectDueStreams(
  rows: DueRow[],
  now: Date,
): Array<{ connectionId: string; stream: EdrSyncStream }> {
  const out: Array<{ connectionId: string; stream: EdrSyncStream }> = [];
  for (const row of rows) {
    if (isStreamDue(row.lastInventorySyncAt, row.inventoryIntervalMinutes, now)) {
      out.push({ connectionId: row.connectionId, stream: 'inventory' });
    }
    if (isStreamDue(row.lastDetectionSyncAt, row.detectionIntervalMinutes, now)) {
      out.push({ connectionId: row.connectionId, stream: 'detections' });
    }
  }
  return out;
}

async function processSyncAll(): Promise<{ queued: number }> {
  // partner-axis table: a contextless read silently returns 0 rows (#1375).
  // `reauth_required` connections are skipped; only "Sync now" after a credentials PATCH retries them.
  const candidates = await runWithSystemDbAccess(() => db
    .select({
      id: edrConnections.id,
      provider: edrConnections.provider,
      lastInventorySyncAt: edrConnections.lastInventorySyncAt,
      lastDetectionSyncAt: edrConnections.lastDetectionSyncAt,
      effectiveInventory: edrConnections.effectiveInventoryIntervalMinutes,
      effectiveDetection: edrConnections.effectiveDetectionIntervalMinutes,
      requestedInventory: edrConnections.inventoryIntervalMinutes,
      requestedDetection: edrConnections.detectionIntervalMinutes,
    })
    .from(edrConnections)
    .where(and(eq(edrConnections.isActive, true), ne(edrConnections.status, 'reauth_required'))),
  'edrProviderSync.scan');

  const rows: DueRow[] = [];
  for (const c of candidates) {
    let adapter: EdrProviderAdapter;
    try {
      adapter = getEdrProvider(c.provider);
    } catch (error) {
      console.error(`[EdrProviderSync] Connection ${c.id}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const d = adapter.capabilities.defaultIntervals;
    rows.push({
      connectionId: c.id,
      lastInventorySyncAt: c.lastInventorySyncAt,
      lastDetectionSyncAt: c.lastDetectionSyncAt,
      inventoryIntervalMinutes: c.effectiveInventory ?? Math.max(c.requestedInventory ?? d.inventoryMinutes, d.inventoryMinutes),
      detectionIntervalMinutes: c.effectiveDetection ?? Math.max(c.requestedDetection ?? d.detectionsMinutes, d.detectionsMinutes),
    });
  }

  // Enqueue with NO transaction held (#1105).
  const due = selectDueStreams(rows, new Date());
  await Promise.all(due.map((d) => enqueueEdrSync(d.connectionId, d.stream)));
  return { queued: due.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEdrReauthFailure(error: unknown): boolean {
  if (error instanceof EdrProviderRequestError) return error.reauth;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(EDR_REAUTH_MARKER);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** Run `fn` over `items` with bounded concurrency; the first thrown error stops new work and is rethrown. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

const deadlockBackoffMs = (attempt: number): number => 10 * attempt + Math.floor(Math.random() * 25);

interface LoadedTenant { id: string; vendorTenantId: string; orgId: string | null; apiHost: string | null; detectionCursor: string | null }

interface LoadedConnection {
  row: typeof edrConnections.$inferSelect;
  tenants: LoadedTenant[];
  /** inventory only: tenant row id -> stalest vendor endpoint ids to enrich */
  staleDetailIds: Map<string, string[]>;
  /** inventory only: tenant row id -> every vendor endpoint id already stored */
  knownEndpointIds: Map<string, Set<string>>;
}

/**
 * Endpoints to enrich this run: ones fetched for the first time (so a newly mapped company shows
 * health / online / last-seen on its first sync, not an inventory cycle later), then the stalest
 * stored ones, capped at DETAIL_ENRICH_PER_RUN.
 */
function enrichmentTargets(fetchedIds: readonly string[], known: ReadonlySet<string>, stale: readonly string[]): string[] {
  const fresh = fetchedIds.filter((id) => !known.has(id));
  return [...new Set([...fresh, ...stale])].slice(0, DETAIL_ENRICH_PER_RUN);
}

async function loadForSync(connectionId: string, stream: EdrSyncStream): Promise<LoadedConnection | null> {
  return runWithSystemDbAccess(async () => {
    const [row] = await db.select().from(edrConnections).where(eq(edrConnections.id, connectionId)).limit(1);
    if (!row) {
      console.warn(`[EdrProviderSync] Connection ${connectionId} not found, skipping sync`);
      return null;
    }
    if (!row.isActive) {
      console.warn(`[EdrProviderSync] Connection ${connectionId} is inactive, skipping sync`);
      return null;
    }
    await db
      .update(edrConnections)
      .set(stream === 'inventory'
        ? { lastInventorySyncStatus: 'running', lastInventorySyncError: null }
        : { lastDetectionSyncStatus: 'running', lastDetectionSyncError: null })
      .where(eq(edrConnections.id, connectionId));

    const tenants = await db
      .select({
        id: edrTenants.id,
        vendorTenantId: edrTenants.vendorTenantId,
        orgId: edrTenants.orgId,
        apiHost: edrTenants.apiHost,
        detectionCursor: edrTenants.detectionCursor,
      })
      .from(edrTenants)
      .where(and(eq(edrTenants.connectionId, connectionId), sql`${edrTenants.vendorMissingSince} IS NULL`));

    const staleDetailIds = new Map<string, string[]>();
    const knownEndpointIds = new Map<string, Set<string>>();
    if (stream === 'inventory') {
      // Every stored endpoint id (so phase 2 can tell which fetched endpoints are NEW), ranked
      // stalest-detail first per tenant.
      const rows = (await db.execute(sql`
        SELECT tenant_id, vendor_endpoint_id,
               row_number() OVER (PARTITION BY tenant_id ORDER BY vendor_detail_synced_at ASC NULLS FIRST) AS rn
        FROM edr_endpoints WHERE connection_id = ${connectionId}::uuid
      `)) as unknown as Array<{ tenant_id: string; vendor_endpoint_id: string; rn: number | string }>;
      for (const r of rows) {
        const known = knownEndpointIds.get(r.tenant_id) ?? new Set<string>();
        known.add(r.vendor_endpoint_id);
        knownEndpointIds.set(r.tenant_id, known);
        if (Number(r.rn) <= DETAIL_ENRICH_PER_RUN) {
          const list = staleDetailIds.get(r.tenant_id) ?? [];
          list.push(r.vendor_endpoint_id);
          staleDetailIds.set(r.tenant_id, list);
        }
      }
    }
    return { row, tenants, staleDetailIds, knownEndpointIds };
  }, `edrProviderSync.load.${stream}`);
}

function buildContext(adapter: EdrProviderAdapter, row: typeof edrConnections.$inferSelect): EdrAdapterContext {
  const creds = decryptEdrSecret('connection_credentials', row.id, row.credentialsEncrypted);
  return buildEdrAdapterContext(adapter, {
    creds,
    baseUrl: row.baseUrl,
    region: row.region,
    vendorRootId: row.vendorRootId,
  });
}

/**
 * Phase 3 wrapper: ONE system tx under the per-connection advisory lock. Re-reads
 * the connection FOR UPDATE and returns null (writes nothing) when it was deleted,
 * deactivated, or its credential material changed during the vendor fetch -- the
 * fence is the credential tuple (not updated_at) because the two streams write
 * the same row concurrently. A deadlock (40P01 against a device delete / org
 * move, which lock in the opposite order) retries the whole tx with the fence
 * re-read each time.
 */
async function runPhase3<T>(
  loaded: LoadedConnection,
  label: string,
  body: (tx: EdrSyncTx, current: { id: string; partnerId: string; provider: string }) => Promise<T>,
): Promise<T | null> {
  const row = loaded.row;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runWithSystemDbAccess(async () => {
        await db.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${row.id}))
        `);
        const [current] = await db
          .select({
            id: edrConnections.id,
            partnerId: edrConnections.partnerId,
            provider: edrConnections.provider,
            isActive: edrConnections.isActive,
            credentialsEncrypted: edrConnections.credentialsEncrypted,
            baseUrl: edrConnections.baseUrl,
            region: edrConnections.region,
            vendorRootId: edrConnections.vendorRootId,
          })
          .from(edrConnections)
          .where(eq(edrConnections.id, row.id))
          .for('update')
          .limit(1);
        if (!current || !current.isActive) return null;
        if (
          current.credentialsEncrypted !== row.credentialsEncrypted
          || current.baseUrl !== row.baseUrl
          || current.region !== row.region
          || current.vendorRootId !== row.vendorRootId
        ) return null;
        return body(db as unknown as EdrSyncTx, current);
      }, label);
    } catch (error) {
      if (isDeadlockError(error) && attempt < MAX_DEADLOCK_RETRIES) {
        await new Promise((r) => setTimeout(r, deadlockBackoffMs(attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function recordSyncFailure(
  connectionId: string,
  stream: EdrSyncStream,
  message: string,
  reauth: boolean,
): Promise<void> {
  // A FRESH transaction: phase 3's is rolling back as we unwind.
  const clipped = message.slice(0, MAX_SYNC_ERROR_LENGTH);
  try {
    await dbModule.runOutsideDbContext(() => runWithSystemDbAccess(() => db
      .update(edrConnections)
      .set({
        ...(stream === 'inventory'
          ? { lastInventorySyncStatus: 'error' as const, lastInventorySyncError: clipped }
          : { lastDetectionSyncStatus: 'error' as const, lastDetectionSyncError: clipped }),
        ...(reauth ? { status: 'reauth_required' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(edrConnections.id, connectionId)), 'edrProviderSync.recordError'));
  } catch (dbError) {
    console.error(`[EdrProviderSync] Failed to record sync error for ${connectionId}:`, dbError);
    captureException(dbError instanceof Error ? dbError : new Error(String(dbError)));
  }
}

async function handleSyncError(
  error: unknown,
  connectionId: string,
  stream: EdrSyncStream,
  isFinalAttempt: boolean,
): Promise<never> {
  const message = error instanceof Error ? error.message : String(error);
  const reauth = isEdrReauthFailure(error);
  // rate_limited / rate_budget_exhausted are connection-scope but NOT reauth: they
  // fall through to a plain rethrow so BullMQ backs off; nothing was persisted.
  if (isFinalAttempt || reauth) {
    await recordSyncFailure(connectionId, stream, message, reauth);
  }
  if (reauth) {
    throw error instanceof UnrecoverableError ? error : new UnrecoverableError(`${EDR_REAUTH_MARKER} ${message}`);
  }
  throw error;
}

function requireRoot(row: typeof edrConnections.$inferSelect): string {
  if (!row.vendorRootId) {
    throw new UnrecoverableError(
      `${EDR_REAUTH_MARKER} connection ${row.id} has no vendor root id -- re-test the connection`,
    );
  }
  return row.vendorRootId;
}

// ---------------------------------------------------------------------------
// Inventory stream
// ---------------------------------------------------------------------------

export async function syncEdrInventory(
  connectionId: string,
  options: { isFinalAttempt?: boolean } = {},
): Promise<void> {
  const isFinalAttempt = options.isFinalAttempt ?? true;

  // ---- phase 1 ---------------------------------------------------------
  const loaded = await loadForSync(connectionId, 'inventory');
  if (!loaded) return;

  try {
    const rootId = requireRoot(loaded.row);
    const adapter = getEdrProvider(loaded.row.provider);
    const ctx = buildContext(adapter, loaded.row);
    const byVendorId = new Map(loaded.tenants.map((t) => [t.vendorTenantId, t]));

    // ---- phase 2 (NO DB) ---------------------------------------------
    const fetched = await dbModule.runOutsideDbContext(async () => {
      // listTenants is all-or-nothing: a failure throws and nothing is written.
      const vendorTenants = await adapter.listTenants(ctx, { id: rootId, type: loaded.row.vendorRootType });
      const results = await mapWithConcurrency(
        vendorTenants,
        adapter.capabilities.tenantFetchConcurrency,
        async (t): Promise<TenantFetch<InventoryFetch>> => {
          const known = byVendorId.get(t.vendorTenantId);
          const ref = { vendorTenantId: t.vendorTenantId, apiHost: known?.apiHost ?? t.apiHost };
          try {
            if (!known?.orgId) {
              // Unmapped: counted, never stored (D5).
              return {
                vendorTenantId: t.vendorTenantId,
                ok: true,
                value: {
                  endpoints: [],
                  details: [],
                  count: adapter.countEndpoints ? await adapter.countEndpoints(ctx, ref) : undefined,
                },
              };
            }
            const endpoints = await adapter.listEndpoints(ctx, ref);
            const details = adapter.enrichEndpoints
              ? await adapter.enrichEndpoints(ctx, ref, enrichmentTargets(
                endpoints.map((e) => e.vendorEndpointId),
                loaded.knownEndpointIds.get(known.id) ?? new Set(),
                loaded.staleDetailIds.get(known.id) ?? [],
              ))
              : [];
            return { vendorTenantId: t.vendorTenantId, ok: true, value: { endpoints, details } };
          } catch (err) {
            // reauth / budget / rate limit: the whole run fails.
            if (err instanceof EdrProviderRequestError && err.scope === 'connection') throw err;
            return { vendorTenantId: t.vendorTenantId, ok: false, error: safeMessage(err), scope: 'tenant' };
          }
        },
      );
      return { vendorTenants, results };
    });

    // ---- phase 3 -------------------------------------------------------
    const done = await runPhase3(loaded, 'edrProviderSync.persistInventory', async (tx, current) => {
      const now = new Date();
      const conn = { id: current.id, partnerId: current.partnerId, provider: current.provider };
      const tenantCounts = await upsertTenants(tx, conn, fetched.vendorTenants, now, {
        hostAllowlist: adapter.hostAllowlist,
      });
      const mapped = await autoMapEdrTenants(tx, conn);
      const inv = await persistInventory(tx, conn, fetched.results, now);
      await pruneMissingTenantEndpoints(tx, conn.id, now);
      const match = await matchEdrEndpoints(tx, conn.id);
      await refreshDetectionDeviceLinks(tx, conn.id);

      const unmapped = Math.max(0, tenantCounts.unmapped - mapped.mapped);
      const [open] = await tx
        .select({ n: sql<number>`coalesce(sum(${edrTenants.openDetectionCount}), 0)::int` })
        .from(edrTenants)
        .where(eq(edrTenants.connectionId, conn.id));

      const cadence = planCadence({
        tenants: tenantCounts.total,
        mappedTenants: Math.max(0, tenantCounts.total - unmapped),
        capabilities: adapter.capabilities,
        requested: {
          detectionsMinutes: loaded.row.detectionIntervalMinutes,
          inventoryMinutes: loaded.row.inventoryIntervalMinutes,
        },
        estimatedCalls: { perTenantDetection: 1, perTenantInventory: 3, perConnectionOverhead: 2 },
      });

      const failed = inv.failedTenants;
      await tx
        .update(edrConnections)
        .set({
          lastInventorySyncAt: now,
          lastInventorySyncStatus: failed > 0 ? 'partial' : 'success',
          lastInventorySyncError: failed > 0 ? `${failed} tenant(s) failed to sync` : null,
          status: 'connected',
          lastSyncTenants: tenantCounts.total,
          lastSyncUnmappedTenants: unmapped,
          lastSyncFailedTenants: failed,
          lastSyncEndpoints: inv.endpoints,
          lastSyncLinkedEndpoints: match.linked,
          lastSyncAmbiguousEndpoints: match.ambiguous,
          lastSyncOpenDetections: open?.n ?? 0,
          effectiveDetectionIntervalMinutes: cadence.detectionsMinutes,
          effectiveInventoryIntervalMinutes: cadence.inventoryMinutes,
          updatedAt: now,
        })
        .where(eq(edrConnections.id, conn.id));
      return true;
    });

    if (!done) {
      console.warn(
        `[EdrProviderSync] Connection ${connectionId} changed during the vendor fetch `
        + '(deleted, deactivated or re-credentialled); nothing written, the next poll retries',
      );
    }
  } catch (error) {
    await handleSyncError(error, connectionId, 'inventory', isFinalAttempt);
  }
}

// ---------------------------------------------------------------------------
// Detection stream
// ---------------------------------------------------------------------------

export async function syncEdrDetections(
  connectionId: string,
  options: { isFinalAttempt?: boolean } = {},
): Promise<void> {
  const isFinalAttempt = options.isFinalAttempt ?? true;

  const loaded = await loadForSync(connectionId, 'detections');
  if (!loaded) return;

  try {
    requireRoot(loaded.row);
    const adapter = getEdrProvider(loaded.row.provider);
    // ONE context (and runCache) for the whole run: connection-wide vendor calls
    // (incidents, quarantine) are memoized there and shared by every tenant.
    const ctx = buildContext(adapter, loaded.row);
    // Unmapped tenants are not fetched.
    const mappedTenants = loaded.tenants.filter((t) => t.orgId);

    // ---- phase 2 (NO DB) ---------------------------------------------
    const now = new Date();
    const results = await dbModule.runOutsideDbContext(() => mapWithConcurrency(
      mappedTenants,
      adapter.capabilities.tenantFetchConcurrency,
      async (t): Promise<TenantFetch<EdrDetectionPage>> => {
        try {
          const page = await adapter.listDetections(
            ctx,
            { vendorTenantId: t.vendorTenantId, apiHost: t.apiHost },
            t.detectionCursor,
            now,
          );
          return { vendorTenantId: t.vendorTenantId, ok: true, value: page };
        } catch (err) {
          if (err instanceof EdrProviderRequestError && err.scope === 'connection') throw err;
          return { vendorTenantId: t.vendorTenantId, ok: false, error: safeMessage(err), scope: 'tenant' };
        }
      },
    ));

    // ---- phase 3 -------------------------------------------------------
    const done = await runPhase3(loaded, 'edrProviderSync.persistDetections', async (tx, current) => {
      const at = new Date();
      const conn = { id: current.id, partnerId: current.partnerId, provider: current.provider };
      const det = await persistDetections(tx, conn, results, at);
      await refreshDetectionDeviceLinks(tx, conn.id);
      const [open] = await tx
        .select({ n: sql<number>`coalesce(sum(${edrTenants.openDetectionCount}), 0)::int` })
        .from(edrTenants)
        .where(eq(edrTenants.connectionId, conn.id));
      await tx
        .update(edrConnections)
        .set({
          lastDetectionSyncAt: at,
          lastDetectionSyncStatus: det.failedTenants > 0 ? 'partial' : 'success',
          lastDetectionSyncError: det.failedTenants > 0 ? `${det.failedTenants} tenant(s) failed to sync` : null,
          status: 'connected',
          lastSyncOpenDetections: open?.n ?? 0,
          updatedAt: at,
        })
        .where(eq(edrConnections.id, conn.id));
      return true;
    });

    if (!done) {
      console.warn(
        `[EdrProviderSync] Connection ${connectionId} changed during the vendor fetch `
        + '(deleted, deactivated or re-credentialled); nothing written, the next poll retries',
      );
    }
  } catch (error) {
    await handleSyncError(error, connectionId, 'detections', isFinalAttempt);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function createEdrProviderSyncWorker(): Worker<EdrSyncJobData> {
  return new Worker<EdrSyncJobData>(
    EDR_PROVIDER_SYNC_QUEUE,
    async (job: Job<EdrSyncJobData>) => {
      // No blanket system-context wrap: each path manages its own short contexts.
      // attemptsMade is 1-based inside the processor.
      const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
      switch (job.data.type) {
        case 'sync-all':
          return processSyncAll();
        case 'sync-inventory':
          return syncEdrInventory(job.data.connectionId, { isFinalAttempt });
        case 'sync-detections':
          return syncEdrDetections(job.data.connectionId, { isFinalAttempt });
        default:
          throw new Error(`Unknown EDR provider sync job type: ${(job.data as { type: string }).type}`);
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
  const q = getEdrProviderSyncQueue();
  for (const repeatable of await q.getRepeatableJobs()) {
    if (repeatable.name === 'sync-all') await q.removeRepeatableByKey(repeatable.key);
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

export async function initializeEdrProviderSyncJob(): Promise<void> {
  edrProviderSyncWorker = createEdrProviderSyncWorker();
  attachWorkerObservability(edrProviderSyncWorker, 'edrProviderSyncWorker');
  edrProviderSyncWorker.on('error', (error) => {
    console.error('[EdrProviderSync] Worker error:', error);
    captureException(error);
  });
  edrProviderSyncWorker.on('failed', (job, error) => {
    // A rejected vendor credential is a config issue already on the connection row (BREEZE-1 lesson).
    if (isEdrReauthFailure(error)) {
      console.warn(
        `[EdrProviderSync] Job ${job?.id} failed: provider credentials rejected -- `
        + 'update them on the connection. Not retried, not reported to Sentry.',
      );
      return;
    }
    console.error(`[EdrProviderSync] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRepeatSyncAll();
  console.log('[EdrProviderSync] EDR provider sync worker initialized');
}

export async function shutdownEdrProviderSyncJob(): Promise<void> {
  if (edrProviderSyncWorker) {
    await edrProviderSyncWorker.close();
    edrProviderSyncWorker = null;
  }
  await shutdownEdrProviderSyncQueue();
  console.log('[EdrProviderSync] EDR provider sync worker shut down');
}
