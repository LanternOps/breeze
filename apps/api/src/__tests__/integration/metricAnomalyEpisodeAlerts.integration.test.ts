import './setup';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { alerts, metricAnomalyEpisodes } from '../../db/schema';
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import {
  registerEpisodeCloseAlertHandler,
  resolveAlertsForAutoClosedEpisodes,
} from '../../services/metricAnomalyEpisodeAlerts';
import { getTestDb } from './setup';
import {
  enableAnomalyDetection,
  insertCleanRollups,
  insertEpisodeDevice,
  seedAlert,
  seedEpisode,
  seedTenant,
} from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

async function alertRow(id: string) {
  const [row] = await getTestDb().select().from(alerts).where(eq(alerts.id, id));
  return row!;
}

describe('episode close → linked alert auto-resolve (W02, spec §7)', () => {
  beforeAll(() => {
    registerEpisodeCloseAlertHandler();
  });

  it('a promoted episode that clears through the resolve stage resolves its active alert', async () => {
    const { org, site } = await seedTenant();
    await enableAnomalyDetection(org.id); // flag off would close it as detection_off (A5)
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const start = new Date(Date.now() - 3 * HOUR);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start, linkedAlertId: alertId, memberStatus: 'promoted' });
    const lastSeen = new Date(start.getTime() + 3 * 300_000);
    await insertCleanRollups({ orgId: org.id, deviceId, metricName: 'disk_write_bps', from: lastSeen, count: 6 });

    await detectMetricAnomaliesRange({ orgId: org.id, from: new Date(Date.now() - HOUR), to: new Date() });

    const [episode] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, ep.episodeId));
    expect(episode).toMatchObject({ status: 'resolved', closeReason: 'cleared' });
    expect(await alertRow(alertId)).toMatchObject({ status: 'resolved', resolutionNote: 'Auto-resolved: anomaly episode cleared', resolvedBy: null });
  });

  it('with detection turned off the episode closes as detection_off and its alert stays active (A5)', async () => {
    const { org, site } = await seedTenant(); // ml.anomalies.enabled defaults off
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const start = new Date(Date.now() - 3 * HOUR);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start, linkedAlertId: alertId, memberStatus: 'promoted' });
    await insertCleanRollups({ orgId: org.id, deviceId, metricName: 'disk_write_bps', from: new Date(start.getTime() + 3 * 300_000), count: 6 });

    await detectMetricAnomaliesRange({ orgId: org.id, from: new Date(Date.now() - HOUR), to: new Date() });

    const [episode] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, ep.episodeId));
    expect(episode).toMatchObject({ status: 'resolved', closeReason: 'detection_off' });
    expect((await alertRow(alertId)).status).toBe('active');
  });

  it('a requires-human alert is never auto-resolved', async () => {
    const { org, site } = await seedTenant();
    await enableAnomalyDetection(org.id); // so the episode really clears
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId, requiresHuman: true });
    const start = new Date(Date.now() - 3 * HOUR);
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start, linkedAlertId: alertId, memberStatus: 'promoted' });
    await insertCleanRollups({ orgId: org.id, deviceId, metricName: 'disk_write_bps', from: new Date(start.getTime() + 2 * 300_000), count: 6 });

    await detectMetricAnomaliesRange({ orgId: org.id, from: new Date(Date.now() - HOUR), to: new Date() });

    expect((await alertRow(alertId)).status).toBe('active');
  });

  it('catch-up: resolves alerts of episodes auto-closed in the last 24 h only, never user-closed ones', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const expiredAlert = await seedAlert({ orgId: org.id, deviceId });
    const staleAlert = await seedAlert({ orgId: org.id, deviceId });
    const userAlert = await seedAlert({ orgId: org.id, deviceId });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 30 * HOUR), status: 'resolved', closeReason: 'expired_no_data', resolvedAt: new Date(Date.now() - HOUR), linkedAlertId: expiredAlert, metricName: 'cpu_percent', metricFamily: 'cpu' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 80 * HOUR), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(Date.now() - 48 * HOUR), linkedAlertId: staleAlert, metricName: 'ram_percent', metricFamily: 'ram' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 5 * HOUR), status: 'resolved', closeReason: 'user', resolvedAt: new Date(Date.now() - HOUR), linkedAlertId: userAlert });

    expect(await resolveAlertsForAutoClosedEpisodes(org.id)).toBe(1);

    expect(await alertRow(expiredAlert)).toMatchObject({ status: 'resolved', resolutionNote: 'Auto-resolved: anomaly episode expired' });
    expect((await alertRow(staleAlert)).status).toBe('active');
    expect((await alertRow(userAlert)).status).toBe('active');

    // Idempotent: a second pass resolves nothing.
    expect(await resolveAlertsForAutoClosedEpisodes(org.id)).toBe(0);
  });
});
