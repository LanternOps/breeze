import { sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { drainTopologyOutbox } from '../services/topology/legacyImport';
import { pruneDeliveredTopologyOutbox } from '../services/topology/legacyRetention';
import { loadTopologyFlags } from '../services/topology/flags';
import { captureException } from '../services/sentry';

export const TOPOLOGY_REPAIR_INTERVAL_MS = 2000;
const SITE_BATCH = 25;
const EVENT_BATCH = 200;
let timer: ReturnType<typeof setInterval> | null = null;
let activeDrain: Promise<void> | null = null;
let lastAlertAt = 0;

export function retryableTopologyTransaction(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40P01' || code === '40001' || code === '55P03';
}

/** Retry the WHOLE transaction after inventory FK/capture lock conflicts.
 * Never catch/retry a PostgreSQL-aborted transaction inside its old context. */
export async function runTopologyRepairTick(): Promise<void> {
  const sites = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ org_id: string; site_id: string; oldest: Date | null }>(sql`
    SELECT s.org_id,s.site_id,min(o.created_at) FILTER (WHERE o.delivered_at IS NULL) AS oldest
    FROM topology_site_state s LEFT JOIN topology_change_outbox o ON o.org_id=s.org_id AND o.site_id=s.site_id
    WHERE s.effective_settings->'legacyImport'->>'version'='1'
      AND (s.dirty_revision>s.materialized_input_revision OR EXISTS (
        SELECT 1 FROM topology_change_outbox old WHERE old.org_id=s.org_id AND old.site_id=s.site_id
          AND old.delivered_at<now()-interval '7 days'))
    GROUP BY s.org_id,s.site_id,s.updated_at
    ORDER BY s.updated_at,s.site_id
    LIMIT ${SITE_BATCH}
  `), 'topology repair candidates'));
  for (const row of sites) {
    const scope = { orgId: row.org_id, siteId: row.site_id };
    if (row.oldest && new Date(row.oldest).getTime() < Date.now() - 15 * 60_000 && Date.now() - lastAlertAt > 5 * 60_000) {
      lastAlertAt = Date.now();
      captureException(new Error('Topology outbox backlog is older than 15 minutes'), undefined, { siteId: row.site_id });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
          // Rotate attempted sites even while their materialization flag is
          // off; an older disabled site must not starve an enabled site's work.
          await db.execute(sql`UPDATE topology_site_state SET updated_at=now() WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
          const flags = await loadTopologyFlags({ scope });
          if (!flags.materialization) return;
          await drainTopologyOutbox(scope, { batchSize: EVENT_BATCH });
          await pruneDeliveredTopologyOutbox(scope);
        }, 'topology outbox replay'));
        break;
      } catch (error) {
        if (retryableTopologyTransaction(error) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        // Keep the full accepted event for repair. Never acknowledge a failed
        // canonical/layout transaction; safe error metadata carries no payload.
        await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
          WITH rotated AS (
            UPDATE topology_site_state SET updated_at=now()
            WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid RETURNING site_id
          )
          UPDATE topology_change_outbox SET attempt_count=attempt_count+1,last_attempt_at=now(),
            next_attempt_at=now()+interval '2 seconds',last_error='replay_failed',updated_at=now()
          WHERE id=(SELECT id FROM topology_change_outbox WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND delivered_at IS NULL ORDER BY source_revision LIMIT 1)
        `), 'topology outbox retry evidence'));
        captureException(error);
        break;
      }
    }
  }
}

function tick(): void {
  if (activeDrain) return;
  activeDrain = runTopologyRepairTick().catch(error => { captureException(error); }).finally(() => { activeDrain = null; });
}

/** DB-backed periodic repair has no Redis enqueue dependency. Like the OAuth
 * revocation retry worker, it recovers on the next tick after infrastructure
 * loss. Only explicitly staged sites are selected; startup never backfills. */
export function initializeTopologyOutboxWorker(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_REPAIR_INTERVAL_MS);
  timer.unref?.();
}

export async function shutdownTopologyOutboxWorker(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  await activeDrain;
}
