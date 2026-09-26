import './setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import {
  deviceProcessSamples,
  devices,
  metricAnomalies,
  metricAnomalyEpisodes,
  metricAnomalyIncidents,
  metricRollups,
  mlFeedbackEvents,
  organizations,
} from '../../db/schema';
import {
  applyEpisodeAssemblyPlan,
  assembleMetricAnomalyEpisodes,
  closeEpisodesForDisabledDetection,
  EPISODE_GAP_MINUTES,
  EPISODE_MIN_BUCKETS,
  loadEpisodeAssemblyInputs,
  resolveMetricAnomalyEpisodes,
  setEpisodeCloseHandler,
  type EpisodeCloseResult,
} from '../../services/metricAnomalyEpisodes';
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import { promoteMetricAnomalyToAlert } from '../../services/metricAnomalyPromotion';
import { planEpisodeAssembly } from '../../services/metricAnomalyEpisodePlanner';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const BUCKET_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

function floorToBucket(value: Date): Date {
  return new Date(Math.floor(value.getTime() / BUCKET_MS) * BUCKET_MS);
}

function at(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MINUTE_MS);
}

function bucketsFrom(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => at(start, index * 5));
}

let deviceCounter = 0;
async function insertDevice(orgId: string, siteId: string, lastSeenAt: Date | null = new Date()): Promise<string> {
  deviceCounter += 1;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `episode-test-${Date.now()}-${deviceCounter}`,
      hostname: `episode-host-${deviceCounter}`,
      displayName: `episode-host-${deviceCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
      lastSeenAt,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

async function enableAnomalies(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ settings: { 'ml.anomalies.enabled': true, 'ml.anomalies.create_alerts': true } })
    .where(eq(organizations.id, orgId));
}

interface AnomalySeed {
  orgId: string;
  deviceId: string;
  windowStart: Date;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  metricType?: string;
  metricName?: string;
  anomalyType?: string;
  score?: number;
  observedValue?: number;
  baselineValue?: number | null;
  status?: string;
  episodeId?: string | null;
}

async function insertAnomaly(seed: AnomalySeed): Promise<string> {
  const [row] = await getTestDb()
    .insert(metricAnomalies)
    .values({
      orgId: seed.orgId,
      deviceId: seed.deviceId,
      sourceTable: seed.sourceTable ?? 'device_metrics',
      metricType: seed.metricType ?? 'cpu',
      metricName: seed.metricName ?? 'cpu_percent',
      anomalyType: seed.anomalyType ?? 'spike',
      status: seed.status ?? 'open',
      windowStart: seed.windowStart,
      windowEnd: at(seed.windowStart, 5),
      bucketSeconds: 300,
      observedValue: seed.observedValue ?? 95,
      baselineValue: seed.baselineValue === undefined ? 40 : seed.baselineValue,
      score: seed.score ?? 5,
      confidence: 0.9,
      sampleCount: 1,
      baselineSummary: {},
      evidence: {},
      episodeId: seed.episodeId ?? null,
    })
    .returning({ id: metricAnomalies.id });
  if (!row) throw new Error('insertAnomaly returned no row');
  return row.id;
}

interface EpisodeSeed {
  orgId: string;
  deviceId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  episodeKey?: string;
  sourceTable?: string;
  anomalyType?: string;
  metricFamily?: string;
  metricNames?: string[];
  status?: 'open' | 'resolved' | 'dismissed';
  closeReason?: string | null;
  snoozedUntil?: Date | null;
  resolvedAt?: Date | null;
  linkedAlertId?: string | null;
}

async function insertEpisode(seed: EpisodeSeed): Promise<string> {
  const metricNames = seed.metricNames ?? ['cpu_percent'];
  const [row] = await getTestDb()
    .insert(metricAnomalyEpisodes)
    .values({
      orgId: seed.orgId,
      deviceId: seed.deviceId,
      episodeKey: seed.episodeKey ?? 'device_metrics:spike:cpu',
      sourceTable: seed.sourceTable ?? 'device_metrics',
      anomalyType: seed.anomalyType ?? 'spike',
      metricFamily: seed.metricFamily ?? 'cpu',
      metricNames,
      status: seed.status ?? 'open',
      closeReason: seed.closeReason ?? null,
      firstSeenAt: seed.firstSeenAt,
      lastSeenAt: seed.lastSeenAt,
      bucketCount: 1,
      peakValue: 95,
      peakMetricName: metricNames[0]!,
      peakBaselineValue: 40,
      peakScore: 5,
      peakAt: seed.firstSeenAt,
      snoozedUntil: seed.snoozedUntil ?? null,
      resolvedAt: seed.resolvedAt ?? null,
      linkedAlertId: seed.linkedAlertId ?? null,
    })
    .returning({ id: metricAnomalyEpisodes.id });
  if (!row) throw new Error('insertEpisode returned no row');
  return row.id;
}

interface RollupSeed {
  orgId: string;
  deviceId: string;
  metricName: string;
  starts: Date[];
  value: (index: number) => number;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  metricType?: string;
}

async function insertRollups(seed: RollupSeed): Promise<void> {
  if (seed.starts.length === 0) return;
  await getTestDb().insert(metricRollups).values(
    seed.starts.map((bucketStart, index) => {
      const value = seed.value(index);
      return {
        orgId: seed.orgId,
        sourceTable: seed.sourceTable ?? 'device_metrics',
        deviceId: seed.deviceId,
        metricType: seed.metricType ?? 'cpu',
        metricName: seed.metricName,
        bucketStart,
        bucketSeconds: 300,
        avgValue: value,
        minValue: value,
        maxValue: value,
        p95Value: value,
        sumValue: value,
        sampleCount: 1,
        gapSeconds: 0,
        metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
      };
    }),
  );
}

async function insertProcessSample(
  orgId: string,
  deviceId: string,
  timestamp: Date,
  processes: Array<{ name: string; pid: number; cpu: number; ramMb: number; diskBps?: number; netBps?: number }>,
): Promise<void> {
  await getTestDb().insert(deviceProcessSamples).values({ orgId, deviceId, timestamp, topProcesses: processes });
}

async function episodesFor(orgId: string, deviceId: string) {
  return getTestDb()
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(eq(metricAnomalyEpisodes.orgId, orgId), eq(metricAnomalyEpisodes.deviceId, deviceId)))
    .orderBy(asc(metricAnomalyEpisodes.firstSeenAt));
}

async function anomalyById(id: string) {
  const [row] = await getTestDb().select().from(metricAnomalies).where(eq(metricAnomalies.id, id));
  if (!row) throw new Error(`anomaly ${id} missing`);
  return row;
}

async function membersOf(episodeId: string) {
  return getTestDb()
    .select()
    .from(metricAnomalies)
    .where(eq(metricAnomalies.episodeId, episodeId))
    .orderBy(asc(metricAnomalies.windowStart));
}

// The `episodes` stage runs inside runDetectionStage's system context; calling
// the function directly needs one too.
async function assemble(orgId: string) {
  const to = floorToBucket(new Date());
  return withSystemDbAccessContext(() => assembleMetricAnomalyEpisodes({ orgId, from: at(to, -15), to }));
}

describe('metric anomaly episode assembly (spec §6, §9)', () => {
  let orgId: string;
  let siteId: string;
  let now: Date;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Episode Org' })).id;
    await enableAnomalies(orgId);
    siteId = (await createSite({ orgId, name: 'Episode Site' })).id;
    now = floorToBucket(new Date());
  });

  it('collapses 17 consecutive disk-write buckets into one open episode with correct peak fields', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -120);
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) {
      ids.push(await insertAnomaly({
        orgId, deviceId: device, windowStart: at(start, i * 5), metricType: 'disk', metricName: 'disk_write_bps',
        score: i === 8 ? 20 : 5, observedValue: i === 8 ? 153e6 : 86e6, baselineValue: i === 8 ? 11e6 : 5.5e6,
      }));
    }

    await assemble(orgId);
    await assemble(orgId); // idempotent: nothing left unassigned, nothing changes

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    const episode = episodes[0]!;
    expect(episode).toMatchObject({
      status: 'open',
      closeReason: null,
      episodeKey: 'device_metrics:spike:disk_write',
      metricFamily: 'disk_write',
      metricNames: ['disk_write_bps'],
      bucketCount: 17,
      peakValue: 153e6,
      peakMetricName: 'disk_write_bps',
      peakBaselineValue: 11e6,
      peakScore: 20,
      recurrenceCount: 0,
    });
    expect(episode.firstSeenAt.toISOString()).toBe(start.toISOString());
    expect(episode.lastSeenAt.toISOString()).toBe(at(start, 85).toISOString());
    expect(episode.peakAt.toISOString()).toBe(at(start, 40).toISOString());
    const members = await membersOf(episode.id);
    expect(members.map((member) => member.id).sort()).toEqual([...ids].sort());
    expect(members.every((member) => member.status === 'open')).toBe(true);
  });

  it('merges the process ram _sum/_max pair into one episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    for (let i = 0; i < 5; i++) {
      for (const metricName of ['top_process_ram_mb_sum', 'top_process_ram_mb_max']) {
        await insertAnomaly({
          orgId, deviceId: device, windowStart: at(start, i * 5), sourceTable: 'device_process_samples', metricType: 'process',
          metricName, anomalyType: 'process_runaway',
          score: metricName === 'top_process_ram_mb_max' && i === 2 ? 9 : 4,
          observedValue: metricName === 'top_process_ram_mb_max' && i === 2 ? 2355 : 6500,
        });
      }
    }

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      episodeKey: 'device_process_samples:process_runaway:process_ram',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      bucketCount: 5,
      peakMetricName: 'top_process_ram_mb_max',
      peakValue: 2355,
    });
    expect(await membersOf(episodes[0]!.id)).toHaveLength(10);
  });

  it('splits two bursts 31 minutes apart: the first closes (cleared on clean data), the second has recurrence_count 1', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });
    await assemble(orgId);
    const [first] = await episodesFor(orgId, device);
    expect(first).toMatchObject({ status: 'open', bucketCount: 3 });

    // Six clean cpu buckets between the bursts, then a bucket 31 minutes after the first burst ended (at +15).
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(at(start, 15), 6), value: () => 20 });
    const late = await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 46) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 51) }); // persistence gate: 2 buckets
    const closed = await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ id: first!.id, status: 'resolved', closeReason: 'cleared', resolvedByUserId: null });
    // Deviation 12: a superseded episode is closed at the successor's start, so
    // the episode-relative recurrence window (A2) still counts it.
    expect(episodes[0]!.resolvedAt!.toISOString()).toBe(at(start, 46).toISOString());
    expect(episodes[1]).toMatchObject({ status: 'open', recurrenceCount: 1, bucketCount: 2 });
    expect((await anomalyById(late)).episodeId).toBe(episodes[1]!.id);
    expect((await membersOf(first!.id)).every((member) => member.status === 'cleared')).toBe(true);
    expect(closed).toEqual([{ episodeId: first!.id, deviceId: device, linkedAlertId: null, closeReason: 'cleared' }]);
  });

  it('a superseded promoted episode hands its linked alert and keeps the promoted member label', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    const members: string[] = [];
    for (const minute of [0, 5, 10]) members.push(await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) }));
    await assemble(orgId);
    const [first] = await episodesFor(orgId, device);
    const promotion = await withSystemDbAccessContext(() =>
      promoteMetricAnomalyToAlert({ orgId, deviceId: device, anomalyId: members[0]!, requireCreateAlertsFlag: false }),
    );
    if (promotion.status !== 'promoted') throw new Error('expected promotion');
    await getTestDb().update(metricAnomalyEpisodes).set({ linkedAlertId: promotion.alertId }).where(eq(metricAnomalyEpisodes.id, first!.id));

    await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 46) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 51) });
    const closed = await assemble(orgId);

    expect(closed).toEqual([{ episodeId: first!.id, deviceId: device, linkedAlertId: promotion.alertId, closeReason: 'expired_no_data' }]);
    expect((await anomalyById(members[0]!)).status).toBe('promoted');
    expect((await anomalyById(members[1]!)).status).toBe('cleared');
  });

  it('keeps a bucket exactly 30 minutes after the burst in the same episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10, 45]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ status: 'open', bucketCount: 4 });
  });

  it('in one batch, closes the older burst as history (expired_no_data without clean data) and opens the newer', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10, 46, 51]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ status: 'resolved', closeReason: 'expired_no_data', bucketCount: 3 });
    expect(episodes[0]!.resolvedAt!.toISOString()).toBe(at(start, 46).toISOString());
    expect(episodes[1]).toMatchObject({ status: 'open', recurrenceCount: 1 });
    expect((await membersOf(episodes[0]!.id)).every((member) => member.status === 'cleared')).toBe(true);
  });

  it('backfill lower bound: a months-old style orphan never rewrites first_seen_at of today\'s episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    const episodeId = await insertEpisode({ orgId, deviceId: device, firstSeenAt: start, lastSeenAt: at(start, 15) });
    for (const minute of [0, 5, 10]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute), episodeId });
    const orphan = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -300) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -295) }); // a lone bucket would be transient
    const near = await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, -30) }); // ends 25 min before first_seen_at

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    const current = episodes.find((episode) => episode.id === episodeId)!;
    expect(current).toMatchObject({ status: 'open', bucketCount: 4 });
    expect(current.firstSeenAt.toISOString()).toBe(at(start, -30).toISOString());
    expect((await anomalyById(near)).episodeId).toBe(episodeId);
    const history = episodes.find((episode) => episode.id !== episodeId)!;
    expect(history).toMatchObject({ status: 'resolved', closeReason: 'expired_no_data', bucketCount: 2 });
    expect(history.resolvedAt!.toISOString()).toBe(at(start, -30).toISOString());
    expect((await anomalyById(orphan)).episodeId).toBe(history.id);
  });

  it('snooze: a new bucket 10 minutes after a user dismiss creates a silent successor, later buckets extend it', async () => {
    const device = await insertDevice(orgId, siteId);
    const snoozedUntil = at(now, 7 * 24 * 60);
    await insertEpisode({
      orgId, deviceId: device, firstSeenAt: at(now, -40), lastSeenAt: at(now, -30),
      status: 'dismissed', closeReason: 'user', snoozedUntil, resolvedAt: at(now, -25),
    });
    const member = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -20) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -15) }); // persistence gate

    await assemble(orgId);

    let episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    const successor = episodes[1]!;
    expect(successor).toMatchObject({ status: 'dismissed', closeReason: 'snoozed', recurrenceCount: 1, resolvedByUserId: null });
    expect(successor.snoozedUntil!.toISOString()).toBe(snoozedUntil.toISOString());
    expect(successor.resolvedAt).not.toBeNull();
    expect(await anomalyById(member)).toMatchObject({ status: 'dismissed', episodeId: successor.id });
    const feedback = await getTestDb().select().from(mlFeedbackEvents).where(eq(mlFeedbackEvents.sourceId, member));
    expect(feedback).toHaveLength(0);

    const next = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10) });
    await assemble(orgId);

    episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ id: successor.id, bucketCount: 3 });
    expect(await anomalyById(next)).toMatchObject({ status: 'dismissed', episodeId: successor.id });
  });

  it('a user dismiss that commits between the planner read and the attach wins: nothing open is attached to it (A1)', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    const episodeId = await insertEpisode({ orgId, deviceId: device, firstSeenAt: start, lastSeenAt: at(start, 10) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: start, episodeId });
    const late = await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 15) });
    // Second bucket: once the anchor is dismissed these become a new island,
    // which the persistence gate only turns into an episode at 2 buckets.
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 20) });

    const tick = new Date();
    const plan = await withSystemDbAccessContext(async () => {
      const inputs = await loadEpisodeAssemblyInputs(orgId, tick);
      return planEpisodeAssembly({
        ...inputs, gapMinutes: EPISODE_GAP_MINUTES, minBuckets: EPISODE_MIN_BUCKETS, settledBefore: floorToBucket(tick),
      });
    });
    expect(new Set(plan.anchorAttaches.map((attach) => attach.episodeId))).toEqual(new Set([episodeId]));

    // W02's PATCH commits here: dismiss + 7-day snooze.
    await getTestDb()
      .update(metricAnomalyEpisodes)
      .set({ status: 'dismissed', closeReason: 'user', resolvedAt: tick, snoozedUntil: at(tick, 7 * 24 * 60) })
      .where(eq(metricAnomalyEpisodes.id, episodeId));

    await withSystemDbAccessContext(() => applyEpisodeAssemblyPlan(orgId, plan, tick));

    const [dismissed] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, episodeId));
    expect(dismissed).toMatchObject({ status: 'dismissed', closeReason: 'user', bucketCount: 1 });
    expect(dismissed!.lastSeenAt.toISOString()).toBe(at(start, 10).toISOString());
    expect(await anomalyById(late)).toMatchObject({ episodeId: null, status: 'open' });

    // Next tick: the row becomes a silent snoozed successor, not a member of the dismissed episode.
    await assemble(orgId);
    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ status: 'dismissed', closeReason: 'snoozed' });
    expect(await anomalyById(late)).toMatchObject({ episodeId: episodes[1]!.id, status: 'dismissed' });
  });

  it('recurrence_count is episode-relative: a replayed burst counts only episodes that closed before it (A2)', async () => {
    const device = await insertDevice(orgId, siteId);
    // Closed BEFORE the replayed burst starts (now − 300 min): counts.
    await insertEpisode({
      orgId, deviceId: device, firstSeenAt: at(now, -500), lastSeenAt: at(now, -490),
      status: 'resolved', closeReason: 'cleared', resolvedAt: at(now, -400),
    });
    // Closed AFTER the replayed burst: a now-relative window would count it too.
    await insertEpisode({
      orgId, deviceId: device, firstSeenAt: at(now, -40), lastSeenAt: at(now, -30),
      status: 'resolved', closeReason: 'cleared', resolvedAt: at(now, -10),
    });
    const replayed = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -300) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -295) });

    await assemble(orgId);

    const createdId = (await anomalyById(replayed)).episodeId;
    const created = (await episodesFor(orgId, device)).find((episode) => episode.id === createdId);
    expect(created).toMatchObject({ recurrenceCount: 1 });
  });

  it('snapshots the top 3 processes at open and at peak, and overwrites only the peak when it grows', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    const ramRow = (minute: number, score: number) => insertAnomaly({
      orgId, deviceId: device, windowStart: at(start, minute), sourceTable: 'device_process_samples', metricType: 'process',
      metricName: 'top_process_ram_mb_max', anomalyType: 'process_runaway', score,
    });
    await ramRow(0, 4);
    await ramRow(5, 6);
    await ramRow(10, 9);
    await insertProcessSample(orgId, device, at(start, 1), [
      { name: 'a.exe', pid: 1, cpu: 1, ramMb: 100 },
      { name: 'b.exe', pid: 2, cpu: 1, ramMb: 300 },
      { name: 'c.exe', pid: 3, cpu: 1, ramMb: 200 },
      { name: 'd.exe', pid: 4, cpu: 1, ramMb: 50 },
    ]);
    await insertProcessSample(orgId, device, at(start, 11), [
      { name: 'chrome.exe', pid: 4120, cpu: 3, ramMb: 1932.5 },
      { name: 'MsMpEng.exe', pid: 900, cpu: 1, ramMb: 400 },
      { name: 'Teams.exe', pid: 77, cpu: 1, ramMb: 300 },
      { name: 'x.exe', pid: 5, cpu: 1, ramMb: 10 },
    ]);

    await assemble(orgId);

    let [episode] = await episodesFor(orgId, device);
    expect(episode!.attribution).toEqual({
      opened: {
        sampledAt: at(start, 1).toISOString(),
        dimension: 'ramMb',
        processes: [
          { name: 'b.exe', pid: 2, value: 300 },
          { name: 'c.exe', pid: 3, value: 200 },
          { name: 'a.exe', pid: 1, value: 100 },
        ],
      },
      peak: {
        sampledAt: at(start, 11).toISOString(),
        dimension: 'ramMb',
        processes: [
          { name: 'chrome.exe', pid: 4120, value: 1932.5 },
          { name: 'MsMpEng.exe', pid: 900, value: 400 },
          { name: 'Teams.exe', pid: 77, value: 300 },
        ],
      },
    });

    // A new, higher peak at +15 moves only `peak`.
    await ramRow(15, 20);
    await insertProcessSample(orgId, device, at(start, 16), [{ name: 'backup.exe', pid: 42, cpu: 9, ramMb: 5000 }]);
    await assemble(orgId);

    [episode] = await episodesFor(orgId, device);
    expect(episode!.attribution?.opened?.processes.map((p) => p.name)).toEqual(['b.exe', 'c.exe', 'a.exe']);
    expect(episode!.attribution?.peak).toEqual({
      sampledAt: at(start, 16).toISOString(),
      dimension: 'ramMb',
      processes: [{ name: 'backup.exe', pid: 42, value: 5000 }],
    });
  });

  it('persistence gate: a lone bucket waits while it can still grow, then closes cleared with no episode or incident', async () => {
    const device = await insertDevice(orgId, siteId);
    const lone = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10) });

    // Still inside the gap: pending, untouched.
    await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });
    expect(await anomalyById(lone)).toMatchObject({ status: 'open', episodeId: null });

    // Once a bucket at last_seen + gap has had its detection pass, it is settled.
    const settledAt = at(now, -5 + EPISODE_GAP_MINUTES + 5);
    await withSystemDbAccessContext(() => assembleMetricAnomalyEpisodes({ orgId, from: at(settledAt, -15), to: settledAt }));

    expect(await anomalyById(lone)).toMatchObject({ status: 'cleared', episodeId: null });
    expect(await episodesFor(orgId, device)).toEqual([]);
    const incidents = await getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.deviceId, device));
    expect(incidents).toEqual([]);
  });

  it('persistence gate control: a second bucket opens the episode before the island settles', async () => {
    const device = await insertDevice(orgId, siteId);
    const first = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10) });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -5) });

    await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });

    const [episode] = await episodesFor(orgId, device);
    expect(episode).toMatchObject({ status: 'open', bucketCount: 2 });
    expect((await anomalyById(first)).episodeId).toBe(episode!.id);
  });

  it('stores an empty process list when the dimension is absent, and NULL when no sample is near', async () => {
    const diskDevice = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    // Two buckets per device: a lone bucket opens no episode (persistence gate).
    for (const minute of [0, 5]) {
      await insertAnomaly({ orgId, deviceId: diskDevice, windowStart: at(start, minute), metricType: 'disk', metricName: 'disk_write_bps' });
    }
    await insertProcessSample(orgId, diskDevice, at(start, 1), [{ name: 'svchost.exe', pid: 8, cpu: 1, ramMb: 20 }]);
    const quietDevice = await insertDevice(orgId, siteId);
    for (const minute of [0, 5]) await insertAnomaly({ orgId, deviceId: quietDevice, windowStart: at(start, minute) });
    const countDevice = await insertDevice(orgId, siteId);
    for (const minute of [0, 5]) {
      await insertAnomaly({ orgId, deviceId: countDevice, windowStart: at(start, minute), metricType: 'process', metricName: 'process_count', anomalyType: 'process_runaway' });
    }
    await insertProcessSample(orgId, countDevice, at(start, 1), [{ name: 'a.exe', pid: 1, cpu: 1, ramMb: 1 }]);

    await assemble(orgId);

    const [disk] = await episodesFor(orgId, diskDevice);
    expect(disk!.attribution?.opened?.processes).toEqual([]);
    expect(disk!.attribution?.peak?.dimension).toBe('diskBps');
    const [quiet] = await episodesFor(orgId, quietDevice);
    expect(quiet!.attribution).toBeNull();
    const [count] = await episodesFor(orgId, countDevice);
    expect(count!.attribution).toBeNull(); // process_count has no attribution dimension
  });
});

describe('metric anomaly episode auto-resolve (spec §7)', () => {
  const T0 = new Date('2026-09-01T12:00:00.000Z'); // episode last_seen_at in every case
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Resolve Org' })).id;
    await enableAnomalies(orgId);
    siteId = (await createSite({ orgId, name: 'Resolve Site' })).id;
  });

  async function seedOpenEpisode(
    deviceId: string,
    options: { metricNames?: string[]; sourceTable?: 'device_metrics' | 'device_process_samples'; episodeKey?: string } = {},
  ): Promise<{ episodeId: string; memberIds: string[] }> {
    const metricNames = options.metricNames ?? ['cpu_percent'];
    const sourceTable = options.sourceTable ?? 'device_metrics';
    const episodeId = await insertEpisode({
      orgId, deviceId, firstSeenAt: at(T0, -15), lastSeenAt: T0, metricNames, sourceTable,
      episodeKey: options.episodeKey ?? 'device_metrics:spike:cpu',
      anomalyType: sourceTable === 'device_metrics' ? 'spike' : 'process_runaway',
    });
    const memberIds: string[] = [];
    for (const minute of [-15, -10, -5]) {
      memberIds.push(await insertAnomaly({
        orgId, deviceId, windowStart: at(T0, minute), episodeId, sourceTable, metricName: metricNames[0],
        anomalyType: sourceTable === 'device_metrics' ? 'spike' : 'process_runaway',
      }));
    }
    return { episodeId, memberIds };
  }

  // `to` = the detection run's range end (A4); a scan's `to` is the current
  // bucket boundary, so it defaults to `now`.
  function resolveAt(now: Date, to: Date = now) {
    return withSystemDbAccessContext(() => resolveMetricAnomalyEpisodes(orgId, to, now));
  }

  async function episodeById(id: string) {
    const [row] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, id));
    return row!;
  }

  it('clears after 6 clean buckets: members cleared, a promoted member untouched, linked alert handed back', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId, memberIds } = await seedOpenEpisode(device);
    const promotion = await withSystemDbAccessContext(() =>
      promoteMetricAnomalyToAlert({ orgId, deviceId: device, anomalyId: memberIds[0]!, requireCreateAlertsFlag: false }),
    );
    if (promotion.status !== 'promoted') throw new Error('expected promotion');
    await getTestDb().update(metricAnomalyEpisodes).set({ linkedAlertId: promotion.alertId }).where(eq(metricAnomalyEpisodes.id, episodeId));
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    const closed = await resolveAt(at(T0, 40));

    expect(closed).toEqual([{ episodeId, deviceId: device, linkedAlertId: promotion.alertId, closeReason: 'cleared' }]);
    const episode = await episodeById(episodeId);
    expect(episode).toMatchObject({ status: 'resolved', closeReason: 'cleared', resolvedByUserId: null });
    expect(episode.resolvedAt!.toISOString()).toBe(at(T0, 40).toISOString());
    expect((await anomalyById(memberIds[0]!)).status).toBe('promoted');
    expect((await anomalyById(memberIds[1]!)).status).toBe('cleared');
    expect((await anomalyById(memberIds[2]!)).status).toBe('cleared');
  });

  it('stays open with only 5 clean buckets', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 5), value: () => 20 });

    expect(await resolveAt(at(T0, 40))).toEqual([]);
    expect((await episodeById(episodeId)).status).toBe('open');
  });

  it('requires clean data on EVERY member metric', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device, {
      sourceTable: 'device_process_samples',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      episodeKey: 'device_process_samples:process_runaway:process_ram',
    });
    const rollup = (metricName: string, count: number) => insertRollups({
      orgId, deviceId: device, sourceTable: 'device_process_samples', metricType: 'process', metricName,
      starts: bucketsFrom(T0, count), value: () => 500,
    });
    await rollup('top_process_ram_mb_max', 6);
    await rollup('top_process_ram_mb_sum', 2);
    expect(await resolveAt(at(T0, 40))).toEqual([]);

    await getTestDb().delete(metricRollups).where(eq(metricRollups.deviceId, device));
    await rollup('top_process_ram_mb_max', 6);
    await rollup('top_process_ram_mb_sum', 6);
    expect((await resolveAt(at(T0, 40))).map((row) => row.episodeId)).toEqual([episodeId]);
  });

  it('expires as expired_no_data after 24 h when the device reports but the series is absent', async () => {
    const now = at(T0, 25 * 60);
    const device = await insertDevice(orgId, siteId, at(now, -5));
    const { episodeId } = await seedOpenEpisode(device);

    expect(await resolveAt(now)).toEqual([{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'expired_no_data' }]);
  });

  it('expires as expired_offline after 24 h when the device itself went quiet', async () => {
    const device = await insertDevice(orgId, siteId, T0);
    const { episodeId } = await seedOpenEpisode(device);

    expect(await resolveAt(at(T0, 25 * 60))).toEqual([{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'expired_offline' }]);
  });

  it('leaves an episode alone while it is still inside the gap', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    expect(await resolveAt(at(T0, 20))).toEqual([]);
    expect((await episodeById(episodeId)).status).toBe('open');
  });

  it('waits until the boundary bucket has had its detection pass, whatever the wall clock says (A4)', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    // now = T0+40 (a now-relative check would clear), but detection only
    // covered buckets before T0+30: the bucket at last_seen_at + gap (T0+30)
    // has not been evaluated yet and could still attach.
    expect(await resolveAt(at(T0, 40), at(T0, 30))).toEqual([]);
    expect((await episodeById(episodeId)).status).toBe('open');

    // Once the range end passes last_seen_at + gap + 5 min, it clears.
    expect((await resolveAt(at(T0, 40), at(T0, 35))).map((row) => row.episodeId)).toEqual([episodeId]);
  });

  it('resolve and detection_off only ever touch the org they were called for', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    const otherPartner = await createPartner();
    const otherOrg = (await createOrganization({ partnerId: otherPartner.id, name: 'Other Resolve Org' })).id;
    const otherSite = (await createSite({ orgId: otherOrg, name: 'Other Site' })).id;
    const otherDevice = await insertDevice(otherOrg, otherSite);
    const otherEpisode = await insertEpisode({ orgId: otherOrg, deviceId: otherDevice, firstSeenAt: at(T0, -15), lastSeenAt: T0 });
    const otherMember = await insertAnomaly({ orgId: otherOrg, deviceId: otherDevice, windowStart: at(T0, -5), episodeId: otherEpisode });
    await insertRollups({ orgId: otherOrg, deviceId: otherDevice, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    expect((await resolveAt(at(T0, 40))).map((row) => row.episodeId)).toEqual([episodeId]);
    expect((await episodeById(otherEpisode)).status).toBe('open');

    await withSystemDbAccessContext(() => closeEpisodesForDisabledDetection(orgId, at(T0, 40)));
    expect((await episodeById(otherEpisode)).status).toBe('open');
    expect((await anomalyById(otherMember)).status).toBe('open');
  });

  it('flag off: closeEpisodesForDisabledDetection closes as detection_off even with clean rollups (A5)', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId, memberIds } = await seedOpenEpisode(device);
    await getTestDb().update(metricAnomalies).set({ status: 'promoted' }).where(eq(metricAnomalies.id, memberIds[0]!));
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });
    const snoozed = await insertEpisode({
      orgId, deviceId: device, firstSeenAt: at(T0, -120), lastSeenAt: at(T0, -115), episodeKey: 'device_metrics:spike:ram',
      metricFamily: 'ram', metricNames: ['ram_percent'], status: 'dismissed', closeReason: 'snoozed',
      snoozedUntil: at(T0, 7 * 24 * 60), resolvedAt: at(T0, -115),
    });

    const closed = await withSystemDbAccessContext(() => closeEpisodesForDisabledDetection(orgId, at(T0, 40)));

    expect(closed).toEqual([{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'detection_off' }]);
    expect(await episodeById(episodeId)).toMatchObject({ status: 'resolved', closeReason: 'detection_off', resolvedByUserId: null });
    expect((await anomalyById(memberIds[0]!)).status).toBe('promoted');
    expect((await anomalyById(memberIds[1]!)).status).toBe('cleared');
    expect(await episodeById(snoozed)).toMatchObject({ status: 'dismissed', closeReason: 'snoozed' });
    const feedback = await getTestDb().select().from(mlFeedbackEvents).where(eq(mlFeedbackEvents.orgId, orgId));
    expect(feedback).toHaveLength(0);
  });
});

describe('episode stages inside detectMetricAnomaliesRange (spec §6, §7, D4)', () => {
  let orgId: string;
  let siteId: string;
  let now: Date;
  const handled: Array<{ orgId: string; closed: EpisodeCloseResult[] }> = [];

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Stage Org' })).id;
    siteId = (await createSite({ orgId, name: 'Stage Site' })).id;
    now = floorToBucket(new Date());
    handled.length = 0;
    setEpisodeCloseHandler(async (closedOrgId, closed) => {
      handled.push({ orgId: closedOrgId, closed });
    });
  });

  afterEach(() => {
    setEpisodeCloseHandler(null);
  });

  async function seedClearableEpisode(deviceId: string): Promise<string> {
    const lastSeenAt = at(now, -60);
    const episodeId = await insertEpisode({ orgId, deviceId, firstSeenAt: at(lastSeenAt, -5), lastSeenAt });
    await insertAnomaly({ orgId, deviceId, windowStart: at(lastSeenAt, -5), episodeId });
    await insertRollups({ orgId, deviceId, metricName: 'cpu_percent', starts: bucketsFrom(lastSeenAt, 6), value: () => 20 });
    return episodeId;
  }

  it('flag off: the resolve stage still runs and closes open episodes as detection_off, never cleared (D4, A5)', async () => {
    // No enableAnomalies(): the flag defaults off. The episode has 6 clean
    // rollups, but no detector evaluated them, so they must not read as `cleared`.
    const device = await insertDevice(orgId, siteId);
    const episodeId = await seedClearableEpisode(device);

    const result = await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });

    expect(result).toMatchObject({ skipped: true, skippedReason: 'ml-disabled', statements: 0, episodesClosed: 1 });
    expect(result.stages.map((stage) => `${stage.stage}:${stage.outcome}`)).toEqual(['episode-resolve:completed']);
    const [episode] = await episodesFor(orgId, device);
    expect(episode).toMatchObject({ id: episodeId, status: 'resolved', closeReason: 'detection_off' });
    expect(handled).toEqual([{ orgId, closed: [{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'detection_off' }] }]);
    const feedback = await getTestDb().select().from(mlFeedbackEvents).where(eq(mlFeedbackEvents.orgId, orgId));
    expect(feedback).toHaveLength(0);
  });

  it('flag on: the same episode clears through the resolve stage (A4 bound = range end)', async () => {
    await enableAnomalies(orgId);
    const device = await insertDevice(orgId, siteId);
    const episodeId = await seedClearableEpisode(device);

    const result = await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });

    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'baseline', 'growth-trend', 'process-runaway', 'episodes', 'incidents', 'episode-resolve',
    ]);
    const [episode] = await episodesFor(orgId, device);
    expect(episode).toMatchObject({ id: episodeId, status: 'resolved', closeReason: 'cleared' });
  });

  it('an incident is created already linked to its episode (A6: episodes runs before incidents)', async () => {
    await enableAnomalies(orgId);
    const device = await insertDevice(orgId, siteId);
    const ram = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10), metricName: 'ram_percent', metricType: 'memory', score: 9 });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10), metricName: 'cpu_percent', score: 3 });
    // Second bucket for each series (persistence gate), lower-scored.
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -5), metricName: 'ram_percent', metricType: 'memory', score: 2 });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -5), metricName: 'cpu_percent', score: 1 });

    await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });

    const ramEpisodeId = (await anomalyById(ram)).episodeId;
    expect(ramEpisodeId).not.toBeNull();
    const incidents = await getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.deviceId, device));
    expect(incidents).toHaveLength(2); // one per (device, anomaly_type, bucket)
    const first = incidents.find((incident) => incident.windowStart.getTime() === at(now, -10).getTime());
    expect(first!.episodeId).toBe(ramEpisodeId); // highest-score member's episode
  });

  it('a backfill assembles but never auto-resolves', async () => {
    await enableAnomalies(orgId);
    const device = await insertDevice(orgId, siteId);
    const episodeId = await seedClearableEpisode(device);
    const fresh = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10), metricName: 'ram_percent', metricType: 'memory' });
    await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -5), metricName: 'ram_percent', metricType: 'memory' });

    const result = await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now, trigger: 'backfill' });

    expect(result.stages.map((stage) => stage.stage)).not.toContain('episode-resolve');
    expect(result.stages.map((stage) => stage.stage)).toContain('episodes');
    const episodes = await episodesFor(orgId, device);
    expect(episodes.find((episode) => episode.id === episodeId)).toMatchObject({ status: 'open' });
    expect((await anomalyById(fresh)).episodeId).not.toBeNull();
    expect(handled).toEqual([]);
  });
});
