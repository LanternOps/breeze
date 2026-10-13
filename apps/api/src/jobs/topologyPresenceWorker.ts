import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  evaluateOrgPresence, PRESENCE_DIRTY_DEBOUNCE_MS, PRESENCE_ORGS_PER_TICK, TOPOLOGY_PRESENCE_INTERVAL_MS,
} from '../services/topology/presenceEvaluator';
import { captureException } from '../services/sentry';

/**
 * Topology presence worker (site location W2, spec S§7.4): an interval tick, same shape as
 * topologyTelemetryMaintenance.ts. Database only, one short system transaction per org; reads never trigger it.
 *
 * Each tick enrols up to PRESENCE_ORGS_PER_TICK orgs and evaluates up to PRESENCE_ORGS_PER_TICK due orgs:
 *  1. Enrols orgs that already hold declarations but have no state row yet (declarations that predate the
 *     read-model migration never fired an invalidation trigger), marking them dirty.
 *  2. Evaluates due orgs: dirty for at least the debounce, or a configured org past its hourly re-evaluation.
 *     `not_configured` orgs are re-checked only when dirty.
 * A failed org is deferred for PRESENCE_FAILURE_BACKOFF_MS (dirty_at in the future) so a persistently failing org can
 * neither retry hot nor crowd healthy orgs' re-evaluations out of the per-tick limit; the error is reported with its org.
 * It never writes devices.site_id.
 */
export type TopologyPresenceTick = { enrolled: number; evaluated: number; busy: number; notConfigured: number; failed: number };

/** How long a failed org waits before its next attempt. */
export const PRESENCE_FAILURE_BACKOFF_MS = 15 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let kick: ReturnType<typeof setTimeout> | null = null;
let active: Promise<unknown> | null = null;

const system = <T>(fn: () => Promise<T>, label: string) => runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export async function runTopologyPresenceTick(now = new Date()): Promise<TopologyPresenceTick> {
  const result: TopologyPresenceTick = { enrolled: 0, evaluated: 0, busy: 0, notConfigured: 0, failed: 0 };
  try {
    const enrolled = await system(() => db.execute<{ org_id: string }>(sql`
      INSERT INTO topology_org_presence_state (org_id, dirty_at)
      SELECT d.org_id, ${now.toISOString()}::timestamptz - make_interval(secs => ${PRESENCE_DIRTY_DEBOUNCE_MS / 1000})
      FROM (SELECT DISTINCT org_id FROM (
              SELECT org_id FROM discovery_profiles WHERE enabled AND cardinality(subnets) > 0
              UNION SELECT org_id FROM network_baselines) declared
            WHERE NOT EXISTS (SELECT 1 FROM topology_org_presence_state s WHERE s.org_id = declared.org_id)
            ORDER BY org_id LIMIT ${PRESENCE_ORGS_PER_TICK}) d
      ON CONFLICT (org_id) DO NOTHING
      RETURNING org_id`), 'topology presence enrolment');
    result.enrolled = enrolled.length;
  } catch (error) {
    captureException(error, undefined, { worker: 'topologyPresence', step: 'enrolment' });
    console.warn('[topology-presence] enrolment failed', error instanceof Error ? error.message : String(error));
  }

  const due = await system(() => db.execute<{ org_id: string }>(sql`
    SELECT org_id FROM topology_org_presence_state
    WHERE (dirty_at IS NOT NULL AND dirty_at <= ${now.toISOString()}::timestamptz - make_interval(secs => ${PRESENCE_DIRTY_DEBOUNCE_MS / 1000}))
       OR (coverage <> 'not_configured' AND (next_evaluation_at IS NULL OR next_evaluation_at <= ${now.toISOString()}::timestamptz))
    ORDER BY dirty_at NULLS LAST, next_evaluation_at NULLS FIRST, org_id
    LIMIT ${PRESENCE_ORGS_PER_TICK}`), 'topology presence due orgs');

  for (const { org_id: orgId } of due) {
    try {
      const outcome = await evaluateOrgPresence(orgId, now);
      if (outcome.status === 'busy') result.busy += 1;
      else if (outcome.status === 'not_configured') result.notConfigured += 1;
      else result.evaluated += 1;
    } catch (error) {
      result.failed += 1;
      captureException(error, undefined, { worker: 'topologyPresence', orgId });
      console.warn('[topology-presence] evaluation failed', { orgId, error: error instanceof Error ? error.message : String(error) });
      try {
        await system(() => db.execute(sql`UPDATE topology_org_presence_state
          SET dirty_at = now() + make_interval(secs => ${PRESENCE_FAILURE_BACKOFF_MS / 1000}), updated_at = now() WHERE org_id = ${orgId}::uuid`),
          'topology presence failure backoff');
      } catch (backoffError) {
        captureException(backoffError);
      }
    }
  }
  if (result.failed > 0) console.warn('[topology-presence] evaluation failures', result);
  return result;
}

function tick() {
  if (!active) active = runTopologyPresenceTick().catch(captureException).finally(() => { active = null; });
}
export function initializeTopologyPresenceWorker(): void {
  if (timer) return;
  timer = setInterval(tick, TOPOLOGY_PRESENCE_INTERVAL_MS); timer.unref?.();
  kick = setTimeout(tick, 45_000); kick.unref?.();
}
export async function shutdownTopologyPresenceWorker(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  if (kick) { clearTimeout(kick); kick = null; }
  await active;
}
