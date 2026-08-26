import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { incidents, type IncidentTimelineEntry } from '../db/schema';
import { publishEvent } from '../services/eventBus';
import { captureException } from '../services/sentry';
import { envInt } from '../utils/envInt';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[IncidentJobs] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const CORRELATION_INTERVAL_MS = envInt('INCIDENT_CORRELATION_INTERVAL_MS', 2 * 60 * 1000);
const TIMELINE_ENRICH_INTERVAL_MS = envInt('INCIDENT_TIMELINE_ENRICH_INTERVAL_MS', 5 * 60 * 1000);
const SLA_MONITOR_INTERVAL_MS = envInt('INCIDENT_SLA_MONITOR_INTERVAL_MS', 60 * 1000);
const P1_ESCALATION_MINUTES = envInt('INCIDENT_SLA_P1_MINUTES', 15);
const P2_ESCALATION_MINUTES = envInt('INCIDENT_SLA_P2_MINUTES', 60);

let correlationTimer: ReturnType<typeof setInterval> | null = null;
let timelineEnricherTimer: ReturnType<typeof setInterval> | null = null;
let slaMonitorTimer: ReturnType<typeof setInterval> | null = null;
const correlationPassState = { running: false };
const timelinePassState = { running: false };
const slaPassState = { running: false };

async function runExclusivePass(
  name: string,
  state: { running: boolean },
  pass: () => Promise<void>
): Promise<void> {
  if (state.running) {
    console.warn(`[IncidentJobs] Skipping ${name} pass because a prior run is still active`);
    return;
  }

  state.running = true;
  try {
    await pass();
  } finally {
    state.running = false;
  }
}

/**
 * The two cross-process winner predicates, extracted so tests can assert the
 * COMPILED SQL. A mocked-drizzle assertion can only substring-match column
 * names, which cannot tell `and` from `or`, cannot notice a dropped `id`
 * predicate, and cannot see the `FOR UPDATE SKIP LOCKED` tail at all — every
 * one of those mutations passed green before these existed, and each turns a
 * per-incident claim into a fleet-wide one.
 */
export function buildEscalationCas(incidentId: string) {
  return and(eq(incidents.id, incidentId), isNull(incidents.escalatedAt));
}

/** Rows the enricher is allowed to claim: open, and not already claimed. */
export function buildEnrichmentClaimScope() {
  return and(ne(incidents.status, 'closed'), isNull(incidents.timelineEnrichedAt));
}

function toTimeline(value: unknown): IncidentTimelineEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as IncidentTimelineEntry[];
}

async function runIncidentCorrelationPass(): Promise<void> {
  await runWithSystemDbAccess(async () => {
    // Placeholder correlation hook for BE-32 Phase 2.
    // Creates a heartbeat log so we can validate worker lifecycle wiring.
    const totals = await db
      .select({ total: sql<number>`count(*)` })
      .from(incidents)
      .where(ne(incidents.status, 'closed'));

    console.log(`[IncidentJobs] correlation pass scanned ${Number(totals[0]?.total ?? 0)} open incidents`);
  });
}

async function runIncidentTimelineEnrichmentPass(): Promise<void> {
  await runWithSystemDbAccess(async () => {
    // Claim-then-work. Selecting un-enriched incidents and updating them by id
    // lets a second process select the SAME rows before either marks them —
    // check-then-act, and both would append a timeline_enriched entry.
    //
    // The claim is the marker column, not the timeline array: appending to a
    // jsonb array cannot be made atomic with a predicate, and `timeline` is the
    // rendering surface. `FOR UPDATE SKIP LOCKED` is the established idiom here
    // (jobs/oauthRevocationRetryWorker.ts).
    const rows = await db
      .update(incidents)
      .set({ timelineEnrichedAt: new Date() })
      .where(
        inArray(
          incidents.id,
          db
            .select({ id: incidents.id })
            .from(incidents)
            .where(buildEnrichmentClaimScope())
            .limit(100)
            .for('update', { skipLocked: true })
        )
      )
      .returning({
        id: incidents.id,
        status: incidents.status,
        timeline: incidents.timeline,
      });

    if (rows.length === 0) {
      return;
    }

    const now = new Date();
    for (const row of rows) {
      const nextTimeline = [
        ...toTimeline(row.timeline),
        {
          at: now.toISOString(),
          type: 'timeline_enriched',
          actor: 'system',
          summary: 'Added baseline timeline context for open incident',
          metadata: { status: row.status },
        } satisfies IncidentTimelineEntry,
      ];

      await db
        .update(incidents)
        .set({
          timeline: nextTimeline,
          updatedAt: now,
        })
        .where(eq(incidents.id, row.id));
    }

    console.log(`[IncidentJobs] timeline enricher updated ${rows.length} incidents`);
  });
}

async function runIncidentSlaMonitorPass(): Promise<void> {
  await runWithSystemDbAccess(async () => {
    const now = new Date();
    const staleP1At = new Date(now.getTime() - P1_ESCALATION_MINUTES * 60_000);
    const staleP2At = new Date(now.getTime() - P2_ESCALATION_MINUTES * 60_000);

    const staleIncidents = await db
      .select({
        id: incidents.id,
        orgId: incidents.orgId,
        title: incidents.title,
        status: incidents.status,
        severity: incidents.severity,
        detectedAt: incidents.detectedAt,
        timeline: incidents.timeline,
      })
      .from(incidents)
      .where(
        and(
          ne(incidents.status, 'closed'),
          // Exclude rows already escalated. Without this the LIMIT 100 window
          // fills with incidents that lose the CAS on every pass — they are
          // never re-paged (the CAS sees to that), but they permanently occupy
          // the scan budget, so a NEW breach beyond the hundredth stale row is
          // never looked at. This is also what makes incidents_unescalated_idx
          // (2026-09-11-b) an index the query planner can actually use.
          isNull(incidents.escalatedAt),
          or(
            and(eq(incidents.severity, 'p1'), lt(incidents.detectedAt, staleP1At)),
            and(eq(incidents.severity, 'p2'), lt(incidents.detectedAt, staleP2At))
          )
        )
      )
      .limit(100);

    for (const row of staleIncidents) {
      const escalationAt = new Date();

      // The UPDATE is the lock. `alreadyEscalated` computed from the array this
      // process just read is per-process belief, not a fact: two processes both
      // read an un-escalated timeline and both publish incident.escalated,
      // paging on-call twice for one breach.
      const [won] = await db
        .update(incidents)
        .set({ escalatedAt: escalationAt })
        .where(buildEscalationCas(row.id))
        .returning({ id: incidents.id });

      if (!won) {
        continue;
      }

      const timeline = toTimeline(row.timeline);
      const nextTimeline = [
        ...timeline,
        {
          at: escalationAt.toISOString(),
          type: 'incident_escalated',
          actor: 'system',
          summary: 'Incident exceeded configured SLA threshold',
          metadata: {
            severity: row.severity,
            status: row.status,
            detectedAt: row.detectedAt.toISOString(),
          },
        } satisfies IncidentTimelineEntry,
      ];

      await db
        .update(incidents)
        .set({
          timeline: nextTimeline,
          updatedAt: escalationAt,
        })
        .where(eq(incidents.id, row.id));

      try {
        await publishEvent(
          'incident.escalated',
          row.orgId,
          {
            incidentId: row.id,
            severity: row.severity,
            status: row.status,
            detectedAt: row.detectedAt.toISOString(),
            title: row.title,
          },
          'incident-sla-monitor'
        );
      } catch (error) {
        // Un-claim, or this breach is NEVER paged. `escalated_at` is now the
        // sole gate (line ~183), so a swallowed publish would leave the row
        // claimed forever while no incident.escalated ever reached anyone —
        // the timeline would read "exceeded SLA threshold" and on-call would
        // hear nothing. Releasing the marker lets the next pass (60s) retry.
        //
        // Scoped to `escalationAt` so we only release the claim THIS iteration
        // took: if a concurrent pass has since re-claimed the row, its marker
        // differs and we leave it alone.
        try {
          await db
            .update(incidents)
            .set({ escalatedAt: null })
            .where(and(eq(incidents.id, row.id), eq(incidents.escalatedAt, escalationAt)));
        } catch (releaseError) {
          captureException(releaseError instanceof Error ? releaseError : new Error(String(releaseError)));
        }
        // captureException as well as the log: a dropped page is the failure
        // this codebase treats as worse than a duplicate one, and pass-level
        // failures already reach Sentry while this one never did.
        captureException(error instanceof Error ? error : new Error(String(error)));
        console.error('[IncidentJobs] incident-escalation-publish-failed', JSON.stringify({
          errorId: 'INCIDENT_ESCALATION_PUBLISH_FAILED',
          incidentId: row.id,
          orgId: row.orgId,
          severity: row.severity,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    if (staleIncidents.length > 0) {
      console.log(`[IncidentJobs] sla monitor reviewed ${staleIncidents.length} stale incidents`);
    }
  });
}

export async function initializeIncidentCorrelationWorker(): Promise<void> {
  if (correlationTimer) {
    return;
  }
  await runExclusivePass('correlation', correlationPassState, runIncidentCorrelationPass).catch((error) => {
    captureException(error);
    console.error('[IncidentJobs] Correlation pass failed:', error);
  });
  correlationTimer = setInterval(() => {
    void runExclusivePass('correlation', correlationPassState, runIncidentCorrelationPass).catch((error) => {
      captureException(error);
      console.error('[IncidentJobs] Correlation pass failed:', error);
    });
  }, CORRELATION_INTERVAL_MS);
  console.log('[IncidentJobs] incident-correlation-worker initialized');
}

export async function shutdownIncidentCorrelationWorker(): Promise<void> {
  if (correlationTimer) {
    clearInterval(correlationTimer);
    correlationTimer = null;
  }
  correlationPassState.running = false;
}

export async function initializeIncidentTimelineEnricher(): Promise<void> {
  if (timelineEnricherTimer) {
    return;
  }
  await runExclusivePass('timeline-enrichment', timelinePassState, runIncidentTimelineEnrichmentPass).catch((error) => {
    captureException(error);
    console.error('[IncidentJobs] Timeline enrichment pass failed:', error);
  });
  timelineEnricherTimer = setInterval(() => {
    void runExclusivePass('timeline-enrichment', timelinePassState, runIncidentTimelineEnrichmentPass).catch((error) => {
      captureException(error);
      console.error('[IncidentJobs] Timeline enrichment pass failed:', error);
    });
  }, TIMELINE_ENRICH_INTERVAL_MS);
  console.log('[IncidentJobs] incident-timeline-enricher initialized');
}

export async function shutdownIncidentTimelineEnricher(): Promise<void> {
  if (timelineEnricherTimer) {
    clearInterval(timelineEnricherTimer);
    timelineEnricherTimer = null;
  }
  timelinePassState.running = false;
}

export async function initializeIncidentSlaMonitor(): Promise<void> {
  if (slaMonitorTimer) {
    return;
  }
  await runExclusivePass('sla-monitor', slaPassState, runIncidentSlaMonitorPass).catch((error) => {
    captureException(error);
    console.error('[IncidentJobs] SLA monitor pass failed:', error);
  });
  slaMonitorTimer = setInterval(() => {
    void runExclusivePass('sla-monitor', slaPassState, runIncidentSlaMonitorPass).catch((error) => {
      captureException(error);
      console.error('[IncidentJobs] SLA monitor pass failed:', error);
    });
  }, SLA_MONITOR_INTERVAL_MS);
  console.log('[IncidentJobs] incident-sla-monitor initialized');
}

export async function shutdownIncidentSlaMonitor(): Promise<void> {
  if (slaMonitorTimer) {
    clearInterval(slaMonitorTimer);
    slaMonitorTimer = null;
  }
  slaPassState.running = false;
}

/**
 * The two passes that carry cross-process winner logic. Exported for tests
 * only — production drives them through the initialize/shutdown pairs above.
 */
export const __testOnly = {
  runIncidentTimelineEnrichmentPass,
  runIncidentSlaMonitorPass,
};
