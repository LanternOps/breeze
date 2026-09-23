import './setup';

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { analyticsRoutes } from '../../routes/analytics';
import { anomaliesRoutes } from '../../routes/devices/anomalies';
import { createIntegrationTestClient } from './db-utils';
import { insertEpisodeDevice, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/devices', anomaliesRoutes);
  app.route('/api/v1/analytics', analyticsRoutes);
  return app;
}

async function feedbackTotals(client: Awaited<ReturnType<typeof createIntegrationTestClient>>) {
  const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
  expect(res.status).toBe(200);
  return (await res.json()).feedback as { total: number; dismissed: number };
}

describe('anomaly episode routes over HTTP (W02)', () => {
  it('dismissing a 17-bucket episode moves /analytics/anomalies/evaluation feedback.total by 17', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 17, start: new Date(Date.now() - 2 * HOUR) });

    const before = await feedbackTotals(client);
    const res = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'dismiss' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: ep.episodeId, status: 'dismissed', closeReason: 'user', snoozed: true, ongoing: false });
    expect(body.meta).toEqual({ alertId: null, alertResolved: false, labelledMembers: 17 });

    const after = await feedbackTotals(client);
    expect(after.total - before.total).toBe(17);
    expect(after.dismissed - before.dismissed).toBe(17);

    // A second dismiss is a 409, and labels do not double-count.
    const again = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'dismiss' });
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe('episode_closed');
    expect((await feedbackTotals(client)).total).toBe(after.total);
  });

  it('ref=<member anomaly id> returns the containing episode first, even when closed', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const closed = await seedEpisode({ orgId, deviceId, memberCount: 2, start: new Date(Date.now() - 30 * HOUR), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(Date.now() - 20 * HOUR) });
    await seedEpisode({ orgId, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });

    const res = await client.get(`/api/v1/devices/${deviceId}/anomaly-episodes?ref=${closed.memberIds[0]}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.focusedEpisodeId).toBe(closed.episodeId);
    expect(body.data[0].id).toBe(closed.episodeId);
    expect(body.data).toHaveLength(2);

    const detail = await client.get(`/api/v1/devices/${deviceId}/anomaly-episodes/${closed.episodeId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.members).toHaveLength(2);
  });

  it('a device in another org is 404 for list, detail and PATCH — and nothing changes', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const other = await seedTenant();
    const foreignDevice = await insertEpisodeDevice(other.org.id, other.site.id);
    const foreign = await seedEpisode({ orgId: other.org.id, deviceId: foreignDevice, memberCount: 2, start: new Date(Date.now() - HOUR) });

    expect((await client.get(`/api/v1/devices/${foreignDevice}/anomaly-episodes`)).status).toBe(404);
    expect((await client.get(`/api/v1/devices/${foreignDevice}/anomaly-episodes/${foreign.episodeId}`)).status).toBe(404);
    expect((await client.patch(`/api/v1/devices/${foreignDevice}/anomaly-episodes/${foreign.episodeId}`, { action: 'dismiss' })).status).toBe(404);

    // Own device, foreign episode id → the service's (org, device) scope makes it 404 too.
    const ownDevice = await insertEpisodeDevice(client.env.organization.id, client.env.site.id);
    expect((await client.patch(`/api/v1/devices/${ownDevice}/anomaly-episodes/${foreign.episodeId}`, { action: 'dismiss' })).status).toBe(404);
  });

  it('promote over HTTP returns the linked alert and keeps the episode open', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR) });

    const res = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'promote', note: 'escalating' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: 'open', ongoing: true, promoted: true });
    expect(body.meta.alertId).toBe(body.data.linkedAlertId);
    expect(body.meta.labelledMembers).toBe(3);
  });
});
