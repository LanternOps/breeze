import './setup';

import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { metricAnomalyIncidents } from '../../db/schema';
import { publishPendingIncidents } from '../../jobs/metricAnomalyIncidentPublisher';
import { getTestDb } from './setup';
import { insertEpisodeDevice, seedEpisode, seedIncident, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

describe('publisher: one dispatch per episode (W02 §11)', () => {
  async function incidentsOf(episodeId: string) {
    return getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.episodeId, episodeId)).orderBy(metricAnomalyIncidents.windowStart);
  }

  it('3 incidents of one episode → 1 published (the earliest), 2 suppressed_by_episode', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: new Date(start.getTime() + i * 300_000) }));
    }

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 1, skipped: 0, suppressed: 2 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock.mock.calls[0]![2]).toEqual({ incidentId: ids[0], deviceId });
    const rows = await incidentsOf(ep.episodeId);
    expect(rows.map((r) => [r.suppressedByEpisode, r.dispatchedAt !== null, r.dispatchAttempts])).toEqual([
      [false, true, 1], [true, true, 1], [true, true, 1],
    ]);
  });

  it('a later incident of an already-dispatched episode is suppressed on the next pass', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start });
    await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: start });
    expect(await publishPendingIncidents()).toMatchObject({ published: 1, suppressed: 0 });

    await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: new Date(start.getTime() + 300_000) });
    expect(await publishPendingIncidents()).toEqual({ published: 0, skipped: 0, suppressed: 1 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it('different episodes each get their own dispatch', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const a = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'cpu_percent', metricFamily: 'cpu' });
    const b = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'ram_percent', metricFamily: 'ram', anomalyType: 'drop' });
    await seedIncident({ orgId: org.id, deviceId, episodeId: a.episodeId, windowStart: start });
    await seedIncident({ orgId: org.id, deviceId, episodeId: b.episodeId, windowStart: start, anomalyType: 'drop' });

    expect(await publishPendingIncidents()).toEqual({ published: 2, skipped: 0, suppressed: 0 });
  });

  it('an unlinked incident (no episode) dispatches at once, as before (D-2 withdrawn)', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const incidentId = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: new Date(Date.now() - HOUR) });

    expect(await publishPendingIncidents()).toEqual({ published: 1, skipped: 0, suppressed: 0 });
    const [row] = await getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.id, incidentId));
    expect(row).toMatchObject({ suppressedByEpisode: false, dispatchAttempts: 1 });
    expect(row!.dispatchedAt).not.toBeNull();
  });
});
