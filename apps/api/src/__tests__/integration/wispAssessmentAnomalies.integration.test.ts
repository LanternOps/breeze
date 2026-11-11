/**
 * #11425 — the Wisp assessment digest's metric anomalies section
 * (`loadDigestAnomalies`, services/wisp/assessment.ts) on real SQL: the open
 * filter (announced, not suppressed by its episode, episode open), the
 * trigger admitted by id whatever its status and ordered first, the org pin,
 * and the device-name / episode-status joins. The unit tests only see the
 * compiled WHERE; this proves the statement runs and selects the right rows.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { metricAnomalyIncidents } from '../../db/schema';
import { loadDigestAnomalies } from '../../services/wisp/assessment';
import { getTestDb } from './setup';
import { insertEpisodeDevice, seedEpisode, seedIncident, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;
const BUCKET = 300_000;

async function markIncident(id: string, o: { dispatched: boolean; suppressed?: boolean; lastSeenAt?: Date }) {
  await getTestDb()
    .update(metricAnomalyIncidents)
    .set({
      dispatchedAt: o.dispatched ? new Date() : null,
      suppressedByEpisode: o.suppressed ?? false,
      ...(o.lastSeenAt ? { lastSeenAt: o.lastSeenAt } : {}),
    })
    .where(eq(metricAnomalyIncidents.id, id));
}

const read = (orgId: string, triggerId: string | null) =>
  withSystemDbAccessContext(() => loadDigestAnomalies(orgId, triggerId));

describe('wisp assessment digest: metric anomalies (#11425)', () => {
  async function seedOrgState() {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 3 * HOUR) / BUCKET) * BUCKET);

    // Open episode: the announced incident is listed; its suppressed sibling
    // and a not-yet-announced one are not.
    const open = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start });
    const announced = await seedIncident({ orgId: org.id, deviceId, episodeId: open.episodeId, windowStart: start });
    const suppressed = await seedIncident({ orgId: org.id, deviceId, episodeId: open.episodeId, windowStart: new Date(start.getTime() + BUCKET) });
    const pending = await seedIncident({ orgId: org.id, deviceId, episodeId: open.episodeId, windowStart: new Date(start.getTime() + 2 * BUCKET) });
    await markIncident(announced, { dispatched: true });
    await markIncident(suppressed, { dispatched: true, suppressed: true });
    await markIncident(pending, { dispatched: false });

    // Resolved episode: its announced incident is no longer open.
    const resolved = await seedEpisode({
      orgId: org.id, deviceId, memberCount: 1, start, status: 'resolved',
      metricName: 'cpu_percent', metricFamily: 'cpu', anomalyType: 'drop',
    });
    const closed = await seedIncident({ orgId: org.id, deviceId, episodeId: resolved.episodeId, windowStart: start, anomalyType: 'drop' });
    await markIncident(closed, { dispatched: true, lastSeenAt: new Date(start.getTime() + 4 * BUCKET) });

    // An unlinked incident (no episode): never listed as open.
    const unlinked = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: new Date(start.getTime() - HOUR), anomalyType: 'flatline' });
    await markIncident(unlinked, { dispatched: true });

    return { org, deviceId, announced, suppressed, pending, closed, unlinked };
  }

  it('lists only announced, unsuppressed incidents whose episode is open, with device name and episode status', async () => {
    const s = await seedOrgState();
    const rows = await read(s.org.id, null);
    expect(rows.map((r) => r.id)).toEqual([s.announced]);
    expect(rows[0]).toMatchObject({
      deviceId: s.deviceId,
      deviceName: expect.stringMatching(/^episode-w02-/),
      anomalyType: 'spike',
      metricNames: ['disk_write_bps'],
      status: 'open',
    });
    expect(Number(rows[0]!.peakScore)).toBe(7);
    expect(rows[0]!.openedAt).toBeInstanceOf(Date);
  });

  it('admits the triggering incident by id whatever its status, ordered first', async () => {
    const s = await seedOrgState();
    const rows = await read(s.org.id, s.closed);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[s.closed, 'resolved'], [s.announced, 'open']]);

    const unlinked = await read(s.org.id, s.unlinked);
    expect(unlinked.map((r) => [r.id, r.status])).toEqual([[s.unlinked, 'unknown'], [s.announced, 'open']]);
  });

  it("is pinned to the org: another org's incident is not admitted even when named as the trigger", async () => {
    const mine = await seedOrgState();
    const other = await seedOrgState();
    const rows = await read(mine.org.id, other.announced);
    expect(rows.map((r) => r.id)).toEqual([mine.announced]);
  });
});
