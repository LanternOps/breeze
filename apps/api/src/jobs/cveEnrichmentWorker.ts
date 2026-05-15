import { Job, Queue, Worker } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as dbModule from '../db';
import { patches, thirdPartyPackageCatalog } from '../db/schema';
import {
  queryOsvForPackage,
  OsvRateLimitError,
  OsvServerError,
} from '../services/osvClient';
import { getBullMQConnection } from '../services/redis';

const { db } = dbModule;

const QUEUE_NAME = 'cve-enrichment';
const JOB_NAME = 'enrich';
const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CveEnrichmentJobData = {
  limit?: number;
};

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

let enrichmentQueue: Queue<CveEnrichmentJobData> | null = null;
let enrichmentWorker: Worker<CveEnrichmentJobData> | null = null;

export function getCveEnrichmentQueue(): Queue<CveEnrichmentJobData> {
  if (!enrichmentQueue) {
    enrichmentQueue = new Queue<CveEnrichmentJobData>(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return enrichmentQueue;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  important: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
};

export interface CveEnrichmentSummary {
  scanned: number;
  updated: number;
  errors: number;
}

export async function runCveEnrichmentBatch(
  { limit = 100 }: { limit?: number } = {}
): Promise<CveEnrichmentSummary> {
  const summary: CveEnrichmentSummary = { scanned: 0, updated: 0, errors: 0 };

  const rows = await db
    .select({
      patchId: patches.id,
      packageId: patches.packageId,
      currentSeverity: patches.severity,
      ecosystem: thirdPartyPackageCatalog.osvEcosystem,
      version: patches.version,
    })
    .from(patches)
    .innerJoin(
      thirdPartyPackageCatalog,
      and(
        eq(thirdPartyPackageCatalog.source, patches.source),
        eq(thirdPartyPackageCatalog.packageId, patches.packageId)
      )
    )
    .where(
      and(
        eq(patches.source, 'third_party'),
        isNotNull(thirdPartyPackageCatalog.osvEcosystem)
      )
    )
    .limit(limit);

  let consecutiveServerErrors = 0;

  for (const row of rows) {
    summary.scanned++;
    if (!row.ecosystem || !row.packageId) continue;
    if (!row.version) {
      // Without a version we can't query OSV meaningfully. Skip quietly.
      if (process.env.LOG_LEVEL === 'debug') {
        // eslint-disable-next-line no-console
        console.debug('[cveEnrichment] skipping row without version', {
          patchId: row.patchId,
          packageId: row.packageId,
        });
      }
      continue;
    }

    try {
      const osv = await queryOsvForPackage({
        ecosystem: row.ecosystem,
        name: row.packageId,
        version: row.version,
      });

      consecutiveServerErrors = 0;

      if (osv.cveIds.length === 0) continue;

      const currentRank = SEVERITY_RANK[row.currentSeverity ?? 'unknown'] ?? 0;
      const osvRank = osv.maxSeverity ? (SEVERITY_RANK[osv.maxSeverity] ?? 0) : 0;
      const nextSeverity = osvRank > currentRank ? osv.maxSeverity : row.currentSeverity;

      await db
        .update(patches)
        .set({
          cveIds: osv.cveIds,
          severity: nextSeverity,
          updatedAt: new Date(),
        })
        .where(eq(patches.id, row.patchId));
      summary.updated++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cveEnrichment] OSV lookup failed', {
        patchId: row.patchId,
        ecosystem: row.ecosystem,
        packageId: row.packageId,
        version: row.version,
        error: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;

      if (err instanceof OsvRateLimitError) {
        // Stop hammering OSV — abort and rethrow so the scheduler backs off.
        throw err;
      }
      if (err instanceof OsvServerError) {
        consecutiveServerErrors++;
        if (consecutiveServerErrors >= 3) {
          throw err;
        }
      } else {
        consecutiveServerErrors = 0;
      }
    }
  }

  return summary;
}

export function createCveEnrichmentWorker(): Worker<CveEnrichmentJobData> {
  return new Worker<CveEnrichmentJobData>(
    QUEUE_NAME,
    async (job: Job<CveEnrichmentJobData>) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[CveEnrichment] Ignoring unknown job name: ${job.name}`);
        return { scanned: 0, updated: 0, errors: 0, skipped: true };
      }

      return runWithSystemDbAccess(() =>
        runCveEnrichmentBatch({ limit: job.data.limit ?? DEFAULT_BATCH_LIMIT })
      );
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    }
  );
}

export async function initializeCveEnrichmentWorker(): Promise<void> {
  try {
    enrichmentWorker = createCveEnrichmentWorker();

    enrichmentWorker.on('error', (error) => {
      console.error('[CveEnrichment] Worker error:', error);
    });

    enrichmentWorker.on('failed', (job, error) => {
      console.error(`[CveEnrichment] Job ${job?.id} failed:`, error);
    });

    const queue = getCveEnrichmentQueue();
    const existingJobs = await queue.getRepeatableJobs();
    for (const job of existingJobs) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      JOB_NAME,
      { limit: DEFAULT_BATCH_LIMIT },
      {
        repeat: { every: DEFAULT_INTERVAL_MS },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      }
    );

    console.log('[CveEnrichment] Worker initialized');
  } catch (error) {
    console.error('[CveEnrichment] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownCveEnrichmentWorker(): Promise<void> {
  if (enrichmentWorker) {
    await enrichmentWorker.close();
    enrichmentWorker = null;
  }
  if (enrichmentQueue) {
    await enrichmentQueue.close();
    enrichmentQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_INTERVAL_MS,
};
