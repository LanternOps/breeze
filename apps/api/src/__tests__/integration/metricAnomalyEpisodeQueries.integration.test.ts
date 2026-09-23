import './setup';

import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { getDeviceEpisodeDetail, listDeviceEpisodes } from '../../services/metricAnomalyEpisodeQueries';
import { insertEpisodeDevice, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('metric anomaly episode queries (W02)', () => {
  it('open filter returns only open episodes, newest last_seen_at first', async () => {
    const { org, site } = await seedTenant();
    const deviceLastSeen = new Date(Math.floor(Date.now() / 1000) * 1000 - 3 * HOUR);
    const deviceId = await insertEpisodeDevice(org.id, site.id, deviceLastSeen);
    const now = new Date();
    const older = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - 5 * HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });
    const newer = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - 1 * HOUR) });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 3 * HOUR), status: 'resolved', closeReason: 'cleared', metricName: 'ram_percent', metricFamily: 'ram' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'open', limit: 25 }));

    expect(result.focusedEpisodeId).toBeNull();
    expect(result.data.map((e) => e.id)).toEqual([newer.episodeId, older.episodeId]);
    expect(result.data[0]).toMatchObject({ ongoing: true, bucketCount: 2, rangeMin: 84, rangeMax: 88, peakAnomalyId: newer.peakMemberId });
    // A9: every DTO carries its device's last_seen_at (the expired_offline chip reads it).
    expect(result.data.every((e) => e.deviceLastSeenAt === deviceLastSeen.toISOString())).toBe(true);
  });

  it('closed filter returns resolved/dismissed episodes closed in the last 7 days only', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const now = new Date();
    const recent = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 2 * DAY), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(now.getTime() - 1 * DAY) });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 10 * DAY), status: 'dismissed', closeReason: 'user', resolvedAt: new Date(now.getTime() - 8 * DAY), metricName: 'cpu_percent', metricFamily: 'cpu' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - HOUR), metricName: 'ram_percent', metricFamily: 'ram' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'closed', limit: 25 }));

    expect(result.data.map((e) => e.id)).toEqual([recent.episodeId]);
  });

  it('ref by member anomaly id forces status=all and returns the containing episode first', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const now = new Date();
    const closed = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(now.getTime() - 3 * DAY), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(now.getTime() - 2 * DAY) });
    const open = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({
      orgId: org.id, deviceId, status: 'open', limit: 25, ref: closed.memberIds[1],
    }));

    expect(result.focusedEpisodeId).toBe(closed.episodeId);
    expect(result.data.map((e) => e.id)).toEqual([closed.episodeId, open.episodeId]);
  });

  it('ref by episode id works and an unknown ref leaves focusedEpisodeId null', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR) });

    const byId = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'open', limit: 25, ref: ep.episodeId }));
    expect(byId.focusedEpisodeId).toBe(ep.episodeId);

    const unknown = await withSystemDbAccessContext(() => listDeviceEpisodes({
      orgId: org.id, deviceId, status: 'open', limit: 25, ref: '99999999-9999-4999-8999-999999999999',
    }));
    expect(unknown.focusedEpisodeId).toBeNull();
    expect(unknown.data.map((e) => e.id)).toEqual([ep.episodeId]);
  });

  it('a ref on another device never resolves (device-scoped lookup)', async () => {
    const { org, site } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const epB = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId: deviceA, status: 'all', limit: 25, ref: epB.memberIds[0] }));
    expect(result.focusedEpisodeId).toBeNull();
    expect(result.data).toEqual([]);
  });

  it('detail returns members ordered by window_start, capped at 200 with membersTruncated', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 201, start: new Date(Date.now() - 20 * HOUR) });

    const detail = await withSystemDbAccessContext(() => getDeviceEpisodeDetail({ orgId: org.id, deviceId, episodeId: ep.episodeId }));

    expect(detail).not.toBeNull();
    expect(detail!.members).toHaveLength(200);
    expect(detail!.membersTruncated).toBe(true);
    expect(detail!.members[0]!.id).toBe(ep.memberIds[0]);
    expect(detail!.members[199]!.id).toBe(ep.memberIds[199]);
  });

  it('detail for an episode on another device is null', async () => {
    const { org, site } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const epB = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });
    expect(await withSystemDbAccessContext(() => getDeviceEpisodeDetail({ orgId: org.id, deviceId: deviceA, episodeId: epB.episodeId }))).toBeNull();
  });
});
