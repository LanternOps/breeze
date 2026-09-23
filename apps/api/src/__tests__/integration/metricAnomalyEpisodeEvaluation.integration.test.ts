import './setup';

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { devices, metricAnomalies, metricAnomalyEpisodes, mlFeedbackEvents, alerts } from '../../db/schema';
import { analyticsRoutes } from '../../routes/analytics';
import { emitAnomalyEpisodeFeedback } from '../../services/mlFeedbackEmitters';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: '99999999-9999-4999-8999-999999999999',
    currentPartnerId: null,
  };
}

/**
 * W03 integration proof, adapted for the parallel-wave dispatch: W02 (the
 * `applyEpisodeAction` resolve/dismiss route and its
 * `metricAnomalyEpisodeFixtures.ts` fixtures) is not on `main` yet, so this
 * file seeds `metric_anomalies` / `metric_anomaly_episodes` /
 * `ml_feedback_events` rows directly (superuser test connection, bypasses
 * RLS) rather than driving them through the episode action HTTP route or
 * W02's fixtures. It proves the two behaviours this wave owns end to end:
 * cleared never raises dismissRate, and humanLabelledShare (A8). It also
 * proves emitAnomalyEpisodeFeedback (Task 3) writes a real row and that the
 * evaluation endpoint's `feedback` block (sourceType 'anomaly' only) does not
 * count it — the wiring of this emitter into an actual resolve/dismiss
 * request is deferred to W02 (see PR description).
 */

let agentIdCounter = 0;

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  agentIdCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `w03-eval-test-${Date.now()}-${agentIdCounter}`,
      hostname: `w03-eval-host-${agentIdCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

let anomalyKeyCounter = 0;

/** Seeds N per-bucket metric_anomalies rows sharing one metric/window family. */
async function insertMemberAnomalies(options: {
  orgId: string;
  deviceId: string;
  count: number;
  status: 'open' | 'dismissed' | 'promoted' | 'resolved' | 'cleared';
  metricName?: string;
}): Promise<string[]> {
  const rows: Array<typeof metricAnomalies.$inferInsert> = [];
  for (let i = 0; i < options.count; i++) {
    anomalyKeyCounter++;
    const windowStart = new Date(Date.now() - (options.count - i) * 5 * 60_000);
    rows.push({
      orgId: options.orgId,
      deviceId: options.deviceId,
      sourceTable: 'device_metrics',
      metricType: 'cpu',
      metricName: options.metricName ?? 'cpu_percent',
      anomalyType: 'spike',
      status: options.status,
      windowStart,
      windowEnd: new Date(windowStart.getTime() + 5 * 60_000),
      bucketSeconds: 300,
      observedValue: 95,
      score: 3,
      confidence: 0.9,
      detectedAt: windowStart,
    });
  }
  const inserted = await getTestDb().insert(metricAnomalies).values(rows).returning({ id: metricAnomalies.id });
  return inserted.map((r) => r.id);
}

async function insertEpisode(options: {
  orgId: string;
  deviceId: string;
  status: 'open' | 'resolved' | 'dismissed';
  closeReason?: 'cleared' | 'expired_offline' | 'expired_no_data' | 'detection_off' | 'user' | 'snoozed' | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt?: Date | null;
  recurrenceCount?: number;
  linkedAlertId?: string | null;
  metricFamily?: string;
}): Promise<string> {
  anomalyKeyCounter++;
  const [row] = await getTestDb()
    .insert(metricAnomalyEpisodes)
    .values({
      orgId: options.orgId,
      deviceId: options.deviceId,
      episodeKey: `device_metrics:spike:${options.metricFamily ?? 'cpu'}:${anomalyKeyCounter}`,
      sourceTable: 'device_metrics',
      anomalyType: 'spike',
      metricFamily: options.metricFamily ?? 'cpu',
      metricNames: [options.metricFamily === 'ram' ? 'ram_percent' : options.metricFamily === 'disk' ? 'disk_write_bps' : 'cpu_percent'],
      status: options.status,
      closeReason: options.closeReason ?? null,
      firstSeenAt: options.firstSeenAt,
      lastSeenAt: options.lastSeenAt,
      bucketCount: 1,
      peakValue: 95,
      peakMetricName: options.metricFamily === 'ram' ? 'ram_percent' : options.metricFamily === 'disk' ? 'disk_write_bps' : 'cpu_percent',
      peakScore: 3,
      peakAt: options.lastSeenAt,
      recurrenceCount: options.recurrenceCount ?? 0,
      linkedAlertId: options.linkedAlertId ?? null,
      resolvedAt: options.resolvedAt ?? null,
    })
    .returning({ id: metricAnomalyEpisodes.id });
  if (!row) throw new Error('insertEpisode returned no row');
  return row.id;
}

async function insertAlert(orgId: string, deviceId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(alerts)
    .values({
      orgId,
      deviceId,
      status: 'active',
      severity: 'medium',
      title: 'W03 eval test alert',
    })
    .returning({ id: alerts.id });
  if (!row) throw new Error('insertAlert returned no row');
  return row.id;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/analytics', analyticsRoutes);
  return app;
}

const HOUR = 3_600_000;

describe('anomaly episode evaluation (W03)', () => {
  it('emitAnomalyEpisodeFeedback writes one anomaly_episode row that the feedback block never counts', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertDevice(orgId, client.env.site.id);

    // Simulate what a resolve/dismiss action would do (W02, not yet wired):
    // per-member anomaly.dismissed feedback rows plus one episode-level row.
    const memberIds = await insertMemberAnomalies({ orgId, deviceId, count: 5, status: 'dismissed' });
    for (const anomalyId of memberIds) {
      await getTestDb().insert(mlFeedbackEvents).values({
        orgId,
        sourceType: 'anomaly',
        sourceId: anomalyId,
        eventType: 'anomaly.dismissed',
        outcome: 'dismissed',
        occurredAt: new Date(),
      });
    }
    const episodeId = await insertEpisode({
      orgId,
      deviceId,
      status: 'dismissed',
      closeReason: 'user',
      firstSeenAt: new Date(Date.now() - 2 * HOUR),
      lastSeenAt: new Date(Date.now() - HOUR),
    });
    const inserted = await withDbAccessContext(orgContext(orgId), () =>
      emitAnomalyEpisodeFeedback({
        orgId,
        episodeId,
        eventType: 'anomaly_episode.dismissed',
        outcome: 'dismissed',
        occurredAt: new Date(),
        metadata: { memberCount: 5 },
      }),
    );
    expect(inserted).toBe(1);

    const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
    expect(res.status).toBe(200);
    const body = await res.json();

    // feedback counts sourceType 'anomaly' only — the episode-level row must
    // not leak into it.
    expect(body.feedback.total).toBe(5);
    expect(body.feedback.dismissed).toBe(5);
    expect(body.episodes.byStatus.dismissed).toBe(1);
    expect(body.episodes.byCloseReason.user).toBe(1);

    const episodeRows = await getTestDb().select().from(mlFeedbackEvents).where(and(
      eq(mlFeedbackEvents.sourceType, 'anomaly_episode'),
      eq(mlFeedbackEvents.sourceId, episodeId),
    ));
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]!.eventType).toBe('anomaly_episode.dismissed');
  });

  it('auto-resolved (cleared) members leave the human-label denominator and never raise dismissRate', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertDevice(orgId, client.env.site.id);

    await insertMemberAnomalies({ orgId, deviceId, count: 6, status: 'cleared' });
    await insertEpisode({
      orgId,
      deviceId,
      status: 'resolved',
      closeReason: 'cleared',
      firstSeenAt: new Date(Date.now() - 3 * HOUR),
      lastSeenAt: new Date(Date.now() - 2 * HOUR),
      resolvedAt: new Date(Date.now() - HOUR),
    });

    const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status.cleared).toBe(6);
    expect(body.total).toBe(0); // cleared is excluded from `total`, the human-label denominator
    expect(body.rates.dismissRate).toBe(0);
    expect(body.episodes.byCloseReason.cleared).toBe(1);
    expect(body.episodes.humanLabelledShare).toBe(0);
  });

  it('humanLabelledShare counts promoted episodes as labelled and leaves snoozed successors out of the denominator (A8)', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertDevice(orgId, client.env.site.id);
    const alertId = await insertAlert(orgId, deviceId);
    const start = new Date(Date.now() - 6 * HOUR);
    const mid = new Date(Date.now() - 5 * HOUR);

    // Promoted, then auto-cleared: a human looked at it -> labelled (via linkedAlertId).
    await insertEpisode({
      orgId, deviceId, status: 'resolved', closeReason: 'cleared',
      firstSeenAt: start, lastSeenAt: mid, resolvedAt: new Date(Date.now() - 4 * HOUR),
      linkedAlertId: alertId, metricFamily: 'cpu',
    });
    // Auto-cleared, nobody looked: in the denominator only.
    await insertEpisode({
      orgId, deviceId, status: 'resolved', closeReason: 'cleared',
      firstSeenAt: start, lastSeenAt: mid, resolvedAt: new Date(Date.now() - 4 * HOUR),
      metricFamily: 'ram',
    });
    // A human clicked Dismiss directly -> labelled (via close_reason 'user', no
    // linked alert). Proves the OTHER half of the humanLabelled OR-condition —
    // the linkedAlertId episode above only proves the first half.
    // recurrenceCount 1 also feeds the recurrenceShare assertion below.
    await insertEpisode({
      orgId, deviceId, status: 'dismissed', closeReason: 'user',
      firstSeenAt: start, lastSeenAt: mid, resolvedAt: new Date(Date.now() - 5 * HOUR),
      recurrenceCount: 1, metricFamily: 'disk',
    });
    // Snoozed successor: neither, and has no resolvedAt (never a new episode
    // "closing" in the human sense) so it must not skew medianDurationSeconds.
    await insertEpisode({
      orgId, deviceId, status: 'dismissed', closeReason: 'snoozed',
      firstSeenAt: start, lastSeenAt: mid,
      metricFamily: 'network',
    });

    const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
    expect(res.status).toBe(200);
    const body = await res.json();

    // 2 labelled (promoted-via-alert + human-dismissed) / 3 eligible (both
    // clears + the human dismiss; snoozed excluded). The pre-A8 formula
    // (close_reason 'user' / all closed) would have given 1 / 4.
    expect(body.episodes.humanLabelledShare).toBe(2 / 3);
    expect(body.episodes.byCloseReason).toMatchObject({ cleared: 2, snoozed: 1, user: 1 });
    expect(body.episodes.byStatus).toMatchObject({ resolved: 2, dismissed: 2 });
    // 1 of 4 episodes recurred.
    expect(body.episodes.recurrenceShare).toBe(0.25);
    // Three episodes closed with a resolvedAt: two at 2h (7200s), one at 1h
    // (3600s) after firstSeenAt — sorted [3600, 7200, 7200], median 7200. The
    // snoozed successor (no resolvedAt) must not be counted or shift this.
    expect(body.episodes.medianDurationSeconds).toBe(7200);
  });
});
