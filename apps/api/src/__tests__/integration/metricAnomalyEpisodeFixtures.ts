import { eq } from 'drizzle-orm';

import { alerts, devices, metricAnomalies, metricAnomalyEpisodes, metricAnomalyIncidents, metricRollups, organizations } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

export const BUCKET_MS = 300_000;

/**
 * Turns ml.anomalies.enabled on for the org. Needed whenever a test runs the
 * detector and expects a `cleared` close: with the flag off W01 closes every
 * open episode as `detection_off` instead (second quorum A5).
 */
export async function enableAnomalyDetection(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ settings: { 'ml.anomalies.enabled': true } })
    .where(eq(organizations.id, orgId));
}

export async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  return { partner, org, site, user };
}

let deviceCounter = 0;
export async function insertEpisodeDevice(orgId: string, siteId: string, lastSeenAt: Date = new Date()): Promise<string> {
  deviceCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `episode-w02-${Date.now()}-${deviceCounter}`,
      hostname: `episode-w02-${deviceCounter}`,
      displayName: `episode-w02-${deviceCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
      lastSeenAt,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertEpisodeDevice returned no row');
  return row.id;
}

export interface SeedEpisodeOptions {
  orgId: string;
  deviceId: string;
  memberCount: number;
  /** window_start of the first member; members are 5 minutes apart. */
  start: Date;
  metricName?: string;
  metricFamily?: string;
  anomalyType?: string;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  status?: 'open' | 'resolved' | 'dismissed';
  closeReason?: 'cleared' | 'expired_offline' | 'expired_no_data' | 'detection_off' | 'user' | 'snoozed' | null;
  resolvedAt?: Date | null;
  snoozedUntil?: Date | null;
  linkedAlertId?: string | null;
  memberStatus?: 'open' | 'promoted' | 'dismissed' | 'resolved' | 'cleared';
}

/** Inserts one episode plus `memberCount` member rows. The last member has the highest score (the peak). */
export async function seedEpisode(o: SeedEpisodeOptions): Promise<{ episodeId: string; memberIds: string[]; peakMemberId: string }> {
  const metricName = o.metricName ?? 'disk_write_bps';
  const metricFamily = o.metricFamily ?? 'disk_write';
  const anomalyType = o.anomalyType ?? 'spike';
  const sourceTable = o.sourceTable ?? 'device_metrics';
  const status = o.status ?? 'open';
  const lastSeenAt = new Date(o.start.getTime() + o.memberCount * BUCKET_MS);
  const peakAt = new Date(o.start.getTime() + (o.memberCount - 1) * BUCKET_MS);
  const [episode] = await getTestDb()
    .insert(metricAnomalyEpisodes)
    .values({
      orgId: o.orgId,
      deviceId: o.deviceId,
      episodeKey: `${sourceTable}:${anomalyType}:${metricFamily}`,
      sourceTable,
      anomalyType,
      metricFamily,
      metricNames: [metricName],
      status,
      closeReason: status === 'open' ? null : (o.closeReason ?? 'user'),
      firstSeenAt: o.start,
      lastSeenAt,
      bucketCount: o.memberCount,
      peakValue: 80 + o.memberCount * 4,
      peakMetricName: metricName,
      peakBaselineValue: 6,
      peakScore: 5 + o.memberCount,
      peakAt,
      linkedAlertId: o.linkedAlertId ?? null,
      snoozedUntil: o.snoozedUntil ?? null,
      resolvedAt: status === 'open' ? null : (o.resolvedAt ?? new Date()),
    })
    .returning({ id: metricAnomalyEpisodes.id });
  if (!episode) throw new Error('seedEpisode returned no episode');

  const memberIds: string[] = [];
  for (let i = 0; i < o.memberCount; i++) {
    const windowStart = new Date(o.start.getTime() + i * BUCKET_MS);
    const [member] = await getTestDb()
      .insert(metricAnomalies)
      .values({
        orgId: o.orgId,
        deviceId: o.deviceId,
        sourceTable,
        metricType: 'system',
        metricName,
        anomalyType,
        status: o.memberStatus ?? 'open',
        windowStart,
        windowEnd: new Date(windowStart.getTime() + BUCKET_MS),
        bucketSeconds: 300,
        observedValue: 84 + i * 4,
        baselineValue: 6,
        baselineMin: 2,
        baselineMax: 11,
        score: 5 + i + 1,
        confidence: 0.8,
        sampleCount: 3,
        linkedAlertId: o.memberStatus === 'promoted' ? (o.linkedAlertId ?? null) : null,
        episodeId: episode.id,
      })
      .returning({ id: metricAnomalies.id });
    if (!member) throw new Error('seedEpisode returned no member');
    memberIds.push(member.id);
  }
  return { episodeId: episode.id, memberIds, peakMemberId: memberIds[memberIds.length - 1]! };
}

export async function seedAlert(o: { orgId: string; deviceId: string; requiresHuman?: boolean; status?: 'active' | 'resolved' }): Promise<string> {
  const [row] = await getTestDb()
    .insert(alerts)
    .values({
      ruleId: null,
      orgId: o.orgId,
      deviceId: o.deviceId,
      status: o.status ?? 'active',
      severity: 'high',
      title: 'Metric anomaly promoted: spike on disk_write_bps',
      message: 'seeded by metricAnomalyEpisodeFixtures',
      context: { source: 'metric_anomaly' },
      requiresHuman: o.requiresHuman ?? false,
      triggeredAt: new Date(),
    })
    .returning({ id: alerts.id });
  if (!row) throw new Error('seedAlert returned no row');
  return row.id;
}

export async function seedIncident(o: {
  orgId: string;
  deviceId: string;
  episodeId: string | null;
  windowStart: Date;
  anomalyType?: string;
  createdAt?: Date;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(metricAnomalyIncidents)
    .values({
      orgId: o.orgId,
      deviceId: o.deviceId,
      anomalyType: o.anomalyType ?? 'spike',
      bucketSeconds: 300,
      windowStart: o.windowStart,
      firstSeenAt: o.windowStart,
      lastSeenAt: o.windowStart,
      peakScore: '7',
      rowCount: 1,
      metricNames: ['disk_write_bps'],
      episodeId: o.episodeId,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning({ id: metricAnomalyIncidents.id });
  if (!row) throw new Error('seedIncident returned no row');
  return row.id;
}

/** `count` clean 5-min rollup buckets with samples, starting at `from` (spec §7 clean predicate). */
export async function insertCleanRollups(o: {
  orgId: string;
  deviceId: string;
  metricName: string;
  from: Date;
  count: number;
  sourceTable?: 'device_metrics' | 'device_process_samples';
}): Promise<void> {
  for (let i = 0; i < o.count; i++) {
    await getTestDb().insert(metricRollups).values({
      orgId: o.orgId,
      sourceTable: o.sourceTable ?? 'device_metrics',
      deviceId: o.deviceId,
      metricType: 'system',
      metricName: o.metricName,
      bucketStart: new Date(o.from.getTime() + i * BUCKET_MS),
      bucketSeconds: 300,
      avgValue: 6,
      minValue: 6,
      maxValue: 6,
      p95Value: 6,
      sumValue: 6,
      sampleCount: 1,
      gapSeconds: 0,
      metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
    });
  }
}
