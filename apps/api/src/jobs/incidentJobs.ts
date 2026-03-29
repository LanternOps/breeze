import { and, eq, lt, ne, or, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { incidents, type IncidentTimelineEntry } from '../db/schema';
import { publishEvent } from '../services/eventBus';
import { captureException } from '../services/sentry';

const { db } = dbModule;

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[IncidentJobs] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const CORRELATION_INTERVAL_MS = Number(process.env.INCIDENT_CORRELATION_INTERVAL_MS ?? 2 * 60 * 1000);
const TIMELINE_ENRICH_INTERVAL_MS = Number(process.env.INCIDENT_TIMELINE_ENRICH_INTERVAL_MS ?? 5 * 60 * 1000);
const SLA_MONITOR_INTERVAL_MS = Number(process.env.INCIDENT_SLA_MONITOR_INTERVAL_MS ?? 60 * 1000);
const P1_ESCALATION_MINUTES = Number(process.env.INCIDENT_SLA_P1_MINUTES ?? 15);
const P2_ESCALATION_MINUTES = Number(process.env.INCIDENT_SLA_P2_MINUTES ?? 60);

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
    const rows = await db
      .select({
        id: incidents.id,
        status: incidents.status,
        timeline: incidents.timeline,
      })
      .from(incidents)
      .where(
        and(
          ne(incidents.status, 'closed'),
          sql`jsonb_array_length(${incidents.timeline}) = 0`
        )
      )
      .limit(100);

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
          or(
            and(eq(incidents.severity, 'p1'), lt(incidents.detectedAt, staleP1At)),
            and(eq(incidents.severity, 'p2'), lt(incidents.detectedAt, staleP2At))
          )
        )
      )
      .limit(100);

    for (const row of staleIncidents) {
      const timeline = toTimeline(row.timeline);
      const alreadyEscalated = timeline.some((entry) => entry.type === 'incident_escalated');
      if (alreadyEscalated) {
        continue;
      }

      const escalationAt = new Date();
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
        console.error('[IncidentJobs] Failed to publish incident.escalated event:', error);
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
