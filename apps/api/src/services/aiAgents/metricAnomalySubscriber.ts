/**
 * Durable anomaly-triggered admission subscriber (wave 6 PR 4, #3828 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-4-anomaly-pilot.md
 * Task 3).
 *
 * Registered on the durable `eventSubscriberRegistry` under id
 * `ai-agent-anomaly` (`eventSubscribers.ts`), subscribed to
 * `anomaly.incident_opened` ONLY — the id-only event Task 2's
 * `metricAnomalyIncidentPublisher.ts` drains the `metric_anomaly_incidents`
 * dispatch marker onto.
 *
 * Admission itself is delegated entirely to `createAndEnqueueAgentRun`
 * (runService.ts) — kill switch, circuit breaker, dedupe, concurrency/rate/
 * budget caps, device pinning, trigger filters, and the forced
 * `modeAtStart: 'shadow'` for `triggerKind: 'anomaly'` all live there.
 * `createAndEnqueueAgentRun` manages its own DB access and deliberately
 * performs its announce+enqueue step OUTSIDE any system DB context (#1105
 * pool-hold-across-Redis) — this module MUST call it with no system context
 * active, or that protection is silently defeated by non-re-entrant nesting
 * (see `ticketHelpdeskSubscriber.ts`'s identical header comment for the full
 * account; this module is a direct structural clone). Only the three reads
 * below run inside a system context.
 *
 * This module's own job is narrow:
 *
 *  1. Extract `incidentId`/`deviceId` from the id-only event payload.
 *  2. Load the canonical incident row (org-pinned) — `anomalyType`,
 *     `metricNames`, `peakScore` all live on this ONE row already (Task 2's
 *     detector upsert keeps them current), so no separate read of sibling
 *     `metric_anomalies` rows is needed for trigger-filter context.
 *  3. Load the incident's device (org-pinned) for the site/tag trigger
 *     filters `evaluateAnomalyTriggerFilters` (runService.ts) applies —
 *     same shape `automationRuntime.ts`'s `executeAiTriageAction` builds for
 *     an alert trigger.
 *  4. Cross-dedupe lookup: query the sibling `metric_anomalies` rows sharing
 *     this incident's collapsing key (`org_id, device_id, anomaly_type,
 *     bucket_seconds, window_start` — the SAME key `metricAnomalyPromotion.
 *     ts`'s `findDedupeSiblings` groups on, `metric_name` excluded) for a
 *     non-null `linked_alert_id`. If one is already promoted to an alert,
 *     the dedupe key becomes `alert:<linkedAlertId>` — colliding on the
 *     SAME `(org_id, dedupe_key)` unique index the alert-triage path uses
 *     (`automationRuntime.ts`'s `dedupeKey: alert:${alertId}`), so an
 *     anomaly whose incident was already promoted (or gets promoted first)
 *     never produces a second, independent agent run for the same event.
 *     Otherwise the dedupe key is `anomaly:<incidentId>`.
 *  5. Call `createAndEnqueueAgentRun` with `kind: 'triage'` (v1 scope — the
 *     only agent kind that accepts an anomaly trigger), `triggerKind:
 *     'anomaly'`, the incident's `deviceId`, `anomalyIncidentId`, and
 *     `anomalyContext`.
 *  6. On successful admission, best-effort stamp `incident.agent_run_id`
 *     (system ctx, swallow-and-log on failure — this is bookkeeping for
 *     `metricAnomalyPromotion.ts`'s informational linkage read, never load-
 *     bearing for admission correctness).
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import * as dbModule from '../../db';
import { devices } from '../../db/schema/devices';
import { metricAnomalies } from '../../db/schema/analytics';
import { metricAnomalyIncidents, type MetricAnomalyIncidentRow } from '../../db/schema/metricAnomalyIncidents';
import type { BreezeEvent } from '../eventBus';
import { createAndEnqueueAgentRun } from './runService';

// #1105 pool-hold seam — identical discipline and identical rationale to
// `ticketHelpdeskSubscriber.ts`'s `runWithSystemDbAccess`: only the three
// reads below run under a system context; `createAndEnqueueAgentRun` (and
// the best-effort agent_run_id stamp) must run with NO system context
// active. See that module's header comment for the full account of why a
// wrapping-the-whole-handler shape would silently defeat the protection.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/**
 * Org-pinned canonical incident lookup. `null` means the incident is not (or
 * no longer) in this org — same "moved/deleted reads as absent" posture used
 * throughout this wave.
 */
async function loadIncident(incidentId: string, orgId: string): Promise<MetricAnomalyIncidentRow | null> {
  const { db } = dbModule;
  const [row] = await db
    .select()
    .from(metricAnomalyIncidents)
    .where(and(eq(metricAnomalyIncidents.id, incidentId), eq(metricAnomalyIncidents.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Site/tag context for `evaluateAnomalyTriggerFilters`'s device-bound
 * filters. Org-pinned (same reasoning as `loadIncident` — this read runs
 * under a system db context, which bypasses RLS). `null` means the device is
 * not (or no longer) in this org.
 */
async function loadDeviceFilterContext(
  deviceId: string,
  orgId: string,
): Promise<{ siteId: string | null; tags: string[] } | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ siteId: devices.siteId, tags: devices.tags })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  return { siteId: row.siteId, tags: row.tags ?? [] };
}

/**
 * Cross-dedupe probe (see this module's header, point 4): does ANY sibling
 * `metric_anomalies` row in this incident's collapsing key already carry a
 * `linked_alert_id`? Org-pinned for the same reason as the two reads above.
 */
async function findLinkedAlertId(incident: MetricAnomalyIncidentRow): Promise<string | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ linkedAlertId: metricAnomalies.linkedAlertId })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, incident.orgId),
      eq(metricAnomalies.deviceId, incident.deviceId),
      eq(metricAnomalies.anomalyType, incident.anomalyType),
      eq(metricAnomalies.bucketSeconds, incident.bucketSeconds),
      eq(metricAnomalies.windowStart, incident.windowStart),
      isNotNull(metricAnomalies.linkedAlertId),
    ))
    .limit(1);
  return row?.linkedAlertId ?? null;
}

/** Best-effort — see this module's header, point 6. Never thrown to the caller. */
async function stampIncidentAgentRunId(incidentId: string, orgId: string, agentRunId: string): Promise<void> {
  const { db } = dbModule;
  await db
    .update(metricAnomalyIncidents)
    .set({ agentRunId })
    .where(and(eq(metricAnomalyIncidents.id, incidentId), eq(metricAnomalyIncidents.orgId, orgId)));
}

/**
 * Registered handler for `anomaly.incident_opened` (`eventSubscribers.ts`).
 * MUST throw on failure — queue-mode dispatch (#4085) retries on a thrown
 * rejection; local delivery's wrapper provides the swallow-and-log semantics
 * a handler-level try/catch used to. A malformed event (missing incidentId/
 * deviceId) is NOT retryable — it is logged and dropped, never thrown, since
 * no redelivery of the same malformed payload would ever succeed.
 */
export async function handleAnomalyIncidentOpenedEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { incidentId?: unknown; deviceId?: unknown } | null | undefined;
  const incidentId = typeof payload?.incidentId === 'string' ? payload.incidentId : null;
  const eventDeviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : null;
  const orgId = event.orgId;

  if (!incidentId || !eventDeviceId || !orgId) {
    console.error(
      '[metricAnomalySubscriber] malformed anomaly.incident_opened event — missing incidentId/deviceId/orgId, dropping',
      { eventId: event.id, orgId, payload: event.payload },
    );
    return;
  }

  try {
    // Only these three reads run under a system context — see
    // `runWithSystemDbAccess`'s header comment (#1105 pool-hold seam).
    const incident = await runWithSystemDbAccess(() => loadIncident(incidentId, orgId));
    if (!incident) {
      console.info(
        '[metricAnomalySubscriber] skipping admission — incident not found (or not in org)',
        { incidentId, orgId },
      );
      return;
    }

    const deviceCtx = await runWithSystemDbAccess(() => loadDeviceFilterContext(incident.deviceId, orgId));
    if (!deviceCtx) {
      console.info(
        '[metricAnomalySubscriber] skipping admission — device not found (or not in org)',
        { incidentId, deviceId: incident.deviceId, orgId },
      );
      return;
    }

    const linkedAlertId = await runWithSystemDbAccess(() => findLinkedAlertId(incident));
    const dedupeKey = linkedAlertId ? `alert:${linkedAlertId}` : `anomaly:${incident.id}`;

    // Called with NO system DB context active — `createAndEnqueueAgentRun`
    // manages its own (see this module's header).
    const result = await createAndEnqueueAgentRun({
      orgId,
      kind: 'triage',
      triggerKind: 'anomaly',
      deviceId: incident.deviceId,
      anomalyIncidentId: incident.id,
      anomalyContext: {
        anomalyType: incident.anomalyType,
        metricNames: incident.metricNames,
        peakScore: Number(incident.peakScore),
        siteId: deviceCtx.siteId,
        deviceTags: deviceCtx.tags,
      },
      triggerRef: { incidentId: incident.id },
      dedupeKey,
    });

    if (result.created) {
      await runWithSystemDbAccess(() => stampIncidentAgentRunId(incident.id, orgId, result.run.id)).catch(
        (err: unknown) => {
          console.error('[metricAnomalySubscriber] failed to stamp agent_run_id on incident (best-effort)', {
            incidentId: incident.id,
            orgId,
            runId: result.run.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    } else {
      console.info('[metricAnomalySubscriber] admission skipped', {
        incidentId: incident.id,
        orgId,
        reason: result.skipped,
      });
    }
  } catch (err) {
    console.error('[metricAnomalySubscriber] handler failed', {
      incidentId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
