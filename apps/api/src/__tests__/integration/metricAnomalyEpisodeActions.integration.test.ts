import './setup';

import { describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { withSystemDbAccessContext } from '../../db';
import { alerts, metricAnomalies, metricAnomalyEpisodes, mlFeedbackEvents } from '../../db/schema';
import { applyEpisodeAction } from '../../services/metricAnomalyEpisodeActions';
import { getTestDb } from './setup';
import { insertEpisodeDevice, seedAlert, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function act(input: Parameters<typeof applyEpisodeAction>[0]) {
  return withSystemDbAccessContext(() => applyEpisodeAction(input));
}

async function episodeRow(id: string) {
  const [row] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, id));
  return row!;
}

async function membersOf(episodeId: string) {
  return getTestDb().select().from(metricAnomalies).where(eq(metricAnomalies.episodeId, episodeId)).orderBy(metricAnomalies.windowStart);
}

async function episodeFeedback(episodeId: string) {
  return getTestDb().select().from(mlFeedbackEvents).where(and(
    eq(mlFeedbackEvents.sourceType, 'anomaly'),
    eq(mlFeedbackEvents.dedupeKey, `episode:${episodeId}`),
  ));
}

describe('applyEpisodeAction (W02, spec §8)', () => {
  it('dismiss over 17 open members: episode dismissed + snoozed 7 d, 17 members dismissed, 17 joinable feedback rows', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 17, start: new Date(Date.now() - 2 * HOUR) });
    const now = new Date();

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id, note: 'backup job', now });

    expect(result).toMatchObject({ status: 'ok', action: 'dismiss', feedbackInserted: 17 });
    const episode = await episodeRow(ep.episodeId);
    expect(episode).toMatchObject({ status: 'dismissed', closeReason: 'user', resolvedByUserId: user.id, note: 'backup job' });
    expect(episode.snoozedUntil!.getTime()).toBe(now.getTime() + 7 * DAY);
    expect((await membersOf(ep.episodeId)).every((m) => m.status === 'dismissed')).toBe(true);

    const feedback = await episodeFeedback(ep.episodeId);
    expect(feedback).toHaveLength(17);
    expect(new Set(feedback.map((f) => f.sourceId))).toEqual(new Set(ep.memberIds));
    expect(feedback.every((f) => f.eventType === 'anomaly.dismissed' && f.actorUserId === user.id)).toBe(true);
    expect(feedback.every((f) => (f.metadata as Record<string, unknown>).episodeId === ep.episodeId)).toBe(true);
  });

  it('cascades only WHERE status = open: a member a human already dismissed keeps its label and gets no new row', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 5, start: new Date(Date.now() - 2 * HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'dismissed' }).where(eq(metricAnomalies.id, ep.memberIds[0]!));

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', feedbackInserted: 4 });
    const members = await membersOf(ep.episodeId);
    expect(members[0]!.status).toBe('dismissed');
    expect(members.slice(1).every((m) => m.status === 'resolved' && m.resolvedAt !== null)).toBe(true);
    expect((await episodeFeedback(ep.episodeId)).map((f) => f.sourceId)).not.toContain(ep.memberIds[0]);
  });

  it('resolve on a promoted episode resolves the linked alert by default, with the user as resolver', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id, note: 'disk replaced' });

    expect(result).toMatchObject({ status: 'ok', alertId, alertResolved: true });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert).toMatchObject({ status: 'resolved', resolvedBy: user.id, resolutionNote: 'disk replaced' });
  });

  it('dismiss on a promoted episode resolves the linked alert by default, like resolve (A7)', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', action: 'dismiss', alertId, alertResolved: true });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert).toMatchObject({ status: 'resolved', resolvedBy: user.id, resolutionNote: 'Resolved: anomaly episode dismissed' });
    expect(await episodeRow(ep.episodeId)).toMatchObject({ status: 'dismissed', closeReason: 'user' });
  });

  it('dismiss with resolveAlert: false leaves the linked alert active (A7)', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id, resolveAlert: false });

    expect(result).toMatchObject({ status: 'ok', alertResolved: false });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert!.status).toBe('active');
  });

  it('resolve with resolveAlert: false leaves the linked alert for the alert workflow', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id, resolveAlert: false });

    expect(result).toMatchObject({ status: 'ok', alertResolved: false });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert!.status).toBe('active');
    expect((await episodeRow(ep.episodeId)).status).toBe('resolved');
  });

  it('promote: one alert with context.episodeId from the peak member; episode stays open; members promoted + linked', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR) });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', action: 'promote', feedbackInserted: 3 });
    const alertId = (result as { alertId: string }).alertId;
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert!.context).toMatchObject({ source: 'metric_anomaly', anomalyId: ep.peakMemberId, episodeId: ep.episodeId });
    expect(alert!.episodeId).toBeNull(); // monitor-episode column untouched
    expect(await episodeRow(ep.episodeId)).toMatchObject({ status: 'open', linkedAlertId: alertId });
    const members = await membersOf(ep.episodeId);
    expect(members.every((m) => m.status === 'promoted' && m.linkedAlertId === alertId)).toBe(true);
    const feedback = await episodeFeedback(ep.episodeId);
    expect(feedback).toHaveLength(3);
    expect(feedback.every((f) => f.eventType === 'anomaly.promoted')).toBe(true);
  });

  it('promote reusing an alert the peak member already carries stamps context.episodeId onto it', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const existingAlert = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'promoted', linkedAlertId: existingAlert }).where(eq(metricAnomalies.id, ep.peakMemberId));

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', alertId: existingAlert, feedbackInserted: 1 });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, existingAlert));
    expect(alert!.context).toMatchObject({ source: 'metric_anomaly', episodeId: ep.episodeId });
  });

  it('a second promote is a 409 already_promoted and creates nothing', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    const again = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(again).toMatchObject({ status: 'conflict', reason: 'already_promoted' });
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId))).toHaveLength(1);
  });

  it('any action but unsnooze on a closed episode is a 409 and writes nothing', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - 3 * HOUR), status: 'resolved', closeReason: 'cleared', memberStatus: 'cleared' });

    for (const action of ['resolve', 'dismiss', 'promote'] as const) {
      expect(await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action, actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'episode_closed' });
    }
    expect(await episodeFeedback(ep.episodeId)).toHaveLength(0);
    expect((await episodeRow(ep.episodeId)).closeReason).toBe('cleared');
  });

  it('unsnooze clears the snooze on every snoozed episode of the same device + key (spec deviation D-4)', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const until = new Date(Date.now() + 5 * DAY);
    const original = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - 6 * HOUR), status: 'dismissed', closeReason: 'user', snoozedUntil: until, memberStatus: 'dismissed' });
    const successor = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR), status: 'dismissed', closeReason: 'snoozed', snoozedUntil: until, memberStatus: 'dismissed' });

    const result = await act({ orgId: org.id, deviceId, episodeId: original.episodeId, action: 'unsnooze', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', action: 'unsnooze', feedbackInserted: 0 });
    expect((await episodeRow(original.episodeId)).snoozedUntil).toBeNull();
    expect((await episodeRow(successor.episodeId)).snoozedUntil).toBeNull();
    expect((await episodeRow(original.episodeId)).status).toBe('dismissed');

    expect(await act({ orgId: org.id, deviceId, episodeId: original.episodeId, action: 'unsnooze', actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'not_snoozed' });
  });

  it('an episode id from another device is not_found', async () => {
    const { org, site, user } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });

    expect(await act({ orgId: org.id, deviceId: deviceA, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id })).toEqual({ status: 'not_found' });
    expect((await membersOf(ep.episodeId)).every((m) => m.status === 'open')).toBe(true);
  });

  it('promote refuses an episode whose members were all labelled by the per-row route', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'dismissed' }).where(inArray(metricAnomalies.id, ep.memberIds));

    expect(await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'no_promotable_member' });
  });
});
