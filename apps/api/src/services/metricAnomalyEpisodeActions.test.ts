import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, dbMock, promoteMock, emitMemberFeedbackMock } = vi.hoisted(() => ({
  calls: [] as string[],
  dbMock: {} as Record<string, unknown>,
  promoteMock: vi.fn(),
  emitMemberFeedbackMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  metricAnomalyEpisodes: { __table: 'episodes' },
  metricAnomalies: { __table: 'members' },
  alerts: { __table: 'alerts' },
}));
vi.mock('./alertService', () => ({ resolveAlert: vi.fn() }));
vi.mock('./metricAnomalyPromotion', () => ({ promoteMetricAnomalyToAlert: promoteMock }));
vi.mock('./mlFeedbackEmitters', () => ({ emitAlertStateFeedback: vi.fn(), emitAnomalyEpisodeMemberFeedback: emitMemberFeedbackMock }));
vi.mock('./metricAnomalyEpisodes', () => ({ EPISODE_SNOOZE_DAYS: 7 }));

import { applyEpisodeAction, decideEpisodeAction, EPISODE_ACTION_CONFLICT_MESSAGES } from './metricAnomalyEpisodeActions';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const open = { status: 'open', linkedAlertId: null, snoozedUntil: null };

describe('decideEpisodeAction (spec §8.1)', () => {
  it.each(['resolve', 'dismiss', 'promote'] as const)('%s is allowed on an open episode', (action) => {
    expect(decideEpisodeAction(open, action, NOW)).toEqual({ ok: true });
  });

  it.each([
    ['resolve', 'resolved'], ['dismiss', 'resolved'], ['promote', 'resolved'],
    ['resolve', 'dismissed'], ['dismiss', 'dismissed'], ['promote', 'dismissed'],
  ] as const)('%s on a %s episode is episode_closed', (action, status) => {
    expect(decideEpisodeAction({ ...open, status }, action, NOW)).toEqual({ ok: false, reason: 'episode_closed' });
  });

  it('promote on an already-linked open episode is already_promoted', () => {
    expect(decideEpisodeAction({ ...open, linkedAlertId: 'a-1' }, 'promote', NOW)).toEqual({ ok: false, reason: 'already_promoted' });
  });

  it('resolve on a promoted (linked) open episode is allowed', () => {
    expect(decideEpisodeAction({ ...open, linkedAlertId: 'a-1' }, 'resolve', NOW)).toEqual({ ok: true });
  });

  it('unsnooze requires dismissed + snoozed_until in the future', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: true });
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: past }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: null }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ ...open, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ status: 'resolved', linkedAlertId: null, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
  });

  it('every conflict reason has a user-facing message', () => {
    for (const reason of ['episode_closed', 'already_promoted', 'not_snoozed', 'no_promotable_member', 'promotion_disabled'] as const) {
      expect(EPISODE_ACTION_CONFLICT_MESSAGES[reason]).toMatch(/\w/);
    }
  });
});

// Hard requirement (W01b concurrency analysis): the episode row is locked
// FOR UPDATE before any member metric_anomalies row is written. Assembly
// (applyEpisodeAssemblyPlan: lockLiveAnchorEpisodes, then attachMembers) and
// the episode-resolve stage (UPDATE episodes, then the members CTE) both take
// the episode row first and the members second; the same order here keeps
// the pair deadlock-free.
describe('applyEpisodeAction lock order', () => {
  const MEMBER = { id: 'm-1', metricName: 'cpu_percent', anomalyType: 'spike' };
  const EPISODE = {
    id: 'ep-1', orgId: 'org-1', deviceId: 'dev-1', episodeKey: 'k', status: 'open',
    linkedAlertId: null, snoozedUntil: null, note: null,
  };

  function tableOf(t: unknown): string {
    return (t as { __table?: string } | undefined)?.__table ?? 'other';
  }

  /** Drizzle-shaped chain that records the terminal calls that take row locks or write. */
  function chain(label: string, rows: unknown[]) {
    const c: Record<string, unknown> = {};
    for (const m of ['where', 'limit', 'orderBy', 'set', 'innerJoin']) c[m] = () => c;
    c.from = (t: unknown) => {
      label = `${label}:${tableOf(t)}`;
      return c;
    };
    c.for = (mode: string) => {
      calls.push(`${label}:for-${mode}`);
      return Promise.resolve(rows);
    };
    c.returning = () => Promise.resolve(label === 'update:members' ? [MEMBER] : []);
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
    return c;
  }

  beforeEach(() => {
    calls.length = 0;
    let selects = 0;
    dbMock.select = () => {
      selects += 1;
      return chain('select', selects === 1 ? [EPISODE] : [MEMBER]);
    };
    dbMock.update = (t: unknown) => {
      calls.push(`update:${tableOf(t)}`);
      return chain(`update:${tableOf(t)}`, []);
    };
    promoteMock.mockReset().mockImplementation(async () => {
      // promoteMetricAnomalyToAlert writes the peak member row (status promoted).
      calls.push('promote:member-write');
      return { status: 'promoted', alertId: 'alert-1', created: true };
    });
    emitMemberFeedbackMock.mockReset().mockResolvedValue(1);
  });

  it.each(['resolve', 'dismiss', 'promote'] as const)('%s locks the episode FOR UPDATE before touching any member row', async (action) => {
    const result = await applyEpisodeAction({ orgId: 'org-1', deviceId: 'dev-1', episodeId: 'ep-1', action, actorUserId: 'u-1', now: NOW });

    expect(result).toMatchObject({ status: 'ok' });
    expect(calls[0]).toBe('select:episodes:for-update');
    const firstMemberWrite = calls.findIndex((c) => c === 'update:members' || c === 'promote:member-write');
    expect(firstMemberWrite).toBeGreaterThan(0);
  });
});
